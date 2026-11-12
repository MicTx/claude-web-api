import { promises as fs, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BridgeError } from './core/errors.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const API_PROTOCOLS = Object.freeze(['messages', 'chat', 'responses']);
export const API_REASONING_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
const OPENAI_REASONING_LEVELS = Object.freeze([...API_REASONING_LEVELS, 'none', 'minimal']);
export const API_MAX_TOKENS_CEILING = 65536;
export const API_CONTEXT_TOKENS_CEILING = 131072;

export function apiProtocol(config) {
  const protocol = config?.apiProtocol === undefined ? 'messages' : config.apiProtocol;
  if (!API_PROTOCOLS.includes(protocol)) throw new BridgeError('CONFIG_INVALID', 'apiProtocol must be messages, chat or responses');
  return protocol;
}

export const apiReasoningEffort = (config) => {
  const levels = apiProtocol(config) === 'messages' ? API_REASONING_LEVELS : OPENAI_REASONING_LEVELS;
  const level = config?.apiReasoning === undefined ? 'off' : config.apiReasoning;
  if (!levels.includes(level)) throw new BridgeError('CONFIG_INVALID', `apiReasoning must be one of ${levels.join(', ')}`);
  return level === 'off' ? null : level;
};

export const apiWireMaxTokens = (config) => config.apiMaxTokens;
const keyValid = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
const scrypt = promisify(scryptCallback);

export async function readApiKeyFile(path) {
  let handle;
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error();
    if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error();
    const initial = await fs.lstat(path, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error();
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 8192n || (before.mode & 0o077n)
      || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) throw new Error();
    const buffer = Buffer.alloc(8193);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    if (BigInt(size) !== before.size || [initial, after, named].some(st =>
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => st[field] !== before[field]))) throw new Error();
    const key = new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(0, size)).trim();
    if (!keyValid(key)) throw new Error();
    return key;
  } catch {
    throw new BridgeError('API_CREDENTIALS', 'API key file must be stable, private, owned, regular, singly linked and at most 8 KiB');
  } finally {
    await handle?.close();
  }
}

async function credentialVerifier(key, sessionId, salt) {
  return scrypt(key, `ccw-api-credential-v1:${sessionId}:${salt}`, 32);
}

export async function createCredentialBinding(key, sessionId) {
  const salt = randomBytes(16).toString('hex');
  const verifier = await credentialVerifier(key, sessionId, salt);
  return { algorithm: 'scrypt-v1', salt, verifier: verifier.toString('hex') };
}

export async function matchesCredentialBinding(key, sessionId, binding) {
  const actual = await credentialVerifier(key, sessionId, binding.salt);
  return timingSafeEqual(actual, Buffer.from(binding.verifier, 'hex'));
}

export function configureApi(config, env) {
  const invalid = message => { throw new BridgeError('CONFIG_INVALID', message); };
  if (!['web', 'api', 'auto'].includes(config.backend)) invalid('backend must be web, api or auto');
  if (!['ephemeral', 'off'].includes(config.apiCache)) invalid('apiCache must be ephemeral or off');
  if (config.apiBaseUrl !== null) {
    let url;
    try { url = new URL(config.apiBaseUrl); } catch { invalid('apiBaseUrl must be a valid URL'); }
    if (typeof config.apiBaseUrl !== 'string' || config.apiBaseUrl.length > 2048
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
      || !url.hostname || url.username || url.password || url.search || url.hash) {
      invalid('apiBaseUrl requires HTTPS (HTTP only for loopback tests), without credentials, query or fragment');
    }
    config.apiBaseUrl = url.href.replace(/\/+$/, '');
  }
  if (config.apiModel !== null && (typeof config.apiModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(config.apiModel))) {
    invalid('apiModel must be a bounded model identifier');
  }
  if (config.apiKeyFile !== null && (typeof config.apiKeyFile !== 'string' || !isAbsolute(config.apiKeyFile) || /[\0\r\n]/.test(config.apiKeyFile))) {
    invalid('apiKeyFile must be an absolute file path');
  }
  apiReasoningEffort(config);
  if (!/^\d+$/.test(String(config.apiMaxTokens))) invalid('apiMaxTokens must be a positive integer');
  config.apiMaxTokens = Number(config.apiMaxTokens);
  if (!Number.isSafeInteger(config.apiMaxTokens) || config.apiMaxTokens < 1 || config.apiMaxTokens > API_MAX_TOKENS_CEILING) {
    invalid(`apiMaxTokens must be between 1 and ${API_MAX_TOKENS_CEILING}`);
  }
  if (!/^\d+$/.test(String(config.apiContextTokens))) invalid('apiContextTokens must be a positive integer');
  config.apiContextTokens = Number(config.apiContextTokens);
  if (!Number.isSafeInteger(config.apiContextTokens) || config.apiContextTokens < 1024
    || config.apiContextTokens > API_CONTEXT_TOKENS_CEILING) {
    invalid(`apiContextTokens must be between 1024 and ${API_CONTEXT_TOKENS_CEILING}`);
  }
  const key = env.CCW_API_KEY;
  if (key !== undefined && !keyValid(key)) invalid('CCW_API_KEY must be a non-empty bounded credential without whitespace');
  if (config.backend !== 'web' && (!config.apiBaseUrl || (key === undefined && !config.apiKeyFile))) {
    invalid('api and auto modes require an API base URL and credential source');
  }
  const keyFile = config.apiKeyFile;
  // Non-secret readiness flag for diagnostics; the credential itself stays behind readApiKey.
  Object.defineProperty(config, 'apiCredentialConfigured', { value: key !== undefined || keyFile !== null });
  Object.defineProperty(config, 'readApiKey', { value: async () => {
    if (!config.apiBaseUrl || (key === undefined && !keyFile)) {
      throw new BridgeError('API_NOT_CONFIGURED', 'Configure the API base URL and private credential source before use');
    }
    return key === undefined ? readApiKeyFile(keyFile) : key;
  } });
}
