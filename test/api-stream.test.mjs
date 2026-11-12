import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApiBridge } from '../src/api-bridge.mjs';
import { sendApiMessage } from '../src/api-client.mjs';
import { ApiStore } from '../src/api-store.mjs';
import { cleanupTmpDirs } from './helpers.mjs';
import { localApi, protocolEnv, replyFor, messagesSse, sseEvent, SECRET, UUID } from './api-protocol-fixtures.mjs';

after(() => cleanupTmpDirs());
const event = (type, rest = {}) => sseEvent(type, { type, ...rest });
const start = (usage) => event('message_start', { message: {
  id: 'msg_stream', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null,
  ...(usage === undefined ? {} : { usage }),
} });
const block = (index, content_block = { type: 'text', text: '' }) => event('content_block_start', { index, content_block });
const text = (index, value) => event('content_block_delta', { index, delta: { type: 'text_delta', text: value } });
const close = index => event('content_block_stop', { index });
const delta = (stop_reason = 'end_turn', usage) => event('message_delta', { delta: { stop_reason }, ...(usage === undefined ? {} : { usage }) });
const stop = () => event('message_stop');
const partial = () => start() + block(0) + text(0, 'unconfirmed text must not enter history');
const complete = (value = 'reply') => start() + block(0) + text(0, value) + close(0) + delta() + stop();
const streamed = body => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const send = (config, fetchImpl, signal) => sendApiMessage(config, {
  messages: [{ role: 'user', content: 'question' }], sessionId: UUID, key: SECRET,
}, { fetchImpl, signal });
function chunked(bytes, size) {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset += size));
  } });
}

// Explicit frames and numeric expectations form an oracle separate from the decoder.
test('api SSE: Bridge merges cumulative delta usage without summing or losing start counters', async () => {
  const wire = start({ input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 })
    + block(0, { type: 'thinking', thinking: '' })
    + event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'private thinking' } })
    + event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'opaque signature' } }) + close(0)
    + block(1, { type: 'redacted_thinking', data: 'opaque data' }) + close(1)
    + block(2) + text(2, '你好🌞\n') + close(2) + block(3) + text(3, 'second block\r\n') + close(3)
    + delta(null, { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11, output_tokens_details: { thinking_tokens: 3 } })
    + delta('end_turn', { output_tokens: 8, input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null }) + stop();
  await localApi('messages', async ({ config, requests }) => {
    const bridge = new ApiBridge(config());
    const answer = await bridge.ask({ session: 'usage', prompt: 'question' });
    assert.equal(answer.reply, '你好🌞\nsecond block\r\n');
    assert.equal(answer.assistantMessageId, 'msg_stream');
    assert.equal(answer.complete, true);
    assert.deepEqual(answer.usage, { inputTokens: 20, outputTokens: 8, cacheCreationInputTokens: 7, cacheReadInputTokens: 11, reasoningTokens: 3 });
    assert.equal(answer.cache.hit, true);
    const stored = await new ApiStore(config().stateDir).load();
    assert.equal(stored.apiSessions[0].pending, null);
    assert.equal(stored.apiSessions[0].lastUsage.outputTokens, 8);
    assert.equal(JSON.stringify(stored).includes('private thinking'), false);
    assert.equal(JSON.stringify(stored).includes('opaque'), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(requests[0].body.output_config, { effort: 'max' });
  }, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); });
});

test('api SSE: a gateway may report all counters only in the final message_delta', async () => {
  await localApi('messages', async ({ config }) => {
    const finalUsage = { input_tokens: 27, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 13 };
    const wire = start() + block(0) + text(0, 'reply') + close(0) + delta('end_turn', finalUsage) + stop();
    const result = await send(config(), async () => streamed(wire));
    assert.deepEqual(result.usage, { inputTokens: 27, outputTokens: 9, cacheCreationInputTokens: 0, cacheReadInputTokens: 13, reasoningTokens: null });
    assert.equal(result.complete, true);
  });
});

test('api SSE: UTF-8, BOM, split CRLF, bare CR, multiline data, comments, ping and future events', async () => {
  const initial = start({ input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0 });
  const multiline = 'event: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "index":0,"delta":{"type":"text_delta","text":"中文🌞"}}\n\n';
  for (const eol of ['\n', '\r\n', '\r']) await localApi('messages', async ({ config }) => {
    const wire = '\ufeff' + (': keepalive\n\n' + initial + event('ping') + event('future_event', { value: 1 })
      + block(0) + multiline + close(0) + delta('end_turn', { output_tokens: 4 }) + stop()).replaceAll('\n', eol);
    const bytes = Buffer.from(wire);
    for (const size of [1, 7, bytes.length]) {
      const result = await send(config(), async () => streamed(chunked(bytes, size)));
      assert.equal(result.reply, '中文🌞');
      assert.equal(result.usage.inputTokens, 5);
      assert.equal(result.usage.outputTokens, 4);
      assert.equal(result.usage.cacheReadInputTokens, 0);
      assert.equal(result.usage.cacheCreationInputTokens, null);
    }
  });
});

test('api SSE: message_stop cancels and unlocks the body without waiting for EOF', async () => {
  await localApi('messages', async ({ config }) => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(complete())); },
      cancel() { cancelled = true; },
    });
    const result = await send(config({ CCW_TIMEOUT_MS: '1000', CCW_IDLE_TIMEOUT_MS: '1000' }), async () => streamed(body));
    assert.equal(result.reply, 'reply');
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });
});

test('api SSE: complete max_tokens stores bounded text and follow-up sees previousComplete false', async () => {
  await localApi('messages', async ({ config, requests }) => {
    const bridge = new ApiBridge(config());
    const result = await bridge.ask({ session: 'truncated', prompt: 'first' });
    assert.equal(result.complete, false);
    assert.equal(result.stopReason, 'max_tokens');
    assert.equal((await bridge.transcript({ session: 'truncated' })).pending, null);
    const next = await bridge.followUp({ session: 'truncated', prompt: 'continue' });
    assert.equal(next.previousComplete, false);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].body.messages[1].content[0].text, 'bounded partial');
  }, (_, res, requests) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(start() + block(0) + text(0, 'bounded partial') + close(0) + delta(requests.length === 1 ? 'max_tokens' : 'end_turn') + stop());
  });
});

test('api SSE: history stays pending until a fully framed message_stop arrives', { timeout: 10000 }, async () => {
  let arrived, finish;
  const ready = new Promise(r => { arrived = r; });
  const gate = new Promise(r => { finish = r; });
  await localApi('messages', async ({ config, requests }) => {
    const bridge = new ApiBridge(config());
    let resolved = false;
    const sending = bridge.ask({ session: 'gated', prompt: 'question' }).then(result => { resolved = true; return result; });
    try {
      await ready;
      const state = await new ApiStore(config().stateDir).load();
      assert.ok(state.apiSessions[0].pending);
      assert.deepEqual(state.apiSessions[0].messages, []);
      assert.equal(resolved, false);
      finish();
      const result = await sending;
      assert.equal(result.complete, true);
      assert.equal(result.reply, 'reply');
      assert.equal((await bridge.transcript({ session: 'gated' })).pending, null);
      assert.equal(requests.length, 1);
    } finally { finish(); await sending.catch(() => {}); }
  }, async (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(start() + block(0) + text(0, 'reply') + close(0) + delta());
    arrived();
    await gate;
    // Keep HTTP alive. The protocol terminator, not connection EOF, completes.
    res.write(stop());
  });
});

test('api SSE: a reset connection after partial deltas keeps the paid attempt pending', { timeout: 10000 }, async () => {
  await localApi('messages', async ({ config, requests }) => {
    const bridge = new ApiBridge(config());
    await assert.rejects(() => bridge.ask({ session: 'reset', prompt: 'question' }), e => {
      assert.equal(e.code, 'API_REQUEST_FAILED');
      assert.equal(e.details.pending, true);
      assert.equal(e.details.retried, false);
      assert.equal(JSON.stringify(e).includes('unconfirmed text'), false);
      return true;
    });
    assert.ok((await bridge.transcript({ session: 'reset' })).pending);
    assert.equal(requests.length, 1);
  }, (_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(partial());
    setTimeout(() => res.destroy(), 20);
  });
});

test('api SSE: invalid or unfinished streams keep pending and never persist or resend partial text', async () => {
  const valid = complete();
  const bads = [
    ['', 'API_STREAM_INCOMPLETE'],
    [partial(), 'API_STREAM_INCOMPLETE'],
    [valid.slice(0, -1), 'API_STREAM_INCOMPLETE'],
    [start() + block(0) + text(0, 'x') + close(0) + delta(), 'API_STREAM_INCOMPLETE'],
    [event('message_stop'), 'API_RESPONSE'],
    [event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }), 'API_RESPONSE'],
    [start() + start(), 'API_RESPONSE'],
    [start() + block(1), 'API_RESPONSE'],
    [start() + block(0) + block(0), 'API_RESPONSE'],
    [start() + block('0'), 'API_RESPONSE'],
    [start() + block(-1), 'API_RESPONSE'],
    [start() + block(0.5), 'API_RESPONSE'],
    [start() + block(0) + event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'wrong type' } }), 'API_RESPONSE'],
    [start() + block(0, { type: 'thinking', thinking: '' }) + text(0, 'wrong type'), 'API_RESPONSE'],
    [start() + block(0) + close(0) + text(0, 'late'), 'API_RESPONSE'],
    [start() + block(0) + close(0) + close(0), 'API_RESPONSE'],
    [partial() + delta() + stop(), 'API_RESPONSE'],
    [start() + block(0) + text(0, 'x') + close(0) + stop(), 'API_RESPONSE'],
    [start() + block(0, { type: 'tool_use', id: 'tool', input: {} }), 'API_RESPONSE'],
    [start() + block(0, { type: 'thinking', thinking: 'hidden' }) + close(0) + delta() + stop(), 'API_RESPONSE'],
    [start() + block(0) + text(0, 'x') + close(0) + delta('unexpected') + stop(), 'API_RESPONSE'],
    [start({ input_tokens: -1 }), 'API_RESPONSE'],
    [start() + delta(null, { cache_read_input_tokens: -1 }), 'API_RESPONSE'],
    [start() + delta(null, { output_tokens: 1.5 }), 'API_RESPONSE'],
    [start() + delta(null, { output_tokens: '8' }), 'API_RESPONSE'],
    [start() + delta(null, { output_tokens_details: { thinking_tokens: -1 } }), 'API_RESPONSE'],
    [start() + delta(null, { output_tokens: Number.MAX_SAFE_INTEGER + 1 }), 'API_RESPONSE'],
    [start() + block(0) + text(0, 'x') + close(0) + delta('end_turn', { output_tokens: 2, output_tokens_details: { thinking_tokens: 3 } }) + stop(), 'API_RESPONSE'],
    [sseEvent('message_start', { type: 'message_stop' }), 'API_RESPONSE'],
    ['event: message_start\ndata: {broken}\n\n', 'API_RESPONSE'],
    [Buffer.concat([Buffer.from(partial()), Buffer.from([0xff])]), 'API_RESPONSE'],
    [partial() + event('error', { error: { type: 'overloaded_error', message: SECRET } }), 'API_RESPONSE'],
    [partial() + event('error', { error: { type: 'overloaded_error', message: 'busy' } }), 'API_REMOTE_ERROR'],
  ];
  for (const [wire, code] of bads) await localApi('messages', async ({ config, requests }) => {
    const bridge = new ApiBridge(config());
    await assert.rejects(() => bridge.ask({ session: 'bad', prompt: 'question' }), e => {
      assert.equal(e.code, code);
      assert.equal(e.details.pending, true);
      assert.equal(e.details.retried, false);
      assert.equal(JSON.stringify(e).includes(SECRET), false);
      assert.equal(JSON.stringify(e).includes('unconfirmed text'), false);
      return true;
    });
    const state = await new ApiStore(config().stateDir).load();
    assert.ok(state.apiSessions[0].pending);
    assert.deepEqual(state.apiSessions[0].messages, []);
    await assert.rejects(() => bridge.followUp({ session: 'bad', prompt: 'different question' }), { code: 'PENDING_TURN' });
    assert.equal(requests.length, 1);
    const view = await bridge.transcript({ session: 'bad', recover: true });
    assert.equal(view.pendingRetained, true);
    assert.equal(view.reconciliation.status, 'unconfirmed');
  }, (_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); });
});

test('api SSE: raw and escaped credentials split across chunks or text deltas never persist', async () => {
  const escaped = [...SECRET].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const wires = [complete(SECRET), complete().replace('msg_stream', `msg_${SECRET}`), complete().replace('claude-opus-5-5', SECRET),
    start() + block(0) + text(0, SECRET.slice(0, 8)) + text(0, SECRET.slice(8)) + close(0) + delta() + stop()];
  for (const original of wires) for (const wire of [original, original.replaceAll(SECRET, escaped)]) {
    await localApi('messages', async ({ config }) => {
      await assert.rejects(() => send(config(), async () => streamed(chunked(Buffer.from(wire), 3))), e => e.code === 'API_RESPONSE' && !JSON.stringify(e).includes(SECRET));
    });
  }
});

test('api SSE: stream, event, event-count, block and visible-reply budgets are bounded', async () => {
  const wires = [
    [start() + block(0) + text(0, 'x'.repeat(128 * 1024 + 1)), 'API_RESPONSE_TOO_LARGE'],
    [': ' + 'x'.repeat(1024 * 1024) + '\n\n', 'API_RESPONSE_TOO_LARGE'],
    [(': ' + 'x'.repeat(1020) + '\n\n').repeat(8200), 'API_RESPONSE_TOO_LARGE'],
    [event('ping').repeat(100001), 'API_RESPONSE_TOO_LARGE'],
    [start() + Array.from({ length: 33 }, (_, i) => block(i) + close(i)).join(''), 'API_RESPONSE'],
  ];
  for (const [wire, code] of wires) await localApi('messages', async ({ config }) => {
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(Buffer.from(wire)); }, cancel() { cancelled = true; } });
    await assert.rejects(() => send(config(), async () => streamed(stream)), { code });
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  });
});

test('api SSE: a JSON reply is refused, not silently downgraded or sent again', async () => {
  await localApi('messages', async ({ config, requests }) => {
    await assert.rejects(() => new ApiBridge(config()).ask({ session: 'json', prompt: 'question' }), { code: 'API_RESPONSE' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.stream, true);
    assert.ok((await new ApiStore(config().stateDir).load()).apiSessions[0].pending);
  }, (_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(replyFor('messages'))); });
});

test('api SSE: HTTP 429, 524 and redirects keep pending without retries or protocol changes', async () => {
  for (const status of [429, 524, 302]) await localApi('messages', async ({ config, requests }) => {
    const bridge = new ApiBridge(config());
    await assert.rejects(() => bridge.ask({ session: 'http', prompt: 'question' }), e => e.code === (status === 302 ? 'API_REDIRECT' : 'API_HTTP_ERROR') && e.details.status === status);
    await assert.rejects(() => bridge.followUp({ session: 'http', prompt: 'do not retry' }), { code: 'PENDING_TURN' });
    assert.equal(requests.length, 1);
  }, (_, res) => { res.writeHead(status, { 'content-type': 'application/json', location: 'https://elsewhere.invalid' }); res.end(JSON.stringify({ error: SECRET })); });
});

test('api SSE: cancellation and total deadline still stop a pinging partial response and release connections', { timeout: 10000 }, async () => {
  for (const mode of ['abort', 'timeout']) {
    let arrived, disconnected;
    const ready = new Promise(r => { arrived = r; });
    const closed = new Promise(r => { disconnected = r; });
    await localApi('messages', async ({ config, requests }) => {
      const controller = new AbortController();
      const bridge = new ApiBridge(config({ CCW_TIMEOUT_MS: '1000', CCW_IDLE_TIMEOUT_MS: '1000' }));
      const rejected = assert.rejects(() => bridge.ask({ session: 'hanging', prompt: 'question' }, { signal: controller.signal }), { code: mode === 'abort' ? 'ABORTED' : 'TIMEOUT' });
      await ready;
      if (mode === 'abort') controller.abort();
      await rejected;
      await closed;
      const view = await bridge.transcript({ session: 'hanging' });
      assert.equal(view.pendingRetained, true);
      assert.deepEqual(view.messages, []);
      assert.equal(requests.length, 1);
      assert.equal((await fs.readdir(config().stateDir)).includes('api.lock'), false);
    }, (_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(partial());
      const interval = setInterval(() => res.write(event('ping')), 20);
      res.on('close', () => { clearInterval(interval); disconnected(); });
      arrived();
    });
  }
});

async function cli(env, args) {
  const child = spawn(process.execPath, ['bin/ccw.mjs', ...args], { cwd: new URL('..', import.meta.url), env: protocolEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', b => { out += b; });
  child.stderr.on('data', b => { err += b; });
  const code = await new Promise((r, reject) => { child.on('error', reject); child.on('close', r); });
  assert.equal(out.trim().split('\n').length, 1, err || out);
  assert.equal(out.includes('unconfirmed text'), false);
  return { code, result: JSON.parse(out) };
}

test('api SSE: real CLI and MCP persist a complete turn but keep a failed follow-up pending', async () => {
  await localApi('messages', async ({ env, config, requests }) => {
    const first = await cli(env, ['ask', '--session', 'cli-stream', '--prompt', 'first']);
    assert.equal(first.code, 0);
    assert.equal(first.result.reply, 'reply');
    const broken = await cli(env, ['follow-up', '--session', 'cli-stream', '--prompt', 'drop']);
    assert.equal(broken.code, 1);
    assert.equal(broken.result.error.code, 'API_STREAM_INCOMPLETE');
    const refused = await cli(env, ['follow-up', '--session', 'cli-stream', '--prompt', 'again']);
    assert.equal(refused.result.error.code, 'PENDING_TURN');
    assert.equal(requests.length, 2);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['src/mcp-server.mjs'], cwd: process.cwd(), env: protocolEnv(env), stderr: 'pipe' });
    const client = new Client({ name: 'stream-test', version: '1.0' });
    try {
      await client.connect(transport);
      const call = async (name, args) => client.callTool({ name, arguments: args }, CallToolResultSchema, { timeout: 30000 });
      const asked = await call('claude_ask', { session: 'mcp-stream', prompt: 'first' });
      assert.equal(asked.structuredContent.reply, 'reply');
      const dropped = await call('claude_follow_up', { session: 'mcp-stream', prompt: 'drop' });
      assert.equal(dropped.isError, true);
      assert.equal(dropped.structuredContent.error.code, 'API_STREAM_INCOMPLETE');
      const blocked = await call('claude_follow_up', { session: 'mcp-stream', prompt: 'again' });
      assert.equal(blocked.structuredContent.error.code, 'PENDING_TURN');
      assert.equal(JSON.stringify(dropped).includes('unconfirmed text'), false);
      assert.equal(requests.length, 4);
      for (const request of requests) {
        assert.equal(request.body.stream, true);
        assert.equal(request.headers.accept, 'text/event-stream');
        assert.deepEqual(request.body.output_config, { effort: 'max' });
      }
      const state = await new ApiStore(config().stateDir).load();
      for (const entry of state.apiSessions) {
        assert.equal(entry.messages.length, 2);
        assert.equal(entry.messages[1].content, 'reply');
        assert.ok(entry.pending);
      }
    } finally { await client.close(); }
  }, (_, res, requests) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const prompt = requests.at(-1).body.messages.at(-1).content[0].text;
    res.end(prompt === 'drop' ? partial() : messagesSse(replyFor('messages')));
  });
});
