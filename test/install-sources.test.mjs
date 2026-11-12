import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { defaultIo, sha256 } from '../src/install/atomic.mjs';
import { findHost, sourcePaths, installHost, checkHost, uninstallHost } from '../src/install/engine.mjs';
import { inspectSources, localHubUrl, parseSourceJson, readSourceFile } from '../src/install/sources.mjs';
import { run } from '../scripts/install-agents.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());
const io = defaultIo();
const paths = sourcePaths();
const CLI = join(paths.sourceRoot, 'scripts/install-agents.mjs');
async function fixture(id = 'pi') {
  const home = await makeTmpDir('ccw-sources-');
  const host = findHost(id);
  const target = host.resolve({ home, env: { HOME: home }, platform: 'linux', stateDir: join(home, 'state') });
  return { home, host, target, deps: { ...paths, home, io } };
}
async function put(path, text, mode = 0o600) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, text, { mode });
}
function hostText(f, entries) {
  if (f.host.format === 'toml') return Object.entries(entries).map(([name, entry]) => `[mcp_servers.${name}]\n` + Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n').join('\n');
  const doc = { unrelated: 'untouched' };
  let cursor = doc;
  for (const key of f.host.container) cursor = cursor[key] = {};
  Object.assign(cursor, entries);
  return JSON.stringify(doc, null, 2) + '\n';
}
async function hub(f, { url = `http://127.0.0.1:3425/mcp/magpie/hub/${f.host.id}`, entries = {}, library = {}, entry = {} } = {}) {
  await put(f.target.configPath, hostText(f, { magpie: { url, ...entry }, ...entries }));
  await put(join(f.home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true, mcp: [{ name: 'claude_web', transport: 'stdio', command: paths.nodePath, args: [paths.mcpPath], agents: [f.host.id] }], ...library }));
}
async function snapshot(root, rel = '') {
  const result = {};
  for (const item of await fs.readdir(join(root, rel), { withFileTypes: true })) {
    const path = join(rel, item.name);
    const st = await fs.lstat(join(root, path));
    result[path] = { type: item.isDirectory() ? 'dir' : item.isSymbolicLink() ? 'link' : 'file', mode: st.mode & 0o777,
      ...(item.isFile() ? { hash: sha256(await fs.readFile(join(root, path))) } : {}), ...(item.isSymbolicLink() ? { link: await fs.readlink(join(root, path)) } : {}) };
    if (item.isDirectory()) Object.assign(result, await snapshot(root, path));
  }
  return result;
}
async function command(f, args) {
  let out = '', err = '';
  const code = await run(args, { env: { HOME: f.home }, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } } });
  return { code, out: JSON.parse(out), err };
}
async function child(f, args) {
  const p = spawn(process.execPath, [CLI, ...args], { env: { HOME: f.home, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', data => { out += data; }); p.stderr.on('data', data => { err += data; });
  const code = await new Promise((resolve, reject) => { p.on('error', reject); p.on('exit', resolve); });
  return { code, out: JSON.parse(out), err };
}

test('sources: all supported config shapes recognize an external Magpie route without taking ownership', async () => {
  for (const id of ['codex', 'claude', 'claude-desktop', 'pi', 'dsh', 'gemini', 'opencode', 'grokbuild']) {
    const f = await fixture(id);
    await hub(f);
    const before = await snapshot(f.home);
    const checked = await checkHost(f.host, f.target, f.deps);
    assert.equal(checked.healthy, true, JSON.stringify(checked));
    assert.equal(checked.installed, false);
    assert.equal(checked.configured, true);
    assert.equal(checked.source.kind, 'magpie-hub');
    assert.equal(checked.source.verification, 'configuration-only');
    assert.ok(!checked.issues.includes('install record missing'));
    for (const dryRun of [true, false]) {
      const result = await installHost(f.host, f.target, { ...f.deps, dryRun });
      assert.equal(result.skippedExternal, true);
      assert.equal(result.changed, false);
    }
    assert.deepEqual(await snapshot(f.home), before, id + ' must not create locks, skills, records or backups');
    await assert.rejects(() => fs.access(f.target.recordPath));
  }
});

test('sources: --check reports a manager-owned stale skill copy without adopting, writing or refreshing it', async () => {
  const f = await fixture(); await hub(f);
  const skill = join(f.target.skillsDir, 'claude');
  await fs.mkdir(skill, { recursive: true });
  const current = await fs.readFile(join(paths.skillSrc, 'SKILL.md'), 'utf8');
  const staleText = `${current}\nmanager-owned edit\n`;
  await fs.writeFile(join(skill, 'SKILL.md'), staleText, { mode: 0o600 });
  for (const { rel } of [{ rel: 'scripts/ccw.mjs' }]) {
    const source = join(paths.skillSrc, rel);
    await fs.mkdir(dirname(join(skill, rel)), { recursive: true });
    await fs.copyFile(source, join(skill, rel));
  }
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.configured, true);
  assert.equal(checked.installed, false);
  assert.equal(checked.healthy, true, 'external skill freshness is separate evidence from route/config health');
  assert.equal(checked.externalSkill.status, 'stale');
  assert.deepEqual(checked.externalSkill.mismatches, ['SKILL.md']);
  assert.ok(checked.issues.some(issue => issue.includes('manager-owned skill copy differs')));
  assert.equal(await fs.readFile(join(skill, 'SKILL.md'), 'utf8'), staleText, 'check must not rewrite the manager copy');
  assert.equal((await installHost(f.host, f.target, f.deps)).skippedExternal, true);
  assert.equal(await fs.readFile(join(skill, 'SKILL.md'), 'utf8'), staleText, 'install must not adopt the manager copy');
});

test('sources: shared Magpie skills expose a stale linked copy regardless of the host assignment', async () => {
  const f = await fixture();
  await hub(f, { library: { sharedSkills: true,
    skills: [{ name: 'claude', agents: ['claude'] }] } });
  const librarySkill = join(f.home, '.config/magpie/library/skills/claude');
  const sharedSkill = join(f.home, '.agents/skills/claude');
  await fs.mkdir(librarySkill, { recursive: true });
  await fs.mkdir(dirname(sharedSkill), { recursive: true });
  await fs.symlink(librarySkill, sharedSkill);
  const current = await fs.readFile(join(paths.skillSrc, 'SKILL.md'), 'utf8');
  const staleText = `${current}\nmanager-owned edit\n`;
  await fs.writeFile(join(librarySkill, 'SKILL.md'), staleText, { mode: 0o600 });
  for (const { rel } of [{ rel: 'scripts/ccw.mjs' }]) {
    await fs.mkdir(dirname(join(librarySkill, rel)), { recursive: true });
    await fs.copyFile(join(paths.skillSrc, rel), join(librarySkill, rel));
  }
  const before = await snapshot(f.home);
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.healthy, true, 'shared skill freshness is separate evidence from route/config health');
  assert.equal(checked.externalSkill.status, 'stale');
  assert.equal(checked.externalSkill.shared, true);
  assert.equal(checked.externalSkill.managerOwned, true);
  assert.equal(checked.externalSkill.linkExists, true);
  assert.equal(checked.externalSkill.skillRoot, await fs.realpath(librarySkill));
  assert.equal(checked.externalSkill.via, sharedSkill);
  assert.deepEqual(checked.externalSkill.mismatches, ['SKILL.md']);
  assert.ok(checked.issues.some(issue => issue.includes('manager-owned skill copy differs')));
  assert.deepEqual(await snapshot(f.home), before);
});

test('sources: sharedSkills:false does not follow the shared directory as host evidence', async () => {
  const f = await fixture();
  await hub(f, { library: { sharedSkills: false,
    skills: [{ name: 'claude', agents: [f.host.id] }] } });
  const librarySkill = join(f.home, '.config/magpie/library/skills/claude');
  const sharedSkill = join(f.home, '.agents/skills/claude');
  await fs.mkdir(librarySkill, { recursive: true });
  await fs.mkdir(dirname(sharedSkill), { recursive: true });
  await fs.symlink(librarySkill, sharedSkill);
  await fs.writeFile(join(librarySkill, 'SKILL.md'), 'stale\n', { mode: 0o600 });
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.externalSkill.status, 'missing');
  assert.equal(checked.externalSkill.shared, undefined);
});

test('sources: a hub route named claude_web is one source, not a fictitious direct+hub conflict', async () => {
  const f = await fixture(); await hub(f);
  await put(f.target.configPath, hostText(f, { claude_web: { url: 'http://127.0.0.1:3425/mcp/magpie/hub/pi' } }));
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.healthy, true); assert.equal(checked.source.kind, 'magpie-hub');
  assert.equal((await installHost(f.host, f.target, f.deps)).skippedExternal, true);
});

test('sources: empty historical marker does not hide a valid external hub or permit normal direct adoption', async () => {
  const f = await fixture('codex'); await hub(f);
  await fs.appendFile(f.target.configPath, '# >>> claude-web-api >>>\n');
  const before = await snapshot(f.home);
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.healthy, true); assert.equal(checked.source.kind, 'magpie-hub');
  assert.ok(checked.source.recoveryIssues.length);
  assert.equal((await installHost(f.host, f.target, f.deps)).skippedExternal, true);
  assert.deepEqual(await snapshot(f.home), before);
  await put(f.target.configPath, '# >>> claude-web-api >>>\n');
  await fs.unlink(join(f.home, '.config/magpie/library.json'));
  await assert.rejects(() => installHost(f.host, f.target, f.deps), e => e.code === 'INSTALL_CONFLICT');
});

test('sources: actual CLI does not duplicate hub entries, and --all still reports genuinely uninstalled hosts', async () => {
  const f = await fixture(); await hub(f);
  const before = await snapshot(f.home);
  for (const args of [['--check', '--host', 'pi'], ['--dry-run', '--host', 'pi'], ['--host', 'pi']]) {
    const result = await child(f, args);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out.hosts[0].source.kind, 'magpie-hub');
  }
  const all = await child(f, ['--check', '--all']);
  assert.equal(all.code, 1);
  assert.equal(all.out.hosts.find(h => h.host === 'pi').healthy, true);
  assert.equal(all.out.hosts.find(h => h.host === 'grokbuild').healthy, false);
  assert.deepEqual(await snapshot(f.home), before);
});

test('sources: whole HOME isolation keeps Magpie Library and host overrides in one fixture', async () => {
  const f = await fixture('codex');
  const override = await makeTmpDir('ccw-sources-override-');
  const target = f.host.resolve({ home: f.home, env: { HOME: f.home }, platform: 'linux', stateDir: join(f.home, 'state'), override });
  const url = 'http://127.0.0.1:3425/mcp/magpie/hub/codex';
  await put(target.configPath, hostText({ host: f.host, target }, { magpie: { url } }));
  await put(join(f.home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true,
    mcp: [{ name: 'claude_web', transport: 'stdio', command: paths.nodePath, args: [paths.mcpPath], agents: ['codex'] }] }));
  const result = await child(f, ['--check', '--host', 'codex', '--home', `codex=${override}`]);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.hosts[0].source.kind, 'magpie-hub');
  assert.equal(result.out.hosts[0].healthy, true);
  assert.equal(result.out.hosts[0].configPath, target.configPath);
});

test('sources: a host-directory-only override cannot disagree with the shared Magpie Library', async () => {
  // --home host=DIR only overrides that host's config directory; the Magpie
  // Library is still read from the process HOME. If the shared Library
  // declares the magpie hub for this host but the overridden host config has
  // no active hub route, the source must be `unknown`, not silently healthy.
  const f = await fixture('codex');
  const override = await makeTmpDir('ccw-sources-override-');
  const target = f.host.resolve({ home: f.home, env: { HOME: f.home }, platform: 'linux', stateDir: join(f.home, 'state'), override });
  const url = `http://127.0.0.1:3425/mcp/magpie/hub/${f.host.id}`;
  await put(target.configPath, hostText({ host: f.host, target }, { magpie: { url } }));
  await put(join(f.home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true,
    mcp: [{ name: 'claude_web', transport: 'stdio', command: paths.nodePath, args: [paths.mcpPath], agents: ['codex'] }] }));
  // The shared Library and the active hub route agree, so the isolated host
  // directory still resolves healthy under --home.
  const healthy = await child(f, ['--check', '--host', 'codex', '--home', `codex=${override}`]);
  assert.equal(healthy.code, 0, healthy.err);
  assert.equal(healthy.out.hosts[0].source.kind, 'magpie-hub');
  assert.equal(healthy.out.hosts[0].healthy, true);

  // Drop the active hub route from the overridden host config while the shared
  // Library still declares it: declaration and active route now disagree.
  await put(target.configPath, hostText({ host: f.host, target }, {}));
  const disagree = await child(f, ['--check', '--host', 'codex', '--home', `codex=${override}`]);
  assert.equal(disagree.code, 1, disagree.err);
  assert.equal(disagree.out.hosts[0].source.kind, 'unknown');
  assert.equal(disagree.out.hosts[0].healthy, false);
  assert.ok(disagree.out.hosts[0].issues.some(issue => issue.includes('do not agree')));
});

test('sources: trusted external direct and Library direct routes are configured, never adopted or removed', async () => {
  for (const id of ['codex', 'claude-desktop', 'opencode']) {
    const f = await fixture(id);
    const entry = id === 'opencode' ? { type: 'local', command: [paths.nodePath, paths.mcpPath] } : { command: paths.nodePath, args: [paths.mcpPath] };
    await put(f.target.configPath, hostText(f, { claude_web: entry }));
    assert.equal((await checkHost(f.host, f.target, f.deps)).source.kind, 'external-direct');
    await hub(f, { library: { mcpHub: false } });
    await put(f.target.configPath, hostText(f, { claude_web: entry }));
    const before = await snapshot(f.home);
    const result = await installHost(f.host, f.target, f.deps);
    assert.equal(result.source.kind, 'magpie-direct');
    assert.equal(result.skippedExternal, true);
    assert.deepEqual(await snapshot(f.home), before);
    await assert.rejects(() => uninstallHost(f.host, f.target, { ...f.deps, dryRun: true }), e => e.code === 'INSTALL_CONFLICT');
  }
});

test('sources: exact installed shim is recognized without executing arbitrary scripts', async () => {
  const f = await fixture('claude-desktop');
  const shim = join(f.home, 'bin/ccw-mcp');
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  await put(shim, `#!/bin/sh\nexec ${quote(paths.nodePath)} ${quote(paths.mcpPath)} "$@"\n`, 0o755);
  await put(f.target.configPath, hostText(f, { claude_web: { command: shim, args: [] } }));
  assert.equal((await checkHost(f.host, f.target, f.deps)).source.route.shimVerified, true);
  await put(f.target.configPath, hostText(f, { claude_web: { command: shim } }));
  const omitted = await checkHost(f.host, f.target, f.deps);
  assert.equal(omitted.healthy, true, 'a manager may omit the empty args list');
  assert.equal(omitted.source.route.shimVerified, true);
  await fs.appendFile(shim, '# changed\n');
  assert.equal((await checkHost(f.host, f.target, f.deps)).healthy, false);
});

test('sources: basename impostors, unknown, disabled and malformed direct routes fail closed', async () => {
  const f = await fixture();
  const fake = join(f.home, 'impostor/src/mcp-server.mjs');
  await put(fake, 'throw new Error("must never run");');
  for (const entry of [null, {}, { command: '/foreign', args: [] }, { command: paths.nodePath, args: [fake] },
    { command: paths.nodePath, args: [paths.mcpPath], enabled: false }, { command: paths.nodePath, args: [paths.mcpPath], disabled: true },
    { command: paths.nodePath, args: [paths.mcpPath], enabled: 'yes' }, { command: paths.nodePath, args: ['--eval', 'dangerous'] },
    { command: paths.nodePath, args: null }, { command: paths.nodePath, args: '' }, { command: paths.nodePath }]) {
    await put(f.target.configPath, hostText(f, { claude_web: entry }));
    const before = await snapshot(f.home);
    const checked = await checkHost(f.host, f.target, f.deps);
    assert.equal(checked.healthy, false);
    await assert.rejects(() => installHost(f.host, f.target, f.deps), e => e.code === 'INSTALL_CONFLICT');
    assert.deepEqual(await snapshot(f.home), before);
  }
});

test('sources: Library checkmarks/cache alone and fake or disabled routes are not healthy', async () => {
  const f = await fixture();
  for (const options of [{ entry: { enabled: false } }, { entry: { disabled: true } }, { entry: { enabled: 'yes' } },
    { url: 'https://127.0.0.1:3425/mcp/magpie/hub/pi' }, { url: 'http://127.0.0.1:3425/mcp/magpie/hub/claude' },
    { url: 'http://remote.example:3425/mcp/magpie/hub/pi' }, { url: 'http://127.0.0.1:3425/mcp/magpie/hub/pi?token=secret' },
    { library: { mcp: [] } }, { library: { applied: { pi: { mcp: ['magpie'] } }, mcp: [] } }]) {
    await hub(f, options);
    const checked = await checkHost(f.host, f.target, f.deps);
    assert.equal(checked.healthy, false, JSON.stringify(options));
  }
  await hub(f);
  await put(f.target.configPath, hostText(f, {}));
  assert.equal((await checkHost(f.host, f.target, f.deps)).healthy, false);
});

test('sources: duplicate delivery, record + hub and duplicate Library definitions are explicit conflicts', async () => {
  const f = await fixture();
  for (const entries of [{ second: { url: 'http://127.0.0.1:3425/mcp/magpie/hub/pi' } }, { claude_web: { command: paths.nodePath, args: [paths.mcpPath] } }]) {
    await hub(f, { entries });
    const checked = await checkHost(f.host, f.target, f.deps);
    assert.equal(checked.source.kind, 'conflict'); assert.equal(checked.healthy, false);
    await assert.rejects(() => installHost(f.host, f.target, f.deps), e => e.code === 'INSTALL_CONFLICT');
  }
  await hub(f); await put(f.target.recordPath, '{}');
  assert.equal((await checkHost(f.host, f.target, f.deps)).source.kind, 'conflict');
  await fs.unlink(f.target.recordPath);
  await hub(f, { library: { mcp: [{ name: 'claude_web' }, { name: 'claude_web' }] } });
  await assert.rejects(() => checkHost(f.host, f.target, f.deps), e => e.code === 'SOURCE_CONFLICT');
});

test('sources: JSON duplicate keys (including inside arrays) and malformed JSON/TOML are rejected without content disclosure', async () => {
  for (const raw of ['{"mcpServers":{},"mcpServers":{}}', '{"mcpServers":{},"a":[{"name":"x","name":"y"}]}', '{"secret":"do-not-echo",}']) {
    assert.throws(() => parseSourceJson(raw), e => e.code === 'CONFIG_INVALID' && !e.message.includes('do-not-echo'));
  }
  const f = await fixture(); await put(f.target.configPath, '{"secret":"do-not-echo",}');
  const result = await command(f, ['--check', '--host', 'pi,gemini']);
  assert.equal(result.code, 1);
  assert.equal(result.out.hosts.length, 2, 'one parse failure does not abort the next host');
  assert.equal(result.out.hosts[0].error.code, 'CONFIG_INVALID');
  assert.equal(result.out.hosts[1].healthy, false);
  assert.ok(!JSON.stringify(result).includes('do-not-echo'));
  const t = await fixture('codex'); await put(t.target.configPath, 'secret = "do-not-echo"\n[mcp_servers.');
  await assert.rejects(() => checkHost(t.host, t.target, t.deps), e => e.code === 'CONFIG_INVALID' && !e.message.includes('do-not-echo'));
});

test('sources: only exact loopback URLs are eligible, never aliases, credentials, query, normalization or external URLs', () => {
  assert.equal(localHubUrl('http://127.0.0.1:3425/mcp/magpie/hub/pi', 'pi'), 'http://127.0.0.1:3425/mcp/magpie/hub/pi');
  assert.equal(localHubUrl('http://[::1]:3425/mcp/magpie/hub/pi', 'pi'), 'http://[::1]:3425/mcp/magpie/hub/pi');
  for (const url of ['http://127.0.0.2:3425/mcp/magpie/hub/pi', 'http://127.1:3425/mcp/magpie/hub/pi',
    'http://user:secret@127.0.0.1:3425/mcp/magpie/hub/pi', 'http://127.0.0.1:3425/x/../mcp/magpie/hub/pi',
    'http://127.0.0.1:3425/mcp/magpie/hub/pi/', 'http://localhost:3425/mcp/magpie/hub/pi#x', 'http://localhost:65536/mcp/magpie/hub/pi']) {
    assert.equal(localHubUrl(url, 'pi'), null, url);
  }
});

test('sources: safe linked external config is read-only; link escape, Library link, unsafe mode and size are rejected', async () => {
  const f = await fixture(); await hub(f);
  const saved = join(f.home, 'managed/pi.json');
  await fs.mkdir(dirname(saved), { recursive: true }); await fs.rename(f.target.configPath, saved); await fs.symlink(saved, f.target.configPath);
  const before = await snapshot(f.home);
  assert.equal((await checkHost(f.host, f.target, f.deps)).source.configLinked, true);
  assert.equal((await installHost(f.host, f.target, f.deps)).skippedExternal, true);
  assert.deepEqual(await snapshot(f.home), before);
  const outside = await fixture(); await hub(outside);
  await fs.unlink(f.target.configPath); await fs.symlink(outside.target.configPath, f.target.configPath);
  await assert.rejects(() => checkHost(f.host, f.target, f.deps), e => e.code === 'UNSAFE_PATH');
  await fs.unlink(f.target.configPath); await fs.symlink(saved, f.target.configPath);
  const lib = join(f.home, '.config/magpie/library.json');
  await fs.rename(lib, lib + '.real'); await fs.symlink(lib + '.real', lib);
  await assert.rejects(() => inspectSources(f.host, f.target, f.deps), e => e.code === 'UNSAFE_PATH');
  await fs.unlink(lib); await fs.rename(lib + '.real', lib);
  await fs.chmod(saved, 0o666);
  await assert.rejects(() => checkHost(f.host, f.target, f.deps), e => e.code === 'UNSAFE_PATH');
  await fs.chmod(saved, 0o600); await fs.writeFile(saved, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(() => checkHost(f.host, f.target, f.deps), e => e.code === 'UNSAFE_PATH');
});

test('sources: changed file/parent paths and invalid UTF-8 are refused, and read descriptors close', async () => {
  const f = await fixture(); await hub(f);
  let closes = 0;
  const racedIo = { ...io, open: async (...args) => {
    const handle = await io.open(...args);
    if (args[0].endsWith('/mcp.json')) {
      await fs.appendFile(f.target.configPath, ' ');
      return new Proxy(handle, { get: (h, key) => key === 'close' ? async () => { closes++; await h.close(); } : typeof h[key] === 'function' ? h[key].bind(h) : h[key] });
    }
    return handle;
  } };
  await assert.rejects(() => checkHost(f.host, f.target, { ...f.deps, io: racedIo }), e => e.code === 'CONFIG_CHANGED');
  assert.equal(closes, 1);
  await fs.writeFile(f.target.configPath, Buffer.from([0xff, 0xfe]));
  await assert.rejects(() => readSourceFile(io, f.target.configPath), e => e.code === 'CONFIG_INVALID');
});

test('sources: installer-owned installs still validate records and report modified entries, never external-health shortcuts', async () => {
  const f = await fixture();
  const installed = await installHost(f.host, f.target, f.deps);
  assert.equal(installed.sourceBefore.kind, 'none', 'pre-write provenance is explicitly labeled, not returned as current source');
  assert.equal(installed.source, undefined);
  const checked = await checkHost(f.host, f.target, f.deps);
  assert.equal(checked.healthy, true); assert.equal(checked.source.kind, 'installer');
  const doc = JSON.parse(await fs.readFile(f.target.configPath, 'utf8'));
  doc.mcpServers.claude_web.args = ['/tampered'];
  await fs.writeFile(f.target.configPath, JSON.stringify(doc));
  assert.equal((await checkHost(f.host, f.target, f.deps)).healthy, false);
  await assert.rejects(() => installHost(f.host, f.target, f.deps), e => e.code === 'OWNED_MODIFIED');
});

test('sources: manager config changes between inspection and adapter preflight cannot cause duplicate registration', async () => {
  for (const id of ['pi', 'codex']) {
    const f = await fixture(id);
    let changed = false;
    const racedIo = { ...io, open: async (path, ...args) => {
      if (path === f.target.lockPath && !changed) {
        changed = true;
        await put(f.target.configPath, hostText(f, { magpie: { url: `http://127.0.0.1:3425/mcp/magpie/hub/${id}` } }));
      }
      return io.open(path, ...args);
    } };
    await assert.rejects(() => installHost(f.host, f.target, { ...f.deps, io: racedIo }), e => e.code === 'CONFIG_CHANGED');
    const config = await fs.readFile(f.target.configPath, 'utf8');
    assert.ok(config.includes('magpie')); assert.ok(!config.includes('claude_web'));
    await assert.rejects(() => fs.access(f.target.recordPath));
  }
});

test('sources: default detection failures are isolated per host and never abort remaining checks', async () => {
  const f = await fixture(); await hub(f);
  let output = '';
  const failedPath = join(f.home, '.claude.json');
  const injected = { ...io, lstat: async path => {
    if (path === failedPath) throw Object.assign(new Error('must not echo private data'), { code: 'EACCES' });
    return io.lstat(path);
  } };
  const code = await run(['--check'], { env: { HOME: f.home }, io: injected, stdout: { write: s => { output += s; } }, stderr: { write: () => {} } });
  assert.equal(code, 1);
  const result = JSON.parse(output);
  assert.equal(result.hosts.find(h => h.host === 'claude').error.code, 'SOURCE_UNREADABLE');
  assert.equal(result.hosts.find(h => h.host === 'pi').healthy, true);
  assert.ok(!output.includes('must not echo private data'));
});

test('sources: orphan managed markers without a record are not adopted even when they point to this runtime', async () => {
  const f = await fixture('codex');
  const text = `# >>> claude-web-api >>>\n[mcp_servers.claude_web]\ncommand = ${JSON.stringify(paths.nodePath)}\nargs = [${JSON.stringify(paths.mcpPath)}]\n# <<< claude-web-api <<<\n`;
  await put(f.target.configPath, text);
  assert.equal((await checkHost(f.host, f.target, f.deps)).healthy, false);
  await assert.rejects(() => installHost(f.host, f.target, f.deps), e => e.code === 'INSTALL_CONFLICT');
});
