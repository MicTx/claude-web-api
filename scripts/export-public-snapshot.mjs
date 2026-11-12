#!/usr/bin/env node
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Build a filtered public source tree for an authorized GitHub snapshot.
//
// The private Gitea repository remains the source of truth. This command copies
// only the public allowlist, applies maintainer-reviewed public variants, emits
// a digest manifest, and runs the credential/private-marker scan. It never
// touches remotes and never publishes; publication is a separate authorized step.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PUBLIC_ROOT_FILES = [
  '.gitignore',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.en.md',
  'README.md',
  'SECURITY.md',
  'install.sh',
  'llms.txt',
  'package-lock.json',
  'package.json',
];
const PUBLIC_DIRS = ['.github', 'bin', 'docs', 'plugin', 'scripts', 'skills', 'src', 'test'];

// Files that embed private development endpoints or gate-triggering fixtures
// (private release hosts, a literal PEM test vector); same rationale as the
// spec-harness exporter's private test list. Public variants at the repository
// root replace their targets inside the staging tree only.
const EXCLUDED_FILES = new Set([
  'test/release-build.test.mjs',
  'test/release-publish.test.mjs',
  'test/repository-docs.test.mjs',
]);
const OVERRIDES = new Map([
  ['SECURITY.public.md', 'SECURITY.md'],
  ['CODE_OF_CONDUCT.public.md', 'CODE_OF_CONDUCT.md'],
  ['github-issue-contact.public.yml', '.github/ISSUE_TEMPLATE/config.yml'],
]);

const PRIVATE_PARTS = new Set([
  '.agents', '.claude', '.codex', '.cursor', '.paseo', '.pi', '.spec', '.zcode',
  '__pycache__', 'backups', 'coverage', 'dist', 'logs', 'node_modules',
  'sessions', 'uploads', 'worktrees',
]);
const PRIVATE_SUFFIXES = new Set([
  '.pyc', '.pyo', '.log', '.bak', '.backup', '.key', '.pem', '.crt', '.cer', '.p12', '.pfx',
]);
// Dot-directories that are part of the published product surface rather than
// local agent state: GitHub metadata and the Codex plugin manifest directory.
const PUBLIC_DOT_DIRS = new Set(['.github', '.codex-plugin']);

class PublicExportError extends Error {}

function usage() {
  console.error('usage: export-public-snapshot.mjs --out <dir> [--source <repo>] [--force] [--no-scan]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { out: null, source: ROOT, force: false, scan: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--no-scan') args.scan = false;
    else usage();
  }
  if (!args.out) usage();
  return args;
}

async function assertFile(source, name) {
  const path = join(source, name);
  const stat = await fs.lstat(path).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new PublicExportError(`required public file missing or symlinked: ${name}`);
  }
  return path;
}

function isUnsafe(relativePath, name) {
  const parts = relativePath.split('/');
  if (parts.some(part => PRIVATE_PARTS.has(part) || part.startsWith('.env') || part === '.DS_Store')) return true;
  if (PRIVATE_SUFFIXES.has(extname(name).toLowerCase())) return true;
  return parts.slice(0, -1).some(part => part.startsWith('.') && !PUBLIC_DOT_DIRS.has(part));
}

async function collectFiles(source) {
  const files = [];
  for (const name of PUBLIC_ROOT_FILES) files.push([await assertFile(source, name), name]);
  for (const dir of PUBLIC_DIRS) {
    const base = join(source, dir);
    const stat = await fs.lstat(base).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PublicExportError(`required public directory missing or symlinked: ${dir}`);
    }
    const walk = async current => {
      for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        const rel = relative(source, path).split(sep).join('/');
        if (isUnsafe(rel, entry.name) || EXCLUDED_FILES.has(rel)) continue;
        if (entry.isDirectory()) { await walk(path); continue; }
        const lst = await fs.lstat(path);
        if (lst.isSymbolicLink() || !lst.isFile()) {
          throw new PublicExportError(`public tree contains unsafe entry: ${rel}`);
        }
        files.push([path, rel]);
      }
    };
    await walk(base);
  }
  return files.sort((a, b) => a[1].localeCompare(b[1]));
}

async function applyOverrides(source, files) {
  const result = new Map(files.map(([srcPath, rel]) => [rel, srcPath]));
  for (const [variant, target] of OVERRIDES) {
    result.set(target, await assertFile(source, variant));
  }
  return [...result.entries()].map(([rel, srcPath]) => [srcPath, rel]);
}

async function sourceCommit(source) {
  const git = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (git.status !== 0) return null;
  return git.stdout.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolve(args.source);
  const output = resolve(args.out);
  if (output === source || output.startsWith(source + sep)) {
    throw new PublicExportError('public output must be outside the private source tree');
  }

  const license = await fs.readFile(join(source, 'LICENSE'), 'utf8');
  assert.ok(license.startsWith('# PolyForm Noncommercial License 1.0.0'),
    'public release requires PolyForm Noncommercial 1.0.0');
  for (const [name, peer] of [['README.md', 'README.en.md'], ['README.en.md', 'README.md']]) {
    const text = await fs.readFile(join(source, name), 'utf8');
    assert.ok(text.includes(`](${peer})`), `public release requires linked bilingual READMEs: ${name}`);
  }

  const outStat = await fs.lstat(output).catch(() => null);
  if (outStat) {
    if (outStat.isSymbolicLink()) throw new PublicExportError('public output must not be a symlink');
    if (!args.force) throw new PublicExportError('output exists; pass --force to replace it');
    await fs.rm(output, { recursive: true });
  }
  await fs.mkdir(output, { recursive: true });

  const files = await applyOverrides(source, await collectFiles(source));
  const digests = {};
  for (const [srcPath, rel] of files) {
    const content = await fs.readFile(srcPath);
    const target = join(output, rel);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    // writeFile creates non-executable entries; preserve the exec bit so
    // install.sh and the CLI shim stay runnable in the public tree.
    const mode = (await fs.stat(srcPath)).mode;
    if (mode & 0o111) await fs.chmod(target, mode & 0o777);
    digests[rel] = createHash('sha256').update(content).digest('hex');
  }

  let scan = { ok: null, skipped: true };
  if (args.scan) {
    const result = spawnSync('python3', [
      join(ROOT, 'scripts', 'scan_public_tree.py'), output, '--source', source,
    ], { encoding: 'utf8' });
    try { scan = JSON.parse(result.stdout || '{}'); } catch { scan = { ok: false, error: 'scanner output unreadable' }; }
    if (result.status !== 0) scan.ok = false;
    if (scan.ok === false) throw new PublicExportError('public privacy gate rejected the staged tree');
  }

  const manifest = {
    format: 1,
    project: 'claude-web-api',
    sourceCommit: await sourceCommit(source),
    overrides: Object.fromEntries(OVERRIDES),
    excluded: [...EXCLUDED_FILES],
    files: Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b))),
  };
  // The manifest is written after the scan so its own sha256 literals can
  // never trip the credential gate.
  await fs.writeFile(join(output, 'PUBLIC_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

  const summary = { ok: scan.ok === true || scan.skipped === true, out: output, files: Object.keys(digests).length, sourceCommit: manifest.sourceCommit, scan };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch(error => {
  console.error(`export-public-snapshot: ${error.message}`);
  process.exit(1);
});
