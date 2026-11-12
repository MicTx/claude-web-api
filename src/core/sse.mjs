// consumeCompletion is injected verbatim into the Claude page context via
// Function.prototype.toString(). It must stay fully self-contained:
// no imports and no references to helpers closed over outside this function.
export async function consumeCompletion(stream, { onChunk = () => {}, maxBytes = 8 * 1024 * 1024 } = {}) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_LINE = 4 * 1024 * 1024;
  const MAX_EVENTS = 1_000_000;
  const MAX_PARTIAL = 4000;
  const KNOWN_EVENTS = new Set([
    'message_start', 'content_block_start', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_limit', 'message_stop', 'error',
  ]);

  const fail = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let curEvent = '';
  let curData = [];
  let eventCount = 0;
  let totalBytes = 0;
  let finished = false;
  let messageStarted = false;
  let assistantMessageId = null;
  let model = null;
  let stopReason = null;
  let quota = null;
  const blocks = new Map();
  // text blocks are concatenated in index order, not arrival order
  const replyText = () => [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, b]) => b.type === 'text')
    .map(([, b]) => b.text)
    .join('');

  const extractLines = (isEof) => {
    const lines = [];
    let start = 0;
    for (let i = 0; i < carry.length; i++) {
      const c = carry[i];
      if (c === '\n') {
        lines.push(carry.slice(start, i));
        start = i + 1;
      } else if (c === '\r') {
        if (i === carry.length - 1 && !isEof) break;
        if (carry[i + 1] === '\n') {
          lines.push(carry.slice(start, i));
          i++;
          start = i + 1;
        } else {
          lines.push(carry.slice(start, i));
          start = i + 1;
        }
      }
    }
    carry = carry.slice(start);
    if (isEof && carry.length > 0) {
      lines.push(carry);
      carry = '';
    }
    return lines;
  };

  const handleLine = (line) => {
    if (line.length > MAX_LINE) fail('API_CONTRACT', 'SSE line exceeds limit');
    if (line === '') {
      dispatch();
      return;
    }
    if (line[0] === ':') return;
    const colon = line.indexOf(':');
    let field;
    let value;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
    }
    if (field === 'event') {
      curEvent = value;
    } else if (field === 'data') {
      curData.push(value);
    }
    // id:, retry: and unknown fields are ignored
  };

  const parseData = (raw) => {
    try {
      return JSON.parse(raw.trim());
    } catch {
      fail('API_CONTRACT', 'SSE event data is not valid JSON');
    }
  };

  const checkIndex = (index) => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      fail('API_CONTRACT', 'SSE content block has an invalid index');
    }
  };

  const dispatch = () => {
    if (curEvent === '' && curData.length === 0) return;
    const name = curEvent;
    const dataRaw = curData.join('\n');
    curEvent = '';
    curData = [];
    if (name === 'ping' || dataRaw === '') return;
    eventCount += 1;
    if (eventCount > MAX_EVENTS) fail('API_CONTRACT', 'SSE event count exceeds limit');
    const data = parseData(dataRaw);
    if (KNOWN_EVENTS.has(name) && data && typeof data === 'object' && 'type' in data && data.type !== name) {
      fail('API_CONTRACT', `SSE ${name} event carries mismatched type`);
    }

    if (name === 'message_start') {
      if (messageStarted) fail('API_CONTRACT', 'duplicate message_start event');
      const uuid = data?.message?.uuid;
      if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
        fail('API_CONTRACT', 'message_start is missing a valid assistant message uuid');
      }
      messageStarted = true;
      assistantMessageId = uuid;
      if (typeof data.message.model === 'string' && data.message.model !== '') {
        model = data.message.model;
      }
      return;
    }
    if (name === 'content_block_start') {
      if (!messageStarted) fail('API_CONTRACT', 'content_block_start before message_start');
      const index = data?.index;
      checkIndex(index);
      if (blocks.has(index)) fail('API_CONTRACT', 'duplicate content_block_start index');
      const type = data?.content_block?.type;
      if (typeof type !== 'string' || type === '') {
        fail('API_CONTRACT', 'content_block_start is missing a block type');
      }
      if (type === 'text' && data.content_block.text !== undefined && typeof data.content_block.text !== 'string') {
        fail('API_CONTRACT', 'text content_block has non-string text');
      }
      blocks.set(index, {
        type,
        text: typeof data.content_block.text === 'string' ? data.content_block.text : '',
        stopped: false,
      });
      return;
    }
    if (name === 'content_block_delta') {
      const index = data?.index;
      checkIndex(index);
      const block = blocks.get(index);
      const delta = data?.delta;
      if (!block) fail('API_CONTRACT', 'content_block_delta references an unknown block');
      if (block.stopped) fail('API_CONTRACT', 'content_block_delta after content_block_stop');
      if (delta?.type === 'text_delta' && block.type !== 'text') {
        fail('API_CONTRACT', 'text_delta references a non-text block');
      }
      if (block.type === 'text') {
        if (!delta || delta.type !== 'text_delta' || typeof delta.text !== 'string') {
          fail('API_CONTRACT', 'text block delta is malformed');
        }
        block.text += delta.text;
        onChunk(replyText());
      }
      // thinking/signature/tool deltas stay excluded
      return;
    }
    if (name === 'content_block_stop') {
      const index = data?.index;
      checkIndex(index);
      const block = blocks.get(index);
      if (!block) fail('API_CONTRACT', 'content_block_stop references an unknown block');
      if (block.stopped) fail('API_CONTRACT', 'duplicate content_block_stop');
      block.stopped = true;
      return;
    }
    if (name === 'message_delta') {
      if (typeof data?.delta?.stop_reason === 'string' && data.delta.stop_reason !== '') {
        stopReason = data.delta.stop_reason;
      }
      return;
    }
    if (name === 'message_limit') {
      if (data && typeof data === 'object' && data.message_limit && typeof data.message_limit === 'object') {
        quota = data.message_limit;
      }
      return;
    }
    if (name === 'message_stop') {
      if (!messageStarted || !assistantMessageId) {
        fail('API_CONTRACT', 'message_stop without a valid message_start');
      }
      if (typeof stopReason !== 'string' || stopReason === '') {
        fail('API_CONTRACT', 'message_stop without a stop_reason');
      }
      for (const block of blocks.values()) {
        if (block.type === 'text' && !block.stopped) {
          fail('API_CONTRACT', 'message_stop arrived with an unstopped text block');
        }
      }
      finished = true;
      return;
    }
    if (name === 'error') {
      const remote = typeof data?.error?.message === 'string' ? data.error.message : 'remote stream error';
      const error = new Error(remote.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300));
      error.code = 'REMOTE_ERROR';
      error.details = { type: typeof data?.error?.type === 'string' ? data.error.type.slice(0, 120) : null };
      throw error;
    }
    // unknown event types are ignored for forward compatibility
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        fail('PAYLOAD_TOO_LARGE', 'SSE stream exceeds size limit', { maxBytes });
      }
      carry += decoder.decode(chunk, { stream: true });
      for (const line of extractLines(false)) handleLine(line);
      if (finished) break;
    }
    if (!finished) {
      carry += decoder.decode();
      for (const line of extractLines(true)) handleLine(line);
      dispatch(); // a complete final event without trailing blank line still counts
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // reader may already be released or errored
    }
    try {
      reader.releaseLock?.();
    } catch {
      // custom readers may not implement releaseLock
    }
  }

  if (!finished) {
    const partialReply = replyText();
    const partial = partialReply === '' ? null : (partialReply.length > MAX_PARTIAL ? `${partialReply.slice(0, MAX_PARTIAL)}...` : partialReply);
    fail('STREAM_INCOMPLETE', 'SSE stream ended without message_stop', { partialReply: partial });
  }
  const reply = replyText();
  if (reply.trim() === '') {
    fail('API_CONTRACT', 'SSE stream completed with an empty reply');
  }
  // This function is injected into the browser and cannot close over imports.
  const complete = ['max_tokens', 'model_context_window_exceeded'].includes(stopReason) ? false
    : ['end_turn', 'stop_sequence', 'refusal'].includes(stopReason) ? true : null;
  return { reply, assistantMessageId, model, stopReason, complete, quota };
}
