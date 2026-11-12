import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverHost, firstJsonArray, schemaIsCurrent, verifyDiscoveredTools } from '../src/install/discovery.mjs';
import { findHost, sourcePaths } from '../src/install/engine.mjs';
import { defaultIo, sha256 } from '../src/install/atomic.mjs';
import { TOOLS, EXECUTABLE_GUIDANCE_CONTRACT } from '../src/tool-contracts.mjs';
import { run } from '../scripts/install-agents.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());
const io = defaultIo(), paths = sourcePaths();

async function fixture() {
  const home = await fs.realpath(await makeTmpDir('ccw-discovery-'));
  const host = findHost('pi');
  const target = host.resolve({ home, env: { HOME: home }, stateDir: join(home, 'state') });
  return { home, host, target, deps: { ...paths, io, home } };
}
async function put(path, text) { await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, text, { mode: 0o600 }); }
async function configureHub(f, url) {
  await put(f.target.configPath, JSON.stringify({ mcpServers: { magpie: { url } } }));
  await put(join(f.home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true,
    mcp: [{ name: 'claude_web', command: paths.nodePath, args: [paths.mcpPath], transport: 'stdio', agents: ['pi'] }] }));
}
const discovered = () => TOOLS.map(tool => ({ name: `claude_web__${tool.name}`, description: tool.description, inputSchema: tool.inputSchema }));
const response = (tools, query) => {
  const selected = query.includes('download')
    ? [tools.find(tool => tool.name.endsWith('download')), ...tools.filter(tool => !tool.name.endsWith('download') && !tool.name.endsWith('doctor'))]
    : [tools.find(tool => tool.name.endsWith('doctor')), ...tools.filter(tool => !tool.name.endsWith('doctor') && !tool.name.endsWith('download'))];
  return `Run one with call_tool.\n${JSON.stringify(selected.filter(Boolean), null, 1)}\nAlso matching:\n- claude_web__claude_download: summary\n`;
};
async function hub(t, { tools = discovered(), failQuery = false, malformed = false } = {}) {
  const methods = [], calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { methods.push(req.method); res.writeHead(405).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString()); methods.push(msg.method);
    if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') { res.writeHead(202).end(); return; }
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-hub', version: '1' } };
    else if (msg.method === 'tools/list') result = { tools: [
      { name: 'find_tools', description: 'Find backend metadata', inputSchema: { type: 'object', properties: { query: { type: 'string' }, server: { type: 'string' } } } },
      { name: 'call_tool', description: 'Invoke backend tool', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    ] };
    else if (msg.method === 'tools/call') {
      calls.push(msg.params);
      if (malformed) result = { content: [{ type: 'text', text: 'No JSON array here; metadata was summarized away.' }] };
      else if (failQuery) result = { content: [{ type: 'text', text: 'unexpected backend response' }], isError: true };
      else result = { content: [{ type: 'text', text: response(tools, msg.params.arguments.query) }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/mcp/magpie/hub/pi`, methods, calls };
}

test('discovery: bounded parser ignores prose around a JSON array', () => {
  assert.deepEqual(firstJsonArray('intro\n[{"name":"one"}]\ntrailing ["two"]'), [{ name: 'one' }]);
  assert.equal(firstJsonArray('intro without an array'), null);
  assert.equal(schemaIsCurrent(TOOLS[0], 'claude_ask'), true);
  assert.equal(schemaIsCurrent({ inputSchema: { type: 'object', properties: {} } }, 'claude_sessions'), true);
  assert.equal(verifyDiscoveredTools(discovered()).guidanceInSendSchemas, true);
});

test('discovery: exact read-only find_tools probes verify six backend schemas without call_tool', async t => {
  const f = await fixture(), server = await hub(t); await configureHub(f, server.url);
  const result = await discoverHost(f.host, f.target, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.verification, 'discovery-schemas');
  assert.equal(result.reachable, true);
  assert.equal(result.hostLoaded, false);
  assert.equal(result.claudeSent, false);
  assert.equal(result.cacheChanged, false);
  assert.equal(result.guidanceInSendSchemas, true);
  assert.deepEqual(result.missingTools, []);
  assert.deepEqual(result.staleSchemas, []);
  assert.equal(result.contractSha256, sha256(EXECUTABLE_GUIDANCE_CONTRACT));
  assert.deepEqual(server.methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call']);
  assert.deepEqual(server.calls.map(call => call.arguments), [
    { server: 'claude_web', query: 'claude_web__claude_download' },
    { server: 'claude_web', query: 'claude_web__claude_doctor' },
  ]);
});

test('discovery: stale and missing backend schemas are distinguished', async t => {
  const stale = discovered().map(tool => tool.name.endsWith('claude_ask')
    ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      guidance: { type: 'boolean', default: true } } } } : tool);
  const f = await fixture(), server = await hub(t, { tools: stale }); await configureHub(f, server.url);
  const result = await discoverHost(f.host, f.target, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'DISCOVERY_STALE_SCHEMA');
  assert.deepEqual(result.staleSchemas, ['claude_ask']);
  assert.deepEqual(result.missingTools, []);
});

test('discovery: non-hub routes, backend errors and malformed metadata fail closed', async t => {
  const f = await fixture();
  await put(f.target.configPath, JSON.stringify({ mcpServers: {} }));
  const noRoute = await discoverHost(f.host, f.target, f.deps);
  assert.equal(noRoute.error.code, 'DISCOVERY_ROUTE_REFUSED');
  const failed = await hub(t, { failQuery: true }); await configureHub(f, failed.url);
  const backend = await discoverHost(f.host, f.target, f.deps);
  assert.equal(backend.error.code, 'DISCOVERY_BACKEND_ERROR');
  const malformedHub = await hub(t, { malformed: true }); await configureHub(f, malformedHub.url);
  const parsed = await discoverHost(f.host, f.target, f.deps);
  assert.equal(parsed.error.code, 'DISCOVERY_PARSE');
});

test('discovery: CLI requires --check and refuses --probe or dry-run combinations', async () => {
  const f = await fixture();
  let output = '';
  const cli = args => run(args, { env: { HOME: f.home }, stdout: { write: s => { output += s; } }, stderr: { write() {} } });
  assert.equal(await cli(['--discover']), 1);
  assert.equal(JSON.parse(output.trim()).error.code, 'INVALID_ARGUMENT');
  output = '';
  assert.equal(await cli(['--check', '--probe', '--discover', '--host', 'pi']), 1);
  assert.equal(JSON.parse(output.trim()).error.code, 'INVALID_ARGUMENT');
  output = '';
  assert.equal(await cli(['--check', '--discover', '--dry-run', '--host', 'pi']), 1);
  assert.equal(JSON.parse(output.trim()).error.code, 'INVALID_ARGUMENT');
});

test('discovery: stale manager skill freshness is independent evidence and does not skip schema discovery', async t => {
  const f = await fixture(), server = await hub(t); await configureHub(f, server.url);
  const skillDir = f.target.skillDest;
  await fs.mkdir(skillDir, { recursive: true });
  const sourceSkill = await fs.readFile(join(paths.skillSrc, 'SKILL.md'), 'utf8');
  await fs.writeFile(join(skillDir, 'SKILL.md'), `${sourceSkill}\nmanager-owned edit\n`, { mode: 0o600 });
  const { checkHost } = await import('../src/install/engine.mjs');
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.healthy, true);
  assert.equal(checked.externalSkill.status, 'stale');
  const result = await discoverHost(f.host, f.target, f.deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.guidanceInSendSchemas, true);
  assert.deepEqual(result.missingTools, []);
  assert.deepEqual(result.staleSchemas, []);
  assert.equal(server.calls.length, 2);
});
