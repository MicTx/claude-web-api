import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { BridgeError } from '../src/core/errors.mjs';
import { computeCodeHashes, inspectProbeApproval, rotateProbeApproval, runProbe } from '../scripts/smoke-design.mjs';
import { cleanupTmpDirs, makeTmpDir } from './helpers.mjs';

after(cleanupTmpDirs);
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
const exec = promisify(execFile);
const project = resolve(import.meta.dirname, '..');
const hashes = await computeCodeHashes();
const initialScope = { branch: 'spec/2026-11-06_add-claude-design-integration', commit: 'a'.repeat(40), specSha256: 'b'.repeat(64) };
const nextScope = { ...initialScope, specSha256: 'd'.repeat(64) };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cost = changes => ({ reads: 0, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0, ...changes });

async function fixture() {
  const parent = await fs.realpath(await makeTmpDir('ccw-design-rotation-'));
  const root = join(parent, 'evidence');
  const approvalFile = join(parent, 'approval.json');
  const nextApprovalFile = join(parent, 'next.json');
  const ledgerFile = join(root, 'ledger.json');
  await fs.mkdir(root, { mode: 0o700 });
  const approval = {
    schema: 'ccw-design-probe-approval/2', approvalId: 'rotation_test_001', issuer: 'host-under-user-authorization',
    scopeSummary: 'Synthetic source; one design; at most two revisions; no uploads or sharing', taskPack: initialScope,
    codeHashes: hashes, evidenceRoot: root,
    sourceTarget: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', frameId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      shortId: 'SyntheticFrame01', version: 'version-1', size: 625, sha256: 'c'.repeat(64) },
    phases: { source: 1, mutations: 1, 'versioned-files': 1, acceptance: 1 },
    limits: { reads: 64, sessions: 1, messages: 3, downloads: 12, uploads: 0, shares: 0 },
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z',
  };
  const bytes = Buffer.from(JSON.stringify(approval));
  await fs.writeFile(approvalFile, bytes, { mode: 0o600 });
  await fs.writeFile(ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: approval.approvalId,
    approvalSha256: digest(bytes), entries: [] }), { mode: 0o600 });
  const next = structuredClone(approval);
  next.taskPack = nextScope;
  next.phases.source = 0;
  await fs.writeFile(nextApprovalFile, JSON.stringify(next), { mode: 0o600 });
  return { parent, root, approvalFile, nextApprovalFile, ledgerFile, approval, next };
}

function settings(scope = nextScope, extra = {}) {
  return { getScope: async () => scope, getCodeHashes: async () => hashes, now: () => fixedNow, ...extra };
}

async function completeSource(context, effects = 18) {
  const runner = async ({ perform }) => {
    for (let index = 0; index < effects; index++) {
      await perform(cost({ reads: index === 0 && effects === 18 ? 3 : 1 }), async () => {});
    }
    throw new BridgeError('SOURCE_UNVERIFIED', 'Synthetic source not observed');
  };
  await assert.rejects(runProbe({ live: true, phase: 'source', approvalFile: context.approvalFile },
    { ...settings(initialScope), runners: { source: runner } }), error => error.code === 'SOURCE_UNVERIFIED');
}

function rotate(context, extra = {}) {
  return rotateProbeApproval({ approvalFile: context.approvalFile, nextApprovalFile: context.nextApprovalFile }, settings(nextScope, extra));
}

async function runMutation(context, approvalFile, runner = async ({ perform }) => perform(cost({ reads: 1 }), async () => {})) {
  return runProbe({ live: true, phase: 'mutations', approvalFile }, { ...settings(approvalFile === context.approvalFile ? initialScope : nextScope),
    runners: { mutations: runner } });
}

async function ledgerOf(context) {
  return JSON.parse(await fs.readFile(context.ledgerFile, 'utf8'));
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => error.code === code);
}

test('rotation: the exact sealed legacy closure rejects a completed rotation before any effect', async () => {
  const context = await fixture();
  const sealed = {
    'scripts/design-probe-json.mjs': 'bd0d7a8a135cae86d1b3f25518a5c024d18e06526168d78cf057758234b641c5',
    'scripts/design-probe-live.mjs': '059516e581495229eb8fa55b3375edb7481bc998687dafcade9de0c706b67495',
    'scripts/design-probe-source.mjs': '0c86cde90828bb130be21a8069a0c0f6a54613b7b2d3db7b32f108564d7a745c',
    'scripts/smoke-design.mjs': '884cc2e84381b0e36ed11aded7bda1c920089955a31b0c1a9a9fb1dea077620e',
    'src/api-config.mjs': '996dff76ecb7994d823c72d5b549ba31e3eb8f1bdcdaf9dea81e8b7e53f05f62',
    'src/config.mjs': 'f9ab918713b61476eef2c31fa1b1c05d3eeca3b229262396a6fd09d6d1033aef',
    'src/core/cdp.mjs': '61ec954ce252d2e3623fd72635cb8a34e12adde0e17d53e178f37cd4d2e25b0a',
    'src/core/errors.mjs': 'b00582904a6df3947b8adfc14af9592294a306bdb69d02efef7cee0c56189f26',
    'src/is-main.mjs': 'ec5942936931f1f3b6d38a21be43bcfbd30d2f70e8e2bdaaf507ce2373dbf67d',
  };
  const legacyRoot = join(context.parent, 'legacy');
  for (const [path, expected] of Object.entries(sealed)) {
    const bytes = await fs.readFile(path === 'scripts/smoke-design.mjs'
      ? join(import.meta.dirname, 'fixtures/design-probe-legacy.txt')
      : path === 'src/api-config.mjs'
        ? join(import.meta.dirname, 'fixtures/design-probe-legacy-api-config.mjs')
        : path === 'src/config.mjs'
          ? join(import.meta.dirname, 'fixtures/design-probe-legacy-config.mjs')
          : join(project, path));
    assert.equal(digest(bytes), expected);
    const destination = join(legacyRoot, path);
    await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { mode: 0o600 });
  }
  // The sealed legacy closure predates the identity module, but its copy of
  // src/config.mjs now imports it; the real file must exist to load the closure.
  const identity = join(legacyRoot, 'src', 'identity.mjs');
  await fs.mkdir(dirname(identity), { recursive: true, mode: 0o700 });
  await fs.writeFile(identity, await fs.readFile(join(project, 'src', 'identity.mjs')), { mode: 0o600 });
  const legacy = await import(pathToFileURL(join(legacyRoot, 'scripts/smoke-design.mjs')).href);
  const { BridgeError: LegacyError } = await import(pathToFileURL(join(legacyRoot, 'src/core/errors.mjs')).href);
  const genesis = structuredClone(context.approval);
  genesis.codeHashes = sealed;
  const genesisBytes = Buffer.from(JSON.stringify(genesis));
  await fs.writeFile(context.approvalFile, genesisBytes);
  await fs.writeFile(context.ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: genesis.approvalId,
    approvalSha256: digest(genesisBytes), entries: [] }));
  await expectCode(legacy.runProbe({ live: true, phase: 'source', approvalFile: context.approvalFile }, {
    getScope: async () => initialScope, now: () => fixedNow,
    runners: { source: async ({ perform }) => {
      for (let index = 0; index < 18; index++) await perform(cost({ reads: index === 0 ? 3 : 1 }), async () => {});
      throw new LegacyError('SOURCE_UNVERIFIED', 'Synthetic source not observed');
    } },
  }), 'SOURCE_UNVERIFIED');
  assert.equal((await ledgerOf(context)).entries.length, 20);
  await rotate(context);
  assert.equal((await ledgerOf(context)).entries.length, 21);
  assert.equal((await fs.readdir(context.root)).filter(name => name.startsWith('.design-reservation-')).length, 20);
  let calls = 0;
  await expectCode(legacy.runProbe({ live: true, phase: 'mutations', approvalFile: context.approvalFile }, {
    getScope: async () => initialScope, now: () => fixedNow,
    runners: { mutations: async () => { calls++; } },
  }), 'LEDGER_INVALID');
  assert.equal(calls, 0);
});

test('rotation: real CLI performs an offline-only rotation with actual scope and code hashes', async () => {
  const context = await fixture();
  const branch = (await exec('git', ['branch', '--show-current'], { cwd: project })).stdout.trim();
  const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim();
  const specSha256 = digest(await fs.readFile(join(project, '.spec/archive/retired/2026-11-06_add-claude-design-integration/spec.md')));
  const genesis = structuredClone(context.approval);
  genesis.taskPack = { branch, commit, specSha256: 'b'.repeat(64) };
  const next = structuredClone(genesis);
  next.taskPack.specSha256 = specSha256;
  next.phases.source = 0;
  const genesisBytes = Buffer.from(JSON.stringify(genesis));
  await fs.writeFile(context.approvalFile, genesisBytes);
  await fs.writeFile(context.nextApprovalFile, JSON.stringify(next));
  await fs.writeFile(context.ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: genesis.approvalId,
    approvalSha256: digest(genesisBytes), entries: [] }));
  const guard = join(context.parent, 'network-guard.mjs');
  const networkLog = join(context.parent, 'network.log');
  // CLI children must share the fixture clock, not expire with the wall clock.
  await fs.writeFile(guard, `
import { appendFileSync } from 'node:fs';
import net from 'node:net';
Date.now = () => ${fixedNow};
const deny = () => { appendFileSync(process.env.CCW_TEST_NETWORK_LOG, 'network\\n'); throw Error('network denied'); };
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
`, { mode: 0o600 });
  const output = await exec(process.execPath, [`--import=${pathToFileURL(guard).href}`, join(project, 'scripts/smoke-design.mjs'),
    '--rotate', '--approval-file', context.approvalFile, '--next-approval-file', context.nextApprovalFile], {
    cwd: project, env: { HOME: context.parent, PATH: process.env.PATH ?? '', CCW_TEST_NETWORK_LOG: networkLog },
  });
  assert.equal(output.stderr, '');
  assert.equal(JSON.parse(output.stdout).generation, 1);
  assert.equal(await fs.readFile(networkLog, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '');
  await assert.rejects(exec(process.execPath, [`--import=${pathToFileURL(guard).href}`, join(project, 'scripts/smoke-design.mjs'), '--audit',
    '--approval-file', context.approvalFile], { cwd: project,
    env: { HOME: context.parent, PATH: process.env.PATH ?? '', CCW_TEST_NETWORK_LOG: networkLog } }), error => {
    assert.equal(JSON.parse(error.stdout).error.code, 'APPROVAL_SUPERSEDED');
    return true;
  });
  const inspection = await inspectProbeApproval({ approvalFile: context.nextApprovalFile },
    { getScope: async () => ({ branch, commit, specSha256 }), now: () => fixedNow });
  assert.deepEqual(inspection, { ok: true, generation: 1, usage: cost({}),
    remaining: context.next.limits, phases: context.next.phases });
});

test('rotation: completed failed phase preserves all 20 charged reads and closes source', async () => {
  const context = await fixture();
  await completeSource(context);
  const before = await ledgerOf(context);
  assert.equal(before.entries.length, 20);
  assert.equal((await fs.readdir(context.root)).filter(name => name.startsWith('.design-reservation-')).length, 19);
  const result = await rotate(context);
  assert.equal(result.generation, 1);
  assert.equal(result.usage.reads, 20);
  assert.equal(64 - result.usage.reads, 44);
  const after = await ledgerOf(context);
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
  assert.equal(after.entries.at(-1).kind, 'rotate');
  await expectCode(runMutation(context, context.approvalFile), 'APPROVAL_SUPERSEDED');
  await expectCode(runProbe({ live: true, phase: 'source', approvalFile: context.nextApprovalFile },
    { ...settings(), runners: { source: async () => {} } }), 'APPROVAL_INVALID');
  let calls = 0;
  await expectCode(runMutation(context, context.nextApprovalFile, async ({ perform }) => {
    await perform(cost({ reads: 44 }), () => { calls++; });
    await perform(cost({ reads: 1 }), () => { calls++; });
  }), 'BUDGET_EXHAUSTED');
  assert.equal(calls, 1);
});

test('rotation: changed totals, target, issuer, expiry or reopened phase are refused without markers', async () => {
  for (const change of [
    value => { value.limits.reads = 63; },
    value => { value.sourceTarget.size = 624; },
    value => { value.issuer = 'another-issuer'; },
    value => { value.expiresAt = '2026-11-09T00:00:00.000Z'; },
    value => { value.notBefore = '2026-11-05T00:00:00.000Z'; },
    value => { value.phases.source = 1; },
  ]) {
    const context = await fixture();
    await completeSource(context, 1);
    const before = await fs.readFile(context.ledgerFile);
    const candidate = structuredClone(context.next);
    change(candidate);
    await fs.writeFile(context.nextApprovalFile, JSON.stringify(candidate));
    await assert.rejects(rotate(context));
    assert.deepEqual(await fs.readFile(context.ledgerFile), before);
    assert.equal((await fs.readdir(context.root)).some(name => name.startsWith('.design-reservation-rotate-')), false);
  }
});

test('rotation: a historical code-file list can differ without weakening current code binding', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  const historical = structuredClone(context.approval);
  delete historical.codeHashes['src/is-main.mjs'];
  const historicalBytes = Buffer.from(JSON.stringify(historical));
  await fs.writeFile(context.approvalFile, historicalBytes);
  const ledger = await ledgerOf(context);
  ledger.approvalSha256 = digest(historicalBytes);
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  const result = await rotate(context);
  assert.equal(result.usage.reads, 1);
  assert.equal((await runMutation(context, context.nextApprovalFile)).ok, true);
  await expectCode(runMutation(context, context.approvalFile), 'APPROVAL_SUPERSEDED');
});

test('rotation: history-only audit accepts an older closure without enabling it to run', async () => {
  const context = await fixture();
  const historical = structuredClone(context.approval);
  delete historical.codeHashes['scripts/design-probe-reconciliation.mjs'];
  const bytes = Buffer.from(JSON.stringify(historical));
  await fs.writeFile(context.approvalFile, bytes);
  await fs.writeFile(context.ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: historical.approvalId,
    approvalSha256: digest(bytes), entries: [] }));
  const before = await fs.readFile(context.ledgerFile);
  const inspection = await inspectProbeApproval({ approvalFile: context.approvalFile, historyOnly: true }, settings(nextScope));
  assert.equal(inspection.ok, true);
  assert.equal(inspection.mode, 'history-only');
  assert.equal(inspection.executable, false);
  assert.equal(inspection.scopeMatch, false);
  assert.equal(inspection.codeMatch, false);
  assert.deepEqual(inspection.usage, cost({}));
  assert.deepEqual(await fs.readFile(context.ledgerFile), before);
  let calls = 0;
  await expectCode(runMutation(context, context.approvalFile, async () => { calls++; }), 'APPROVAL_INVALID');
  await expectCode(inspectProbeApproval({ approvalFile: context.approvalFile }, settings(initialScope)), 'APPROVAL_INVALID');
  assert.equal(calls, 0);
});

test('rotation: history-only audit rejects damaged or superseded state without effects', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  await rotate(context);
  await expectCode(inspectProbeApproval({ approvalFile: context.approvalFile, historyOnly: true }, settings()), 'APPROVAL_SUPERSEDED');
  const ledger = await ledgerOf(context);
  ledger.entries[0].hash = 'f'.repeat(64);
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  await expectCode(inspectProbeApproval({ approvalFile: context.nextApprovalFile, historyOnly: true }, settings()), 'LEDGER_INVALID');
});

test('rotation: history-only audit refuses ledger or marker changes during inspection', async () => {
  for (const change of ['ledger', 'marker']) {
    const context = await fixture();
    await completeSource(context, 1);
    const getCodeHashes = async () => {
      if (change === 'ledger') {
        const ledger = await ledgerOf(context);
        ledger.entries[0].hash = 'f'.repeat(64);
        await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
      } else {
        const marker = (await fs.readdir(context.root)).find(name => name.startsWith('.design-reservation-'));
        await fs.writeFile(join(context.root, marker), 'changed\n');
      }
      return hashes;
    };
    await assert.rejects(inspectProbeApproval({ approvalFile: context.approvalFile, historyOnly: true },
      settings(initialScope, { getCodeHashes })), error => ['LEDGER_CHANGED', 'LEDGER_INVALID'].includes(error.code));
  }
});

test('rotation: history-only CLI audits an older closure without network or state writes', async () => {
  const context = await fixture();
  const historical = structuredClone(context.approval);
  delete historical.codeHashes['scripts/design-probe-reconciliation.mjs'];
  const bytes = Buffer.from(JSON.stringify(historical));
  await fs.writeFile(context.approvalFile, bytes);
  await fs.writeFile(context.ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: historical.approvalId,
    approvalSha256: digest(bytes), entries: [] }));
  const before = await fs.readFile(context.ledgerFile);
  const guard = join(context.parent, 'history-audit-no-network.mjs');
  const log = join(context.parent, 'history-audit-network.log');
  await fs.writeFile(guard, `
import { appendFileSync } from 'node:fs';
import net from 'node:net';
Date.now = () => ${fixedNow};
const deny = () => { appendFileSync(process.env.CCW_TEST_NETWORK_LOG, 'network\\n'); throw Error('network denied'); };
net.Socket.prototype.connect = deny;
globalThis.fetch = deny;
globalThis.WebSocket = class { constructor() { deny(); } };
`, { mode: 0o600 });
  const output = await exec(process.execPath, [`--import=${pathToFileURL(guard).href}`, join(project, 'scripts/smoke-design.mjs'),
    '--audit', '--history-only', '--approval-file', context.approvalFile], {
    cwd: project, env: { HOME: context.parent, PATH: process.env.PATH ?? '', CCW_TEST_NETWORK_LOG: log },
  });
  assert.equal(output.stderr, '');
  const audit = JSON.parse(output.stdout);
  assert.equal(audit.mode, 'history-only');
  assert.equal(audit.executable, false);
  assert.equal(audit.scopeMatch, false);
  assert.equal(audit.codeMatch, false);
  assert.deepEqual(await fs.readFile(context.ledgerFile), before);
  assert.equal(await fs.readFile(log, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '');
});

test('rotation: a phase disabled in genesis cannot be enabled by a successor', async () => {
  const context = await fixture();
  const genesis = structuredClone(context.approval);
  genesis.phases.mutations = 0;
  const bytes = Buffer.from(JSON.stringify(genesis));
  await fs.writeFile(context.approvalFile, bytes);
  const ledger = await ledgerOf(context);
  ledger.approvalSha256 = digest(bytes);
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  await expectCode(rotate(context), 'ROTATION_CONFLICT');
  assert.equal((await fs.readdir(context.root)).some(name => name.startsWith('.design-reservation-rotate-')), false);
});

test('rotation: an unfinished phase cannot rotate or spend again', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  const ledger = await ledgerOf(context);
  ledger.entries.pop();
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  await expectCode(rotate(context), 'ROTATION_CONFLICT');
  await expectCode(runMutation(context, context.approvalFile), 'PHASE_UNRESOLVED');
  assert.equal((await fs.readdir(context.root)).some(name => name.startsWith('.design-reservation-rotate-')), false);
});

test('rotation: interrupted marker requires the same target and recovers exactly once', async () => {
  const context = await fixture();
  await completeSource(context);
  await expectCode(rotate(context, { afterStep: async step => { if (step === 'marker') throw new Error('stop'); } }), 'PROBE_FAILED');
  await expectCode(runMutation(context, context.approvalFile), 'LEDGER_CHANGED');
  const candidate = structuredClone(context.next);
  candidate.taskPack = { ...nextScope, specSha256: 'e'.repeat(64) };
  const different = join(context.parent, 'different.json');
  await fs.writeFile(different, JSON.stringify(candidate), { mode: 0o600 });
  await expectCode(rotateProbeApproval({ approvalFile: context.approvalFile, nextApprovalFile: different },
    settings(candidate.taskPack)), 'ROTATION_CONFLICT');
  const recovered = await rotate(context);
  assert.equal(recovered.usage.reads, 20);
  assert.equal(recovered.alreadyRotated, false);
  const repeated = await rotate(context);
  assert.equal(repeated.alreadyRotated, true);
  assert.equal((await ledgerOf(context)).entries.filter(entry => entry.kind === 'rotate').length, 1);
});

test('rotation: killed subprocesses recover without restoring or duplicating budget', async () => {
  for (const stopAt of ['snapshot-staged', 'snapshot-link', 'snapshots', 'marker-staged', 'marker-link', 'marker', 'ledger']) {
    const context = await fixture();
    await completeSource(context);
    const worker = join(context.parent, 'rotation-worker.mjs');
    const moduleUrl = pathToFileURL(join(import.meta.dirname, '../scripts/smoke-design.mjs')).href;
    await fs.writeFile(worker, `
import { rotateProbeApproval } from ${JSON.stringify(moduleUrl)};
await rotateProbeApproval({ approvalFile: process.argv[2], nextApprovalFile: process.argv[3] }, {
  getScope: async () => (${JSON.stringify(nextScope)}), now: () => ${fixedNow},
  afterStep: async step => { if (step === process.argv[4]) process.kill(process.pid, 'SIGKILL'); }
});
`, { mode: 0o600 });
    const child = spawn(process.execPath, [worker, context.approvalFile, context.nextApprovalFile, stopAt], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const [exitCode, signal] = await once(child, 'exit');
    assert.equal(exitCode, null, stderr);
    assert.equal(signal, 'SIGKILL');
    await fs.unlink(join(context.root, '.design-probe.lock'));
    if (stopAt === 'marker-link' || stopAt === 'marker') await expectCode(runMutation(context, context.approvalFile), 'LEDGER_CHANGED');
    const recovered = await rotate(context);
    assert.equal(recovered.usage.reads, 20);
    assert.equal(recovered.alreadyRotated, stopAt === 'ledger');
    assert.equal((await ledgerOf(context)).entries.filter(entry => entry.kind === 'rotate').length, 1);
    const directory = join(context.root, 'approvals');
    for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.json'))) {
      assert.equal((await fs.stat(join(directory, name))).nlink, 1);
    }
    assert.equal((await fs.stat(join(context.root, '.design-reservation-rotate-000001'))).nlink, 1);
  }
});

test('rotation: orphan snapshots have no authority and do not prevent another candidate', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  await expectCode(rotate(context, { afterStep: async step => { if (step === 'snapshots') throw new Error('stop'); } }), 'PROBE_FAILED');
  const candidate = structuredClone(context.next);
  candidate.taskPack = { ...nextScope, specSha256: 'e'.repeat(64) };
  const alternate = join(context.parent, 'alternate.json');
  await fs.writeFile(alternate, JSON.stringify(candidate), { mode: 0o600 });
  const result = await rotateProbeApproval({ approvalFile: context.approvalFile, nextApprovalFile: alternate }, settings(candidate.taskPack));
  assert.equal(result.generation, 1);
  await expectCode(runProbe({ live: true, phase: 'mutations', approvalFile: context.nextApprovalFile },
    { ...settings(), runners: { mutations: async () => {} } }), 'APPROVAL_SUPERSEDED');
});

test('rotation: ledger rollback blocks running and can only restore the same rotation', async () => {
  const context = await fixture();
  await completeSource(context);
  const before = await fs.readFile(context.ledgerFile);
  await rotate(context);
  await fs.writeFile(context.ledgerFile, before);
  await expectCode(runMutation(context, context.approvalFile), 'LEDGER_CHANGED');
  const result = await rotate(context);
  assert.equal(result.usage.reads, 20);
  assert.equal((await ledgerOf(context)).entries.filter(entry => entry.kind === 'rotate').length, 1);
});

test('rotation: changed snapshots and snapshot-as-approval are rejected', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  await rotate(context);
  const firstHash = digest(await fs.readFile(context.approvalFile));
  const snapshot = join(context.root, 'approvals', `${firstHash}.json`);
  await expectCode(runMutation(context, snapshot), 'APPROVAL_UNSAFE');
  await fs.chmod(snapshot, 0o600);
  await fs.writeFile(snapshot, '{}');
  await fs.chmod(snapshot, 0o400);
  await expectCode(runMutation(context, context.nextApprovalFile), 'LEDGER_INVALID');
});

test('rotation: the run path does not write or replace approval snapshots', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  await rotate(context);
  const directory = join(context.root, 'approvals');
  const names = (await fs.readdir(directory)).sort();
  const before = await Promise.all(names.map(async name => ({ name, bytes: await fs.readFile(join(directory, name)),
    stat: await fs.stat(join(directory, name), { bigint: true }) })));
  await runMutation(context, context.nextApprovalFile);
  assert.deepEqual((await fs.readdir(directory)).sort(), names);
  for (const entry of before) {
    const path = join(directory, entry.name);
    const stat = await fs.stat(path, { bigint: true });
    assert.deepEqual(await fs.readFile(path), entry.bytes);
    assert.equal(stat.ino, entry.stat.ino);
    assert.equal(stat.mtimeNs, entry.stat.mtimeNs);
    assert.equal(stat.mode & 0o777n, 0o400n);
  }
});

test('rotation: marker gaps, extra markers and changed contents reject every run', async () => {
  for (const change of ['gap', 'extra', 'contents']) {
    const context = await fixture();
    await completeSource(context, 1);
    await rotate(context);
    const marker = join(context.root, '.design-reservation-rotate-000001');
    if (change === 'gap') await fs.rename(marker, join(context.root, '.design-reservation-rotate-000002'));
    else if (change === 'extra') await fs.writeFile(join(context.root, '.design-reservation-unexpected'), 'unexpected\n', { mode: 0o600 });
    else await fs.writeFile(marker, 'changed\n');
    await expectCode(runMutation(context, context.nextApprovalFile), 'LEDGER_CHANGED');
  }
});

test('rotation: changed or missing recovery marker snapshot fails closed', async () => {
  for (const removeSnapshot of [false, true]) {
    const context = await fixture();
    await completeSource(context, 1);
    await expectCode(rotate(context, { afterStep: async step => { if (step === 'marker') throw new Error('stop'); } }), 'PROBE_FAILED');
    const marker = join(context.root, '.design-reservation-rotate-000001');
    if (removeSnapshot) {
      const nextHash = digest(await fs.readFile(context.nextApprovalFile));
      await fs.unlink(join(context.root, 'approvals', `${nextHash}.json`));
    } else {
      const record = JSON.parse(await fs.readFile(marker, 'utf8'));
      record.previous = 'f'.repeat(64);
      await fs.writeFile(marker, `${JSON.stringify(record)}\n`);
    }
    await assert.rejects(rotate(context));
    await expectCode(runMutation(context, context.approvalFile), 'LEDGER_CHANGED');
  }
});

test('rotation: a stolen lock cannot create a second target for the same generation', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  const alternate = structuredClone(context.next);
  alternate.taskPack = { ...nextScope, specSha256: 'e'.repeat(64) };
  const alternateFile = join(context.parent, 'alternate.json');
  await fs.writeFile(alternateFile, JSON.stringify(alternate), { mode: 0o600 });
  await expectCode(rotate(context, { afterStep: async step => {
    if (step !== 'marker') return;
    await fs.unlink(join(context.root, '.design-probe.lock'));
    await expectCode(rotateProbeApproval({ approvalFile: context.approvalFile, nextApprovalFile: alternateFile },
      settings(alternate.taskPack)), 'ROTATION_CONFLICT');
  } }), 'LOCK_LOST');
  const recovered = await rotate(context);
  assert.equal(recovered.generation, 1);
  assert.equal((await ledgerOf(context)).entries.filter(entry => entry.kind === 'rotate').length, 1);
});

test('rotation: an active phase keeps the shared lock and blocks rotation', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  let resume;
  let entered;
  const gate = new Promise(resolve => { resume = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const pending = runMutation(context, context.approvalFile, async ({ perform }) => {
    await perform(cost({ reads: 1 }), async () => {});
    entered();
    await gate;
  });
  await started;
  try { await expectCode(rotate(context), 'BUSY'); } finally { resume(); }
  assert.equal((await pending).ok, true);
});

test('rotation: a forged intermediate approval cannot change the genesis budget or time window', async () => {
  for (const change of [
    value => { value.limits.reads = 63; },
    value => { value.expiresAt = '2026-11-09T00:00:00.000Z'; },
    value => { value.notBefore = '2026-11-05T00:00:00.000Z'; },
  ]) {
    const context = await fixture();
    await completeSource(context, 1);
    const directory = join(context.root, 'approvals');
    await fs.mkdir(directory, { mode: 0o700 });
    const genesisBytes = await fs.readFile(context.approvalFile);
    const intermediate = structuredClone(context.next);
    change(intermediate);
    const intermediateBytes = Buffer.from(JSON.stringify(intermediate));
    const activeBytes = await fs.readFile(context.nextApprovalFile);
    const approvalBytes = [genesisBytes, intermediateBytes, activeBytes];
    const approvalHashes = approvalBytes.map(digest);
    for (const [index, bytes] of approvalBytes.entries()) {
      await fs.writeFile(join(directory, `${approvalHashes[index]}.json`), bytes, { mode: 0o400 });
    }
    const ledger = await ledgerOf(context);
    for (let generation = 1; generation <= 2; generation++) {
      const record = { sequence: ledger.entries.length + 1, kind: 'rotate', phase: null, cost: cost({}),
        reservation: { generation, from: approvalHashes[generation - 1], to: approvalHashes[generation] },
        status: 'rotated', at: new Date(fixedNow).toISOString(), previous: ledger.entries.at(-1).hash };
      record.hash = digest(JSON.stringify([record.sequence, record.kind, record.phase, record.cost,
        record.reservation, record.status, record.at, record.previous]));
      ledger.entries.push(record);
      await fs.writeFile(join(context.root, `.design-reservation-rotate-${String(generation).padStart(6, '0')}`),
        `${JSON.stringify(record)}\n`, { mode: 0o600 });
    }
    await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
    let calls = 0;
    await expectCode(runMutation(context, context.nextApprovalFile, async () => { calls++; }), 'ROTATION_CONFLICT');
    assert.equal(calls, 0);
  }
});

test('rotation: a later generation preserves history and cannot re-enable prior phases', async () => {
  const context = await fixture();
  await completeSource(context, 1);
  await rotate(context);
  const third = structuredClone(context.next);
  third.taskPack = { ...nextScope, specSha256: 'f'.repeat(64) };
  const thirdFile = join(context.parent, 'third.json');
  await fs.writeFile(thirdFile, JSON.stringify(third), { mode: 0o600 });
  const result = await rotateProbeApproval({ approvalFile: context.nextApprovalFile, nextApprovalFile: thirdFile }, settings(third.taskPack));
  assert.equal(result.generation, 2);
  assert.equal(result.usage.reads, 1);
  await expectCode(runMutation(context, context.nextApprovalFile), 'APPROVAL_SUPERSEDED');
  const latest = await runProbe({ live: true, phase: 'mutations', approvalFile: thirdFile },
    { ...settings(third.taskPack), runners: { mutations: async ({ perform }) => perform(cost({ reads: 1 }), async () => {}) } });
  assert.equal(latest.ok, true);
});
