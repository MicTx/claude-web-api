const MAX_MESSAGE = 500;
const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_STRING = 2000;
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

function cleanString(value) {
  const text = String(value).replace(CONTROL_CHARS, ' ');
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}...` : text;
}

function cleanDetails(value, depth) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return cleanString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((item) => cleanDetails(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      out[key] = cleanDetails(value[key], depth + 1);
    }
    return out;
  }
  return String(value);
}

export class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export function errorResult(error) {
  const isBridge = error instanceof BridgeError;
  const code = isBridge && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const raw = error && typeof error.message === 'string' ? error.message : 'Unknown error';
  const message = cleanString(raw).slice(0, MAX_MESSAGE);
  const details = isBridge ? cleanDetails(error.details ?? {}, 0) : {};
  return { ok: false, error: { code, message, details } };
}
