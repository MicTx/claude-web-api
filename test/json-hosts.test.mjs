import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { resolveTargets, findHost, installHost, uninstallHost, checkHost, sourcePaths } from '../src/install/engine.mjs';
import { defaultIo } from '../src/install/atomic.mjs';
import { canonical } from '../src/install/json-text.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());

const io = defaultIo();
const deps = { ...sourcePaths(), io };

const base = (home) => ({ home, env: { HOME: home }, platform: 'linux', stateDir: join(home, 'state') });

async function target(id) {
  const home = await makeTmpDir(`ccw-json-${id}-`);
  const found = resolveTargets(base(home)).find((e) => e.host.id === id);
  return { home, host: found.host, target: found.target };
}

// Realistic user content per host; install must only add our member.
const SEEDS = {
  claude: (t) => [
    t.configPath,
    '{\n  "numStartups": 12,\n  "mcpServers": {\n    "other": {\n      "command": "/bin/other"\n    }\n  },\n  "projects": {"/work": {"history": []}}\n}\n',
  ],
  'claude-desktop': (t) => [
    t.configPath,
    '{\n  "deploymentMode": "3p",\n  "preferences": {"coworkLegacyRootGrantsPruned": true}\n}\n',
  ],
  pi: (t) => [
    t.configPath,
    '{\n  "mcpServers": {},\n  "imports": ["cursor", "claude-code"],\n  "settings": {"mcpFooterStatus": "off"}\n}\n',
  ],
  dsh: (t) => [
    t.configPath,
    '{\n  "timeouts": {\n    "connect_timeout": 10,\n    "execute_timeout": 60,\n    "read_timeout": 120\n  },\n  "servers": {\n    "example": {"command": "node", "args": ["./x.js"], "enabled": false}\n  }\n}\n',
  ],
  gemini: (t) => [
    t.configPath,
    '{\n  "security": {"auth": {"selectedType": "gemini-api-key"}},\n  "mcpServers": {}\n}',
  ],
  opencode: (t) => [
    t.configPath,
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {\n    "context7": {"command": ["npx", "-y", "@context7/mcp"], "enabled": true, "type": "local"}\n  }\n}\n',
  ],
};

async function seed(id, t) {
  const [path, content] = SEEDS[id](t);
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
  return content;
}

for (const id of ['claude', 'claude-desktop', 'pi', 'dsh', 'gemini', 'opencode']) {
  test(`json hosts: ${id} install keeps user bytes and uninstall restores them`, async () => {
    const { home, host, target: t } = await target(id);
    const before = await seed(id, t);

    const installed = await installHost(host, t, deps);
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.installed, true);

    const afterInstall = await fs.readFile(t.configPath, 'utf8');
    assert.notEqual(afterInstall, before);
    const parsed = JSON.parse(afterInstall);
    const entry = parsed.mcpServers?.claude_web ?? parsed.mcp?.claude_web ?? parsed.servers?.claude_web;
    assert.ok(entry, 'entry is registered');
    const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
    assert.equal(command, process.execPath);
    assert.ok(JSON.stringify(entry.args ?? entry.command).includes('mcp-server.mjs'));
    // the installed document equals the seed plus exactly our entry
    const expected = JSON.parse(before);
    let expectedCursor = expected;
    for (const segment of host.container) {
      expectedCursor[segment] ??= {};
      expectedCursor = expectedCursor[segment];
    }
    expectedCursor.claude_web = entry;
    assert.equal(canonical(parsed), canonical(expected));

    // the install record lives in the state dir, not in the host directory
    assert.equal(installed.recordPath, t.recordPath);
    assert.ok(t.recordPath.startsWith(join(home, 'state')), t.recordPath);
    await fs.access(t.recordPath);
    if (host.skills) {
      const runtime = JSON.parse(await fs.readFile(join(t.skillDest, 'runtime.json'), 'utf8'));
      assert.equal(runtime.host, id);
    } else {
      assert.equal(t.skillDest, null);
      await assert.rejects(() => fs.access(join(home, 'skills', 'claude')));
    }

    const checked = await checkHost(host, t, deps);
    assert.equal(checked.healthy, true, JSON.stringify(checked.issues));
    assert.deepEqual(checked.issues, []);

    const again = await installHost(host, t, deps);
    assert.equal(again.alreadyInstalled, true, 'install is idempotent');

    const removed = await uninstallHost(host, t, deps);
    assert.equal(removed.removed, true);
    assert.equal(await fs.readFile(t.configPath, 'utf8'), before, 'config restored byte for byte');
    await assert.rejects(() => fs.access(t.recordPath));
    if (host.skills) await assert.rejects(() => fs.access(t.skillDest));
  });
}

test('json hosts: an installer-created config is removed entirely on uninstall', async () => {
  for (const id of ['claude', 'claude-desktop', 'pi', 'dsh', 'gemini', 'opencode']) {
    const { host, target: t } = await target(id);
    const installed = await installHost(host, t, deps);
    assert.equal(installed.installed, true);
    const parsed = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
    assert.ok(JSON.stringify(parsed).includes('claude_web'));
    const removed = await uninstallHost(host, t, deps);
    assert.equal(removed.removed, true);
    await assert.rejects(() => fs.access(t.configPath), `${id} config should be gone`);
  }
});

test('json hosts: hyperlink-free on an empty home (no host config at all)', async () => {
  const { host, target: t } = await target('claude');
  const result = await installHost(host, t, deps);
  assert.equal(result.ok, true);
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  assert.deepEqual(Object.keys(doc), ['mcpServers']);
  assert.equal(doc.mcpServers.claude_web.type, 'stdio');
  assert.deepEqual(doc.mcpServers.claude_web.args, [join(deps.sourceRoot, 'src', 'mcp-server.mjs')]);
});

test('json hosts: a foreign pre-existing entry is a conflict and nothing is written', async () => {
  const { host, target: t } = await target('pi');
  await fs.mkdir(join(t.configPath, '..'), { recursive: true });
  const foreign = '{\n  "mcpServers": {\n    "claude_web": {"command": "/somewhere/else", "args": ["x"]}\n  }\n}\n';
  await fs.writeFile(t.configPath, foreign);
  const before = await fs.readdir(join(t.configPath, '..'));
  await assert.rejects(() => installHost(host, t, deps), (e) => e.code === 'INSTALL_CONFLICT');
  assert.equal(await fs.readFile(t.configPath, 'utf8'), foreign, 'foreign config untouched');
  assert.deepEqual(await fs.readdir(join(t.configPath, '..')), before);
  await assert.rejects(() => uninstallHost(host, t, deps), (e) => e.code === 'INSTALL_CONFLICT');
  assert.equal(await fs.readFile(t.configPath, 'utf8'), foreign);
});

test('json hosts: a container of the wrong JSON type is refused before any write', async () => {
  const { host, target: t } = await target('gemini');
  await fs.mkdir(join(t.configPath, '..'), { recursive: true });
  const broken = '{"mcpServers": []}';
  await fs.writeFile(t.configPath, broken);
  await assert.rejects(() => installHost(host, t, deps), (e) => e.code === 'CONFIG_INVALID');
  assert.equal(await fs.readFile(t.configPath, 'utf8'), broken);
});

test('json hosts: malformed JSON is refused without echoing the file', async () => {
  const { host, target: t } = await target('opencode');
  await fs.mkdir(join(t.configPath, '..'), { recursive: true });
  await fs.writeFile(t.configPath, '{"secret-token": "sk-live",}');
  await assert.rejects(
    () => installHost(host, t, deps),
    (e) => e.code === 'CONFIG_INVALID' && !e.message.includes('sk-live'),
  );
});

test('json hosts: an entry modified after install is OWNED_MODIFIED', async () => {
  const { host, target: t } = await target('dsh');
  await seed('dsh', t);
  await installHost(host, t, deps);
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  doc.servers.claude_web.execute_timeout = 5;
  const tampered = `${JSON.stringify(doc, null, 2)}\n`;
  await fs.writeFile(t.configPath, tampered);

  await assert.rejects(() => installHost(host, t, deps), (e) => e.code === 'OWNED_MODIFIED');
  await assert.rejects(() => uninstallHost(host, t, deps), (e) => e.code === 'OWNED_MODIFIED');
  assert.equal(await fs.readFile(t.configPath, 'utf8'), tampered);
  const checked = await checkHost(host, t, deps);
  assert.equal(checked.healthy, false);
  assert.ok(checked.issues.some((i) => i.includes('changed after installation')));
});

test('json hosts: a tampered skill file blocks uninstall and is reported by check', async () => {
  const { host, target: t } = await target('pi');
  await seed('pi', t);
  await installHost(host, t, deps);
  await fs.writeFile(join(t.skillDest, 'SKILL.md'), 'local customization');
  await assert.rejects(() => uninstallHost(host, t, deps), (e) => e.code === 'OWNED_MODIFIED');
  const checked = await checkHost(host, t, deps);
  assert.ok(checked.issues.some((i) => i.includes('SKILL.md')));
});

test('json hosts: dsh registers a consultation-length execute_timeout', async () => {
  const { host, target: t } = await target('dsh');
  await seed('dsh', t);
  await installHost(host, t, deps);
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  const entry = doc.servers.claude_web;
  assert.equal(entry.execute_timeout, 660);
  assert.equal(entry.enabled, true);
  assert.equal(entry.disabled, false);
  assert.deepEqual(entry.enabled_tools, []);
  assert.equal(doc.timeouts.execute_timeout, 60, 'user timeouts untouched');
});

test('json hosts: opencode registers a local server with an argv command', async () => {
  const { host, target: t } = await target('opencode');
  await installHost(host, t, deps);
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  assert.deepEqual(doc.mcp.claude_web, {
    type: 'local', command: [process.execPath, join(deps.sourceRoot, 'src', 'mcp-server.mjs')], enabled: true,
  });
});

test('json hosts: claude code entry declares stdio transport', async () => {
  const { host, target: t } = await target('claude');
  await installHost(host, t, deps);
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  assert.equal(doc.mcpServers.claude_web.type, 'stdio');
});

test('json hosts: dry run reports the change and writes nothing', async () => {
  const { host, target: t } = await target('claude');
  const before = await seed('claude', t);
  const result = await installHost(host, t, { ...deps, dryRun: true });
  assert.equal(result.wouldInstall, true);
  assert.deepEqual(result.changes, { config: true, skills: true });
  assert.equal(await fs.readFile(t.configPath, 'utf8'), before);
  await assert.rejects(() => fs.access(t.recordPath));
  const removal = await uninstallHost(host, t, { ...deps, dryRun: true });
  assert.equal(removal.ok, true);
  assert.equal(removal.removed, false, 'nothing installed yet, nothing to remove');
});

test('json hosts: check on a fresh home reports not installed', async () => {
  const { host, target: t } = await target('gemini');
  const result = await checkHost(host, t, deps);
  assert.equal(result.installed, false);
  assert.equal(result.healthy, false);
  assert.ok(result.issues.includes('install record missing'));
});

test('json hosts: a moved node binary upgrades the entry in place', async () => {
  const { home, host, target: t } = await target('claude');
  await seed('claude', t);
  await installHost(host, t, deps);
  const moved = join(home, 'other-node');
  await fs.writeFile(moved, '#!/bin/sh\n', { mode: 0o755 });
  const movedDeps = { ...deps, nodePath: moved };
  const upgraded = await installHost(host, t, movedDeps);
  assert.equal(upgraded.installed, true);
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  assert.equal(doc.mcpServers.claude_web.command, moved);
  const checked = await checkHost(host, t, movedDeps);
  assert.equal(checked.healthy, true, JSON.stringify(checked.issues));
  // a recorded node binary that no longer exists is a check finding
  await fs.unlink(moved);
  const stale = await checkHost(host, t, movedDeps);
  assert.equal(stale.healthy, false);
  assert.ok(stale.issues.includes('node path missing'));
});

test('json hosts: grokbuild writes a TOML block with the conservative key set', async () => {
  const { host, target: t } = await target('grokbuild');
  await fs.mkdir(join(t.configPath, '..'), { recursive: true });
  const before = '[models]\ndefault = "grok-1"\n';
  await fs.writeFile(t.configPath, before);
  const installed = await installHost(host, t, deps);
  assert.equal(installed.installed, true);
  const text = await fs.readFile(t.configPath, 'utf8');
  assert.ok(text.includes('[mcp_servers.claude_web]'));
  assert.ok(text.includes('startup_timeout_sec') === false, 'no unverified keys');
  assert.ok(text.includes('command = '));
  assert.equal(host.skills, null, 'no skill directory for this host');
  const checked = await checkHost(host, t, deps);
  assert.equal(checked.healthy, true, JSON.stringify(checked.issues));
  await uninstallHost(host, t, deps);
  assert.equal(await fs.readFile(t.configPath, 'utf8'), before);
});

test('json hosts: the reserved lock is released after every operation', async () => {
  const { host, target: t } = await target('pi');
  await seed('pi', t);
  await installHost(host, t, deps);
  const stateEntries = await fs.readdir(join(t.recordPath, '..'));
  assert.deepEqual(stateEntries, ['pi.json']);
});

test('json hosts: uninstall tolerates our entry being removed outside the installer', async () => {
  const { host, target: t } = await target('pi');
  await seed('pi', t);
  await installHost(host, t, deps);
  // the user (or another installer) drops our entry and keeps the rest
  const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
  delete doc.mcpServers.claude_web;
  const edited = `${JSON.stringify(doc, null, 2)}\n`;
  await fs.writeFile(t.configPath, edited);

  const dry = await uninstallHost(host, t, { ...deps, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.changes.config, false, 'dry run must not promise a config edit');
  assert.equal(dry.changes.skills, true);
  assert.equal(await fs.readFile(t.configPath, 'utf8'), edited, 'dry run wrote nothing');

  const removed = await uninstallHost(host, t, deps);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(await fs.readFile(t.configPath, 'utf8'), edited, 'user bytes untouched');
  await assert.rejects(() => fs.access(t.recordPath), 'install record is cleaned up');
  await assert.rejects(() => fs.access(t.skillDest), 'skill tree is cleaned up');
  const checked = await checkHost(host, t, deps);
  assert.equal(checked.installed, false);
});

test('json hosts: uninstall tolerates a removed container or a deleted config file', async () => {
  for (const [id, mutate] of [
    ['claude', async (t) => {
      const doc = JSON.parse(await fs.readFile(t.configPath, 'utf8'));
      delete doc.mcpServers;
      await fs.writeFile(t.configPath, `${JSON.stringify(doc, null, 2)}\n`);
    }],
    ['gemini', async (t) => { await fs.unlink(t.configPath); }],
  ]) {
    const { host, target: t } = await target(id);
    await seed(id, t);
    await installHost(host, t, deps);
    await mutate(t);
    const before = await fs.readFile(t.configPath, 'utf8').catch(() => null);

    const removed = await uninstallHost(host, t, deps);
    assert.equal(removed.removed, true, `${id} uninstall must still finish`);
    assert.equal(await fs.readFile(t.configPath, 'utf8').catch(() => null), before,
      `${id} must not resurrect or rewrite the user's config`);
    await assert.rejects(() => fs.access(t.recordPath), `${id} record cleaned up`);
    await assert.rejects(() => fs.access(t.skillDest), `${id} skill cleaned up`);
  }
});

test('json hosts: missing current skill source is reported as an unhealthy check', async () => {
  const { home, host, target: t } = await target('pi');
  await seed('pi', t);
  await installHost(host, t, deps);
  const checked = await checkHost(host, t, { ...deps, skillSrc: join(home, 'missing-skill') });
  assert.equal(checked.healthy, false);
  assert.ok(checked.issues.some(issue => issue.includes('current skill source unavailable')));
});

test('json hosts: check refuses a linked skill destination instead of reporting it healthy', async () => {
  const { home, host, target: t } = await target('pi');
  await seed('pi', t);
  await installHost(host, t, deps);
  const preserved = join(home, 'original-skill');
  await fs.rename(t.skillDest, preserved);
  await fs.symlink(preserved, t.skillDest);
  const checked = await checkHost(host, t, deps);
  assert.equal(checked.healthy, false);
  assert.ok(checked.issues.some(issue => /symlink|symbolic link/i.test(issue)));
  await assert.rejects(() => installHost(host, t, { ...deps, dryRun: true }), { code: 'UNSAFE_PATH' });
  assert.equal((await fs.lstat(t.skillDest)).isSymbolicLink(), true);
});

test('json hosts: a record-owned legacy skill directory upgrades to the new entry name', async () => {
  const { host, target: t } = await target('pi');
  await seed('pi', t);
  await installHost(host, t, deps);
  // Simulate a pre-rename install: move the tree to the legacy name and record it.
  const legacyDest = t.legacySkillDest;
  await fs.rename(t.skillDest, legacyDest);
  const rec = JSON.parse(await fs.readFile(t.recordPath, 'utf8'));
  rec.skillDir = legacyDest;
  await fs.writeFile(t.recordPath, JSON.stringify(rec));
  const checked = await checkHost(host, t, deps);
  assert.equal(checked.healthy, false);
  assert.ok(checked.issues.some(issue => issue.includes('skill directory at legacy path')));
  // The upgrade writes the tree to skills/claude and removes the legacy directory.
  const upgraded = await installHost(host, t, deps);
  assert.equal(upgraded.installed, true);
  assert.equal(await fs.readFile(join(t.skillDest, 'SKILL.md'), 'utf8').then((s) => s.includes('name: claude')), true);
  await assert.rejects(() => fs.access(legacyDest), 'legacy skill directory removed');
  const updated = JSON.parse(await fs.readFile(t.recordPath, 'utf8'));
  assert.equal(updated.skillDir, t.skillDest);
});
