import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { defaultIo, sha256 } from '../src/install/atomic.mjs';
import { findHost, installHost, checkHost, sourcePaths } from '../src/install/engine.mjs';
import { reconcileHost } from '../src/install/reconcile.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());
const paths = sourcePaths();
const io = defaultIo();
async function fixture(id = 'codex') {
  const home = await fs.realpath(await makeTmpDir('ccw-reconcile-'));
  const host = findHost(id);
  const target = host.resolve({ home, env: { HOME: home }, platform: process.platform, stateDir: join(home, 'state') });
  return { home, host, target, deps: { ...paths, io, home } };
}
async function put(path, text) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text, { mode: 0o600 });
}
async function snapshot(root, rel = '') {
  const entries = {};
  for (const item of await fs.readdir(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, item.name), full = join(root, path);
    const stat = await fs.lstat(full);
    entries[path] = { mode: stat.mode & 0o777, type: item.isDirectory() ? 'dir' : item.isSymbolicLink() ? 'link' : 'file',
      ...(item.isFile() ? { hash: sha256(await fs.readFile(full)) } : {}), ...(item.isSymbolicLink() ? { target: await fs.readlink(full) } : {}) };
    if (item.isDirectory()) Object.assign(entries, await snapshot(root, path));
  }
  return entries;
}
async function cli(f, args) {
  const child = spawn(process.execPath, [join(paths.sourceRoot, 'scripts/install-agents.mjs'), ...args, '--state-dir', f.target.stateDir], {
    env: { HOME: f.home, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { errors += d; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  return { code, out: JSON.parse(output), errors };
}
const orphan = 'model = "keep-model"\n# >>> claude-web-api >>>\n\n[permissions]\nallow = ["keep-byte-for-byte"]\n';
const restored = orphan.replace('# >>> claude-web-api >>>\n', '');

test('reconcile: actual CLI preview is zero-write, then removes only the exact orphan comment and verifies private backups', async () => {
  const f = await fixture(); await put(f.target.configPath, orphan);
  const before = await snapshot(f.home);
  const preview = await cli(f, ['--host', 'codex', '--reconcile', '--dry-run']);
  assert.equal(preview.code, 0, JSON.stringify(preview));
  assert.equal(preview.out.action, 'reconcile'); assert.equal(preview.out.dryRun, true);
  assert.equal(preview.out.hosts[0].actions[0].kind, 'remove-orphan-start-marker');
  assert.deepEqual(await snapshot(f.home), before);
  const executed = await cli(f, ['--host', 'codex', '--reconcile']);
  assert.equal(executed.code, 0, JSON.stringify(executed));
  assert.equal(executed.out.hosts[0].changed, true);
  assert.equal(await fs.readFile(f.target.configPath, 'utf8'), restored);
  const backup = executed.out.hosts[0].recoveryPath;
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(backup, 'config.preimage'))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(join(backup, 'config.preimage'), 'utf8'), orphan);
  assert.equal(await fs.readFile(join(backup, 'COMMITTED'), 'utf8'), 'verified\n');
  const journal = JSON.parse(await fs.readFile(join(backup, 'journal.json'), 'utf8'));
  assert.equal(journal.files[0].sha256, sha256(orphan));
  assert.equal(journal.postimage.configSha256, sha256(restored));
  const second = await cli(f, ['--host', 'codex', '--reconcile']);
  assert.equal(second.code, 0); assert.equal(second.out.hosts[0].changed, false);
  assert.equal((await fs.readdir(join(f.target.stateDir, 'install-recovery'))).length, 1);
});

test('reconcile: CRLF and EOF orphan lines preserve every remaining byte', async () => {
  for (const [input, expected] of [[orphan.replaceAll('\n', '\r\n'), restored.replaceAll('\n', '\r\n')], ['model = "x"\n# >>> claude-web-api >>>', 'model = "x"\n']]) {
    const f = await fixture(); await put(f.target.configPath, input);
    const result = await reconcileHost(f.host, f.target, f.deps);
    assert.equal(result.changed, true); assert.equal(await fs.readFile(f.target.configPath, 'utf8'), expected);
  }
});

test('reconcile: stray end, paired/duplicate markers, ambiguous content or live registrations never authorize deletion', async () => {
  const inputs = [
    '# <<< claude-web-api <<<\n', '# >>> claude-web-api >>>\n# <<< claude-web-api <<<\n',
    '# >>> claude-web-api >>>\n# >>> claude-web-api >>>\n', '# >>> claude-web-api >>>\nkey = "user-owned"\n',
    `# >>> claude-web-api >>>\n[mcp_servers.claude_web]\ncommand = ${JSON.stringify(paths.nodePath)}\nargs = [${JSON.stringify(paths.mcpPath)}]\n`,
  ];
  for (const input of inputs) {
    const f = await fixture(); await put(f.target.configPath, input); const before = await snapshot(f.home);
    await assert.rejects(() => reconcileHost(f.host, f.target, f.deps), e => e.code === 'RECONCILE_CONFLICT');
    assert.deepEqual(await snapshot(f.home), before);
    await assert.rejects(() => installHost(f.host, f.target, { ...f.deps, dryRun: true }), e => e.code === 'INSTALL_CONFLICT');
  }
});

async function stale(f) {
  await installHost(f.host, f.target, f.deps);
  const record = await fs.readFile(f.target.recordPath, 'utf8');
  if (f.target.skillDest) await fs.rm(f.target.skillDest, { recursive: true });
  await fs.unlink(f.target.configPath);
  return record;
}

test('reconcile: valid stale records retire only after registrations and skill destinations are absent', async () => {
  for (const id of ['codex', 'claude', 'claude-desktop', 'grokbuild']) {
    const f = await fixture(id); const record = await stale(f);
    const before = await snapshot(f.home);
    const preview = await reconcileHost(f.host, f.target, { ...f.deps, dryRun: true });
    assert.equal(preview.actions[0].kind, 'retire-stale-install-record');
    assert.deepEqual(await snapshot(f.home), before);
    const result = await reconcileHost(f.host, f.target, f.deps);
    assert.equal(result.changed, true);
    await assert.rejects(() => fs.access(f.target.recordPath));
    assert.equal(await fs.readFile(join(result.recoveryPath, 'record.preimage'), 'utf8'), record);
    assert.equal((await checkHost(f.host, f.target, f.deps)).installed, false);
  }
});

test('reconcile: malformed, unknown-runtime, still-live and skill-surviving records are refused without writes', async () => {
  for (const mode of ['malformed', 'unknown-runtime', 'live', 'skill']) {
    const f = await fixture('pi');
    await installHost(f.host, f.target, f.deps);
    if (mode === 'malformed') await fs.writeFile(f.target.recordPath, '{"schema":999}');
    else if (mode === 'unknown-runtime') {
      await fs.rm(f.target.skillDest, { recursive: true }); await fs.unlink(f.target.configPath);
      const record = JSON.parse(await fs.readFile(f.target.recordPath, 'utf8'));
      record.cliPath = join(f.home, 'unknown/bin/ccw.mjs');
      await fs.writeFile(f.target.recordPath, JSON.stringify(record));
    } else if (mode === 'skill') await fs.unlink(f.target.configPath);
    const before = await snapshot(f.home);
    await assert.rejects(() => reconcileHost(f.host, f.target, f.deps), e => ['INSTALL_CONFLICT', 'RECONCILE_CONFLICT'].includes(e.code));
    assert.deepEqual(await snapshot(f.home), before, mode);
  }
});

test('reconcile: a linked config, linked skill, ancestor link or record link is never followed for recovery', async () => {
  for (const mode of ['config', 'skill', 'parent', 'record']) {
    const f = await fixture(); await put(f.target.configPath, orphan);
    const external = await fixture(); await put(external.target.configPath, 'model = "external"\n');
    if (mode === 'config') { await fs.unlink(f.target.configPath); await fs.symlink(external.target.configPath, f.target.configPath); }
    if (mode === 'skill') { await fs.mkdir(f.target.skillsDir); await fs.symlink(external.home, f.target.skillDest); }
    if (mode === 'parent') {
      const saved = join(f.home, 'real-codex'); await fs.rename(f.target.homeDir, saved); await fs.symlink(saved, f.target.homeDir);
    }
    if (mode === 'record') await fs.symlink(external.target.configPath, f.target.recordPath);
    const before = await snapshot(f.home), outside = await snapshot(external.home);
    await assert.rejects(() => reconcileHost(f.host, f.target, f.deps), e => e.code === 'UNSAFE_PATH');
    assert.deepEqual(await snapshot(f.home), before); assert.deepEqual(await snapshot(external.home), outside);
  }
});

test('reconcile: check/preview refuses installer and consultation locks, never clearing or guessing their PIDs', async () => {
  for (const name of ['installer', 'ccw.lock', 'ccw-recovery.lock', 'api.lock', 'api-recovery.lock', `alias-${'a'.repeat(64)}.lock`, `alias-${'b'.repeat(64)}.recovery.lock`]) {
    const f = await fixture(); await put(f.target.configPath, orphan);
    const lock = name === 'installer' ? f.target.lockPath : join(f.target.stateDir, name);
    await put(lock, '{"pid":999999,"token":"foreign-lock"}');
    const before = await snapshot(f.home);
    for (const dryRun of [true, false]) await assert.rejects(() => reconcileHost(f.host, f.target, { ...f.deps, dryRun }), e => e.code === 'INSTALL_BUSY');
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('reconcile: concurrent preimage edits after backup abort, retain private recovery and leave editor bytes intact', async () => {
  const f = await fixture(); await put(f.target.configPath, orphan);
  let changed = false;
  const injected = { ...io, rename: async (a, b) => {
    await io.rename(a, b);
    if (b.endsWith('/journal.json')) { await fs.writeFile(f.target.configPath, 'model = "edited"\n'); changed = true; }
  } };
  await assert.rejects(() => reconcileHost(f.host, f.target, { ...f.deps, io: injected }), error => {
    assert.equal(error.code, 'CONFIG_CHANGED'); assert.ok(error.details.recoveryPath); return true;
  });
  assert.equal(changed, true); assert.equal(await fs.readFile(f.target.configPath, 'utf8'), 'model = "edited"\n');
  const backups = await fs.readdir(join(f.target.stateDir, 'install-recovery'));
  assert.equal(await fs.readFile(join(f.target.stateDir, 'install-recovery', backups[0], 'config.preimage'), 'utf8'), orphan);
  await assert.rejects(() => fs.access(f.target.lockPath));
});

test('reconcile: partial I/O failure after mutation retains accurate recovery material and exits nonzero', async () => {
  const f = await fixture(); await put(f.target.configPath, orphan);
  const injected = { ...io, rename: async (a, b) => {
    if (b.endsWith('/COMMITTED')) throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
    return io.rename(a, b);
  } };
  await assert.rejects(() => reconcileHost(f.host, f.target, { ...f.deps, io: injected }), error => {
    assert.equal(error.code, 'EIO'); assert.ok(error.details.recoveryPath); return true;
  });
  assert.equal(await fs.readFile(f.target.configPath, 'utf8'), restored);
  const [backup] = await fs.readdir(join(f.target.stateDir, 'install-recovery'));
  assert.equal(await fs.readFile(join(f.target.stateDir, 'install-recovery', backup, 'config.preimage'), 'utf8'), orphan);
  await assert.rejects(() => fs.access(join(f.target.stateDir, 'install-recovery', backup, 'COMMITTED')));
  await assert.rejects(() => fs.access(f.target.lockPath));
});

test('reconcile: failed preimage backup is reported with its retained path and never changes targets', async () => {
  const f = await fixture(); await put(f.target.configPath, orphan);
  const injected = { ...io, open: async (path, ...args) => {
    if (path.endsWith('/config.preimage')) throw Object.assign(new Error('injected backup failure'), { code: 'EIO' });
    return io.open(path, ...args);
  } };
  await assert.rejects(() => reconcileHost(f.host, f.target, { ...f.deps, io: injected }), e => e.code === 'EIO' && e.details.backupIncomplete && Boolean(e.details.recoveryPath));
  assert.equal(await fs.readFile(f.target.configPath, 'utf8'), orphan);
});

test('reconcile: BOM is never silently stripped from a user configuration', async () => {
  const f = await fixture(); const original = '\ufeff' + orphan;
  await put(f.target.configPath, original);
  try { await reconcileHost(f.host, f.target, f.deps); }
  catch (error) { assert.ok(['CONFIG_INVALID', 'RECONCILE_CONFLICT'].includes(error.code)); return; }
  assert.equal(await fs.readFile(f.target.configPath, 'utf8'), '\ufeff' + restored);
});

test('reconcile: actual CLI failure isolation, invalid action combinations and no-op recovery', async () => {
  const f = await fixture(); await put(f.target.configPath, '# <<< claude-web-api <<<\n');
  const result = await cli(f, ['--host', 'codex,pi', '--reconcile', '--dry-run']);
  assert.equal(result.code, 1); assert.equal(result.out.hosts[0].error.code, 'RECONCILE_CONFLICT');
  assert.equal(result.out.hosts[1].ok, true); assert.equal(result.out.hosts[1].changed, false);
  for (const args of [['--reconcile', '--check'], ['--reconcile', '--uninstall']]) {
    const bad = await cli(f, args); assert.equal(bad.code, 1); assert.equal(bad.out.error.code, 'INVALID_ARGUMENT');
  }
  const empty = await fixture('pi'); const before = await snapshot(empty.home);
  assert.equal((await cli(empty, ['--host', 'pi', '--reconcile'])).code, 0);
  assert.deepEqual(await snapshot(empty.home), before);
});
