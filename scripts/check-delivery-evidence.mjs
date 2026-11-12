#!/usr/bin/env node
// Verify additive delivery evidence without modifying files or rewriting history.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = '.spec/specs/archive/2026-11-12_fix-consultation-state-safety';
const DELIVERED = '7b90e45';
const FROZEN_FILES = ['completion-summary.md', 'runs.jsonl', 'spec.md', 'tasks.md'];
const read = path => fs.readFile(join(ROOT, path), 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

const supplement = await read(`${ARCHIVE}/supplement.md`);
for (const required of [
  'No retained lessons',
  '8 pre-delivery rows',
  '21 rows',
  'reconstruction',
  'c0cfe59',
  '90d4be3',
  'd754193',
  '9a31d56',
  'host before/after evidence ABSENT',
  'not released',
  'not installation-verified',
  'not contemporaneous proof',
]) assert.ok(supplement.includes(required), `supplement missing: ${required}`);
assert.ok(!supplement.includes('/Users/'), 'supplement contains a host path');

for (const name of FROZEN_FILES) {
  const current = await fs.readFile(join(ROOT, ARCHIVE, name));
  const delivered = execFileSync('git', ['show', `${DELIVERED}:${ARCHIVE}/${name}`], { cwd: ROOT });
  assert.equal(sha256(current), sha256(delivered), `${name} must remain frozen`);
}

const rows = (await read(`${ARCHIVE}/runs.jsonl`)).trim().split('\n');
assert.equal(rows.length, 29);
const active = git(['show', '3823b6c:.spec/specs/2026-11-12_fix-consultation-state-safety/runs.jsonl']).trim().split('\n');
assert.equal(active.length, 8);
assert.deepEqual(rows.slice(0, 8), active, 'first eight rows must have pre-delivery provenance');

const provenance = JSON.parse(await read(`${ARCHIVE}/evidence/runs-provenance.json`));
assert.equal(provenance.preDeliveryRows, 8);
assert.equal(provenance.firstMaterializedInDeliveryRows, 21);
assert.equal(provenance.proofLevel, 'reconstruction');
assert.equal(provenance.deliveryCommit, DELIVERED);

const summary = await read(`${ARCHIVE}/evidence/verification-summary.txt`);
for (const required of ['tests 781', 'pass 781', 'fail 0', 'structure OK', 'git diff --check', 'exit=0', 'c0cfe59']) {
  assert.ok(summary.includes(required), `verification evidence missing: ${required}`);
}
assert.ok(!summary.includes('/Users/'), 'verification summary contains a host path');

const hashes = await read(`${ARCHIVE}/evidence/frozen-hashes.sha256`);
for (const name of FROZEN_FILES) assert.ok(hashes.includes(`${ARCHIVE}/${name}`), `missing hash entry: ${name}`);
for (const asset of ['claude-web-api-v0.2.17.tar.gz', 'install.sh', 'SHA256SUMS']) {
  assert.ok(hashes.includes(`dist/releases/v0.2.17/${asset}`), `missing dist baseline: ${asset}`);
}
const scan = await read(`${ARCHIVE}/evidence/content-scan.txt`);
assert.match(scan, /evidence scrub OK/);
assert.match(scan, /assertPublishableContent OK/);

console.log('delivery evidence OK: frozen bytes, provenance, scope and verification artifacts');
