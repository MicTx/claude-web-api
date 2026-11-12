import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAcyclic, dependencyStrata, verifyStructure } from '../scripts/verify-structure.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('architecture: dependency strata are deterministic and acyclic', () => {
  const strata = dependencyStrata(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['d', 'c']]);
  assert.deepEqual([...strata], [[0, ['c']], [1, ['b', 'd']], [2, ['a']]]);
  assertAcyclic(['a', 'b'], [['a', 'b']]);
  assert.throws(() => assertAcyclic(['a', 'b'], [['a', 'b'], ['b', 'a']]), /cycle/);
  assert.throws(() => dependencyStrata(['a', 'b'], [['a', 'b'], ['b', 'a']]), /cycle/);
});

test('architecture: generated index, DAG and contract agree with the current tree', async () => {
  const result = await verifyStructure();
  assert.ok(result.paths >= 90);
  assert.ok(result.allPaths >= 120);
  assert.ok(result.strata >= 2);
  assert.ok(result.edges > 0);
  const mmd = await fs.readFile(join(ROOT, '.spec/architecture/module-dag.mmd'), 'utf8');
  const md = await fs.readFile(join(ROOT, '.spec/architecture/module-dag.md'), 'utf8');
  assert.ok(md.includes(mmd.trim()));
  assert.doesNotMatch(mmd, /cycles|cycle is allowed/i);
});
