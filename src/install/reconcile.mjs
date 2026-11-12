// Explicit, conservative recovery. Normal install/uninstall retain their
// existing ownership rules; recovery never adopts an external entry or follows
// links into a manager-owned config/skill tree.
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import {
  defaultIo, lstatSafe, sha256, ensureDirectory, acquireLock,
  writeFileAtomic, writeFileGuarded, removeFileGuarded,
} from './atomic.mjs';
import { readSourceFile, parseSourceJson, sourceServers } from './sources.mjs';
import { validateHostRecord } from './host-json.mjs';
import { validateTomlRecord, isBlockStart, isBlockEnd } from './toml-host.mjs';
import { InstallError } from './errors.mjs';

const fail = (code, message, details) => { throw new InstallError(code, message, details); };
const statePaths = target => [target.homeDir, dirname(target.configPath), dirname(target.recordPath), dirname(target.lockPath), target.skillsDir, target.skillDest].filter(Boolean);

// Reject *all* link components before writes, including links in ancestors.
// /var on macOS may be a link, so callers/tests use their physical user path;
// automatic path canonicalization would conceal the boundary being checked.
async function safePath(io, path, { directory = false } = {}) {
  const chain = [];
  for (let p = resolve(path);; p = dirname(p)) { chain.push(p); if (dirname(p) === p) break; }
  for (const p of chain.reverse()) {
    const st = await lstatSafe(io, p);
    if (!st) continue;
    if (st.isSymbolicLink() || ((p !== resolve(path) || directory) && !st.isDirectory())) fail('UNSAFE_PATH', 'Recovery paths must not traverse symlinks or non-directories');
  }
}

function orphanMarker(text, host) {
  if (host.format !== 'toml' || text === null) return null;
  const lines = [];
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset);
    const next = end < 0 ? text.length : end + 1;
    const raw = text.slice(offset, end < 0 ? text.length : end);
    lines.push({ start: offset, end: next, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    offset = next;
  }
  const starts = lines.filter(line => isBlockStart(line.text));
  const ends = lines.filter(line => isBlockEnd(line.text));
  if (!starts.length && !ends.length) return null;
  // Only the historical *empty* orphan start marker is removable. A pair, an
  // orphan end, duplicate markers or a live claude_web table is not evidence
  // for deleting any user-owned text.
  if (starts.length !== 1 || ends.length) fail('RECONCILE_CONFLICT', 'Managed-looking marker layout is not a single empty orphan start');
  const start = starts[0];
  const rest = text.slice(start.end);
  if (rest.trimStart() && !rest.trimStart().startsWith('[')) fail('RECONCILE_CONFLICT', 'Orphan marker has content before the next TOML section');
  const parsedBefore = parseToml(text);
  if (Object.hasOwn(parsedBefore.mcp_servers ?? {}, host.serverName)) fail('RECONCILE_CONFLICT', 'Orphan marker coexists with a claude_web registration');
  const next = text.slice(0, start.start) + text.slice(start.end);
  // Removing precisely one comment line cannot alter semantics; make that an
  // independently parsed invariant before any target write is possible.
  if (JSON.stringify(parseToml(next)) !== JSON.stringify(parsedBefore)) fail('RECONCILE_CONFLICT', 'Orphan marker removal would change TOML semantics');
  return next;
}

async function assertNoBusy(io, target, { ownLock = false } = {}) {
  for (const path of [...(ownLock ? [] : [target.lockPath]), ...['ccw.lock', 'ccw-recovery.lock', 'api.lock', 'api-recovery.lock'].map(name => join(target.stateDir, name))]) {
    if (await lstatSafe(io, path)) fail('INSTALL_BUSY', 'An installer or consultation lock exists; recovery never guesses or clears lock ownership');
  }
  const state = await lstatSafe(io, target.stateDir);
  if (state) {
    if (!state.isDirectory() || state.isSymbolicLink()) fail('UNSAFE_PATH', 'Consultation state directory must not be a link or non-directory');
    const dir = await io.opendir(target.stateDir);
    try {
      let count = 0, entry;
      while ((entry = await dir.read()) !== null) {
        if (++count > 4096) fail('RECONCILE_CONFLICT', 'State directory is too large for bounded recovery inspection');
        if (/^alias-[a-f0-9]{64}(\.recovery)?\.lock$/.test(entry.name)) fail('INSTALL_BUSY', 'A consultation alias lock exists; recovery never clears active or unknown locks');
      }
    } finally { await dir.close(); }
  }
}

async function capture(host, target, deps, { ownLock = false } = {}) {
  const { io, home } = deps;
  for (const path of statePaths(target)) await safePath(io, path, { directory: true });
  for (const path of [target.configPath, target.recordPath]) await safePath(io, path);
  await assertNoBusy(io, target, { ownLock });
  const config = await readSourceFile(io, target.configPath, { home, label: 'recovery configuration' });
  const record = await readSourceFile(io, target.recordPath, { home, maxBytes: 256 * 1024, label: 'install record' });
  // Parse even when there is no action: malformed config is never reported as
  // safe to reconcile. Do not include its original values in errors.
  const servers = sourceServers(host, config?.text ?? null);
  let validated = null;
  if (record) {
    const data = parseSourceJson(record.text, 'install record');
    validated = host.format === 'toml'
      ? validateTomlRecord(data, { ...host, ...target })
      : validateHostRecord(data, host, target);
  }
  let marker = null;
  try { marker = orphanMarker(config?.text ?? null, host); }
  catch (error) {
    if (error instanceof InstallError) throw error;
    fail('CONFIG_INVALID', 'Recovery configuration is not valid TOML');
  }
  if (marker !== null && record) fail('RECONCILE_CONFLICT', 'Orphan markers with a surviving record require historical reconciliation');
  let removeRecord = false;
  if (record) {
    if (Object.hasOwn(servers, host.serverName)) fail('RECONCILE_CONFLICT', 'Install record is not stale: claude_web registration still exists');
    if (target.skillDest && await lstatSafe(io, target.skillDest)) fail('RECONCILE_CONFLICT', 'Install record still has a skill destination; do not discard its ownership proof');
    if (host.format === 'toml' && config && config.text.split(/\r?\n/).some(line => isBlockStart(line) || isBlockEnd(line))) {
      fail('RECONCILE_CONFLICT', 'Install record still has managed-looking config markers');
    }
    // A structurally valid record is not enough: retain unknown installations
    // of older runtimes until their historical identity can be verified.
    for (const key of ['nodePath', 'mcpPath', 'cliPath']) {
      if (validated[key] !== deps[key]) fail('RECONCILE_CONFLICT', 'Stale record refers to another runtime; historical ownership verification required');
    }
    removeRecord = true;
  }
  return { config: config?.text ?? null, record: record?.text ?? null, nextConfig: marker, removeRecord,
    actions: [...(marker !== null ? [{ kind: 'remove-orphan-start-marker', path: target.configPath }] : []),
      ...(removeRecord ? [{ kind: 'retire-stale-install-record', path: target.recordPath }] : [])] };
}

const sameCapture = (a, b) => a.config === b.config && a.record === b.record && a.nextConfig === b.nextConfig && a.removeRecord === b.removeRecord;

async function syncDirectory(io, path) {
  const handle = await io.open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function privateBackup(io, target, pre) {
  const root = join(target.stateDir, 'install-recovery');
  await safePath(io, root, { directory: true });
  await ensureDirectory(io, root, { mode: 0o700, label: 'recovery backup directory' });
  const st = await io.lstat(root);
  if (st.mode & 0o077 || (process.getuid && st.uid !== process.getuid())) fail('UNSAFE_PATH', 'Recovery backup directory must be private and owned by the current user');
  const dir = join(root, randomUUID());
  await io.mkdir(dir, { mode: 0o700 });
  try {
    const files = [];
    for (const [name, text] of [['config.preimage', pre.config], ['record.preimage', pre.record]]) {
      if (text === null) continue;
      const path = join(dir, name);
      const handle = await io.open(path, 'wx', 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      if (await io.readFile(path, 'utf8') !== text) fail('BACKUP_FAILED', 'Recovery backup did not match the captured preimage', { recoveryPath: dir });
      files.push({ name, sha256: sha256(text) });
    }
    await writeFileAtomic(io, join(dir, 'journal.json'), JSON.stringify({ schema: 1, host: target.hostId, status: 'prepared', files, actions: pre.actions,
      postimage: { configSha256: pre.nextConfig === null ? (pre.config === null ? null : sha256(pre.config)) : sha256(pre.nextConfig), recordRemoved: pre.removeRecord } }, null, 2) + '\n');
    await syncDirectory(io, dir);
    await syncDirectory(io, root);
    await syncDirectory(io, target.stateDir);
    return dir;
  } catch (error) {
    error.details = { ...(error.details ?? {}), recoveryPath: dir, backupIncomplete: true };
    throw error;
  }
}

export async function reconcileHost(host, target, { io = defaultIo(), dryRun = false, ...rest } = {}) {
  const deps = { ...rest, io };
  const pre = await capture(host, target, deps);
  const result = { ok: true, host: host.id, configPath: target.configPath, actions: pre.actions, verification: 'ownership-and-images',
    ...(dryRun ? { dryRun: true, wouldReconcile: pre.actions.length !== 0 } : {}) };
  if (dryRun || pre.actions.length === 0) return { ...result, changed: false };
  const release = await acquireLock(io, { lockPath: target.lockPath, directory: dirname(target.lockPath), directoryLabel: 'recovery lock directory' });
  let recoveryPath = null;
  try {
    const locked = await capture(host, target, deps, { ownLock: true });
    if (!sameCapture(pre, locked)) fail('CONFIG_CHANGED', 'Recovery targets changed before the lock was acquired');
    recoveryPath = await privateBackup(io, target, pre);
    // A write failure retains the preimage and journal. No speculative
    // compensation can clobber edits made by another process after our guard.
    const verified = await capture(host, target, deps, { ownLock: true });
    if (!sameCapture(pre, verified)) fail('CONFIG_CHANGED', 'Recovery targets changed while backing up');
    if (pre.nextConfig !== null) await writeFileGuarded(io, { path: target.configPath, expected: pre.config, newText: pre.nextConfig, label: 'config', phase: 'reconciliation' });
    if (pre.removeRecord) await removeFileGuarded(io, { path: target.recordPath, expected: pre.record, label: 'install record', phase: 'reconciliation' });
    const postConfig = await readSourceFile(io, target.configPath, { home: rest.home, label: 'recovery configuration' });
    if ((postConfig?.text ?? null) !== (pre.nextConfig ?? pre.config)) {
      fail('CONFIG_CHANGED', 'Recovery configuration postimage could not be verified');
    }
    if (pre.removeRecord && await lstatSafe(io, target.recordPath)) fail('CONFIG_CHANGED', 'Install record reappeared after recovery');
    if (pre.nextConfig !== null) await syncDirectory(io, dirname(target.configPath));
    if (pre.removeRecord) await syncDirectory(io, dirname(target.recordPath));
    await writeFileAtomic(io, join(recoveryPath, 'COMMITTED'), 'verified\n');
    await syncDirectory(io, recoveryPath);
    return { ...result, changed: true, recoveryPath };
  } catch (error) {
    if (recoveryPath) error.details = { ...(error.details ?? {}), recoveryPath };
    throw error;
  } finally { await release(); }
}
