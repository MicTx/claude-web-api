// Read-only discovery of a manager-owned shared skill directory. This never
// links, adopts, repairs or refreshes the manager's copy.
import { join } from 'node:path';
import { defaultIo, lstatSafe } from './atomic.mjs';
import { parseSourceJson, readSourceFile } from './sources.mjs';

export async function inspectSharedSkill({ io = defaultIo(), home, skillName } = {}) {
  if (!home || !skillName) return null;
  const libraryPath = join(home, '.config', 'magpie', 'library.json');
  let library;
  try {
    const file = await readSourceFile(io, libraryPath, { home, label: 'Magpie Library' });
    if (!file) return null;
    library = parseSourceJson(file.text, 'Magpie Library');
  }
  catch { return null; }
  if (library.sharedSkills !== true) return null;
  if (!Array.isArray(library.skills)) return null;
  const skill = library.skills.find(item => item && typeof item === 'object' && item.name === skillName);
  if (!skill) return null;
  const dest = join(home, '.agents', 'skills', skillName);
  const shared = await lstatSafe(io, dest);
  return { dest, enabled: true, linkExists: shared !== null,
    managerOwned: shared?.isSymbolicLink() === true };
}
