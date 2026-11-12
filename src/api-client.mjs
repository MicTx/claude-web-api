import { BridgeError } from './core/errors.mjs';
import { apiProtocol } from './api-config.mjs';
import { apiPayloadFor, apiWireSettings } from './api-protocol.mjs';
import { estimateApiInputTokens } from './api-context.mjs';
import { decodeApiReply } from './api-reply.mjs';
import { consumeApiMessages, MAX_API_STREAM_BYTES } from './api-sse.mjs';

export { MAX_API_REPLY_BYTES, completionForStopReason } from './api-reply.mjs';
export const MAX_API_CONTEXT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prepareApiRequest(config, messages, sessionId) {
  if (!config.apiBaseUrl || !config.apiModel) throw new BridgeError('API_NOT_CONFIGURED', 'Configure an API base URL and model first');
  if (!UUID.test(sessionId) || !Array.isArray(messages) || !messages.length || messages.length > 129
    || messages.length % 2 !== 1 || messages.some((m, i) => !m || m.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' || !m.content.trim())) {
    throw new BridgeError('INVALID_ARGUMENT', 'API messages require a stable session ID and alternating bounded text history');
  }
  const current = messages.at(-1);
  const currentTokens = estimateApiInputTokens([current]);
  if (currentTokens > config.apiContextTokens) {
    throw new BridgeError('API_INPUT_BUDGET', 'The current prompt exceeds the configured API input token budget; nothing was sent', {
      estimatedInputTokens: currentTokens,
      tokenBudget: config.apiContextTokens,
    });
  }
  let currentBytes = null;
  for (let start = 0; start < messages.length; start += 2) {
    const selected = messages.slice(start);
    const estimatedInputTokens = estimateApiInputTokens(selected);
    const payload = JSON.stringify(apiPayloadFor(config, selected, sessionId));
    const requestBytes = Buffer.byteLength(payload, 'utf8');
    if (start === messages.length - 1) currentBytes = requestBytes;
    if (estimatedInputTokens <= config.apiContextTokens && requestBytes <= MAX_API_CONTEXT_BYTES) {
      return {
        body: payload,
        context: {
          policy: 'rolling-window',
          tokenBudget: config.apiContextTokens,
          maxRequestBytes: MAX_API_CONTEXT_BYTES,
          estimatedInputTokens,
          requestBytes,
          retainedTurns: (selected.length - 1) / 2,
          omittedTurns: start / 2,
          retainedMessages: selected.length,
        },
      };
    }
  }
  if (currentBytes !== null && currentBytes > MAX_API_CONTEXT_BYTES) {
    throw new BridgeError('API_CONTEXT_LIMIT', 'Current API request JSON exceeds 256 KiB; no request was sent', {
      requestBytes: currentBytes,
      maxRequestBytes: MAX_API_CONTEXT_BYTES,
      estimatedInputTokens: currentTokens,
      tokenBudget: config.apiContextTokens,
    });
  }
  throw new BridgeError('API_INPUT_BUDGET', 'No complete API context fits the configured input token budget; nothing was sent', {
    estimatedInputTokens: currentTokens,
    tokenBudget: config.apiContextTokens,
  });
}

export function apiRequest(config, messages, sessionId) {
  return prepareApiRequest(config, messages, sessionId).body;
}

export async function sendApiMessage(config, { messages, sessionId, key, prepared }, { signal, fetchImpl = globalThis.fetch } = {}) {
  const request = prepared ?? prepareApiRequest(config, messages, sessionId);
  const body = request.body;
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(key)) throw new BridgeError('API_CREDENTIALS', 'A valid private API credential is required');
  if (messages.some(message => message.content.includes(key)) || body.includes(key) || config.apiBaseUrl.includes(key)) {
    throw new BridgeError('API_CREDENTIALS', 'Credentials must not appear in API text or destination paths');
  }
  const protocol = apiProtocol(config);
  const streaming = protocol === 'messages';
  const contentType = streaming ? 'text/event-stream' : 'application/json';
  const maxBytes = streaming ? MAX_API_STREAM_BYTES : MAX_RESPONSE_BYTES;
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let res;
  try {
    if (combined.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    res = await fetchImpl(`${config.apiBaseUrl}${apiWireSettings(config).path}`, {
      method: 'POST', redirect: 'manual', signal: combined,
      headers: {
        authorization: `Bearer ${key}`, ...(protocol === 'messages' ? { 'anthropic-version': '2023-06-01' } : {}),
        'content-type': 'application/json', accept: contentType, 'x-session-affinity': sessionId,
      },
      body,
    });
    if (res.status >= 300 && res.status < 400) throw new BridgeError('API_REDIRECT', 'API redirects are refused; credentials were not forwarded', { status: res.status });
    if (res.status !== 200) throw new BridgeError('API_HTTP_ERROR', 'API rejected or failed the request; no retry was made', { status: res.status });
    if ((res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== contentType || !res.body) {
      throw new BridgeError('API_RESPONSE', streaming ? 'Messages API response must be SSE' : 'API response must be JSON');
    }
    if (Number(res.headers.get('content-length')) > maxBytes) throw new BridgeError('API_RESPONSE_TOO_LARGE', 'API response exceeds the read limit');
    if (streaming) {
      const result = await consumeApiMessages(res.body, key, { signal: combined });
      return { ...result, context: request.context };
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new BridgeError('API_RESPONSE_TOO_LARGE', 'API response exceeds the read limit');
      chunks.push(chunk);
    }
    if (combined.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const result = decodeApiReply(Buffer.concat(chunks), key, protocol);
    return { ...result, context: request.context };
  } catch (error) {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'API operation aborted; it was not retried');
    if (deadline.aborted) throw new BridgeError('TIMEOUT', 'API operation timed out; it was not retried');
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('API_REQUEST_FAILED', 'API request failed; it was not retried');
  } finally {
    await res?.body?.cancel().catch(() => {});
  }
}
