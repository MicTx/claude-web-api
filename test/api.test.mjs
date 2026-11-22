import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.mjs';
import { ApiStore, MAX_API_FILE_BYTES, MAX_API_MESSAGES, MAX_API_TURNS } from '../src/api-store.mjs';
import { ApiBridge } from '../src/api-bridge.mjs';
import { prepareApiRequest, MAX_API_CONTEXT_BYTES } from '../src/api-client.mjs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT } from '../src/tool-contracts.mjs';
import { BridgeError } from '../src/core/errors.mjs';
import { ROOT_PARENT } from '../src/core/claude-api.mjs';
import { makeTmpDir, cleanupTmpDirs, ClaudeService, FakeCdpServer, fetchHandlerFor, fakeWithTab, tabFor } from './helpers.mjs';
import * as fx from './fixtures.mjs';
import { writeProtocolReply } from './api-protocol-fixtures.mjs';

after(() => cleanupTmpDirs());
const SECRET = 'fixture-api-secret-not-a-real-credential';
const configured = {
  CCW_API_BASE_URL: 'https://api.example.com',
  CCW_API_MODEL: 'claude-opus-5-5',
  CCW_API_CONTEXT_TOKENS: '131072',
};
const SESSION_ID = '17e50c0d-769a-4219-a61b-e70a37f6630a';
const response = (text = 'reply', extra = {}) => ({
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn',
  usage: { input_tokens: 21, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 42 },
  ...extra,
});

async function withApi(fn, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (handler) return handler(req, res, requests);
    writeProtocolReply(res, 'messages', response('reply', { id: `msg_fixture_${requests.length}` }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const home = await makeTmpDir();
  const url = `http://127.0.0.1:${server.address().port}`;
  const mkConfig = (extra = {}) => loadConfig({ HOME: home, ...configured, CCW_BACKEND: 'api', CCW_API_KEY: SECRET, CCW_API_BASE_URL: url, CCW_CDP_URL: 'http://127.0.0.1:1', ...extra });
  const config = mkConfig();
  try { return await fn(config, requests, { home, url, mkConfig }); } finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
}

const secretFree = value => !JSON.stringify(value).includes(SECRET);
const readApiState = async stateDir => JSON.parse(await fs.readFile(join(stateDir, 'api-sessions.json'), 'utf8'));

const send = async (config, messages = [{ role: 'user', content: 'hello' }], options = {}) => {
  const { sendApiMessage } = await import('../src/api-client.mjs');
  return sendApiMessage(config, { messages, sessionId: SESSION_ID, key: SECRET }, options);
};

test('api: config defaults to web and keeps credentials out of serializable settings', async () => {
  const home = await makeTmpDir();
  const defaults = loadConfig({ HOME: home });
  assert.equal(defaults.backend, 'web');
  assert.equal(defaults.apiContextTokens, 16000);
  const config = loadConfig({ HOME: home, ...configured, CCW_BACKEND: 'auto', CCW_API_KEY: SECRET });
  assert.equal(config.backend, 'auto');
  assert.equal(config.apiBaseUrl, configured.CCW_API_BASE_URL);
  assert.equal(config.apiModel, configured.CCW_API_MODEL);
  assert.equal(config.apiMaxTokens, 2048);
  assert.equal(config.apiCache, 'ephemeral');
  assert.equal(await config.readApiKey(), SECRET);
  assert.ok(!JSON.stringify(config).includes(SECRET));
});

test('api: config reads only a private owned key file and does not rewrite it', async () => {
  const home = await makeTmpDir();
  const path = join(home, 'key');
  await fs.writeFile(path, SECRET + '\n', { mode: 0o600 });
  const before = await fs.readFile(path);
  const config = loadConfig({ HOME: home, ...configured, CCW_API_KEY_FILE: path });
  assert.equal(await config.readApiKey(), SECRET);
  assert.deepEqual(await fs.readFile(path), before);
  const envConfig = loadConfig({ HOME: home, ...configured, CCW_API_KEY_FILE: join(home, 'absent'), CCW_API_KEY: SECRET });
  assert.equal(await envConfig.readApiKey(), SECRET);
});

test('api: config refuses unsafe key material without exposing its contents', async () => {
  const home = await makeTmpDir();
  const path = join(home, 'key');
  await fs.writeFile(path, SECRET, { mode: 0o644 });
  const read = () => loadConfig({ HOME: home, ...configured, CCW_API_KEY_FILE: path }).readApiKey();
  await assert.rejects(read, { code: 'API_CREDENTIALS' });
  await fs.chmod(path, 0o600);
  const link = join(home, 'link');
  await fs.symlink(path, link);
  await assert.rejects(() => loadConfig({ HOME: home, ...configured, CCW_API_KEY_FILE: link }).readApiKey(), { code: 'API_CREDENTIALS' });
  await fs.link(path, join(home, 'hard-link'));
  await assert.rejects(read, { code: 'API_CREDENTIALS' });
  const large = join(home, 'large');
  await fs.writeFile(large, 'z'.repeat(8193), { mode: 0o600 });
  await assert.rejects(() => loadConfig({ HOME: home, ...configured, CCW_API_KEY_FILE: large }).readApiKey(), { code: 'API_CREDENTIALS' });
  assert.throws(() => loadConfig({ HOME: home, ...configured, CCW_API_KEY: SECRET + '\ninvalid' }), e => e.code === 'CONFIG_INVALID' && !e.message.includes(SECRET));
});

test('api: config rejects invalid destinations, controls and incomplete enabled profiles', async () => {
  const home = await makeTmpDir();
  for (const url of ['http://api.example.com', 'https://user:pass@example.com', 'https://api.example.com/?key=value', 'https://api.example.com/#x', 'file:///tmp/x']) {
    assert.throws(() => loadConfig({ HOME: home, ...configured, CCW_API_BASE_URL: url }), { code: 'CONFIG_INVALID' });
  }
  for (const [key, value] of [['CCW_BACKEND', 'other'], ['CCW_API_MAX_TOKENS', '0'], ['CCW_API_MAX_TOKENS', '65537'], ['CCW_API_CONTEXT_TOKENS', '1023'], ['CCW_API_CONTEXT_TOKENS', '131073'], ['CCW_API_CACHE', 'other'], ['CCW_API_MODEL', 'bad\nmodel'], ['CCW_API_KEY_FILE', 'relative.key'], ['CCW_API_REASONING', 'ultra']]) {
    assert.throws(() => loadConfig({ HOME: home, ...configured, [key]: value }), { code: 'CONFIG_INVALID' });
  }
  assert.throws(() => loadConfig({ HOME: home, CCW_BACKEND: 'api' }), { code: 'CONFIG_INVALID' });
  assert.equal(loadConfig({ HOME: home, ...configured, CCW_API_BASE_URL: 'http://127.0.0.1:1234/' }).apiBaseUrl, 'http://127.0.0.1:1234');
});

test('api: config shares non-secret startup settings and honors explicit environment values', async () => {
  const home = await makeTmpDir();
  const dir = join(home, '.config', 'claude-web-api');
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, 'config.json');
  const data = { backend: 'auto', apiBaseUrl: configured.CCW_API_BASE_URL, apiModel: configured.CCW_API_MODEL, apiKeyFile: join(home, 'key'), apiMaxTokens: 512, apiCache: 'ephemeral' };
  await fs.writeFile(path, JSON.stringify(data), { mode: 0o600 });
  const before = await fs.readFile(path);
  const config = loadConfig({ HOME: home, CCW_API_MAX_TOKENS: '256', CCW_API_KEY: SECRET });
  assert.equal(config.backend, 'auto');
  assert.equal(config.apiMaxTokens, 256);
  assert.equal(await config.readApiKey(), SECRET);
  assert.deepEqual(await fs.readFile(path), before);
  await fs.writeFile(path, JSON.stringify({ ...data, apiKey: SECRET }));
  assert.throws(() => loadConfig({ HOME: home }), e => e.code === 'CONFIG_INVALID' && !e.message.includes(SECRET));
});

test('api: wire sends one authenticated Messages request with the specified model and limit', async () => {
  await withApi(async (config, requests) => {
    config.apiMaxTokens = 256;
    const result = await send(config);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/v1/messages');
    assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`);
    assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[0].body.model, 'claude-opus-5-5');
    assert.equal(requests[0].body.max_tokens, 256);
    assert.equal(requests[0].body.metadata.user_id, SESSION_ID);
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].headers.accept, 'text/event-stream');
    assert.equal(result.reply, 'reply');
    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(result.complete, true);
    assert.equal(result.usage.cacheReadInputTokens, 42);
  });
});

test('api: wire never retries HTTP errors or follows a credential-bearing redirect', async () => {
  for (const status of [302, 401, 429, 500]) {
    await withApi(async (config, requests) => {
      await assert.rejects(() => send(config), error => {
        assert.equal(error.code, status === 302 ? 'API_REDIRECT' : 'API_HTTP_ERROR');
        assert.equal(error.details.status, status);
        assert.ok(!JSON.stringify(error).includes(SECRET));
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(requests.length, 1);
    }, (_, res) => {
      res.writeHead(status, { 'content-type': 'application/json', location: 'http://127.0.0.1:1/credential-target' });
      res.end(JSON.stringify({ error: { message: SECRET } }));
    });
  }
});

test('api: wire validates response shape, bounds, text and completion independently of HTTP success', async () => {
  for (const data of [
    { error: { message: 'not a message' } },
    response('', {}),
    response(SECRET),
    response('x', { content: [{ type: 'tool_use', id: 'tool', input: {} }], stop_reason: 'tool_use' }),
    response('x', { stop_reason: null }),
    response('x', { usage: { input_tokens: -1 } }),
    response('x'.repeat(1024 * 1024)),
  ]) {
    await withApi(async (config, requests) => {
      await assert.rejects(() => send(config), error => {
        assert.ok(['API_RESPONSE', 'API_RESPONSE_TOO_LARGE'].includes(error.code));
        assert.ok(!error.message.includes(SECRET));
        return true;
      });
      assert.equal(requests.length, 1);
    }, (_, res) => { writeProtocolReply(res, 'messages', data); });
  }
});

test('api: wire cancellation stops an in-flight response without retrying', async () => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  await withApi(async (config, requests) => {
    const controller = new AbortController();
    const promise = send(config, undefined, { signal: controller.signal });
    const rejected = assert.rejects(() => promise, { code: 'ABORTED' });
    await started;
    controller.abort();
    await rejected;
    assert.equal(requests.length, 1);
  }, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': keepalive\n\n'); ready(); });
});

test('api: cache sends stable content, bounded breakpoints and reports only actual counters', async () => {
  await withApi(async (config, requests) => {
    const first = [{ role: 'user', content: 'stable task instructions' }];
    await send(config, first);
    await send(config, [...first, { role: 'assistant', content: 'prior answer' }, { role: 'user', content: 'new evidence' }]);
    assert.deepEqual(requests[1].body.messages[0], requests[0].body.messages[0]);
    assert.equal(requests[1].body.messages[2].content[0].cache_control, undefined);
    assert.equal(requests[1].body.metadata.user_id, requests[0].body.metadata.user_id);
    config.apiCache = 'off';
    await send(config);
    assert.equal(requests[2].body.messages[0].content[0].cache_control, undefined);
  });
  await withApi(async config => {
    const result = await send(config);
    assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, reasoningTokens: null });
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal(result.reply, 'bounded');
  }, (_, res) => { writeProtocolReply(res, 'messages', response('bounded', { usage: undefined, stop_reason: 'max_tokens' })); });
});

test('api: rolling input budget sends complete-turn suffix and preserves stored history', async () => {
  await withApi(async (config, requests, { mkConfig }) => {
    const cfg = mkConfig({ CCW_API_CONTEXT_TOKENS: '1024' });
    const bridge = new ApiBridge(cfg);
    const prompt = index => `question-${index}-${'x'.repeat(500)}`;
    await bridge.ask({ session: 'rolling', prompt: prompt(1) });
    await bridge.followUp({ session: 'rolling', prompt: prompt(2) });
    const result = await bridge.followUp({ session: 'rolling', prompt: prompt(3) });

    assert.equal(requests.length, 3);
    assert.equal(requests[2].body.messages.length, 3);
    assert.equal(requests[2].body.messages[0].content[0].text, prompt(2));
    assert.equal(requests[2].body.messages[2].content[0].text, prompt(3));
    assert.deepEqual(result.context, {
      policy: 'rolling-window',
      tokenBudget: 1024,
      maxRequestBytes: MAX_API_CONTEXT_BYTES,
      estimatedInputTokens: result.context.estimatedInputTokens,
      requestBytes: result.context.requestBytes,
      retainedTurns: 1,
      omittedTurns: 1,
      retainedMessages: 3,
    });

    const stored = await readApiState(cfg.stateDir);
    assert.equal(stored.apiSessions[0].messages.length, 6);
    assert.equal(stored.apiSessions[0].messages[0].content, prompt(1));
    assert.equal(stored.apiSessions[0].pending, null);
  });
});

test('api: request selection enforces JSON bytes independently from estimated tokens', async () => {
  await withApi(async (config, requests, { mkConfig }) => {
    const cfg = mkConfig({ CCW_API_CONTEXT_TOKENS: '131072' });
    const old = '\x01'.repeat(80_000);
    const selected = prepareApiRequest(cfg, [
      { role: 'user', content: old },
      { role: 'assistant', content: old },
      { role: 'user', content: 'current' },
    ], SESSION_ID);
    assert.ok(selected.context.requestBytes <= MAX_API_CONTEXT_BYTES);
    assert.equal(selected.context.omittedTurns, 1);
    assert.equal(JSON.parse(selected.body).messages[0].content[0].text, 'current');

    assert.throws(
      () => prepareApiRequest(cfg, [{ role: 'user', content: '\x01'.repeat(60_000) }], SESSION_ID),
      error => error.code === 'API_CONTEXT_LIMIT'
        && error.details.maxRequestBytes === MAX_API_CONTEXT_BYTES
        && error.details.requestBytes > MAX_API_CONTEXT_BYTES,
    );
    assert.equal(requests.length, 0);
  });
});

test('api: oversized current prompt fails before pending or network send', async () => {
  await withApi(async (config, requests, { mkConfig }) => {
    const cfg = mkConfig({ CCW_API_CONTEXT_TOKENS: '1024' });
    await assert.rejects(
      () => new ApiBridge(cfg).ask({ session: 'too-large', prompt: 'x'.repeat(2000) }),
      error => error.code === 'API_INPUT_BUDGET' && error.details.tokenBudget === 1024,
    );
    assert.equal(requests.length, 0);
    assert.equal((await new ApiStore(cfg.stateDir).load()).apiSessions.length, 0);
  });
});

// ---------- persistent private history -------------------------------------

const UUID = '17e50c0d-769a-4219-a61b-e70a37f6630a';
const apiEntry = (over = {}) => ({
  session: 'seeded', sessionId: UUID, apiBaseUrl: 'https://api.example.com', model: 'claude-opus-5-5',
  title: null, messages: [], lastAssistantMessageId: null,
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
  lastUsage: null, pending: null, ...over,
});

test('api: guidance reaches real bridge requests and persistent history', async () => {
  await withApi(async (config, requests) => {
    const bridge = new ConsultBridge(config);
    const first = '第一轮问题';
    const next = '补充证据';
    const sentFirst = `${first}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`;
    const sentNext = `${next}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`;
    assert.equal((await bridge.ask({ session: 'guided', prompt: first, guidance: true })).guidanceAppended, true);
    assert.equal((await bridge.followUp({ session: 'guided', prompt: next, guidance: true })).guidanceAppended, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.messages[0].content[0].text, sentFirst);
    assert.equal(requests[1].body.messages[0].content[0].text, sentFirst);
    assert.equal(requests[1].body.messages[2].content[0].text, sentNext);
    const entry = (await readApiState(config.stateDir)).apiSessions[0];
    assert.equal(entry.messages[0].content, sentFirst);
    assert.equal(entry.messages[2].content, sentNext);
    assert.equal(entry.pending, null);
  });
});

test('api: guided failed send retains canonical digest and does not retry', async () => {
  await withApi(async (config, requests) => {
    const bridge = new ConsultBridge(config);
    const prompt = '需要明确对账的问题';
    const canonical = `${prompt}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`;
    await assert.rejects(bridge.ask({ session: 'guided-pending', prompt, guidance: true }), { code: 'API_HTTP_ERROR' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.messages[0].content[0].text, canonical);
    const entry = (await readApiState(config.stateDir)).apiSessions[0];
    assert.equal(entry.pending.promptSha256, createHash('sha256').update(canonical).digest('hex'));
    await assert.rejects(bridge.followUp({ session: 'guided-pending', prompt: '下一轮', guidance: true }), { code: 'PENDING_TURN' });
    const recovery = await bridge.transcript({ session: 'guided-pending', recover: true });
    assert.equal(recovery.recoveryAvailable, false);
    assert.equal(requests.length, 1);
    assert.equal((await readApiState(config.stateDir)).apiSessions[0].pending.promptSha256, entry.pending.promptSha256);
  }, (_, res) => { res.writeHead(500); res.end(); });
});

test('api: sticky keeps alias identity, endpoint, model and prefix across instances', async () => {
  await withApi(async (config, requests, ctx) => {
    const first = await new ApiBridge(config).ask({ session: 'sticky', prompt: 'first synthetic prompt' });
    assert.equal(first.ok, true);
    assert.equal(first.backend, 'api');
    assert.equal(first.complete, true);
    const second = await new ApiBridge(config).followUp({ session: 'sticky', prompt: 'second synthetic prompt' });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.metadata.user_id, requests[1].body.metadata.user_id);
    assert.equal(requests[0].headers['x-session-affinity'], requests[1].headers['x-session-affinity']);
    assert.equal(requests[0].headers['x-session-affinity'], requests[0].body.metadata.user_id);
    assert.equal(requests[0].body.model, requests[1].body.model);
    assert.equal(requests[0].path, requests[1].path);
    // the second request replays the stored prefix byte for byte, then the new turn
    assert.deepEqual(requests[1].body.messages[0], requests[0].body.messages[0]);
    assert.deepEqual(requests[1].body.messages[1].content[0], { type: 'text', text: 'reply', cache_control: { type: 'ephemeral' } });
    assert.equal(requests[1].body.messages[2].content[0].text, 'second synthetic prompt');
    assert.equal(second.sessionId, first.sessionId);
    assert.ok(secretFree(first) && secretFree(second));

    const stored = await readApiState(config.stateDir);
    assert.equal(stored.apiSessions.length, 1);
    assert.equal(stored.apiSessions[0].messages.length, 4);
    assert.equal(stored.apiSessions[0].pending, null);
    assert.ok(!(await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8')).includes(SECRET));
    assert.equal((await fs.stat(join(config.stateDir, 'api-sessions.json'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(config.stateDir)).mode & 0o777, 0o700);
    assert.deepEqual((await fs.readdir(config.stateDir)).filter(f => f.endsWith('.tmp')), []);
    assert.ok(!(await fs.readdir(config.stateDir)).includes('api.lock'));

    // a changed explicit model never moves an existing paid conversation
    await assert.rejects(
      () => new ApiBridge(ctx.mkConfig({ CCW_API_MODEL: 'claude-other-1' })).followUp({ session: 'sticky', prompt: 'third' }),
      { code: 'API_PROFILE_CHANGED' });
    assert.equal(requests.length, 2);
    await assert.rejects(
      () => new ApiBridge(ctx.mkConfig({ CCW_API_BASE_URL: 'https://other.example.com' })).followUp({ session: 'sticky', prompt: 'third' }),
      { code: 'API_PROFILE_CHANGED' });
    assert.equal(requests.length, 2);
  });
});

test('api: credential rotation verifies the original key before rebinding history', async () => {
  await withApi(async (config, requests, ctx) => {
    const replacement = 'fixture-replacement-secret-not-a-real-credential';
    await new ApiBridge(config).ask({ session: 'rotation', prompt: 'private history' });
    const changed = new ApiBridge(ctx.mkConfig({ CCW_API_KEY: replacement }));
    const before = await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8');
    await assert.rejects(() => changed.followUp({ session: 'rotation', prompt: 'must not send' }), { code: 'API_CREDENTIAL_CHANGED' });
    assert.equal(requests.length, 1);
    assert.equal(await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8'), before);
    const oldKey = join(ctx.home, 'old-key');
    await fs.writeFile(oldKey, 'wrong-key\n', { mode: 0o600 });
    await assert.rejects(() => changed.bindCredential({ session: 'rotation', oldKeyFile: oldKey }), { code: 'API_CREDENTIAL_MISMATCH' });
    assert.equal(await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8'), before);
    await fs.writeFile(oldKey, SECRET + '\n', { mode: 0o600 });
    const result = await changed.bindCredential({ session: 'rotation', oldKeyFile: oldKey });
    assert.equal(result.identityVerified, true);
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(result).includes(SECRET) && !JSON.stringify(result).includes(replacement));
    await changed.followUp({ session: 'rotation', prompt: 'continue' });
    assert.equal(requests.length, 2);
    await assert.rejects(() => new ApiBridge(config).followUp({ session: 'rotation', prompt: 'old key' }), { code: 'API_CREDENTIAL_CHANGED' });
    const stored = await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8');
    assert.ok(!stored.includes(SECRET) && !stored.includes(replacement));
  });
});

test('api: legacy credential identity remains unknown until an explicit adoption', async () => {
  await withApi(async (config, requests) => {
    const store = new ApiStore(config.stateDir);
    const entry = apiEntry({ apiBaseUrl: config.apiBaseUrl, messages: [
      { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
    ], lastAssistantMessageId: 'msg_old' });
    await store.save({ version: 1, apiSessions: [entry] });
    const bridge = new ApiBridge(config);
    await assert.rejects(() => bridge.followUp({ session: 'seeded', prompt: 'do not replay' }), { code: 'API_CREDENTIAL_UNBOUND' });
    assert.equal(requests.length, 0);
    assert.equal((await bridge.transcript({ session: 'seeded' })).credentialIdentity, 'unknown');
    const adopted = await bridge.bindCredential({ session: 'seeded', adoptUnbound: true });
    assert.equal(adopted.identityVerified, false);
    await bridge.followUp({ session: 'seeded', prompt: 'continue' });
    assert.equal(requests.length, 1);
  });
});

test('api: credential binding never changes an uncertain send or accepts unsafe old key files', async () => {
  await withApi(async (config, requests, ctx) => {
    const bridge = new ApiBridge(config);
    await bridge.ask({ session: 'protected', prompt: 'first' });
    const keyFile = join(ctx.home, 'old-credential');
    await fs.writeFile(keyFile, SECRET, { mode: 0o644 });
    await assert.rejects(() => bridge.bindCredential({ session: 'protected', oldKeyFile: keyFile }), { code: 'API_CREDENTIALS' });
    await assert.rejects(() => bridge.bindCredential({ session: 'protected', adoptUnbound: true }), { code: 'INVALID_ARGUMENT' });
    const state = await bridge.store.load();
    state.apiSessions[0].pending = { kind: 'send', transport: 'api', promptSha256: 'a'.repeat(64), startedAt: new Date().toISOString(), messageCount: 2 };
    await bridge.store.save(state);
    const before = await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8');
    await assert.rejects(() => bridge.bindCredential({ session: 'protected', oldKeyFile: keyFile }), { code: 'PENDING_TURN' });
    assert.equal(await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8'), before);
    assert.equal(requests.length, 1);
  });
});

test('session-store-private: route refuses unsafe web state', async (context) => {
  const stateDir = await makeTmpDir();
  const file = join(stateDir, 'sessions.json');
  const session = 'web-route';
  const timestamp = '2026-11-05T00:00:00.000Z';
  await fs.writeFile(file, JSON.stringify({ version: 1, lastSubmissionAt: 0, sessions: [{
    session, orgId: fx.ORG_ID, conversationId: fx.CONV_ID, parentMessageId: ROOT_PARENT,
    model: null, createdAt: timestamp, updatedAt: timestamp, pending: null,
  }] }), { mode: 0o600 });
  const web = { transcript: context.mock.fn(async () => ({})) };
  const api = { transcript: context.mock.fn(async () => ({})) };
  const bridge = new ConsultBridge({ stateDir, backend: 'web' }, { web, api });
  await fs.chmod(file, 0o644);
  await assert.rejects(() => bridge.transcript({ session }), { code: 'STATE_UNSAFE' });
  assert.equal(web.transcript.mock.callCount(), 0);
  assert.equal(api.transcript.mock.callCount(), 0);
  await fs.chmod(file, 0o600);
  assert.equal((await bridge.transcript({ session })).backend, 'web');
  assert.equal(web.transcript.mock.callCount(), 1);
});

test('api: state rejects corrupt, linked, open or oversized private history', async () => {
  const dir = await makeTmpDir();
  const store = new ApiStore(dir);
  await store.save({ version: 1, apiSessions: [] });
  const file = join(dir, 'api-sessions.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  await fs.writeFile(file, '{oops');
  await assert.rejects(() => store.load(), { code: 'API_STATE_CORRUPT' });
  for (const bad of [
    { version: 2, apiSessions: [] },
    { version: 1, apiSessions: [], extra: true },
    { version: 1, apiSessions: [apiEntry({ extra: 1 })] },
    { version: 1, apiSessions: [apiEntry({ messages: [{ role: 'assistant', content: 'x' }] })] },
    { version: 1, apiSessions: [apiEntry({ pending: { kind: 'send', transport: 'api', promptSha256: 'x', startedAt: 'nope', messageCount: 0 } })] },
    { version: 1, apiSessions: [apiEntry(), apiEntry()] },
    { version: 1, apiSessions: Array.from({ length: 33 }, (_, i) => apiEntry({ session: `s${i}`, sessionId: UUID })) },
  ]) {
    await fs.writeFile(file, JSON.stringify(bad));
    await assert.rejects(() => store.load(), { code: 'API_STATE_CORRUPT' }, JSON.stringify(bad).slice(0, 120));
  }

  await store.save({ version: 1, apiSessions: [apiEntry()] });
  await fs.chmod(file, 0o644);
  await assert.rejects(() => store.load(), { code: 'API_STATE_UNSAFE' });
  await assert.rejects(() => store.save({ version: 1, apiSessions: [] }), { code: 'API_STATE_UNSAFE' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o644); // never silently relaxed or rewritten
  await fs.chmod(file, 0o600);

  await fs.rm(file);
  await fs.symlink(join(dir, 'elsewhere.json'), file);
  await assert.rejects(() => store.load(), { code: 'API_STATE_UNSAFE' });
  await assert.rejects(() => store.save({ version: 1, apiSessions: [] }), { code: 'API_STATE_UNSAFE' });
  await fs.rm(file);

  await fs.writeFile(file, 'x'.repeat(600 * 1024), { mode: 0o600 });
  await assert.rejects(() => store.load(), { code: 'API_STATE_CORRUPT' });
  await fs.writeFile(file, 'x'.repeat(MAX_API_FILE_BYTES + 1), { mode: 0o600 });
  await assert.rejects(() => store.load(), { code: 'API_STATE_TOO_LARGE' });
  assert.equal((await fs.stat(file)).size, MAX_API_FILE_BYTES + 1);

  // atomic write: a failing rename leaves no temporary file and keeps the previous state
  await fs.rm(file);
  const atomic = new ApiStore(dir, { io: { ...fs, rename: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } } });
  await assert.rejects(() => atomic.save({ version: 1, apiSessions: [] }), { code: 'API_STATE_IO' });
  assert.deepEqual((await fs.readdir(dir)).filter(f => f.endsWith('.tmp')), []);

  // exclusive lock, released on settle
  const locked = new ApiStore(dir);
  await locked.save({ version: 1, apiSessions: [] });
  assert.equal(await locked.withLock(async () => {
    await assert.rejects(() => locked.lock.withLock(async () => {}), { code: 'BUSY' });
    return 'held';
  }), 'held');
  assert.ok(!(await fs.readdir(dir)).includes('api.lock'));
});

test('api: state capacity is checked before requests and never makes history unreadable', async () => {
  await withApi(async (config, requests) => {
    const bridge = new ApiBridge(config);
    let completed = 0;
    let rejected;
    for (let index = 0; index < 32; index++) {
      try {
        await bridge.ask({ session: `capacity-${index}`, prompt: 'x'.repeat(60000) });
        completed++;
      } catch (error) {
        rejected = error;
        break;
      }
    }
    assert.ok(completed >= 5);
    assert.equal(rejected?.code, 'API_STATE_CAPACITY');
    assert.equal(requests.length, completed);
    assert.equal((await bridge.sessions()).sessions.length, completed);
    assert.equal((await bridge.store.load()).apiSessions.length, completed);
  }, (_req, res, seen) => {
    writeProtocolReply(res, 'messages', response('y'.repeat(60000), { id: `msg_${seen.length}` }));
  });
});

test('api: serialized write limit preserves the previous history and accepts valid older files', async () => {
  const dir = await makeTmpDir();
  const store = new ApiStore(dir);
  const file = join(dir, 'api-sessions.json');
  const messages = [{ role: 'user', content: 'x'.repeat(60000) }, { role: 'assistant', content: 'y'.repeat(60000) }];
  const old = { version: 1, apiSessions: Array.from({ length: 5 }, (_, i) => apiEntry({ session: `old-${i}`, messages, lastAssistantMessageId: 'msg_1' })) };
  await fs.writeFile(file, JSON.stringify(old), { mode: 0o600 });
  assert.ok((await fs.stat(file)).size > 512 * 1024);
  assert.equal((await store.load()).apiSessions.length, 5);
  const before = await fs.readFile(file, 'utf8');
  const escaped = [{ role: 'user', content: '\x01'.repeat(60000) }, { role: 'assistant', content: '\x01'.repeat(60000) }];
  const tooLarge = { version: 1, apiSessions: Array.from({ length: 3 }, (_, i) => apiEntry({ session: `escaped-${i}`, messages: escaped, lastAssistantMessageId: 'msg_1' })) };
  await assert.rejects(store.save(tooLarge), { code: 'API_STATE_CAPACITY' });
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

test('api: a valid long reply is saved and remains available', async () => {
  await withApi(async (config, requests) => {
    const bridge = new ApiBridge(config);
    const result = await bridge.ask({ session: 'long-reply', prompt: 'synthetic' });
    assert.equal(result.reply.length, 70000);
    assert.equal(requests.length, 1);
    const view = await bridge.transcript({ session: 'long-reply' });
    assert.equal(view.messages.at(-1).text, result.reply);
    assert.equal(view.pending, null);
  }, (_req, res) => {
    writeProtocolReply(res, 'messages', response('y'.repeat(70000), { id: 'msg_long' }));
  });
});

test('api: completion status survives transcript and is visible on follow-up', async () => {
  await withApi(async (config, requests) => {
    const bridge = new ApiBridge(config);
    const first = await bridge.ask({ session: 'partial', prompt: 'first' });
    assert.equal(first.complete, false);
    assert.equal(first.stopReason, 'max_tokens');
    assert.equal(first.limits.outputTokenLimit, 2048);
    assert.deepEqual(first.truncation, {
      stopReason: 'max_tokens',
      outputTokenLimit: 2048,
      reasoningTokens: null,
      reasoningConsumesOutputBudget: true,
    });
    const view = await bridge.transcript({ session: 'partial' });
    assert.equal(view.messages.at(-1).complete, false);
    assert.equal(view.messages.at(-1).stopReason, 'max_tokens');
    const next = await bridge.followUp({ session: 'partial', prompt: 'continue' });
    assert.equal(next.previousComplete, false);
    assert.equal(requests.length, 2);
  }, (_req, res, seen) => {
    writeProtocolReply(res, 'messages', response('partial', { id: `msg_${seen.length}`, stop_reason: seen.length === 1 ? 'max_tokens' : 'end_turn' }));
  });
});

test('api: legacy history has unknown completion and invalid status is rejected', async () => {
  await withApi(async config => {
    const store = new ApiStore(config.stateDir);
    const entry = apiEntry({ apiBaseUrl: config.apiBaseUrl, messages: [
      { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
    ], lastAssistantMessageId: 'msg_old' });
    await store.save({ version: 1, apiSessions: [entry] });
    const view = await new ApiBridge(config).transcript({ session: 'seeded' });
    assert.equal(view.messages.at(-1).complete, null);
    assert.equal(view.messages.at(-1).stopReason, null);
    entry.messages[1].stopReason = 'max_tokens';
    entry.messages[1].complete = true;
    await assert.rejects(() => store.save({ version: 1, apiSessions: [entry] }), { code: 'API_STATE_CORRUPT' });
  });
});

test('api: state stops at the stored turn limit instead of trimming history', async () => {
  await withApi(async (config, requests) => {
    const messages = [];
    for (let i = 0; i < MAX_API_TURNS; i += 1) {
      messages.push({ role: 'user', content: `stored prompt ${i}` }, { role: 'assistant', content: `stored answer ${i}` });
    }
    assert.equal(messages.length, MAX_API_MESSAGES);
    const store = new ApiStore(config.stateDir);
    await store.save({ version: 1, apiSessions: [apiEntry({ apiBaseUrl: config.apiBaseUrl, messages, lastAssistantMessageId: 'msg_last' })] });
    const before = await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8');
    await assert.rejects(
      () => new ApiBridge(config).followUp({ session: 'seeded', prompt: 'one more turn' }),
      error => error.code === 'API_CONTEXT_LIMIT' && error.details.messages === MAX_API_MESSAGES);
    assert.equal(requests.length, 0);
    assert.equal(await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8'), before);

    // the alias-count guard also refuses before any request
    const many = Array.from({ length: 32 }, (_, i) => apiEntry({ session: `many-${i}`, apiBaseUrl: config.apiBaseUrl }));
    await store.save({ version: 1, apiSessions: many });
    await assert.rejects(
      () => new ApiBridge(config).ask({ session: 'one-too-many', prompt: 'x' }),
      { code: 'API_SESSION_LIMIT' });
    assert.equal(requests.length, 0);

    await store.save({ version: 1, apiSessions: [apiEntry({ apiBaseUrl: config.apiBaseUrl, messages, lastAssistantMessageId: 'msg_last' })] });
    // byte-limit refusal happens before any durable or paid effect
    const big = '\x01'.repeat(15_000);
    const padded = Array.from({ length: 5 }, () => ([
      { role: 'user', content: big }, { role: 'assistant', content: big },
    ])).flat();
    await store.save({ version: 1, apiSessions: [apiEntry({ apiBaseUrl: config.apiBaseUrl, messages: padded, lastAssistantMessageId: 'msg_last' })] });
    const paddedBefore = await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8');
    await assert.rejects(
      () => new ApiBridge(config).followUp({ session: 'seeded', prompt: '\x01'.repeat(60_000) }),
      { code: 'API_CONTEXT_LIMIT' });
    assert.equal(requests.length, 0);
    assert.equal(await fs.readFile(join(config.stateDir, 'api-sessions.json'), 'utf8'), paddedBefore);
  });
});

// ---------- uncertain sends ------------------------------------------------

test('api: pending blocks resend and only an explicit discard clears it', async () => {
  let arrived;
  const received = new Promise(resolve => { arrived = resolve; });
  await withApi(async (config, requests) => {
    const bridge = new ApiBridge(config);
    const controller = new AbortController();
    const rejected = assert.rejects(
      () => bridge.ask({ session: 'uncertain', prompt: 'paid attempt' }, { signal: controller.signal }),
      { code: 'ABORTED' });
    await received;
    controller.abort();
    await rejected;
    assert.equal(requests.length, 1);

    const stored = await readApiState(config.stateDir);
    assert.equal(stored.apiSessions[0].pending.kind, 'send');
    assert.equal(stored.apiSessions[0].pending.transport, 'api');
    assert.deepEqual(stored.apiSessions[0].messages, []);

    await assert.rejects(() => bridge.followUp({ session: 'uncertain', prompt: 'again' }), { code: 'PENDING_TURN' });
    assert.equal(requests.length, 1);

    // recovery never claims completion and never clears without authority
    const view = await bridge.transcript({ session: 'uncertain', recover: true });
    assert.equal(view.recovered, false);
    assert.equal(view.pendingRetained, true);
    assert.equal(view.recoveryAvailable, false);
    assert.equal(view.reconciliation.status, 'unconfirmed');
    assert.equal(requests.length, 1);
    assert.equal((await readApiState(config.stateDir)).apiSessions[0].pending.kind, 'send');

    await assert.rejects(() => bridge.transcript({ session: 'uncertain', discardPending: true }), { code: 'INVALID_ARGUMENT' });
    const cleared = await bridge.transcript({ session: 'uncertain', recover: true, discardPending: true });
    assert.equal(cleared.discarded, true);
    assert.equal(cleared.pending, null);
    assert.equal(cleared.retried, false);
    assert.equal(requests.length, 1);
    assert.equal((await readApiState(config.stateDir)).apiSessions[0].pending, null);

    const resumed = await bridge.followUp({ session: 'uncertain', prompt: 'after discard' });
    assert.equal(resumed.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.messages.length, 1);
    assert.equal(requests[1].body.messages[0].content[0].text, 'after discard');
    assert.equal(requests[1].body.metadata.user_id, requests[0].body.metadata.user_id);
  }, (req, res, seen) => {
    if (seen.length === 1) { arrived(); return; }
    writeProtocolReply(res, 'messages', response('reply', { id: `msg_fixture_${seen.length}` }));
  });
});

test('api: pending is durable across storage failures and network timeouts', async () => {
  await withApi(async (config, requests, ctx) => {
    // a pre-send persistence failure must stop before any request
    const failingStore = {
      load: async () => ({ version: 1, apiSessions: [] }),
      save: async () => { throw new Error('disk full'); },
      withLock: fn => fn(),
    };
    await assert.rejects(
      () => new ApiBridge(config, { store: failingStore }).ask({ session: 'blocked', prompt: 'never sent' }),
      error => error.code === 'API_STATE_IO' && error.details.pending === true);
    assert.equal(requests.length, 0);
    await assert.rejects(() => fs.stat(join(config.stateDir, 'api-sessions.json')), { code: 'ENOENT' });

    // a reply that arrives but cannot be stored keeps the durable pending marker
    const real = new ApiStore(config.stateDir);
    let saves = 0;
    const flaky = {
      load: () => real.load(),
      withLock: (fn, options) => real.withLock(fn, options),
      updateSession: (session, update, options) => real.updateSession(session, update, options),
      save: async state => {
        saves += 1;
        if (saves === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return real.save(state);
      },
    };
    await assert.rejects(
      () => new ApiBridge(config, { store: flaky }).ask({ session: 'lost-reply', prompt: 'paid attempt' }),
      error => error.code === 'API_STATE_IO' && error.details.responseReceived === true && error.details.pending === true);
    assert.equal(requests.length, 1);
    const stored = (await readApiState(config.stateDir)).apiSessions.find(e => e.session === 'lost-reply');
    assert.equal(stored.pending.kind, 'send');
    assert.deepEqual(stored.messages, []);
    await assert.rejects(() => new ApiBridge(config).followUp({ session: 'lost-reply', prompt: 'again' }), { code: 'PENDING_TURN' });
    assert.equal(requests.length, 1);

    // a deadline is an uncertain send, not a retry trigger
    await withApi(async (inner, innerRequests, innerCtx) => {
      const slow = innerCtx.mkConfig({ CCW_TIMEOUT_MS: '1000', CCW_IDLE_TIMEOUT_MS: '1000' });
      const bridge = new ApiBridge(slow);
      await assert.rejects(() => bridge.ask({ session: 'timed-out', prompt: 'paid attempt' }), { code: 'TIMEOUT' });
      assert.equal(innerRequests.length, 1);
      const entry = (await readApiState(slow.stateDir)).apiSessions.find(e => e.session === 'timed-out');
      assert.equal(entry.pending.kind, 'send');
      assert.deepEqual(entry.messages, []);
      await assert.rejects(() => bridge.followUp({ session: 'timed-out', prompt: 'again' }), { code: 'PENDING_TURN' });
      assert.equal(innerRequests.length, 1);
    }, (_req, _res) => {});
  });
});

test('api: different aliases send concurrently without losing state writes', { timeout: 10000 }, async () => {
  await withApi(async (_outerConfig, _outerRequests, { mkConfig }) => {
    const requests = [];
    let secondStarted;
    const secondStartedPromise = new Promise(resolve => { secondStarted = resolve; });
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let firstStarted;
    const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; });
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      if (requests.length === 1) {
        firstStarted();
        await firstGate;
        return writeProtocolReply(res, 'messages', response('first reply', { id: 'msg_first' }));
      }
      secondStarted();
      return writeProtocolReply(res, 'messages', response('second reply', { id: 'msg_second' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const config = mkConfig({ CCW_API_BASE_URL: url });
      const bridge = new ApiBridge(config, { modelCatalog: () => ({ models: [{ hostId: 'fixture', id: 'claude-opus-5-5', normalized: 'claude-opus-5-5', series: 'opus' }], defaultModel: 'claude-opus-5-5' }) });
      const first = bridge.ask({ session: 'first', prompt: 'first prompt', model: 'claude-opus-5-5' });
      await firstStartedPromise;
      const second = bridge.ask({ session: 'second', prompt: 'second prompt', model: 'claude-opus-5-5' });
      await secondStartedPromise;
      const pending = await readApiState(config.stateDir);
      assert.deepEqual(pending.apiSessions.map(entry => entry.session), ['first', 'second']);
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assert.equal(firstResult.reply, 'first reply');
      assert.equal(secondResult.reply, 'second reply');
      const state = await readApiState(config.stateDir);
      assert.deepEqual(state.apiSessions.map(entry => entry.session), ['first', 'second']);
      assert.deepEqual(state.apiSessions.map(entry => entry.messages.length), [2, 2]);
      assert.equal(requests[0].body.messages[0].content[0].text, 'first prompt');
      assert.equal(requests[1].body.messages[0].content[0].text, 'second prompt');
    } finally {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
  });
});

// ---------- backend selection ----------------------------------------------

const downBrowser = async () => { throw new BridgeError('CDP_UNREACHABLE', 'no browser'); };

test('api: selection rejects PDF before probing either backend', async () => {
  await withApi(async (_config, requests, ctx) => {
    let probes = 0;
    const bridge = new ConsultBridge(ctx.mkConfig({ CCW_BACKEND: 'auto' }), {
      withTab: async () => { probes += 1; throw new BridgeError('CDP_UNREACHABLE', 'unavailable'); },
    });
    await assert.rejects(() => bridge.ask({ session: 'pdf', prompt: 'inspect', attachments: ['/tmp/sample.PDF'] }), { code: 'FILE_TYPE' });
    assert.equal(probes, 0);
    assert.equal(requests.length, 0);
    assert.equal((await bridge.sessions()).sessions.length, 0);
  });
});

test('api: selection keeps existing API aliases reserved in web-only mode', async () => {
  await withApi(async (config, requests, ctx) => {
    await new ConsultBridge(config).ask({ session: 'owned', prompt: 'api turn' });
    const service = new ClaudeService();
    const web = new ConsultBridge(ctx.mkConfig({ CCW_BACKEND: 'web' }), { withTab: fakeWithTab(service) });
    await assert.rejects(web.ask({ session: 'owned', prompt: 'duplicate' }), error => ['SESSION_EXISTS', 'API_DISABLED'].includes(error.code));
    assert.equal(service.posts().length, 0);
    assert.equal(requests.length, 1);
  });
});

test('api: selection serializes cross-backend creation of one alias', async () => {
  await withApi(async (_config, requests, ctx) => {
    const config = ctx.mkConfig({ CCW_BACKEND: 'auto' });
    const service = new ClaudeService();
    const normal = fakeWithTab(service);
    let entered;
    const probing = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    const slowWeb = async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return normal(...args);
    };
    const a = new ConsultBridge(config, { withTab: slowWeb });
    const b = new ConsultBridge(config, { withTab: downBrowser });
    const webTurn = a.ask({ session: 'race', prompt: 'web' });
    await probing;
    let other;
    try { other = await b.ask({ session: 'race', prompt: 'api' }); }
    catch (error) { other = error; }
    finally { release(); }
    const firstResult = await webTurn;
    assert.equal(firstResult.backend, 'web');
    assert.ok(['BUSY', 'SESSION_EXISTS'].includes(other.code), String(other.code));
    assert.equal(service.posts().length + requests.length, 1);
    const sessions = await a.sessions();
    assert.equal(sessions.sessions.filter(item => item.session === 'race').length, 1);
  });
});

test('api: selection allows different aliases on different backends', async () => {
  await withApi(async (_config, requests, ctx) => {
    const config = ctx.mkConfig({ CCW_BACKEND: 'auto' });
    const service = new ClaudeService();
    const normal = fakeWithTab(service);
    let entered, release;
    const probing = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let first = true;
    const a = new ConsultBridge(config, { withTab: async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return normal(...args);
    } });
    const b = new ConsultBridge(config, { withTab: downBrowser });
    const webTurn = a.ask({ session: 'web-alias', prompt: 'web' });
    await probing;
    let apiTurn;
    try { apiTurn = await b.ask({ session: 'api-alias', prompt: 'api' }); }
    finally { release(); }
    assert.equal((await webTurn).backend, 'web');
    assert.equal(apiTurn.backend, 'api');
    assert.equal(service.posts().length, 1);
    assert.equal(requests.length, 1);
  });
});

test('api: selection falls back only for a new session after a read-only web failure', async () => {
  await withApi(async (config, requests, ctx) => {
    const auto = ctx.mkConfig({ CCW_BACKEND: 'auto' });
    const fallback = await new ConsultBridge(auto, { withTab: downBrowser }).ask({ session: 'fallback', prompt: 'synthetic question' });
    assert.equal(fallback.backend, 'api');
    assert.equal(requests.length, 1);
    // the failed web preflight created no conversation
    await assert.rejects(() => fs.stat(join(auto.stateDir, 'sessions.json')), { code: 'ENOENT' });

    // an existing API alias stays on the API even when the browser recovers
    const healthyWeb = new ClaudeService();
    const routed = await new ConsultBridge(auto, { withTab: fakeWithTab(healthyWeb) })
      .followUp({ session: 'fallback', prompt: 'continue' });
    assert.equal(routed.backend, 'api');
    assert.equal(healthyWeb.requests.length, 0);
    assert.equal(requests.length, 2);

    // a healthy browser keeps a brand-new session on the web and never touches the API
    const web = new ClaudeService();
    const webBridge = new ConsultBridge(auto, { withTab: fakeWithTab(web) });
    const webResult = await webBridge.ask({ session: 'browser', prompt: 'web question' });
    assert.equal(webResult.backend, 'web');
    assert.equal(web.posts('/completion').length, 1);
    assert.equal(requests.length, 2);
    const webTranscript = await webBridge.transcript({ session: 'browser' });
    assert.equal(webTranscript.backend, 'web');

    // protocol breakage and cancellation are not fallback conditions
    const brokenTab = async () => { throw new BridgeError('API_CONTRACT', 'page protocol broke'); };
    await assert.rejects(
      () => new ConsultBridge(auto, { withTab: brokenTab }).ask({ session: 'broken', prompt: 'x' }),
      { code: 'API_CONTRACT' });
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => new ConsultBridge(auto, { withTab: downBrowser }).ask({ session: 'cancelled', prompt: 'x' }, { signal: aborted.signal }),
      { code: 'ABORTED' });
    await assert.rejects(() => new ConsultBridge(auto, { withTab: downBrowser }).ask({ session: '', prompt: 'ok' }), { code: 'INVALID_ARGUMENT' });
    assert.equal(requests.length, 2);

    // attachments and native intent are refused instead of silently dropped
    await assert.rejects(
      () => new ConsultBridge(auto, { withTab: downBrowser }).ask({ session: 'files', prompt: 'x', attachments: ['/tmp/a.png'] }),
      { code: 'API_UNSUPPORTED_INPUT' });
    await assert.rejects(
      () => new ConsultBridge(auto, { withTab: downBrowser }).ask({ session: 'files', prompt: 'x', native: true }),
      { code: 'API_UNSUPPORTED_INPUT' });
    assert.equal(requests.length, 2);

    // web-only configuration never reaches the API, api-only never probes a browser
    await assert.rejects(
      () => new ConsultBridge(ctx.mkConfig({ CCW_BACKEND: 'web' }), { withTab: downBrowser }).ask({ session: 'webonly', prompt: 'x' }),
      { code: 'CDP_UNREACHABLE' });
    let probes = 0;
    const apiOnly = await new ConsultBridge(ctx.mkConfig({ CCW_BACKEND: 'api' }), {
      withTab: async () => { probes += 1; throw new Error('unused'); },
    }).ask({ session: 'apionly', prompt: 'api only' });
    assert.equal(apiOnly.backend, 'api');
    assert.equal(probes, 0);
    assert.equal(requests.length, 3);

    // api mode refuses to start without a credential profile at all
    assert.throws(
      () => loadConfig({ HOME: ctx.home, CCW_BACKEND: 'api', CCW_API_BASE_URL: ctx.url, CCW_API_MODEL: 'claude-opus-5-5' }),
      { code: 'CONFIG_INVALID' });
    // an unusable private credential file fails before any state or request
    const badKeyFile = ctx.mkConfig({ CCW_API_KEY_FILE: join(ctx.home, 'missing.key'), CCW_API_KEY: undefined });
    await assert.rejects(
      () => new ConsultBridge(badKeyFile, { withTab: downBrowser }).ask({ session: 'nokey', prompt: 'x' }),
      { code: 'API_CREDENTIALS' });
    assert.equal(requests.length, 3);

    // an alias present in both stores is refused rather than guessed
    await fs.writeFile(join(auto.stateDir, 'sessions.json'), JSON.stringify({
      version: 1, lastSubmissionAt: 0,
      sessions: [{
        session: 'apionly', orgId: fx.ORG_ID, conversationId: fx.CONV_ID, parentMessageId: ROOT_PARENT,
        model: null, createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', pending: null,
      }],
    }), { mode: 0o600 });
    await assert.rejects(
      () => new ConsultBridge(auto, { withTab: downBrowser }).followUp({ session: 'apionly', prompt: 'x' }),
      { code: 'SESSION_CONFLICT' });
    assert.equal(requests.length, 3);
  });
});

test('api: selection reports unconfirmed browser cleanup through fallback and failure', async () => {
  await withApi(async (config, requests, ctx) => {
    const auto = ctx.mkConfig({ CCW_BACKEND: 'auto' });
    const uncertain = async () => { throw new BridgeError('CDP_TIMEOUT', 'fixture timeout', { cleanupPending: true, targetCreationUncertain: true }); };
    const result = await new ConsultBridge(auto, { withTab: uncertain }).ask({ session: 'probe-risk', prompt: 'synthetic' });
    assert.equal(result.backend, 'api');
    assert.deepEqual(result.webPreflightCleanup, { cleanupPending: true, targetCreationUncertain: true });
    assert.equal(requests.length, 1);
    const failedApi = { profile: () => ({ configured: true }), ask: async () => { throw new BridgeError('API_HTTP_ERROR', 'fixture failure'); } };
    await assert.rejects(() => new ConsultBridge(auto, { withTab: uncertain, api: failedApi }).ask({ session: 'probe-failure', prompt: 'synthetic' }),
      error => error.code === 'API_HTTP_ERROR' && error.details.webPreflightCleanup?.cleanupPending === true);

    const web = new ClaudeService();
    const normal = fakeWithTab(web);
    let calls = 0;
    const retained = async (...args) => {
      const value = await normal(...args);
      if (++calls === 1) return { ...value, browserCleanup: { closeUnconfirmed: true, targetId: 'fixture-target' } };
      return value;
    };
    const webResult = await new ConsultBridge(auto, { withTab: retained }).ask({ session: 'probe-retained', prompt: 'synthetic' });
    assert.deepEqual(webResult.webPreflightCleanup, { browserCleanup: { closeUnconfirmed: true, targetId: 'fixture-target' } });
    assert.equal(web.posts('/completion').length, 1);
  });
});

test('api: doctor reports the fallback profile without sending anything', async () => {
  await withApi(async (config, requests, ctx) => {
    const profile = new ConsultBridge(config, { withTab: downBrowser }).profile;
    assert.equal(profile, undefined); // the facade exposes doctor, not internals
    const apiOnly = await new ConsultBridge(config, { withTab: downBrowser }).doctor({});
    assert.equal(apiOnly.ok, true);
    assert.equal(apiOnly.backend, 'api');
    assert.equal(apiOnly.api.model, 'claude-opus-5-5');
    assert.equal(apiOnly.api.cache, 'ephemeral');
    assert.deepEqual(apiOnly.api.transport, {
      retry: { method: 'POST', maxAttempts: 1, retry: 'never', idempotencyRequired: 'confirmed' },
      idempotencyConfirmed: false,
    });
    assert.deepEqual(apiOnly.api.concurrency, {
      sameSession: 'single-in-flight',
      differentSessions: 'concurrent-network-short-state-lock',
      globalSessionLimit: null,
    });
    assert.ok(secretFree(apiOnly));
    assert.equal(requests.length, 0);

    assert.deepEqual(apiOnly.api.credential, { readable: true });

    const auto = await new ConsultBridge(ctx.mkConfig({ CCW_BACKEND: 'auto' }), { withTab: downBrowser }).doctor({});
    assert.equal(auto.ok, true);
    assert.equal(auto.backend, 'api');
    assert.equal(auto.fallback, true);
    assert.equal(auto.webError, 'CDP_UNREACHABLE');
    assert.equal(requests.length, 0);

    // an unusable private credential is reported, not echoed and not repaired
    const keyPath = join(ctx.home, 'doctor-key');
    await fs.writeFile(keyPath, SECRET, { mode: 0o644 });
    const unsafe = await new ConsultBridge(
      ctx.mkConfig({ CCW_BACKEND: 'auto', CCW_API_KEY_FILE: keyPath, CCW_API_KEY: undefined }),
      { withTab: downBrowser }).doctor({});
    assert.equal(unsafe.ok, true);
    assert.deepEqual(unsafe.api.credential, { readable: false, code: 'API_CREDENTIALS' });
    assert.ok(secretFree(unsafe));
    assert.equal(requests.length, 0);
    assert.equal((await fs.stat(keyPath)).mode & 0o777, 0o644);

    const web = new ClaudeService();
    const webDoctor = await new ConsultBridge(ctx.mkConfig({ CCW_BACKEND: 'auto' }), { withTab: fakeWithTab(web) }).doctor({});
    assert.equal(webDoctor.backend, 'web');
    assert.equal(webDoctor.authenticated, true);
    assert.equal(webDoctor.protocol, 'rest-sse');
    assert.equal(web.posts('/completion').length, 0);
    assert.equal(requests.length, 0);
  });
});

test('api: auto doctor preserves browser cleanup information using a single web check', async () => {
  await withApi(async (_config, requests, ctx) => {
    const auto = ctx.mkConfig({ CCW_BACKEND: 'auto' });
    const cleanup = { cleanupPending: true, targetCreationUncertain: true };
    const failed = async () => { throw new BridgeError('CDP_TIMEOUT', 'fixture timeout', cleanup); };
    const fallback = await new ConsultBridge(auto, { withTab: failed }).doctor({});
    assert.equal(fallback.backend, 'api');
    assert.deepEqual(fallback.webPreflightCleanup, cleanup);
    assert.equal(requests.length, 0);

    const web = new ClaudeService();
    const normal = fakeWithTab(web);
    let calls = 0;
    const retained = async (...args) => {
      calls++;
      return { ...await normal(...args), browserCleanup: { closeUnconfirmed: true, targetId: 'fixture-target' } };
    };
    const result = await new ConsultBridge(auto, { withTab: retained }).doctor({});
    assert.equal(result.backend, 'web');
    assert.deepEqual(result.browserCleanup, { closeUnconfirmed: true, targetId: 'fixture-target' });
    assert.equal(calls, 1);
    assert.equal(web.requests.filter(request => request.path === '/api/organizations').length, 1);
    assert.equal(requests.length, 0);

    const refused = async () => { throw new BridgeError('API_CONTRACT', 'fixture protocol error', { browserCleanup: { closeUnconfirmed: true } }); };
    await assert.rejects(() => new ConsultBridge(auto, { withTab: refused }).doctor({}),
      error => error.code === 'API_CONTRACT' && error.details.browserCleanup.closeUnconfirmed === true);
  });
});

// ---------- cache and usage ------------------------------------------------

test('api: cache reports only observed counters and keeps the sticky prefix', async () => {
  await withApi(async (config, requests, ctx) => {
    const bridge = new ApiBridge(config);
    const first = await bridge.ask({ session: 'cached', prompt: 'stable first turn' });
    assert.deepEqual(first.usage, { inputTokens: 21, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 42, reasoningTokens: null });
    assert.deepEqual(first.cache, { control: 'ephemeral', readInputTokens: 42, creationInputTokens: 0, observed: true, hit: true });
    const second = await new ApiBridge(config).followUp({ session: 'cached', prompt: 'second turn' });
    assert.deepEqual(requests[1].body.messages.at(-2).content[0].cache_control, { type: 'ephemeral' });
    assert.equal(requests[1].body.messages.at(-1).content[0].cache_control, undefined);
    assert.deepEqual(requests[0].body.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.equal(requests[0].headers['x-session-affinity'], requests[1].headers['x-session-affinity']);
    assert.equal(second.usage.cacheReadInputTokens, 42);

    // a cache-control change never rotates the session identity or the prefix
    const off = ctx.mkConfig({ CCW_API_CACHE: 'off' });
    const third = await new ApiBridge(off).followUp({ session: 'cached', prompt: 'third turn' });
    assert.equal(third.cache.control, 'off');
    assert.equal(requests[2].body.messages[2].content[0].cache_control, undefined);
    // cache_control decorates a request; the stored conversation prefix itself is unchanged
    for (const index of [0, 1]) {
      assert.equal(requests[2].body.messages[index].role, requests[1].body.messages[index].role);
      assert.equal(requests[2].body.messages[index].content[0].text, requests[1].body.messages[index].content[0].text);
    }
    assert.equal(requests[2].body.messages[0].content[0].cache_control, undefined);
    assert.equal(requests[2].body.messages[2].content[0].text, 'second turn');
    assert.equal(requests[2].body.metadata.user_id, requests[0].body.metadata.user_id);
  });
  await withApi(async config => {
    const result = await new ApiBridge(config).ask({ session: 'uncounted', prompt: 'no counters' });
    assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, reasoningTokens: null });
    assert.deepEqual(result.cache, { control: 'ephemeral', readInputTokens: null, creationInputTokens: null, observed: false, hit: null });
  }, (_, res) => {
    writeProtocolReply(res, 'messages', response('reply', { usage: undefined, id: 'msg_uncounted' }));
  });
});

// ---------- CLI and MCP -----------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiEnv = (stateDir, url, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCW_'))),
  HOME: stateDir,
  CCW_STATE_DIR: stateDir,
  CCW_BACKEND: 'api',
  CCW_API_BASE_URL: url,
  CCW_API_MODEL: configured.CCW_API_MODEL,
  CCW_API_KEY: SECRET,
  CCW_CDP_URL: 'http://127.0.0.1:1',
  ...extra,
});

function runCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['bin/ccw.mjs', ...args], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('exit', code => resolvePromise({ code, out, err }));
    child.stdin.end();
  });
}

const oneJson = out => {
  const lines = out.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON line: ${out.slice(0, 300)}`);
  return JSON.parse(lines[0]);
};

test('api: CLI rotation changes binding without sending or printing credentials', async () => {
  await withApi(async (_config, requests, ctx) => {
    const oldEnv = apiEnv(ctx.home, ctx.url);
    const first = await runCli(['ask', '--session', 'cli-rotation', '--prompt', 'first'], oldEnv);
    assert.equal(first.code, 0, first.out);
    const oldKeyFile = join(ctx.home, 'old-key');
    await fs.writeFile(oldKeyFile, SECRET, { mode: 0o600 });
    const nextSecret = 'replacement-fixture-credential';
    const nextEnv = { ...oldEnv, CCW_API_KEY: nextSecret };
    const blocked = await runCli(['follow-up', '--session', 'cli-rotation', '--prompt', 'continue'], nextEnv);
    assert.equal(oneJson(blocked.out).error.code, 'API_CREDENTIAL_CHANGED');
    const bind = await runCli(['api-bind-credential', '--session', 'cli-rotation', '--old-key-file', oldKeyFile], nextEnv);
    assert.equal(bind.code, 0, bind.out);
    assert.equal(oneJson(bind.out).identityVerified, true);
    assert.ok(!bind.out.includes(SECRET) && !bind.out.includes(nextSecret));
    assert.equal(requests.length, 1);
    const next = await runCli(['follow-up', '--session', 'cli-rotation', '--prompt', 'continue'], nextEnv);
    assert.equal(next.code, 0, next.out);
    assert.equal(requests.length, 2);
  });
});

test('api: cross-process creation keeps one owner while web preflight is pending', { timeout: 30000 }, async () => {
  await withApi(async (_config, requests, ctx) => {
    const service = new ClaudeService();
    const handler = fetchHandlerFor(service);
    let entered, release;
    const probing = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let firstProbe = true;
    const browser = await new FakeCdpServer({
      fetchHandler: async (path, options) => {
        if (path === '/api/organizations' && firstProbe) { firstProbe = false; entered(); await gate; }
        return handler(path, options);
      },
      nativeService: service,
    }).start();
    try {
      const env = apiEnv(ctx.home, ctx.url, { CCW_BACKEND: 'auto', CCW_CDP_URL: browser.cdpUrl });
      const first = runCli(['ask', '--session', 'cross-process', '--prompt', 'web'], env);
      await probing;
      let second;
      try { second = await runCli(['ask', '--session', 'cross-process', '--prompt', 'api'], { ...env, CCW_BACKEND: 'api' }); }
      finally { release(); }
      const firstResult = await first;
      assert.equal(firstResult.code, 0, firstResult.out);
      assert.equal(oneJson(firstResult.out).backend, 'web');
      assert.equal(second.code, 1);
      assert.ok(['BUSY', 'SESSION_EXISTS'].includes(oneJson(second.out).error.code));
      assert.equal(service.posts().length + requests.length, 1);
    } finally {
      release();
      await browser.stop();
    }
  });
});

test('api: killed creator can release its alias lock without clearing pending', { timeout: 30000 }, async () => {
  let observed;
  const requestSeen = new Promise(resolve => { observed = resolve; });
  await withApi(async (_config, requests, ctx) => {
    const env = apiEnv(ctx.home, ctx.url);
    const child = spawn(process.execPath, ['bin/ccw.mjs', 'ask', '--session', 'crashed', '--prompt', 'first'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await requestSeen;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      const aliasUnlock = await runCli(['unlock', '--session', 'crashed'], env);
      assert.equal(aliasUnlock.code, 0, aliasUnlock.out);
      assert.equal(oneJson(aliasUnlock.out).unlocked, true);
      const stateUnlock = await runCli(['unlock'], env);
      assert.equal(stateUnlock.code, 0, stateUnlock.out);
      const retry = await runCli(['follow-up', '--session', 'crashed', '--prompt', 'retry'], env);
      assert.equal(oneJson(retry.out).error.code, 'PENDING_TURN');
      assert.equal(requests.length, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, () => observed());
});

test('api: independent CLI processes continue one sticky alias without a browser', async () => {
  await withApi(async (config, requests, ctx) => {
    const env = apiEnv(ctx.home, ctx.url);
    const first = await runCli(['ask', '--session', 'apicli', '--prompt', 'first synthetic prompt'], env);
    assert.equal(first.code, 0, first.err);
    const asked = oneJson(first.out);
    assert.equal(asked.ok, true);
    assert.equal(asked.backend, 'api');
    assert.equal(asked.reply, 'reply');
    assert.equal(asked.usage.cacheReadInputTokens, 42);

    const second = await runCli(['follow-up', '--session', 'apicli', '--prompt', 'second synthetic prompt'], env);
    assert.equal(second.code, 0, second.err);
    assert.equal(oneJson(second.out).backend, 'api');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.metadata.user_id, requests[0].body.metadata.user_id);
    assert.equal(requests[1].body.messages.length, 3);

    const list = oneJson((await runCli(['sessions'], env)).out);
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].backend, 'api');
    assert.equal(list.sessions[0].session, 'apicli');

    const transcript = oneJson((await runCli(['transcript', '--session', 'apicli', '--recover'], env)).out);
    assert.equal(transcript.ok, true);
    assert.equal(transcript.recoveryAvailable, false);
    assert.equal(transcript.messages.length, 4);

    const download = oneJson((await runCli(['download', '--session', 'apicli', '--artifact', 'a'.repeat(64)], env)).out);
    assert.equal(download.ok, false);
    assert.equal(download.error.code, 'API_UNSUPPORTED_INPUT');
    assert.equal(requests.length, 2);
  });
});

test('api: MCP keeps strict arguments and continues the same sticky session', async () => {
  await withApi(async (config, requests, ctx) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['src/mcp-server.mjs'],
      cwd: ROOT,
      env: apiEnv(ctx.home, ctx.url),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'api-fixture', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const asked = await client.callTool({ name: 'claude_ask', arguments: { session: 'apimcp', prompt: 'first' } }, CallToolResultSchema, { timeout: 30_000 });
      assert.equal(asked.isError ?? false, false, JSON.stringify(asked));
      assert.equal(asked.structuredContent.backend, 'api');
      const continued = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'apimcp', prompt: 'second' } }, CallToolResultSchema, { timeout: 30_000 });
      assert.equal(continued.isError ?? false, false, JSON.stringify(continued));
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.metadata.user_id, requests[0].body.metadata.user_id);
      assert.equal(requests[1].body.messages.length, 3);

      const listed = await client.callTool({ name: 'claude_sessions', arguments: {} }, CallToolResultSchema, { timeout: 30_000 });
      assert.equal(listed.structuredContent.sessions[0].backend, 'api');

      const strict = await client.callTool({ name: 'claude_ask', arguments: { session: 'apimcp2', prompt: 'x', backend: 'api' } }, CallToolResultSchema, { timeout: 30_000 });
      assert.equal(strict.isError, true);
      const bad = await client.callTool({ name: 'claude_ask', arguments: { session: 'apimcp3', prompt: 'x', attachments: ['/tmp/a.png'] } }, CallToolResultSchema, { timeout: 30_000 });
      assert.equal(bad.isError, true);
      assert.equal(bad.structuredContent.error.code, 'API_UNSUPPORTED_INPUT');
      assert.equal(requests.length, 2);
    } finally {
      await client.close();
    }
  });
});

test('api: reasoning levels send adaptive thinking with the matching effort', async () => {
  for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) {
    await withApi(async (config, requests, { mkConfig }) => {
      const cfg = mkConfig({ CCW_API_REASONING: level, CCW_API_MAX_TOKENS: '4096' });
      await send(cfg);
      const body = requests.at(0).body;
      if (level === 'off') {
        assert.equal(body.thinking, undefined, 'off must not send a thinking field');
        assert.equal(body.output_config, undefined, 'off must not send an effort');
        assert.equal(body.max_tokens, 4096, 'off keeps the configured limit');
      } else {
        assert.deepEqual(body.thinking, { type: 'adaptive' }, level);
        assert.deepEqual(body.output_config, { effort: level }, level);
        assert.equal(body.max_tokens, 4096, `${level} keeps the configured hard output limit`);
        assert.equal(JSON.stringify(body).includes('budget_tokens'), false, 'manual budgets are rejected upstream');
      }
    });
  }
});

test('api: reasoning keeps a configured hard limit and off is the default', async () => {
  await withApi(async (config, requests) => {
    assert.equal(config.apiReasoning, 'off');
    await send(config);
    assert.equal(requests.at(0).body.thinking, undefined);
    assert.equal(requests.at(0).body.output_config, undefined);
  });
  await withApi(async (config, requests, { mkConfig }) => {
    const cfg = mkConfig({ CCW_API_REASONING: 'max', CCW_API_MAX_TOKENS: '60000' });
    await send(cfg);
    assert.equal(requests.at(0).body.max_tokens, 60000, 'a larger configured limit wins');
    assert.deepEqual(requests.at(0).body.output_config, { effort: 'max' });
  });
  await withApi(async (config, requests, { mkConfig }) => {
    const cfg = mkConfig({ CCW_API_REASONING: 'high', CCW_API_MAX_TOKENS: '20000' });
    assert.equal(cfg.apiMaxTokens, 20000, 'the configured value is never rewritten');
    await send(cfg);
    assert.equal(requests.at(0).body.max_tokens, 20000);
  });
});

test('api: reasoning reads the startup config file and the environment wins', async () => {
  const home = await makeTmpDir();
  const dir = join(home, '.config', 'claude-web-api');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(dir, 'config.json'), JSON.stringify({ apiReasoning: 'xhigh', backend: 'api', apiBaseUrl: 'https://api.example.com', apiModel: 'claude-opus-5-5' }), { mode: 0o600 });
  const fromFile = loadConfig({ HOME: home, CCW_API_KEY: SECRET });
  assert.equal(fromFile.apiReasoning, 'xhigh');
  const overridden = loadConfig({ HOME: home, CCW_API_KEY: SECRET, CCW_API_REASONING: 'max' });
  assert.equal(overridden.apiReasoning, 'max');
  const invalidFile = join(dir, 'config.json');
  await fs.writeFile(invalidFile, JSON.stringify({ apiReasoning: 'turbo', backend: 'api', apiBaseUrl: 'https://api.example.com', apiModel: 'claude-opus-5-5' }), { mode: 0o600 });
  assert.throws(() => loadConfig({ HOME: home, CCW_API_KEY: SECRET }), { code: 'CONFIG_INVALID' });
});

test('api: an invalid reasoning level is refused before any request is sent', async () => {
  await withApi(async (config, requests, { mkConfig }) => {
    for (const level of ['maximum', 'Max', 'enabled', 'adaptive', '', '__proto__', 'constructor']) {
      assert.throws(() => mkConfig({ CCW_API_REASONING: level }), { code: 'CONFIG_INVALID' }, JSON.stringify(level));
    }
    assert.equal(requests.length, 0, 'no request may be sent for an invalid level');
  });
});

test('api: doctor reports the reasoning level, effort and effective limit', async () => {
  await withApi(async (config, requests, { mkConfig }) => {
    const cfg = mkConfig({ CCW_API_REASONING: 'max' });
    const doctor = await new ConsultBridge(cfg).doctor({});
    assert.deepEqual(doctor.api.reasoning, { level: 'max', effort: 'max', configuredMaxTokens: 2048 });
    assert.equal(doctor.api.maxTokens, 2048, 'doctor shows the limit actually sent');
    const off = await new ConsultBridge(mkConfig({})).doctor({});
    assert.deepEqual(off.api.reasoning, { level: 'off', effort: null, configuredMaxTokens: 2048 });
    assert.equal(off.api.maxTokens, 2048);
    assert.equal(requests.length, 0, 'doctor never sends');
    assert.ok(secretFree(doctor));
  });
});
