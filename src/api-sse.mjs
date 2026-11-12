import { BridgeError } from './core/errors.mjs';
import { MAX_API_REPLY_BYTES, validateApiReply } from './api-reply.mjs';

export const MAX_API_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 100000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const EVENTS = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'error']);
const COUNTERS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const invalid = () => { throw new BridgeError('API_RESPONSE', 'API stream is not a valid bounded text message'); };
const tooLarge = () => { throw new BridgeError('API_RESPONSE_TOO_LARGE', 'API stream exceeds its read limit'); };

// API message IDs/usage differ from the webpage SSE contract. Never expose or
// persist a partial answer: only a fully framed message_stop returns a result.
export async function consumeApiMessages(stream, key, { signal } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let totalBytes = 0, eventBytes = 0, eventCount = 0, lineBytes = 0, replyBytes = 0;
  let line = '', eventName = '', eventData = '', hasData = false, skipLF = false, secretTail = '';
  let message = null, active = null, deltaSeen = false, stopReason = null, result = null;
  const blocks = [];
  const usage = {};

  const checkAbort = () => {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'API stream aborted; it was not retried');
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  const mergeUsage = incoming => {
    if (incoming === undefined) return;
    if (!record(incoming)) invalid();
    for (const field of COUNTERS) {
      const value = incoming[field];
      // All counters are cumulative. Omitted/null details do not erase the
      // initial usage; a reported zero is real and must not become unknown.
      if (value === undefined || value === null) continue;
      if (!Number.isSafeInteger(value) || value < 0) invalid();
      usage[field] = value;
    }
    for (const field of ['input_tokens_details', 'output_tokens_details']) {
      const details = incoming[field];
      if (details === undefined || details === null) continue;
      if (!record(details)) invalid();
      if (field === 'output_tokens_details' && details.thinking_tokens != null) {
        const value = details.thinking_tokens;
        if (!Number.isSafeInteger(value) || value < 0) invalid();
        usage.output_tokens_details = { thinking_tokens: value };
      }
    }
  };
  const appendText = (block, text) => {
    if (typeof text !== 'string') invalid();
    replyBytes += Buffer.byteLength(text);
    if (replyBytes > MAX_API_REPLY_BYTES) tooLarge();
    block.text += text;
  };
  const indexFor = data => {
    if (!Number.isSafeInteger(data.index) || data.index < 0 || data.index >= 32) invalid();
    return data.index;
  };
  const parseData = raw => {
    let data;
    try { data = JSON.parse(raw); } catch { invalid(); }
    // Raw chunk scanning also covers comments/unknown events. Check decoded
    // strings in known frames so Unicode escapes cannot echo a credential.
    const pending = [data];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === 'string' && value.includes(key)) invalid();
      if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value)) pending.push(item);
      }
    }
    return data;
  };
  const dispatch = () => {
    const name = eventName, raw = eventData, present = hasData;
    eventName = ''; eventData = ''; hasData = false; eventBytes = 0;
    if (!name && !present) return;
    if (++eventCount > MAX_EVENTS) tooLarge();
    // Future event types are ignored, but still consume all wire/event budgets.
    if (name === 'ping' || !EVENTS.has(name)) return;
    if (!present) invalid();
    const data = parseData(raw);
    if (!record(data) || data.type !== name) invalid();
    if (name === 'error') throw new BridgeError('API_REMOTE_ERROR', 'API stream reported a remote error; it was not retried');
    if (name === 'message_start') {
      const m = data.message;
      if (message || !record(m) || m.type !== 'message' || m.role !== 'assistant'
        || typeof m.id !== 'string' || !ID.test(m.id) || typeof m.model !== 'string' || !ID.test(m.model)
        || !Array.isArray(m.content) || m.content.length || m.stop_reason != null) invalid();
      message = { id: m.id, model: m.model, type: 'message', role: 'assistant' };
      mergeUsage(m.usage);
      return;
    }
    if (!message) invalid();
    if (name === 'content_block_start') {
      const index = indexFor(data), block = data.content_block;
      if (deltaSeen || active !== null || index !== blocks.length || !record(block)
        || !['text', 'thinking', 'redacted_thinking'].includes(block.type)) invalid();
      const item = { type: block.type, ...(block.type === 'text' ? { text: '' } : {}) };
      if (block.type === 'text') appendText(item, block.text);
      if (block.type === 'thinking' && (typeof block.thinking !== 'string' || (block.signature !== undefined && typeof block.signature !== 'string'))) invalid();
      if (block.type === 'redacted_thinking' && typeof block.data !== 'string') invalid();
      blocks.push(item);
      active = index;
      return;
    }
    if (name === 'content_block_delta') {
      const index = indexFor(data), d = data.delta;
      if (active !== index || !record(d)) invalid();
      const block = blocks[index];
      if (block.type === 'text') {
        if (d.type !== 'text_delta') invalid();
        appendText(block, d.text);
      } else if (block.type === 'thinking') {
        if (!((d.type === 'thinking_delta' && typeof d.thinking === 'string')
          || (d.type === 'signature_delta' && typeof d.signature === 'string'))) invalid();
        // No thinking or signature text is accumulated or returned.
      } else invalid();
      return;
    }
    if (name === 'content_block_stop') {
      if (active !== indexFor(data)) invalid();
      active = null;
      return;
    }
    if (name === 'message_delta') {
      if (active !== null || !record(data.delta)) invalid();
      deltaSeen = true;
      const reason = data.delta.stop_reason;
      if (reason !== undefined && reason !== null) {
        if (typeof reason !== 'string' || !reason || (stopReason !== null && stopReason !== reason)) invalid();
        stopReason = reason;
      }
      mergeUsage(data.usage);
      return;
    }
    if (name === 'message_stop') {
      if (active !== null || !deltaSeen || !stopReason) invalid();
      result = validateApiReply({ ...message, content: blocks, stop_reason: stopReason, usage }, key, 'messages');
    }
  };
  const handleLine = value => {
    if (!value) { dispatch(); return; }
    eventBytes += Buffer.byteLength(value) + 1;
    if (eventBytes > MAX_EVENT_BYTES) tooLarge();
    if (value[0] === ':') return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let data = colon < 0 ? '' : value.slice(colon + 1);
    if (data[0] === ' ') data = data.slice(1);
    if (field === 'event') eventName = data;
    if (field === 'data') {
      eventData += (hasData ? '\n' : '') + data;
      hasData = true;
    }
    // id/retry/unknown fields never trigger reconnects or resend a request.
  };
  const appendLine = part => {
    lineBytes += Buffer.byteLength(part);
    if (lineBytes + eventBytes > MAX_EVENT_BYTES) tooLarge();
    line += part;
  };
  const consume = text => {
    if ((secretTail + text).includes(key)) invalid();
    secretTail = key.length > 1 ? (secretTail + text).slice(-(key.length - 1)) : '';
    let from = 0;
    // Scan only new characters, not the growing carried line on each chunk.
    for (let i = 0; i < text.length; i++) {
      if (skipLF) {
        skipLF = false;
        if (text[i] === '\n') { from = i + 1; continue; }
      }
      if (text[i] !== '\r' && text[i] !== '\n') continue;
      appendLine(text.slice(from, i));
      const value = line;
      line = ''; lineBytes = 0;
      handleLine(value);
      if (result) return;
      skipLF = text[i] === '\r';
      from = i + 1;
    }
    appendLine(text.slice(from));
  };
  const decode = (bytes, stream) => {
    let text;
    try { text = decoder.decode(bytes, { stream }); } catch { invalid(); }
    consume(text);
  };

  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort();
    while (!result) {
      const { value, done } = await reader.read();
      checkAbort();
      if (done) {
        decode(undefined, false);
        // Do not dispatch an unframed tail at EOF: a cut message_stop is not
        // proof that a paid turn terminated, even if its JSON looks complete.
        if (!result) throw new BridgeError('API_STREAM_INCOMPLETE', 'API stream ended before message_stop; it was not retried');
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_API_STREAM_BYTES) tooLarge();
      decode(value, true);
    }
    checkAbort();
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* Stream may already be closed or errored. */ }
    reader.releaseLock();
  }
  checkAbort();
  return result;
}
