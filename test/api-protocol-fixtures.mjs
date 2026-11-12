import { createServer } from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { join } from 'node:path';
import { makeTmpDir } from './helpers.mjs';

export const protocolEnv = (overrides, inherited = process.env) => ({
  ...Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('CCW_'))),
  ...overrides,
});

export const SECRET = 'fixture-protocol-key-not-real';
export const UUID = '17e50c0d-769a-4219-a61b-e70a37f6630a';
export const PATHS = { messages: '/v1/messages', chat: '/v1/chat/completions', responses: '/v1/responses' };
export const MODEL = 'claude-opus-5-5';
export const replyFor = (protocol, text = 'reply') => {
  if (protocol === 'messages') return {
    id: 'msg_test', type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }],
    usage: { input_tokens: 20, output_tokens: 14, output_tokens_details: { thinking_tokens: 9 } },
  };
  if (protocol === 'chat') return {
    id: 'chatcmpl_test', object: 'chat.completion', model: MODEL,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 20, completion_tokens: 14, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 9 } },
  };
  return {
    id: 'resp_test', object: 'response', model: MODEL, status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'reasoning', id: 'rs_test', summary: [] }, { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 20, output_tokens: 14, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 9 } },
  };
};

// A wire oracle, deliberately independent of the production SSE decoder.
export const sseEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
export function messagesSse(message) {
  const { content, stop_reason, usage, ...header } = message;
  let wire = sseEvent('message_start', { type: 'message_start', message: {
    ...header, content: [], stop_reason: null,
    ...(usage === undefined ? {} : { usage: { ...usage, output_tokens: 0, output_tokens_details: undefined } }),
  } });
  for (const [index, block] of (Array.isArray(content) ? content : []).entries()) {
    const text = block?.type === 'text' && typeof block.text === 'string';
    wire += sseEvent('content_block_start', { type: 'content_block_start', index, content_block: text ? { ...block, text: '' } : block });
    if (text) wire += sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    wire += sseEvent('content_block_stop', { type: 'content_block_stop', index });
  }
  return wire + sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason }, ...(usage === undefined ? {} : { usage }) })
    + sseEvent('message_stop', { type: 'message_stop' });
}
export const protocolBody = (protocol, data) => protocol === 'messages' ? messagesSse(data) : JSON.stringify(data);
export const protocolContentType = protocol => protocol === 'messages' ? 'text/event-stream' : 'application/json';
export const protocolResponse = (protocol, data) => new Response(protocolBody(protocol, data), { headers: { 'content-type': protocolContentType(protocol) } });
export function writeProtocolReply(res, protocol, data) {
  res.writeHead(200, { 'content-type': protocolContentType(protocol) });
  res.end(protocolBody(protocol, data));
}

export async function localApi(protocol, run, handler) {
  const home = await makeTmpDir();
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    if (handler) return handler(req, res, requests);
    writeProtocolReply(res, protocol, replyFor(protocol));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = {
    HOME: home, CCW_STATE_DIR: join(home, 'state'), CCW_BACKEND: 'api', CCW_API_KEY: SECRET, CCW_API_MODEL: MODEL,
    CCW_API_BASE_URL: `http://127.0.0.1:${server.address().port}`, CCW_CDP_URL: 'http://127.0.0.1:1',
    CCW_API_PROTOCOL: protocol, CCW_API_REASONING: 'max',
  };
  const config = (extra = {}) => loadConfig({ ...env, ...extra });
  try { await run({ env, home, requests, config }); }
  finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
