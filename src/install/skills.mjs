// Skill-directory mechanics shared by every host adapter: source enumeration,
// content hashing, staged publication with quarantine, and post-image checks.
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InstallError } from './errors.mjs';
import { writeFileAtomic, sha256 } from './atomic.mjs';

// runtime.json is written by the installer, never copied from the source skill.
const GENERATED = new Set(['runtime.json']);

export async function listSkillSources(io, skillSrc) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const item of await io.readdir(dir, { withFileTypes: true })) {
      const r = rel === '' ? item.name : `${rel}/${item.name}`;
      const p = join(dir, item.name);
      if (item.isDirectory()) await walk(p, r);
      else if (item.isFile() && !GENERATED.has(item.name)) out.push({ rel: r, abs: p });
    }
  };
  await walk(skillSrc, '');
  return out;
}

export const hashFile = async (io, p) => sha256(await io.readFile(p));

export async function listDirFiles(io, dir) {
  const out = [];
  const walk = async (d, rel) => {
    let items;
    try {
      items = await io.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const item of items) {
      const r = rel === '' ? item.name : `${rel}/${item.name}`;
      const p = join(d, item.name);
      if (item.isDirectory()) await walk(p, r);
      else out.push({ rel: r, abs: p, stat: await io.lstat(p) });
    }
  };
  await walk(dir, '');
  return out;
}

// Records which CLI entry the installed skill should call and which host owns
// it, so one skill copy per host stays self-describing.
export const runtimeJson = ({ cliPath, hostId }) => `${JSON.stringify({ cli: cliPath, host: hostId })}\n`;

export async function desiredSkillFiles(io, { skillSrc, cliPath, hostId }) {
  const files = {};
  for (const { rel, abs } of await listSkillSources(io, skillSrc)) {
    files[rel] = await hashFile(io, abs);
  }
  files['runtime.json'] = sha256(runtimeJson({ cliPath, hostId }));
  return files;
}

export function skillHashesMatch(first, second) {
  const keys = Object.keys(first ?? {});
  return keys.length === Object.keys(second ?? {}).length && keys.every(key => first[key] === second[key]);
}

export async function checkSkillFreshness(io, { skillSrc, cliPath, hostId, recorded, issues }) {
  if (!skillSrc || !cliPath) return;
  try {
    const desired = await desiredSkillFiles(io, { skillSrc, cliPath, hostId });
    if (!skillHashesMatch(desired, recorded)) issues.push('skill copy differs from current runtime; verify ownership and refresh');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) {
      issues.push('current skill source unavailable; verify the runtime before refreshing');
      return;
    }
    throw error;
  }
}

export async function copySkillInto(io, { skillSrc, dest, cliPath, hostId, keepSet }) {
  await io.mkdir(dest, { recursive: true, mode: 0o700 });
  for (const { rel, abs } of await listSkillSources(io, skillSrc)) {
    const target = join(dest, ...rel.split('/'));
    await io.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await io.copyFile(abs, target);
    await io.chmod(target, 0o600);
  }
  await writeFileAtomic(io, join(dest, 'runtime.json'), runtimeJson({ cliPath, hostId }));
  for (const f of await listDirFiles(io, dest)) {
    if (!keepSet.has(f.rel)) await io.unlink(f.abs);
  }
}

export async function dirMatchesPostimage(io, dir, postHashes) {
  const files = await listDirFiles(io, dir);
  if (files.length !== Object.keys(postHashes).length) return false;
  for (const f of files) {
    if (!(f.rel in postHashes) || !f.stat.isFile() || f.stat.isSymbolicLink()) return false;
    if (await hashFile(io, f.abs) !== postHashes[f.rel]) return false;
  }
  return true;
}

export async function restoreQuarantinedSkill(io, { skillDest, quarantine, leftover }) {
  const retained = `skill directory (quarantine kept: ${quarantine})`;
  try {
    if ((await io.lstat(skillDest).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)))) !== null) {
      leftover.push(retained);
      return;
    }
    await io.rename(quarantine, skillDest);
  } catch {
    leftover.push(retained);
  }
}

// Validate the managed skill tree against the recorded hashes: an unknown,
// modified, missing or non-regular file means the tree is no longer ours.
export async function verifySkillTree(io, { skillDest, postHashes, issues, onIssue }) {
  const report = onIssue ?? ((msg) => issues.push(msg));
  const files = await listDirFiles(io, skillDest);
  for (const f of files) {
    if (!(f.rel in postHashes)) report(`Unknown file inside the managed skill directory: ${f.rel}`);
    else if (!f.stat.isFile()) report(`Managed skill path ${f.rel} is not a regular file`);
    else if (await hashFile(io, f.abs) !== postHashes[f.rel]) report(`skill file changed: ${f.rel}`);
  }
  for (const rel of Object.keys(postHashes)) {
    if (!files.some((f) => f.rel === rel)) report(`skill file missing: ${rel}`);
  }
  return files;
}

// Refuse to touch a skill directory that exists but is not ours.
export async function assertOwnedSkillTree(io, { skillDest, postHashes }) {
  const files = await listDirFiles(io, skillDest);
  for (const f of files) {
    if (f.stat.isSymbolicLink()) throw new InstallError('UNSAFE_PATH', `Skill file ${f.rel} is a symlink`);
    if (!(f.rel in postHashes)) throw new InstallError('OWNED_MODIFIED', `Unknown file ${f.rel} inside the managed skill directory`);
    if (!f.stat.isFile()) throw new InstallError('OWNED_MODIFIED', `Managed skill path ${f.rel} is not a regular file`);
    if (await hashFile(io, f.abs) !== postHashes[f.rel]) throw new InstallError('OWNED_MODIFIED', `Installed skill file ${f.rel} was modified`);
  }
  for (const rel of Object.keys(postHashes)) {
    if (!files.some((f) => f.rel === rel)) throw new InstallError('OWNED_MODIFIED', `Installed skill file ${rel} is missing`);
  }
  return files;
}

export const stagingName = () => `.staging-${randomUUID()}`;
export const quarantineName = () => `.prev-${randomUUID()}`;
