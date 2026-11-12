// Read-only comparison of a manager-owned skill copy against the current
// trusted runtime. This never adopts, repairs or rewrites the copy; ownership
// and refresh remain with the external manager.
import { join } from 'node:path';
import { defaultIo, sha256 } from './atomic.mjs';
import { listSkillSources } from './skills.mjs';

export async function inspectExternalSkill({ io = defaultIo(), home, skillDest, skillSrc } = {}) {
  if (!skillDest || !skillSrc) return null;
  let root;
  try { root = io.realpath ? await io.realpath(skillDest) : skillDest; }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return { status: 'missing', skillRoot: skillDest, mismatches: [] };
    return { status: 'unreadable', skillRoot: skillDest, mismatches: [] };
  }
  if (home) {
    const resolvedHome = io.realpath ? await io.realpath(home).catch(() => home) : home;
    if (root !== resolvedHome && !root.startsWith(`${resolvedHome}/`)) {
      return { status: 'outside-home', skillRoot: root, mismatches: [] };
    }
  }
  let sources;
  try { sources = await listSkillSources(io, skillSrc); }
  catch { return { status: 'runtime-unreadable', skillRoot: root, mismatches: [] }; }
  const mismatches = [];
  let compared = 0;
  for (const { rel, abs } of sources) {
    let expected, actual;
    try {
      expected = sha256(await io.readFile(abs));
      actual = sha256(await io.readFile(join(root, ...rel.split('/'))));
    } catch {
      mismatches.push(rel);
      continue;
    }
    compared++;
    if (expected !== actual) mismatches.push(rel);
  }
  return { status: mismatches.length ? 'stale' : 'current', skillRoot: root, compared, mismatches };
}
