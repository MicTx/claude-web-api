import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildRelease } from '../scripts/build-release.mjs';
import { readRelease, pack, MAX_PAYLOAD } from '../src/release/archive.mjs';
import { transaction, fileImage } from '../src/release/install-fs.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
async function temp() { const p = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ccw-release-install-'))); dirs.push(p); return p; }
after(async () => { for (const p of dirs) await fs.rm(p, { recursive: true, force: true }); });
const hash = b => createHash('sha256').update(b).digest('hex');
const built = await buildRelease({ outDir: await temp() });
const bash = join(built.outDir, 'install.sh');
const bytes = await fs.readFile(built.archivePath);
const argsFor = (path = built.archivePath, digest = hash(bytes), version = built.version) => ['--archive', path, '--sha256', digest, '--version', version];
async function run(home, args, extra = {}) {
  const options = { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...extra }, timeout: 15000, maxBuffer: 1024 * 1024 };
  let code = 0, stdout = '', stderr = '';
  try { ({ stdout, stderr } = await exec('bash', [bash, ...args], options)); }
  catch (error) { code = error.code; stdout = error.stdout ?? ''; stderr = error.stderr ?? ''; }
  let data;
  try { data = JSON.parse(stdout); } catch { data = null; }
  return { code, stdout, stderr, data };
}
const runtime = home => join(home, '.local/share/claude-web-api/runtime');
const present = path => fs.lstat(path).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
async function fixture(version, modify) {
  const { files } = readRelease(bytes, built.version);
  files.set('package.json', { mode: 0o644, bytes: Buffer.from(JSON.stringify({ name: 'claude-web-api', version, type: 'module' })) });
  if (modify) modify(files);
  const manifest = { schema: 1, name: 'claude-web-api', version, files: [...files].filter(([path]) => path !== 'release.json').map(([path, f]) => ({ path, mode: f.mode, size: f.bytes.length, sha256: hash(f.bytes) })) };
  files.set('release.json', { mode: 0o644, bytes: Buffer.from(JSON.stringify(manifest)) });
  const archive = pack([...files].map(([path, f]) => ({ path: `claude-web-api-v${version}/${path}`, ...f })));
  const path = join(await temp(), `fixture-v${version}.tar.gz`);
  await fs.writeFile(path, archive);
  return { path, digest: hash(archive), archive };
}
async function http(handler, fn) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('release install: published Bash is valid; the source copy refuses consumption', async () => {
  await exec('bash', ['-n', bash]);
  const help = await run(await temp(), ['--help']);
  assert.equal(help.code, 0, help.stderr);
  for (const option of ['--release-url', '--archive', '--dry-run', '--status', '--rollback']) assert.ok(help.stdout.includes(option));
  await assert.rejects(exec('bash', [join(ROOT, 'install.sh'), '--help']), e => e.code === 64 && /verified Release/.test(e.stderr));
  const bootstrap = (await fs.readFile(bash, 'utf8')).split("<<'CCW_RELEASE_PROGRAM'")[0];
  assert.ok(!bootstrap.includes('CCW_NODE_COMMAND'), 'published Bash must not require a private launcher variable');
  assert.match(bootstrap, /exec node --input-type=module/);
});

test('release install: local preview validates bytes but makes no filesystem changes', async () => {
  const home = await temp();
  const r = await run(home, [...argsFor(), '--dry-run']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.data.artifactVerified, true);
  assert.deepEqual(await fs.readdir(home), []);
  const missing = await run(home, ['--archive', built.archivePath]);
  assert.equal(missing.code, 1);
  assert.equal(missing.data.error.code, 'INVALID_ARGUMENT');
});

test('release install: a green --check --probe clears the reconnect marker', async () => {
  const home = await temp();
  const prefix = join(home, 'runtime');
  const bin = join(home, 'bin');
  const env = { PATH: process.env.PATH, HOME: home };
  const install = await run(home, [...argsFor(), '--prefix', prefix, '--bin-dir', bin]);
  assert.equal(install.code, 0, install.stdout);
  const marker = join(prefix, 'reconnect-required');
  assert.equal(await present(marker), true);
  const envCli = { PATH: process.env.PATH, HOME: home, CCW_CDP_URL: 'http://127.0.0.1:1' };
  const cliStatus = () => exec(join(bin, 'ccw'), ['--status', '--prefix', prefix], { cwd: home, env: envCli });
  const cliMarker = JSON.parse((await cliStatus()).stdout);
  assert.equal(cliMarker.reconnectRequired, true);
  assert.equal(cliMarker.reconnectVersion, built.version);
  const status = await run(home, ['--status', '--prefix', prefix]);
  assert.equal(status.data.reconnectRequired, true);
  assert.equal(status.data.reconnectVersion, built.version);
  // An externally-owned, verified direct route whose bounded probe succeeds
  // proves the host already reaches the installed release; the marker clears.
  const desktopDir = join(home, 'desktop');
  await fs.mkdir(desktopDir);
  await fs.writeFile(join(desktopDir, 'claude_desktop_config.json'),
    JSON.stringify({ mcpServers: { claude_web: { command: join(bin, 'ccw-mcp'), args: [] } } }), { mode: 0o600 });
  const check = await exec(join(bin, 'ccw-hosts'),
    ['--check', '--probe', '--host', 'claude-desktop', '--home', `claude-desktop=${desktopDir}`], { cwd: home, env });
  const checked = JSON.parse(check.stdout);
  const host = checked.hosts[0];
  assert.equal(host.probe.ok, true, check.stdout);
  assert.equal(checked.reconnectCleared, true);
  assert.equal(checked.reconnectMarker, 'cleared');
  assert.equal(await present(marker), false);
  const cleared = await run(home, ['--status', '--prefix', prefix]);
  assert.equal(cleared.data.reconnectRequired, false);
  assert.equal(cleared.data.reconnectVersion, undefined);
  const clearedCli = JSON.parse((await cliStatus()).stdout);
  assert.equal(clearedCli.reconnectRequired, false);
  assert.equal(clearedCli.reconnectVersion, undefined);
  const repeat = JSON.parse((await exec(join(bin, 'ccw-hosts'),
    ['--check', '--probe', '--host', 'claude-desktop', '--home', `claude-desktop=${desktopDir}`], { cwd: home, env })).stdout);
  assert.equal(repeat.reconnectCleared, false);
  assert.equal(repeat.reconnectMarker, 'absent');
  assert.equal(repeat.warning, undefined);
});

test('release install: status refuses an unsafe reconnect marker', async () => {
  const home = await temp();
  const prefix = join(home, 'runtime');
  const bin = join(home, 'bin');
  const install = await run(home, [...argsFor(), '--prefix', prefix, '--bin-dir', bin]);
  assert.equal(install.code, 0, install.stdout);
  const marker = join(prefix, 'reconnect-required');
  const status = () => run(home, ['--status', '--prefix', prefix]);
  assert.equal((await status()).data.reconnectRequired, true);
  const cliStatus = () => exec(join(bin, 'ccw'), ['--status', '--prefix', prefix], { cwd: home,
    env: { PATH: process.env.PATH, HOME: home, CCW_CDP_URL: 'http://127.0.0.1:1' } });
  assert.equal(JSON.parse((await cliStatus()).stdout).reconnectRequired, true);

  await fs.unlink(marker);
  await fs.symlink(join(home, 'elsewhere'), marker);
  const symlink = await status();
  assert.equal(symlink.code, 1);
  assert.equal(symlink.data.error.code, 'UNSAFE_PATH');
  const symlinkCli = await cliStatus().catch(error => error);
  assert.equal(JSON.parse(symlinkCli.stdout).error.code, 'UNSAFE_PATH');
  await fs.unlink(marker);
  await fs.writeFile(marker, 'x'.repeat(257));
  const oversized = await status();
  assert.equal(oversized.code, 1);
  assert.equal(oversized.data.error.code, 'UNSAFE_PATH');
  const oversizedCli = await cliStatus().catch(error => error);
  assert.equal(JSON.parse(oversizedCli.stdout).error.code, 'UNSAFE_PATH');
  await fs.writeFile(marker, `${built.version}\n`);
  assert.equal((await status()).data.reconnectVersion, built.version);
  assert.equal(JSON.parse((await cliStatus()).stdout).reconnectVersion, built.version);
  const desktopDir = join(home, 'desktop');
  await fs.mkdir(desktopDir);
  await fs.writeFile(join(desktopDir, 'claude_desktop_config.json'),
    JSON.stringify({ mcpServers: { claude_web: { command: join(bin, 'ccw-mcp'), args: [] } } }), { mode: 0o600 });
  const probe = () => exec(join(bin, 'ccw-hosts'),
    ['--check', '--probe', '--host', 'claude-desktop', '--home', `claude-desktop=${desktopDir}`],
    { cwd: home, env: { PATH: process.env.PATH, HOME: home } });
  const healthyProbe = JSON.parse((await probe()).stdout);
  assert.equal(healthyProbe.reconnectCleared, true);
  assert.equal(healthyProbe.reconnectMarker, 'cleared');
  assert.equal(await present(marker), false);

  await fs.symlink(join(home, 'elsewhere'), marker);
  const unsafeProbe = JSON.parse((await probe()).stdout);
  assert.equal(unsafeProbe.reconnectCleared, false);
  assert.equal(unsafeProbe.reconnectMarker, 'failed');
  assert.equal(unsafeProbe.warning, 'reconnect marker cleanup did not complete; see reconnectMarker');
  assert.equal((await fs.lstat(marker)).isSymbolicLink(), true);
});

test('release install: independent prefixes and quoted paths run real commands and preserve state', async () => {
  const home = await temp();
  const prefix = join(home, "runtime's folder");
  const bin = join(home, "bin's folder");
  const sentinel = join(home, '.pi/agent/mcp.json');
  await fs.mkdir(dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, '{"unrelated":"preserve"}\n');
  const r = await run(home, [...argsFor(), '--prefix', prefix, '--bin-dir', bin]);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.data.registeredHosts, false);
  assert.equal(await fs.readlink(join(prefix, 'current')), `releases/v${built.version}`);
  assert.equal(await fs.readFile(sentinel, 'utf8'), '{"unrelated":"preserve"}\n');
  const env = { PATH: process.env.PATH, HOME: home };
  const cli = await exec(join(bin, 'ccw'), ['--help'], { cwd: home, env });
  assert.match(cli.stdout, /Usage/);
  const cliStatus = JSON.parse((await exec(join(bin, 'ccw'), ['--status', '--prefix', prefix, '--bin-dir', bin], { cwd: home, env })).stdout);
  assert.equal(cliStatus.ok, true);
  assert.equal(cliStatus.action, 'status');
  assert.equal(cliStatus.installed, true);
  assert.equal(cliStatus.version, built.version);
  assert.equal(cliStatus.binDir, bin);
  const wrongBin = join(home, 'wrong-bin');
  await fs.mkdir(wrongBin);
  const ownerStatus = JSON.parse((await exec(join(bin, 'ccw'), ['--status', '--prefix', prefix, '--bin-dir', wrongBin], { cwd: home, env })).stdout);
  assert.equal(ownerStatus.ok, true);
  assert.equal(ownerStatus.installed, true);
  assert.equal(ownerStatus.binDir, bin, 'installed status reports the verified owner binDir, not the display override');
  const hosts = await exec(join(bin, 'ccw-hosts'), ['--host', 'codex'], { cwd: home, env });
  assert.equal(JSON.parse(hosts.stdout).ok, true, hosts.stderr);
  const config = await fs.readFile(join(home, '.codex/config.toml'), 'utf8');
  assert.ok(config.includes(join(prefix, 'current/src/mcp-server.mjs')));
  assert.ok(!config.includes(ROOT));
  const skillRuntime = JSON.parse(await fs.readFile(join(home, '.codex/skills/claude/runtime.json'), 'utf8'));
  assert.equal(skillRuntime.cli, join(prefix, 'current/bin/ccw.mjs'));
  const status = await run(home, ['--status', '--prefix', prefix]);
  assert.equal(status.code, 0, status.stdout);
  assert.equal(status.data.version, built.version);
  assert.equal(status.data.reconnectRequired, true);
  assert.equal(status.data.reconnectVersion, built.version);
  assert.equal((await fs.stat(join(prefix, 'install.json'))).mode & 0o777, 0o600);
  // Manager-owned consumers use the installed stable ccw-mcp command with no
  // arguments, not an imitation basename or a source-tree path.
  const desktopDir = join(home, 'desktop'); await fs.mkdir(desktopDir);
  for (const managerEntry of [{ command: join(bin, 'ccw-mcp'), args: [] }, { command: join(bin, 'ccw-mcp') }]) {
    await fs.writeFile(join(desktopDir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { claude_web: managerEntry } }), { mode: 0o600 });
    const check = await exec(join(bin, 'ccw-hosts'), ['--check', '--probe', '--host', 'claude-desktop', '--home', `claude-desktop=${desktopDir}`], { cwd: home, env });
    const external = JSON.parse(check.stdout).hosts[0];
    assert.equal(external.installed, false); assert.equal(external.source.kind, 'external-direct');
    assert.equal(external.source.route.shimVerified, true); assert.equal(external.probe.ok, true);
  }
  // Magpie serializes empty argv with omitempty, both in the Library backend
  // and in the Desktop entry. A real bundled host CLI must accept that form.
  await fs.mkdir(join(home, '.config/magpie'), { recursive: true });
  await fs.writeFile(join(home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true,
    mcp: [{ name: 'claude_web', transport: 'stdio', command: join(bin, 'ccw-mcp'), agents: ['pi'] }] }), { mode: 0o600 });
  const hubHome = join(home, 'hub-pi'); await fs.mkdir(hubHome);
  await fs.writeFile(join(hubHome, 'mcp.json'), JSON.stringify({ mcpServers: { magpie: { url: 'http://127.0.0.1:3425/mcp/magpie/hub/pi' } } }), { mode: 0o600 });
  const hub = await exec(join(bin, 'ccw-hosts'), ['--check', '--host', 'pi', '--home', `pi=${hubHome}`], { cwd: home, env });
  const hubResult = JSON.parse(hub.stdout).hosts[0];
  assert.equal(hubResult.source.kind, 'magpie-hub');
  assert.equal(hubResult.healthy, true);
  assert.equal(hubResult.installed, false);
  assert.equal(hubResult.externalSkill.status, 'missing', 'absent external skill is reported, not treated as stale or refreshed');
});

test('release install: check reports an external-manager stale skill copy without refreshing it', async () => {
  const home = await temp();
  assert.equal((await run(home, argsFor())).code, 0);
  const binDir = join(home, '.local/bin');
  const hubHome = join(home, 'hub-pi');
  await fs.mkdir(join(home, '.config/magpie'), { recursive: true });
  await fs.mkdir(hubHome, { recursive: true });
  const copy = join(hubHome, 'skills/claude');
  await fs.mkdir(copy, { recursive: true });
  await fs.cp(join(runtime(home), 'current/skills/claude'), copy, { recursive: true });
  const skillFile = join(copy, 'SKILL.md');
  const stale = `${await fs.readFile(skillFile, 'utf8')}\nmanager edit\n`;
  await fs.writeFile(skillFile, stale, { mode: 0o600 });
  await fs.writeFile(join(home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true,
    mcp: [{ name: 'claude_web', transport: 'stdio', command: join(binDir, 'ccw-mcp'), agents: ['pi'] }] }), { mode: 0o600 });
  await fs.writeFile(join(hubHome, 'mcp.json'), JSON.stringify({ mcpServers: { magpie: { url: 'http://127.0.0.1:3425/mcp/magpie/hub/pi' } } }), { mode: 0o600 });
  let check;
  check = JSON.parse((await exec(join(binDir, 'ccw-hosts'), ['--check', '--host', 'pi', '--home', `pi=${hubHome}`],
    { cwd: home, env: { PATH: process.env.PATH, HOME: home } })).stdout);
  const result = check.hosts[0];
  assert.equal(result.source.kind, 'magpie-hub');
  assert.equal(result.installed, false);
  assert.equal(result.healthy, true, 'external skill freshness must not suppress diagnostics');
  assert.equal(result.externalSkill.status, 'stale');
  assert.deepEqual(result.externalSkill.mismatches, ['SKILL.md']);
  assert.equal(await fs.readFile(skillFile, 'utf8'), stale, 'check must not refresh a manager-owned copy');
});

test('release install: published check reports a stale shared Magpie skill link regardless of assignment', async () => {
  const home = await temp();
  assert.equal((await run(home, argsFor())).code, 0);
  const binDir = join(home, '.local/bin');
  const hubHome = join(home, 'hub-pi');
  const librarySkill = join(home, '.config/magpie/library/skills/claude');
  const sharedSkill = join(home, '.agents/skills/claude');
  await fs.mkdir(librarySkill, { recursive: true });
  await fs.mkdir(dirname(sharedSkill), { recursive: true });
  await fs.mkdir(hubHome, { recursive: true });
  await fs.symlink(librarySkill, sharedSkill);
  await fs.cp(join(runtime(home), 'current/skills/claude'), librarySkill, { recursive: true });
  const skillFile = join(librarySkill, 'SKILL.md');
  const stale = `${await fs.readFile(skillFile, 'utf8')}\nmanager edit\n`;
  await fs.writeFile(skillFile, stale, { mode: 0o600 });
  await fs.writeFile(join(home, '.config/magpie/library.json'), JSON.stringify({ mcpHub: true, sharedSkills: true,
    skills: [{ name: 'claude', agents: ['claude'] }],
    mcp: [{ name: 'claude_web', transport: 'stdio', command: join(binDir, 'ccw-mcp'), agents: ['pi'] }] }), { mode: 0o600 });
  await fs.writeFile(join(hubHome, 'mcp.json'), JSON.stringify({ mcpServers: { magpie: { url: 'http://127.0.0.1:3425/mcp/magpie/hub/pi' } } }), { mode: 0o600 });
  const check = JSON.parse((await exec(join(binDir, 'ccw-hosts'), ['--check', '--host', 'pi', '--home', `pi=${hubHome}`],
    { cwd: home, env: { PATH: process.env.PATH, HOME: home } })).stdout);
  const result = check.hosts[0];
  assert.equal(result.source.kind, 'magpie-hub');
  assert.equal(result.healthy, true);
  assert.equal(result.externalSkill.status, 'stale');
  assert.equal(result.externalSkill.shared, true);
  assert.equal(result.externalSkill.managerOwned, true);
  assert.equal(result.externalSkill.linkExists, true);
  assert.deepEqual(result.externalSkill.mismatches, ['SKILL.md']);
  assert.equal(await fs.readFile(skillFile, 'utf8'), stale);
  assert.equal(await fs.readlink(sharedSkill), librarySkill);
});

test('release install: commands and managed hosts survive a Node runtime upgrade', async () => {
  const home = await temp();
  const fakeBin = join(home, 'fake-bin');
  await fs.mkdir(fakeBin);
  const oldNode = join(fakeBin, 'old-node');
  const newNode = join(fakeBin, 'new-node');
  await fs.symlink(process.execPath, oldNode);
  await fs.symlink(process.execPath, newNode);
  const pathDir = join(home, 'path-bin');
  await fs.mkdir(pathDir);
  const command = join(pathDir, 'node');
  await fs.symlink(oldNode, command);
  const upgradedEnv = { ...process.env, PATH: `${pathDir}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, CODEX_HOME: join(home, '.codex') };
  const installed = await run(home, argsFor(), upgradedEnv);
  assert.equal(installed.code, 0, installed.stdout);
  assert.equal(installed.data.registeredHosts, false);
  for (const name of ['ccw', 'ccw-mcp', 'ccw-hosts']) {
    const shim = await fs.readFile(join(home, '.local/bin', name), 'utf8');
    assert.ok(shim.includes("exec 'node'"), `${name} shim must resolve node at launch`);
    assert.ok(!shim.includes(process.execPath), `${name} shim must not persist a versioned physical path`);
  }
  const owner = JSON.parse(await fs.readFile(join(runtime(home), 'install.json'), 'utf8'));
  assert.ok(!JSON.stringify(owner).includes(process.execPath));
  const hosts = join(home, '.local/bin/ccw-hosts');
  assert.equal((await exec(hosts, ['--host', 'codex'], { cwd: home, env: upgradedEnv })).stdout.includes('"ok":true'), true);
  const config = await fs.readFile(join(home, '.codex/config.toml'), 'utf8');
  assert.match(config, /command = "node"/);
  assert.ok(!config.includes(process.execPath));
  await fs.unlink(oldNode);
  await fs.unlink(command);
  await fs.symlink(newNode, command);
  const cli = await exec(join(home, '.local/bin/ccw'), ['--help'], { cwd: home, env: upgradedEnv });
  assert.match(cli.stdout, /Usage/);
  const checked = await exec(hosts, ['--check', '--host', 'codex'], { cwd: home, env: upgradedEnv });
  assert.equal(JSON.parse(checked.stdout).hosts[0].healthy, true, checked.stdout + checked.stderr);
  const probed = await exec(hosts, ['--check', '--probe', '--host', 'codex'], { cwd: home, env: upgradedEnv });
  assert.equal(JSON.parse(probed.stdout).hosts[0].probe.ok, true, probed.stdout + probed.stderr);
});

test('release install: immutable versions, idempotence, upgrades and reversible rollback', async () => {
  const home = await temp();
  const first = await run(home, argsFor());
  assert.equal(first.code, 0, first.stdout);
  const repeat = await run(home, argsFor());
  assert.equal(repeat.code, 0, repeat.stdout);
  assert.equal(repeat.data.changed, false);
  const nextVersion = built.version.split('.').map((part, index) => index === 2 ? String(Number(part) + 1) : part).join('.');
  const next = await fixture(nextVersion);
  const upgrade = await run(home, argsFor(next.path, next.digest, nextVersion));
  assert.equal(upgrade.code, 0, upgrade.stdout);
  assert.equal(upgrade.data.previous, built.version);
  const beforePreview = await fs.readlink(join(runtime(home), 'current'));
  const preview = await run(home, ['--rollback', '--dry-run']);
  assert.equal(preview.code, 0);
  assert.equal(await fs.readlink(join(runtime(home), 'current')), beforePreview);
  const rolled = await run(home, ['--rollback']);
  assert.equal(rolled.code, 0, rolled.stdout);
  assert.equal(rolled.data.version, built.version);
  const forward = await run(home, ['--rollback']);
  assert.equal(forward.data.version, nextVersion);
  const changed = await fixture(nextVersion, files => files.get('README.md').bytes = Buffer.from('different release bytes'));
  const refused = await run(home, argsFor(changed.path, changed.digest, nextVersion));
  assert.equal(refused.data.error.code, 'VERSION_CONFLICT');
  assert.equal(await fs.readlink(join(runtime(home), 'current')), `releases/v${nextVersion}`);
});

test('release install: an external manager skill copy falls back to the independent CLI, not a guessed wrapper', async () => {
  const home = await temp();
  assert.equal((await run(home, argsFor())).code, 0);
  const current = join(runtime(home), 'current/skills/claude');
  const copy = join(home, 'manager/skills/claude');
  await fs.mkdir(dirname(copy), { recursive: true });
  await fs.cp(current, copy, { recursive: true });
  await assert.rejects(fs.access(join(copy, 'runtime.json')));
  const text = await fs.readFile(join(copy, 'SKILL.md'), 'utf8');
  assert.match(text, /管理器复制的技能不一定有 runtime\.json/);
  assert.match(text, /\"\$HOME\/\.local\/bin\/ccw\" doctor/);
  const env = { PATH: process.env.PATH, HOME: home };
  const help = await exec(join(home, '.local/bin/ccw'), ['--help'], { cwd: home, env });
  assert.match(help.stdout, /Usage/);
  await assert.rejects(exec(process.execPath, [join(copy, 'scripts/ccw.mjs'), '--help'], { cwd: home, env }),
    error => /ERR_MODULE_NOT_FOUND/.test(error.stderr));
});

test('release install: version-specific host wrapper cannot replace stable current bindings', async () => {
  const home = await temp();
  assert.equal((await run(home, argsFor())).code, 0);
  const env = { PATH: process.env.PATH, HOME: home };
  const hosts = join(home, '.local/bin/ccw-hosts');
  await exec(hosts, ['--host', 'codex,pi'], { cwd: home, env });
  const wrapper = join(runtime(home), 'releases', `v${built.version}`, 'scripts/install-agents.mjs');
  const paths = [join(home, '.codex/config.toml'), join(home, '.codex/skills/claude/runtime.json'),
    join(home, '.pi/agent/mcp.json'), join(home, '.pi/agent/skills/claude/runtime.json')];
  const original = await Promise.all(paths.map(path => fs.readFile(path, 'utf8')));
  for (const id of ['codex', 'pi']) {
    const check = await exec(process.execPath, [wrapper, '--check', '--host', id], { cwd: home, env });
    assert.equal(JSON.parse(check.stdout).hosts[0].healthy, true, id);
    const preview = await exec(process.execPath, [wrapper, '--dry-run', '--host', id], { cwd: home, env });
    assert.equal(JSON.parse(preview.stdout).hosts[0].alreadyInstalled, true, id);
    const probe = await exec(process.execPath, [wrapper, '--check', '--probe', '--host', id], { cwd: home, env });
    const diagnostic = JSON.parse(probe.stdout).hosts[0].probe;
    assert.equal(diagnostic.ok, true, id);
    assert.equal(diagnostic.hostLoaded, false);
    assert.equal(diagnostic.claudeSent, false);
    let discover;
    await assert.rejects(() => exec(process.execPath, [wrapper, '--check', '--discover', '--host', id], { cwd: home, env }),
      error => { discover = JSON.parse(error.stdout); return true; });
    const discovery = discover.hosts[0].discovery;
    assert.equal(discovery.ok, false, id);
    assert.equal(discovery.error.code, 'DISCOVERY_ROUTE_REFUSED', id);
    assert.equal(discovery.claudeSent, false, id);
    const repeat = await exec(process.execPath, [wrapper, '--host', id], { cwd: home, env });
    assert.equal(JSON.parse(repeat.stdout).hosts[0].alreadyInstalled, true, id);
  }
  assert.deepEqual(await Promise.all(paths.map(path => fs.readFile(path, 'utf8'))), original);
  const internal = join(runtime(home), 'releases', `v${built.version}`, 'src/install/entry.mjs');
  for (const args of [['--check', '--host', 'codex'], ['--host', 'codex']]) {
    await assert.rejects(exec(process.execPath, [internal, ...args], { cwd: home, env }), error => {
      assert.match(error.stderr, /use.*scripts\/install-agents\.mjs/i);
      return true;
    });
    assert.deepEqual(await Promise.all(paths.map(path => fs.readFile(path, 'utf8'))), original);
  }
  const imported = `import { pathToFileURL } from 'node:url';
    const mod = await import(pathToFileURL(process.env.CCW_INTERNAL).href);
    process.exitCode = await mod.run(['--host', 'gemini'], { sourceRoot: process.env.CCW_VERSION_ROOT });`;
  const importedEnv = { ...env, CCW_INTERNAL: internal, CCW_VERSION_ROOT: dirname(dirname(dirname(internal))) };
  const viaImport = await exec(process.execPath, ['--input-type=module', '-e', imported], { cwd: home, env: importedEnv });
  assert.equal(JSON.parse(viaImport.stdout).hosts[0].installed, true);
  const importedRecord = JSON.parse(await fs.readFile(join(home, '.local/share/claude-web-api/installs/gemini.json'), 'utf8'));
  assert.equal(importedRecord.cliPath, join(runtime(home), 'current/bin/ccw.mjs'));
  assert.equal(importedRecord.mcpPath, join(runtime(home), 'current/src/mcp-server.mjs'));
  const linkedInternal = join(runtime(home), 'current/src/install/entry.mjs');
  const geminiBefore = await fs.readFile(join(home, '.gemini/settings.json'), 'utf8');
  await assert.rejects(exec(process.execPath, ['--preserve-symlinks-main', linkedInternal, '--host', 'gemini'], { cwd: home, env }), error => {
    assert.match(error.stderr, /use.*scripts\/install-agents\.mjs/i);
    return true;
  });
  assert.equal(await fs.readFile(join(home, '.gemini/settings.json'), 'utf8'), geminiBefore);

  const nextVersion = built.version.split('.').map((part, index) => index === 2 ? String(Number(part) + 1) : part).join('.');
  const next = await fixture(nextVersion);
  assert.equal((await run(home, argsFor(next.path, next.digest, nextVersion))).code, 0);
  for (const action of [['--check'], ['--dry-run'], []]) {
    await assert.rejects(exec(process.execPath, [wrapper, ...action, '--host', 'codex'], { cwd: home, env }), error => {
      assert.equal(JSON.parse(error.stdout).error.code, 'RELEASE_REQUIRED');
      return true;
    });
  }
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', imported], { cwd: home, env: importedEnv }), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'RELEASE_REQUIRED');
    return true;
  });
  assert.equal(await fs.readFile(join(home, '.gemini/settings.json'), 'utf8'), geminiBefore);
  assert.deepEqual(await Promise.all(paths.map(path => fs.readFile(path, 'utf8'))), original);
  assert.equal((await run(home, ['--rollback'])).code, 0);
  const checkCurrent = await exec(process.execPath, [wrapper, '--check', '--host', 'codex'], { cwd: home, env });
  assert.equal(JSON.parse(checkCurrent.stdout).hosts[0].healthy, true);
  const staleWrapper = join(runtime(home), 'releases', `v${nextVersion}`, 'scripts/install-agents.mjs');
  await assert.rejects(exec(process.execPath, [staleWrapper, '--check', '--host', 'codex'], { cwd: home, env }), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'RELEASE_REQUIRED');
    return true;
  });
});

test('release install: direct skill checks detect a stale copy after upgrade and rollback', async () => {
  const home = await temp();
  assert.equal((await run(home, argsFor())).code, 0);
  const env = { PATH: process.env.PATH, HOME: home };
  const hosts = join(home, '.local/bin/ccw-hosts');
  await exec(hosts, ['--host', 'codex,pi'], { cwd: home, env });
  const skillPath = id => id === 'codex' ? join(home, '.codex/skills/claude/SKILL.md') : join(home, '.pi/agent/skills/claude/SKILL.md');
  const original = await fs.readFile(skillPath('codex'), 'utf8');
  const nextVersion = built.version.split('.').map((part, index) => index === 2 ? String(Number(part) + 1) : part).join('.');
  const next = await fixture(nextVersion, files => {
    const old = files.get('skills/claude/SKILL.md');
    files.set('skills/claude/SKILL.md', { ...old, bytes: Buffer.from(`${old.bytes.toString('utf8')}\nSynthetic upgraded skill.\n`) });
  });
  assert.equal((await run(home, argsFor(next.path, next.digest, nextVersion))).code, 0);
  for (const id of ['codex', 'pi']) {
    await assert.rejects(exec(hosts, ['--check', '--host', id], { cwd: home, env }), error => {
      const result = JSON.parse(error.stdout).hosts[0];
      assert.equal(result.installed, true);
      assert.equal(result.healthy, false);
      assert.ok(result.issues.some(issue => issue.includes('skill copy differs from current runtime')));
      return true;
    });
    await assert.rejects(exec(hosts, ['--check', '--probe', '--host', id], { cwd: home, env }), error => {
      const result = JSON.parse(error.stdout).hosts[0];
      assert.equal(result.probe.error.code, 'PROBE_CONFIG_UNHEALTHY');
      assert.equal(result.probe.hostLoaded, false);
      assert.equal(result.probe.claudeSent, false);
      return true;
    });
    const preview = JSON.parse((await exec(hosts, ['--host', id, '--dry-run'], { cwd: home, env })).stdout).hosts[0];
    assert.equal(preview.changes.skills, true, id);
    assert.equal(await fs.readFile(skillPath(id), 'utf8'), original, 'preview must not write');
    const userText = `${original}\nuser-owned modification\n`;
    await fs.writeFile(skillPath(id), userText);
    await assert.rejects(exec(hosts, ['--host', id, '--dry-run'], { cwd: home, env }), error => {
      assert.equal(JSON.parse(error.stdout).hosts[0].error.code, 'OWNED_MODIFIED');
      return true;
    });
    await assert.rejects(exec(hosts, ['--host', id], { cwd: home, env }), error => {
      assert.equal(JSON.parse(error.stdout).hosts[0].error.code, 'OWNED_MODIFIED');
      return true;
    });
    assert.equal(await fs.readFile(skillPath(id), 'utf8'), userText);
    await fs.writeFile(skillPath(id), original);
    await exec(hosts, ['--host', id], { cwd: home, env });
    assert.equal(JSON.parse((await exec(hosts, ['--check', '--host', id], { cwd: home, env })).stdout).hosts[0].healthy, true);
    assert.match(await fs.readFile(skillPath(id), 'utf8'), /Synthetic upgraded skill/);
  }
  assert.equal((await run(home, ['--rollback'])).code, 0);
  for (const id of ['codex', 'pi']) {
    await assert.rejects(exec(hosts, ['--check', '--host', id], { cwd: home, env }), error => {
      assert.ok(JSON.parse(error.stdout).hosts[0].issues.some(issue => issue.includes('skill copy differs from current runtime')));
      return true;
    });
    await exec(hosts, ['--host', id], { cwd: home, env });
    assert.equal(await fs.readFile(skillPath(id), 'utf8'), original);
    assert.equal(JSON.parse((await exec(hosts, ['--check', '--host', id], { cwd: home, env })).stdout).hosts[0].healthy, true);
  }
});

test('release install: checksum failures, foreign commands, links and source trees leave originals intact', async () => {
  const home = await temp();
  const wrong = await run(home, argsFor(built.archivePath, '0'.repeat(64)));
  assert.equal(wrong.data.error.code, 'SHA_MISMATCH');
  assert.deepEqual(await fs.readdir(home), []);
  const bin = join(home, '.local/bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(join(bin, 'ccw'), 'foreign command');
  const conflict = await run(home, argsFor());
  assert.equal(conflict.data.error.code, 'OWNERSHIP_CONFLICT');
  assert.equal(await fs.readFile(join(bin, 'ccw'), 'utf8'), 'foreign command');
  assert.equal(await present(runtime(home)), false);
  const other = await temp();
  const outside = await temp();
  await fs.symlink(outside, join(other, 'linked'));
  const linked = await run(other, [...argsFor(), '--prefix', join(other, 'linked/runtime')]);
  assert.equal(linked.data.error.code, 'UNSAFE_PATH');
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.mkdir(join(other, 'checkout/.git'), { recursive: true });
  const source = await run(other, [...argsFor(), '--prefix', join(other, 'checkout/runtime')]);
  assert.equal(source.data.error.code, 'SOURCE_TREE');
  assert.equal(await present(join(other, 'checkout/runtime')), false);
});

test('release install: installed changes and an unresolved lock are never silently repaired', async () => {
  const home = await temp();
  assert.equal((await run(home, argsFor())).code, 0);
  const lock = join(dirname(runtime(home)), `.${basename(runtime(home))}.install.lock`);
  await fs.writeFile(lock, 'another writer');
  const locked = await run(home, argsFor());
  assert.equal(locked.data.error.code, 'LOCKED');
  assert.equal(await fs.readFile(lock, 'utf8'), 'another writer');
  await fs.unlink(lock);
  await fs.writeFile(join(runtime(home), 'current/README.md'), 'user modification');
  const changed = await run(home, ['--status']);
  assert.equal(changed.data.error.code, 'MODIFIED_RELEASE');
  assert.equal(await fs.readFile(join(runtime(home), 'current/README.md'), 'utf8'), 'user modification');
});

test('release install: malicious archive paths, link entries and decompression bombs are refused before writes', async () => {
  const home = await temp();
  const tar = gunzipSync(bytes);
  const corrupt = async mutate => {
    const data = Buffer.from(tar);
    mutate(data);
    data.fill(32, 148, 156);
    const sum = data.subarray(0, 512).reduce((a, b) => a + b, 0);
    data.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const archive = gzipSync(data);
    const path = join(await temp(), 'malicious.tar.gz');
    await fs.writeFile(path, archive);
    const r = await run(home, argsFor(path, hash(archive)));
    assert.equal(r.code, 1, r.stdout);
    assert.deepEqual(await fs.readdir(home), []);
  };
  await corrupt(data => { data.fill(0, 0, 100); data.write('../../escaped', 0, 'ascii'); });
  await corrupt(data => { data[156] = 50; });
  const bomb = gzipSync(Buffer.alloc(MAX_PAYLOAD + 1), { level: 1 });
  const path = join(await temp(), 'bomb.tar.gz');
  await fs.writeFile(path, bomb);
  assert.equal((await run(home, argsFor(path, hash(bomb)))).code, 1);
  assert.deepEqual(await fs.readdir(home), []);
});

test('release install: remote preview is offline; same-origin redirects preserve private auth without logging it', async () => {
  const home = await temp();
  const calls = [];
  const token = 'fixture-private-gitea-token';
  await http((req, res) => {
    calls.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.endsWith('SHA256SUMS')) res.end(`${hash(bytes)}  claude-web-api-v${built.version}.tar.gz\n`);
    else if (req.url.endsWith('.tar.gz') && !req.url.startsWith('/assets')) { res.writeHead(302, { location: '/assets/release.tar.gz' }); res.end(); }
    else res.end(bytes);
  }, async base => {
    const args = ['--release-url', `${base}/release/v${built.version}`, '--allow-loopback-http'];
    const preview = await run(home, [...args, '--dry-run'], { CCW_RELEASE_TOKEN: token });
    assert.equal(preview.code, 0, preview.stdout);
    assert.equal(preview.data.artifactVerified, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(await fs.readdir(home), []);
    const installed = await run(home, args, { CCW_RELEASE_TOKEN: token });
    assert.equal(installed.code, 0, installed.stdout);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(c => c.authorization === `token ${token}`));
    assert.ok(!(installed.stdout + installed.stderr).includes(token));
    assert.ok(!(await fs.readFile(join(runtime(home), 'install.json'), 'utf8')).includes(token));
  });
});

test('release install: foreign redirects, authentication failures and network deadlines fail closed', async () => {
  const token = 'fixture-secret-not-for-logs';
  let foreign = 0;
  await http((req, res) => { foreign++; res.end('unexpected'); }, async other => {
    await http((req, res) => { res.writeHead(302, { location: `${other}/leak` }); res.end(); }, async base => {
      const home = await temp();
      const r = await run(home, ['--release-url', `${base}/release/v${built.version}`, '--allow-loopback-http'], { CCW_RELEASE_TOKEN: token });
      assert.equal(r.data.error.code, 'DOWNLOAD_FAILED');
      assert.equal(foreign, 0);
      assert.ok(!(r.stdout + r.stderr).includes(token));
      assert.deepEqual(await fs.readdir(home), []);
    });
  });
  await http((req, res) => { res.writeHead(401); res.end(token); }, async base => {
    const r = await run(await temp(), ['--release-url', `${base}/release/v${built.version}`, '--allow-loopback-http']);
    assert.equal(r.data.error.code, 'DOWNLOAD_FAILED');
    assert.ok(!r.stdout.includes(token));
  });
  await http(() => {}, async base => {
    const home = await temp();
    const r = await run(home, ['--release-url', `${base}/release/v${built.version}`, '--allow-loopback-http', '--timeout-ms', '500']);
    assert.equal(r.data.error.code, 'DOWNLOAD_TIMEOUT', r.stdout);
    assert.deepEqual(await fs.readdir(home), []);
  });
});

test('release install: a partial publication compensates only its own changes and keeps recovery images', async () => {
  const root = await temp();
  const first = join(root, 'first');
  await fs.writeFile(first, 'original', { mode: 0o600 });
  await assert.rejects(transaction(root, [ { path: first, after: fileImage(Buffer.from('changed')) },
    { path: join(root, 'missing/second'), after: fileImage(Buffer.from('unreachable')) } ]));
  assert.equal(await fs.readFile(first, 'utf8'), 'original');
  assert.ok((await fs.readdir(join(root, 'backups'))).length > 0);
  const rename = fs.rename;
  fs.rename = async (from, to) => { await rename(from, to); if (to === first) await fs.writeFile(first, 'external writer'); };
  try {
    await assert.rejects(transaction(root, [{ path: first, after: fileImage(Buffer.from('ours')) }]), e => e.code === 'RECOVERY_REQUIRED');
    assert.equal(await fs.readFile(first, 'utf8'), 'external writer');
  } finally { fs.rename = rename; }
});
