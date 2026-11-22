import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { BridgeError } from '../src/core/errors.mjs';
import { CdpClient } from '../src/core/cdp.mjs';
import { consumeCompletion } from '../src/core/sse.mjs';
import { withClaudeTab } from '../src/core/tab.mjs';
import { ClaudeApi, activeBranch, ROOT_PARENT } from '../src/core/claude-api.mjs';
import {
  FakeCdpServer, streamFromString, streamFromBytes, hangingStream,
  makeTmpDir, fetchHandlerFor, ClaudeService,
} from './helpers.mjs';
import * as fx from './fixtures.mjs';
import { cleanupTmpDirs } from './helpers.mjs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
after(() => cleanupTmpDirs());

// ---------- config --------------------------------------------------------

test('config: defaults and loopback variants', async () => {
  const home = await makeTmpDir('ccw-config-');
  const c = loadConfig({ HOME: home });
  assert.equal(c.cdpUrl, null);
  assert.equal(c.timeoutMs, 600_000);
  assert.equal(c.idleTimeoutMs, 120_000);
  assert.equal(c.stateDir, join(home, '.local', 'share', 'claude-web-api'));
  assert.equal(c.attachmentRootSource, null);
  assert.equal(c.attachmentConfigFile, '$HOME/.config/claude-web-api/config.json');

  assert.equal(loadConfig({ HOME: home, CCW_CDP_URL: 'http://localhost:9333' }).cdpUrl, 'http://localhost:9333');
  assert.equal(loadConfig({ HOME: home, CCW_CDP_URL: 'http://[::1]:9333' }).cdpUrl, 'http://[::1]:9333');
  assert.equal(loadConfig({ HOME: home, CCW_CDP_URL: 'http://127.0.0.1:9222' }).cdpUrl, 'http://127.0.0.1:9222');
});

test('config: startup file supplies filtered MCP environments without writing configuration', async () => {
  const home = await makeTmpDir('ccw-config-');
  const configDir = join(home, '.config', 'claude-web-api');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, 'config.json');
  const bytes = JSON.stringify({ cdpUrl: 'http://127.0.0.1:9222', attachmentRoot: home, timeoutMs: 4000, idleTimeoutMs: 3000 });
  await fs.writeFile(path, bytes, { mode: 0o600 });
  const conf = loadConfig({ HOME: home });
  assert.equal(conf.cdpUrl, 'http://127.0.0.1:9222');
  assert.equal(conf.attachmentRootReal, await fs.realpath(home));
  assert.equal(conf.attachmentRootSource, 'config');
  assert.equal(conf.attachmentConfigFile, '$HOME/.config/claude-web-api/config.json');
  assert.equal(conf.timeoutMs, 4000);
  assert.equal(conf.stateDir, join(home, '.local', 'share', 'claude-web-api'));
  assert.equal(loadConfig({ HOME: home, CCW_TIMEOUT_MS: '5000', CCW_CDP_URL: 'http://localhost:9333' }).timeoutMs, 5000);
  assert.equal(loadConfig({ HOME: home, CCW_TIMEOUT_MS: undefined }).timeoutMs, 4000);
  assert.equal(loadConfig({ HOME: home, CCW_ATTACHMENT_ROOT: home }).attachmentRootSource, 'env');
  assert.equal(await fs.readFile(path, 'utf8'), bytes);
});

test('config: attachment roots may use portable HOME-relative prefixes', async () => {
  const home = await makeTmpDir('ccw-config-');
  const approved = join(home, 'approved');
  await fs.mkdir(approved);
  for (const value of ['~/approved', '$HOME/approved']) {
    const configDir = join(home, '.config', 'claude-web-api');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(configDir, 'config.json'), JSON.stringify({ attachmentRoot: value }), { mode: 0o600 });
    const conf = loadConfig({ HOME: home });
    assert.equal(conf.attachmentRoot, approved);
    assert.equal(conf.attachmentRootReal, await fs.realpath(approved));
    assert.equal(conf.attachmentRootSource, 'config');
  }
  const linkedHome = join(home, 'linked-home');
  await fs.symlink(home, linkedHome);
  for (const value of ['~', '$HOME', '~/..', '~/linked-home']) {
    assert.throws(() => loadConfig({ HOME: home }, { attachmentRoot: value }), { code: 'CONFIG_INVALID' }, value);
  }
  assert.throws(() => loadConfig({ HOME: home }, { attachmentRoot: '~/missing' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => loadConfig({ HOME: home }, { attachmentRoot: '~' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => loadConfig({ HOME: home }, { attachmentRoot: '${HOME}/approved' }), { code: 'CONFIG_INVALID' });
});

test('config: directories under another product name are never read', async () => {
  const home = await makeTmpDir('ccw-config-');
  const foreignConfigDir = join(home, '.config', 'call-claude-webkit');
  const foreignStateDir = join(home, '.local', 'share', 'call-claude-webkit');
  await fs.mkdir(foreignConfigDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(foreignStateDir, { recursive: true });
  await fs.writeFile(join(foreignConfigDir, 'config.json'), JSON.stringify({ cdpUrl: 'http://127.0.0.1:9222' }), { mode: 0o600 });
  const conf = loadConfig({ HOME: home });
  // A config under a different product name is invisible to this runtime; the
  // built-in loopback default applies instead of the foreign value.
  assert.equal(conf.cdpUrl, null);
  assert.equal(conf.stateDir, join(home, '.local', 'share', 'claude-web-api'));
  assert.equal(loadConfig({ HOME: home, CCW_STATE_DIR: join(home, 'mine') }).stateDir, join(home, 'mine'));
});

test('config: startup file rejects unsafe files and invalid fields without exposing contents', async () => {
  const home = await makeTmpDir('ccw-config-');
  assert.equal(loadConfig({ HOME: home }).attachmentRoot, null);
  assert.deepEqual(await fs.readdir(home), []);
  const dir = join(home, '.config', 'claude-web-api');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'config.json');
  for (const text of [
    'bad JSON CONFIG_PRIVATE_MARKER', 'null', '[]', '{"__proto__":{}}', '{"unknown":"CONFIG_PRIVATE_MARKER"}',
    '{"attachmentRoot":42}', '{"cdpUrl":"https://example.invalid"}', '{"timeoutMs":{}}', ' '.repeat(16385),
  ]) {
    await fs.writeFile(path, text, { mode: 0o600 });
    assert.throws(() => loadConfig({ HOME: home }), e => e.code === 'CONFIG_INVALID' && !e.message.includes('CONFIG_PRIVATE_MARKER'));
  }
  await fs.writeFile(path, '{}');
  await fs.chmod(path, 0o666);
  assert.throws(() => loadConfig({ HOME: home }), { code: 'CONFIG_INVALID' });
  await fs.chmod(path, 0o600);
  await fs.rename(path, `${path}.owned`);
  await fs.symlink(`${path}.owned`, path);
  assert.throws(() => loadConfig({ HOME: home }), { code: 'CONFIG_INVALID' });
});

test('config: rejects non-loopback, credentials, path, missing port', () => {
  for (const url of [
    'https://127.0.0.1:9333',
    'http://example.com:9333',
    'http://192.168.1.5:9333',
    'http://127.0.0.1',
    'http://user:pass@127.0.0.1:9333',
    'http://127.0.0.1:9333/json',
    'http://127.0.0.1:9333/?x=1',
    'not a url',
  ]) {
    assert.throws(() => loadConfig({ CCW_CDP_URL: url }), (e) => e instanceof BridgeError && e.code === 'CONFIG_INVALID', url);
  }
});

test('config: timeout bounds, idle<=total, org uuid, absolute stateDir', () => {
  assert.throws(() => loadConfig({ CCW_TIMEOUT_MS: '500' }), /timeoutMs/);
  assert.throws(() => loadConfig({ CCW_TIMEOUT_MS: '600001' }), /timeoutMs/);
  assert.throws(() => loadConfig({ CCW_TIMEOUT_MS: 'abc' }), /positive integer/);
  assert.throws(() => loadConfig({ CCW_TIMEOUT_MS: '10000', CCW_IDLE_TIMEOUT_MS: '20000' }), /idleTimeoutMs/);
  assert.throws(() => loadConfig({ CCW_ORG_ID: 'not-uuid' }), /orgId/);
  assert.throws(() => loadConfig({}, { stateDir: 'relative/path' }), /absolute/);
  const c = loadConfig({ CCW_ORG_ID: fx.ORG_ID });
  assert.equal(c.orgId, fx.ORG_ID);
});

// ---------- consumeCompletion --------------------------------------------

test('sse: basic reply with uuid, model, stopReason, quota', async () => {
  const r = await consumeCompletion(streamFromString(fx.SSE_BASIC));
  assert.equal(r.reply, 'Hello world');
  assert.equal(r.assistantMessageId, fx.REPLY_UUID);
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.quota?.type, 'within_limit');
});

test('sse: completion status identifies a token-limited reply', async () => {
  const body = fx.sse([fx.msgStart(), fx.blockStart(), fx.textDelta(0, 'partial'), fx.blockStop(), fx.msgDelta('max_tokens'), fx.msgStop()]);
  const result = await consumeCompletion(streamFromString(body));
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal(result.complete, false);
});

test('sse: multibyte text split byte-by-byte', async () => {
  const r = await consumeCompletion(streamFromString(fx.SSE_THINKING, 1));
  assert.equal(r.reply, '可见回复');
  assert.equal(r.assistantMessageId, fx.REPLY_UUID_2);
});

test('sse: CRLF line endings and multi-line data fields, nonzero block index', async () => {
  const r = await consumeCompletion(streamFromString(fx.sseMultilineData()));
  assert.equal(r.reply, 'joined');
  assert.equal(r.assistantMessageId, fx.REPLY_UUID);
});

test('sse: multiple text blocks concatenate in index order', async () => {
  const r = await consumeCompletion(streamFromString(fx.SSE_TWO_TEXT_BLOCKS));
  assert.equal(r.reply, 'first-block second-block tail');
});

test('sse: ping events and comments ignored', async () => {
  const r = await consumeCompletion(streamFromString(fx.SSE_PING_COMMENTS));
  assert.equal(r.reply, 'ok');
});

test('sse: malformed JSON event data -> API_CONTRACT', async () => {
  await assert.rejects(() => consumeCompletion(streamFromString(fx.SSE_BAD_JSON)),
    (e) => e.code === 'API_CONTRACT');
});

test('sse: remote error event -> REMOTE_ERROR without echoing payload', async () => {
  await assert.rejects(() => consumeCompletion(streamFromString(fx.SSE_ERROR_EVENT)),
    (e) => e.code === 'REMOTE_ERROR' && e.message.includes('slow down'));
});

test('sse: EOF without message_stop -> STREAM_INCOMPLETE with bounded partial', async () => {
  await assert.rejects(() => consumeCompletion(streamFromString(fx.SSE_NO_STOP)), (e) => {
    assert.equal(e.code, 'STREAM_INCOMPLETE');
    assert.equal(e.details.partialReply, 'partial reply here');
    return true;
  });
});

test('sse: missing assistant uuid -> API_CONTRACT', async () => {
  await assert.rejects(() => consumeCompletion(streamFromString(fx.SSE_NO_UUID)),
    (e) => e.code === 'API_CONTRACT');
});

test('sse: empty reply -> API_CONTRACT', async () => {
  await assert.rejects(() => consumeCompletion(streamFromString(fx.SSE_EMPTY_REPLY)),
    (e) => e.code === 'API_CONTRACT');
});

test('sse: maxBytes exceeded -> PAYLOAD_TOO_LARGE', async () => {
  await assert.rejects(
    () => consumeCompletion(streamFromString(fx.SSE_BASIC), { maxBytes: 64 }),
    (e) => e.code === 'PAYLOAD_TOO_LARGE',
  );
});

test('sse: onChunk receives accumulating reply', async () => {
  const seen = [];
  await consumeCompletion(streamFromString(fx.SSE_BASIC), { onChunk: (r) => seen.push(r) });
  assert.deepEqual(seen, ['Hello', 'Hello world']);
});

// ---------- CdpClient ------------------------------------------------------

test('cdp: connect, send, close against fake server', async () => {
  const service = new ClaudeService();
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service) }).start();
  try {
    const client = await CdpClient.connect(server.cdpUrl);
    assert.equal(client.versionInfo.Browser, 'FakeChrome/1.0');
    const { targetId } = await client.send('Target.createTarget', { url: 'https://claude.ai/new' });
    assert.equal(targetId, 'target-1');
    client.close();
    assert.equal(client.closed, true);
    await assert.rejects(() => client.send('Target.createTarget'), (e) => e.code === 'CDP_CLOSED');
  } finally {
    await server.stop();
  }
});

test('cdp: rejects malicious/foreign websocket debugger urls', async () => {
  for (const wsUrl of [
    'ws://169.254.1.1:9333/devtools/browser/x',
    'ws://evil.example/devtools/browser/x',
    'wss://127.0.0.1:1/devtools/browser/x',
  ]) {
    const server = await new FakeCdpServer({ fetchHandler: async () => ({}), wsUrl }).start();
    try {
      await assert.rejects(() => CdpClient.connect(server.cdpUrl), (e) => e.code === 'CDP_INVALID', wsUrl);
    } finally {
      await server.stop();
    }
  }
  // debugger path that is not a browser target
  const bad = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  try {
    bad.wsUrlOverride = `ws://127.0.0.1:${bad.port}/devtools/page/x`;
    await assert.rejects(() => CdpClient.connect(bad.cdpUrl), (e) => e.code === 'CDP_INVALID');
  } finally {
    await bad.stop();
  }
});

test('cdp: unreachable endpoint and wrong port -> CDP_UNREACHABLE', async () => {
  await assert.rejects(() => CdpClient.connect('http://127.0.0.1:1', { timeoutMs: 2000 }),
    (e) => e.code === 'CDP_UNREACHABLE');
});

test('cdp: pending requests reject when the socket closes', async () => {
  const server = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  try {
    const client = await CdpClient.connect(server.cdpUrl);
    const pending = client.send('Target.createTarget');
    for (const ws of server.sockets) ws.terminate();
    await assert.rejects(() => pending, (e) => e.code === 'CDP_CLOSED');
  } finally {
    await server.stop();
  }
});

test('cdp: send timeout', async () => {
  const server = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  server.onMessage = () => {};
  // drop responses by making the server never answer: override via method
  const client = await CdpClient.connect(server.cdpUrl);
  try {
    server.dropResponses = true;
    const orig = server.onMessage;
    // simplest deterministic path: unsupported method returns error fast,
    // so instead kill the socket handler after connect
    for (const ws of server.sockets) ws.removeAllListeners('message');
    await assert.rejects(
      () => client.send('Target.createTarget', {}, { timeoutMs: 100 }),
      (e) => e.code === 'CDP_TIMEOUT',
    );
    client.close();
    void orig;
  } finally {
    await server.stop();
  }
});

// ---------- withClaudeTab + tab.request ------------------------------------

const testConfig = (cdpUrl, extra = {}) => ({
  cdpUrl, orgId: null, timeoutMs: 10_000, idleTimeoutMs: 500,
  readyTimeoutMs: 5_000, minIntervalMs: 0, stateDir: '/tmp/x', ...extra,
});

test('tab: full round trip creates own target, requests orgs, closes it', async () => {
  const service = new ClaudeService();
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service) }).start();
  try {
    const result = await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      const orgs = await tab.request({ path: '/api/organizations' });
      assert.ok(Array.isArray(orgs));
      return orgs[0].uuid;
    });
    assert.equal(result, fx.ORG_ID);
    assert.equal(server.createdTargets.length, 1);
    assert.deepEqual(server.closedTargets, [server.createdTargets[0].targetId]);
  } finally {
    await server.stop();
  }
});

test('tab: refuses non-claude origin and does not close an out-of-scope target', async () => {
  const server = await new FakeCdpServer({ fetchHandler: async () => ({}), origin: 'https://evil.example' }).start();
  try {
    await assert.rejects(
      () => withClaudeTab(testConfig(server.cdpUrl, { readyTimeoutMs: 800 }), async () => {}),
      (e) => e.code === 'ORIGIN_MISMATCH',
    );
    assert.equal(server.closedTargets.length, 0);
  } finally {
    await server.stop();
  }
});

test('tab: attach failure still closes the created target', async () => {
  const server = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  const orig = server.onMessage;
  server.onMessage = (msg) => {
    if (msg.method === 'Target.attachToTarget') {
      // make attach fail by terminating the socket response path
      for (const ws of server.sockets) {
        ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: 'attach denied' } }));
      }
      server.onMessage = orig;
    }
  };
  try {
    await assert.rejects(
      () => withClaudeTab(testConfig(server.cdpUrl), async () => {}),
      (e) => e.code === 'CDP_ERROR',
    );
    assert.equal(server.closedTargets.length, 1);
  } finally {
    await server.stop();
  }
});

test('tab: cancellation during target creation still closes the owned target', async () => {
  const server = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  const controller = new AbortController();
  let called = false;
  server.onMessage = (message) => {
    if (message.method === 'Target.createTarget') controller.abort();
  };
  try {
    await assert.rejects(
      () => withClaudeTab(testConfig(server.cdpUrl), async () => { called = true; }, { signal: controller.signal }),
      (error) => error.code === 'ABORTED',
    );
    assert.equal(called, false);
    assert.equal(server.createdTargets.length, 1);
    assert.deepEqual(server.closedTargets, server.createdTargets.map((target) => target.targetId));
  } finally {
    await server.stop();
  }
});

test('tab: delayed creation returns promptly and later closes only the proven blank target', async () => {
  const service = new ClaudeService();
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service }).start();
  const controller = new AbortController();
  server.createTargetResponseDelayMs = 300;
  server.onMessage = message => { if (message.method === 'Target.createTarget') setTimeout(() => controller.abort(), 10); };
  try {
    const started = Date.now();
    await assert.rejects(() => withClaudeTab(testConfig(server.cdpUrl, { readyTimeoutMs: 1000 }), async () => {}, { signal: controller.signal }),
      error => error.code === 'ABORTED' && error.details.cleanupPending === true);
    assert.ok(Date.now() - started < 250);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(server.closedTargets, ['target-1']);
  } finally { await server.stop(); }
});

test('tab: late creation preserves a target with user activity; missing response reports risk', async () => {
  const service = new ClaudeService();
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service }).start();
  const controller = new AbortController();
  server.createTargetResponseDelayMs = 220;
  server.onMessage = message => { if (message.method === 'Target.createTarget') setTimeout(() => controller.abort(), 10); };
  server.onPage = page => { page.editor.innerText = 'user draft'; };
  try {
    await assert.rejects(() => withClaudeTab(testConfig(server.cdpUrl, { readyTimeoutMs: 1000 }), async () => {}, { signal: controller.signal }),
      error => error.code === 'ABORTED' && error.details.cleanupPending === true);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(server.closedTargets, []);
  } finally { await server.stop(); }

  const lost = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  lost.suppressCreateTargetResponse = true;
  try {
    const started = Date.now();
    await assert.rejects(() => withClaudeTab(testConfig(lost.cdpUrl, { readyTimeoutMs: 100 }), async () => {}),
      error => error.code === 'CDP_TIMEOUT' && error.details.cleanupPending === true);
    assert.ok(Date.now() - started < 450);
  } finally { await lost.stop(); }
});

test('tab: plain operations retain a page with user attachments or unreadable activity', async () => {
  for (const mode of ['attachment', 'unreadable']) {
    const service = new ClaudeService();
    const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service }).start();
    try {
      const result = await withClaudeTab(testConfig(server.cdpUrl), async () => {
        const page = server.pageFor();
        if (mode === 'attachment') page.nativeFiles.push({ name: 'user.png' });
        else page.sandbox.document.querySelector = () => null;
        return { ok: true };
      });
      assert.equal(server.closedTargets.length, 0, mode);
      assert.deepEqual(result.browserCleanup, { closeUnconfirmed: true, targetId: 'target-1' });
    } finally { await server.stop(); }
  }
});

test('tab: refuses non-whitelisted paths', async () => {
  const server = await new FakeCdpServer({ fetchHandler: async () => ({}) }).start();
  try {
    await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      for (const p of ['/claudeai-rpc/foo', '/api/other', 'https://claude.ai/api/organizations', '/api/organizations/../x']) {
        await assert.rejects(() => tab.request({ path: p }), (e) => e.code === 'INVALID_PATH', p);
      }
      await assert.rejects(
        () => tab.request({ path: '/api/organizations', method: 'DELETE' }),
        (e) => e.code === 'INVALID_PATH',
      );
    });
  } finally {
    await server.stop();
  }
});

test('tab: HTTP status mapping and wrong content-type', async () => {
  const cases = [
    [{ status: 401 }, 'AUTH_REQUIRED'],
    [{ status: 403 }, 'ACCESS_DENIED'],
    [{ status: 429, headers: { 'retry-after': '30' } }, 'RATE_LIMITED'],
    [{ status: 404 }, 'NOT_FOUND'],
    [{ status: 503 }, 'SERVICE_UNAVAILABLE'],
    [{ status: 200, contentType: 'text/html', body: '<html></html>' }, 'API_CONTRACT'],
  ];
  for (const [resp, code] of cases) {
    const server = await new FakeCdpServer({ fetchHandler: async () => resp }).start();
    try {
      await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
        await assert.rejects(
          () => tab.request({ path: '/api/organizations' }),
          (e) => e.code === code && (code !== 'RATE_LIMITED' || e.details.retryAfterSec === 30),
          `${resp.status} -> ${code}`,
        );
      });
    } finally {
      await server.stop();
    }
  }
});

test('tab: SSE completion through the injected page function', async () => {
  const server = await new FakeCdpServer({
    fetchHandler: async (path) => {
      assert.ok(path.endsWith('/completion'));
      return { status: 200, contentType: 'text/event-stream', body: fx.SSE_BASIC };
    },
  }).start();
  try {
    await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      const r = await tab.request({
        path: `/api/organizations/${fx.ORG_ID}/chat_conversations/${fx.CONV_ID}/completion`,
        method: 'POST',
        body: { prompt: 'hi' },
        stream: true,
      });
      assert.equal(r.reply, 'Hello world');
      assert.equal(r.assistantMessageId, fx.REPLY_UUID);
    });
  } finally {
    await server.stop();
  }
});

test('tab: idle timeout aborts a hanging stream', async () => {
  const server = await new FakeCdpServer({
    fetchHandler: async () => ({ status: 200, contentType: 'text/event-stream', body: hangingStream() }),
  }).start();
  try {
    await withClaudeTab(testConfig(server.cdpUrl, { idleTimeoutMs: 150, timeoutMs: 5000 }), async (tab) => {
      await assert.rejects(
        () => tab.request({
          path: `/api/organizations/${fx.ORG_ID}/chat_conversations/${fx.CONV_ID}/completion`,
          method: 'POST', body: {}, stream: true,
        }),
        (e) => e.code === 'IDLE_TIMEOUT',
      );
    });
  } finally {
    await server.stop();
  }
});

test('tab: external abort cancels via the page abort handle', async () => {
  let fetchSawAbort = false;
  const server = await new FakeCdpServer({
    fetchHandler: async (path, opts) => {
      opts.signal.addEventListener('abort', () => { fetchSawAbort = true; });
      return { status: 200, contentType: 'text/event-stream', body: hangingStream() };
    },
  }).start();
  try {
    const ac = new AbortController();
    await assert.rejects(
      () => withClaudeTab(testConfig(server.cdpUrl, { idleTimeoutMs: 5000 }), async (tab) => {
        setTimeout(() => ac.abort(), 60);
        await tab.request({
          path: `/api/organizations/${fx.ORG_ID}/chat_conversations/${fx.CONV_ID}/completion`,
          method: 'POST', body: {}, stream: true,
        }, { signal: ac.signal });
      }),
      (e) => e.code === 'ABORTED',
    );
    // give the fire-and-forget abort evaluate a moment to reach the page
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fetchSawAbort, true);
  } finally {
    await server.stop();
  }
});

test('tab: prompt is passed as data, not concatenated into JS', async () => {
  let received;
  const server = await new FakeCdpServer({
    fetchHandler: async (path, opts) => {
      received = opts;
      return { status: 200, contentType: 'application/json', body: '[]' };
    },
  }).start();
  const sneaky = '"; process.exit(1); //';
  try {
    await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      await tab.request({
        path: `/api/organizations/${fx.ORG_ID}/chat_conversations`,
        method: 'POST',
        body: { uuid: fx.CONV_ID, name: sneaky },
      });
    });
    assert.ok(String(received.body).includes('process.exit'));
    assert.equal(JSON.parse(received.body).name, sneaky);
  } finally {
    await server.stop();
  }
});

// ---------- ClaudeApi + activeBranch ----------------------------------------

test('claude-api: org selection - single, ambiguous, explicit, api-only', async () => {
  const service = new ClaudeService({ orgs: fx.ORGS_DUAL });
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service) }).start();
  try {
    await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      const api = new ClaudeApi(tab, testConfig(server.cdpUrl));
      assert.equal(await api.discoverOrganization(), fx.ORG_ID);
      const apiExplicit = new ClaudeApi(tab, testConfig(server.cdpUrl, { orgId: fx.ORGS_DUAL[1].uuid }));
      await assert.rejects(() => apiExplicit.discoverOrganization(), (e) => e.code === 'ORG_NOT_FOUND');
      const apiOk = new ClaudeApi(tab, testConfig(server.cdpUrl, { orgId: fx.ORG_ID }));
      assert.equal(await apiOk.discoverOrganization(), fx.ORG_ID);
    });
  } finally {
    await server.stop();
  }
});

test('claude-api: ambiguous chat orgs require explicit selection', async () => {
  const service = new ClaudeService({ orgs: fx.ORGS_AMBIGUOUS });
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service) }).start();
  try {
    await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      const api = new ClaudeApi(tab, testConfig(server.cdpUrl));
      await assert.rejects(() => api.discoverOrganization(), (e) => e.code === 'ORG_AMBIGUOUS');
    });
  } finally {
    await server.stop();
  }
});

test('activeBranch: chronological lineage, excludes side branches', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const C = 'cccccccc-0000-4000-8000-000000000003';
  const S = 'dddddddd-0000-4000-8000-000000000004';
  const m = (uuid, parent, sender = 'human') => ({ uuid, parent_message_uuid: parent, sender, content: [] });
  const branch = activeBranch({
    current_leaf_message_uuid: C,
    chat_messages: [m(S, ROOT_PARENT), m(A, ROOT_PARENT), m(B, A, 'assistant'), m(C, B, 'assistant')],
  });
  assert.deepEqual(branch.map((x) => x.uuid), [A, B, C]);
});

test('activeBranch: rejects malformed graphs and missing chat_messages', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const m = (uuid, parent) => ({ uuid, parent_message_uuid: parent, sender: 'human', content: [] });
  for (const conv of [
    { current_leaf_message_uuid: A, chat_messages: [m(A, ROOT_PARENT), m(A, ROOT_PARENT)] },
    { current_leaf_message_uuid: A, chat_messages: [m(A, B), m(B, A)] },
    { current_leaf_message_uuid: B, chat_messages: [m(A, ROOT_PARENT)] },
    { current_leaf_message_uuid: null, chat_messages: [m(A, ROOT_PARENT)] },
    { current_leaf_message_uuid: A },
    { current_leaf_message_uuid: A, chat_messages: [{ uuid: 'bad', parent_message_uuid: ROOT_PARENT, sender: 'human', content: [] }] },
    { current_leaf_message_uuid: A, chat_messages: [m(A, 'not-a-uuid')] },
  ]) {
    assert.throws(() => activeBranch(conv), (e) => e.code === 'API_CONTRACT', JSON.stringify(conv).slice(0, 80));
  }
  assert.deepEqual(activeBranch({ current_leaf_message_uuid: null, chat_messages: [] }), []);
  assert.deepEqual(activeBranch({ current_leaf_message_uuid: ROOT_PARENT, chat_messages: [] }), []);
});

// ---------- R7 lifecycle + R4/R5 additions ----------------------------------

test('sse: strict lifecycle rejects malformed streams', async () => {
  for (const body of [fx.SSE_DUP_START, fx.SSE_DUP_BLOCK, fx.SSE_DELTA_UNKNOWN,
    fx.SSE_DELTA_AFTER_STOP, fx.SSE_STOP_UNKNOWN, fx.SSE_STOP_NO_REASON, fx.SSE_BAD_INDEX]) {
    await assert.rejects(() => consumeCompletion(streamFromString(body)), (e) => e.code === 'API_CONTRACT');
  }
});

test('cdp: version body that stalls after headers hits the connect deadline', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"webSocketDebuggerUrl":'); // headers + partial body, then stall
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}`;
    const t0 = Date.now();
    await assert.rejects(() => CdpClient.connect(url, { timeoutMs: 400 }), (e) => e.code === 'CDP_UNREACHABLE');
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test('cdp: oversized version body -> CDP_INVALID', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('x'.repeat(80 * 1024));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      () => CdpClient.connect(`http://127.0.0.1:${srv.address().port}`),
      (e) => e.code === 'CDP_INVALID',
    );
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('claude-api: strict conversation schema - wrong uuid/missing fields never reach a send', async () => {
  for (const resp of [
    { status: 200, body: JSON.stringify({ uuid: 'eeeeeeee-0000-4000-8000-000000000001', chat_messages: [], current_leaf_message_uuid: null }) },
    { status: 200, body: JSON.stringify({ uuid: fx.CONV_ID, current_leaf_message_uuid: null }) },
    { status: 200, body: JSON.stringify({ uuid: fx.CONV_ID, chat_messages: [{ uuid: '01a1c813-8618-7628-b37b-12d140349c2c', parent_message_uuid: ROOT_PARENT, sender: 'human', content: [] }] }) },
    { status: 200, body: JSON.stringify({ uuid: fx.CONV_ID, chat_messages: [{ uuid: 'bad', parent_message_uuid: 'x', sender: 'human', content: 'no' }], current_leaf_message_uuid: 'bad' }) },
  ]) {
    const server = await new FakeCdpServer({ fetchHandler: async () => resp }).start();
    try {
      await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
        const api = new ClaudeApi(tab, testConfig(server.cdpUrl));
        await assert.rejects(
          () => api.conversation(fx.ORG_ID, fx.CONV_ID),
          (e) => e.code === 'API_CONTRACT',
          resp.body.slice(0, 60),
        );
      });
    } finally {
      await server.stop();
    }
  }
});

test('claude-api: an empty conversation may omit current_leaf_message_uuid', async () => {
  const resp = { status: 200, body: JSON.stringify({ uuid: fx.CONV_ID, chat_messages: [] }) };
  const server = await new FakeCdpServer({ fetchHandler: async () => resp }).start();
  try {
    await withClaudeTab(testConfig(server.cdpUrl), async (tab) => {
      const api = new ClaudeApi(tab, testConfig(server.cdpUrl));
      const data = await api.conversation(fx.ORG_ID, fx.CONV_ID);
      assert.equal(data.current_leaf_message_uuid ?? null, null);
      assert.deepEqual(activeBranch(data), []);
    });
  } finally {
    await server.stop();
  }
});

test('sse: strict text-block data validation', async () => {
  const bad = [
    fx.sse([fx.blockStart(0), fx.textDelta(0, 'x'), fx.msgDelta(), fx.msgStop()]), // block before message_start
    fx.sse([fx.msgStart(), fx.blockStart(0), ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } })], fx.msgDelta(), fx.msgStop()]), // missing text
    fx.sse([fx.msgStart(), fx.blockStart(0), ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 5 } })], fx.msgDelta(), fx.msgStop()]),
    fx.sse([fx.msgStart(), fx.blockStart(0, 'thinking'), fx.textDelta(0, 'must not be silently dropped'), fx.blockStop(0), fx.msgDelta(), fx.msgStop()]),
  ];
  for (const body of bad) {
    await assert.rejects(() => consumeCompletion(streamFromString(body)), (e) => e.code === 'API_CONTRACT');
  }
  // EOF flush: final message_stop event with no trailing blank line still completes
  const tail = fx.SSE_PING_COMMENTS.replace(/\n\n$/, '\n');
  const r = await consumeCompletion(streamFromString(tail));
  assert.equal(r.reply, 'ok');
});
