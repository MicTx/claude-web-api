import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './core/errors.mjs';
import { MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_TEXT_BYTES, MAX_TOTAL_BYTES, safeFileName } from './attachments.mjs';

export const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

function corrupt(message) {
  throw new BridgeError('STATE_CORRUPT', `State file is corrupt: ${message}`);
}

function checkUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) corrupt(`${field} is not a UUID`);
}

function checkIso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) corrupt(`${field} is not a timestamp`);
}

function validatePending(pending, field, version) {
  if (pending === null) return;
  if (typeof pending !== 'object' || Array.isArray(pending)) corrupt(`${field} is malformed`);
  if (!['create', 'send', 'upload'].includes(pending.kind)) corrupt(`${field}.kind is unknown`);
  checkIso(pending.startedAt, `${field}.startedAt`);
  if (pending.kind === 'send' || pending.kind === 'upload') {
    checkUuid(pending.parentMessageId, `${field}.parentMessageId`);
    if (typeof pending.promptSha256 !== 'string' || !SHA256_RE.test(pending.promptSha256)) {
      corrupt(`${field}.promptSha256 is malformed`);
    }
  }
  if (pending.transport !== undefined || pending.attachments !== undefined || pending.kind === 'upload') {
    if (version !== 2 || pending.transport !== 'native' || !['upload', 'send'].includes(pending.kind)) corrupt(`${field} requires native state version 2`);
    if (Object.keys(pending).some(key => !['kind', 'transport', 'parentMessageId', 'promptSha256', 'startedAt', 'attachments'].includes(key))) corrupt(`${field} contains unexpected native fields`);
    if (!Array.isArray(pending.attachments) || pending.attachments.length > MAX_ATTACHMENTS) corrupt(`${field}.attachments is malformed`);
    const names = new Set();
    let total = 0;
    for (const file of pending.attachments) {
      if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).some(key => !['name', 'kind', 'mimeType', 'size', 'sha256', 'fileId'].includes(key))) corrupt(`${field} has malformed attachment identity`);
      try { safeFileName(file.name); } catch { corrupt(`${field} has unsafe attachment name`); }
      if (names.has(file.name) || !['image', 'document', 'text'].includes(file.kind)) corrupt(`${field} has duplicate or unknown attachment`);
      names.add(file.name);
      const limit = file.kind === 'text' ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > limit
        || typeof file.sha256 !== 'string' || !SHA256_RE.test(file.sha256)
        || typeof file.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]{1,80}$/i.test(file.mimeType)) corrupt(`${field} has invalid attachment metadata`);
      total += file.size;
      if (file.fileId !== null) checkUuid(file.fileId, `${field}.fileId`);
      if (file.kind === 'text' && file.fileId !== null) corrupt(`${field} text attachment must use a content digest`);
      if (pending.kind === 'send' && file.kind !== 'text' && file.fileId === null) corrupt(`${field} cannot send unidentified files`);
    }
    if (total > MAX_TOTAL_BYTES) corrupt(`${field} attachments exceed the aggregate limit`);
  }
}

function validateEntry(entry, index, version) {
  const field = `sessions[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) corrupt(`${field} is malformed`);
  if (typeof entry.session !== 'string' || !ALIAS_RE.test(entry.session)) corrupt(`${field}.session is invalid`);
  checkUuid(entry.orgId, `${field}.orgId`);
  checkUuid(entry.conversationId, `${field}.conversationId`);
  checkUuid(entry.parentMessageId, `${field}.parentMessageId`);
  if (entry.model !== null && typeof entry.model !== 'string') corrupt(`${field}.model is malformed`);
  checkIso(entry.createdAt, `${field}.createdAt`);
  checkIso(entry.updatedAt, `${field}.updatedAt`);
  if (entry.pending === undefined) corrupt(`${field}.pending is missing`);
  validatePending(entry.pending, `${field}.pending`, version);
}

export function validateState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) corrupt('root is not an object');
  if (data.version !== 1 && data.version !== 2) corrupt('unsupported version');
  if (typeof data.lastSubmissionAt !== 'number' || !Number.isFinite(data.lastSubmissionAt) || data.lastSubmissionAt < 0) {
    corrupt('lastSubmissionAt is malformed');
  }
  if (!Array.isArray(data.sessions)) corrupt('sessions is not an array');
  const seen = new Set();
  data.sessions.forEach((entry, index) => {
    validateEntry(entry, index, data.version);
    if (seen.has(entry.session)) corrupt(`duplicate session alias ${entry.session}`);
    seen.add(entry.session);
  });
  return data;
}

export function emptyState() {
  return { version: 1, lastSubmissionAt: 0, sessions: [] };
}

export function assertPrivateStateFile(stat, name, errorCode) {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new BridgeError(errorCode, `${name} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new BridgeError(errorCode, `${name} must not grant permissions to group or other users`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new BridgeError(errorCode, `${name} is owned by another user`);
  }
}

function validateLockContent(content) {
  if (!content || typeof content !== 'object'
    || !Number.isSafeInteger(content.pid) || content.pid <= 0
    || typeof content.hostname !== 'string' || content.hostname === ''
    || typeof content.token !== 'string' || content.token === '') {
    throw new BridgeError('LOCK_INVALID', 'Lock file is malformed or incomplete');
  }
  return content;
}

export async function ensureStateDir(stateDir, io = fs) {
  try {
    const st = await io.lstat(stateDir);
    if (st.isSymbolicLink()) {
      throw new BridgeError('STATE_UNSAFE', 'State directory is a symlink');
    }
    if (!st.isDirectory()) {
      throw new BridgeError('STATE_UNSAFE', 'State path is not a directory');
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error.code === 'ENOENT') {
      await io.mkdir(stateDir, { recursive: true, mode: 0o700 });
      return;
    }
    throw error;
  }
  try {
    await io.chmod(stateDir, 0o700);
  } catch {
    // best effort on filesystems that allow chmod
  }
}

// Cross-process exclusive lock shared by every state file in the state directory.
// A separate lock name keeps independent state files from blocking each other.
export class StateLock {
  #storage = new AsyncLocalStorage();
  #tail = Promise.resolve();

  constructor(stateDir, { file = 'ccw.lock', recoveryFile = 'ccw-recovery.lock', io = fs } = {}) {
    this.stateDir = stateDir;
    this.io = io;
    this.file = join(stateDir, file);
    this.recoveryFile = join(stateDir, recoveryFile);
  }

  async #acquireExclusive(path) {
    const st = await this.io.lstat(path).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
    if (st && st.isSymbolicLink()) {
      throw new BridgeError('STATE_UNSAFE', 'Lock path is a symlink');
    }
    let handle;
    try {
      handle = await this.io.open(path, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new BridgeError('BUSY', 'Another process holds the state lock');
      }
      throw error;
    }
    const token = randomUUID();
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token }));
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      // the file exists only because our wx create made it: always removable
      await this.io.unlink(path).catch(() => {});
      throw error;
    }
    await handle.close();
    return token;
  }

  async withLock(fn, { signal } = {}) {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    if (this.#storage.getStore()) {
      throw new BridgeError('BUSY', 'Nested state lock');
    }
    const run = this.#tail
      .catch(() => {})
      .then(() => this.#withLockNow(fn, { signal }));
    this.#tail = run.catch(() => {});
    return run;
  }

  async #withLockNow(fn, { signal }) {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    await ensureStateDir(this.stateDir, this.io);
    const token = await this.#acquireExclusive(this.file);
    try {
      return await this.#storage.run({}, fn);
    } finally {
      await this.#releaseIfOwner(this.file, token);
    }
  }


  async #releaseIfOwner(path, token) {
    try {
      const st = await this.io.lstat(path);
      if (st.isSymbolicLink()) return;
      const text = await this.io.readFile(path, 'utf8');
      const content = JSON.parse(text);
      if (content && content.token === token && content.pid === process.pid) {
        await this.io.unlink(path);
      }
    } catch {
      // lock already gone or replaced - do not remove someone else's lock
    }
  }

  async unlockDeadOwner() {
    await ensureStateDir(this.stateDir, this.io);
    const token = await this.#acquireExclusive(this.recoveryFile);
    try {
      let text;
      try {
        const st = await this.io.lstat(this.file);
        if (st.isSymbolicLink()) {
          throw new BridgeError('STATE_UNSAFE', 'Lock path is a symlink');
        }
        text = await this.io.readFile(this.file, 'utf8');
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      let content;
      try {
        content = validateLockContent(JSON.parse(text));
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('LOCK_INVALID', 'Lock file is malformed');
      }
      if (content.hostname !== hostname()) {
        throw new BridgeError('LOCK_FOREIGN', 'Lock is owned by a different host');
      }
      let alive = true;
      try {
        process.kill(content.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') alive = false;
        else if (error.code !== 'EPERM') throw error;
      }
      if (alive) {
        throw new BridgeError('LOCK_HELD', 'Lock owner process is still running', { pid: content.pid });
      }
      await this.io.unlink(this.file);
      return true;
    } finally {
      await this.#releaseIfOwner(this.recoveryFile, token);
    }
  }
}

export class SessionStore {
  constructor(stateDir, { io = fs } = {}) {
    this.stateDir = stateDir;
    this.io = io;
    this.file = join(stateDir, 'sessions.json');
    this.lock = new StateLock(stateDir, { io });
    this.lockFile = this.lock.file;
    this.recoveryLockFile = this.lock.recoveryFile;
  }

  async #ensureDir() {
    return ensureStateDir(this.stateDir, this.io);
  }

  async load() {
    let text;
    try {
      const dirStat = await this.io.lstat(this.stateDir);
      if (dirStat.isSymbolicLink()) {
        throw new BridgeError('STATE_UNSAFE', 'State directory is a symlink');
      }
      const st = await this.io.lstat(this.file);
      assertPrivateStateFile(st, 'sessions.json', 'STATE_UNSAFE');
      text = await this.io.readFile(this.file, 'utf8');
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.code === 'ENOENT') return emptyState();
      throw new BridgeError('STATE_IO', 'Cannot read state file');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      corrupt('not valid JSON');
    }
    return validateState(data);
  }

  async save(state) {
    validateState(state);
    await this.#ensureDir();
    try {
      const st = await this.io.lstat(this.file);
      assertPrivateStateFile(st, 'sessions.json', 'STATE_UNSAFE');
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await this.io.open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.io.rename(tmp, this.file);
    } catch (error) {
      // only ever remove our own exclusive temp file; original stays untouched
      await this.io.unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async withLock(fn, options) {
    return this.lock.withLock(fn, options);
  }

  async createSession(session, entry, { signal } = {}) {
    return this.withLock(async () => {
      const state = await this.load();
      if (state.sessions.some(item => item.session === session)) {
        throw new BridgeError('SESSION_EXISTS', `Session "${session}" already exists`);
      }
      const next = { ...entry, session };
      state.sessions.push(next);
      await this.save(state);
      return { state, entry: next };
    }, { signal });
  }

  async unlockDeadOwner() {
    return this.lock.unlockDeadOwner();
  }
}
