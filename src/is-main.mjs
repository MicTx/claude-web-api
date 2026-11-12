import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Both paths can preserve symlinks; compare their physical identities.
export function isMainModule(moduleUrl) {
  const argv = process.argv[1];
  if (!argv) return false;
  let p = resolve(argv);
  let modulePath = fileURLToPath(moduleUrl);
  try { p = realpathSync(p); } catch { /* keep resolved argument */ }
  try { modulePath = realpathSync(modulePath); } catch { /* keep module path */ }
  return modulePath === p;
}
