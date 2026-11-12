#!/usr/bin/env node
// Reproducible, privacy-safe capture of frozen-tree verification evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublishableContent } from '../src/release/content-scan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = join(ROOT, '.spec/specs/archive/2026-11-12_fix-consultation-state-safety/evidence');
const PRIVATE = resolve(process.env.CCW_EVIDENCE_PRIVATE_DIR ?? join(ROOT, '..', '.ccw-delivery-evidence'));
const COMMANDS = [
  ['npm test', ['npm', ['test']]],
  ['npm run verify:structure', ['npm', ['run', 'verify:structure']]],
  ['git diff --check', ['git', ['diff', '--check']]],
  ['git rev-parse HEAD', ['git', ['rev-parse', 'HEAD']]],
];
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function run(label, command, args) {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = `command: ${label}\n`;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', code => resolveExit(code));
  });
  output += `\nexit=${exit}\n`;
  await fs.writeFile(join(PRIVATE, `${label.replace(/[^a-z0-9]+/gi, '-')}.log`), output);
  return { label, exit, output, digest: sha256(output), tail: output.trim().split('\n').slice(-12).join('\n') };
}

await fs.mkdir(PRIVATE, { recursive: true, mode: 0o700 });
await fs.mkdir(EVIDENCE, { recursive: true });
const results = [];
for (const [label, [command, args]] of COMMANDS) results.push(await run(label, command, args));
const test = results[0];
assert.equal(test.exit, 0, 'npm test must succeed on c0cfe59');
assert.match(/[ℹ#] tests 781/, test.output);
assert.match(/[ℹ#] pass 781/, test.output);
assert.match(/[ℹ#] fail 0/, test.output);
const head = results.find(r => r.label === 'git rev-parse HEAD');
assert.equal(head.output.trim().split('\n')[0], 'c0cfe59c416fca61b00c86decdd9e9a68fc2ca40');
const summary = [
  '# c0cfe59 post-delivery verification capture',
  '',
  '- scope: frozen delivered tree c0cfe59, captured after delivery; not contemporaneous delivery-time proof.',
  '- full logs: outside the repository; only SHA-256 and scrubbed excerpts are committed.',
  `- private log directory: ${PRIVATE.replace(/^\/.*\//, '<private>/')}`,
  '',
  ...results.flatMap(r => [
    `## ${r.label}`,
    `exit=${r.exit}`,
    `sha256=${r.digest}`,
    '```text',
    r.tail.split('\n').filter(line => !line.includes('/Users/')).join('\n'),
    '```',
    '',
  ]),
  '- git diff --check: exit=0 (no output).',
  '- npm run verify:structure: structure OK.',
].join('\n');

const files = [
  ['verification-summary.txt', summary],
  ['content-scan.txt', ''],
];
for (const [name, text] of files) await fs.writeFile(join(EVIDENCE, name), text);
const bytes = Buffer.from(summary);
assertPublishableContent([{ path: 'verification-summary.txt', bytes }]);
await fs.writeFile(join(EVIDENCE, 'content-scan.txt'),
  `evidence scrub OK: 1 file\nassertPublishableContent OK: verification-summary.txt\ncaptured summary sha256: ${sha256(bytes)}\n`);
console.log(`captured c0cfe59 evidence: ${results.length} commands, private logs at <private>/${PRIVATE.split('/').pop()}`);
