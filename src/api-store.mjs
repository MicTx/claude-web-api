import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError } from './core/errors.mjs';
import { ensureStateDir, StateLock, ALIAS_RE } from './session-store.mjs';
import { MAX_API_CONTEXT_BYTES, MAX_API_REPLY_BYTES, completionForStopReason } from './api-client.mjs';
import { API_PROTOCOLS } from './api-config.mjs';

// Private API history stays outside sessions.json: it has its own file, limits,
// permissions and lock so web state semantics are never changed by this channel.
export const MAX_API_SESSIONS = 32;
export const MAX_API_TURNS = 20;
export const MAX_API_MESSAGES = MAX_API_TURNS * 2;
export const MAX_API_PROMPT_BYTES = 64 * 1024;
export const MAX_API_FILE_BYTES = 2 * 1024 * 1024;
const MAX_API_HISTORY_BYTES = MAX_API_CONTEXT_BYTES + MAX_API_REPLY_BYTES;
const RESPONSE_RESERVE_BYTES = 6 * MAX_API_REPLY_BYTES + 4096;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens', 'reasoningTokens'];
const PENDING_FIELDS = ['kind', 'transport', 'promptSha256', 'startedAt', 'messageCount'];
const ENTRY_FIELDS = ['session', 'sessionId', 'apiBaseUrl', 'model', 'modelSelection', 'title', 'messages',
  'lastAssistantMessageId', 'createdAt', 'updatedAt', 'lastUsage', 'pending', 'credentialBinding', 'protocol'];

function corrupt(message) {
  throw new BridgeError('API_STATE_CORRUPT', `Private API history is corrupt: ${message}`);
}

function unsafe(message) {
  throw new BridgeError('API_STATE_UNSAFE', message);
}

function checkIso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) corrupt(`${field} is not a timestamp`);
}

function checkBaseUrl(value, field) {
  if (typeof value !== 'string' || value.length > 2048) corrupt(`${field} is malformed`);
  let url;
  try { url = new URL(value); } catch { corrupt(`${field} is not a URL`); }
  if (!url.hostname || url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) {
    corrupt(`${field} is not an allowed destination`);
  }
}

function checkUsage(usage, field) {
  if (usage === null) return;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) corrupt(`${field} is malformed`);
  if (Object.keys(usage).some(key => ![...USAGE_FIELDS, 'observedAt'].includes(key))) corrupt(`${field} has unknown counters`);
  for (const name of USAGE_FIELDS) {
    const value = usage[name] ?? null;
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) corrupt(`${field}.${name} is malformed`);
  }
  if (usage.observedAt !== undefined) checkIso(usage.observedAt, `${field}.observedAt`);
}

function checkPending(pending, field, messageCount) {
  if (pending === null) return;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) corrupt(`${field} is malformed`);
  if (Object.keys(pending).some(key => !PENDING_FIELDS.includes(key))) corrupt(`${field} has unknown fields`);
  if (pending.kind !== 'send' || pending.transport !== 'api') corrupt(`${field} is not an API send attempt`);
  if (typeof pending.promptSha256 !== 'string' || !SHA256_RE.test(pending.promptSha256)) corrupt(`${field}.promptSha256 is malformed`);
  checkIso(pending.startedAt, `${field}.startedAt`);
  if (pending.messageCount !== messageCount) corrupt(`${field}.messageCount does not match the stored history`);
}

function checkEntry(entry, index) {
  const field = `apiSessions[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) corrupt(`${field} is malformed`);
  if (Object.keys(entry).some(key => !ENTRY_FIELDS.includes(key))) corrupt(`${field} has unknown fields`);
  if (typeof entry.session !== 'string' || !ALIAS_RE.test(entry.session)) corrupt(`${field}.session is invalid`);
  if (typeof entry.sessionId !== 'string' || !UUID_RE.test(entry.sessionId)) corrupt(`${field}.sessionId is not a UUID`);
  checkBaseUrl(entry.apiBaseUrl, `${field}.apiBaseUrl`);
  if (typeof entry.model !== 'string' || !MODEL_RE.test(entry.model)) corrupt(`${field}.model is malformed`);
  if (entry.modelSelection !== undefined && entry.modelSelection !== 'explicit') corrupt(`${field}.modelSelection is malformed`);
  if (entry.protocol !== undefined && !API_PROTOCOLS.includes(entry.protocol)) corrupt(`${field}.protocol is malformed`);
  if (entry.credentialBinding !== undefined) {
    const binding = entry.credentialBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).some(key => !['algorithm', 'salt', 'verifier'].includes(key))
      || binding.algorithm !== 'scrypt-v1' || !/^[0-9a-f]{32}$/.test(binding.salt ?? '')
      || !SHA256_RE.test(binding.verifier ?? '')) corrupt(`${field}.credentialBinding is malformed`);
  }
  if (entry.title !== null && (typeof entry.title !== 'string' || [...entry.title].length > 200)) corrupt(`${field}.title is malformed`);
  checkIso(entry.createdAt, `${field}.createdAt`);
  checkIso(entry.updatedAt, `${field}.updatedAt`);
  if (entry.lastAssistantMessageId !== null
    && (typeof entry.lastAssistantMessageId !== 'string' || !ID_RE.test(entry.lastAssistantMessageId))) {
    corrupt(`${field}.lastAssistantMessageId is malformed`);
  }
  checkUsage(entry.lastUsage ?? null, `${field}.lastUsage`);
  if (!Array.isArray(entry.messages) || entry.messages.length > MAX_API_MESSAGES || entry.messages.length % 2 !== 0) {
    corrupt(`${field}.messages must be a bounded, completed turn history`);
  }
  let bytes = 0;
  entry.messages.forEach((message, i) => {
    const name = `${field}.messages[${i}]`;
    if (!message || typeof message !== 'object' || Array.isArray(message)) corrupt(`${name} is malformed`);
    if (Object.keys(message).some(key => !['role', 'content', 'stopReason', 'complete'].includes(key))) corrupt(`${name} has unknown fields`);
    if (message.role !== (i % 2 ? 'assistant' : 'user')) corrupt(`${name}.role breaks the user/assistant order`);
    const hasStatus = Object.hasOwn(message, 'stopReason') || Object.hasOwn(message, 'complete');
    if (hasStatus && (message.role !== 'assistant' || completionForStopReason(message.stopReason) === null
      || message.complete !== completionForStopReason(message.stopReason))) corrupt(`${name} has an invalid completion status`);
    if (typeof message.content !== 'string' || message.content.trim() === '') corrupt(`${name}.content is empty`);
    const size = Buffer.byteLength(message.content, 'utf8');
    if (size > (message.role === 'user' ? MAX_API_PROMPT_BYTES : MAX_API_REPLY_BYTES)) corrupt(`${name}.content exceeds the per-message limit`);
    bytes += size;
  });
  if (bytes > MAX_API_HISTORY_BYTES) corrupt(`${field}.messages exceeds the history limit`);
  if (entry.messages.length === 0 && entry.lastAssistantMessageId !== null) corrupt(`${field} claims an answer without history`);
  checkPending(entry.pending, `${field}.pending`, entry.messages.length);
}

export function validateApiState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) corrupt('root is not an object');
  if (Object.keys(data).some(key => !['version', 'apiSessions'].includes(key))) corrupt('root has unknown fields');
  if (data.version !== 1) corrupt('unsupported version');
  if (!Array.isArray(data.apiSessions) || data.apiSessions.length > MAX_API_SESSIONS) corrupt('apiSessions is not a bounded array');
  const seen = new Set();
  data.apiSessions.forEach((entry, index) => {
    checkEntry(entry, index);
    if (seen.has(entry.session)) corrupt(`duplicate session alias ${entry.session}`);
    seen.add(entry.session);
  });
  return data;
}

export function emptyApiState() {
  return { version: 1, apiSessions: [] };
}

export function assertApiCapacity(state, prompt) {
  const size = Buffer.byteLength(`${JSON.stringify(state)}\n`);
  const userMessage = Buffer.byteLength(JSON.stringify({ role: 'user', content: prompt }));
  if (size + userMessage + RESPONSE_RESERVE_BYTES > MAX_API_FILE_BYTES) {
    throw new BridgeError('API_STATE_CAPACITY', 'Private API history has insufficient reserved capacity; no request was sent');
  }
}

export class ApiStore {
  constructor(stateDir, { io = fs } = {}) {
    this.stateDir = stateDir;
    this.io = io;
    this.file = join(stateDir, 'api-sessions.json');
    this.lock = new StateLock(stateDir, { file: 'api.lock', recoveryFile: 'api-recovery.lock', io });
  }

  async #checkFile() {
    try {
      const dirStat = await this.io.lstat(this.stateDir);
      if (dirStat.isSymbolicLink()) unsafe('State directory is a symlink');
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.code !== 'ENOENT') throw error;
      return null;
    }
    try {
      const st = await this.io.lstat(this.file);
      if (st.isSymbolicLink() || !st.isFile()) unsafe('api-sessions.json must be a regular file');
      if ((st.mode & 0o077) !== 0) unsafe('api-sessions.json is readable by other users; fix its permissions instead of relaxing the check');
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) unsafe('api-sessions.json is owned by another user');
      if (st.size > MAX_API_FILE_BYTES) throw new BridgeError('API_STATE_TOO_LARGE', 'Private API history exceeds the read limit; preserve a backup for inspection');
      return st;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.code === 'ENOENT') return null;
      throw new BridgeError('API_STATE_IO', 'Cannot inspect the private API history file');
    }
  }

  async load() {
    if (!(await this.#checkFile())) return emptyApiState();
    let text;
    try {
      text = await this.io.readFile(this.file, 'utf8');
    } catch {
      throw new BridgeError('API_STATE_IO', 'Cannot read the private API history file');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      corrupt('not valid JSON');
    }
    return validateApiState(data);
  }

  async save(state) {
    validateApiState(state);
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized) > MAX_API_FILE_BYTES) {
      throw new BridgeError('API_STATE_CAPACITY', 'Private API history exceeds the write limit; the existing file was preserved');
    }
    await ensureStateDir(this.stateDir, this.io);
    // an existing file must still be private, owned and unlinked before it is replaced
    await this.#checkFile();
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await this.io.open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(serialized);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.io.rename(tmp, this.file);
    } catch (error) {
      await this.io.unlink(tmp).catch(() => {});
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('API_STATE_IO', 'Cannot write the private API history file');
    }
  }

  async withLock(fn, options) {
    return this.lock.withLock(fn, options);
  }

  async unlockDeadOwner() {
    return this.lock.unlockDeadOwner();
  }
}
