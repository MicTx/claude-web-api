import { realpathSync, statSync, openSync, closeSync, fstatSync, lstatSync, readSync, constants } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { BridgeError } from './core/errors.mjs';
import { configureApi } from './api-config.mjs';
import { configPath, defaultStateDir } from './identity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_READY_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1_000;
const ENV_KEYS = {
  cdpUrl: 'CCW_CDP_URL', stateDir: 'CCW_STATE_DIR', orgId: 'CCW_ORG_ID',
  attachmentRoot: 'CCW_ATTACHMENT_ROOT', downloadRoot: 'CCW_DOWNLOAD_ROOT',
  timeoutMs: 'CCW_TIMEOUT_MS', idleTimeoutMs: 'CCW_IDLE_TIMEOUT_MS',
  readyTimeoutMs: 'CCW_READY_TIMEOUT_MS', minIntervalMs: 'CCW_MIN_INTERVAL_MS',
  backend: 'CCW_BACKEND', apiBaseUrl: 'CCW_API_BASE_URL', apiModel: 'CCW_API_MODEL',
  apiKeyFile: 'CCW_API_KEY_FILE', apiMaxTokens: 'CCW_API_MAX_TOKENS', apiCache: 'CCW_API_CACHE',
  apiReasoning: 'CCW_API_REASONING', apiProtocol: 'CCW_API_PROTOCOL',
};

// One file at a time: null means absent, any other failure is a hard error so an
// unsafe new file is never bypassed by silently reading the legacy path.
function readStartupConfigFile(path) {
  let fd;
  let found = false;
  try {
    const initial = lstatSync(path, { bigint: true });
    found = true;
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n
      || initial.size > 16384n || (initial.mode & 0o022n)
      || (typeof process.getuid === 'function' && initial.uid !== BigInt(process.getuid()))
      || !Number.isInteger(constants.O_NOFOLLOW)) throw new Error('unsafe configuration');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    const buffer = Buffer.alloc(16385);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (size > 16384 || BigInt(size) !== before.size || !before.isFile() || before.nlink !== 1n
      || [initial, after, named].some(st => st.dev !== before.dev || st.ino !== before.ino || st.size !== before.size
        || st.mtimeNs !== before.mtimeNs || st.ctimeNs !== before.ctimeNs)) throw new Error('configuration changed');
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid configuration');
    for (const [key, value] of Object.entries(data)) {
      if (!Object.hasOwn(ENV_KEYS, key)) throw new Error('unknown configuration field');
      if (key.endsWith('Ms') || key === 'apiMaxTokens') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('invalid configuration value');
      } else if (typeof value !== 'string' && !(value === null && ['orgId', 'attachmentRoot', 'downloadRoot', 'apiBaseUrl', 'apiModel', 'apiKeyFile'].includes(key))) {
        throw new Error('invalid configuration value');
      }
    }
    return data;
  } catch (error) {
    if (!found && error.code === 'ENOENT') return null;
    throw new BridgeError('CONFIG_INVALID', 'Startup configuration must be a stable, owned, non-linked JSON file with supported fields (at most 16 KiB, not group/world writable)');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function startupConfig(env) {
  if (!env.HOME) return {};
  if (typeof env.HOME !== 'string' || !isAbsolute(env.HOME) || env.HOME.includes('\0')) throw new BridgeError('CONFIG_INVALID', 'HOME must be an absolute directory');
  for (const path of [configPath(env.HOME)]) {
    const data = readStartupConfigFile(path);
    if (data !== null) return data;
  }
  return {};
}

function parsePositiveInt(raw, name) {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw <= 0) {
      throw new BridgeError('CONFIG_INVALID', `${name} must be a positive integer`);
    }
    return raw;
  }
  if (!/^\d+$/.test(String(raw).trim())) {
    throw new BridgeError('CONFIG_INVALID', `${name} must be a positive integer`);
  }
  return Number(String(raw).trim());
}

function validateCdpUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must be a non-empty string');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl is not a valid URL');
  }
  if (url.protocol !== 'http:') {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must use http://');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must point to a loopback host (127.0.0.1, localhost or [::1])');
  }
  if (url.port === '') {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must include an explicit port');
  }
  if (url.username !== '' || url.password !== '') {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must not contain credentials');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must not contain a path');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new BridgeError('CONFIG_INVALID', 'cdpUrl must not contain a query or fragment');
  }
  return `http://${url.hostname === '[::1]' ? '[::1]' : url.hostname}:${url.port}`;
}

export function loadConfig(env = process.env, overrides = {}) {
  const raw = {
    cdpUrl: null,
    stateDir: defaultStateDir(env),
    orgId: null,
    attachmentRoot: null,
    downloadRoot: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_MS,
    readyTimeoutMs: DEFAULT_READY_MS,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    backend: 'web',
    apiBaseUrl: null,
    apiModel: null,
    apiKeyFile: null,
    apiMaxTokens: 4096,
    apiCache: 'ephemeral',
    apiReasoning: 'off',
    apiProtocol: 'messages',
    ...startupConfig(env),
  };
  for (const [key, variable] of Object.entries(ENV_KEYS)) {
    if (env[variable] !== undefined) raw[key] = env[variable];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && Object.hasOwn(raw, key)) raw[key] = value;
  }

  if (raw.cdpUrl !== null) raw.cdpUrl = validateCdpUrl(raw.cdpUrl);

  if (typeof raw.stateDir !== 'string' || raw.stateDir.length === 0 || raw.stateDir.includes('\0')) {
    throw new BridgeError('CONFIG_INVALID', 'stateDir must be a non-empty path');
  }
  if (!isAbsolute(raw.stateDir)) {
    throw new BridgeError('CONFIG_INVALID', 'stateDir must be an absolute path');
  }
  raw.stateDir = resolve(raw.stateDir);

  raw.attachmentRootReal = null;
  if (raw.attachmentRoot !== null) {
    if (typeof raw.attachmentRoot !== 'string' || !isAbsolute(raw.attachmentRoot) || raw.attachmentRoot.includes('\0')) {
      throw new BridgeError('CONFIG_INVALID', 'attachmentRoot must be an absolute directory path');
    }
    try {
      raw.attachmentRoot = resolve(raw.attachmentRoot);
      raw.attachmentRootReal = realpathSync(raw.attachmentRoot);
      if (!statSync(raw.attachmentRootReal).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new BridgeError('CONFIG_INVALID', 'attachmentRoot must name an existing accessible directory');
    }
  }

  raw.downloadRootReal = null;
  if (raw.downloadRoot !== null) {
    if (typeof raw.downloadRoot !== 'string' || !isAbsolute(raw.downloadRoot) || raw.downloadRoot.includes('\0')) {
      throw new BridgeError('CONFIG_INVALID', 'downloadRoot must be an absolute directory path');
    }
    try {
      raw.downloadRoot = resolve(raw.downloadRoot);
      raw.downloadRootReal = realpathSync(raw.downloadRoot);
      if (!statSync(raw.downloadRootReal).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new BridgeError('CONFIG_INVALID', 'downloadRoot must name an existing accessible directory');
    }
  }

  if (raw.orgId !== null) {
    if (typeof raw.orgId !== 'string' || !UUID_RE.test(raw.orgId)) {
      throw new BridgeError('CONFIG_INVALID', 'orgId must be a UUID');
    }
  }

  raw.timeoutMs = parsePositiveInt(raw.timeoutMs, 'timeoutMs');
  if (raw.timeoutMs < MIN_TIMEOUT_MS || raw.timeoutMs > MAX_TIMEOUT_MS) {
    throw new BridgeError('CONFIG_INVALID', `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  raw.idleTimeoutMs = parsePositiveInt(raw.idleTimeoutMs, 'idleTimeoutMs');
  if (raw.idleTimeoutMs > raw.timeoutMs) {
    throw new BridgeError('CONFIG_INVALID', 'idleTimeoutMs must not exceed timeoutMs');
  }
  raw.readyTimeoutMs = parsePositiveInt(raw.readyTimeoutMs, 'readyTimeoutMs');
  raw.minIntervalMs = parsePositiveInt(raw.minIntervalMs, 'minIntervalMs');
  if (raw.readyTimeoutMs > MAX_TIMEOUT_MS || raw.minIntervalMs > MAX_TIMEOUT_MS) throw new BridgeError('CONFIG_INVALID', 'Readiness timeout and minimum interval must not exceed 600000ms');

  configureApi(raw, env);
  Object.defineProperty(raw, 'home', { value: env.HOME ?? null, enumerable: false });
  Object.defineProperty(raw, 'env', { value: env, enumerable: false });
  Object.defineProperty(raw, 'platform', { value: process.platform, enumerable: false });
  return raw;
}
