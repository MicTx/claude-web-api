import { BridgeError } from './core/errors.mjs';

export const MAX_API_REPLY_BYTES = 128 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MESSAGE_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal', 'max_tokens', 'model_context_window_exceeded']);
const COMPLETE = new Set(['end_turn', 'stop_sequence', 'refusal', 'stop', 'completed']);
const PARTIAL = new Set(['max_tokens', 'model_context_window_exceeded', 'length', 'max_output_tokens', 'content_filter']);
const invalid = () => { throw new BridgeError('API_RESPONSE', 'API response is not a valid bounded text message'); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function completionForStopReason(reason) {
  return COMPLETE.has(reason) ? true : PARTIAL.has(reason) ? false : null;
}

function detail(parent, field) {
  const v = parent?.[field];
  if (v === undefined || v === null) return undefined;
  if (!record(v)) invalid();
  return v;
}

function counter(parent, field) {
  const v = parent?.[field] ?? null;
  if (v !== null && (!Number.isSafeInteger(v) || v < 0)) invalid();
  return v;
}

function usageFor(data, protocol) {
  if (data.usage !== undefined && !record(data.usage)) invalid();
  const u = data.usage;
  const chat = protocol === 'chat';
  const input = detail(u, chat ? 'prompt_tokens_details' : 'input_tokens_details');
  const output = detail(u, chat ? 'completion_tokens_details' : 'output_tokens_details');
  const usage = {
    inputTokens: counter(u, chat ? 'prompt_tokens' : 'input_tokens'),
    outputTokens: counter(u, chat ? 'completion_tokens' : 'output_tokens'),
    cacheCreationInputTokens: protocol === 'messages' ? counter(u, 'cache_creation_input_tokens') : counter(input, 'cache_write_tokens'),
    cacheReadInputTokens: protocol === 'messages' ? counter(u, 'cache_read_input_tokens') : counter(input, 'cached_tokens'),
    reasoningTokens: counter(output, protocol === 'messages' ? 'thinking_tokens' : 'reasoning_tokens'),
  };
  if (usage.reasoningTokens !== null && usage.outputTokens !== null && usage.reasoningTokens > usage.outputTokens) invalid();
  return usage;
}

function messagesReply(data) {
  if (data.type !== 'message' || data.role !== 'assistant' || !MESSAGE_STOPS.has(data.stop_reason)
    || !Array.isArray(data.content) || !data.content.length || data.content.length > 32) invalid();
  const parts = data.content.map(b => {
    if (!record(b)) invalid();
    if (b.type === 'text' && typeof b.text === 'string') return b.text;
    if (['thinking', 'redacted_thinking'].includes(b.type)) return '';
    return invalid();
  });
  return { reply: parts.join(''), stopReason: data.stop_reason };
}

function chatReply(data) {
  if (data.object !== 'chat.completion' || !Array.isArray(data.choices) || data.choices.length !== 1) invalid();
  const c = data.choices[0];
  if (!record(c) || c.index !== 0 || !['stop', 'length', 'content_filter'].includes(c.finish_reason)) invalid();
  const m = c.message;
  if (!record(m) || m.role !== 'assistant' || (m.content !== null && typeof m.content !== 'string')
    || (m.refusal !== undefined && m.refusal !== null && typeof m.refusal !== 'string')
    || (m.tool_calls !== undefined && (!Array.isArray(m.tool_calls) || m.tool_calls.length))
    || m.function_call != null || m.audio != null) invalid();
  return { reply: m.content || m.refusal || '', stopReason: c.finish_reason };
}

function responsesStop(data) {
  if (data.object !== 'response' || data.error != null) invalid();
  if (data.status === 'completed' && data.incomplete_details == null) return 'completed';
  if (data.status === 'incomplete' && record(data.incomplete_details)
    && ['max_output_tokens', 'content_filter'].includes(data.incomplete_details.reason)) return data.incomplete_details.reason;
  return invalid();
}

function responsesReply(data) {
  const stopReason = responsesStop(data);
  if (!Array.isArray(data.output) || !data.output.length || data.output.length > 32) invalid();
  const parts = data.output.flatMap(item => {
    if (!record(item)) invalid();
    // Reasoning items may be encrypted; this text-only channel never exposes them.
    if (item.type === 'reasoning') return [];
    if (item.type !== 'message' || item.role !== 'assistant' || typeof item.id !== 'string' || !ID.test(item.id)
      || !['completed', 'incomplete'].includes(item.status)
      || (data.status === 'completed' && item.status !== 'completed')
      || !Array.isArray(item.content) || !item.content.length || item.content.length > 32) invalid();
    return item.content.map(block => {
      if (!record(block)) invalid();
      if (block.type === 'output_text' && typeof block.text === 'string') return block.text;
      if (block.type === 'refusal' && typeof block.refusal === 'string') return block.refusal;
      return invalid();
    });
  });
  return { reply: parts.join(''), stopReason };
}

export function decodeApiReply(bytes, key, protocol) {
  let data;
  try {
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    if (text.includes(key)) invalid();
    data = JSON.parse(text);
  } catch { invalid(); }
  return validateApiReply(data, key, protocol);
}

// JSON and Messages SSE share the same final text/identity/usage contract.
export function validateApiReply(data, key, protocol) {
  if (!record(data) || typeof data.id !== 'string' || !ID.test(data.id)
    || typeof data.model !== 'string' || !ID.test(data.model)) invalid();
  const result = protocol === 'messages' ? messagesReply(data) : protocol === 'chat' ? chatReply(data) : responsesReply(data);
  if (!result.reply.trim() || Buffer.byteLength(result.reply) > MAX_API_REPLY_BYTES
    || [result.reply, data.id, data.model].some(value => value.includes(key))) invalid();
  return {
    ...result, assistantMessageId: data.id, model: data.model,
    complete: completionForStopReason(result.stopReason), usage: usageFor(data, protocol),
  };
}
