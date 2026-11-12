// Shared by the native plugin and standalone release; no development paths in output.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BANNER = "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n";

export async function bundleRuntime(entry, outfile, options = {}) {
  const result = await build({
    absWorkingDir: ROOT, entryPoints: [entry], outfile, bundle: true,
    format: 'esm', platform: 'node', target: 'node22',
    banner: { js: BANNER }, logLevel: 'warning', ...options,
  });
  const text = options.write === false ? result.outputFiles[0].text : await readFile(outfile, 'utf8');
  if (text.includes(ROOT)) throw new Error('Bundle contains a development repository path');
  return text;
}
