import { TextDecoder } from 'node:util';

const RULES = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['provider-key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}/],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/],
  ['url-basic-auth', /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['session-key', /\bsessionKey\s*[:=]\s*['"]?[A-Za-z0-9._-]{16,}/],
  ['secret-assignment', /\b(?:ANTHROPIC_API_KEY|CCW_API_KEY|OPENAI_API_KEY|API_KEY|SECRET|TOKEN|PASSWORD)\s*[:=]\s*['"][A-Za-z0-9_./+=-]{16,}['"]/i],
  ['posix-home-path', /(?:^|[^\w])\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ['windows-home-path', /\b[A-Z]:\\Users\\[A-Za-z0-9._-]+\\/],
];

const decoder = new TextDecoder('utf-8', { fatal: true });

export function assertPublishableContent(entries) {
  if (!Array.isArray(entries)) throw new Error('Publishable content must be an array');
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path
      || !(Buffer.isBuffer(entry.bytes) || entry.bytes instanceof Uint8Array)) {
      throw new Error('Publishable content entry is malformed');
    }
    let text;
    try {
      text = decoder.decode(entry.bytes);
    } catch {
      throw new Error(`Non-UTF-8 publishable content: ${entry.path}`);
    }
    for (const [rule, pattern] of RULES) {
      if (pattern.test(text)) throw new Error(`Sensitive content in publishable file: ${entry.path} (${rule})`);
    }
  }
}
