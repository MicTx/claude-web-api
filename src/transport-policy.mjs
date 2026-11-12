import { BridgeError } from './core/errors.mjs';

export const POST_RETRY_POLICY = Object.freeze({
  method: 'POST',
  maxAttempts: 1,
  retry: 'never',
  idempotencyRequired: 'confirmed',
});

export function classifySendRetry({ status, error } = {}) {
  if (typeof status === 'number') {
    if (status >= 300 && status < 400) return { retryable: false, reason: 'redirect', idempotencyConfirmed: null };
    if (status === 401 || status === 403) return { retryable: false, reason: 'authentication', idempotencyConfirmed: null };
    if (status >= 500) return { retryable: false, reason: 'paid-uncertain', idempotencyConfirmed: false };
    return { retryable: false, reason: 'contract', idempotencyConfirmed: null };
  }
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'TIMEOUT' || code === 'ABORTED') return { retryable: false, reason: 'uncertain', idempotencyConfirmed: false };
  if (code === 'API_STREAM_INCOMPLETE') return { retryable: false, reason: 'partial-stream', idempotencyConfirmed: false };
  if (code === 'API_REDIRECT') return { retryable: false, reason: 'redirect', idempotencyConfirmed: null };
  if (code === 'API_HTTP_ERROR' && (error?.details?.status === 401 || error?.details?.status === 403)) {
    return { retryable: false, reason: 'authentication', idempotencyConfirmed: null };
  }
  return { retryable: false, reason: code ?? 'request-failed', idempotencyConfirmed: null };
}

export function parseRetryAfter(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds), 86_400);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.min(Math.max(Math.ceil((dateMs - Date.now()) / 1000), 0), 86_400);
  return null;
}

export function policyForSend({ method = 'POST', idempotencyConfirmed = false } = {}) {
  if (method !== 'POST') {
    throw new BridgeError('INVALID_ARGUMENT', 'Send retry policy is defined for POST only');
  }
  return {
    ...POST_RETRY_POLICY,
    idempotencyConfirmed: idempotencyConfirmed === true,
    maxAttempts: idempotencyConfirmed === true ? 2 : 1,
  };
}

export function safeReadRetryPolicy() {
  return Object.freeze({ methods: ['GET', 'HEAD'], maxAttempts: 2, scope: 'same-deadline' });
}
