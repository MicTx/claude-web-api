import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { makeTmpDir, cleanupTmpDirs, FakeCdpServer, ClaudeService, fetchHandlerFor, offlineNodeOptions } from './helpers.mjs';
import { SAMPLE_PNG, SAMPLE_PDF, SAMPLE_CODE } from './fixtures.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { run as rawInstallerRun } from '../scripts/install-codex.mjs';
import { buildBlock, BLOCK_START } from '../src/install/toml-host.mjs';
import { findHost, checkHost, installHost, sourcePaths } from '../src/install/engine.mjs';
import { sha256 } from '../src/release/archive.mjs';
import { promises as realFs } from 'node:fs';
import { createHash } from 'node:crypto';
after(() => cleanupTmpDirs());

const ioBase = () => ({
  lstat: realFs.lstat, mkdir: realFs.mkdir, readFile: realFs.readFile, writeFile: realFs.writeFile,
  open: realFs.open, rename: realFs.rename, unlink: realFs.unlink, rmdir: realFs.rmdir, rm: realFs.rm,
  readdir: realFs.readdir, copyFile: realFs.copyFile, chmod: realFs.chmod, symlink: realFs.symlink, link: realFs.link,
  realpath: realFs.realpath, readlink: realFs.readlink,
});
// Provenance now reads HOME's Library too: every installer fixture must isolate
// HOME as well as CODEX_HOME instead of consulting the operator's live Library.
const installerRun = (args, options = {}) => {
  const explicitHome = args.indexOf('--codex-home');
  const home = options.env?.HOME ?? options.env?.CODEX_HOME ?? (explicitHome >= 0 ? args[explicitHome + 1] : undefined);
  assert.ok(home, 'installer tests require an isolated HOME');
  return rawInstallerRun(args, { ...options, env: { HOME: home, ...options.env } });
};
const silent = { write: () => {} };
const runInProc = (args, io, env = {}) => installerRun(args, { env: { ...env }, stdout: silent, io });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = join(ROOT, 'scripts', 'install-codex.mjs');

function run(args, { codexHome } = {}) {
  return new Promise((resolvePromise, reject) => {
    const argv = [INSTALLER, ...args];
    if (codexHome) argv.push('--codex-home', codexHome);
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: codexHome, CODEX_HOME: codexHome } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, out: out.trim() ? JSON.parse(out.trim().split('\n').at(-1)) : null, raw: out, err }));
  });
}

const configOf = (home) => join(home, 'config.toml');
const skillDirOf = (home) => join(home, 'skills', 'claude');
const recordOf = (home) => join(home, 'claude-web-api-install.json');
const backups = async (home) => (await fs.readdir(home)).filter((f) => f.includes('config.toml.bak'));

async function readIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

test('install: fresh home gets managed block, skill and record', async () => {
  const home = await makeTmpDir('ccw-home-');
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.out.ok, true);
  assert.equal(r.out.installed, true);

  const config = await fs.readFile(configOf(home), 'utf8');
  assert.ok(config.includes('# >>> claude-web-api >>>'));
  assert.ok(config.includes('# <<< claude-web-api <<<'));
  const parsed = parseToml(config);
  const entry = parsed.mcp_servers.claude_web;
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args, [join(ROOT, 'src', 'mcp-server.mjs')]);
  assert.equal(entry.tool_timeout_sec, 660);
  assert.equal(entry.startup_timeout_sec, 20);

  const skill = await fs.readFile(join(skillDirOf(home), 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('name: claude'));
  const wrapper = await fs.readFile(join(skillDirOf(home), 'scripts', 'ccw.mjs'), 'utf8');
  assert.ok(wrapper.includes('runtime.json'));
  const runtime = JSON.parse(await fs.readFile(join(skillDirOf(home), 'runtime.json'), 'utf8'));
  assert.equal(runtime.cli, join(ROOT, 'bin', 'ccw.mjs'));

  const record = JSON.parse(await fs.readFile(recordOf(home), 'utf8'));
  assert.equal(record.schema, 1);
  assert.ok(Object.keys(record.skillFiles).includes('SKILL.md'));

  assert.equal((await fs.stat(configOf(home))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(recordOf(home))).mode & 0o777, 0o600);
});

test('install: missing current skill source reports an unhealthy TOML check', async () => {
  const home = await makeTmpDir('ccw-missing-source-');
  const host = findHost('codex');
  const target = host.resolve({ home, env: { HOME: home }, stateDir: join(home, 'state') });
  const deps = { ...sourcePaths(), io: ioBase(), home };
  await installHost(host, target, deps);
  const checked = await checkHost(host, target, { ...deps, skillSrc: join(home, 'missing-skill') });
  assert.equal(checked.healthy, false);
  assert.ok(checked.issues.some(issue => issue.includes('current skill source unavailable')));
});

test('install: installed entry loads operator config under filtered env and transfers files', async t => {
  const home = await makeTmpDir('ccw-operator-');
  const codexHome = await makeTmpDir('ccw-home-');
  const source = await makeTmpDir('ccw-source-');
  const unrelated = await makeTmpDir('ccw-cwd-');
  for (const part of ['src', 'bin', 'skills', 'package.json']) await fs.cp(join(ROOT, part), join(source, part), { recursive: true });
  await fs.symlink(join(ROOT, 'node_modules'), join(source, 'node_modules'));
  const installed = await installerRun(['--codex-home', codexHome], { sourceRoot: source, stdout: silent, io: ioBase() });
  assert.equal(installed, 0);
  const configBytes = await fs.readFile(configOf(codexHome), 'utf8');
  const entry = parseToml(configBytes).mcp_servers.claude_web;
  const service = new ClaudeService();
  service.nativeOutputs = [{ name: 'result.js', bytes: SAMPLE_CODE }];
  const browser = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service }).start();
  t.after(() => browser.stop());
  const selected = [['sample.png', SAMPLE_PNG], ['sample.js', SAMPLE_CODE]];
  for (const [name, bytes] of [['sample.png', SAMPLE_PNG], ['sample.pdf', SAMPLE_PDF], ['sample.js', SAMPLE_CODE]]) {
    await fs.writeFile(join(home, name), bytes);
  }
  const configDir = join(home, '.config', 'claude-web-api');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const settings = JSON.stringify({ cdpUrl: browser.cdpUrl, stateDir: join(home, 'state'), attachmentRoot: home, minIntervalMs: 1 });
  await fs.writeFile(join(configDir, 'config.json'), settings, { mode: 0o600 });
  const client = new Client({ name: 'installed-files-test', version: '1' });
  const transport = new StdioClientTransport({
    command: entry.command, args: entry.args, cwd: unrelated, stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: home, NODE_OPTIONS: await offlineNodeOptions(unrelated, browser.cdpUrl) },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const refused = await client.callTool({ name: 'claude_ask', arguments: { session: 'installed-pdf', prompt: 'inspect', attachments: [join(home, 'sample.pdf')] } });
  assert.equal(refused.structuredContent.ok, false);
  assert.equal(refused.structuredContent.error.code, 'FILE_TYPE');
  const first = await client.callTool({ name: 'claude_ask', arguments: { session: 'installed', prompt: 'inspect', attachments: selected.map(([name]) => join(home, name)) } });
  assert.equal(first.structuredContent.ok, true, JSON.stringify(first.structuredContent));
  const follow = await client.callTool({ name: 'claude_follow_up', arguments: { session: 'installed', prompt: 'continue' } });
  assert.equal(follow.structuredContent.ok, true);
  const result = await client.callTool({ name: 'claude_download', arguments: { session: 'installed', artifact: first.structuredContent.artifacts[0].id } });
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
  assert.deepEqual(await fs.readFile(result.structuredContent.path), SAMPLE_CODE);
  assert.equal(service.uploads.length, 2);
  assert.equal(await fs.readFile(configOf(codexHome), 'utf8'), configBytes);
  assert.equal(await fs.readFile(join(configDir, 'config.json'), 'utf8'), settings);
});

test('install: re-run is a byte-identical no-op with no new backups', async () => {
  const home = await makeTmpDir('ccw-home-');
  await run([], { codexHome: home });
  const before = await fs.readFile(configOf(home), 'utf8');
  const backupsBefore = await backups(home);
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 0);
  assert.equal(r.out.alreadyInstalled, true);
  assert.equal(await fs.readFile(configOf(home), 'utf8'), before);
  assert.deepEqual(await backups(home), backupsBefore);
});

test('install: preserves user config bytes exactly; uninstall restores them', async () => {
  const home = await makeTmpDir('ccw-home-');
  const userConfig = [
    'model = "gpt-5"',
    '',
    '[[permissions.allow]]',
    'rule = "shell(git status)"',
    '',
    '[mcp_servers.other]',
    'command = "/usr/bin/other"',
    'args = ["--serve"]',
    '', // no trailing newline edge covered below
  ].join('\n');
  await fs.writeFile(configOf(home), userConfig);

  const r = await run([], { codexHome: home });
  assert.equal(r.code, 0, r.raw);
  const after = await fs.readFile(configOf(home), 'utf8');
  assert.ok(after.startsWith(userConfig));
  const parsed = parseToml(after);
  assert.equal(parsed.model, 'gpt-5');
  assert.equal(parsed.mcp_servers.other.command, '/usr/bin/other');
  assert.ok(parsed.permissions.allow.length === 1); // sensitive field retained
  assert.ok(parsed.mcp_servers.claude_web);
  assert.equal((await backups(home)).length, 1);
  const backupText = await fs.readFile(join(home, (await backups(home))[0]), 'utf8');
  assert.equal(backupText, userConfig);

  const u = await run(['--uninstall'], { codexHome: home });
  assert.equal(u.code, 0, u.raw);
  assert.equal(await fs.readFile(configOf(home), 'utf8'), userConfig);
  assert.equal(await readIfExists(skillDirOf(home)), null);
  assert.equal(await readIfExists(recordOf(home)), null);
});

test('install: pre-existing user claude_web entries are conflicts in all TOML forms', async () => {
  const forms = [
    '[mcp_servers.claude_web]\ncommand = "/usr/bin/x"\n',
    '[mcp_servers."claude_web"]\ncommand = "/usr/bin/x"\n',
    'mcp_servers = { claude_web = { command = "/usr/bin/x" } }\n',
    '[mcp_servers]\nclaude_web = { command = "/usr/bin/x" }\n',
  ];
  for (const form of forms) {
    const home = await makeTmpDir('ccw-home-');
    await fs.writeFile(configOf(home), form);
    const r = await run([], { codexHome: home });
    assert.equal(r.code, 1, form);
    assert.equal(r.out.error.code, 'INSTALL_CONFLICT', form);
    assert.equal(await fs.readFile(configOf(home), 'utf8'), form);
    assert.deepEqual(await backups(home), []);
    assert.equal(await readIfExists(skillDirOf(home)), null);
  }
});

test('install: malformed TOML fails CONFIG_INVALID without echoing config', async () => {
  const home = await makeTmpDir('ccw-home-');
  const secret = 'super_secret_user_value_12345';
  await fs.writeFile(configOf(home), `[broken\ntoken = "${secret}"\n`);
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'CONFIG_INVALID');
  assert.ok(!r.raw.includes(secret), 'raw config must not leak into output');
});

test('install: refuses when owned skill file was customized; --check reports it', async () => {
  const home = await makeTmpDir('ccw-home-');
  await run([], { codexHome: home });
  await fs.appendFile(join(skillDirOf(home), 'SKILL.md'), '\nuser edit\n');
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'OWNED_MODIFIED');
  const c = await run(['--check'], { codexHome: home });
  assert.equal(c.code, 1);
  assert.equal(c.out.healthy, false);
  assert.ok(c.out.issues.some((i) => i.includes('SKILL.md')));
});

test('install: user text appended after the block survives uninstall', async () => {
  const home = await makeTmpDir('ccw-home-');
  const userConfig = 'model = "gpt-5"\n';
  await fs.writeFile(configOf(home), userConfig);
  await run([], { codexHome: home });
  const appended = '\n[mcp_servers.later]\ncommand = "/bin/later"\n';
  await fs.appendFile(configOf(home), appended);
  const u = await run(['--uninstall'], { codexHome: home });
  assert.equal(u.code, 0, u.raw);
  const remaining = await fs.readFile(configOf(home), 'utf8');
  assert.equal(remaining, `${userConfig}${appended.slice(0)}`.replace(userConfig + '\n', userConfig + '\n'));
  assert.equal(remaining, userConfig + appended);
  const parsed = parseToml(remaining);
  assert.equal(parsed.mcp_servers.later.command, '/bin/later');
  assert.equal(parsed.mcp_servers.claude_web, undefined);
});

test('install: installer-created config is removed entirely on uninstall', async () => {
  const home = await makeTmpDir('ccw-home-');
  await run([], { codexHome: home });
  const u = await run(['--uninstall'], { codexHome: home });
  assert.equal(u.code, 0);
  assert.equal(u.out.removed, true);
  assert.equal(await readIfExists(configOf(home)), null);
  assert.equal(await readIfExists(join(skillDirOf(home), 'SKILL.md')), null);
  assert.equal(await readIfExists(recordOf(home)), null);
});

test('check: healthy on clean install, false on fresh home', async () => {
  const home = await makeTmpDir('ccw-home-');
  const c0 = await run(['--check'], { codexHome: home });
  assert.equal(c0.code, 1);
  assert.equal(c0.out.installed, false);
  await run([], { codexHome: home });
  const c = await run(['--check'], { codexHome: home });
  assert.equal(c.code, 0, c.raw);
  assert.equal(c.out.installed, true);
  assert.equal(c.out.healthy, true);
  assert.deepEqual(c.out.issues, []);
});

test('install: refuses symlinked skill destination and config', async () => {
  const home = await makeTmpDir('ccw-home-');
  const outside = await makeTmpDir('ccw-outside-');
  await fs.mkdir(join(home, 'skills'));
  await fs.symlink(outside, join(home, 'skills', 'claude'));
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.ok(['UNSAFE_PATH', 'INSTALL_CONFLICT'].includes(r.out.error.code));

  const home2 = await makeTmpDir('ccw-home-');
  const real = join(outside, 'real-config.toml');
  await fs.writeFile(real, 'model = "x"\n');
  await fs.symlink(real, configOf(home2));
  const r2 = await run([], { codexHome: home2 });
  assert.equal(r2.code, 1);
  assert.equal(r2.out.error.code, 'UNSAFE_PATH');
});

test('install: concurrent invocation rejected by the install lock', async () => {
  const home = await makeTmpDir('ccw-home-');
  await fs.writeFile(join(home, '.claude-web-api-install.lock'), '{}', { flag: 'wx' });
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'INSTALL_BUSY');
});

test('install: keys added after install survive a later uninstall', async () => {
  const home = await makeTmpDir('ccw-home-');
  await fs.writeFile(configOf(home), 'model = "gpt-5"\n');
  await run([], { codexHome: home });
  // user adds unrelated settings after our block
  await fs.appendFile(configOf(home), '\n[profiles.work]\nmodel = "gpt-5-mini"\n');
  const u = await run(['--uninstall'], { codexHome: home });
  assert.equal(u.code, 0, u.raw);
  const remaining = parseToml(await fs.readFile(configOf(home), 'utf8'));
  assert.equal(remaining.profiles.work.model, 'gpt-5-mini');
  assert.equal(remaining.mcp_servers?.claude_web, undefined);
});

test('install: injected record-publish failure on fresh install restores everything', async () => {
  const home = await makeTmpDir('ccw-home-');
  const original = 'model = "preserved-model"\n';
  await realFs.writeFile(configOf(home), original);
  const io = ioBase();
  const realRename = io.rename;
  io.rename = async (a, b) => {
    if (String(b).endsWith('claude-web-api-install.json')) { const e = new Error('disk gone'); e.code = 'EIO'; throw e; }
    return realRename(a, b);
  };
  const env = { CODEX_HOME: home };
  const code = await runInProc([], io, env);
  assert.equal(code, 1);
  assert.equal(await readIfExists(configOf(home)), original);
  assert.equal(await readIfExists(skillDirOf(home)), null);
  assert.equal(await readIfExists(recordOf(home)), null);
  const leftovers = (await realFs.readdir(home)).filter((f) => f.includes('staging') || f.includes('.prev-') || f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('install: injected record failure on update restores old config+skill+record', async () => {
  const src = await makeTmpDir('ccw-src-');
  await realFs.mkdir(join(src, 'skills', 'claude', 'scripts'), { recursive: true });
  await realFs.mkdir(join(src, 'src'), { recursive: true });
  await realFs.mkdir(join(src, 'bin'), { recursive: true });
  await realFs.copyFile(join(ROOT, 'skills', 'claude', 'SKILL.md'), join(src, 'skills', 'claude', 'SKILL.md'));
  await realFs.copyFile(join(ROOT, 'skills', 'claude', 'scripts', 'ccw.mjs'), join(src, 'skills', 'claude', 'scripts', 'ccw.mjs'));
  await realFs.copyFile(join(ROOT, 'src', 'mcp-server.mjs'), join(src, 'src', 'mcp-server.mjs'));
  await realFs.copyFile(join(ROOT, 'bin', 'ccw.mjs'), join(src, 'bin', 'ccw.mjs'));
  const home = await makeTmpDir('ccw-home-');
  const env = { CODEX_HOME: home };
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
  const oldConfig = await realFs.readFile(configOf(home), 'utf8');
  const oldSkill = await realFs.readFile(join(skillDirOf(home), 'scripts', 'ccw.mjs'), 'utf8');
  const oldRecord = await realFs.readFile(recordOf(home), 'utf8');
  // Change executable wrapper metadata, keeping the skill instructions intact.
  await realFs.appendFile(join(src, 'skills', 'claude', 'scripts', 'ccw.mjs'), '\n// update fixture\n');
  const io = ioBase();
  const realRename = io.rename;
  io.rename = async (a, b) => {
    if (String(b).endsWith('claude-web-api-install.json')) { const e = new Error('disk gone'); e.code = 'EIO'; throw e; }
    return realRename(a, b);
  };
  const code = await installerRun([], { env, stdout: silent, sourceRoot: src, io });
  assert.equal(code, 1);
  assert.equal(await realFs.readFile(configOf(home), 'utf8'), oldConfig);
  assert.equal(await realFs.readFile(join(skillDirOf(home), 'scripts', 'ccw.mjs'), 'utf8'), oldSkill);
  assert.equal(await realFs.readFile(recordOf(home), 'utf8'), oldRecord);
});

test('install: marker-looking block without record is a conflict, never adopted', async () => {
  const home = await makeTmpDir('ccw-home-');
  const marker = '# >>> claude-web-api >>>\n[mcp_servers.claude_web]\ncommand = "/usr/bin/x"\nargs = ["/y"]\ntool_timeout_sec = 660\nstartup_timeout_sec = 20\n# <<< claude-web-api <<<\n';
  await realFs.writeFile(configOf(home), `model = "m"\n${marker}`);
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'INSTALL_CONFLICT');
});

test('install: a record file under another product name is never adopted', async () => {
  const home = await makeTmpDir('ccw-home-');
  const mcpPath = join(ROOT, 'src', 'mcp-server.mjs');
  const spec = { serverName: 'claude_web', extraKeys: [['tool_timeout_sec', 660], ['startup_timeout_sec', 20]] };
  const foreignBlock = buildBlock(spec, process.execPath, mcpPath);
  const foreignRecord = join(home, 'call-claude-webkit-install.json');
  const record = {
    schema: 1, createdConfig: false, nodePath: process.execPath, mcpPath, cliPath: join(ROOT, 'bin', 'ccw.mjs'),
    blockSha256: sha256(foreignBlock), skillFiles: {}, appendedBase64: Buffer.from(foreignBlock).toString('base64'),
  };
  await realFs.writeFile(configOf(home), `model = "m"\n${foreignBlock}`, { mode: 0o600 });
  await realFs.writeFile(foreignRecord, JSON.stringify(record));
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'INSTALL_CONFLICT');
  // A record under a different product name is never adopted as ownership.
  assert.equal(await realFs.readFile(foreignRecord, 'utf8'), JSON.stringify(record));
});

test('install: a record-owned legacy skill directory upgrades to the new entry name', async () => {
  const home = await makeTmpDir('ccw-home-');
  const src = await mkSource();
  const env = { CODEX_HOME: home };
  // Simulate the pre-rename install: the record names claude-consult as skillDir.
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
  const legacyDest = join(home, 'skills', 'claude-consult');
  await realFs.rename(skillDirOf(home), legacyDest);
  const rec = JSON.parse(await realFs.readFile(recordOf(home), 'utf8'));
  rec.skillDir = legacyDest;
  await realFs.writeFile(recordOf(home), JSON.stringify(rec));
  // The upgrade must replace it at skills/claude and quarantine the old tree.
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
  // The skill tree moves to the new entry name; the old directory is removed.
  const skill = await realFs.readFile(join(skillDirOf(home), 'SKILL.md'), 'utf8');
  assert.ok(skill.includes('name: claude'));
  assert.equal(await readIfExists(legacyDest), null, 'legacy skill directory removed');
  // A foreign directory with the same new name is still a conflict, not adopted.
  const home2 = await makeTmpDir('ccw-home-');
  const foreignDest = join(home2, 'skills', 'claude');
  await realFs.mkdir(foreignDest, { recursive: true });
  await realFs.writeFile(join(foreignDest, 'SKILL.md'), 'unrelated');
  const env2 = { CODEX_HOME: home2 };
  assert.equal(await installerRun([], { env: env2, stdout: silent, sourceRoot: src }), 1);
  assert.equal(await realFs.readFile(join(foreignDest, 'SKILL.md'), 'utf8'), 'unrelated');
});

test('install: TOML check reports a linked legacy skill without following it', async () => {
  const home = await makeTmpDir('ccw-home-');
  const src = await mkSource();
  const env = { CODEX_HOME: home };
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
  const preserved = join(home, 'outside-skill');
  const legacyDest = join(home, 'skills', 'claude-consult');
  await realFs.rename(skillDirOf(home), preserved);
  await realFs.symlink(preserved, legacyDest);
  const host = findHost('codex');
  const target = host.resolve({ home, env, stateDir: join(home, 'state') });
  const checked = await checkHost(host, target, { ...sourcePaths(src), io: ioBase(), home });
  assert.equal(checked.healthy, false);
  assert.ok(checked.issues.some(issue => issue.includes('symlink')));
  assert.equal((await realFs.lstat(legacyDest)).isSymbolicLink(), true);
});

test('install: forged records with traversal keys or bad hashes are rejected', async () => {
  for (const bad of [
    { schema: 1, blockSha256: 'x'.repeat(64), appendedBase64: 'eA==', nodePath: '/n', mcpPath: '/m', cliPath: '/c', skillFiles: { '../evil': 'a'.repeat(64) } },
    { schema: 1, blockSha256: 'Z'.repeat(64), appendedBase64: 'eA==', nodePath: '/n', mcpPath: '/m', cliPath: '/c', skillFiles: {} },
    { schema: 2, blockSha256: 'a'.repeat(64), appendedBase64: 'eA==', nodePath: '/n', mcpPath: '/m', cliPath: '/c', skillFiles: {} },
  ]) {
    const home = await makeTmpDir('ccw-home-');
    await realFs.writeFile(recordOf(home), JSON.stringify(bad));
    const r = await run([], { codexHome: home });
    assert.equal(r.code, 1);
    assert.equal(r.out.error.code, 'INSTALL_CONFLICT', JSON.stringify(bad).slice(0, 60));
  }
});

test('install: inline mcp_servers parent makes candidate invalid, nothing written', async () => {
  const home = await makeTmpDir('ccw-home-');
  const cfg = 'mcp_servers = { other = { command = "/x" } }\n';
  await realFs.writeFile(configOf(home), cfg);
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(await realFs.readFile(configOf(home), 'utf8'), cfg);
  assert.equal(await readIfExists(skillDirOf(home)), null);
  assert.deepEqual(await backups(home), []);
});

const mkSource = async (label) => {
  const src = await makeTmpDir('ccw-src-');
  await realFs.mkdir(join(src, 'skills', 'claude', 'scripts'), { recursive: true });
  await realFs.mkdir(join(src, 'src'), { recursive: true });
  await realFs.mkdir(join(src, 'bin'), { recursive: true });
  await realFs.copyFile(join(ROOT, 'skills', 'claude', 'SKILL.md'), join(src, 'skills', 'claude', 'SKILL.md'));
  await realFs.copyFile(join(ROOT, 'skills', 'claude', 'scripts', 'ccw.mjs'), join(src, 'skills', 'claude', 'scripts', 'ccw.mjs'));
  await realFs.copyFile(join(ROOT, 'src', 'mcp-server.mjs'), join(src, 'src', 'mcp-server.mjs'));
  await realFs.copyFile(join(ROOT, 'bin', 'ccw.mjs'), join(src, 'bin', 'ccw.mjs'));
  return src;
};

test('install: source-path upgrade (A -> B) -> check healthy, uninstall restores config', async () => {
  const a = await mkSource('a');
  const b = await mkSource('b');
  const home = await makeTmpDir('ccw-home-');
  const cfg = 'model = "m"\n[mcp_servers.other]\ncommand = "/x"\n';
  await realFs.writeFile(configOf(home), cfg);
  const env = { CODEX_HOME: home };
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: a }), 0);
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: b }), 0);
  assert.equal(await installerRun(['--check'], { env, stdout: silent, sourceRoot: b }), 0);
  assert.equal(await installerRun(['--uninstall'], { env, stdout: silent }), 0);
  assert.equal(await realFs.readFile(configOf(home), 'utf8'), cfg);
});

test('uninstall: injected record-unlink failure restores config+skill+record', async () => {
  const home = await makeTmpDir('ccw-home-');
  assert.equal(await installerRun([], { env: { CODEX_HOME: home }, stdout: silent }), 0);
  const snap = {
    c: await realFs.readFile(configOf(home), 'utf8'),
    s: await realFs.readFile(join(skillDirOf(home), 'SKILL.md'), 'utf8'),
    r: await realFs.readFile(recordOf(home), 'utf8'),
  };
  const io = ioBase();
  const realUnlink = io.unlink;
  io.unlink = async (p) => {
    if (String(p).endsWith('claude-web-api-install.json')) { const e = new Error('no'); e.code = 'EIO'; throw e; }
    return realUnlink(p);
  };
  assert.equal(await installerRun(['--uninstall'], { env: { CODEX_HOME: home }, stdout: silent, io }), 1);
  assert.equal(await realFs.readFile(configOf(home), 'utf8'), snap.c);
  assert.equal(await realFs.readFile(join(skillDirOf(home), 'SKILL.md'), 'utf8'), snap.s);
  assert.equal(await realFs.readFile(recordOf(home), 'utf8'), snap.r);
  assert.equal(await installerRun(['--check'], { env: { CODEX_HOME: home }, stdout: silent }), 0);
});

test('install: quarantine rm failure after commit succeeds with cleanupPending', async () => {
  const src = await mkSource();
  const home = await makeTmpDir('ccw-home-');
  assert.equal(await installerRun([], { env: { CODEX_HOME: home }, stdout: silent, sourceRoot: src }), 0);
  await realFs.appendFile(join(src, 'skills', 'claude', 'scripts', 'ccw.mjs'), '\n// harmless comment update\n');
  const io = ioBase();
  const realRm = io.rm;
  io.rm = async (p, o) => {
    if (String(p).includes('.prev-')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return realRm(p, o);
  };
  const out = [];
  assert.equal(await installerRun([], { env: { CODEX_HOME: home }, stdout: { write: (s) => out.push(s) }, sourceRoot: src, io }), 0);
  assert.ok(out.some((l) => JSON.parse(l).cleanupPending?.length >= 1));
  assert.equal(await installerRun(['--check'], { env: { CODEX_HOME: home }, stdout: silent, sourceRoot: src }), 0);
});

test('uninstall: quarantine rm failure after commit stays uninstalled with cleanupPending', async () => {
  const home = await makeTmpDir('ccw-home-');
  assert.equal(await installerRun([], { env: { CODEX_HOME: home }, stdout: silent }), 0);
  const io = ioBase();
  const realRm = io.rm;
  io.rm = async (p, o) => {
    if (String(p).includes('.quarantine-')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return realRm(p, o);
  };
  const out = [];
  assert.equal(await installerRun(['--uninstall'], { env: { CODEX_HOME: home }, stdout: { write: (s) => out.push(s) }, io }), 0);
  assert.ok(out.some((l) => JSON.parse(l).cleanupPending?.length >= 1));
  assert.equal(await readIfExists(recordOf(home)), null);
  assert.equal(await readIfExists(skillDirOf(home)), null);
});

test('rollback preserves user edits made during injected record failure', async () => {
  for (const surface of ['config', 'skill']) {
    const home = await makeTmpDir('ccw-home-');
    const io = ioBase();
    const realRename = io.rename;
    io.rename = async (a, b) => {
      if (String(b).endsWith('claude-web-api-install.json')) {
        if (surface === 'config') await realFs.appendFile(configOf(home), '\n# user edit\n');
        else await realFs.writeFile(join(skillDirOf(home), 'extra.user'), 'mine');
        const e = new Error('gone'); e.code = 'EIO'; throw e;
      }
      return realRename(a, b);
    };
    const emitted = [];
    assert.equal(await installerRun([], {
      env: { CODEX_HOME: home },
      stdout: { write: (text) => emitted.push(JSON.parse(text)) },
      io,
    }), 1);
    assert.ok(emitted.at(-1).error.details.incompleteRollback.length > 0);
    if (surface === 'config') {
      assert.ok((await realFs.readFile(configOf(home), 'utf8')).includes('user edit'));
    } else {
      assert.equal(await realFs.readFile(join(skillDirOf(home), 'extra.user'), 'utf8'), 'mine');
    }
  }
});

test('install: concurrent in-place config changes survive replacement in a reported recovery file', async () => {
  const home = await makeTmpDir('ccw-home-');
  const original = 'model = "fixture"\n';
  const userEdit = 'approval_policy = "synthetic"\n';
  await fs.writeFile(configOf(home), original);
  const io = ioBase();
  let injected = false;
  io.rename = async (source, destination) => {
    if (destination === configOf(home) && !injected) {
      injected = true;
      await fs.appendFile(configOf(home), userEdit);
    }
    return realFs.rename(source, destination);
  };
  const output = [];
  const code = await installerRun([], { env: { CODEX_HOME: home }, stdout: { write: text => output.push(JSON.parse(text)) }, io });
  assert.equal(injected, true);
  assert.equal(code, 1);
  assert.equal(output.at(-1).error.code, 'CONFIG_CHANGED');
  const recovery = output.at(-1).error.details.recoveryPath;
  assert.ok(recovery.startsWith(home));
  assert.equal(await fs.readFile(recovery, 'utf8'), original + userEdit);
  assert.equal(await readIfExists(recordOf(home)), null);
});

test('install: a config created after preflight is never overwritten', async () => {
  const home = await makeTmpDir('ccw-home-');
  const userConfig = 'model = "created-concurrently"\n';
  const io = ioBase();
  let injected = false;
  io.open = async (path, ...args) => {
    const handle = await realFs.open(path, ...args);
    if (!injected && String(path).startsWith(`${configOf(home)}.`) && String(path).endsWith('.tmp')) {
      injected = true;
      await fs.writeFile(configOf(home), userConfig);
    }
    return handle;
  };
  const output = [];
  const code = await installerRun([], { env: { CODEX_HOME: home }, stdout: { write: text => output.push(JSON.parse(text)) }, io });
  assert.equal(injected, true);
  assert.equal(code, 1);
  assert.equal(await fs.readFile(configOf(home), 'utf8'), userConfig);
  assert.equal(await readIfExists(recordOf(home)), null);
});

test('uninstall: concurrent in-place config changes survive deletion in a reported recovery file', async () => {
  const home = await makeTmpDir('ccw-home-');
  assert.equal(await installerRun([], { env: { CODEX_HOME: home }, stdout: silent }), 0);
  const userEdit = '\n# concurrent user edit\n';
  const io = ioBase();
  let injected = false;
  io.unlink = async path => {
    if (path === configOf(home) && !injected) {
      injected = true;
      await fs.appendFile(configOf(home), userEdit);
    }
    return realFs.unlink(path);
  };
  const output = [];
  const code = await installerRun(['--uninstall'], { env: { CODEX_HOME: home }, stdout: { write: text => output.push(JSON.parse(text)) }, io });
  assert.equal(injected, true);
  assert.equal(code, 1);
  assert.equal(output.at(-1).error.code, 'CONFIG_CHANGED');
  assert.ok((await fs.readFile(output.at(-1).error.details.recoveryPath, 'utf8')).includes(userEdit));
  assert.notEqual(await readIfExists(recordOf(home)), null);
});

test('install: failed config guard cleanup reports retained paths and incomplete publication', async () => {
  const home = await makeTmpDir('ccw-home-');
  await fs.writeFile(configOf(home), 'model = "fixture"\n');
  const io = ioBase();
  io.unlink = async path => {
    if (String(path).includes('config.toml.concurrent-')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realFs.unlink(path);
  };
  const output = [];
  const code = await installerRun([], { env: { CODEX_HOME: home }, stdout: { write: text => output.push(JSON.parse(text)) }, io });
  assert.equal(code, 1);
  assert.equal(output.at(-1).error.code, 'CONFIG_CLEANUP');
  assert.ok(output.at(-1).error.details.incompleteRollback.includes('config.toml'));
  const [retained] = output.at(-1).error.details.cleanupPaths;
  assert.ok(retained.startsWith(home));
  assert.equal(await fs.readFile(retained, 'utf8'), 'model = "fixture"\n');
  assert.equal(await readIfExists(recordOf(home)), null);
});

test('install: user env subtable under our MCP entry is OWNED_MODIFIED, no writes', async () => {
  const home = await makeTmpDir('ccw-home-');
  assert.equal(await installerRun([], { env: { CODEX_HOME: home }, stdout: silent }), 0);
  await realFs.appendFile(configOf(home), '\n[mcp_servers.claude_web.env]\nFOO = "bar"\n');
  const r = await run([], { codexHome: home });
  assert.equal(r.code, 1);
  assert.equal(r.out.error.code, 'OWNED_MODIFIED');
});

for (const target of ['staging', 'installed']) {
  test(`install: failed ${target} cleanup reports the retained directory`, async () => {
    const home = await makeTmpDir('ccw-home-');
    const io = ioBase();
    let retained;
    io.copyFile = async (source, destination) => {
      await realFs.copyFile(source, destination);
      if (target === 'staging') throw Object.assign(new Error('copy failed'), { code: 'EIO' });
    };
    io.rename = async (source, destination) => {
      if (destination === recordOf(home)) throw Object.assign(new Error('publish failed'), { code: 'EIO' });
      return realFs.rename(source, destination);
    };
    io.rm = async (path, options) => {
      if (target === 'staging' ? path.includes('.staging-') : path === skillDirOf(home)) {
        retained = path;
        throw Object.assign(new Error('cleanup failed'), { code: 'EBUSY' });
      }
      return realFs.rm(path, options);
    };
    const output = [];
    assert.equal(await installerRun([], { env: { CODEX_HOME: home }, io, stdout: { write: (text) => output.push(JSON.parse(text)) } }), 1);
    assert.ok(retained);
    assert.ok((await realFs.lstat(retained)).isDirectory());
    assert.ok(output.at(-1).error.details?.incompleteRollback?.some((item) => item.includes(target === 'staging' ? retained : 'skill directory')));
    assert.equal(await readIfExists(recordOf(home)), null);
    assert.equal(await readIfExists(configOf(home)), null);
  });
}

for (const failure of ['activation', 'record']) {
  test(`install: ${failure} failure reports the old skill when restoration also fails`, async () => {
    const home = await makeTmpDir('ccw-home-');
    const src = await mkSource();
    const env = { CODEX_HOME: home };
    assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
    const previousSkill = await realFs.readFile(join(skillDirOf(home), 'scripts', 'ccw.mjs'), 'utf8');
    const previousRecord = await realFs.readFile(recordOf(home), 'utf8');
    await realFs.appendFile(join(src, 'skills', 'claude', 'scripts', 'ccw.mjs'), '\nvoid 0;\n');
    const io = ioBase();
    let retained;
    io.rename = async (source, destination) => {
      if (source.includes('.prev-') && destination === skillDirOf(home)) {
        retained = source;
        throw Object.assign(new Error('restore failed'), { code: 'EIO' });
      }
      if ((failure === 'activation' && source.includes('.staging-') && destination === skillDirOf(home))
        || (failure === 'record' && destination === recordOf(home))) {
        throw Object.assign(new Error('install failed'), { code: 'EIO' });
      }
      return realFs.rename(source, destination);
    };
    const output = [];
    assert.equal(await installerRun([], { env, io, sourceRoot: src, stdout: { write: (text) => output.push(JSON.parse(text)) } }), 1);
    assert.ok(retained);
    assert.equal(await realFs.readFile(join(retained, 'scripts', 'ccw.mjs'), 'utf8'), previousSkill);
    assert.equal(await realFs.readFile(recordOf(home), 'utf8'), previousRecord);
    assert.ok(output.at(-1).error.details?.incompleteRollback?.some((item) => item.includes(retained)));
  });
}

for (const operation of ['install', 'uninstall']) {
  test(`${operation}: a concurrent config type change does not prevent skill rollback`, async () => {
    const home = await makeTmpDir('ccw-home-');
    const env = { CODEX_HOME: home };
    if (operation === 'uninstall') assert.equal(await installerRun([], { env, stdout: silent }), 0);
    const previousRecord = await readIfExists(recordOf(home));
    const previousSkill = await readIfExists(join(skillDirOf(home), 'SKILL.md'));
    const io = ioBase();
    const replaceConfig = async () => {
      await realFs.unlink(configOf(home)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await realFs.mkdir(configOf(home));
      await realFs.writeFile(join(configOf(home), 'user-file'), 'preserve me');
      throw Object.assign(new Error('commit failed'), { code: 'EIO' });
    };
    io.rename = async (source, destination) => {
      if (operation === 'install' && destination === recordOf(home)) return replaceConfig();
      return realFs.rename(source, destination);
    };
    io.unlink = async (path) => {
      if (operation === 'uninstall' && path === recordOf(home)) return replaceConfig();
      return realFs.unlink(path);
    };
    const output = [];
    assert.equal(await installerRun(operation === 'uninstall' ? ['--uninstall'] : [], {
      env, io, stdout: { write: (text) => output.push(JSON.parse(text)) },
    }), 1);
    assert.equal(await realFs.readFile(join(configOf(home), 'user-file'), 'utf8'), 'preserve me');
    assert.ok(output.at(-1).error.details?.incompleteRollback?.includes('config.toml'));
    const restored = await realFs.lstat(skillDirOf(home)).catch(() => null);
    assert.equal(restored?.isDirectory() ?? false, operation === 'uninstall');
    assert.equal(await readIfExists(recordOf(home)), previousRecord);
    assert.equal(await readIfExists(join(skillDirOf(home), 'SKILL.md')), previousSkill);
  });
}

test('install: skill-only upgrade publishes the current protocol without changing config bytes', async () => {
  const home = await makeTmpDir('ccw-home-');
  const src = await mkSource();
  const sourceSkill = join(src, 'skills', 'claude', 'SKILL.md');
  const currentSkill = await realFs.readFile(join(ROOT, 'skills', 'claude', 'SKILL.md'), 'utf8');
  await realFs.writeFile(sourceSkill, '---\nname: claude\ndescription: Previous consulting instructions\n---\nOne question at a time.\n');
  const env = { CODEX_HOME: home };
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
  const config = await realFs.readFile(configOf(home), 'utf8');
  const previousBackups = await backups(home);
  await realFs.writeFile(sourceSkill, currentSkill);
  assert.equal(await installerRun([], { env, stdout: silent, sourceRoot: src }), 0);
  assert.equal(await realFs.readFile(join(skillDirOf(home), 'SKILL.md'), 'utf8'), currentSkill);
  assert.equal(await realFs.readFile(configOf(home), 'utf8'), config);
  assert.deepEqual(await backups(home), previousBackups);
  const record = JSON.parse(await realFs.readFile(recordOf(home), 'utf8'));
  assert.equal(record.skillFiles['SKILL.md'], createHash('sha256').update(currentSkill).digest('hex'));
  assert.equal(await installerRun(['--check'], { env, stdout: silent, sourceRoot: src }), 0);
});
