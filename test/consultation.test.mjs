import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as contracts from '../src/tool-contracts.mjs';

const skill = await readFile(new URL('../skills/claude/SKILL.md', import.meta.url), 'utf8');
const cases = [
  {
    name: 'stage loop',
    skill: [/当前宿主会话/, /执行 → 验证 → Claude 复审/, /同一.*session/, /claude_follow_up/, /不要.*收到.*回复.*结束/],
    instructions: [/current host agent session/, /execute.*verify.*review/is, /same session/, /Do not stop after.*reply/],
  },
  {
    name: 'authorized scenario assessment is not an event hook',
    skill: [/仅在已获.*外部咨询授权/, /规划/, /难题攻坚/, /复杂问题推理/, /本项目不提供.*事件 hook/, /未获授权.*只提示.*不.*发送/],
    instructions: [/planning, hard problem-solving and complex reasoning/, /existing user authorization/, /Without.*authorization.*do not.*send/is, /no event hooks/],
  },
  {
    name: 'actionable guidance reaches the composed prompt',
    skill: [/原样保留.*用户.*请求/, /宿主构造.*prompt/, /原样附加/, /桥接层.*不.*改写/, /方向性.*框架性/],
    instructions: [/host-composed prompt/, /original user request/, /append.*verbatim/is, /does not rewrite/],
  },
  {
    name: 'sufficient but lean context with file-level aggressive guidance',
    skill: [/上下文装配/, /8 KiB/, /不粘贴整文件/, /仓库相对路径/, /符号/, /行号/, /ultrathink/i, /进取/, /根因/, /验证门禁/, /回滚/],
    instructions: [/sufficient but lean authorized context/i, /8 KiB/, /no paste whole files|Do not paste whole files/i,
      /repository-relative paths/, /symbols/, /line numbers/, /ultrathink/i, /aggressive root-cause/i,
      /defensive guards/i, /verification (?:logic|gate)/i, /rollback/i],
  },
  {
    name: 'incomplete advice is a new targeted follow-up, not a replay',
    skill: [/回复验收/, /缺项/, /同一别名.*追问/, /complete: false/, /pending/, /新一轮.*不.*重放/],
    instructions: [/missing.*fields/is, /targeted follow-up/, /complete=false/, /pending/, /not a replay/],
  },
  {
    name: 'completion evidence',
    skill: [/验收标准/, /最新.*证据/, /最后一轮.*复审/, /有效问题/, /口头/],
    instructions: [/acceptance criteria/, /latest evidence/, /final review/, /actionable findings/, /verbal approval/i],
  },
  {
    name: 'pause and resume',
    skill: [/暂停不是完成/, /连续两轮.*(?:证据|结果)/, /预算/, /PENDING_TURN/, /claude_transcript/, /不.*自动重发/],
    instructions: [/Pause is not completion/, /two consecutive rounds/, /budget/, /PENDING_TURN/, /claude_transcript/, /never automatically resend/],
  },
  {
    name: 'one-shot and authority',
    skill: [/只问一次/, /不自动.*(?:改代码|执行)/, /授权/, /不.*后台.*(?:agent|宿主)/, /不可信/, /不自动上传/],
    instructions: [/one-shot/, /do not modify files/, /authorization/, /no background host-agent process/, /untrusted/, /minimal.*context/],
  },
  {
    name: 'publication boundaries',
    skill: [/不是.*(?:调度器|守护进程)/, /不.*保证.*(?:遵守|模型)/, /阶段完成/, /任务闭环/],
    instructions: [/not a scheduler/, /does not guarantee.*compliance/, /stage complete/, /task closed/],
  },
  {
    name: 'host neutrality',
    skill: [/宿主会话/, /Claude Code/, /Pi agent|Pi、/, /DeepSeek Harness/, /Gemini CLI/, /OpenCode/,
      /install-agents\.mjs/, /安装记录/, /不.*(?:猜测|猜写)/, /openclaw/, /omp/],
    instructions: [/host agent session/, /Codex, Claude Code, Pi, DeepSeek Harness/, /Grok Build/],
  },
  {
    name: 'attachment authority and verification',
    skill: [/CCW_ATTACHMENT_ROOT/, /不上传仓库/, /不.*(?:拼接|改名|拆批)/, /claude_download/, /SHA-256/, /不.*(?:执行|运行).*产物/, /不自动重新上传/, /--attach/, /--file.*文本/, /Frame.*未.*(?:支持|核验)/],
    instructions: [/CCW_ATTACHMENT_ROOT/, /Never upload.*repository/is, /claude_download/, /digest/, /never execute/i, /never automatically re-upload/i, /Frame.*unverified/i],
  },
  {
    name: 'fallback api sticky sessions',
    skill: [/备用 API/, /纯文本/, /复用同一别名/, /不.*(?:迁移|重放)/, /discardPending/, /cache_read_input_tokens/, /不.*(?:自动|静默).*(?:裁剪|重发)|不静默裁剪/, /密钥/],
    instructions: [/fallback HTTP Messages channel/i, /text-only and sticky/i, /never migrate/i, /discardPending/, /cache_read_input_tokens/, /PENDING_TURN/],
  },
];

test('consultation contract: the fixed guidance block is identical in the skill and MCP instructions', () => {
  const guidance = contracts.EXECUTABLE_GUIDANCE_CONTRACT;
  assert.equal(typeof guidance, 'string');
  assert.ok(guidance.startsWith('【可执行指导要求 v3】\n'));
  assert.ok(guidance.endsWith('\n【可执行指导要求结束】'));
  const block = skill.match(/```text\n(【可执行指导要求 v3】\n[\s\S]*?\n【可执行指导要求结束】)\n```/);
  assert.ok(block, 'the distributed skill must carry the copyable contract, not just its name');
  assert.equal(block[1], guidance);
  assert.equal(contracts.SERVER_INSTRUCTIONS.split(guidance).length, 2);
  for (const pattern of [/首选方案/, /前置条件/, /运行目录/, /完整.*命令/, /手工操作/, /成功.*观测/, /失败.*(?:处置|诊断)/,
    /端到端验证/, /未核验/, /取证/, /不.*(?:编造|臆造)/, /只读/, /一次性/,
    /ultrathink/i, /文件/, /仓库相对路径/, /符号/, /行号/, /进取/, /根因/, /保护层/, /兼容分支/,
    /验证门禁/, /修订/, /回滚/, /最小必要事实/, /整文件/, /完整历史/,
    /可执行单元/, /已核验/, /需本地核查/, /可证伪/, /检测命令/, /被否方案/, /切换触发/, /依赖序/]) {
    assert.match(guidance, pattern);
  }
  assert.ok(Buffer.byteLength(guidance, 'utf8') <= 2047, 'v3 must stay within about 1.3x the v2 block');
});

test('consultation contract: reply acceptance is a six-item executable checklist', () => {
  for (const pattern of [/回复验收（6 项全过才算可执行）/, /1\. 决策：/, /2\. 执行单元：/, /3\. 证据层级：/,
    /4\. 根因：/, /5\. 端到端验证：/, /6\. 范围：/, /同一别名定点追问/, /咨询简报模板/,
    /待决策项（A\/B 与判据）/, /已核验事实（路径:行 \+ 证据）/]) {
    assert.match(skill, pattern);
  }
});

test('consultation contract: both send schemas tell the host to include actionable guidance', () => {
  for (const name of ['claude_ask', 'claude_follow_up']) {
    const description = contracts.TOOLS.find(tool => tool.name === name).inputSchema.properties.prompt.description;
    for (const pattern of [/user-approved/, /【可执行指导要求 v3】/, /verbatim/, /prerequisites/, /ordered steps/, /commands/, /success/, /failure/, /sanitized summary/,
      /8 KiB/, /repository-relative paths/, /symbols/, /line numbers/, /ultrathink/i, /aggressive root-cause/i, /verification gate/i, /rollback/i]) {
      assert.match(description, pattern, name);
    }
    assert.equal(description.split(contracts.EXECUTABLE_GUIDANCE_CONTRACT).length, 2,
      `${name} must carry the complete block exactly once without relying on initialization or a skill`);
    assert.equal(contracts.TOOLS.find(tool => tool.name === name).inputSchema.properties.guidance.type, 'boolean');
  }
});

test('consultation contract: transcript recover may complete one verified held draft', () => {
  const tool = contracts.TOOLS.find((entry) => entry.name === 'claude_transcript');
  assert.match(tool.description, /held submission/i);
  assert.match(tool.description, /resumed=true/);
  assert.doesNotMatch(tool.description, /Does not send any message/);
});

test('consultation contract: one-shot limits override missing-field follow-ups', () => {
  assert.match(skill, /“只问一次”时不追加发送，直接报告缺口/);
  assert.match(contracts.SERVER_INSTRUCTIONS, /Honor explicit one-shot limits rather than sending another question/);
  assert.match(contracts.SERVER_INSTRUCTIONS, /confirmed termination and no pending turn remains/);
  assert.match(skill, /先在本地脱敏并明确标注该段是脱敏摘要/);
  assert.match(contracts.SERVER_INSTRUCTIONS, /explicitly labeled sanitized summary, never leak sensitive context/);
});

test('consultation contract: the protocol no longer self-refers to Codex as the host', () => {
  assert.doesNotMatch(skill, /当前 Codex 会话/);
  assert.doesNotMatch(contracts.SERVER_INSTRUCTIONS, /current Codex session/);
});

for (const scenario of cases) {
  test(`consultation contract: ${scenario.name}`, () => {
    for (const pattern of scenario.skill) assert.match(skill, pattern);
    assert.equal(typeof contracts.SERVER_INSTRUCTIONS, 'string');
    for (const pattern of scenario.instructions) assert.match(contracts.SERVER_INSTRUCTIONS, pattern);
  });
}
