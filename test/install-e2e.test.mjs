// End-to-end acceptance: every supported host goes install -> check -> install
// (idempotent) -> uninstall through the real CLI in a temporary HOME, and the
// registered entry is proven executable by speaking MCP to it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'install-agents.mjs');

const SEEDS = {
  codex: ['config.toml', '# user codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n'],
  claude: ['.claude.json', '{\n  "numStartups": 3,\n  "mcpServers": {\n    "other": {"command": "/bin/other"}\n  }\n}\n'],
  'claude-desktop': [
    'Library/Application Support/Claude/claude_desktop_config.json',
    '{\n  "deploymentMode": "3p",\n  "preferences": {"coworkLegacyRootGrantsPruned": true}\n}\n',
  ],
  pi: ['.pi/agent/mcp.json', '{\n  "mcpServers": {},\n  "imports": ["cursor"],\n  "settings": {"mcpFooterStatus": "off"}\n}\n'],
  dsh: [
    '.deepseek/mcp.json',
    '{\n  "timeouts": {"connect_timeout": 10, "execute_timeout": 60, "read_timeout": 120},\n  "servers": {"example": {"command": "node", "args": ["./x.js"], "enabled": false}}\n}\n',
  ],
  gemini: ['.gemini/settings.json', '{\n  "security": {"auth": {"selectedType": "gemini-api-key"}},\n  "mcpServers": {}\n}\n'],
  opencode: [
    '.config/opencode/opencode.json',
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {"context7": {"command": ["npx", "-y", "@context7/mcp"], "enabled": true, "type": "local"}}\n}\n',
  ],
  grokbuild: ['.grok/config.toml', '[models]\ndefault = "grok-1"\n'],
};

function run(args, { home }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: home },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, out: out.trim() ? JSON.parse(out.trim()) : null, raw: out, err }));
  });
}

async function readIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

test('e2e: all eight hosts survive install, check, reinstall and uninstall byte-identically', async () => {
  const home = await makeTmpDir('ccw-e2e-');
  const stateDir = join(home, 'state');
  const snapshots = {};
  for (const [id, [rel, content]] of Object.entries(SEEDS)) {
    const path = join(home, rel);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content);
    snapshots[id] = { rel, content };
  }

  const install = await run(['--all', '--state-dir', stateDir], { home });
  assert.equal(install.code, 0, install.raw);
  assert.equal(install.out.hosts.length, 8);
  for (const host of install.out.hosts) {
    assert.equal(host.ok, true, `${host.host}: ${JSON.stringify(host.error ?? {})}`);
    assert.equal(host.installed, true, host.host);
  }

  // the registered entry is really executable and exposes the six tools
  const claudeConfig = JSON.parse(await fs.readFile(join(home, '.claude.json'), 'utf8'));
  const entry = claudeConfig.mcpServers.claude_web;
  assert.equal(entry.type, 'stdio');
  const client = new Client({ name: 'ccw-e2e', version: '1' });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: home },
  });
  t: {
    await client.connect(transport);
    const tools = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema);
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      'claude_ask', 'claude_doctor', 'claude_download', 'claude_follow_up', 'claude_sessions', 'claude_transcript',
    ]);
    await client.close();
  }

  const check = await run(['--check', '--all', '--state-dir', stateDir], { home });
  assert.equal(check.code, 0, check.raw);
  for (const host of check.out.hosts) {
    assert.equal(host.healthy, true, `${host.host}: ${JSON.stringify(host.issues)}`);
  }

  const again = await run(['--all', '--state-dir', stateDir], { home });
  assert.equal(again.code, 0, again.raw);
  assert.ok(again.out.hosts.every((h) => h.alreadyInstalled === true), again.raw);

  const uninstall = await run(['--uninstall', '--all', '--state-dir', stateDir], { home });
  assert.equal(uninstall.code, 0, uninstall.raw);
  assert.ok(uninstall.out.hosts.every((h) => h.removed === true), uninstall.raw);

  for (const [id, { rel, content }] of Object.entries(snapshots)) {
    assert.equal(await readIfExists(join(home, rel)), content, `${id} config restored byte for byte`);
  }
  // no skill directories, records or locks left behind
  for (const leftover of ['.codex/skills/claude', '.claude/skills/claude', '.pi/agent/skills/claude',
    '.deepseek/skills/claude', '.gemini/skills/claude', '.config/opencode/skills/claude']) {
    assert.equal(await readIfExists(join(home, leftover)), null, `${leftover} removed`);
  }
  assert.deepEqual(await fs.readdir(join(stateDir, 'installs')), [], 'records removed');
  assert.deepEqual((await fs.readdir(stateDir)).filter((f) => f.includes('.lock')), [], 'locks released');
});

test('e2e: the installed skill calls back into this repository CLI', async () => {
  const home = await makeTmpDir('ccw-e2e-skill-');
  const install = await run(['--host', 'pi', '--state-dir', join(home, 'state')], { home });
  assert.equal(install.code, 0, install.raw);
  const runtime = JSON.parse(await fs.readFile(join(home, '.pi/agent/skills/claude/runtime.json'), 'utf8'));
  assert.equal(runtime.cli, join(ROOT, 'bin', 'ccw.mjs'));
  assert.equal(runtime.host, 'pi');
  const wrapper = await fs.readFile(join(home, '.pi/agent/skills/claude/scripts/ccw.mjs'), 'utf8');
  assert.match(wrapper, /runtime\.json/);
  // the wrapper resolves to a working CLI
  const child = spawn(process.execPath, [join(home, '.pi/agent/skills/claude/scripts/ccw.mjs'), '--help'], {
    cwd: home, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: home },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  assert.match(out, /Usage:/);
});
