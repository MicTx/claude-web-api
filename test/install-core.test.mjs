import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultIo, sha256, readIfFile, writeFileAtomic, writeFileGuarded, removeFileGuarded,
  acquireLock, backupFile, rollbackFile, ensureDirectory, lstatSafe,
} from '../src/install/atomic.mjs';
import {
  listSkillSources, desiredSkillFiles, copySkillInto, dirMatchesPostimage, verifySkillTree,
  assertOwnedSkillTree, runtimeJson, listDirFiles,
} from '../src/install/skills.mjs';
import { buildBlock, readRecord as readTomlRecord } from '../src/install/toml-host.mjs';
import { validateHostRecord } from '../src/install/host-json.mjs';
import { canonical } from '../src/install/json-text.mjs';
import { InstallError } from '../src/install/errors.mjs';
import { findHost } from '../src/install/hosts.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const io = defaultIo();
const nodePath = process.execPath;
const mcpPath = join(ROOT, 'src', 'mcp-server.mjs');
const cliPath = join(ROOT, 'bin', 'ccw.mjs');
const skillSrc = join(ROOT, 'skills', 'claude');

test('install core: the install lock is exclusive and token owned', async () => {
  const dir = await makeTmpDir('ccw-core-lock-');
  const lockPath = join(dir, '.install.lock');
  const release = await acquireLock(io, { lockPath, directory: dir, directoryLabel: 'test home' });
  await assert.rejects(
    () => acquireLock(io, { lockPath, directory: dir, directoryLabel: 'test home' }),
    (error) => error instanceof InstallError && error.code === 'INSTALL_BUSY',
  );
  // a foreign lock owner is never removed by a non-owner release
  const release2 = await (async () => {
    await release();
    return acquireLock(io, { lockPath, directory: dir, directoryLabel: 'test home' });
  })();
  await fs.writeFile(lockPath, JSON.stringify({ pid: 1, token: 'not-ours' }));
  await release2();
  assert.equal((await lstatSafe(io, lockPath)) !== null, true, 'foreign lock stays');
  await fs.unlink(lockPath);
});

test('install core: guarded writes refuse concurrent changes and keep the recovery copy', async () => {
  const dir = await makeTmpDir('ccw-core-guard-');
  const target = join(dir, 'config.json');
  await fs.writeFile(target, '{"a":1}\n');
  await writeFileGuarded(io, { path: target, expected: '{"a":1}\n', newText: '{"a":2}\n', label: 'config', phase: 'installation' });
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":2}\n');

  await fs.writeFile(target, '{"a":3}\n'); // concurrent user edit after our read
  await assert.rejects(
    () => writeFileGuarded(io, { path: target, expected: '{"a":2}\n', newText: '{"a":4}\n', label: 'config', phase: 'installation' }),
    (error) => error.code === 'CONFIG_CHANGED',
  );
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":3}\n', 'user edit survives');
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('concurrent'));
  assert.equal(leftovers.length, 0, 'guard link cleaned up');
});

test('install core: creating a file refuses to overwrite one that appeared meanwhile', async () => {
  const dir = await makeTmpDir('ccw-core-appear-');
  const target = join(dir, 'config.json');
  await fs.writeFile(target, '{"user":true}\n');
  await assert.rejects(
    () => writeFileGuarded(io, { path: target, expected: null, newText: '{"ours":true}\n', label: 'config', phase: 'installation' }),
    (error) => error.code === 'CONFIG_CHANGED' && /changed during installation/.test(error.message),
  );
  assert.equal(await fs.readFile(target, 'utf8'), '{"user":true}\n');
});

test('install core: guarded removal and rollback restore the preimage', async () => {
  const dir = await makeTmpDir('ccw-core-remove-');
  const target = join(dir, 'config.json');
  await fs.writeFile(target, '{"a":1}\n');
  await removeFileGuarded(io, { path: target, expected: '{"a":1}\n', label: 'config', phase: 'removal' });
  assert.equal(await lstatSafe(io, target), null);

  const leftover = [];
  // rolling back a file we created removes it
  await writeFileAtomic(io, target, '{"ours":1}\n');
  await rollbackFile(io, { path: target, expectedPost: '{"ours":1}\n', original: null, leftover, label: 'config' });
  assert.deepEqual(leftover, []);
  assert.equal(await lstatSafe(io, target), null);
  await writeFileAtomic(io, target, '{"a":1}\n');
  await rollbackFile(io, { path: target, expectedPost: '{"ours":1}\n', original: '{"a":1}\n', leftover, label: 'config' });
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":1}\n');
  // a concurrent edit is reported, never overwritten
  await fs.writeFile(target, '{"user":2}\n');
  await rollbackFile(io, { path: target, expectedPost: '{"ours":1}\n', original: '{"a":1}\n', leftover, label: 'config' });
  assert.deepEqual(leftover, ['config']);
  assert.equal(await fs.readFile(target, 'utf8'), '{"user":2}\n');
});

test('install core: backups get unique names and keep the preimage bytes', async () => {
  const dir = await makeTmpDir('ccw-core-backup-');
  const target = join(dir, 'config.json');
  await fs.writeFile(target, '{"a":1}\n');
  const first = await backupFile(io, { path: target });
  const second = await backupFile(io, { path: target });
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(first, 'utf8'), '{"a":1}\n');
});

test('install core: ensureDirectory refuses symlinked or non-directory paths', async () => {
  const dir = await makeTmpDir('ccw-core-dir-');
  const file = join(dir, 'file');
  await fs.writeFile(file, 'x');
  await assert.rejects(() => ensureDirectory(io, file), (e) => e.code === 'UNSAFE_PATH');
  const link = join(dir, 'link');
  await fs.symlink(file, link);
  await assert.rejects(() => ensureDirectory(io, link), (e) => e.code === 'UNSAFE_PATH');
  await ensureDirectory(io, join(dir, 'nested', 'deep'));
  assert.equal((await fs.lstat(join(dir, 'nested', 'deep'))).isDirectory(), true);
});

test('install core: readIfFile refuses symlinks and directories', async () => {
  const dir = await makeTmpDir('ccw-core-read-');
  const file = join(dir, 'file');
  await fs.writeFile(file, 'x');
  await fs.symlink(file, join(dir, 'link'));
  await assert.rejects(() => readIfFile(io, join(dir, 'link'), 'config'), (e) => e.code === 'UNSAFE_PATH');
  await assert.rejects(() => readIfFile(io, dir, 'config'), (e) => e.code === 'UNSAFE_PATH');
  assert.equal(await readIfFile(io, join(dir, 'missing'), 'config'), null);
});

test('install core: skill sources exclude the generated runtime.json', async () => {
  const sources = await listSkillSources(io, skillSrc);
  const rels = sources.map((s) => s.rel).sort();
  assert.deepEqual(rels, ['SKILL.md', 'scripts/ccw.mjs']);
});

test('install core: skill tree install, verify and tamper detection', async () => {
  const dir = await makeTmpDir('ccw-core-skill-');
  const dest = join(dir, 'claude');
  const desired = await desiredSkillFiles(io, { skillSrc, cliPath, hostId: 'pi' });
  assert.ok(Object.keys(desired).includes('runtime.json'));
  assert.equal(desired['runtime.json'], sha256(runtimeJson({ cliPath, hostId: 'pi' })));

  await copySkillInto(io, { skillSrc, dest, cliPath, hostId: 'pi', keepSet: new Set(Object.keys(desired)) });
  const runtime = JSON.parse(await fs.readFile(join(dest, 'runtime.json'), 'utf8'));
  assert.equal(runtime.cli, cliPath);
  assert.equal(runtime.host, 'pi');
  assert.equal(await dirMatchesPostimage(io, dest, desired), true);
  await assertOwnedSkillTree(io, { skillDest: dest, postHashes: desired });

  // modified file
  await fs.writeFile(join(dest, 'SKILL.md'), 'tampered');
  const issues = [];
  await verifySkillTree(io, { skillDest: dest, postHashes: desired, issues });
  assert.ok(issues.some((i) => i.includes('skill file changed: SKILL.md')));
  await assert.rejects(
    () => assertOwnedSkillTree(io, { skillDest: dest, postHashes: desired }),
    (e) => e.code === 'OWNED_MODIFIED',
  );

  // unknown file
  await fs.writeFile(join(dest, 'extra.txt'), 'x');
  const unknown = [];
  await verifySkillTree(io, { skillDest: dest, postHashes: desired, issues: unknown });
  assert.ok(unknown.some((i) => i.includes('Unknown file')));

  // missing file
  await fs.unlink(join(dest, 'extra.txt'));
  await fs.unlink(join(dest, 'scripts', 'ccw.mjs'));
  const missing = [];
  await verifySkillTree(io, { skillDest: dest, postHashes: desired, issues: missing });
  assert.ok(missing.some((i) => i.includes('skill file missing')));
  assert.equal(await dirMatchesPostimage(io, dest, desired), false);
});

test('install core: copySkillInto prunes files outside the keep set', async () => {
  const dir = await makeTmpDir('ccw-core-prune-');
  const dest = join(dir, 'claude');
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(join(dest, 'old.txt'), 'stale');
  const desired = await desiredSkillFiles(io, { skillSrc, cliPath, hostId: 'codex' });
  await copySkillInto(io, { skillSrc, dest, cliPath, hostId: 'codex', keepSet: new Set(Object.keys(desired)) });
  const rels = (await listDirFiles(io, dest)).map((f) => f.rel).sort();
  assert.deepEqual(rels, ['SKILL.md', 'runtime.json', 'scripts/ccw.mjs']);
});

test('install core: codex record validation keeps schema 1 and rejects forgeries', async () => {
  const home = await makeTmpDir('ccw-core-codexrec-');
  const host = findHost('codex');
  const spec = {
    ...host,
    ...host.resolve({ home, env: { HOME: home }, override: join(home, '.codex'), stateDir: join(home, 'state') }),
    nodePath, mcpPath, cliPath, skillSrc,
  };
  await fs.mkdir(spec.homeDir, { recursive: true });
  const block = buildBlock(spec, nodePath, mcpPath);
  const valid = {
    schema: 1,
    blockSha256: sha256(block),
    appendedBase64: Buffer.from(block, 'utf8').toString('base64'),
    createdConfig: false,
    nodePath, mcpPath, cliPath,
    skillFiles: { 'SKILL.md': sha256('x') },
  };
  await fs.writeFile(spec.recordPath, JSON.stringify(valid));
  assert.equal((await readTomlRecord(io, spec)).schema, 1);

  for (const bad of [
    { ...valid, schema: 2 },
    { ...valid, blockSha256: 'Z'.repeat(64) },
    { ...valid, nodePath: 'relative/path' },
    { ...valid, skillFiles: { '../evil': sha256('x') } },
    { ...valid, appendedBase64: 'eA' },
    { ...valid, appendedBase64: Buffer.from('other bytes', 'utf8').toString('base64') },
  ]) {
    await fs.writeFile(spec.recordPath, JSON.stringify(bad));
    await assert.rejects(() => readTomlRecord(io, spec), (e) => e.code === 'INSTALL_CONFLICT', JSON.stringify(bad).slice(0, 80));
  }
  await fs.writeFile(spec.recordPath, 'not json');
  await assert.rejects(() => readTomlRecord(io, spec), (e) => e.code === 'INSTALL_CONFLICT');
});

test('install core: json host records bind host, paths and entry hash', async () => {
  const home = await makeTmpDir('ccw-core-jsonrec-');
  const host = findHost('dsh');
  const target = host.resolve({ home, env: { HOME: home }, stateDir: join(home, 'state') });
  const entry = host.entry({ nodePath, mcpPath });
  const valid = {
    schema: 2, host: 'dsh', format: 'json',
    configPath: target.configPath, container: ['servers'], serverName: 'claude_web',
    entrySha256: sha256(canonical(entry)),
    createdFile: false, createdContainer: false,
    nodePath, mcpPath, cliPath, skillDir: target.skillDest, skillFiles: { 'SKILL.md': sha256('x') },
  };
  assert.equal(validateHostRecord(valid, host, target).host, 'dsh');
  for (const bad of [
    { ...valid, schema: 1 },
    { ...valid, host: 'pi' },
    { ...valid, configPath: '/elsewhere/mcp.json' },
    { ...valid, container: ['mcpServers'] },
    { ...valid, container: ['servers', '../x'] },
    { ...valid, serverName: 'other' },
    { ...valid, entrySha256: sha256('wrong') },
    { ...valid, skillDir: '/elsewhere/skills/claude' },
    { ...valid, skillFiles: { '/abs/path': sha256('x') } },
  ]) {
    assert.throws(() => validateHostRecord(bad, host, target), (e) => e.code === 'INSTALL_CONFLICT', JSON.stringify(bad).slice(0, 80));
  }
});
