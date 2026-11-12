import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { probeHost } from '../src/install/probe.mjs';
import { findHost, sourcePaths, installHost } from '../src/install/engine.mjs';
import { defaultIo, sha256 } from '../src/install/atomic.mjs';
import { TOOLS, EXECUTABLE_GUIDANCE_CONTRACT } from '../src/tool-contracts.mjs';
import { run } from '../scripts/install-agents.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());
const io = defaultIo(), paths = sourcePaths();
async function fixture() {
  const home = await fs.realpath(await makeTmpDir('ccw-probe-'));
  const host = findHost('pi');
  const target = host.resolve({ home, env: { HOME: home }, stateDir: join(home, 'state') });
  return { home, host, target, deps: { ...paths, io, home } };
}
async function put(path, text) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text, { mode: 0o600 }); }
async function snapshot(root, prefix = '') {
  const result = {};
  for (const item of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, item.name), path = join(root, rel), st = await fs.lstat(path);
    result[rel] = { mode: st.mode & 0o777, type: item.isDirectory() ? 'dir' : 'file', ...(item.isFile() ? { hash: sha256(await fs.readFile(path)) } : {}) };
    if (item.isDirectory()) Object.assign(result, await snapshot(root, rel));
  }
  return result;
}
async function configureHub(f, url, { entry = {}, library = {} } = {}) {
  await put(f.target.configPath, JSON.stringify({ mcpServers: { magpie: { url, ...entry } } }));
  await put(join(f.home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true,
    mcp: [{ name: 'claude_web', command: paths.nodePath, args: [paths.mcpPath], transport: 'stdio', agents: ['pi'] }], ...library }));
}
async function mcp(t, options = {}) {
  const methods = [], sockets = new Set(); let connections = 0, active = 0;
  const server = http.createServer(async (req, res) => {
    active++; res.once('close', () => { active--; });
    if (req.method !== 'POST') { methods.push(req.method); res.writeHead(405).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString()); methods.push(msg.method);
    if (options.handler && await options.handler(req, res, msg)) return;
    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') { res.writeHead(202).end(); return; }
    if (msg.method === 'tools/call') { throw new Error('Probe must never call Claude'); }
    const result = msg.method === 'initialize'
      ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-local-hub', version: '1' }, instructions: options.instructions ?? 'Summary only; not the full contract.' }
      : { tools: structuredClone(options.tools ?? TOOLS), ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}) };
    if (options.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    }
  });
  server.on('connection', socket => { connections++; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/mcp/magpie/hub/pi`, methods, sockets, connections: () => connections, active: () => active };
}
async function cli(f, args) {
  let output = '', stderr = '';
  const code = await run(args, { env: { HOME: f.home }, stdout: { write: s => { output += s; } }, stderr: { write: s => { stderr += s; } } });
  return { code, out: JSON.parse(output), stderr };
}

test('probe: full live schemas with summarized initialize are sufficient only at protocol level, JSON and SSE transports', async t => {
  for (const sse of [false, true]) {
    const f = await fixture(), server = await mcp(t, { sse }); await configureHub(f, server.url);
    const before = await snapshot(f.home);
    const result = await probeHost(f.host, f.target, f.deps);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.reachable, true);
    assert.equal(result.verification, 'protocol-only'); assert.equal(result.hostLoaded, false); assert.equal(result.claudeSent, false);
    assert.equal(result.toolCount, 6); assert.equal(result.guidanceInInitialize, false); assert.equal(result.guidanceInSendSchemas, true);
    assert.equal(result.contractSha256, sha256(EXECUTABLE_GUIDANCE_CONTRACT));
    assert.deepEqual(server.methods, ['initialize', 'notifications/initialized', 'tools/list']);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(server.active(), 0, 'probe leaves no active MCP HTTP request');
    assert.deepEqual(await snapshot(f.home), before);
    assert.match(result.nextAction, /reconnect Pi agent/);
  }
});

test('probe: stale send descriptions, missing tools and duplicate names fail without tools/call or cache mutation', async t => {
  for (const mode of ['stale', 'missing', 'duplicate', 'invalid-schema']) {
    const tools = structuredClone(TOOLS);
    if (mode === 'stale') for (const tool of tools) if (tool.inputSchema.properties.prompt) tool.inputSchema.properties.prompt.description = 'short reference only';
    if (mode === 'missing') tools.pop();
    if (mode === 'duplicate') tools.push(tools[0]);
    if (mode === 'invalid-schema') tools[0].inputSchema.properties.prompt.type = 'number';
    const f = await fixture(), server = await mcp(t, { tools }); await configureHub(f, server.url);
    const before = await snapshot(f.home);
    const result = await probeHost(f.host, f.target, f.deps);
    assert.equal(result.ok, false); assert.equal(result.cacheChanged, false);
    assert.equal(result.error.code, mode === 'duplicate' ? 'PROBE_TOOL_CONFLICT' : 'PROBE_STALE_SCHEMA');
    assert.equal(server.methods.includes('tools/call'), false); assert.equal(server.methods.includes('DELETE'), false);
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('probe: both send tools require an optional false-default guidance boolean', async t => {
  for (const name of ['claude_ask', 'claude_follow_up']) {
    for (const defect of ['missing', 'wrong-type', 'required', 'true-default', 'missing-default']) {
      const tools = JSON.parse(JSON.stringify(TOOLS));
      const schema = tools.find(tool => tool.name === name).inputSchema;
      if (defect === 'missing') delete schema.properties.guidance;
      if (defect === 'wrong-type') schema.properties.guidance.type = 'string';
      if (defect === 'required') schema.required.push('guidance');
      if (defect === 'true-default') schema.properties.guidance.default = true;
      if (defect === 'missing-default') delete schema.properties.guidance.default;
      const f = await fixture(), server = await mcp(t, { tools });
      await configureHub(f, server.url);
      const before = await snapshot(f.home);
      const result = await probeHost(f.host, f.target, f.deps);
      assert.equal(result.ok, false, `${name}:${defect}`);
      assert.equal(result.error.code, 'PROBE_STALE_SCHEMA', `${name}:${defect}`);
      assert.deepEqual(result.staleSchemas, [name]);
      assert.equal(result.guidanceInSendSchemas, false);
      assert.equal(result.verification, 'protocol-only');
      assert.equal(result.claudeSent, false);
      assert.deepEqual(server.methods, ['initialize', 'notifications/initialized', 'tools/list']);
      assert.deepEqual(await snapshot(f.home), before);
    }
  }
});

test('probe: discovery-only hub is unverified, not stale or missing; meta-tools are never called', async t => {
  const tools = [
    { name: 'find_tools', description: 'Find backend metadata', inputSchema: { type: 'object', properties: { query: { type: 'string' }, server: { type: 'string' } } } },
    { name: 'call_tool', description: 'Invoke backend tool', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  ];
  const f = await fixture(), server = await mcp(t, { tools }); await configureHub(f, server.url);
  const result = await probeHost(f.host, f.target, f.deps);
  assert.equal(result.ok, false); assert.equal(result.reachable, true); assert.equal(result.discoveryOnly, true);
  assert.equal(result.error.code, 'PROBE_DISCOVERY_ONLY'); assert.equal(result.staleSchemas, null); assert.equal(result.missingTools, null);
  assert.equal(result.guidanceInSendSchemas, null); assert.match(result.nextAction, /find_tools/);
  assert.deepEqual(server.methods, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('probe: exact source namespace accepted; ambiguous delivery names refused', async t => {
  for (const ambiguous of [false, true]) {
    const tools = structuredClone(TOOLS).map(tool => ({ ...tool, name: 'claude_web__' + tool.name }));
    if (ambiguous) tools.push(structuredClone(TOOLS[0]));
    const f = await fixture(), server = await mcp(t, { tools }); await configureHub(f, server.url);
    const result = await probeHost(f.host, f.target, f.deps);
    assert.equal(result.ok, !ambiguous, JSON.stringify(result));
    if (ambiguous) assert.equal(result.error.code, 'PROBE_TOOL_CONFLICT');
  }
});

test('probe: redirects are refused without visiting destination or exposing response bodies', async t => {
  let visits = 0;
  const destination = http.createServer((req, res) => { visits++; res.end('must-not-visit'); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  t.after(() => new Promise(resolve => destination.close(resolve)));
  const server = await mcp(t, { handler: async (req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/secret` }); res.end('private-token-not-for-output'); return true; } });
  const f = await fixture(); await configureHub(f, server.url);
  const result = await probeHost(f.host, f.target, f.deps);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'PROBE_REDIRECT_REFUSED'); assert.equal(visits, 0);
  assert.ok(!JSON.stringify(result).includes('private-token-not-for-output'));
  assert.deepEqual(server.methods, ['initialize']);
});

test('probe: non-local URLs, unknown paths, auth-bearing routes and unverified programs are refused without fetching or executing', async () => {
  const f = await fixture(); let calls = 0;
  const fetchImpl = () => { calls++; throw new Error('network must be unused'); };
  for (const url of ['https://example.invalid/mcp', 'http://127.0.0.2:3425/mcp/magpie/hub/pi', 'http://127.0.0.1:3425/other', 'http://localhost:3425/mcp/magpie/hub/pi']) {
    await configureHub(f, url); assert.equal((await probeHost(f.host, f.target, { ...f.deps, fetchImpl })).ok, false);
  }
  await configureHub(f, 'http://127.0.0.1:3425/mcp/magpie/hub/pi', { entry: { headers: { Authorization: 'never-copy-this-token' } } });
  const authenticated = await probeHost(f.host, f.target, { ...f.deps, fetchImpl });
  assert.equal(authenticated.error.code, 'PROBE_ROUTE_REFUSED'); assert.ok(!JSON.stringify(authenticated).includes('never-copy-this-token'));
  const marker = join(f.home, 'danger-was-executed'), malicious = join(f.home, 'fake/src/mcp-server.mjs');
  await put(malicious, `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  await put(f.target.configPath, JSON.stringify({ mcpServers: { claude_web: { command: process.execPath, args: [malicious] } } }));
  assert.equal((await probeHost(f.host, f.target, { ...f.deps, fetchImpl })).ok, false);
  await assert.rejects(() => fs.access(marker)); assert.equal(calls, 0);
});

test('probe: timeout and cancellation release sockets; EOF and HTTP failures are non-retrying and sanitized', async t => {
  for (const mode of ['timeout', 'abort', 'disconnect', 'http']) {
    const f = await fixture();
    const controller = new AbortController();
    const server = await mcp(t, { handler: async (req, res, message) => {
      if (message.method !== 'initialize') return false;
      if (mode === 'abort') controller.abort();
      else if (mode === 'disconnect') res.destroy();
      else if (mode === 'http') { res.writeHead(503).end('secret-error-from-server'); }
      return true;
    } });
    await configureHub(f, server.url);
    // Exercise cancellation of a real request, not cancellation during file
    // inspection because parallel tests delayed a fixed 30ms timer. The
    // separate provenance-deadline test below covers zero-network timeouts.
    const timeoutMs = mode === 'timeout' ? 1000 : 3000;
    const start = Date.now();
    const result = await probeHost(f.host, f.target, { ...f.deps, timeoutMs, signal: controller.signal });
    assert.equal(result.ok, false, mode);
    assert.equal(result.error.code, { timeout: 'PROBE_TIMEOUT', abort: 'PROBE_ABORTED', disconnect: 'PROBE_PROTOCOL_ERROR', http: 'PROBE_HTTP_ERROR' }[mode]);
    assert.ok(Date.now() - start < timeoutMs + 1500); assert.deepEqual(server.methods, ['initialize']);
    assert.ok(!JSON.stringify(result).includes('secret-error-from-server'));
    // Wait on actual peer closure, not a fixed sleep, then prove no request
    // survives the cancellation deadline (idle pooled sockets are harmless).
    if (server.active()) await Promise.race([
      Promise.all([...server.sockets].map(socket => once(socket, 'close'))),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('probe request not closed')), 500); timer.unref(); }),
    ]);
    assert.equal(server.active(), 0, 'cancelled probe has no in-flight request');
  }
});

test('probe: response and pagination limits prevent unbounded metadata', async t => {
  for (const mode of ['oversize', 'cursor']) {
    const f = await fixture(), server = await mcp(t, mode === 'cursor' ? { nextCursor: 'repeated' } : { handler: async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 }); res.end('x'); return true;
    } });
    await configureHub(f, server.url);
    const result = await probeHost(f.host, f.target, f.deps);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'PROBE_LIMIT', JSON.stringify(result));
    assert.ok(server.methods.length <= 4);
  }
});

test('probe: actual CLI plain check never connects; --check --probe diagnoses endpoint but not host loading', async t => {
  const f = await fixture(), server = await mcp(t); await configureHub(f, server.url);
  const before = await snapshot(f.home);
  const check = await cli(f, ['--check', '--host', 'pi']);
  assert.equal(check.code, 0); assert.equal(server.connections(), 0);
  const probed = await cli(f, ['--check', '--probe', '--host', 'pi']);
  assert.equal(probed.code, 0, JSON.stringify(probed)); assert.equal(probed.out.hosts[0].probe.ok, true);
  assert.equal(probed.out.hosts[0].probe.hostLoaded, false);
  assert.equal(probed.out.reconnectCleared, false);
  assert.equal(probed.out.reconnectMarker, 'no-release-root');
  assert.equal(probed.out.warning, 'reconnect marker cleanup did not complete; see reconnectMarker');
  assert.deepEqual(await snapshot(f.home), before);
  for (const args of [['--probe'], ['--check', '--probe', '--dry-run'], ['--list', '--probe'], ['--uninstall', '--probe'], ['--reconcile', '--probe']]) {
    const invalid = await cli(f, args); assert.equal(invalid.code, 1); assert.equal(invalid.out.error.code, 'INVALID_ARGUMENT');
  }
});

test('probe: actual CLI stale schema failure and per-host isolation preserve configuration-level result', async t => {
  const f = await fixture(), tools = structuredClone(TOOLS); tools[0].inputSchema.properties.prompt.description = 'stale';
  const server = await mcp(t, { tools }); await configureHub(f, server.url);
  const result = await cli(f, ['--check', '--probe', '--host', 'pi,gemini']);
  assert.equal(result.code, 1); assert.equal(result.out.hosts.length, 2);
  assert.equal(result.out.hosts[0].healthy, true); assert.equal(result.out.hosts[0].probe.error.code, 'PROBE_STALE_SCHEMA');
  assert.equal(result.out.hosts[1].probe.skipped, true); assert.match(result.stderr, /PROBE_STALE_SCHEMA/);
});

test('probe: provenance I/O is covered by total deadline and cannot start networking after timeout', async () => {
  const f = await fixture(); let calls = 0;
  const blocking = { ...io, lstat: async path => path === f.target.configPath ? new Promise(() => {}) : io.lstat(path) };
  const start = Date.now();
  const result = await probeHost(f.host, f.target, { ...f.deps, io: blocking, timeoutMs: 30, fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(result.error.code, 'PROBE_TIMEOUT'); assert.equal(calls, 0); assert.ok(Date.now() - start < 500);
});

test('probe: invalid installer records cannot authorize execution just by naming trusted paths', async () => {
  const f = await fixture();
  await put(f.target.configPath, JSON.stringify({ mcpServers: { claude_web: { command: paths.nodePath, args: [paths.mcpPath] } } }));
  await put(f.target.recordPath, '{}');
  const before = await snapshot(f.home);
  const result = await probeHost(f.host, f.target, f.deps);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'PROBE_ROUTE_REFUSED');
  assert.deepEqual(await snapshot(f.home), before);
});

test('probe: trusted stdio runtime supplies current schemas with no session/state writes and clean process shutdown', async () => {
  const f = await fixture(); await installHost(f.host, f.target, f.deps);
  const before = await snapshot(f.home);
  const result = await probeHost(f.host, f.target, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.source, 'installer');
  assert.equal(result.guidanceInInitialize, true); assert.equal(result.claudeSent, false);
  assert.deepEqual(await snapshot(f.home), before);
  const controller = new AbortController(); controller.abort();
  assert.equal((await probeHost(f.host, f.target, { ...f.deps, signal: controller.signal })).error.code, 'PROBE_ABORTED');
});
