import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HOSTS, UNSUPPORTED_HOSTS, SUPPORTED_IDS, findHost, inventory, isDetected, resolveTargets } from '../src/install/hosts.mjs';
import { parseHomeOverrides, parseHostSelection, defaultStateDir, sourcePaths } from '../src/install/engine.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';
import { promises as fs } from 'node:fs';

after(() => cleanupTmpDirs());

const base = (home, extra = {}) => ({ home, env: { HOME: home }, platform: 'darwin', stateDir: join(home, 'state'), ...extra });
const targetOf = (id, home, extra) => {
  const found = resolveTargets(base(home, extra)).find((e) => e.host.id === id);
  assert.ok(found, `host ${id} is not in the registry`);
  return found.target;
};

test('host registry: supported hosts are the eight verified agent hosts', () => {
  assert.deepEqual(SUPPORTED_IDS, [
    'codex', 'claude', 'claude-desktop', 'pi', 'dsh', 'gemini', 'opencode', 'grokbuild',
  ]);
  for (const id of SUPPORTED_IDS) assert.ok(findHost(id), `${id} must resolve`);
  assert.equal(findHost('nope'), null);
});

test('host registry: every supported host has an evidence note and a format', () => {
  for (const host of HOSTS) {
    assert.ok(host.label && typeof host.label === 'string');
    assert.ok(['toml', 'json-members'].includes(host.format), `${host.id} format`);
    assert.ok(typeof host.evidence === 'string' && host.evidence.length > 0, `${host.id} evidence`);
    assert.equal(host.serverName, 'claude_web');
    assert.equal(host.skillName, 'claude');
    if (host.format === 'json-members') {
      assert.ok(Array.isArray(host.container) && host.container.length > 0, `${host.id} container`);
      assert.equal(typeof host.entry, 'function', `${host.id} entry builder`);
    }
  }
});

test('host registry: config paths follow each host convention', async () => {
  const home = await makeTmpDir('ccw-hosts-');
  const paths = Object.fromEntries(HOSTS.map((h) => [h.id, targetOf(h.id, home)]));
  assert.equal(paths.codex.configPath, join(home, '.codex', 'config.toml'));
  assert.equal(paths.codex.skillDest, join(home, '.codex', 'skills', 'claude'));
  assert.equal(paths.claude.configPath, join(home, '.claude.json'));
  assert.equal(paths.claude.skillsDir, join(home, '.claude', 'skills'));
  assert.equal(paths['claude-desktop'].configPath, join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.equal(paths['claude-desktop'].skillsDir, null);
  assert.equal(paths.pi.configPath, join(home, '.pi', 'agent', 'mcp.json'));
  assert.equal(paths.dsh.configPath, join(home, '.deepseek', 'mcp.json'));
  assert.equal(paths.gemini.configPath, join(home, '.gemini', 'settings.json'));
  assert.equal(paths.opencode.configPath, join(home, '.config', 'opencode', 'opencode.json'));
  assert.equal(paths.grokbuild.configPath, join(home, '.grok', 'config.toml'));
  assert.equal(paths.grokbuild.skillsDir, null);
  for (const [id, target] of Object.entries(paths)) {
    if (id === 'codex') continue; // historical record/lock live inside its own home
    assert.ok(target.recordPath.startsWith(join(home, 'state')), `record stays in the state dir: ${target.recordPath}`);
    assert.ok(target.lockPath.startsWith(join(home, 'state')), `lock stays in the state dir: ${target.lockPath}`);
  }
  // codex keeps its historical record and lock location inside its own home
  assert.equal(paths.codex.recordPath, join(home, '.codex', 'claude-web-api-install.json'));
});

test('host registry: a record under another product name is never adopted', async () => {
  const home = await makeTmpDir('ccw-hosts-legacy-');
  const codex = join(home, '.codex');
  await fs.mkdir(codex, { recursive: true });
  // A record file from a different product name must not steer this runtime.
  await fs.writeFile(join(codex, 'call-claude-webkit-install.json'), '{}');
  const target = targetOf('codex', home);
  assert.equal(target.recordPath, join(codex, 'claude-web-api-install.json'));
  assert.equal(target.lockPath, join(codex, '.claude-web-api-install.lock'));
});

test('host registry: host env overrides are honoured', async () => {
  const home = await makeTmpDir('ccw-hosts-env-');
  const env = {
    HOME: home, CODEX_HOME: join(home, 'cx'), CLAUDE_CONFIG_DIR: join(home, 'cc'),
    PI_CODING_AGENT_DIR: join(home, 'pi'), DEEPSEEK_HOME: join(home, 'ds'), XDG_CONFIG_HOME: join(home, 'xdg'),
  };
  assert.equal(targetOf('codex', home, { env }).configPath, join(home, 'cx', 'config.toml'));
  assert.equal(targetOf('claude', home, { env }).configPath, join(home, 'cc', '.claude.json'));
  assert.equal(targetOf('pi', home, { env }).configPath, join(home, 'pi', 'mcp.json'));
  assert.equal(targetOf('dsh', home, { env }).configPath, join(home, 'ds', 'mcp.json'));
  assert.equal(targetOf('opencode', home, { env }).configPath, join(home, 'xdg', 'opencode', 'opencode.json'));
});

test('host registry: per-host --home overrides win over the environment', async () => {
  const home = await makeTmpDir('ccw-hosts-override-');
  const override = join(home, 'custom');
  const target = targetOf('pi', home, { overrides: { pi: override } });
  assert.equal(target.configPath, join(override, 'mcp.json'));
  assert.equal(target.skillsDir, join(override, 'skills'));
});

test('host registry: claude-desktop path is platform aware', async () => {
  const home = await makeTmpDir('ccw-hosts-plat-');
  const linux = targetOf('claude-desktop', home, { platform: 'linux', env: { HOME: home } });
  assert.equal(linux.configPath, join(home, '.config', 'Claude', 'claude_desktop_config.json'));
  const win = targetOf('claude-desktop', home, { platform: 'win32', env: { HOME: home, APPDATA: join(home, 'AppData') } });
  assert.equal(win.configPath, join(home, 'AppData', 'Claude', 'claude_desktop_config.json'));
});

test('host registry: cc-switch hosts without verified evidence are unsupported', () => {
  const ids = UNSUPPORTED_HOSTS.map((h) => h.id);
  assert.deepEqual(ids.sort(), ['agy', 'hermes', 'kimi', 'mcode', 'omp', 'openclaw']);
  for (const host of UNSUPPORTED_HOSTS) {
    assert.equal(host.status, 'unsupported');
    assert.ok(host.reason.length > 0, `${host.id} needs a reason`);
    assert.equal(findHost(host.id), null, `${host.id} must not resolve to a writable host`);
  }
});

test('host registry: inventory lists supported paths and unsupported reasons', async () => {
  const home = await makeTmpDir('ccw-hosts-inventory-');
  const list = inventory(base(home));
  assert.equal(list.length, SUPPORTED_IDS.length + UNSUPPORTED_HOSTS.length);
  const claude = list.find((h) => h.id === 'claude');
  assert.equal(claude.status, 'supported');
  assert.equal(claude.mcp.configPath, join(home, '.claude.json'));
  assert.equal(claude.mcp.serverName, 'claude_web');
  assert.equal(claude.skills.dir, join(home, '.claude', 'skills'));
  const desktop = list.find((h) => h.id === 'claude-desktop');
  assert.equal(desktop.skills, null);
  const kimi = list.find((h) => h.id === 'kimi');
  assert.equal(kimi.status, 'unsupported');
  assert.ok(kimi.reason.length > 0);
});

test('host registry: detection follows the host directory or config file', async () => {
  const home = await makeTmpDir('ccw-hosts-detect-');
  const io = { lstat: fs.lstat };
  const claude = resolveTargets(base(home)).find((e) => e.host.id === 'claude');
  assert.equal(await isDetected(io, claude.host, claude.target), false);
  await fs.mkdir(join(home, '.claude'), { recursive: true });
  assert.equal(await isDetected(io, claude.host, claude.target), true);
});

test('host registry: selection parsing rejects unknown hosts and relative dirs', () => {
  assert.equal(parseHostSelection([]), null);
  assert.deepEqual(parseHostSelection(['claude,pi', 'dsh']), ['claude', 'pi', 'dsh']);
  assert.throws(() => parseHostSelection(['nope']), /Unknown host/);
  assert.deepEqual(parseHomeOverrides(['pi=/tmp/pi']), { pi: '/tmp/pi' });
  assert.throws(() => parseHomeOverrides(['nope=/tmp/x']), /unknown host/);
  assert.throws(() => parseHomeOverrides(['pi=rel/path']), /absolute/);
  assert.throws(() => parseHomeOverrides(['malformed']), /<host>=<dir>/);
});

test('host registry: source paths point at the MCP server and CLI entries', () => {
  const paths = sourcePaths('/tmp/src');
  assert.equal(paths.mcpPath, '/tmp/src/src/mcp-server.mjs');
  assert.equal(paths.cliPath, '/tmp/src/bin/ccw.mjs');
  assert.equal(paths.skillSrc, '/tmp/src/skills/claude');
  assert.equal(paths.nodePath, process.execPath);
  assert.equal(defaultStateDir({ HOME: '/tmp/h' }), join('/tmp/h', '.local', 'share', 'claude-web-api'));
  assert.equal(defaultStateDir({ HOME: '/tmp/h', CCW_STATE_DIR: '/tmp/s' }), '/tmp/s');
});
