#!/usr/bin/env node
// CLI fallback wrapper for the claude skill. Resolves the real CLI
// entry from runtime.json (written by the standalone installer) or falls back
// to the repository/plugin layout relative to this file.
import { readFile } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let cliPath = resolve(here, '..', '..', '..', 'bin', 'ccw.mjs');
try {
  const raw = await readFile(resolve(here, '..', 'runtime.json'), 'utf8');
  const data = JSON.parse(raw);
  if (data && typeof data.cli === 'string' && isAbsolute(data.cli)) {
    cliPath = data.cli;
  }
} catch {
  // no runtime.json - use the relative fallback
}

const mod = await import(pathToFileURL(cliPath).href);
if (typeof mod.main !== 'function') {
  process.stderr.write('ccw wrapper: CLI entry not found\n');
  process.exit(1);
}
process.exitCode = await mod.main(process.argv.slice(2));
