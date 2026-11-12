#!/usr/bin/env node
// Privacy gate for delivery evidence: UTF-8 only, bounded, no secrets or host paths.
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertPublishableContent } from '../src/release/content-scan.mjs';

const MAX_BYTES = 256 * 1024;
const EXTRA_RULES = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['private-host', /\{\{HOSTNAME_[A-Za-z0-9_]+\}\}/],
  ['session-transcript', /\.claude\/projects\//],
  ['sandbox-user', /\/(?:var|private|tmp)\/[^\s/]*?(?:sandbox|claude-)[^\s/]*/i],
];
const decoder = new TextDecoder('utf-8', { fatal: true });

async function list(dir) {
  const entries = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) entries.push(...await list(path));
    else if (item.isFile()) entries.push(path);
    else throw new Error(`Unsafe evidence entry: ${path}`);
  }
  return entries;
}

const dir = resolve(process.argv[2] ?? '');
const paths = (await list(dir)).sort();
if (!paths.length) throw new Error('No evidence files');
const entries = [];
for (const path of paths) {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error(`Unsafe evidence file: ${path}`);
  const bytes = await fs.readFile(path);
  const text = decoder.decode(bytes);
  for (const [rule, pattern] of EXTRA_RULES) if (pattern.test(text)) throw new Error(`Sensitive evidence: ${path} (${rule})`);
  entries.push({ path, bytes });
}
assertPublishableContent(entries);
console.log(`evidence scrub OK: ${entries.length} files`);
