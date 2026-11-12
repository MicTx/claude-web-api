import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORTER = join(ROOT, 'scripts', 'export-public-snapshot.mjs');
const SCANNER = join(ROOT, 'scripts', 'scan_public_tree.py');

const ROOT_FILES = {
  '.gitignore': 'node_modules/\n',
  'CHANGELOG.md': '# Changelog\n',
  'CODE_OF_CONDUCT.md': 'conduct with private tracker https://git.private.example/org/repo/issues\n',
  'CONTRIBUTING.md': '# Contributing\n',
  LICENSE: '# PolyForm Noncommercial License 1.0.0\nbody\n',
  NOTICE: 'notice\n',
  'README.en.md': 'en [简体中文](README.md)\n',
  'README.md': 'zh [English](README.en.md)\n',
  'SECURITY.md': 'security interim https://git.private.example/org/repo/issues\n',
  'install.sh': '#!/bin/sh\necho install\n',
  'llms.txt': 'llms\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
  'package.json': '{"name":"fixture"}\n',
};
const VARIANTS = {
  'SECURITY.public.md': 'security public https://github.com/ExampleOrg/repo/security/advisories/new\n',
  'CODE_OF_CONDUCT.public.md': 'conduct public contact https://github.com/ExampleOrg/repo/security/advisories/new\n',
  'github-issue-contact.public.yml': 'contact_links:\n  - url: https://github.com/ExampleOrg/repo/security/advisories/new\n',
};

async function makeFixture(t, { secret = false } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ccw-public-src-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(ROOT_FILES)) {
    await fs.writeFile(join(dir, name), content);
  }
  for (const [name, content] of Object.entries(VARIANTS)) {
    await fs.writeFile(join(dir, name), content);
  }
  await fs.chmod(join(dir, 'install.sh'), 0o755);
  for (const sub of ['.github/ISSUE_TEMPLATE', 'bin', 'docs', 'plugin/.codex-plugin',
    'scripts', 'skills/claude', 'src', 'test', '.spec/specs', 'logs', '.claude']) {
    await fs.mkdir(join(dir, sub), { recursive: true });
  }
  await fs.writeFile(join(dir, '.github/ISSUE_TEMPLATE/config.yml'),
    'contact_links:\n  - url: https://git.private.example/org/repo/issues\n');
  await fs.writeFile(join(dir, '.github/ISSUE_TEMPLATE/10_bug.yml'), 'name: bug\n');
  await fs.writeFile(join(dir, 'bin/ccw.mjs'), '#!/usr/bin/env node\n');
  await fs.writeFile(join(dir, 'docs/usage.md'), 'usage\n');
  await fs.writeFile(join(dir, 'plugin/.codex-plugin/plugin.json'), '{}\n');
  await fs.writeFile(join(dir, 'scripts/x.mjs'), 'export {}\n');
  await fs.writeFile(join(dir, 'skills/claude/SKILL.md'), 'skill\n');
  await fs.writeFile(join(dir, 'src/index.mjs'), 'export {}\n');
  await fs.writeFile(join(dir, 'test/release-publish.test.mjs'), '// private endpoint test\n');
  await fs.writeFile(join(dir, 'test/ok.test.mjs'), '// ok\n');
  await fs.writeFile(join(dir, '.spec/specs/hidden.md'), 'spec archive\n');
  await fs.writeFile(join(dir, 'AGENTS.md'), 'internal facts\n');
  await fs.writeFile(join(dir, 'logs/run.log'), 'log\n');
  await fs.writeFile(join(dir, '.claude/state.json'), '{}\n');
  if (secret) await fs.writeFile(join(dir, 'src/index.mjs'), 'const key = "sk-' + 'a'.repeat(24) + '";\n');
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await exec('git', ['remote', 'add', 'origin', 'git@git.private.example:org/repo.git'], { cwd: dir });
  return dir;
}

async function runExporter(source, out) {
  return exec('node', [EXPORTER, '--out', out, '--source', source, '--force'], { cwd: ROOT });
}

test('public snapshot: allowlist, overrides and exclusions hold', async t => {
  const source = await makeFixture(t);
  const out = join(await fs.mkdtemp(join(tmpdir(), 'ccw-public-out-')), 'tree');
  const { stdout } = await runExporter(source, out);
  const summary = JSON.parse(stdout);
  assert.equal(summary.ok, true);
  assert.ok(summary.files > 15);

  for (const absent of ['.spec', 'logs', '.claude', 'AGENTS.md',
    'test/release-publish.test.mjs', 'SECURITY.public.md']) {
    await assert.rejects(fs.lstat(join(out, absent)), { code: 'ENOENT' }, absent);
  }
  const security = await fs.readFile(join(out, 'SECURITY.md'), 'utf8');
  assert.ok(security.includes('github.com/ExampleOrg/repo/security/advisories'));
  const config = await fs.readFile(join(out, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8');
  assert.ok(config.includes('github.com/ExampleOrg'));
  const manifest = JSON.parse(await fs.readFile(join(out, 'PUBLIC_MANIFEST.json'), 'utf8'));
  assert.equal(manifest.format, 1);
  assert.ok(manifest.files['src/index.mjs']);
  assert.ok(!manifest.files['AGENTS.md']);
  const installMode = (await fs.stat(join(out, 'install.sh'))).mode;
  assert.ok(installMode & 0o111, 'install.sh keeps the exec bit');
});

test('public snapshot: credential-bearing file fails closed', async t => {
  const source = await makeFixture(t, { secret: true });
  const out = join(await fs.mkdtemp(join(tmpdir(), 'ccw-public-out-')), 'tree');
  await assert.rejects(runExporter(source, out), /privacy gate rejected|exit code 1|Command failed/i);
});

test('public scan: remote-derived private host is caught, clean tree passes', async t => {
  const source = await makeFixture(t);
  const dirty = await fs.mkdtemp(join(tmpdir(), 'ccw-public-scan-'));
  await fs.writeFile(join(dirty, 'leak.md'), 'see https://git.private.example/org/repo\n');
  await assert.rejects(exec('python3', [SCANNER, dirty, '--source', source]));

  const clean = await fs.mkdtemp(join(tmpdir(), 'ccw-public-scan-'));
  await fs.writeFile(join(clean, 'ok.md'), 'no private content\n');
  const { stdout } = await exec('python3', [SCANNER, clean, '--source', source]);
  assert.equal(JSON.parse(stdout).ok, true);
});
