import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';
import { parseHomeOverrides, absoluteOn, inventory } from '../src/install/engine.mjs';
import { resolveBase } from '../scripts/install-agents.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT } from '../src/tool-contracts.mjs';

after(() => cleanupTmpDirs());

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'install-agents.mjs');

function run(args, { home, cwd = ROOT, extraEnv = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: home, ...extraEnv },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      let parsed = null;
      try {
        parsed = out.trim() ? JSON.parse(out.trim()) : null;
      } catch {
        parsed = { unparsable: out };
      }
      resolvePromise({ code, out: parsed, raw: out, err });
    });
  });
}

const readIfExists = async (p) => {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
};

test('install-agents: --list reports supported and unsupported cc-switch hosts', async () => {
  const home = await makeTmpDir('ccw-cli-list-');
  const r = await run(['--list'], { home });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.action, 'list');
  const byId = Object.fromEntries(r.out.hosts.map((h) => [h.id, h]));
  for (const id of ['codex', 'claude', 'claude-desktop', 'pi', 'dsh', 'gemini', 'opencode', 'grokbuild']) {
    assert.equal(byId[id].status, 'supported', id);
    assert.ok(byId[id].mcp.configPath.startsWith(home), `${id} path is resolved under the given home`);
    assert.equal(byId[id].mcp.serverName, 'claude_web');
  }
  for (const id of ['openclaw', 'hermes', 'mcode', 'kimi', 'agy', 'omp']) {
    assert.equal(byId[id].status, 'unsupported', id);
    assert.ok(byId[id].reason.length > 0);
    assert.equal(byId[id].mcp, undefined, `${id} exposes no write target`);
  }
});

test('install-agents: --help prints usage without side effects', async () => {
  const home = await makeTmpDir('ccw-cli-help-');
  const r = await run(['--help'], { home });
  assert.equal(r.code, 0);
  assert.match(r.raw, /--host/);
  assert.match(r.raw, /Supported hosts: codex, claude/);
  assert.equal(await readIfExists(join(home, '.claude.json')), null);
});

test('install-agents: explicit hosts install, check and uninstall', async () => {
  const home = await makeTmpDir('ccw-cli-cycle-');
  const args = ['--host', 'claude,pi', '--state-dir', join(home, 'state')];
  const installed = await run(args, { home });
  assert.equal(installed.code, 0, installed.raw);
  assert.equal(installed.out.ok, true);
  assert.deepEqual(installed.out.hosts.map((h) => h.host), ['claude', 'pi']);
  assert.ok(installed.out.hosts.every((h) => h.installed === true));
  assert.ok(await readIfExists(join(home, '.claude.json')));
  assert.ok(await readIfExists(join(home, '.pi', 'agent', 'mcp.json')));

  const checked = await run(['--check', ...args], { home });
  assert.equal(checked.code, 0, checked.raw);
  assert.ok(checked.out.hosts.every((h) => h.healthy === true));

  const removed = await run(['--uninstall', ...args], { home });
  assert.equal(removed.code, 0, removed.raw);
  assert.ok(removed.out.hosts.every((h) => h.removed === true));
  assert.equal(await readIfExists(join(home, '.claude.json')), null);
  assert.equal(await readIfExists(join(home, '.pi', 'agent', 'mcp.json')), null);
});

test('install-agents: without --host only detected hosts are touched', async () => {
  const home = await makeTmpDir('ccw-cli-detect-');
  await fs.mkdir(join(home, '.pi', 'agent'), { recursive: true });
  await fs.writeFile(join(home, '.pi', 'agent', 'mcp.json'), '{\n  "mcpServers": {}\n}\n');
  const r = await run(['--state-dir', join(home, 'state')], { home });
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.hosts.map((h) => h.host), ['pi']);
  assert.equal(await readIfExists(join(home, '.claude.json')), null, 'undetected hosts untouched');
});

test('install-agents: no detected host is a no-op with an explanatory note', async () => {
  const home = await makeTmpDir('ccw-cli-empty-');
  const r = await run([], { home });
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.hosts, []);
  assert.match(r.out.note, /--host/);
  assert.deepEqual(await fs.readdir(home), [], 'nothing created');
});

test('install-agents: --check reports an uninstalled host as a failure', async () => {
  const home = await makeTmpDir('ccw-cli-check-');
  const r = await run(['--check', '--host', 'claude', '--state-dir', join(home, 'state')], { home });
  assert.equal(r.code, 1);
  assert.equal(r.out.ok, false);
  assert.deepEqual(r.out.failed, ['claude']);
  assert.equal(r.out.hosts[0].healthy, false);
  assert.ok(r.out.hosts[0].issues.includes('install record missing'));
});

test('install-agents: one failing host does not block the others', async () => {
  const home = await makeTmpDir('ccw-cli-isolate-');
  await fs.writeFile(join(home, '.claude.json'), '{\n  "mcpServers": {\n    "claude_web": {"command": "/foreign", "args": ["x"]}\n  }\n}\n');
  const r = await run(['--host', 'claude,pi', '--state-dir', join(home, 'state')], { home });
  assert.equal(r.code, 1);
  assert.equal(r.out.ok, false);
  assert.deepEqual(r.out.failed, ['claude']);
  const claude = r.out.hosts.find((h) => h.host === 'claude');
  assert.equal(claude.error.code, 'INSTALL_CONFLICT');
  const pi = r.out.hosts.find((h) => h.host === 'pi');
  assert.equal(pi.installed, true);
  assert.ok(await readIfExists(join(home, '.pi', 'agent', 'mcp.json')));
  assert.match(r.err, /claude failed: INSTALL_CONFLICT/);
  assert.ok((await fs.readFile(join(home, '.claude.json'), 'utf8')).includes('/foreign'), 'foreign entry untouched');
});

test('install-agents: --dry-run writes nothing at all', async () => {
  const home = await makeTmpDir('ccw-cli-dry-');
  const r = await run(['--all', '--dry-run', '--state-dir', join(home, 'state')], { home });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.dryRun, true);
  assert.ok(r.out.hosts.every((h) => h.wouldInstall === true));
  assert.deepEqual(await fs.readdir(home), []);
});

test('install-agents: --all installs every supported host', async () => {
  const home = await makeTmpDir('ccw-cli-all-');
  const r = await run(['--all', '--state-dir', join(home, 'state')], { home });
  assert.equal(r.code, 0, r.raw);
  assert.deepEqual(r.out.hosts.map((h) => h.host), [
    'codex', 'claude', 'claude-desktop', 'pi', 'dsh', 'gemini', 'opencode', 'grokbuild',
  ]);
  assert.ok(r.out.hosts.every((h) => h.installed === true), r.raw);
  const sourceSkill = await fs.readFile(join(ROOT, 'skills', 'claude', 'SKILL.md'), 'utf8');
  const hosts = inventory({ home, env: { HOME: home }, platform: process.platform, stateDir: join(home, 'state') });
  const withSkills = hosts.filter(host => host.skills);
  assert.equal(withSkills.length, 6);
  for (const host of withSkills) {
    const copied = await fs.readFile(join(host.skills.dir, 'claude', 'SKILL.md'), 'utf8');
    assert.equal(copied, sourceSkill, `${host.id} must receive the full current skill`);
    assert.ok(copied.includes(EXECUTABLE_GUIDANCE_CONTRACT), `${host.id} must receive the exact guidance block`);
  }
});

test('install-agents: invalid combinations and unknown hosts fail closed', async () => {
  const home = await makeTmpDir('ccw-cli-invalid-');
  const both = await run(['--check', '--uninstall'], { home });
  assert.equal(both.code, 1);
  assert.equal(both.out.error.code, 'INVALID_ARGUMENT');

  const unknownHost = await run(['--host', 'nope'], { home });
  assert.equal(unknownHost.code, 1);
  assert.match(unknownHost.out.error.message, /Unknown host/);
  const probes = await run(['--check', '--probe', '--discover', '--host', 'pi'], { home });
  assert.equal(probes.code, 1);
  assert.equal(probes.out.error.code, 'INVALID_ARGUMENT');
  const dryRun = await run(['--check', '--discover', '--dry-run', '--host', 'pi'], { home });
  assert.equal(dryRun.code, 1);
  assert.equal(dryRun.out.error.code, 'INVALID_ARGUMENT');

  const badHome = await run(['--host', 'pi', '--home', 'pi=relative'], { home });
  assert.equal(badHome.code, 1);
  assert.match(badHome.out.error.message, /absolute/);

  const badFlag = await run(['--nonsense'], { home });
  assert.equal(badFlag.code, 1);
  assert.equal(badFlag.out.error.code, 'INVALID_ARGUMENT');
});

test('install-agents: per-host --home redirects a single host', async () => {
  const home = await makeTmpDir('ccw-cli-home-');
  const custom = join(home, 'custom-pi');
  const r = await run(['--host', 'pi', '--home', `pi=${custom}`, '--state-dir', join(home, 'state')], { home });
  assert.equal(r.code, 0, r.raw);
  assert.ok(await readIfExists(join(custom, 'mcp.json')));
  assert.ok(await readIfExists(join(custom, 'skills', 'claude', 'SKILL.md')));
  assert.equal(await readIfExists(join(home, '.pi', 'agent', 'mcp.json')), null);
});

test('install-agents: a vanished host with a live record is still checked and cleaned', async () => {
  const home = await makeTmpDir('ccw-cli-stale-');
  const state = join(home, 'state');
  const installed = await run(['--host', 'pi', '--state-dir', state], { home });
  assert.equal(installed.code, 0, installed.raw);
  assert.ok(await readIfExists(join(state, 'installs', 'pi.json')), 'record exists');

  // the user uninstalls the host itself
  await fs.rm(join(home, '.pi'), { recursive: true, force: true });

  const checked = await run(['--check', '--state-dir', state], { home });
  assert.equal(checked.code, 1, 'a stale install must fail the check instead of being skipped');
  assert.equal(checked.out.ok, false);
  assert.deepEqual(checked.out.hosts.map((h) => h.host), ['pi']);
  assert.deepEqual(checked.out.failed, ['pi']);
  assert.equal(checked.out.hosts[0].installed, true);
  assert.ok(checked.out.hosts[0].issues.includes('mcpServers.claude_web is not registered'));
  assert.match(checked.err, /pi failed: UNHEALTHY/);

  const removed = await run(['--uninstall', '--state-dir', state], { home });
  assert.equal(removed.code, 0, removed.raw);
  assert.deepEqual(removed.out.hosts.map((h) => h.host), ['pi']);
  assert.equal(removed.out.hosts[0].removed, true);
  assert.deepEqual(await fs.readdir(join(state, 'installs')), [], 'record reclaimed');
});

test('install-agents: default install does not resurrect a vanished host', async () => {
  const home = await makeTmpDir('ccw-cli-noresurrect-');
  const state = join(home, 'state');
  await run(['--host', 'pi', '--state-dir', state], { home });
  await fs.rm(join(home, '.pi'), { recursive: true, force: true });

  const reinstalled = await run(['--state-dir', state], { home });
  assert.equal(reinstalled.code, 0, reinstalled.raw);
  assert.deepEqual(reinstalled.out.hosts, [], 'install only targets hosts that are present');
  assert.equal(await readIfExists(join(home, '.pi', 'agent', 'mcp.json')), null, 'config is not recreated');
  assert.ok(await readIfExists(join(state, 'installs', 'pi.json')), 'the record is left for check/uninstall to report');
});

test('install-agents: a relative --state-dir is refused instead of scattering records', async () => {
  const home = await makeTmpDir('ccw-cli-relstate-');
  const cwd = await makeTmpDir('ccw-cli-relcwd-');
  const r = await run(['--host', 'pi', '--state-dir', 'relstate'], { home, cwd });
  assert.equal(r.code, 1, r.raw);
  assert.equal(r.out.error.code, 'INVALID_ARGUMENT');
  assert.match(r.out.error.message, /--state-dir must be an absolute path/);
  assert.deepEqual(await fs.readdir(cwd), [], 'nothing is written into the working directory');
  assert.equal(await readIfExists(join(home, '.pi', 'agent', 'mcp.json')), null, 'no host config written');
});

test('install-agents: a relative CCW_STATE_DIR is refused and names its source', async () => {
  const home = await makeTmpDir('ccw-cli-relenv-');
  const cwd = await makeTmpDir('ccw-cli-relenv-cwd-');
  const r = await run(['--host', 'pi'], { home, cwd, extraEnv: { CCW_STATE_DIR: 'relative/state' } });
  assert.equal(r.code, 1, r.raw);
  assert.equal(r.out.error.code, 'INVALID_ARGUMENT');
  assert.match(r.out.error.message, /CCW_STATE_DIR must be an absolute path/);
  assert.deepEqual(await fs.readdir(cwd), []);
});

test('install-agents: absolute-path acceptance follows the running platform', () => {
  // `C:\x` is absolute on win32 and not on posix — a `/` prefix check is wrong.
  assert.equal(absoluteOn('win32')('C:\\Users\\x\\.pi\\agent'), true);
  assert.equal(absoluteOn('linux')('C:\\Users\\x\\.pi\\agent'), false);
  assert.equal(absoluteOn('linux')('/home/x/.pi/agent'), true);
  assert.equal(absoluteOn('darwin')('/Users/x/.pi/agent'), true);
  assert.equal(absoluteOn('win32')('relative\\path'), false);

  assert.deepEqual(parseHomeOverrides(['pi=C:\\Users\\x\\.pi\\agent'], 'win32'), { pi: 'C:\\Users\\x\\.pi\\agent' });
  assert.throws(() => parseHomeOverrides(['pi=C:\\Users\\x\\.pi\\agent'], 'linux'), /absolute directory/);
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.throws(() => parseHomeOverrides(['pi=relative/dir'], platform), /absolute directory/, platform);
  }
});

test('install-agents: resolveBase rejects a relative state dir from either source', () => {
  assert.equal(resolveBase({ env: { HOME: '/h' }, stateDir: '/abs/state' }).stateDir, '/abs/state');
  assert.throws(() => resolveBase({ env: { HOME: '/h' }, stateDir: 'rel' }), /--state-dir must be an absolute path/);
  assert.throws(() => resolveBase({ env: { HOME: '/h', CCW_STATE_DIR: 'rel' } }), /CCW_STATE_DIR must be an absolute path/);
  assert.equal(resolveBase({ env: { HOME: '/h', CCW_STATE_DIR: '/env/state' } }).stateDir, '/env/state');
  assert.equal(resolveBase({ env: { HOME: '/h' } }).stateDir, join('/h', '.local', 'share', 'claude-web-api'));
  assert.throws(() => resolveBase({ env: { HOME: 'relative' }, stateDir: '/abs/state' }), /HOME must be an absolute/);
  assert.throws(() => resolveBase({ env: { HOME: '/bad\0home' }, stateDir: '/abs/state' }), /HOME must be an absolute/);
});
