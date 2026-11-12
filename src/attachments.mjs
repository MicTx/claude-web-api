import { promises as fs, constants } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BridgeError } from './core/errors.mjs';

export const MAX_ATTACHMENTS = 5;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.json', '.md', '.txt', '.css', '.html', '.sql', '.toml', '.yaml', '.yml', '.sh', '.rb']);
const ARCHIVES = new Set(['.zip', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst', '.bundle']);
const MIME = { '.png': 'image/png', '.pdf': 'application/pdf', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css' };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function attachmentIdentity(file) {
  const { name, kind, mimeType, size, sha256 } = file;
  return { name, kind, mimeType, size, sha256, fileId: null };
}

export function matchesAttachments(message, manifest) {
  const files = message.files ?? [];
  const texts = message.attachments ?? [];
  if (!Array.isArray(files) || !Array.isArray(texts) || files.length + texts.length !== manifest.length) return false;
  const binary = manifest.filter(f => f.kind !== 'text');
  const plain = manifest.filter(f => f.kind === 'text');
  if (files.length !== binary.length || texts.length !== plain.length) return false;
  return binary.every(expected => expected.fileId && files.filter(file => file?.file_uuid === expected.fileId
    && file.file_name === expected.name && file.size_bytes === expected.size && file.file_kind === expected.kind).length === 1)
    && plain.every(expected => texts.filter(file => file?.file_name === expected.name && file.file_size === expected.size
      && file.file_type === expected.mimeType && typeof file.extracted_content === 'string'
      && Buffer.byteLength(file.extracted_content) === expected.size && digest(file.extracted_content) === expected.sha256).length === 1);
}

// Rebuild the attachment manifest of a restored native draft from the identifiers
// the page already holds. Nothing is uploaded: identities must match the original
// selection exactly, including the text digest, before the draft may be submitted.
export function resolveAdoptedAttachments(manifest, draft, { expectedEditorText = '' } = {}) {
  const fail = (code, message, details = {}) => { throw new BridgeError(code, message, details); };
  if (!Array.isArray(manifest) || manifest.length === 0) fail('INVALID_ARGUMENT', 'The saved send has no attachment manifest');
  if (!draft || !Array.isArray(draft.entries)) fail('UI_DRAFT_UNAVAILABLE', 'The restored draft could not be read');
  if (typeof draft.editorText === 'string' && draft.editorText.trim() !== ''
    && draft.editorText !== expectedEditorText && draft.editorText !== expectedEditorText.replaceAll('\n', '\n\n')) {
    fail('UI_DRAFT_CONFLICT', 'The conversation holds draft text that is not ours');
  }
  const resolved = [];
  const seen = new Set();
  for (const expected of manifest) {
    const matches = draft.entries.filter(entry => entry && entry.name === expected.name);
    // a whole missing draft row is UI_DRAFT_UNAVAILABLE, which the caller waits out; one entry
    // absent from a row that exists is an operator conflict, not a persistence state
    if (matches.length !== 1) fail('UI_DRAFT_CONFLICT', `Restored draft does not hold exactly one ${expected.name}`, { name: expected.name });
    const entry = matches[0];
    if (seen.has(expected.name)) fail('UI_DRAFT_CONFLICT', 'Duplicate attachment name in the manifest');
    seen.add(expected.name);
    // IndexedDB stores the attachment as a `blob` placeholder until the server receipt is
    // persisted. Checked before size and kind so a placeholder that has not finished
    // writing is waitable instead of looking like an operator conflict.
    if (entry.kind === 'blob' && expected.kind !== 'text') {
      fail('FILE_NOT_READY', `Restored ${expected.name} is not persisted yet`, { name: expected.name, kind: entry.kind });
    }
    if (entry.size !== expected.size) {
      fail('UI_DRAFT_CONFLICT', `Restored ${expected.name} has a different size`, { name: expected.name, size: entry.size, expected: expected.size });
    }
    if (expected.kind === 'text') {
      if (typeof entry.content !== 'string') fail('UI_DRAFT_CONFLICT', `Restored ${expected.name} has no stored text`, { name: expected.name });
      const bytes = Buffer.from(entry.content, 'utf8');
      if (bytes.length !== expected.size || digest(bytes.toString('utf8')) !== expected.sha256) {
        fail('UI_DRAFT_CONFLICT', `Restored ${expected.name} content does not match the original file`, { name: expected.name });
      }
      if (typeof entry.mimeType === 'string' && entry.mimeType !== expected.mimeType) {
        fail('UI_DRAFT_CONFLICT', `Restored ${expected.name} has a different type`, { name: expected.name, mimeType: entry.mimeType });
      }
      resolved.push({ ...expected, fileId: null });
      continue;
    }
    // Only a settled kind can be called a conflict; `blob` was handled above.
    if (entry.kind !== expected.kind) fail('UI_DRAFT_CONFLICT', `Restored ${expected.name} has a different kind`, { name: expected.name, kind: entry.kind });
    if (typeof entry.fileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.fileId)) {
      fail('FILE_NOT_READY', `Restored ${expected.name} has no usable uploaded identity`, { name: expected.name });
    }
    if (typeof expected.fileId !== 'string') {
      fail('FILE_NOT_READY', `The original uploaded identity of ${expected.name} is unknown`, { name: expected.name });
    }
    if (entry.fileId.toLowerCase() !== expected.fileId.toLowerCase()) {
      fail('UI_DRAFT_CONFLICT', `Restored ${expected.name} has a different uploaded identity`, { name: expected.name });
    }
    resolved.push({ ...expected, fileId: entry.fileId });
  }
  const unexpected = draft.entries.filter(entry => entry && !seen.has(entry.name)).map(entry => entry.name);
  if (unexpected.length) {
    fail('UI_DRAFT_CONFLICT', 'The restored draft holds attachments outside the original selection', { unexpected: unexpected.slice(0, 8) });
  }
  return resolved;
}

export function checkAbort(signal) {
  if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
}

export function safeFileName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || Buffer.byteLength(name) > 180
    || /[/\\:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new BridgeError('FILE_UNSAFE', 'Unsafe file name');
  }
  return name;
}

export function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function rejectPdfAttachments(paths) {
  if (Array.isArray(paths) && paths.some(path => typeof path === 'string' && extname(path).toLowerCase() === '.pdf')) {
    throw new BridgeError('FILE_TYPE', 'PDF attachments are not supported; only PNG and UTF-8 .js files can be uploaded');
  }
}

function kindOf(name) {
  const ext = extname(name).toLowerCase();
  if (ARCHIVES.has(ext)) throw new BridgeError('ARCHIVE_NOT_ALLOWED', 'Archives and repository bundles cannot be uploaded');
  if (ext === '.png') return 'image';
  rejectPdfAttachments([name]);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  throw new BridgeError('FILE_TYPE', 'Unsupported attachment format');
}

function validateBytes(bytes, kind) {
  if (kind === 'image') {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0
      || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_777_216) {
      throw new BridgeError('FILE_TYPE', 'Invalid or oversized PNG image dimensions');
    }
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      offset += size + 12;
      if (offset > bytes.length) break;
      if (type === 'IEND' && size === 0 && offset === bytes.length) return;
    }
    throw new BridgeError('FILE_TYPE', 'Incomplete PNG or unexpected trailing data');
  }
  if (kind === 'document') {
    if (!/^%PDF-[12]\.\d/.test(bytes.toString('ascii', 0, 8))
      || !bytes.subarray(-1024).toString('latin1').trimEnd().endsWith('%%EOF')) {
      throw new BridgeError('FILE_TYPE', 'Expected a complete PDF document');
    }
    return;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new BridgeError('FILE_TYPE', 'Code and text attachments must be UTF-8'); }
  if (!Buffer.from(text).equals(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) {
    throw new BridgeError('FILE_TYPE', 'Binary, BOM-prefixed or control-character text is not supported');
  }
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function checkedPath(io, root, path) {
  let current = root;
  for (const part of ['', ...relative(root, path).split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const st = await io.lstat(current, { bigint: true });
    if (st.isSymbolicLink() || (current !== path && !st.isDirectory())) {
      throw new BridgeError('FILE_UNSAFE', 'Attachment path contains a link or non-directory parent');
    }
    if (current === path) return st;
  }
}

export async function prepareAttachments(paths, config, { signal, io = fs } = {}) {
  checkAbort(signal);
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > MAX_ATTACHMENTS
    || paths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 4096)) {
    throw new BridgeError('INVALID_ARGUMENT', 'attachments must be a bounded list of absolute individual file paths');
  }
  if (paths.length === 0) return [];
  paths = [...paths];
  if (typeof config.attachmentRoot !== 'string' || !isAbsolute(config.attachmentRoot)) {
    throw new BridgeError('ATTACHMENT_SCOPE', 'Uploads require an operator-configured CCW_ATTACHMENT_ROOT');
  }
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) {
    throw new BridgeError('FILE_UNSAFE', 'Secure attachment opening is unavailable on this platform');
  }
  try {
    const declared = resolve(config.attachmentRoot);
    const root = config.attachmentRootReal ?? await io.realpath(declared);
    const names = new Set();
    const candidates = [];
    let total = 0;
    for (const raw of paths) {
      checkAbort(signal);
      const path = resolve(raw);
      const base = inside(declared, path) ? declared : inside(root, path) ? root : null;
      if (!base || raw.split(/[/\\]/).includes('..')) throw new BridgeError('ATTACHMENT_SCOPE', 'Attachment escapes the authorized root');
      const rel = relative(base, path);
      if (!rel || rel.split(sep).includes('.git')) throw new BridgeError('FILE_UNSAFE', 'Directories and repository metadata cannot be uploaded');
      const physical = join(root, rel);
      const name = safeFileName(basename(physical));
      if (names.has(name)) throw new BridgeError('INVALID_ARGUMENT', 'Duplicate attachment name or selection');
      names.add(name);
      const kind = kindOf(name);
      const st = await checkedPath(io, root, physical);
      if (!st.isFile() || st.nlink !== 1n) throw new BridgeError('FILE_UNSAFE', 'Only regular, non-linked individual files are allowed');
      const limit = kind === 'text' ? MAX_TEXT_BYTES : MAX_FILE_BYTES;
      total += Number(st.size);
      if (st.size <= 0n || st.size > BigInt(limit) || total > MAX_TOTAL_BYTES) {
        throw new BridgeError('FILE_TOO_LARGE', 'Attachment size or aggregate size is outside the permitted limits');
      }
      candidates.push({ physical, name, kind, st, limit });
    }
    const prepared = [];
    for (const { physical, name, kind, st, limit } of candidates) {
      checkAbort(signal);
      const file = await io.open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !sameFile(st, opened)
          || await io.realpath(physical) !== physical) {
          throw new BridgeError('FILE_CHANGED', 'Attachment identity changed before reading');
        }
        const chunks = [];
        let length = 0;
        for (;;) {
          checkAbort(signal);
          const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
          const { bytesRead } = await file.read(chunk, 0, chunk.length, length);
          if (!bytesRead) break;
          chunks.push(chunk.subarray(0, bytesRead));
          length += bytesRead;
          if (length > limit) throw new BridgeError('FILE_TOO_LARGE', 'Attachment grew beyond its limit');
        }
        if (!sameFile(st, await file.stat({ bigint: true }))
          || !sameFile(st, await io.lstat(physical, { bigint: true }))
          || await io.realpath(physical) !== physical) {
          throw new BridgeError('FILE_CHANGED', 'Attachment changed during reading');
        }
        const bytes = Buffer.concat(chunks);
        if (kind === 'text' && /^\s*%PDF-\d\.\d/.test(bytes.subarray(0, 1024).toString('latin1'))) {
          throw new BridgeError('FILE_TYPE', 'PDF attachments are not supported');
        }
        validateBytes(bytes, kind);
        prepared.push({ name, kind, mimeType: MIME[extname(name).toLowerCase()] ?? 'text/plain', size: bytes.length, sha256: digest(bytes), bytes });
      } finally {
        await file.close();
      }
    }
    checkAbort(signal);
    return prepared;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('FILE_IO', 'Could not securely read the selected attachment', { cause: error.code ?? null });
  }
}

export function validateDestination(destination) {
  if (destination === undefined) return;
  if (typeof destination !== 'string' || !destination || destination.length > 1024 || isAbsolute(destination)) {
    throw new BridgeError('INVALID_ARGUMENT', 'destination must be a relative file name inside the configured download root');
  }
  destination.split('/').forEach(safeFileName);
}

export function verifiedAttachments(files) {
  rejectPdfAttachments(files.map(file => file.name));
  if (files.some(file => {
    const ext = extname(file.name).toLowerCase();
    return !(ext === '.png' && file.kind === 'image' && file.mimeType === 'image/png')
      && !(ext === '.js' && file.kind === 'text' && file.mimeType === 'text/javascript');
  })) {
    throw new BridgeError('FILE_TYPE', 'Only PNG and UTF-8 .js attachment transports are supported');
  }
  return files;
}

export function validateDownload(bytes, name, sourceMimeType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new BridgeError('FILE_CONTENT', 'Empty or oversized file response');
  }
  if ((sourceMimeType !== '' && !/^[a-z0-9.+-]+\/[a-z0-9.+-]{1,100}$/i.test(sourceMimeType))
    || ['text/html', 'application/xhtml+xml', 'text/event-stream'].includes(sourceMimeType)) {
    throw new BridgeError('FILE_CONTENT', 'Response type is not a downloadable file');
  }
  const prefix = bytes.subarray(0, 4096).toString('utf8').trimStart();
  if (/^(<!doctype\s+html|<html\b)/i.test(prefix)) throw new BridgeError('FILE_CONTENT', 'Refusing an HTML page instead of a verified file');
  if (prefix.startsWith('{')) {
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); } catch {}
    if (data && (Object.hasOwn(data, 'error') || data.success === false)) throw new BridgeError('FILE_CONTENT', 'Refusing a JSON error envelope');
  }
  const ext = extname(name).toLowerCase();
  let mimeType = sourceMimeType;
  if (ext === '.png' || ext === '.pdf') {
    validateBytes(bytes, ext === '.png' ? 'image' : 'document');
    mimeType = MIME[ext];
  } else if (TEXT_EXTENSIONS.has(ext) || ext === '.svg') {
    validateBytes(bytes, 'text');
    if (ext === '.svg' && !/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) throw new BridgeError('FILE_CONTENT', 'Expected an SVG file');
    mimeType = ext === '.svg' ? 'image/svg+xml' : ext === '.md' ? 'text/markdown' : MIME[ext] ?? 'text/plain';
  } else if (sourceMimeType === '') {
    throw new BridgeError('FILE_CONTENT', 'A file without a response MIME type requires a verified format');
  }
  const allowed = new Set(['application/octet-stream', mimeType]);
  if (mimeType.startsWith('text/') || mimeType === 'image/svg+xml') allowed.add('text/plain');
  if (mimeType === 'text/javascript') allowed.add('application/javascript');
  if (sourceMimeType !== '' && !allowed.has(sourceMimeType)) throw new BridgeError('FILE_CONTENT', 'Response type does not match the public file descriptor');
  return { mimeType, sourceMimeType: sourceMimeType || null, size: bytes.length, sha256: digest(bytes) };
}

// Frame originals come from verified conversation history, not a network body, and are HTML by definition.
export function validateFrameOriginal(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new BridgeError('FILE_CONTENT', 'Empty or oversized Frame original');
  }
  validateBytes(bytes, 'text');
  if (!/^\s*(<!doctype\s+html|<html\b)/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
    throw new BridgeError('FILE_CONTENT', 'Frame original is not an HTML document');
  }
  return { mimeType: 'text/html', sourceMimeType: null, size: bytes.length, sha256: digest(bytes) };
}

async function downloadWriter() {
  let aborted = false;
  let wake;
  const abort = () => { aborted = true; process.stdin.destroy(); wake?.(null); };
  process.on('SIGTERM', abort);
  process.on('disconnect', abort);
  const receive = () => new Promise(resolve => { wake = resolve; process.once('message', resolve); });
  const header = await receive();
  const { promises: io, constants: c } = await import('node:fs');
  const { createHash, randomUUID } = await import('node:crypto');
  const { join } = await import('node:path');
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const check = () => { if (aborted) fail('ABORTED'); };
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const safe = name => typeof name === 'string' && !!name && !name.startsWith('.') && Buffer.byteLength(name) <= 180
    && !/[/\\:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name);
  const directory = st => {
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== BigInt(process.getuid()) || (st.mode & 0o022n)) fail('FILE_UNSAFE');
  };
  let handle, temporary, owned, published = false, result;
  let physical, current;
  const parentMatches = async () => {
    check();
    const actual = await io.lstat(physical, { bigint: true });
    directory(actual);
    if (!same(actual, current) || await io.realpath(physical) !== physical) fail('FILE_CHANGED');
  };
  try {
    check();
    if (!header || !Number.isInteger(c.O_NOFOLLOW) || typeof process.getuid !== 'function'
      || !safe(header.name) || !Array.isArray(header.dirs) || !header.dirs.every(safe)
      || !Number.isSafeInteger(header.maxBytes) || header.maxBytes <= 0 || header.maxBytes > 2 * 1024 * 1024) fail('FILE_UNSAFE');
    current = await io.lstat('.', { bigint: true });
    directory(current);
    if (String(current.dev) !== header.dev || String(current.ino) !== header.ino) fail('FILE_CHANGED');
    physical = header.root;
    await parentMatches();
    for (const [index, part] of header.dirs.entries()) {
      if (index === 0 && header.createDefault && part === 'downloads') {
        await io.mkdir(part, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      const next = await io.lstat(part, { bigint: true });
      directory(next);
      process.chdir(part);
      current = await io.lstat('.', { bigint: true });
      if (!same(next, current)) fail('FILE_CHANGED');
      physical = join(physical, part);
      await parentMatches();
    }
    const existing = await io.lstat(header.name).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) fail('FILE_EXISTS');
    temporary = `.ccw-${randomUUID()}.part`;
    handle = await io.open(temporary, c.O_RDWR | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    owned = await handle.stat({ bigint: true });
    const expected = receive();
    process.send({ ready: true });
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of process.stdin) {
      await parentMatches();
      size += chunk.length;
      if (size > header.maxBytes) fail('PAYLOAD_TOO_LARGE');
      let offset = 0;
      while (offset < chunk.length) {
        check();
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) fail('FILE_IO');
        offset += bytesWritten;
      }
      hash.update(chunk);
    }
    const proof = await expected;
    check();
    const sha256 = hash.digest('hex');
    if (!proof || size !== proof.size || sha256 !== proof.sha256 || !size) fail('FILE_INCOMPLETE');
    await handle.sync();
    const final = await handle.stat({ bigint: true });
    if (!same(final, owned) || final.size !== BigInt(size) || final.nlink !== 1n || (final.mode & 0o777n) !== 0o600n) fail('FILE_CHANGED');
    const verify = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < size;) {
      check();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) fail('FILE_CHANGED');
      verify.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (verify.digest('hex') !== sha256) fail('FILE_CHANGED');
    await parentMatches();
    if (!same(await io.lstat(temporary, { bigint: true }), owned)) fail('FILE_CHANGED');
    await io.link(temporary, header.name);
    published = true;
    await parentMatches();
    if (!same(await io.lstat(header.name, { bigint: true }), owned)) fail('FILE_CHANGED');
    result = { ok: true, size, sha256 };
  } catch (error) {
    const code = error.code === 'EEXIST' ? 'FILE_EXISTS' : ['ABORTED', 'FILE_UNSAFE', 'FILE_CHANGED', 'FILE_EXISTS', 'FILE_INCOMPLETE', 'PAYLOAD_TOO_LARGE'].includes(error.code) ? error.code : 'FILE_IO';
    result = { ok: false, code };
  } finally {
    let cleanupPending = Boolean(temporary && handle && !owned);
    if (temporary && owned) {
      try {
        const remaining = await io.lstat(temporary, { bigint: true }).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (remaining && same(remaining, owned) && remaining.isFile()) await io.unlink(temporary);
        else if (remaining) cleanupPending = true;
      } catch { cleanupPending = true; }
    }
    await handle?.close().catch(() => { cleanupPending = true; });
    if (process.connected) {
      await new Promise(resolve => process.send({ ...result, published, cleanupPending, temporary: cleanupPending ? temporary : undefined }, () => resolve()));
      process.disconnect();
    }
  }
}

export async function prepareDownload(config, destination, { signal } = {}) {
  validateDestination(destination);
  checkAbort(signal);
  let root, st;
  try {
    root = config.downloadRootReal ?? await fs.realpath(config.downloadRoot ?? config.stateDir);
    st = await fs.lstat(root, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(root) !== root) throw new BridgeError('FILE_UNSAFE', 'Download root changed');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('FILE_IO', 'Could not open the authorized download root');
  }
  const parts = destination.split('/');
  const name = parts.pop();
  const dirs = [...(config.downloadRoot ? [] : ['downloads']), ...parts];
  const path = join(root, ...dirs, name);
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `(${downloadWriter.toString()})()`], {
    cwd: root, env: {}, stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
  });
  let received, closed = false, forceTimer, startupError;
  const cleanupDetails = () => ({
    path, published: received?.published === true, cleanupPending: received?.cleanupPending === true,
    ...(received?.cleanupPending && received.temporary ? { cleanupPath: join(root, ...dirs, received.temporary) } : {}),
  });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const stop = () => {
    if (closed) return;
    child.kill('SIGTERM');
    forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  const exited = new Promise(resolve => child.once('close', () => {
    closed = true;
    clearTimeout(forceTimer);
    readyReject(new BridgeError(signal?.aborted ? 'ABORTED' : received?.code ?? 'FILE_IO', 'Could not prepare the download destination', cleanupDetails()));
    resolve();
  }));
  child.on('error', () => { startupError = new BridgeError('FILE_IO', 'Could not start the secure download writer'); stop(); });
  child.stdin.on('error', () => {});
  child.on('message', message => {
    if (message?.ready === true) readyResolve();
    else received = message;
  });
  signal?.addEventListener('abort', stop, { once: true });
  child.send({ root, dirs, name, createDefault: !config.downloadRoot, maxBytes: MAX_DOWNLOAD_BYTES, dev: String(st.dev), ino: String(st.ino) }, error => { if (error) stop(); });
  if (signal?.aborted) stop();
  const timer = setTimeout(() => { startupError = new BridgeError('FILE_IO', 'Download writer readiness timeout'); stop(); }, config.readyTimeoutMs);
  const dispose = async () => {
    clearTimeout(timer);
    stop();
    await exited;
    signal?.removeEventListener('abort', stop);
    return cleanupDetails();
  };
  try {
    await ready;
    clearTimeout(timer);
    if (startupError) throw startupError;
    checkAbort(signal);
  } catch (error) {
    await dispose();
    throw startupError ?? error;
  }
  return {
    path,
    async finish(bytes, proof) {
      checkAbort(signal);
      child.send({ size: proof.size, sha256: proof.sha256 }, error => { if (error) stop(); });
      child.stdin.end(bytes);
      await exited;
      const details = cleanupDetails();
      if (signal?.aborted) throw new BridgeError('ABORTED', 'Download interrupted', details);
      if (!received?.ok) throw new BridgeError(received?.code ?? 'FILE_IO', 'Could not securely publish the downloaded file', details);
      return details;
    },
    dispose,
  };
}
