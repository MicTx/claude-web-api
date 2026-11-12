// Filesystem boundary for the standalone installer. No user/agent state is edited.
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, VERSION, RUNTIME_FILES, DOC_FILES, validateReleaseFiles, MAX_ARCHIVE } from './archive.mjs';

import { APP } from '../identity.mjs';

export { APP };
export const COMMANDS = ['ccw', 'ccw-mcp', 'ccw-hosts'];
export const RECONNECT_MARKER = 'reconnect-required';
export const fail = (code, message) => Object.assign(new Error(message), { code });
export async function stat(path) {
  try { return await fs.lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function checkDirectory(path, { create = false, rejectGit = true } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) === '/') throw fail('UNSAFE_PATH', 'An absolute non-root install directory is required');
  const chain = [];
  for (let p = resolve(path);; p = dirname(p)) { chain.push(p); if (dirname(p) === p) break; }
  for (const p of chain.reverse()) {
    const s = await stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) throw fail('UNSAFE_PATH', 'Install directories must not traverse links or non-directories');
    if (rejectGit && await stat(join(p, '.git'))) throw fail('SOURCE_TREE', 'A development worktree cannot be a consumption directory');
    if (!s && create) await fs.mkdir(p, { mode: 0o700 });
  }
  const final = await stat(resolve(path));
  if (final && ((final.mode & 0o022) !== 0 || (process.getuid && final.uid !== process.getuid()))) throw fail('UNSAFE_PATH', 'Install directory must be owned by the current user and not writable by others');
}

export async function regular(path, max = MAX_ARCHIVE) {
  const s = await stat(path);
  if (!s || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) throw fail('UNSAFE_PATH', 'Expected a bounded single-link regular file');
  const bytes = await fs.readFile(path);
  const after = await stat(path);
  if (!after || after.dev !== s.dev || after.ino !== s.ino || after.size !== s.size || after.mtimeMs !== s.mtimeMs || bytes.length > max) throw fail('CONCURRENT_CHANGE', 'File changed while reading');
  return { bytes, mode: s.mode & 0o777 };
}

// A reconnect marker is a small installer-owned regular file. Never follow a
// symlink or read an unbounded file; status reports its presence, not its data.
export async function reconnectPending(root) {
  const path = join(root, RECONNECT_MARKER);
  const before = await stat(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256) {
    throw fail('UNSAFE_PATH', 'Reconnect marker is not a bounded regular file');
  }
  const bytes = await fs.readFile(path);
  const after = await stat(path);
  if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length > 256) {
    throw fail('CONCURRENT_CHANGE', 'Reconnect marker changed while reading');
  }
  const version = bytes.toString('utf8').trim();
  return VERSION.test(version) ? version : true;
}

// The marker is outside the installer transaction only after a green direct
// probe. Remove just the identity checked above; never unlink a replacement.
export async function clearReconnectMarker(root) {
  const path = join(root, RECONNECT_MARKER);
  const before = await stat(path);
  if (!before) return false;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256) {
    throw fail('UNSAFE_PATH', 'Reconnect marker is not a bounded regular file');
  }
  const handle = await fs.open(path, 'r');
  try {
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw fail('CONCURRENT_CHANGE', 'Reconnect marker changed while reading');
    }
  } finally { await handle.close(); }
  const current = await stat(path);
  if (!current || !current.isFile() || current.isSymbolicLink()
    || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
    || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) {
    throw fail('CONCURRENT_CHANGE', 'Reconnect marker changed before removal');
  }
  await fs.unlink(path);
  return true;
}

export async function installedRelease(root, version, expected) {
  if (!VERSION.test(version) || !expected || !/^[a-f0-9]{64}$/.test(expected.manifestSha256)) throw fail('OWNERSHIP_CONFLICT', 'Release identity is not recorded');
  const dir = join(root, 'releases', `v${version}`);
  await checkDirectory(dir);
  const mf = await regular(join(dir, 'release.json'), 32768);
  if (sha256(mf.bytes) !== expected.manifestSha256) throw fail('MODIFIED_RELEASE', 'Installed release manifest changed');
  const manifest = JSON.parse(mf.bytes.toString('utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length > 63) throw fail('MODIFIED_RELEASE', 'Invalid installed manifest');
  const files = new Map([['release.json', mf]]);
  const allowed = [...RUNTIME_FILES, ...DOC_FILES];
  for (const item of manifest.files) {
    if (!item || !allowed.includes(item.path) || files.has(item.path)) throw fail('MODIFIED_RELEASE', 'Unexpected installed file');
    await checkDirectory(dirname(join(dir, item.path)));
    files.set(item.path, await regular(join(dir, item.path)));
  }
  const found = [];
  const walk = async (path, prefix = '') => {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (![...files.keys()].some(name => name.startsWith(rel + '/'))) throw fail('MODIFIED_RELEASE', 'Unknown directory in installed release');
        await walk(join(path, entry.name), rel + '/');
      } else {
        found.push(rel);
        if (found.length > files.size || !files.has(rel)) throw fail('MODIFIED_RELEASE', 'Unknown file in installed release');
      }
    }
  };
  await walk(dir);
  if (found.length !== files.size) throw fail('MODIFIED_RELEASE', 'Installed release is incomplete');
  try { validateReleaseFiles(files, version); }
  catch { throw fail('MODIFIED_RELEASE', 'Installed release content, modes or identity no longer match'); }
  return { dir, manifest, files };
}

export async function readState(root) {
  await checkDirectory(root);
  if (!await stat(root)) return null;
  const ownerPath = join(root, 'install.json');
  if (!await stat(ownerPath)) {
    if ((await fs.readdir(root)).length) throw fail('OWNERSHIP_CONFLICT', 'Nonempty runtime directory has no installer ownership record');
    return null;
  }
  const record = await regular(ownerPath, 32768);
  if (record.mode !== 0o600) throw fail('UNSAFE_PATH', 'Runtime ownership record must have mode 0600');
  const owner = JSON.parse(record.bytes.toString('utf8'));
  if (owner.schema !== 1 || owner.name !== APP || owner.root !== root || typeof owner.binDir !== 'string'
    || !owner.releases || typeof owner.releases !== 'object' || Array.isArray(owner.releases)
    || !owner.shims || COMMANDS.some(name => !/^[a-f0-9]{64}$/.test(owner.shims[name] ?? ''))) throw fail('OWNERSHIP_CONFLICT', 'Invalid runtime ownership record');
  await checkDirectory(owner.binDir);
  const links = {};
  for (const name of ['current', 'previous']) {
    const path = join(root, name);
    const s = await stat(path);
    if (!s) { links[name] = null; continue; }
    if (!s.isSymbolicLink()) throw fail('OWNERSHIP_CONFLICT', 'Runtime selectors must be installer-owned links');
    const target = await fs.readlink(path);
    if (!target.startsWith('releases/v') || !VERSION.test(target.slice(10))) throw fail('OWNERSHIP_CONFLICT', 'Runtime selector leaves its version directory');
    const version = target.slice(10);
    await installedRelease(root, version, owner.releases[version]);
    links[name] = version;
  }
  if (!links.current) throw fail('OWNERSHIP_CONFLICT', 'Installed runtime has no current release');
  for (const name of COMMANDS) {
    const file = await regular(join(owner.binDir, name), 16384);
    if (file.mode !== 0o755 || sha256(file.bytes) !== owner.shims[name]) throw fail('OWNERSHIP_CONFLICT', 'An installed command was modified');
  }
  return { owner, ...links };
}

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export function shims(root, nodePath) {
  const scripts = { ccw: 'bin/ccw.mjs', 'ccw-mcp': 'src/mcp-server.mjs', 'ccw-hosts': 'scripts/install-agents.mjs' };
  const launcher = nodePath === 'node' ? 'export CCW_NODE_COMMAND=node\n' : '';
  return Object.fromEntries(COMMANDS.map(name => [name, Buffer.from('#!/bin/sh\n'
    + launcher
    + (name === 'ccw-hosts' ? `export CCW_RUNTIME_ROOT=${quote(join(root, 'current'))}\n` : '')
    + `exec ${quote(nodePath)} ${quote(join(root, 'current', scripts[name]))} "$@"\n`)]));
}

async function image(path) {
  const s = await stat(path);
  if (!s) return { kind: 'absent' };
  if (s.isSymbolicLink()) return { kind: 'link', target: await fs.readlink(path) };
  const file = await regular(path, 65536);
  return { kind: 'file', mode: file.mode, base64: file.bytes.toString('base64') };
}
async function matches(path, expected) {
  const actual = await image(path);
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'absent') return true;
  if (actual.kind === 'link') return actual.target === expected.target;
  return actual.mode === expected.mode && actual.base64 === expected.base64;
}
async function publish(path, value) {
  if (value.kind === 'absent') { await fs.unlink(path); return; }
  const temp = join(dirname(path), `.ccw-${randomUUID()}`);
  let created = false;
  try {
    if (value.kind === 'link') { await fs.symlink(value.target, temp); created = true; }
    else {
      const handle = await fs.open(temp, 'wx', value.mode);
      created = true;
      try { await handle.writeFile(Buffer.from(value.base64, 'base64')); await handle.chmod(value.mode); await handle.sync(); }
      finally { await handle.close(); }
    }
    await fs.rename(temp, path);
    created = false;
  } finally {
    if (created) await fs.unlink(temp);
  }
}

// Durable pre/post images and checked compensation; never restore over another writer.
export async function transaction(root, changes) {
  const journalDir = join(root, 'backups', randomUUID());
  await checkDirectory(journalDir, { create: true });
  const records = [];
  for (const { path, after } of changes) records.push({ path, before: await image(path), after });
  const journal = await fs.open(join(journalDir, 'journal.json'), 'wx', 0o600);
  try { await journal.writeFile(JSON.stringify({ schema: 1, records }, null, 2)); await journal.sync(); }
  finally { await journal.close(); }
  await syncDirectory(journalDir);
  await syncDirectory(dirname(journalDir));
  await syncDirectory(root);
  const applied = [];
  try {
    for (const record of records) {
      if (!await matches(record.path, record.before)) throw fail('CONCURRENT_CHANGE', 'Target changed before publication');
      await publish(record.path, record.after);
      applied.push(record);
      await syncDirectory(dirname(record.path));
      if (!await matches(record.path, record.after)) throw fail('CONCURRENT_CHANGE', 'Target changed after publication');
    }
    const committed = await fs.open(join(journalDir, 'COMMITTED'), 'wx', 0o600);
    try { await committed.writeFile('ok\n'); await committed.sync(); } finally { await committed.close(); }
    await syncDirectory(journalDir);
  } catch (error) {
    let restored = true;
    for (const record of applied.reverse()) {
      try {
        if (!await matches(record.path, record.after)) { restored = false; continue; }
        await publish(record.path, record.before);
        await syncDirectory(dirname(record.path));
      } catch { restored = false; }
    }
    if (!restored) throw fail('RECOVERY_REQUIRED', `Publication failed; concurrent changes or I/O prevented rollback. Recovery journal: ${journalDir}`);
    throw error;
  }
  return journalDir;
}

export async function syncDirectory(path) {
  const handle = await fs.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export const fileImage = (bytes, mode = 0o600) => ({ kind: 'file', base64: bytes.toString('base64'), mode });
export const linkImage = version => ({ kind: 'link', target: `releases/v${version}` });
