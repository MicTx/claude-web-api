#!/usr/bin/env node
// Lead-authored live acceptance recipe. Exactly two sends, no retries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.mjs';
import { ROOT_PARENT } from '../src/core/claude-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedTools = [
  'claude_ask', 'claude_doctor', 'claude_follow_up',
  'claude_sessions', 'claude_transcript',
].sort();

async function targetIds(config) {
  const response = await fetch(`${config.cdpUrl}/json/list`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, 'CDP target enumeration failed');
  const targets = await response.json();
  assert.ok(Array.isArray(targets));
  // Do not log existing URLs, page titles or user conversations.
  return new Set(targets.filter((target) => target.type === 'page').map((target) => target.id));
}

function runCli(args, input, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin/ccw.mjs'), ...args], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stderrBytes = 0;
    let failure = null;
    let hardStop;
    const timer = setTimeout(() => {
      failure = new Error('CLI acceptance deadline exceeded; do not retry the send');
      child.kill('SIGTERM');
      hardStop = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, 630_000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > 20 * 1024 * 1024 && !failure) {
        failure = new Error('CLI output exceeds acceptance limit');
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.byteLength; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(hardStop);
      if (failure) return reject(failure);
      try {
        const lines = output.trim().split('\n');
        assert.equal(lines.length, 1, 'CLI must emit exactly one JSON result');
        const result = JSON.parse(lines[0]);
        assert.equal(code, 0, `CLI failed: ${result.error?.code ?? code}; stderr bytes=${stderrBytes}`);
        assert.equal(result.ok, true, `CLI result failed: ${result.error?.code}`);
        resolveResult(result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

async function tool(client, name, args) {
  const result = await client.callTool(
    { name, arguments: args },
    CallToolResultSchema,
    { timeout: 650_000 },
  );
  const payload = result.structuredContent;
  assert.notEqual(result.isError, true, `${name} failed: ${payload?.error?.code}`);
  assert.equal(payload?.ok, true, `${name} returned no successful structured result`);
  return payload;
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--live'], 'Pass --live to authorize the two test messages');
  const config = loadConfig();
  const stateDir = await mkdtemp(join(tmpdir(), 'ccw-live-'));
  const session = `smoke-${randomUUID().slice(0, 8)}`;
  const token = `CCW-${randomUUID()}`;
  const firstPrompt = `请记住验收代号「${token}」。只回复：已记住。`;
  const followPrompt = '请只回复上一条消息里的验收代号，不要解释。';
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CCW_CDP_URL: config.cdpUrl,
    CCW_STATE_DIR: stateDir,
    CCW_TIMEOUT_MS: String(config.timeoutMs),
    CCW_IDLE_TIMEOUT_MS: String(config.idleTimeoutMs),
    ...(config.orgId ? { CCW_ORG_ID: config.orgId } : {}),
  };
  let client;
  let success = false;
  let conversationId;
  const started = performance.now();
  try {
    const before = await targetIds(config);
    const first = await runCli([
      'ask', '--session', session, '--stdin',
      '--title', '[ccw] Cross-process continuity verification',
    ], firstPrompt, env);
    conversationId = first.conversationId;
    assert.ok(first.reply.trim(), 'First turn must return visible text');
    assert.ok(first.assistantMessageId, 'First turn must include its parent pointer');

    // Fresh process: it can resume only from the saved state and server history.
    client = new Client({ name: 'ccw-live-acceptance', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'src/mcp-server.mjs')],
      cwd: root, env, stderr: 'pipe',
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((item) => item.name).sort(), expectedTools);
    const second = await tool(client, 'claude_follow_up', { session, prompt: followPrompt });
    assert.equal(second.conversationId, first.conversationId);
    assert.notEqual(second.assistantMessageId, first.assistantMessageId);
    assert.ok(second.reply.includes(token), 'Claude did not recall the unique token from the prior CLI turn');

    const transcript = await tool(client, 'claude_transcript', { session });
    assert.equal(transcript.pending, null);
    assert.equal(transcript.messages.length, 4, 'Server must record exactly two human/assistant pairs');
    const [human1, assistant1, human2, assistant2] = transcript.messages;
    assert.deepEqual(transcript.messages.map((message) => message.sender), ['human', 'assistant', 'human', 'assistant']);
    assert.equal(human1.text, firstPrompt);
    assert.equal(human1.parentMessageId, ROOT_PARENT);
    assert.equal(assistant1.uuid, first.assistantMessageId);
    assert.equal(assistant1.parentMessageId, human1.uuid);
    assert.equal(assistant1.text, first.reply);
    assert.equal(human2.text, followPrompt);
    assert.equal(human2.parentMessageId, assistant1.uuid);
    assert.equal(assistant2.uuid, second.assistantMessageId);
    assert.equal(assistant2.parentMessageId, human2.uuid);
    assert.equal(assistant2.text, second.reply);
    assert.equal(transcript.currentLeafMessageId, second.assistantMessageId);

    const saved = await tool(client, 'claude_sessions', {});
    assert.equal(saved.sessions.length, 1, 'Live acceptance must use isolated local state');
    assert.equal(saved.sessions[0].session, session);
    assert.equal(saved.sessions[0].pending, null);
    assert.equal(saved.sessions[0].parentMessageId, second.assistantMessageId);
    await client.close();
    client = undefined;
    const after = await targetIds(config);
    assert.ok([...before].every((id) => after.has(id)), 'An original browser tab was closed');
    success = true;
    console.log(JSON.stringify({
      ok: true,
      scenario: 'CLI first turn → fresh MCP follow-up → server transcript',
      conversationId,
      url: first.url,
      sends: 2,
      expectedToken: token,
      recalledReply: second.reply,
      serverMessages: transcript.messages.length,
      parentChainVerified: true,
      originalTabsPreserved: true,
      durationMs: Math.round(performance.now() - started),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      session,
      conversationId: conversationId ?? null,
      recoveryStateDir: stateDir,
      action: 'Inspect this isolated session; do not rerun or resend automatically.',
    }));
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
    if (success) await rm(stateDir, { recursive: true, force: true });
  }
}

await main();
