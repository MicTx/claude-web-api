#!/usr/bin/env node
// Build from an explicit allowlist, never from a worktree archive.
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bundleRuntime } from './bundle-runtime.mjs';
import { pack, readRelease, sha256, VERSION } from '../src/release/archive.mjs';
import { assertPublishableContent } from '../src/release/content-scan.mjs';
import { DOC_FILES } from '../src/release/docs.mjs';
import { APP } from '../src/identity.mjs';
import { isMainModule } from '../src/is-main.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = async path => { try { await fs.lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

// The separate wrapper keeps import.meta.url at the engine's original depth.
// CCW_RUNTIME_ROOT is scoped to our installed shim, not a global shell setting.
const HOST_WRAPPER = `#!/usr/bin/env node
process.env.CCW_NODE_COMMAND = 'node';
import { run, readState, VERSION } from '../src/install/entry.mjs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, readFile, lstat } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let selected = process.env.CCW_RUNTIME_ROOT ?? root;
try {
  if (!selected.startsWith('/') || await realpath(selected) !== await realpath(root)) throw new Error('Runtime root identity mismatch');
  const physicalRoot = await realpath(root);
  const releases = dirname(physicalRoot);
  if (basename(releases) === 'releases' && basename(physicalRoot).startsWith('v') && VERSION.test(basename(physicalRoot).slice(1))) {
    const runtimeRoot = dirname(releases);
    const state = await readState(runtimeRoot);
    if (!state || await realpath(join(runtimeRoot, 'current')) !== physicalRoot) throw new Error('Only the verified current release can register hosts');
    selected = join(runtimeRoot, 'current');
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.name !== '${APP}') throw new Error('Release manifest required');
  const readonly = process.argv.slice(2).some(a => ['--help', '--list', '--check', '--dry-run', '--uninstall', '--discover'].includes(a));
  if (!readonly) {
    for (let p = root;; p = dirname(p)) {
      if (await lstat(resolve(p, '.git')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Cannot register a development worktree as a runtime');
      if (dirname(p) === p) break;
    }
    if (!process.argv.slice(2).some(a => a === '--host' || a.startsWith('--host='))) throw new Error('Select an explicitly verified direct host with --host; external managers must use the installed ccw-mcp entry');
  }
  process.exitCode = await run(process.argv.slice(2), { sourceRoot: selected });
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: 'RELEASE_REQUIRED', message: error.message } }));
  process.exitCode = 1;
}
`;

export async function buildRelease({ outDir } = {}) {
  const pkg = JSON.parse(await fs.readFile(join(ROOT, 'package.json'), 'utf8'));
  if (!VERSION.test(pkg.version)) throw new Error('Package version is not a supported fixed version');
  const version = pkg.version;
  const out = resolve(outDir ?? join(ROOT, 'dist', 'releases', `v${version}`));
  if (await exists(out) && !(await fs.lstat(out)).isDirectory()) throw new Error('Unsafe release output directory');
  await fs.mkdir(out, { recursive: true });
  const stage = await fs.mkdtemp(join(out, '.build-'));
  try {
    for (const dir of ['bin', 'src/install', 'scripts', 'skills/claude/scripts']) await fs.mkdir(join(stage, dir), { recursive: true });
    await Promise.all([
      bundleRuntime(join(ROOT, 'bin/ccw.mjs'), join(stage, 'bin/ccw.mjs')),
      bundleRuntime(join(ROOT, 'src/mcp-server.mjs'), join(stage, 'src/mcp-server.mjs')),
      bundleRuntime(join(ROOT, 'scripts/install-agents.mjs'), join(stage, 'src/install/entry.mjs'), {
        define: { __CCW_RELEASE_INTERNAL_ENTRY__: 'true' },
      }),
    ]);
    await fs.writeFile(join(stage, 'scripts/install-agents.mjs'), HOST_WRAPPER);
    const files = [];
    const add = async (path, mode = 0o644) => {
      const stat = await fs.lstat(join(stage, path));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe release input');
      const bytes = await fs.readFile(join(stage, path));
      if (bytes.includes(Buffer.from(ROOT))) throw new Error(`Development path in release file: ${path}`);
      files.push({ path, mode, bytes });
    };
    for (const path of ['bin/ccw.mjs', 'src/mcp-server.mjs', 'src/install/entry.mjs', 'scripts/install-agents.mjs']) await add(path, 0o755);
    for (const path of ['skills/claude/SKILL.md', 'skills/claude/scripts/ccw.mjs', ...DOC_FILES]) {
      const src = join(ROOT, path);
      if (!await exists(src)) {
        if (DOC_FILES.includes(path)) continue;
        throw new Error(`Missing release input: ${path}`);
      }
      const stat = await fs.lstat(src);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe release input');
      await fs.mkdir(dirname(join(stage, path)), { recursive: true });
      await fs.copyFile(src, join(stage, path));
      await add(path);
    }
    const runtimePackage = { name: pkg.name, version, private: true, type: 'module', license: pkg.license, engines: pkg.engines, bin: { ccw: 'bin/ccw.mjs' } };
    files.push({ path: 'package.json', mode: 0o644, bytes: Buffer.from(JSON.stringify(runtimePackage, null, 2) + '\n') });
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = { schema: 1, name: pkg.name, version, files: files.map(({ path, mode, bytes }) => ({ path, mode, size: bytes.length, sha256: sha256(bytes) })) };
    files.push({ path: 'release.json', mode: 0o644, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
    assertPublishableContent(files);
    const prefix = `${APP}-v${version}/`;
    const archive = pack(files.map(file => ({ ...file, path: prefix + file.path })));
    readRelease(archive, version);
    const assetName = `${APP}-v${version}.tar.gz`;
    const assets = new Map([[assetName, archive]]);
    if (await exists(join(ROOT, 'install.sh')) && await exists(join(ROOT, 'src/release/installer.mjs'))) {
      const source = await fs.readFile(join(ROOT, 'install.sh'), 'utf8');
      const marker = '# ccw:bundled-release-installer';
      const index = source.indexOf(marker);
      if (index < 0 || source.indexOf(marker, index + marker.length) >= 0) throw new Error('Invalid installer bootstrap template');
      const program = await bundleRuntime(join(ROOT, 'src/release/installer.mjs'), join(stage, 'installer.mjs'), {
        write: false, define: { __CCW_RELEASE_VERSION__: JSON.stringify(version) },
      });
      const bash = source.slice(0, index) + "exec node --input-type=module - \"$@\" <<'CCW_RELEASE_PROGRAM'\n" + program + '\nCCW_RELEASE_PROGRAM\n';
      const installBytes = Buffer.from(bash);
      assertPublishableContent([{ path: 'install.sh', bytes: installBytes }]);
      assets.set('install.sh', installBytes);
    }
    const sums = [...assets].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join('');
    assets.set('SHA256SUMS', Buffer.from(sums));
    for (const [name, bytes] of assets) {
      const path = join(out, name);
      if (await exists(path) && !(await fs.lstat(path)).isFile()) throw new Error('Unsafe release asset path');
      const tmp = join(out, `.${name}-${randomUUID()}`);
      await fs.writeFile(tmp, bytes, { mode: name === 'install.sh' ? 0o755 : 0o644, flag: 'wx' });
      await fs.rename(tmp, path);
    }
    return { version, outDir: out, archivePath: join(out, assetName), checksumPath: join(out, 'SHA256SUMS'), assets: [...assets.keys()] };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  buildRelease().then(result => console.log(JSON.stringify({ ok: true, ...result }))).catch(error => {
    console.error(`build-release failed: ${error.message}`);
    process.exitCode = 1;
  });
}
