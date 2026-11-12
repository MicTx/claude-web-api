// Documentation must not drift from the host registry: every supported host,
// its resolved config path, its skill directory, the installer commands and the
// honest list of unsupported hosts are read from src/install/hosts.mjs and
// required to appear in the user-facing docs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory, SUPPORTED_IDS } from '../src/install/engine.mjs';
import { UNSUPPORTED_HOSTS } from '../src/install/hosts.mjs';
import { run as runInstaller } from '../scripts/install-agents.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/Users/example';

const repoText = (rel) => fs.readFile(join(ROOT, rel), 'utf8');

// Registry paths are absolute for a given home; docs spell them with `~`.
const docPath = (p) => {
  if (p === HOME) return '~';
  if (p.startsWith(`${HOME}/`)) return `~${p.slice(HOME.length)}`;
  return p;
};

const hosts = inventory({ home: HOME, env: { HOME }, platform: process.platform, stateDir: join(HOME, 'state') });

test('docs: every supported host is documented with its config path and skill directory', async () => {
  const zh = await repoText('docs/usage.md');
  for (const host of hosts.filter((h) => h.status === 'supported')) {
    assert.ok(zh.includes(host.label), `docs/usage.md must name ${host.label}`);
    assert.ok(zh.includes(docPath(host.mcp.configPath)), `docs/usage.md must show ${docPath(host.mcp.configPath)}`);
    assert.ok(zh.includes(`\`${host.id}\``), `docs/usage.md must show the host id ${host.id}`);
    if (host.skills) assert.ok(zh.includes(docPath(host.skills.dir)), `docs/usage.md must show ${docPath(host.skills.dir)}`);
    else assert.match(zh, /无技能目录|无（桌面端/, `${host.id} has no skill directory and must say so`);
  }
});

test('docs: both READMEs carry the host matrix and the installer commands', async () => {
  const zh = await repoText('README.md');
  const en = await repoText('README.en.md');
  for (const host of hosts.filter((h) => h.status === 'supported')) {
    assert.ok(zh.includes(host.label), `README.md must name ${host.label}`);
    assert.ok(en.includes(host.label), `README.en.md must name ${host.label}`);
    assert.ok(zh.includes(docPath(host.mcp.configPath)), `README.md must show ${docPath(host.mcp.configPath)}`);
    assert.ok(en.includes(docPath(host.mcp.configPath)), `README.en.md must show ${docPath(host.mcp.configPath)}`);
  }
  assert.match(en, /none \(no skill directory\)/);
  for (const text of [zh, en]) {
    assert.match(text, /ccw-hosts" --list/);
    assert.match(text, /ccw-hosts" --host dsh --dry-run/);
    assert.match(text, /ccw-hosts" --host dsh\n/);
    assert.match(text, /ccw-hosts" --check --host dsh/);
    assert.ok(text.includes('docs/install.md'));
    assert.ok(text.includes('docs/install.en.md'));
    assert.ok(text.includes('llms.txt'));
  }
});

test('docs: unsupported cc-switch hosts are reported, never silently dropped', async () => {
  const zh = await repoText('README.md');
  const usage = await repoText('docs/usage.md');
  for (const host of UNSUPPORTED_HOSTS) {
    assert.ok(zh.includes(host.id), `README.md must list ${host.id} as unsupported`);
    assert.ok(usage.includes(host.id), `docs/usage.md must list ${host.id} as unsupported`);
  }
  assert.match(usage, /不支持原因|未核验/);
});

test('docs: the installer commands and script entries exist', async () => {
  const pkg = JSON.parse(await repoText('package.json'));
  assert.equal(pkg.scripts['install:agents'], 'node scripts/install-agents.mjs');
  assert.equal(pkg.scripts['install:codex'], 'node scripts/install-codex.mjs');
  assert.equal(pkg.scripts['verify:plugin'], 'node scripts/verify-plugin.mjs');
  assert.equal(pkg.scripts['verify:structure'], 'node scripts/verify-structure.mjs');
  await fs.access(join(ROOT, 'scripts', 'install-agents.mjs'));
  await fs.access(join(ROOT, 'scripts', 'install-codex.mjs'));
  await fs.access(join(ROOT, 'scripts', 'verify-plugin.mjs'));
  await fs.access(join(ROOT, 'scripts', 'verify-structure.mjs'));
  const zh = await repoText('README.md');
  const en = await repoText('README.en.md');
  for (const text of [zh, en]) {
    assert.ok(text.includes('npm run verify:plugin'));
    assert.ok(text.includes('npm run verify:structure'));
    assert.ok(text.includes('codex'));
  }
});

test('docs: the skill documents every supported host and the installer', async () => {
  const skill = await repoText('skills/claude/SKILL.md');
  for (const host of hosts.filter((h) => h.status === 'supported')) {
    assert.ok(skill.includes(host.label), `SKILL.md must name ${host.label}`);
    assert.ok(skill.includes(docPath(host.mcp.configPath)) || host.id === 'claude-desktop',
      `SKILL.md must show ${docPath(host.mcp.configPath)}`);
  }
  assert.match(skill, /ccw-hosts" --list/);
  assert.match(skill, /开发仓库不能作为运行/);
  assert.match(skill, /Release/);
  assert.match(skill, /安装记录/);
  assert.match(skill, /不猜测写入|不.*猜测/);
});

test('docs: the MCP registration name is consistent across docs and code', async () => {
  const [zh, en, usage, skill] = await Promise.all([
    repoText('README.md'), repoText('README.en.md'), repoText('docs/usage.md'), repoText('skills/claude/SKILL.md'),
  ]);
  for (const text of [zh, en, usage, skill]) assert.ok(text.includes('claude_web'));
  for (const id of SUPPORTED_IDS) assert.ok(hosts.some((h) => h.id === id));
});

test('docs: consultation distinguishes semantic triggers and requires executable guidance', async () => {
  const zh = await repoText('README.md');
  const en = await repoText('README.en.md');
  const usage = await repoText('docs/usage.md');
  for (const text of [zh, usage]) {
    for (const pattern of [/本项目不提供事件 hook/, /规划/, /难题攻坚/, /复杂问题推理/, /授权/, /首选方案/,
      /前置条件/, /完整命令/, /成功观测/, /失败/, /端到端验证/, /8 KiB/, /ultrathink/i, /文件级/, /进取/, /根因/, /门禁/, /回滚/]) assert.match(text, pattern);
  }
  for (const pattern of [/no event hooks/, /existing user authorization/, /planning, hard problem-solving and complex reasoning/,
    /preferred solution/, /prerequisites/, /ordered concrete steps/, /exact commands/, /success observations/, /failure handling/, /end-to-end verification/,
    /sufficient but lean context/i, /8 KiB/, /ultrathink/i, /file-level/i, /aggressive root-cause/i, /verification gate/i, /rollback/i]) {
    assert.match(en, pattern);
  }
  for (const text of [zh, en]) assert.ok(text.includes('docs/usage.md#可执行端到端指导'));
  assert.match(usage, /guidanceAppended:false.*不证明.*完整 v3/);
  assert.match(usage, /契约升级后相同开关可能得到不同正文/);
  assert.match(usage, /PROMPT_MISMATCH.*不打开浏览器.*不改 pending.*不发送/);
  for (const pattern of [/initialize\.instructions.*只到宿主/, /默认不改写正文/, /guidanceAppended/, /--guidance/, /EXECUTABLE_GUIDANCE_CONTRACT/, /不从开发目录导入/,
    /只问一次/, /缺项/, /pending/, /complete: false/, /前两层不证明模型遵守/, /已安装.*不会自行刷新/,
    /8 KiB/, /ultrathink/i, /文件级/, /进取/, /根因/, /验证门禁/, /回滚/, /整文件/, /最小必要事实/,
    /已核验/, /需本地核查/, /可证伪/, /PreToolUse/, /用户自管/, /不写宿主事件配置/]) assert.match(usage, pattern);
});

test('docs: the opt-in PreToolUse recipe matches both direct and Magpie tools', async () => {
  const usage = await repoText('docs/usage.md');
  const section = usage.split('### 可选：Claude Code PreToolUse 加固（用户自管）')[1]?.split('\n## ')[0];
  assert.ok(section, 'the manual hook section must exist');
  const script = section.match(/```js\n([\s\S]*?)\n```/)?.[1];
  const config = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
  assert.ok(script && config, 'the manual recipe must have executable script and configuration');
  const hook = JSON.parse(config).hooks.PreToolUse[0];
  assert.equal(hook.hooks[0].onFailure, 'block');
  assert.notEqual(hook.hooks[0].async, true);
  assert.notEqual(hook.hooks[0].asyncRewake, true);
  assert.match(section, /v2\.1\.295/);
  const matcher = new RegExp(hook.matcher);
  for (const name of ['mcp__claude_web__claude_ask', 'mcp__claude_web__claude_follow_up',
    'mcp__magpie__claude_web__claude_ask', 'mcp__magpie__claude_web__claude_follow_up']) {
    assert.match(name, matcher);
  }
  for (const name of ['mcp__claude_web__claude_doctor', 'mcp__magpie__claude_web__claude_transcript',
    'mcp__other__claude_ask', 'mcp__unrelated__claude_follow_up']) {
    assert.doesNotMatch(name, matcher);
  }
  const run = tool_input => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify({ tool_input }), encoding: 'utf8',
  });
  assert.equal(run({ prompt: '请求', guidance: true }).status, 0);
  assert.equal(run({ prompt: '请求\n【可执行指导要求 v3】' }).status, 0);
  for (const prompt of ['请求\n【可执行指导要求', '请求\n【可执行指导要求 v3', '请求\n【可执行指导要求结束】']) {
    assert.equal(run({ prompt }).status, 2, `non-marker: ${prompt}`);
  }
  for (const guidance of [undefined, false, 'true', 1]) {
    assert.equal(run({ prompt: '请求', guidance }).status, 2, `guidance=${String(guidance)}`);
  }
});

test('docs: multi-source, read-only probe and explicit recovery are documented across consumer guides', async () => {
  for (const file of ['README.md', 'README.en.md', 'docs/usage.md', 'docs/install.md', 'docs/install.en.md', 'llms.txt', 'skills/claude/SKILL.md']) {
    const text = await repoText(file);
    for (const value of ['--check', '--probe', '--reconcile', '--dry-run', 'configured:true', 'installed:false']) {
      assert.ok(text.includes(value), `${file} missing ${value}`);
    }
    assert.match(text, /归属|ownership/);
  }
  for (const file of ['README.md', 'README.en.md', 'docs/install.md', 'docs/install.en.md', 'llms.txt']) {
    const text = await repoText(file);
    assert.match(text, /PATH/);
    assert.match(text, /node/);
    assert.match(text, /reconnect|重连/);
    assert.ok(!text.includes('/opt/homebrew/Cellar/node/'), `${file} must not document a versioned Node path`);
  }
  for (const file of ['README.md', 'README.en.md', 'docs/usage.md', 'llms.txt', 'skills/claude/SKILL.md']) {
    const text = await repoText(file);
    for (const value of ['configuration-only', 'protocol-only', 'hostLoaded:false', 'recoveryPath']) assert.ok(text.includes(value), `${file} missing evidence boundary ${value}`);
  }
  const usage = await repoText('docs/usage.md');
  for (const value of ['PROBE_STALE_SCHEMA', 'PROBE_DISCOVERY_ONLY', '--discover', 'discovery-schemas',
    'claude_web__claude_download', 'claude_web__claude_doctor', 'DISCOVERY_*',
    '0700', '0600', 'install-recovery', '5 秒', '1 MiB', '4 MiB', '8 页', '原像', '符号链接', '锁', '并发']) assert.ok(usage.includes(value), `usage missing ${value}`);
  for (const value of ['--discover', 'externalSkill.status', 'discovery-schemas', 'healthy route']) assert.ok((await repoText('llms.txt')).includes(value), `llms missing ${value}`);
  for (const value of ['sharedSkills', '~/.agents/skills', 'externalSkill.shared']) {
    assert.ok((await repoText('llms.txt')).includes(value), `llms missing shared skill evidence ${value}`);
    assert.ok((await repoText('docs/install.md')).includes(value), `install missing shared skill evidence ${value}`);
    assert.ok((await repoText('docs/install.en.md')).includes(value), `install.en missing shared skill evidence ${value}`);
  }
  assert.ok((await repoText('docs/install.md')).includes('不管勾没勾选'));
  assert.ok((await repoText('docs/install.en.md')).includes('regardless of per-agent assignment'));
  for (const file of ['docs/install.md', 'docs/install.en.md']) {
    const text = await repoText(file);
    for (const value of ['reconnectCleared', 'reconnectMarker', 'no-release-root', 'UNSAFE_PATH']) {
      assert.ok(text.includes(value), `${file} missing ${value}`);
    }
    assert.ok(text.includes('warning'), `${file} missing probe warning contract`);
  }
  for (const file of ['README.md', 'README.en.md']) {
    assert.ok((await repoText(file)).includes('externalSkill.status:"stale"'), `${file} missing external freshness boundary`);
    assert.ok((await repoText(file)).includes('sharedSkills'), `${file} missing shared skill freshness boundary`);
  }
  for (const value of ['--discover', 'claude_web__claude_download', 'claude_web__claude_doctor']) {
    assert.ok((await repoText('skills/claude/SKILL.md')).includes(value), `skill missing ${value}`);
  }
  let help = '';
  assert.equal(await runInstaller(['--help'], { stdout: { write: s => { help += s; } } }), 0);
  for (const flag of ['--probe', '--discover', '--reconcile', '--check', '--dry-run']) assert.ok(help.includes(flag));
  let output = '';
  assert.equal(await runInstaller(['--probe'], { stdout: { write: s => { output += s; } } }), 1);
  assert.equal(JSON.parse(output).error.code, 'INVALID_ARGUMENT');
  output = '';
  assert.equal(await runInstaller(['--discover'], { stdout: { write: s => { output += s; } } }), 1);
  assert.equal(JSON.parse(output).error.code, 'INVALID_ARGUMENT');
});

test('docs: API protocols document their distinct effort, limits and usage boundaries', async () => {
  for (const file of ['README.md', 'README.en.md', 'docs/usage.md']) {
    const text = await repoText(file);
    for (const keyword of ['CCW_API_PROTOCOL', 'messages', 'chat', 'responses', 'reasoning_effort', 'output_config.effort', 'reasoning.effort']) {
      assert.ok(text.includes(keyword), `${file} missing ${keyword}`);
    }
  }
  const reference = await repoText('docs/api-protocols.md');
  for (const keyword of ['/v1/messages', '/v1/chat/completions', '/v1/responses', 'max_completion_tokens', 'max_output_tokens', 'reasoningTokens', 'null', 'off', 'none', 'store: false']) {
    assert.ok(reference.includes(keyword), `protocol reference missing ${keyword}`);
  }
  const usage = await repoText('docs/usage.md');
  for (const text of [usage, reference]) {
    for (const keyword of ['stream: true', 'message_delta', 'message_stop', 'API_STREAM_INCOMPLETE', 'pending', '429', 'JSON']) {
      assert.ok(text.includes(keyword), `SSE documentation missing ${keyword}`);
    }
    assert.match(text, /累计/);
    assert.match(text, /不逐 token|不是向调用者逐 token/);
  }
  assert.match(reference, /Chat\/Responses 保持 `stream: false`/);
  assert.ok(!reference.includes('拒绝重定向、工具调用、流式响应'));
});
