import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

const files = ['docs/claude-web-protocol.md', 'docs/claude-design-protocol.md'];
const denied = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /approvalSha256|approval-file|next-approval|\.design-reservation|ledger|采样账本|审批轮换|剩余额度|累计 reads|G0[ab12]?|mutation-result\.json/i,
  /Chrome 156\.0|Pro，UI 语言|Asia\/Tokyo|devin\/chrome-japan|frame\.claudeusercontent\.com|claudeai-rpc|bard\.api/i,
  /\b(?:[a-f0-9]{64})\b/i,
  /账号：|组织 ID|org_uuid|customer_terms|resets_at|utilization|608,203|42,813|829 字节/i,
];
const required = [
  ['docs/claude-web-protocol.md', ['公开净化版', '不是稳定公共 API', 'pending', 'PROMPT_MISMATCH', 'U+FFFD', '原件导出未核验', 'API 协议参考']],
  ['docs/claude-design-protocol.md', ['公开净化版', '不是 claude.ai 官方文档', '声明', '投影', '原件', '未核验', '不构成授权']],
];

for (const [file, values] of required) {
  const text = await fs.readFile(file, 'utf8');
  for (const value of values) assert.ok(text.includes(value), `${file} missing ${value}`);
}
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  for (const pattern of denied) assert.doesNotMatch(text, pattern, `${file} contains private evidence: ${pattern}`);
}
console.log(`public protocol docs OK: ${files.length} sanitized files`);
