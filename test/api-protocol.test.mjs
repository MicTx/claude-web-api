import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApiBridge } from '../src/api-bridge.mjs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { apiRequest, sendApiMessage } from '../src/api-client.mjs';
import { ApiStore } from '../src/api-store.mjs';
import { loadConfig } from '../src/config.mjs';
import { cleanupTmpDirs } from './helpers.mjs';
import { localApi, protocolEnv, replyFor, protocolResponse, protocolBody, protocolContentType, SECRET, UUID, PATHS } from './api-protocol-fixtures.mjs';

after(() => cleanupTmpDirs());
const protocols = Object.keys(PATHS);
const tokens = { messages: 'max_tokens', chat: 'max_completion_tokens', responses: 'max_output_tokens' };
function assertWire(protocol, request, level = 'max') {
  assert.equal(request.path, PATHS[protocol]);
  assert.equal(request.body.stream, protocol === 'messages');
  assert.equal(request.headers.accept, protocolContentType(protocol));
  assert.equal(request.body[tokens[protocol]], 2048);
  for (const other of Object.values(tokens).filter(x => x !== tokens[protocol])) assert.equal(request.body[other], undefined);
  const effort = level === 'off' ? undefined : level;
  assert.deepEqual(request.body.thinking, protocol === 'messages' && effort ? { type: 'adaptive' } : undefined);
  assert.deepEqual(request.body.output_config, protocol === 'messages' && effort ? { effort } : undefined);
  assert.equal(request.body.reasoning_effort, protocol === 'chat' ? effort : undefined);
  assert.deepEqual(request.body.reasoning, protocol === 'responses' && effort ? { effort } : undefined);
  assert.equal(request.body.metadata.user_id, request.headers['x-session-affinity']);
  if (protocol !== 'messages') {
    assert.equal(request.body.store, false);
    assert.equal(JSON.stringify(request.body).includes('cache_control'), false);
    assert.equal(request.headers['anthropic-version'], undefined);
  }
}
const send = (config, fetchImpl) => sendApiMessage(config, { messages: [{ role: 'user', content: 'hello' }], sessionId: UUID, key: SECRET }, { fetchImpl });
const wireFields = ['stream', 'thinking', 'reasoning', 'output_config', 'reasoning_effort'];

for (const protocol of protocols) {
  test(`entry: ${protocol} ask and followUp carry reasoning through persisted state`, async () => {
    await localApi(protocol, async ({ requests, config }) => {
      const cfg = config();
      const first = await new ApiBridge(cfg).ask({ session: 'entry', prompt: 'first' });
      assert.equal(first.protocol, protocol);
      assert.equal(first.usage.reasoningTokens, 9);
      const second = await new ApiBridge(cfg).followUp({ session: 'entry', prompt: 'second' });
      assert.equal(second.protocol, protocol);
      assert.equal(requests.length, 2);
      for (const r of requests) assertWire(protocol, r);
      const history = requests[1].body[protocol === 'responses' ? 'input' : 'messages'];
      assert.equal(history.length, 3);
      assert.equal(history[1].role, 'assistant');
      assert.equal(requests[0].body.metadata.user_id, requests[1].body.metadata.user_id);
      const state = await new ApiStore(cfg.stateDir).load();
      assert.equal(state.apiSessions[0].protocol, protocol);
      assert.equal(state.apiSessions[0].lastUsage.reasoningTokens, 9);
      assert.equal(state.apiSessions[0].pending, null);
      const view = await new ApiBridge(cfg).transcript({ session: 'entry' });
      assert.equal(view.protocol, protocol);
    });
  });

  test(`doctor: ${protocol} displays the exact sent decorations without requests`, async () => {
    await localApi(protocol, async ({ config, requests }) => {
      const cfg = config();
      const bridge = new ApiBridge(cfg);
      const profile = bridge.profile();
      const directDoctor = await new ConsultBridge(cfg).doctor({});
      assert.equal(directDoctor.protocol, protocol);
      const fallbackDoctor = await new ConsultBridge(config({ CCW_BACKEND: 'auto' })).doctor({});
      assert.equal(fallbackDoctor.protocol, protocol);
      assert.equal(profile.protocol, protocol);
      assert.equal(profile.request.path, PATHS[protocol]);
      const payload = JSON.parse(apiRequest(cfg, [{ role: 'user', content: 'x' }], UUID));
      assert.deepEqual(profile.request.fields, Object.fromEntries(Object.entries(payload).filter(([k]) => Object.values(tokens).includes(k) || wireFields.includes(k))));
      assert.equal(requests.length, 0);
      await bridge.ask({ session: 'diagnostic', prompt: 'x' });
      assertWire(protocol, requests[0]);
    });
  });

  test(`protocol: ${protocol} every effort and off use only their own wire keys`, async () => {
    await localApi(protocol, async ({ config, requests }) => {
      const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max', ...(protocol === 'messages' ? [] : ['none', 'minimal'])];
      for (const level of levels) {
        await send(config({ CCW_API_REASONING: level }));
        assertWire(protocol, requests.at(-1), level);
      }
      await send(config({ CCW_API_MAX_TOKENS: '60000' }));
      assert.equal(requests.at(-1).body[tokens[protocol]], 60000);
    });
  });

  test(`protocol: ${protocol} enforces transport protections without retries or switching`, async () => {
    await localApi(protocol, async ({ config }) => {
      for (const status of [302, 401, 429, 500]) {
        let calls = 0;
        await assert.rejects(() => send(config(), async url => {
          calls++;
          assert.ok(url.endsWith(PATHS[protocol]));
          return new Response(JSON.stringify({ error: { message: SECRET } }), { status, headers: { location: 'https://elsewhere.invalid', 'content-type': 'application/json' } });
        }), e => e.code === (status === 302 ? 'API_REDIRECT' : 'API_HTTP_ERROR') && !JSON.stringify(e).includes(SECRET));
        assert.equal(calls, 1);
      }
    });
  });

  test(`protocol: ${protocol} missing reasoning usage stays unknown, not zero`, async () => {
    await localApi(protocol, async ({ config }) => {
      const body = replyFor(protocol);
      const usage = protocol === 'chat' ? { prompt_tokens: 5, completion_tokens: 2 } : { input_tokens: 5, output_tokens: 2 };
      const result = await send(config(), async () => protocolResponse(protocol, { ...body, usage }));
      assert.equal(result.usage.reasoningTokens, null);
      assert.equal(result.usage.cacheReadInputTokens, null);
      const zero = protocol === 'chat' ? { ...usage, completion_tokens_details: { reasoning_tokens: 0 } } : { ...usage, output_tokens_details: { [protocol === 'messages' ? 'thinking_tokens' : 'reasoning_tokens']: 0 } };
      assert.equal((await send(config(), async () => protocolResponse(protocol, { ...body, usage: zero }))).usage.reasoningTokens, 0);
    });
  });
}

test('protocol: configuration defaults, file and environment priority are strict', async () => {
  await localApi('messages', async ({ config, env, home, requests }) => {
    assert.equal(config({ CCW_API_PROTOCOL: undefined }).apiProtocol, 'messages');
    for (const bad of ['message', 'response', 'CHAT', '', '__proto__', 'constructor']) assert.throws(() => config({ CCW_API_PROTOCOL: bad }), { code: 'CONFIG_INVALID' });
    for (const level of ['none', 'minimal']) assert.throws(() => config({ CCW_API_REASONING: level }), { code: 'CONFIG_INVALID' });
    const dir = join(home, '.config/claude-web-api');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'config.json'), JSON.stringify({ apiProtocol: 'chat', apiReasoning: 'minimal' }), { mode: 0o600 });
    const fromFile = loadConfig({ ...env, CCW_API_PROTOCOL: undefined, CCW_API_REASONING: undefined });
    assert.equal(fromFile.apiProtocol, 'chat');
    assert.equal(fromFile.apiReasoning, 'minimal');
    assert.equal(loadConfig({ ...env, CCW_API_PROTOCOL: 'responses' }).apiProtocol, 'responses');
    assert.equal(requests.length, 0);
  });
});

test('protocol: legacy Messages histories survive, protocol changes never send or migrate', async () => {
  await localApi('messages', async ({ config, requests }) => {
    const cfg = config();
    await new ApiBridge(cfg).ask({ session: 'old', prompt: 'first' });
    const store = new ApiStore(cfg.stateDir);
    const state = await store.load();
    const legacy = { ...state, apiSessions: state.apiSessions.map(({ protocol, ...entry }) => entry) };
    await store.save(legacy);
    const original = await fs.readFile(store.file, 'utf8');
    for (const protocol of ['chat', 'responses']) {
      const other = new ApiBridge(config({ CCW_API_PROTOCOL: protocol }));
      await assert.rejects(() => other.followUp({ session: 'old', prompt: 'do not send' }), { code: 'API_PROFILE_CHANGED' });
      await assert.rejects(() => other.bindCredential({ session: 'old', adoptUnbound: true }), { code: 'API_PROFILE_CHANGED' });
    }
    assert.equal(requests.length, 1);
    assert.equal(await fs.readFile(store.file, 'utf8'), original);
    await new ApiBridge(cfg).followUp({ session: 'old', prompt: 'same protocol' });
    assert.equal(requests.length, 2);
  });
});

test('protocol: explicit Chat and Responses aliases reject every protocol switch without writes', async () => {
  for (const protocol of ['chat', 'responses']) await localApi(protocol, async ({ config, requests }) => {
    const cfg = config();
    const bridge = new ApiBridge(cfg);
    await bridge.ask({ session: 'pinned', prompt: 'first' });
    const store = new ApiStore(cfg.stateDir);
    const original = await fs.readFile(store.file, 'utf8');
    assert.equal(JSON.parse(original).apiSessions[0].protocol, protocol);
    for (const other of protocols.filter(p => p !== protocol)) {
      await assert.rejects(() => new ApiBridge(config({ CCW_API_PROTOCOL: other })).followUp({ session: 'pinned', prompt: 'do not send' }), { code: 'API_PROFILE_CHANGED' });
      assert.equal(requests.length, 1);
      assert.equal(await fs.readFile(store.file, 'utf8'), original);
    }
    await bridge.followUp({ session: 'pinned', prompt: 'same protocol' });
    assert.equal(requests.length, 2);
    assertWire(protocol, requests[1]);
  });
});

test('protocol: chat length and Responses incomplete preserve native truncation on disk', async () => {
  for (const protocol of ['chat', 'responses']) {
    const body = replyFor(protocol, 'partial');
    const truncated = protocol === 'chat'
      ? { ...body, choices: body.choices.map(c => ({ ...c, finish_reason: 'length' })) }
      : { ...body, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: body.output.map(b => b.type === 'message' ? { ...b, status: 'incomplete' } : b) };
    await localApi(protocol, async ({ config, requests }) => {
      const bridge = new ApiBridge(config());
      const result = await bridge.ask({ session: 'partial', prompt: 'x' });
      assert.equal(result.complete, false);
      assert.equal(result.stopReason, protocol === 'chat' ? 'length' : 'max_output_tokens');
      const view = await bridge.transcript({ session: 'partial' });
      assert.equal(view.messages.at(-1).complete, false);
      assert.equal(view.messages.at(-1).stopReason, result.stopReason);
      const continued = await bridge.followUp({ session: 'partial', prompt: 'continue the partial answer' });
      assert.equal(continued.previousComplete, false);
      assert.equal(continued.protocol, protocol);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1].body[protocol === 'responses' ? 'input' : 'messages'], [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'continue the partial answer' },
      ]);
    }, (_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(truncated)); });
  }
});

test('protocol: malformed responses, unknown terminal states, tools and credential echoes fail closed', async () => {
  for (const protocol of protocols) await localApi(protocol, async ({ config }) => {
    const good = replyFor(protocol);
    const bads = [
      { ...good, id: 'bad\nid' }, { ...good, model: 'bad\nmodel' },
      replyFor(protocol, ''), replyFor(protocol, SECRET),
      { ...good, usage: { input_tokens: -1, prompt_tokens: -1 } },
      { ...good, usage: { output_tokens_details: { thinking_tokens: -1, reasoning_tokens: -1 }, completion_tokens_details: { reasoning_tokens: -1 } } },
    ];
    if (protocol === 'chat') bads.push({ ...good, choices: [] }, { ...good, choices: [...good.choices, ...good.choices] }, { ...good, choices: [{ ...good.choices[0], finish_reason: 'tool_calls' }] }, { ...good, choices: [{ ...good.choices[0], finish_reason: 'mystery' }] });
    if (protocol === 'responses') bads.push({ ...good, status: 'in_progress' }, { ...good, status: 'failed' }, { ...good, status: 'incomplete', incomplete_details: { reason: 'mystery' } }, { ...good, output: [...good.output, { type: 'function_call' }] });
    if (protocol === 'messages') bads.push({ ...good, role: 'user' }, { ...good, content: [{ type: 'tool_use', id: 'tool', input: {} }] });
    if (protocol === 'chat') bads.push({ ...good, choices: [{ ...good.choices[0], message: { role: 'user', content: 'wrong author' } }] }, { ...good, choices: [{ ...good.choices[0], message: { role: 'assistant', content: 42 } }] });
    if (protocol === 'responses') bads.push({ ...good, output: good.output.map(item => item.type === 'message' ? { ...item, status: 'in_progress' } : item) }, { ...good, output: good.output.filter(item => item.type === 'reasoning') });
    for (const bad of bads) await assert.rejects(() => send(config(), async () => protocolResponse(protocol, bad)), { code: 'API_RESPONSE' });
  });
});

async function cli(env, args, inherited = process.env) {
  const child = spawn(process.execPath, ['bin/ccw.mjs', ...args], { cwd: new URL('..', import.meta.url), env: protocolEnv(env, inherited), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { err += c; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0, err || out);
  return JSON.parse(out);
}

test('fixture: isolated environment keeps only explicit CCW values without mutating inputs', () => {
  const inherited = Object.freeze({ PATH: '/synthetic/bin', CCW_UNKNOWN: 'host', CCW_STATE_DIR: '/foreign', CCW_API_MAX_TOKENS: '60000' });
  const overrides = Object.freeze({ HOME: '/synthetic/home', CCW_STATE_DIR: '/synthetic/state', CCW_API_PROTOCOL: 'chat' });
  assert.deepEqual(protocolEnv(overrides, inherited), { PATH: '/synthetic/bin', ...overrides });
  assert.equal(inherited.CCW_STATE_DIR, '/foreign');
  assert.equal(inherited.CCW_UNKNOWN, 'host');
});

test('entry: CLI is isolated from inherited CCW configuration', async () => {
  await localApi('chat', async ({ env, home, requests, config }) => {
    const foreign = join(home, 'foreign-runtime');
    await fs.mkdir(foreign);
    const sentinel = join(foreign, 'sentinel');
    await fs.writeFile(sentinel, 'unchanged');
    const inherited = {
      ...process.env, CCW_STATE_DIR: foreign, CCW_API_MAX_TOKENS: '60000',
      CCW_ATTACHMENT_ROOT: join(home, 'missing-root'),
    };
    const result = await cli(env, ['ask', '--session', 'isolated', '--prompt', 'first'], inherited);
    assert.equal(result.protocol, 'chat');
    assert.equal(requests.length, 1);
    assertWire('chat', requests[0]);
    const state = await new ApiStore(config().stateDir).load();
    assert.equal(state.apiSessions[0].messages.length, 2);
    assert.deepEqual(await fs.readdir(foreign), ['sentinel']);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  });
});

test('protocol: quoted or backslash credentials in input never reach HTTP', async () => {
  for (const protocol of protocols) await localApi(protocol, async ({ config, requests }) => {
    for (const key of ['synthetic"key', 'synthetic\\key']) {
      let calls = 0;
      const messages = [{ role: 'user', content: `must not send ${key}` }];
      await assert.rejects(() => sendApiMessage(config(), { messages, sessionId: UUID, key }, {
        fetchImpl: async () => { calls++; return Response.json(replyFor(protocol)); },
      }), e => e.code === 'API_CREDENTIALS' && !JSON.stringify(e).includes(key));
      assert.equal(calls, 0);
    }
    assert.equal(requests.length, 0);
  });
});

test('protocol: Responses message IDs must be strings, not coerced scalars', async () => {
  await localApi('responses', async ({ config }) => {
    const body = replyFor('responses');
    for (const id of [7, true, ['msg_test']]) {
      const malformed = { ...body, output: body.output.map(item => item.type === 'message' ? { ...item, id } : item) };
      await assert.rejects(() => send(config(), async () => Response.json(malformed)), { code: 'API_RESPONSE' });
    }
  });
});

test('protocol: escaped credential echoes never enter durable history', async () => {
  for (const protocol of protocols) {
    const encoded = [...SECRET].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    for (const target of ['text', 'id', 'model']) {
      const data = { ...replyFor(protocol, target === 'text' ? SECRET : 'ok'), ...(target === 'text' ? {} : { [target]: `msg_${SECRET}` }) };
      const raw = protocolBody(protocol, data).replaceAll(SECRET, encoded);
      assert.equal(raw.includes(SECRET), false, 'raw JSON check alone cannot detect the credential');
      await localApi(protocol, async ({ config }) => {
        const cfg = config();
        await assert.rejects(() => new ApiBridge(cfg).ask({ session: 'echo', prompt: 'x' }), e => e.code === 'API_RESPONSE' && !JSON.stringify(e).includes(SECRET));
        const stored = await new ApiStore(cfg.stateDir).load();
        assert.equal(stored.apiSessions[0].messages.length, 0);
        assert.ok(stored.apiSessions[0].pending);
        assert.equal(JSON.stringify(stored).includes(SECRET), false);
      }, (_, res) => { res.writeHead(200, { 'content-type': protocolContentType(protocol) }); res.end(raw); });
    }
  }
});

test('entry: CLI and MCP subprocesses cover sticky follow-up and isolated read-only doctor', async () => {
  for (const protocol of protocols) await localApi(protocol, async ({ env, home, requests }) => {
    const inherited = { ...process.env, CCW_STATE_DIR: join(home, 'foreign-mcp'), CCW_ATTACHMENT_ROOT: join(home, 'missing-mcp-root'), CCW_API_MAX_TOKENS: '60000' };
    const asked = await cli(env, ['ask', '--session', 'cli', '--prompt', 'first'], inherited);
    assert.equal(asked.protocol, protocol);
    await cli(env, ['follow-up', '--session', 'cli', '--prompt', 'second'], inherited);
    for (const r of requests) assertWire(protocol, r);
    const client = new Client({ name: 'protocol-test', version: '1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'src/mcp-server.mjs')], env: protocolEnv(env, inherited), stderr: 'pipe' });
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 30000 });
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      return result.structuredContent;
    };
    try {
      await client.connect(transport);
      const first = await call('claude_ask', { session: 'mcp', prompt: 'third' });
      const next = await call('claude_follow_up', { session: 'mcp', prompt: 'fourth' });
      assert.equal(first.protocol, protocol);
      assert.equal(next.protocol, protocol);
      assert.equal(next.sessionId, first.sessionId);
      assert.equal(requests.length, 4);
      for (const r of requests.slice(2)) assertWire(protocol, r);
      assert.equal(requests[2].headers['x-session-affinity'], requests[3].headers['x-session-affinity']);
      assert.equal(requests[3].body[protocol === 'responses' ? 'input' : 'messages'].length, 3);
      const before = requests.length;
      const doctor = await call('claude_doctor', {});
      assert.equal(doctor.protocol, protocol);
      assert.equal(doctor.api.request.path, PATHS[protocol]);
      assert.deepEqual(doctor.api.request.fields, Object.fromEntries(Object.entries(requests.at(-1).body).filter(([k]) => Object.values(tokens).includes(k) || wireFields.includes(k))));
      assert.equal(requests.length, before, 'MCP doctor must not send to the API');
      await assert.rejects(() => fs.stat(inherited.CCW_STATE_DIR), { code: 'ENOENT' });
    } finally { await client.close(); }
  });
});
