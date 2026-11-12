// Filesystem primitives shared by every host adapter: the install lock, atomic
// replacement, concurrent-change guards, backups and rollback.
//
// All filesystem access goes through an injectable `io` seam so failure
// injection stays possible in tests; never call node:fs directly here.
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { InstallError } from './errors.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export const defaultIo = () => ({
  lstat: fs.lstat, mkdir: fs.mkdir, readFile: fs.readFile, writeFile: fs.writeFile,
  open: fs.open, rename: fs.rename, unlink: fs.unlink, rmdir: fs.rmdir, rm: fs.rm,
  readdir: fs.readdir, copyFile: fs.copyFile, chmod: fs.chmod, symlink: fs.symlink, link: fs.link,
  readlink: fs.readlink, realpath: fs.realpath, opendir: fs.opendir,
});

export const lstatSafe = async (io, p) => {
  try {
    return await io.lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};

export async function readIfFile(io, p, label) {
  const st = await lstatSafe(io, p);
  if (st === null) return null;
  if (st.isSymbolicLink()) throw new InstallError('UNSAFE_PATH', `${label} is a symlink`);
  if (!st.isFile()) throw new InstallError('UNSAFE_PATH', `${label} is not a regular file`);
  return io.readFile(p, 'utf8');
}

export async function assertNotSymlink(io, p, label) {
  const st = await lstatSafe(io, p);
  if (st && st.isSymbolicLink()) throw new InstallError('UNSAFE_PATH', `${label} is a symlink`);
}

// Create the directory when missing; refuse a symlinked or non-directory path.
export async function ensureDirectory(io, dir, { label = 'directory', mode = 0o700 } = {}) {
  const st = await lstatSafe(io, dir);
  if (st === null) {
    await io.mkdir(dir, { recursive: true, mode });
    return;
  }
  if (st.isSymbolicLink()) throw new InstallError('UNSAFE_PATH', `${label} is a symlink`);
  if (!st.isDirectory()) throw new InstallError('UNSAFE_PATH', `${label} is not a directory`);
}

export async function writeFileAtomic(io, path, content, mode = 0o600) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await io.open(tmp, 'wx', mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await io.rename(tmp, path);
  } catch (e) {
    await io.unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function cleanupOwnedFile(io, path, identity) {
  const st = await lstatSafe(io, path);
  if (!st) return true;
  if (!identity) return false;
  if (!st.isFile() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino) return false;
  await io.unlink(path);
  return true;
}

// Exclusive installer lock. Ownership is proven by a per-acquisition token so a
// stale lock is never removed by a process that does not own it.
export async function acquireLock(io, { lockPath, directory, directoryLabel = 'target directory' }) {
  await ensureDirectory(io, directory, { label: directoryLabel });
  // The lock may live outside the host directory (installer state dir).
  if (dirname(lockPath) !== directory) await ensureDirectory(io, dirname(lockPath), { label: 'lock directory' });
  await assertNotSymlink(io, lockPath, 'install lock');
  let handle;
  try {
    handle = await io.open(lockPath, 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') throw new InstallError('INSTALL_BUSY', 'Another install or uninstall is in progress');
    throw e;
  }
  const token = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    await handle.sync();
  } catch (e) {
    await handle.close().catch(() => {});
    await io.unlink(lockPath).catch(() => {});
    throw e;
  }
  await handle.close();
  return async () => {
    try {
      const c = JSON.parse(await io.readFile(lockPath, 'utf8'));
      if (c && c.token === token) await io.unlink(lockPath);
    } catch { /* already gone */ }
  };
}

export async function backupFile(io, { path, label = 'configuration' }) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (let i = 0; i < 100; i++) {
    const candidate = `${path}.bak.${stamp}${i === 0 ? '' : `.${i}`}`;
    if ((await lstatSafe(io, candidate)) === null) {
      const handle = await io.open(candidate, 'wx', 0o600);
      try {
        await handle.writeFile(await io.readFile(path, 'utf8'));
      } finally {
        await handle.close();
      }
      return candidate;
    }
  }
  throw new InstallError('BACKUP_FAILED', `Could not create a unique ${label} backup name`);
}

// Hard-link the preimage next to the target so a concurrent in-place edit stays
// recoverable even if it happens between our read and our rename.
export async function guardFile(io, { path, expected, label, phase }) {
  const guard = `${path}.concurrent-${randomUUID()}.bak`;
  let linked = false;
  let identity = null;
  try {
    await io.link(path, guard);
    linked = true;
    const [guardStat, currentStat] = await Promise.all([io.lstat(guard), io.lstat(path)]);
    identity = { dev: guardStat.dev, ino: guardStat.ino };
    if (!guardStat.isFile() || guardStat.isSymbolicLink() || guardStat.dev !== currentStat.dev || guardStat.ino !== currentStat.ino
      || await readIfFile(io, guard, `${label} recovery link`) !== expected
      || await readIfFile(io, path, label) !== expected) {
      throw new InstallError('CONFIG_CHANGED', `${label} changed during ${phase}; aborted`);
    }
    return { path: guard, dev: guardStat.dev, ino: guardStat.ino };
  } catch (error) {
    if (linked && !(await cleanupOwnedFile(io, guard, identity).catch(() => false))) {
      error.details = { ...(error.details ?? {}), cleanupPaths: [guard] };
    }
    if (error.code === 'ENOENT') throw new InstallError('CONFIG_CHANGED', `${label} disappeared during ${phase}; aborted`);
    throw error;
  }
}

export async function writeFileGuarded(io, { path, expected, newText, label, phase = 'installation' }) {
  const current = await readIfFile(io, path, label);
  if (current !== expected) {
    throw new InstallError('CONFIG_CHANGED', `${label} changed during ${phase}; aborted`);
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let guard = null;
  let retainGuard = false;
  let tmpIdentity = null;
  let published = false;
  let failure = null;
  try {
    const handle = await io.open(tmp, 'wx', 0o600);
    try {
      tmpIdentity = await handle.stat();
      await handle.writeFile(newText);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expected === null) {
      try { await io.link(tmp, path); }
      catch (error) {
        if (error.code === 'EEXIST') throw new InstallError('CONFIG_CHANGED', `${label} appeared during ${phase}; aborted`);
        throw error;
      }
      published = true;
    } else {
      guard = await guardFile(io, { path, expected, label, phase });
      await io.rename(tmp, path);
      published = true;
      if (await readIfFile(io, guard.path, `${label} recovery link`) !== expected) {
        retainGuard = true;
        throw new InstallError('CONFIG_CHANGED', `${label} changed during replacement; the concurrent version was retained`, {
          recoveryPath: guard.path, incompleteRollback: [label],
        });
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const leftovers = [];
    if (!(await cleanupOwnedFile(io, tmp, tmpIdentity).catch(() => false))) leftovers.push(tmp);
    if (guard && !retainGuard && !(await cleanupOwnedFile(io, guard.path, guard).catch(() => false))) leftovers.push(guard.path);
    if (leftovers.length) {
      failure ??= new InstallError('CONFIG_CLEANUP', 'Could not clean up configuration staging files');
      failure.details = { ...(failure.details ?? {}), cleanupPaths: leftovers, ...(published ? { incompleteRollback: [label] } : {}) };
    }
  }
  if (failure) throw failure;
}

export async function removeFileGuarded(io, { path, expected, label, phase = 'removal' }) {
  const guard = await guardFile(io, { path, expected, label, phase });
  let retainGuard = false;
  try {
    await io.unlink(path);
    if (await readIfFile(io, guard.path, `${label} recovery link`) !== expected) {
      retainGuard = true;
      throw new InstallError('CONFIG_CHANGED', `${label} changed during ${phase}; the concurrent version was retained`, {
        recoveryPath: guard.path, incompleteRollback: [label],
      });
    }
  } finally {
    if (!retainGuard && !(await cleanupOwnedFile(io, guard.path, guard).catch(() => false))) {
      throw new InstallError('CONFIG_CLEANUP', 'Could not clean up the configuration recovery link', {
        cleanupPaths: [guard.path], incompleteRollback: [label],
      });
    }
  }
}

// Best-effort restore of the preimage after a partial install. Anything that
// cannot be restored is reported instead of being silently dropped.
export async function rollbackFile(io, { path, expectedPost, original, leftover, label = 'configuration' }) {
  try {
    const current = await readIfFile(io, path, label);
    if (current === expectedPost) {
      if (original === null) await io.unlink(path);
      else await writeFileAtomic(io, path, original);
    } else if (current !== original) {
      leftover.push(label);
    }
  } catch {
    leftover.push(label);
  }
}
