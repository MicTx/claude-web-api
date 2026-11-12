import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FakeCdpServer, makeTmpDir, fetchHandlerFor, ClaudeService } from './helpers.mjs';
import * as fx from './fixtures.mjs';
import { cleanupTmpDirs, hangingStream } from './helpers.mjs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter, once } from 'node:events';
import { createInterface } from 'node:readline';
import * as contracts from '../src/tool-contracts.mjs';
after(() => cleanupTmpDirs());

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = ['claude_ask', 'claude_doctor', 'claude_download', 'claude_follow_up', 'claude_sessions', 'claude_transcript'];

function runCli(args, { env, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['bin/ccw.mjs', ...args], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, out, err }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

const inheritedOfflineEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCW_')
  && !['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'DEEPSEEK_HOME', 'XDG_CONFIG_HOME'].includes(key)));
const isolatedEnv = (home, extra = {}) => ({
  ...inheritedOfflineEnv(),
  HOME: home,
  ...extra,
});

const cliEnv = (stateDir, cdpUrl) => ({
  ...inheritedOfflineEnv(),
  HOME: stateDir,
  CCW_STATE_DIR: stateDir,
  CCW_CDP_URL: cdpUrl ?? 'http://127.0.0.1:1',
});

function parseSingleJsonLine(out) {
  const lines = out.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one output line, got: ${out.slice(0, 400)}`);
  return JSON.parse(lines[0]);
}

async function withServer(fn) {
  const service = new ClaudeService({ orgs: fx.ORGS_DUAL });
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service }).start();
  try {
    return await fn(service, server);
  } finally {
    await server.stop();
  }
}

// ---------- CLI -------------------------------------------------------------

test('cli: sessions on empty state prints one JSON line', async () => {
  const dir = await makeTmpDir();
  const r = await runCli(['sessions'], { env: cliEnv(dir) });
  assert.equal(r.code, 0);
  const result = parseSingleJsonLine(r.out);
  assert.deepEqual(result, { ok: true, sessions: [] });
  assert.equal(r.err, '');
});

test('cli: native-resume is CLI-only, documented, and validates before touching a browser', async () => {
  const dir = await makeTmpDir();
  const help = await runCli(['--help'], { env: cliEnv(dir) });
  assert.ok(help.out.includes('native-resume'));
  const missing = await runCli(['native-resume', '--session', 'absent', '--prompt', 'x'], { env: cliEnv(dir) });
  assert.equal(missing.code, 1);
  assert.equal(parseSingleJsonLine(missing.out).error.code, 'SESSION_NOT_FOUND');
  const bad = await runCli(['native-resume', '--session', 'absent'], { env: cliEnv(dir) });
  assert.equal(parseSingleJsonLine(bad.out).error.code, 'INVALID_ARGUMENT');
  // no MCP tool is added for this destructive-capable recovery step
  assert.ok(!EXPECTED_TOOLS.includes('claude_native_resume'));
});

test('cli: --help exits zero', async () => {
  const r = await runCli(['--help'], { env: cliEnv(await makeTmpDir()) });
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('Usage'));
});

test('cli: --status is read-only and does not load model configuration', async () => {
  const dir = await fsp.realpath(await makeTmpDir());
  await fsp.mkdir(join(dir, '.config/claude-web-api'), { recursive: true });
  await fsp.writeFile(join(dir, '.config/claude-web-api/config.json'), '{"invalid":');
  const r = await runCli(['--status'], { env: cliEnv(dir) });
  assert.equal(r.code, 0);
  assert.deepEqual(parseSingleJsonLine(r.out), {
    ok: true,
    action: 'status',
    installed: false,
    version: null,
    previous: null,
    root: join(dir, '.local/share/claude-web-api/runtime'),
    binDir: join(dir, '.local/bin'),
    reconnectRequired: false,
    verification: 'installed-files-and-commands',
  });
});

test('cli: unknown command, bad options and prompt-source rules fail INVALID_ARGUMENT', async () => {
  const dir = await makeTmpDir();
  for (const args of [
    ['frobnicate'],
    ['sessions', '--extra'],
    ['ask', '--session', 's'],
    ['ask', '--session', 's', '--prompt', 'x', '--stdin'],
    ['ask', '--session', 's', '--prompt', 'x', '--bogus'],
    ['follow-up', '--session', 's', '--prompt', 'x', '--title', 'no'],
    ['transcript'],
    ['ask', '--session', '../bad', '--prompt', 'x'],
  ]) {
    const r = await runCli(args, { env: cliEnv(dir) });
    assert.equal(r.code, 1, args.join(' '));
    const result = parseSingleJsonLine(r.out);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_ARGUMENT', args.join(' '));
  }
});

test('cli: doctor via fake CDP reports authenticated org without sending', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const r = await runCli(['doctor'], { env: cliEnv(dir, server.cdpUrl) });
    assert.equal(r.code, 0, r.err);
    const result = parseSingleJsonLine(r.out);
    assert.equal(result.ok, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.orgId, fx.ORG_ID);
    assert.equal(result.protocol, 'rest-sse');
    assert.equal(service.posts('/completion').length, 0);
    assert.deepEqual(server.closedTargets, [server.createdTargets[0].targetId]);
  });
});

test('cli: ask, follow-up, transcript and stdin prompt over fake CDP', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const firstPrompt = `用户原始请求：\r\n规划最小实现，不改写原文。\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}\n`;
    const nextPrompt = `验证新证据并给具体诊断。\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}\n`;
    const ask = await runCli(['ask', '--session', 'topic', '--stdin'], {
      env: cliEnv(dir, server.cdpUrl), input: firstPrompt,
    });
    assert.equal(ask.code, 0, ask.err);
    const r1 = parseSingleJsonLine(ask.out);
    assert.equal(r1.ok, true);
    assert.equal(r1.session, 'topic');
    assert.equal(r1.reply, 'Claude reply text');
    assert.equal(r1.stopReason, 'end_turn');
    assert.ok(r1.quota);

    const fu = await runCli(['follow-up', '--session', 'topic', '--stdin'], {
      env: cliEnv(dir, server.cdpUrl),
      input: nextPrompt,
    });
    assert.equal(fu.code, 0, fu.err);
    const r2 = parseSingleJsonLine(fu.out);
    assert.equal(r2.ok, true);
    const sends = service.posts('/completion');
    assert.equal(sends[1].body.parent_message_uuid, r1.assistantMessageId);
    assert.equal(sends[0].body.prompt, firstPrompt);
    assert.equal(sends[1].body.prompt, nextPrompt);

    const t = await runCli(['transcript', '--session', 'topic'], { env: cliEnv(dir, server.cdpUrl) });
    const tr = parseSingleJsonLine(t.out);
    assert.equal(tr.ok, true);
    assert.equal(tr.messages.length, 4);
    assert.deepEqual(tr.messages.map((m) => m.sender), ['human', 'assistant', 'human', 'assistant']);

    const list = await runCli(['sessions'], { env: cliEnv(dir, server.cdpUrl) });
    const lr = parseSingleJsonLine(list.out);
    assert.equal(lr.sessions[0].session, 'topic');
    assert.equal(lr.sessions[0].pending, null);
  });
});

test('cli: --guidance appends the fixed block once and reports it', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const raw = '用户请求：只读规划';
    const ask = await runCli(['ask', '--session', 'gcli', '--stdin', '--guidance'], {
      env: cliEnv(dir, server.cdpUrl), input: raw,
    });
    assert.equal(ask.code, 0, ask.err);
    const result = parseSingleJsonLine(ask.out);
    assert.equal(result.guidanceAppended, true);
    assert.equal(service.posts('/completion')[0].body.prompt, `${raw}\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}`);
  });
});

test('cli: --guidance rejects empty and whitespace prompts before any browser action', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    for (const command of ['ask', 'follow-up', 'native-resume']) {
      for (const prompt of ['', ' \t\n']) {
        const result = await runCli([command, '--session', 'empty', '--prompt', prompt, '--guidance'], {
          env: cliEnv(dir, server.cdpUrl),
        });
        assert.equal(result.code, 1, `${command}:${JSON.stringify(prompt)}`);
        assert.equal(parseSingleJsonLine(result.out).error.code, 'INVALID_ARGUMENT');
      }
    }
    assert.equal(service.requests.length, 0);
    assert.equal(server.createdTargets.length, 0);
  });
});

// ---------- MCP ---------------------------------------------------------------

async function mcpClient({ stateDir, cdpUrl, env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/mcp-server.mjs'],
    cwd: ROOT,
    env: { ...cliEnv(stateDir, cdpUrl), ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ccw-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test('mcp: listTools preserves the five original tools and adds controlled download', async () => {
  const dir = await makeTmpDir();
  const client = await mcpClient({ stateDir: dir });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
    const ask = tools.find((t) => t.name === 'claude_ask');
    assert.equal(ask.inputSchema.additionalProperties, false);
    assert.deepEqual(ask.inputSchema.required.sort(), ['prompt', 'session']);
  } finally {
    await client.close();
  }
});

test('mcp: tools carry the complete guidance through a relay with summarized instructions', async () => {
  await withServer(async (service, cdp) => {
    const upstream = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: cdp.cdpUrl });
    const summary = upstream.getInstructions().slice(0, 300);
    const relay = new Server({ name: 'summary-relay-fixture', version: '0.0.0' }, {
      capabilities: { tools: {} }, instructions: summary,
    });
    relay.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
    const client = new Client({ name: 'summary-relay-client', version: '0.0.0' });
    const [clientTransport, relayTransport] = InMemoryTransport.createLinkedPair();
    try {
      await relay.connect(relayTransport);
      await client.connect(clientTransport);
      assert.equal(client.getInstructions(), summary);
      assert.equal(summary.includes(contracts.EXECUTABLE_GUIDANCE_CONTRACT), false);
      const { tools } = await client.listTools();
      for (const name of ['claude_ask', 'claude_follow_up']) {
        const description = tools.find(tool => tool.name === name).inputSchema.properties.prompt.description;
        assert.ok(description.includes(contracts.EXECUTABLE_GUIDANCE_CONTRACT),
          `${name} must be self-contained after the actual upstream tools/list is relayed`);
        assert.match(description, /sanitized summary/);
      }
      assert.equal(service.requests.length, 0);
      assert.equal(cdp.createdTargets.length, 0);
    } finally {
      await Promise.all([client.close(), relay.close(), upstream.close()]);
    }
  });
});

test('attachments: cli sends explicit files and downloads a verified artifact', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const files = [['sample.png', fx.SAMPLE_PNG], ['sample.js', fx.SAMPLE_CODE]];
    const all = [['sample.png', fx.SAMPLE_PNG], ['sample.pdf', fx.SAMPLE_PDF], ['sample.js', fx.SAMPLE_CODE]];
    for (const [name, bytes] of all) await fsp.writeFile(join(dir, name), bytes);
    service.nativeOutputs = [{ name: 'result.js', bytes: fx.SAMPLE_CODE }];
    await fsp.writeFile(join(dir, 'question.txt'), 'inspect the selected files');
    const env = { ...cliEnv(join(dir, 'state'), server.cdpUrl), CCW_ATTACHMENT_ROOT: dir };
    const refused = await runCli(['ask', '--session', 'cli-pdf', '--prompt', 'x', '--attach', join(dir, 'sample.pdf')], { env });
    assert.equal(refused.code, 1);
    assert.equal(parseSingleJsonLine(refused.out).error.code, 'FILE_TYPE');
    assert.equal(service.uploads?.length ?? 0, 0);
    const r = await runCli(['ask', '--session', 'cli-files', '--file', join(dir, 'question.txt'), ...files.flatMap(([name]) => ['--attach', join(dir, name)])], { env });
    assert.equal(r.code, 0, r.out);
    const first = parseSingleJsonLine(r.out);
    assert.equal(service.uploads.length, 2);
    assert.equal(service.nativeSends[0].prompt, 'inspect the selected files');
    const next = await runCli(['follow-up', '--session', 'cli-files', '--prompt', 'continue'], { env });
    assert.equal(next.code, 0, next.out);
    assert.equal(service.uploads.length, 2);
    const downloaded = await runCli(['download', '--session', 'cli-files', '--artifact', first.artifacts[0].id, '--destination', 'result.js'], { env });
    assert.equal(downloaded.code, 0, downloaded.out);
    assert.deepEqual(await fsp.readFile(parseSingleJsonLine(downloaded.out).path), fx.SAMPLE_CODE);
    assert.equal(service.posts('/completion').length, 0);
    const conflict = await runCli(['download', '--session', 'cli-files', '--artifact', first.artifacts[0].id, '--destination', 'result.js'], { env });
    assert.equal(conflict.code, 1);
    assert.equal(parseSingleJsonLine(conflict.out).error.code, 'FILE_EXISTS');
  });
});

test('attachments: mcp accepts finite lists and returns only file metadata', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const selected = join(dir, 'sample.js');
    await fsp.writeFile(selected, fx.SAMPLE_CODE);
    service.nativeOutputs = [{ name: 'result.js', bytes: fx.SAMPLE_CODE }];
    const client = await mcpClient({ stateDir: join(dir, 'state'), cdpUrl: server.cdpUrl, env: { CCW_ATTACHMENT_ROOT: dir } });
    try {
      const ask = await client.callTool({ name: 'claude_ask', arguments: { session: 'files', prompt: 'inspect', attachments: [selected] } });
      assert.equal(ask.structuredContent.ok, true, JSON.stringify(ask.structuredContent));
      const follow = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'files', prompt: 'continue' } });
      assert.equal(follow.structuredContent.ok, true);
      const result = await client.callTool({ name: 'claude_download', arguments: { session: 'files', artifact: ask.structuredContent.artifacts[0].id } });
      assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
      assert.deepEqual(await fsp.readFile(result.structuredContent.path), fx.SAMPLE_CODE);
      assert.match(result.structuredContent.sha256, /^[a-f0-9]{64}$/);
      assert.equal(result.structuredContent.base64, undefined);
      assert.equal(service.uploads.length, 1);
      assert.equal(service.nativeSends.length, 2);
    } finally { await client.close(); }
  });
});

test('attachments: mcp rejects nested values, unknown scope keys and unbounded lists', async () => {
  await withServer(async (service, server) => {
    const client = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: server.cdpUrl });
    try {
      for (const patch of [
        { attachments: null }, { attachments: 'file.js' }, { attachments: [null] },
        { attachments: [{ path: '/file.js', approved: true }] }, { attachments: [['/file.js']] },
        { attachments: Array(6).fill('/file.js') }, { attachments: ['/file.js', '/file.js'] },
        { attachmentRoot: '/' }, { native: 'true' },
      ]) {
        const result = await client.callTool({ name: 'claude_ask', arguments: { session: 'bad', prompt: 'no requests', ...patch } });
        assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
      }
      assert.equal(service.requests.length, 0);
      assert.equal(server.createdTargets.length, 0);
    } finally { await client.close(); }
  });
});

test('mcp: initialization publishes the stage protocol without starting browser work', async () => {
  await withServer(async (service, server) => {
    const client = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: server.cdpUrl });
    try {
      const instructions = client.getInstructions();
      assert.equal(typeof instructions, 'string');
      assert.equal(instructions, contracts.SERVER_INSTRUCTIONS);
      const { tools } = await client.listTools();
      for (const name of ['claude_ask', 'claude_follow_up']) {
        const description = tools.find((tool) => tool.name === name).description;
        assert.match(description, /task stage/);
        assert.match(description, /evidence/);
        const promptDescription = tools.find(tool => tool.name === name).inputSchema.properties.prompt.description;
        assert.match(promptDescription, /【可执行指导要求 v3】/);
        assert.match(promptDescription, /ordered steps/);
        assert.match(promptDescription, /failure handling/);
        assert.match(promptDescription, /file-level guidance/i);
        assert.match(promptDescription, /ultrathink/i);
        assert.ok(promptDescription.includes(contracts.EXECUTABLE_GUIDANCE_CONTRACT));
      }
      assert.ok(instructions.includes(contracts.EXECUTABLE_GUIDANCE_CONTRACT));
      assert.equal(service.requests.length, 0);
      assert.equal(server.createdTargets.length, 0);
    } finally {
      await client.close();
    }
  });
});

test('mcp: claude_sessions on empty state returns structured ok', async () => {
  const dir = await makeTmpDir();
  const client = await mcpClient({ stateDir: dir });
  try {
    const r = await client.callTool({ name: 'claude_sessions', arguments: {} }, CallToolResultSchema, { timeout: 15_000 });
    assert.deepEqual(r.structuredContent, { ok: true, sessions: [] });
    assert.equal(JSON.parse(r.content[0].text).ok, true);
  } finally {
    await client.close();
  }
});

test('mcp: argument violations and unknown tools return structured errors', async () => {
  const dir = await makeTmpDir();
  const client = await mcpClient({ stateDir: dir });
  try {
    for (const [name, args] of [
      ['claude_ask', { session: 's' }],
      ['claude_ask', { session: 'bad alias!', prompt: 'x' }],
      ['claude_ask', { session: 's', prompt: 'x', extra: 1 }],
      ['claude_follow_up', { prompt: 'x' }],
      ['claude_transcript', { session: 's', recover: 'yes' }],
      ['nope_tool', {}],
    ]) {
      const r = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 15_000 });
      assert.equal(r.isError, true, name);
      assert.equal(r.structuredContent.ok, false);
      assert.equal(r.structuredContent.error.code, 'INVALID_ARGUMENT', `${name} ${JSON.stringify(args)}`);
    }
  } finally {
    await client.close();
  }
});

test('mcp: ask then follow-up across the fake browser keeps the session', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const client = await mcpClient({ stateDir: dir, cdpUrl: server.cdpUrl });
    try {
      const d = await client.callTool({ name: 'claude_doctor', arguments: {} }, CallToolResultSchema, { timeout: 20_000 });
      assert.equal(d.structuredContent.ok, true);
      assert.equal(d.structuredContent.authenticated, true);

      const a = await client.callTool(
        { name: 'claude_ask', arguments: { session: 'mcp-topic', prompt: `原始请求：复杂问题推理\r\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}\n` } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(a.structuredContent.ok, true, JSON.stringify(a.structuredContent));
      assert.equal(a.structuredContent.reply, 'Claude reply text');

      const f = await client.callTool(
        { name: 'claude_follow_up', arguments: { session: 'mcp-topic', prompt: `复审最新证据\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}\n` } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(f.structuredContent.ok, true);
      const sends = service.posts('/completion');
      assert.equal(sends.length, 2);
      assert.equal(sends[1].body.parent_message_uuid, a.structuredContent.assistantMessageId);
      assert.equal(sends[0].body.prompt, `原始请求：复杂问题推理\r\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}\n`);
      assert.equal(sends[1].body.prompt, `复审最新证据\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}\n`);

      const t = await client.callTool(
        { name: 'claude_transcript', arguments: { session: 'mcp-topic' } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(t.structuredContent.messages.length, 4);
    } finally {
      await client.close();
    }
  });
});

test('mcp: guidance=true appends the fixed block once and reports it', async () => {
  await withServer(async (service, server) => {
    const client = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: server.cdpUrl });
    try {
      const raw = '用户请求：只读规划';
      const a = await client.callTool(
        { name: 'claude_ask', arguments: { session: 'mcp-guidance', prompt: raw, guidance: true } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(a.structuredContent.ok, true, JSON.stringify(a.structuredContent));
      assert.equal(a.structuredContent.guidanceAppended, true);
      const f = await client.callTool(
        { name: 'claude_follow_up', arguments: { session: 'mcp-guidance', prompt: '新证据', guidance: true } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(f.structuredContent.ok, true);
      assert.equal(f.structuredContent.guidanceAppended, true);
      const sends = service.posts('/completion');
      assert.equal(sends.length, 2);
      assert.equal(sends[0].body.prompt, `${raw}\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}`);
      assert.equal(sends[1].body.prompt, `新证据\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}`);
    } finally {
      await client.close();
    }
  });
});

test('mcp: guidance=true rejects whitespace before any browser action', async () => {
  await withServer(async (service, server) => {
    const client = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: server.cdpUrl });
    try {
      for (const name of ['claude_ask', 'claude_follow_up']) {
        const result = await client.callTool(
          { name, arguments: { session: 'empty', prompt: ' \t\n', guidance: true } },
          CallToolResultSchema,
          { timeout: 20_000 },
        );
        assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT', name);
      }
      assert.equal(service.requests.length, 0);
      assert.equal(server.createdTargets.length, 0);
    } finally {
      await client.close();
    }
  });
});

test('mcp: unpaired surrogate prompts are rejected before any browser action', async () => {
  await withServer(async (service, server) => {
    const client = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: server.cdpUrl });
    try {
      for (const name of ['claude_ask', 'claude_follow_up']) {
        for (const prompt of ['bad\ud800text', 'bad\udc00text']) {
          const result = await client.callTool(
            { name, arguments: { session: 'unicode', prompt, guidance: true } },
            CallToolResultSchema,
            { timeout: 20_000 },
          );
          assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT', name);
        }
      }
      assert.equal(service.requests.length, 0);
      assert.equal(server.createdTargets.length, 0);
    } finally {
      await client.close();
    }
  });
});

test('mcp: injected guidance is the pending digest and is reconciled without resending', async () => {
  await withServer(async (service, server) => {
    const dir = await makeTmpDir();
    const client = await mcpClient({ stateDir: dir, cdpUrl: server.cdpUrl });
    const prompt = '只读诊断';
    const canonical = `${prompt}\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}`;
    try {
      service.failNext = 'afterCommit';
      const sent = await client.callTool(
        { name: 'claude_ask', arguments: { session: 'guided-recover', prompt, guidance: true } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(sent.structuredContent.error.code, 'STREAM_INCOMPLETE');
      const state = JSON.parse(await fsp.readFile(join(dir, 'sessions.json'), 'utf8'));
      assert.equal(state.sessions[0].pending.promptSha256,
        createHash('sha256').update(canonical).digest('hex'));
      const blocked = await client.callTool(
        { name: 'claude_follow_up', arguments: { session: 'guided-recover', prompt: 'new evidence', guidance: true } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(blocked.structuredContent.error.code, 'PENDING_TURN');
      const recovered = await client.callTool(
        { name: 'claude_transcript', arguments: { session: 'guided-recover', recover: true } },
        CallToolResultSchema,
        { timeout: 20_000 },
      );
      assert.equal(recovered.structuredContent.recovered, true);
      assert.equal(recovered.structuredContent.messages[0].text, canonical);
      assert.equal(recovered.structuredContent.pending, null);
      assert.equal(service.posts('/completion').length, 1);
    } finally {
      await client.close();
    }
  });
});

test('mcp: changing the guidance block cannot bypass an uncertain pending send', async () => {
  await withServer(async (service, server) => {
    const client = await mcpClient({ stateDir: await makeTmpDir(), cdpUrl: server.cdpUrl });
    const prompt = `用户原始请求：难题攻坚\n\n${contracts.EXECUTABLE_GUIDANCE_CONTRACT}`;
    try {
      service.failNext = 'afterCommit';
      const sent = await client.callTool({ name: 'claude_ask', arguments: { session: 'guidance-pending', prompt } },
        CallToolResultSchema, { timeout: 20_000 });
      assert.equal(sent.structuredContent.error.code, 'STREAM_INCOMPLETE');
      assert.equal(service.posts('/completion').length, 1);
      const changedBlock = prompt.replace('要求 v3', '要求 v2');
      assert.notEqual(changedBlock, prompt, 'the altered-contract candidate must actually change the prompt');
      for (const candidate of [prompt, `${prompt} `, changedBlock]) {
        const blocked = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'guidance-pending', prompt: candidate } },
          CallToolResultSchema, { timeout: 20_000 });
        assert.equal(blocked.structuredContent.error.code, 'PENDING_TURN');
        assert.equal(service.posts('/completion').length, 1, 'no replay, even with changed instructions');
      }
      const recovered = await client.callTool({ name: 'claude_transcript', arguments: { session: 'guidance-pending', recover: true } },
        CallToolResultSchema, { timeout: 20_000 });
      assert.equal(recovered.structuredContent.recovered, true);
      assert.equal(recovered.structuredContent.pending, null);
      assert.equal(recovered.structuredContent.messages[0].text, prompt);
      assert.equal(service.posts('/completion').length, 1, 'recovery never sends');
    } finally { await client.close(); }
  });
});

test('mcp: own-property/prototype-named arguments are rejected', async () => {
  const { validateInput } = await import('../src/mcp-server.mjs');
  const { TOOLS } = await import('../src/tool-contracts.mjs');
  const ask = TOOLS.find((t) => t.name === 'claude_ask');
  for (const raw of [
    '{"session":"s","prompt":"x","__proto__":{}}',
    '{"session":"s","prompt":"x","constructor":{}}',
    '{"session":"s","prompt":"x","toString":{}}',
    '{"session":"s","prompt":"x","nope":1}',
  ]) {
    assert.throws(() => validateInput(ask, JSON.parse(raw)), (e) => e.code === 'INVALID_ARGUMENT', raw);
  }
  const ok = validateInput(ask, { session: 's', prompt: 'x' });
  assert.deepEqual(ok, { session: 's', prompt: 'x', guidance: false });
});

test('mcp: SIGTERM during an in-flight send aborts, keeps pending, releases lock and tab', async () => {
  const service = new ClaudeService();
  let completionStarted;
  const completionSeen = new Promise((r) => { completionStarted = r; });
  const server = await new FakeCdpServer({
    fetchHandler: async (path, opts) => {
      if (path.includes('/completion')) {
        service.requests.push({ method: opts.method ?? 'POST', path, body: opts.body ? JSON.parse(opts.body) : null });
        completionStarted?.();
        return { status: 200, contentType: 'text/event-stream', body: hangingStream() };
      }
      return fetchHandlerFor(service)(path, opts);
    },
    nativeService: service,
  }).start();
  try {
    const dir = await makeTmpDir();
    const child = spawn(process.execPath, ['src/mcp-server.mjs'], {
      cwd: ROOT,
      env: isolatedEnv(dir, { CCW_STATE_DIR: dir, CCW_CDP_URL: server.cdpUrl, CCW_IDLE_TIMEOUT_MS: '60000', CCW_TIMEOUT_MS: '60000' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const rpc = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    let gotInit = false;
    child.stdout.on('data', (d) => { if (d.includes('"id":1')) gotInit = true; });
    rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    await Promise.race([
      new Promise((r) => { const iv = setInterval(() => { if (gotInit) { clearInterval(iv); r(); } }, 20); }),
      new Promise((r, j) => setTimeout(() => j(new Error('mcp init timeout')), 10_000)),
    ]);
    rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claude_ask', arguments: { session: 'kill-me', prompt: 'x' } } });
    await Promise.race([completionSeen, new Promise((r, j) => setTimeout(() => j(new Error('completion never reached fake service')), 10_000))]);
    child.kill('SIGTERM');
    const code = await new Promise((r) => child.once('exit', (c) => r(c)));
    assert.notEqual(code, null);
    const state = JSON.parse(await fsp.readFile(join(dir, 'sessions.json'), 'utf8'));
    assert.equal(state.sessions[0].pending.kind, 'send');
    assert.ok(!(await fsp.readdir(dir)).includes('ccw.lock'));
    assert.ok(server.closedTargets.length >= 1);
    assert.equal(service.posts('/completion').length, 1);
  } finally {
    await server.stop();
  }
});

test('cli: SIGINT during open stdin exits nonzero with one ABORTED JSON, no requests', async () => {
  const service = new ClaudeService();
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service) }).start();
  try {
    const dir = await makeTmpDir();
    const child = spawn(process.execPath, ['bin/ccw.mjs', 'ask', '--session', 's', '--stdin'], {
      cwd: ROOT,
      env: isolatedEnv(dir, { CCW_STATE_DIR: dir, CCW_CDP_URL: server.cdpUrl }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    // A fixed sleep must cover Node bootstrap and stdin setup: SIGINT sent
    // before the handler is installed kills the process without an ABORTED
    // result. Under load the original 600ms window was too short.
    await new Promise((r) => setTimeout(r, 1500));
    child.kill('SIGINT');
    const code = await Promise.race([
      new Promise((r) => child.once('exit', (c) => r(c))),
      new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000)),
    ]);
    assert.notEqual(code, 'TIMEOUT');
    assert.notEqual(code, 0);
    const lines = out.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).error.code, 'ABORTED');
    assert.equal(service.requests.length, 0);
  } finally {
    await server.stop();
  }
});

test('mcp: stdin EOF aborts an in-flight send and releases its lock and tab', { timeout: 20_000 }, async () => {
  const service = new ClaudeService();
  const completion = new EventEmitter();
  const server = await new FakeCdpServer({
    fetchHandler: async (path, opts) => {
      if (path.endsWith('/completion')) {
        service.requests.push({ method: opts.method, path });
        completion.emit('start');
        return { status: 200, contentType: 'text/event-stream', body: hangingStream() };
      }
      return fetchHandlerFor(service)(path, opts);
    },
    nativeService: service,
  }).start();
  const dir = await makeTmpDir();
  const child = spawn(process.execPath, ['src/mcp-server.mjs'], {
    cwd: ROOT,
    env: isolatedEnv(dir, { CCW_STATE_DIR: dir, CCW_CDP_URL: server.cdpUrl, CCW_TIMEOUT_MS: '60000', CCW_IDLE_TIMEOUT_MS: '60000' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const rpc = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    const initialized = once(lines, 'line', { signal: AbortSignal.timeout(5000) });
    rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } } });
    assert.equal(JSON.parse((await initialized)[0]).id, 1);
    rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const started = once(completion, 'start', { signal: AbortSignal.timeout(10_000) });
    rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'claude_ask', arguments: { session: 'eof', prompt: 'offline EOF fixture' } } });
    await started;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
    child.stdin.end();
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    const state = JSON.parse(await fsp.readFile(join(dir, 'sessions.json'), 'utf8'));
    assert.equal(state.sessions[0].pending.kind, 'send');
    assert.ok(!(await fsp.readdir(dir)).includes('ccw.lock'));
    assert.equal(service.posts('/completion').length, 1);
    assert.deepEqual(server.closedTargets, server.createdTargets.map((target) => target.targetId));
    assert.equal(server.createdTargets.length, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(3000) });
      child.kill('SIGTERM');
      await exited;
    }
    lines.close();
    await server.stop();
  }
});

test('identity: package, MCP server and release naming agree', async () => {
  const pkg = JSON.parse(await fsp.readFile(join(ROOT, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await fsp.readFile(join(ROOT, 'plugin', '.codex-plugin', 'plugin.json'), 'utf8'));
  const { APP } = await import('../src/identity.mjs');
  const { SERVER_VERSION } = await import('../src/mcp-server.mjs');
  assert.equal(pkg.name, 'claude-web-api');
  assert.equal(APP, pkg.name);
  assert.equal(SERVER_VERSION, pkg.version);
  assert.equal(plugin.version, pkg.version);
});
