#!/usr/bin/env node
// Verify the built native plugin installs and runs inside an isolated
// temporary CODEX_HOME. Never touches the real CODEX_HOME or a real browser.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FakeCdpServer, ClaudeService, fetchHandlerFor, offlineNodeOptions } from '../test/helpers.mjs';
import * as fx from '../test/fixtures.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT, SERVER_INSTRUCTIONS, TOOLS } from '../src/tool-contracts.mjs';
import { messagesSse } from '../test/api-protocol-fixtures.mjs';

const execFileP = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKET_ROOT = join(root, 'dist', 'marketplace');
const EXPECTED_TOOLS = ['claude_ask', 'claude_doctor', 'claude_download', 'claude_follow_up', 'claude_sessions', 'claude_transcript'];

const fail = (m) => { throw new Error(m); };

async function runCodex(args, env) {
  try {
    const r = await execFileP('codex', args, { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return r.stdout;
  } catch (e) {
    fail(`codex ${args.join(' ')} failed: ${e.message}\n${e.stderr ?? ''}`);
  }
}

async function findPluginDir(codexHome) {
  const hits = [];
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    let items;
    try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const p = join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === '.codex-plugin') hits.push(dir);
        else await walk(p, depth + 1);
      }
    }
  };
  await walk(codexHome, 0);
  return hits.find((d) => dirname(d).includes('claude')) ?? hits[0] ?? null;
}

async function main() {
  if ((await fs.lstat(MARKET_ROOT).catch(() => null)) === null) {
    fail('dist/marketplace not found; run npm run build:plugin first');
  }
  const codexHome = await fs.mkdtemp(join(tmpdir(), 'ccw-codex-home-'));
  const workDir = await fs.mkdtemp(join(tmpdir(), 'ccw-codex-cwd-'));
  const stateDir = await fs.mkdtemp(join(tmpdir(), 'ccw-state-'));
  const service = new ClaudeService({ orgs: fx.ORGS_DUAL });
  const fakeCdp = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service }).start();
  const apiRequests = [];
  const apiFixture = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    apiRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (apiRequests.at(-1).stream !== true) fail('cached API client did not request streaming');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(messagesSse({ id: `msg_plugin_${apiRequests.length}`, type: 'message', role: 'assistant', model: 'claude-fixture',
      content: [{ type: 'text', text: 'fixture reply' }], stop_reason: apiRequests.length === 1 ? 'max_tokens' : 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3 } }));
  });
  await new Promise(resolve => apiFixture.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${apiFixture.address().port}`;
  const env = { PATH: process.env.PATH ?? '', HOME: workDir, CODEX_HOME: codexHome, NODE_OPTIONS: await offlineNodeOptions(workDir, [fakeCdp.cdpUrl, apiUrl]) };
  let client = null;
  try {
    const settingsDir = join(workDir, '.config', 'claude-web-api');
    await fs.mkdir(settingsDir, { recursive: true, mode: 0o700 });
    const settings = JSON.stringify({ cdpUrl: fakeCdp.cdpUrl, stateDir, attachmentRoot: workDir });
    await fs.writeFile(join(settingsDir, 'config.json'), settings, { mode: 0o600 });
    const samples = [['sample.png', fx.SAMPLE_PNG], ['sample.js', fx.SAMPLE_CODE]];
    for (const [name, bytes] of samples) await fs.writeFile(join(workDir, name), bytes);
    await fs.writeFile(join(workDir, 'sample.pdf'), fx.SAMPLE_PDF);
    process.stdout.write(`marketplace add: ${(await runCodex(['plugin', 'marketplace', 'add', MARKET_ROOT, '--json'], env)).trim()}\n`);
    process.stdout.write(`plugin add: ${(await runCodex(['plugin', 'add', 'claude@claude-web-api', '--json'], env)).trim()}\n`);
    process.stdout.write(`plugin list: ${(await runCodex(['plugin', 'list'], env)).trim()}\n`);

    const pluginDir = await findPluginDir(codexHome);
    if (pluginDir === null) fail('installed plugin directory not found inside the isolated CODEX_HOME');
    if (!pluginDir.startsWith(codexHome)) fail(`plugin dir ${pluginDir} escaped the isolated home`);
    const manifest = JSON.parse(await fs.readFile(join(pluginDir, '.codex-plugin', 'plugin.json'), 'utf8'));
    if (manifest.name !== 'claude') fail(`unexpected plugin name: ${manifest.name}`);
    const mcp = JSON.parse(await fs.readFile(join(pluginDir, '.mcp.json'), 'utf8'));
    if (mcp?.mcpServers?.claude_web?.command !== 'node') fail('installed .mcp.json lacks the claude_web node server');
    if (JSON.stringify(mcp.mcpServers.claude_web.args) !== '["./server.mjs"]'
      || mcp.mcpServers.claude_web.cwd !== '.') fail('installed server path or plugin-relative cwd differs from the verified entry');
    const serverPath = join(pluginDir, 'server.mjs');
    if ((await fs.lstat(serverPath).catch(() => null)) === null) fail('server.mjs missing');
    if ((await fs.lstat(join(pluginDir, 'skills', 'claude', 'SKILL.md')).catch(() => null)) === null) fail('skill missing');
    const sourceSkill = await fs.readFile(join(root, 'skills', 'claude', 'SKILL.md'), 'utf8');
    const installedSkill = await fs.readFile(join(pluginDir, 'skills', 'claude', 'SKILL.md'), 'utf8');
    if (installedSkill !== sourceSkill) fail('cached skill differs from the current source protocol');
    if (!installedSkill.includes(EXECUTABLE_GUIDANCE_CONTRACT)) fail('cached skill lacks the complete executable-guidance block');

    // the installed copy must be self-contained: unrelated cwd, bundled page code
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath],
      cwd: workDir,
      env,
      stderr: 'pipe',
    });
    client = new Client({ name: 'ccw-plugin-verify', version: '0.0.0' });
    await client.connect(transport);
    if (client.getInstructions() !== SERVER_INSTRUCTIONS) fail('cached server lacks the current collaboration instructions');
    const { tools } = await client.listTools();
    if (JSON.stringify(tools.map((t) => t.name).sort()) !== JSON.stringify(EXPECTED_TOOLS)) {
      fail(`installed server exposes wrong tools: ${tools.map((t) => t.name).join(',')}`);
    }
    for (const name of ['claude_ask', 'claude_follow_up']) {
      const actual = tools.find(tool => tool.name === name)?.inputSchema.properties.prompt;
      const expected = TOOLS.find(tool => tool.name === name).inputSchema.properties.prompt;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`cached ${name} lacks the current prompt guidance`);
      if (!actual.description.includes(EXECUTABLE_GUIDANCE_CONTRACT)) fail(`cached ${name} lacks self-contained executable guidance`);
      const schema = tools.find(tool => tool.name === name).inputSchema;
      if (JSON.stringify(schema.properties.guidance) !== JSON.stringify(TOOLS.find(tool => tool.name === name).inputSchema.properties.guidance)
        || schema.required.includes('guidance')) fail(`cached ${name} lacks optional guidance=false`);
    }
    // exercise the bundled injected page function end to end through fake CDP
    const doc = await client.callTool({ name: 'claude_doctor', arguments: {} }, CallToolResultSchema, { timeout: 30_000 });
    if (doc.structuredContent?.ok !== true || doc.structuredContent.authenticated !== true) {
      fail(`claude_doctor on bundled server failed: ${JSON.stringify(doc.structuredContent).slice(0, 300)}`);
    }
    const guidancePrompt = `User request: plan the fixture verification.\r\n\n${EXECUTABLE_GUIDANCE_CONTRACT}\n`;
    const ask = await client.callTool(
      { name: 'claude_ask', arguments: { session: 'bundle-check', prompt: guidancePrompt } },
      CallToolResultSchema, { timeout: 30_000 });
    if (ask.structuredContent?.ok !== true || ask.structuredContent.reply !== 'Claude reply text') {
      fail(`claude_ask on bundled server failed: ${JSON.stringify(ask.structuredContent).slice(0, 300)}`);
    }
    if (service.posts('/completion')[0]?.body.prompt !== guidancePrompt) fail('cached server changed the host-composed guidance prompt');
    const injectedPrompt = 'User request: inspect a fixture.';
    const injected = await client.callTool(
      { name: 'claude_follow_up', arguments: { session: 'bundle-check', prompt: injectedPrompt, guidance: true } },
      CallToolResultSchema, { timeout: 30_000 });
    if (injected.structuredContent?.ok !== true || injected.structuredContent.guidanceAppended !== true
      || service.posts('/completion')[1]?.body.prompt !== `${injectedPrompt}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`) {
      fail('cached server failed to append opt-in guidance');
    }
    const empty = await client.callTool(
      { name: 'claude_follow_up', arguments: { session: 'bundle-check', prompt: '  ', guidance: true } },
      CallToolResultSchema, { timeout: 30_000 });
    if (empty.structuredContent?.error?.code !== 'INVALID_ARGUMENT' || service.posts('/completion').length !== 2) {
      fail('cached server accepted an empty opt-in question');
    }
    const malformed = await client.callTool(
      { name: 'claude_follow_up', arguments: { session: 'bundle-check', prompt: 'bad\ud800text', guidance: true } },
      CallToolResultSchema, { timeout: 30_000 });
    if (malformed.structuredContent?.error?.code !== 'INVALID_ARGUMENT' || service.posts('/completion').length !== 2) {
      fail('cached server accepted malformed Unicode');
    }
    const sess = await client.callTool({ name: 'claude_sessions', arguments: {} }, CallToolResultSchema, { timeout: 30_000 });
    if (sess.structuredContent?.sessions?.[0]?.session !== 'bundle-check') fail('claude_sessions mismatch');
    const targetsBefore = fakeCdp.createdTargets.length;
    const requestsBefore = service.requests.length;
    const refused = await client.callTool({
      name: 'claude_ask', arguments: { session: 'bundle-pdf', prompt: 'inspect', attachments: [join(workDir, 'sample.pdf')] },
    }, CallToolResultSchema, { timeout: 30_000 });
    if (refused.structuredContent?.error?.code !== 'FILE_TYPE' || fakeCdp.createdTargets.length !== targetsBefore
      || service.requests.length !== requestsBefore) fail('cached server did not reject PDF before browser access');
    service.nativeOutputs = [{ name: 'result.js', bytes: fx.SAMPLE_CODE, mimeType: '' }];
    const native = await client.callTool({
      name: 'claude_ask', arguments: { session: 'bundle-files', prompt: 'inspect explicit files', attachments: samples.map(([name]) => join(workDir, name)) },
    }, CallToolResultSchema, { timeout: 30_000 });
    if (native.structuredContent?.ok !== true || native.structuredContent.attachments.length !== 2) fail(`cached native upload failed: ${JSON.stringify(native.structuredContent)}`);
    const follow = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'bundle-files', prompt: 'continue without re-upload' } }, CallToolResultSchema, { timeout: 30_000 });
    if (follow.structuredContent?.ok !== true || service.uploads.length !== 2) fail('cached native continuity failed');
    const transcript = await client.callTool({ name: 'claude_transcript', arguments: { session: 'bundle-files' } }, CallToolResultSchema, { timeout: 30_000 });
    if (!transcript.structuredContent?.artifacts?.some(a => a.id === native.structuredContent.artifacts[0].id)) fail('cached artifact listing failed');
    const downloaded = await client.callTool({
      name: 'claude_download', arguments: { session: 'bundle-files', artifact: native.structuredContent.artifacts[0].id },
    }, CallToolResultSchema, { timeout: 30_000 });
    if (downloaded.structuredContent?.ok !== true) fail(`cached download failed: ${JSON.stringify(downloaded.structuredContent)}`);
    if (!(await fs.readFile(downloaded.structuredContent.path)).equals(fx.SAMPLE_CODE)) fail('cached download bytes differ');
    if (downloaded.structuredContent.sourceMimeType !== null || downloaded.structuredContent.mimeType !== 'text/javascript') fail('cached server mishandles the observed missing MIME header');
    if (await fs.readFile(join(settingsDir, 'config.json'), 'utf8') !== settings) fail('operator settings were modified');
    await client.close();
    client = null;
    if (service.posts('/completion').length !== 2) fail('bundled server did not send the two expected fake completions');

    // cached skill wrapper runs its bundled CLI from an unrelated cwd
    const wrapper = await execFileP(process.execPath, [
      join(pluginDir, 'skills', 'claude', 'scripts', 'ccw.mjs'), 'sessions',
    ], { cwd: workDir, env, timeout: 30_000 });
    const wrapped = JSON.parse(wrapper.stdout.trim().split('\n').at(-1));
    if (wrapped.ok !== true || !Array.isArray(wrapped.sessions)) fail('cached skill wrapper sessions failed');

    // Exercise the cached bundle against a separate, strictly local API fixture.
    const oldKey = 'fixture-only-old-key';
    const newKey = 'fixture-only-new-key';
    const apiEnv = { ...env, CCW_BACKEND: 'api', CCW_API_BASE_URL: apiUrl, CCW_API_MODEL: 'claude-fixture',
      CCW_API_KEY: oldKey, CCW_STATE_DIR: join(workDir, 'api-state') };
    const connectApi = async settings => {
      const apiClient = new Client({ name: 'ccw-plugin-api-verify', version: '0.0.0' });
      await apiClient.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: workDir, env: settings, stderr: 'pipe' }));
      return apiClient;
    };
    client = await connectApi(apiEnv);
    const apiFirst = await client.callTool({ name: 'claude_ask', arguments: { session: 'bundle-api', prompt: 'fixture first' } }, CallToolResultSchema);
    if (apiFirst.structuredContent?.complete !== false) fail('cached API did not expose truncated completion');
    const apiView = await client.callTool({ name: 'claude_transcript', arguments: { session: 'bundle-api' } }, CallToolResultSchema);
    if (apiView.structuredContent?.messages?.at(-1)?.complete !== false) fail('cached API lost completion status in history');
    const apiNext = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'bundle-api', prompt: 'fixture continue' } }, CallToolResultSchema);
    if (apiNext.structuredContent?.previousComplete !== false || apiRequests.length !== 2
      || apiRequests[0].metadata.user_id !== apiRequests[1].metadata.user_id || apiRequests[1].messages.length !== 3) fail('cached API continuity failed');
    await client.close();
    client = await connectApi({ ...apiEnv, CCW_API_KEY: newKey });
    const blocked = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'bundle-api', prompt: 'must not replay' } }, CallToolResultSchema);
    if (blocked.structuredContent?.error?.code !== 'API_CREDENTIAL_CHANGED' || apiRequests.length !== 2) fail('cached API accepted a changed credential');
    const oldKeyFile = join(workDir, 'fixture-old-key');
    await fs.writeFile(oldKeyFile, oldKey, { mode: 0o600 });
    const rotated = await execFileP(process.execPath, [join(pluginDir, 'bin', 'ccw.mjs'), 'api-bind-credential', '--session', 'bundle-api', '--old-key-file', oldKeyFile],
      { cwd: workDir, env: { ...apiEnv, CCW_API_KEY: newKey }, timeout: 30_000 });
    if (JSON.parse(rotated.stdout.trim()).identityVerified !== true || apiRequests.length !== 2) fail('cached CLI credential rotation failed');
    const afterRotation = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'bundle-api', prompt: 'after rotation' } }, CallToolResultSchema);
    if (afterRotation.structuredContent?.ok !== true || apiRequests.length !== 3) fail('cached API failed after credential rotation');
    await client.close();
    client = null;
    process.stdout.write(`verify-plugin OK: pluginDir=${pluginDir}\n`);
  } finally {
    if (client) await client.close().catch(() => {});
    apiFixture.closeAllConnections();
    await new Promise(resolve => apiFixture.close(resolve));
    await fakeCdp.stop();
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

main().then(() => {}).catch((e) => {
  process.stderr.write(`verify-plugin: ${e.message}\n`);
  process.exitCode = 1;
});
