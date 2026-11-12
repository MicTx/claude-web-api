import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';
import { CODE_FILES, computeCodeHashes, runProbe } from '../scripts/smoke-design.mjs';
import { BridgeError } from '../src/core/errors.mjs';

after(cleanupTmpDirs);
const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/smoke-design.mjs');
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
const codeHashes = await computeCodeHashes();
const scope = { branch: 'spec/2026-11-06_add-claude-design-integration', commit: 'a'.repeat(40), specSha256: 'b'.repeat(64) };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cost = changes => ({ reads: 0, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0, ...changes });

async function fixture() {
  const parent = await fs.realpath(await makeTmpDir('ccw-design-probe-'));
  const root = join(parent, 'evidence');
  const approvalFile = join(parent, 'approval.json');
  const ledgerFile = join(root, 'ledger.json');
  await fs.mkdir(root, { mode: 0o700 });
  const approval = {
    schema: 'ccw-design-probe-approval/2', approvalId: 'approval_test_001', issuer: 'host-under-user-authorization',
    scopeSummary: 'Synthetic source; one design; at most two revisions; no uploads or sharing', taskPack: { ...scope }, codeHashes, evidenceRoot: root,
    sourceTarget: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', frameId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      shortId: 'SyntheticFrame01', version: 'version-1', size: 625, sha256: 'c'.repeat(64) },
    phases: { source: 1, mutations: 1, 'versioned-files': 1, acceptance: 1 },
    limits: { reads: 10, sessions: 1, messages: 3, downloads: 3, uploads: 0, shares: 0 },
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z',
  };
  const writeApproval = async (value = approval, updateLedger = true) => {
    const bytes = Buffer.from(JSON.stringify(value));
    await fs.writeFile(approvalFile, bytes, { mode: 0o600 });
    if (updateLedger) {
      const ledger = { schema: 'ccw-design-probe-ledger/1', approvalId: value.approvalId, approvalSha256: hash(bytes), entries: [] };
      await fs.writeFile(ledgerFile, JSON.stringify(ledger), { mode: 0o600 });
    }
    return bytes;
  };
  await writeApproval();
  return { parent, root, approvalFile, ledgerFile, approval, writeApproval };
}

function runOptions(approvalFile, phase = 'source') {
  return { live: true, phase, approvalFile };
}

function dependencies(runner, extra = {}) {
  return { runners: { source: runner }, getScope: async () => ({ ...scope }), now: () => fixedNow, ...extra };
}

async function ledgerOf(context) {
  return JSON.parse(await fs.readFile(context.ledgerFile, 'utf8'));
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /TOKEN_SENTINEL|PRIVATE_SENTINEL/);
    return true;
  });
}

test('design probe: default and every CLI refusal make zero network or child-process calls', async () => {
  const context = await fixture();
  const guard = join(context.parent, 'no-egress.mjs');
  const log = join(context.parent, 'egress.log');
  await fs.writeFile(guard, `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http2 from 'node:http2';
import tls from 'node:tls';
import workers from 'node:worker_threads';
import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deny = name => () => { fs.appendFileSync(process.env.CCW_TEST_GUARD_LOG, name + '\\n'); throw Error('egress denied'); };
net.Socket.prototype.connect = deny('socket');
net.connect = deny('connect');
http.request = deny('http');
https.request = deny('https');
dgram.createSocket = deny('udp');
dns.lookup = deny('dns-lookup');
dns.promises.resolve = deny('dns-resolve');
http2.connect = deny('http2');
tls.connect = deny('tls');
workers.Worker = class { constructor() { deny('worker')(); } };
for (const name of ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync']) child[name] = deny(name);
globalThis.fetch = deny('fetch');
globalThis.WebSocket = class { constructor() { deny('websocket')(); } };
syncBuiltinESMExports();
`, { mode: 0o600 });
  const env = { HOME: context.parent, PATH: process.env.PATH ?? '', CCW_TEST_GUARD_LOG: log };
  const sanity = `
    import dns from 'node:dns';
    import http2 from 'node:http2';
    import tls from 'node:tls';
    import { Worker } from 'node:worker_threads';
    for (const invoke of [() => dns.lookup('example.invalid', () => {}),
      () => dns.promises.resolve('example.invalid'), () => http2.connect('https://example.invalid'),
      () => tls.connect(1), () => new Worker('')]) { try { invoke(); } catch {} }
  `;
  await exec(process.execPath, [`--import=${pathToFileURL(guard).href}`, '--input-type=module', '--eval', sanity], { env });
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n').sort(), ['dns-lookup', 'dns-resolve', 'http2', 'tls', 'worker']);
  await fs.writeFile(log, '');
  const cases = [
    { args: [], skipped: true },
    { args: ['--help'], help: true },
    { args: ['--phase', 'source', '--approval-file', '/PRIVATE_SENTINEL'], skipped: true },
    { args: ['--live'], code: 'INVALID_ARGUMENT' },
    { args: ['--live', '--phase', 'unknown', '--approval-file', context.approvalFile], code: 'INVALID_ARGUMENT' },
    { args: ['--live', '--phase', 'source', '--approval-file', '/does-not-exist/approval.json'], code: 'APPROVAL_UNSAFE' },
    { args: ['--live', '--phase', 'mutations', '--approval-file', 'relative.json'], code: 'INVALID_ARGUMENT' },
    { args: ['--live', '--phase', 'source', '--approval-file', 'relative.json'], code: 'INVALID_ARGUMENT' },
    { args: ['--phase', 'unknown'], code: 'INVALID_ARGUMENT' },
    { args: ['--live', '--live'], code: 'INVALID_ARGUMENT' },
    { args: ['--rotate'], code: 'INVALID_ARGUMENT' },
    { args: ['--rotate', '--live', '--approval-file', context.approvalFile, '--next-approval-file', context.approvalFile], code: 'INVALID_ARGUMENT' },
    { args: ['--next-approval-file', context.approvalFile], code: 'INVALID_ARGUMENT' },
    { args: ['--audit'], code: 'INVALID_ARGUMENT' },
    { args: ['--history-only'], code: 'INVALID_ARGUMENT' },
    { args: ['--history-only', '--live', '--phase', 'source', '--approval-file', context.approvalFile], code: 'INVALID_ARGUMENT' },
    { args: ['--audit', '--live', '--approval-file', context.approvalFile], code: 'INVALID_ARGUMENT' },
    { args: ['--live', '--phase', 'source', '--phase', 'mutations', '--approval-file', context.approvalFile], code: 'INVALID_ARGUMENT' },
    { args: ['--unknown', 'TOKEN_SENTINEL'], code: 'INVALID_ARGUMENT' },
    { args: ['--help', '--live'], code: 'INVALID_ARGUMENT' },
  ];
  for (const scenario of cases) {
    let output;
    try {
      output = await exec(process.execPath, [`--import=${pathToFileURL(guard).href}`, script, ...scenario.args], { env });
      assert.ok(scenario.skipped || scenario.help);
    } catch (error) {
      assert.equal(error.code, 1);
      output = error;
    }
    assert.equal(output.stderr, '');
    assert.doesNotMatch(output.stdout, /TOKEN_SENTINEL|PRIVATE_SENTINEL/);
    const payload = JSON.parse(output.stdout);
    if (scenario.skipped) assert.equal(payload.skipped, true);
    else if (scenario.help) {
      assert.equal(payload.help.approval.schema, 'ccw-design-probe-approval/2');
      assert.equal(payload.help.ledger.schema, 'ccw-design-probe-ledger/1');
      assert.match(payload.help.status, /Passive source, read-only discovery and one-shot mutation probes are available/);
    }
    else assert.equal(payload.error.code, scenario.code);
  }
  assert.equal(await fs.readFile(log, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '');
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: live CLI rejects debug and preload settings without printing them', async () => {
  const context = await fixture();
  for (const [name, value] of Object.entries({ DEBUG: 'TOKEN_SENTINEL', NODE_DEBUG: 'TOKEN_SENTINEL',
    NODE_DEBUG_NATIVE: 'TOKEN_SENTINEL', NODE_OPTIONS: '--trace-warnings', CCW_CDP_DEBUG: 'TOKEN_SENTINEL' })) {
    await assert.rejects(exec(process.execPath, [script, '--live', '--phase', 'source', '--approval-file', context.approvalFile], {
      env: { HOME: context.parent, PATH: process.env.PATH ?? '', [name]: value },
    }), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).error.code, 'LIVE_GUARD');
      assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /TOKEN_SENTINEL/);
      return true;
    });
  }
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: approval parse and schema errors never disclose input', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await fs.writeFile(context.approvalFile, '{"TOKEN_SENTINEL":', { mode: 0o600 });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'APPROVAL_INVALID');
  const duplicate = JSON.stringify(context.approval).replace('"schema":', '"schema":"PRIVATE_SENTINEL","\\u0073chema":');
  await fs.writeFile(context.approvalFile, duplicate, { mode: 0o600 });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'APPROVAL_INVALID');
  for (const mutate of [
    value => { value.limits.reads = -1; },
    value => { value.limits.reads = 0.5; },
    value => { value.limits.messages = '1'; },
    value => { value.limits.uploads = 1; },
    value => { value.limits.shares = 1; },
    value => { value.limits.reads = 65; },
    value => { value.extra = 'PRIVATE_SENTINEL'; },
    value => { value.phases.source = true; },
    value => { value.approvalId = '../TOKEN_SENTINEL'; },
    value => { value.approvalId = 12345678; },
    value => { value.issuer = 'user'; },
    value => { value.sourceTarget.frameId = 'https://TOKEN_SENTINEL'; },
    value => { value.sourceTarget.organizationId = 'TOKEN_SENTINEL'; },
    value => { value.sourceTarget.shortId = 'https://example.invalid'; },
    value => { value.sourceTarget.version = '../other'; },
    value => { value.sourceTarget.size = 0; },
    value => { value.sourceTarget.sha256 = 'TOKEN_SENTINEL'; },
    value => { value.codeHashes[CODE_FILES[0]] = 'TOKEN_SENTINEL'; },
    value => { delete value.codeHashes[CODE_FILES[0]]; },
    value => { value.codeHashes['src/bridge.mjs'] = 'a'.repeat(64); },
  ]) {
    const approval = structuredClone(context.approval);
    mutate(approval);
    await context.writeApproval(approval, false);
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'APPROVAL_INVALID');
  }
  assert.equal(calls, 0);
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: approval must be a private owned regular file without links', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await fs.chmod(context.approvalFile, 0o644);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'APPROVAL_UNSAFE');
  await fs.chmod(context.approvalFile, 0o600);
  const linked = join(context.parent, 'approval-hardlink.json');
  await fs.link(context.approvalFile, linked);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'APPROVAL_UNSAFE');
  await fs.unlink(linked);
  await fs.symlink(context.approvalFile, linked);
  await rejectsCode(runProbe(runOptions(linked), dependencies(runner)), 'APPROVAL_UNSAFE');
  await rejectsCode(runProbe(runOptions(context.parent), dependencies(runner)), 'APPROVAL_UNSAFE');
  assert.equal(calls, 0);
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: root identity, canonical path and permissions are checked without chmod', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await fs.chmod(context.root, 0o755);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'ROOT_UNSAFE');
  assert.equal((await fs.stat(context.root)).mode & 0o777, 0o755);
  await fs.chmod(context.root, 0o700);
  const link = join(context.parent, 'root-link');
  await fs.symlink(context.root, link);
  const approval = { ...context.approval, evidenceRoot: link };
  await context.writeApproval(approval, false);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'ROOT_UNSAFE');
  approval.evidenceRoot = resolve(import.meta.dirname, '..');
  await context.writeApproval(approval, false);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'ROOT_UNSAFE');
  assert.equal(calls, 0);
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: expiration, future approval and task scope mismatch have no effect', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  for (const time of ['2026-11-05T00:00:00.000Z', '2026-11-08T00:00:00.000Z']) {
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, { now: () => Date.parse(time) })), 'APPROVAL_INVALID');
  }
  for (const key of ['branch', 'commit', 'specSha256']) {
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, {
      getScope: async () => ({ ...scope, [key]: key === 'branch' ? 'spec/other' : 'c'.repeat(key === 'commit' ? 40 : 64) }),
    })), 'APPROVAL_SCOPE');
  }
  assert.equal(calls, 0);
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: changed implementation is rejected before the effect', async () => {
  const context = await fixture();
  let calls = 0;
  const changed = { ...codeHashes, [CODE_FILES[0]]: 'f'.repeat(64) };
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, { getCodeHashes: async () => changed })), 'CODE_CHANGED');
  assert.deepEqual((await ledgerOf(context)).entries, []);
  let checks = 0;
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, {
    getCodeHashes: async () => (++checks >= 4 ? changed : { ...codeHashes }),
  })), 'CODE_CHANGED');
  assert.deepEqual((await ledgerOf(context)).entries.map(entry => entry.kind), ['phase', 'effect', 'result']);
  assert.equal(calls, 0);
});

test('design probe: missing, old, malformed, oversized and linked ledgers are never reset', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  const original = await fs.readFile(context.ledgerFile);
  await fs.unlink(context.ledgerFile);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LEDGER_UNSAFE');
  await assert.rejects(fs.stat(context.ledgerFile), { code: 'ENOENT' });
  await fs.writeFile(context.ledgerFile, '{"PRIVATE_SENTINEL":', { mode: 0o600 });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LEDGER_INVALID');
  await fs.writeFile(context.ledgerFile, Buffer.alloc(128 * 1024 + 1), { mode: 0o600 });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LEDGER_UNSAFE');
  await fs.writeFile(context.ledgerFile, original, { mode: 0o600 });
  const previous = JSON.parse(original.toString());
  previous.approvalId = 'another_approval';
  await fs.writeFile(context.ledgerFile, JSON.stringify(previous));
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LEDGER_INVALID');
  await fs.unlink(context.ledgerFile);
  await fs.symlink(context.approvalFile, context.ledgerFile);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LEDGER_UNSAFE');
  assert.equal(calls, 0);
});

test('design probe: durable phase and effect reservations precede the action and survive completion', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), async () => {
    const ledger = await ledgerOf(context);
    assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect']);
    assert.equal(ledger.entries[1].cost.reads, 1);
    assert.equal((await fs.readdir(context.root)).filter(name => name.startsWith('.design-reservation-')).length, 2);
    calls++;
  });
  const result = await runProbe(runOptions(context.approvalFile), dependencies(runner));
  assert.deepEqual(result, { ok: true, phase: 'source' });
  assert.equal(calls, 1);
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect', 'result']);
  assert.equal(ledger.entries[2].status, 'completed');
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'PHASE_UNRESOLVED');
  assert.equal(calls, 1);
  assert.equal((await fs.readdir(context.root)).includes('.design-probe.lock'), false);
});

test('design probe: source target is read only from the approved immutable snapshot', async () => {
  const context = await fixture();
  let seen;
  const runner = async ({ perform, sourceTarget }) => {
    assert.equal(Object.isFrozen(sourceTarget), true);
    seen = sourceTarget;
    await perform(cost({ reads: 1 }), () => {});
  };
  assert.equal((await runProbe(runOptions(context.approvalFile), dependencies(runner))).ok, true);
  assert.deepEqual(seen, context.approval.sourceTarget);
  assert.doesNotMatch(await fs.readFile(context.ledgerFile, 'utf8'), /SyntheticFrame01|bbbbbbbb-bbbb/);
});

test('design probe: the declared effect is snapshotted before asynchronous work', async () => {
  const context = await fixture();
  const declared = cost({ reads: 1 });
  let calls = 0;
  const runner = async ({ perform }) => {
    const pending = perform(declared, () => { calls++; });
    declared.reads = 0;
    declared.messages = 1;
    await pending;
  };
  assert.equal((await runProbe(runOptions(context.approvalFile), dependencies(runner))).ok, true);
  const ledger = await ledgerOf(context);
  assert.equal(ledger.entries[1].cost.reads, 1);
  assert.equal(ledger.entries[1].cost.messages, 0);
  assert.equal(calls, 1);
});

test('design probe: depleted or forbidden budgets stop before the effect', async () => {
  for (const change of [{ reads: 0 }, { uploads: 1 }, { shares: 1 }, { messages: 1 }]) {
    const context = await fixture();
    let calls = 0;
    let attempted = cost(change);
    if (Object.hasOwn(change, 'reads')) {
      context.approval.limits.reads = 0;
      await context.writeApproval();
      attempted = cost({ reads: 1 });
    }
    const runner = async ({ perform }) => perform(attempted, () => { calls++; });
    const expected = Object.hasOwn(change, 'reads') ? 'BUDGET_EXHAUSTED' : 'LIVE_GUARD';
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), expected);
    const ledger = await ledgerOf(context);
    assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'result']);
    assert.equal(ledger.entries[1].status, 'failed');
    assert.equal(calls, 0);
  }
});

test('design probe: mutation phase cannot spend the acceptance message allowance', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ messages: 3 }), () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile, 'mutations'), {
    runners: { mutations: runner }, getScope: async () => ({ ...scope }), now: () => fixedNow,
  }), 'BUDGET_EXHAUSTED');
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'result']);
  assert.equal(calls, 0);
});

test('design probe: approval mutation before reservation leaves the ledger unchanged', async () => {
  const context = await fixture();
  const original = await fs.readFile(context.ledgerFile);
  let scopes = 0;
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, {
    getScope: async () => {
      scopes++;
      if (scopes === 1) await context.writeApproval({ ...context.approval, expiresAt: '2026-11-09T00:00:00.000Z' }, false);
      return { ...scope };
    },
  })), 'APPROVAL_CHANGED');
  assert.deepEqual(await fs.readFile(context.ledgerFile), original);
  assert.equal(calls, 0);
});

test('design probe: approval mutation after effect reservation consumes budget without performing it', async () => {
  const context = await fixture();
  let scopes = 0;
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, {
    getScope: async () => {
      scopes++;
      if (scopes === 3) await context.writeApproval({ ...context.approval, expiresAt: '2026-11-09T00:00:00.000Z' }, false);
      return { ...scope };
    },
  })), 'APPROVAL_CHANGED');
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect', 'result']);
  assert.equal(ledger.entries[1].cost.reads, 1);
  assert.equal(ledger.entries[2].status, 'failed');
  assert.equal(calls, 0);
});

test('design probe: every approval reread checks permissions, symlinks and hard links', async () => {
  for (const attack of ['mode', 'symlink', 'hardlink']) {
    const context = await fixture();
    let calls = 0;
    const runner = async ({ perform }) => {
      await perform(cost({ reads: 1 }), async () => {
        calls++;
        if (attack === 'mode') await fs.chmod(context.approvalFile, 0o644);
        if (attack === 'symlink') {
          const moved = join(context.parent, 'approval-original.json');
          await fs.rename(context.approvalFile, moved);
          await fs.symlink(moved, context.approvalFile);
        }
        if (attack === 'hardlink') await fs.link(context.approvalFile, join(context.parent, 'approval-copy.json'));
      });
      await perform(cost({ reads: 1 }), () => { calls++; });
    };
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'APPROVAL_UNSAFE');
    const ledger = await ledgerOf(context);
    assert.equal(ledger.entries.filter(entry => entry.kind === 'effect').length, 1);
    assert.equal(calls, 1);
  }
});

test('design probe: cancellation before or after durable reservation never retries', async () => {
  const context = await fixture();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, { signal: controller.signal })), 'ABORTED');
  assert.deepEqual((await ledgerOf(context)).entries, []);
  const interrupted = new AbortController();
  let scopes = 0;
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, {
    signal: interrupted.signal,
    getScope: async () => { if (++scopes === 4) interrupted.abort(); return { ...scope }; },
  })), 'ABORTED');
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect', 'result']);
  assert.equal(ledger.entries[2].status, 'interrupted');
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'PHASE_UNRESOLVED');
  assert.equal(calls, 0);
});

test('design probe: runner failures and return values cannot leak untrusted text', async () => {
  const context = await fixture();
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { throw new Error('TOKEN_SENTINEL PRIVATE_SENTINEL'); });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'PROBE_FAILED');
  const ledger = await fs.readFile(context.ledgerFile, 'utf8');
  assert.doesNotMatch(ledger, /TOKEN_SENTINEL|PRIVATE_SENTINEL/);
  assert.equal(JSON.parse(ledger).entries.at(-1).status, 'failed');
  const another = await fixture();
  const returns = async ({ perform }) => perform(cost({ reads: 1 }), () => ({ token: 'TOKEN_SENTINEL' }));
  const result = await runProbe(runOptions(another.approvalFile), dependencies(returns));
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SENTINEL/);
  const wrapped = await fixture();
  const forged = async ({ perform }) => perform(cost({ reads: 1 }), () => {
    throw new BridgeError('APPROVAL_CHANGED', 'TOKEN_SENTINEL', { leaked: 'PRIVATE_SENTINEL' });
  });
  await rejectsCode(runProbe(runOptions(wrapped.approvalFile), dependencies(forged)), 'APPROVAL_CHANGED');
  assert.doesNotMatch(await fs.readFile(wrapped.ledgerFile, 'utf8'), /TOKEN_SENTINEL|PRIVATE_SENTINEL/);
  const getterContext = await fixture();
  const getter = async ({ perform }) => perform(cost({ reads: 1 }), () => {
    const error = new BridgeError('PROBE_FAILED', 'safe');
    Object.defineProperty(error, 'code', { get: () => { throw new Error('TOKEN_SENTINEL'); } });
    throw error;
  });
  await rejectsCode(runProbe(runOptions(getterContext.approvalFile), dependencies(getter)), 'PROBE_FAILED');
  assert.equal((await ledgerOf(getterContext)).entries.at(-1).status, 'failed');
  const proxyContext = await fixture();
  const proxy = async ({ perform }) => perform(cost({ reads: 1 }), () => {
    throw new Proxy({}, { getPrototypeOf: () => { throw new Error('PRIVATE_SENTINEL'); } });
  });
  await rejectsCode(runProbe(runOptions(proxyContext.approvalFile), dependencies(proxy)), 'PROBE_FAILED');
  assert.equal((await ledgerOf(proxyContext)).entries.at(-1).status, 'failed');
});

test('design probe: detached rejection in the CLI cannot print its reason', async () => {
  const context = await fixture();
  const preload = join(context.parent, 'late-rejection.mjs');
  await fs.writeFile(preload, "setImmediate(() => Promise.reject('TOKEN_SENTINEL PRIVATE_SENTINEL'));\n", { mode: 0o600 });
  await assert.rejects(exec(process.execPath, [`--import=${pathToFileURL(preload).href}`, script], {
    env: { HOME: context.parent, PATH: process.env.PATH ?? '' },
  }), error => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /TOKEN_SENTINEL|PRIVATE_SENTINEL/);
    return true;
  });
});

test('design probe: unknown effect metadata never enters ledger or marker names', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => perform({ ...cost({ reads: 1 }), note: 'TOKEN_SENTINEL' }, () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LIVE_GUARD');
  assert.doesNotMatch(await fs.readFile(context.ledgerFile, 'utf8'), /TOKEN_SENTINEL/);
  assert.doesNotMatch((await fs.readdir(context.root)).join('\n'), /TOKEN_SENTINEL/);
  assert.equal(calls, 0);
});

test('design probe: approval expiration after reservation leaves the allowance spent', async () => {
  const context = await fixture();
  let clock = fixedNow;
  let scopes = 0;
  let calls = 0;
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner, {
    now: () => clock,
    getScope: async () => {
      if (++scopes === 3) clock = Date.parse(context.approval.expiresAt);
      return { ...scope };
    },
  })), 'APPROVAL_INVALID');
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect', 'result']);
  assert.equal(ledger.entries[1].cost.reads, 1);
  assert.equal(ledger.entries.at(-1).status, 'failed');
  assert.equal(calls, 0);
});

test('design probe: missing markers, orphan markers and rolled-back ledgers are rejected', async () => {
  const context = await fixture();
  const original = await fs.readFile(context.ledgerFile);
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => {});
  await runProbe(runOptions(context.approvalFile), dependencies(runner));
  const current = await fs.readFile(context.ledgerFile);
  const markers = (await fs.readdir(context.root)).filter(name => name.startsWith('.design-reservation-'));
  assert.equal(markers.length, 2);
  await fs.writeFile(context.ledgerFile, original);
  await rejectsCode(runProbe(runOptions(context.approvalFile, 'mutations'), {
    runners: { mutations: async () => {} }, getScope: async () => ({ ...scope }), now: () => fixedNow,
  }), 'LEDGER_CHANGED');
  await fs.writeFile(context.ledgerFile, current);
  await fs.unlink(join(context.root, markers[0]));
  await rejectsCode(runProbe(runOptions(context.approvalFile, 'mutations'), {
    runners: { mutations: async () => {} }, getScope: async () => ({ ...scope }), now: () => fixedNow,
  }), 'LEDGER_CHANGED');
});

test('design probe: fixed-generation rotation marker is refused before any effect', async () => {
  const context = await fixture();
  const marker = join(context.root, '.design-reservation-rotate-000001');
  await fs.writeFile(marker, 'SYNTHETIC_ROTATION_MARKER\n', { mode: 0o600, flag: 'wx' });
  let calls = 0;
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(async ({ perform }) => {
    await perform(cost({ reads: 1 }), () => { calls++; });
  })), 'LEDGER_CHANGED');
  assert.equal(calls, 0);
  assert.deepEqual((await ledgerOf(context)).entries, []);
});

test('design probe: corrupted hash chain and clock rollback fail closed', async () => {
  const context = await fixture();
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => {});
  await runProbe(runOptions(context.approvalFile), dependencies(runner));
  const later = { runners: { mutations: async () => {} }, getScope: async () => ({ ...scope }), now: () => fixedNow - 1 };
  await rejectsCode(runProbe(runOptions(context.approvalFile, 'mutations'), later), 'LEDGER_INVALID');
  const ledger = await ledgerOf(context);
  ledger.entries[0].hash = '0'.repeat(64);
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  await rejectsCode(runProbe(runOptions(context.approvalFile, 'mutations'), { ...later, now: () => fixedNow }), 'LEDGER_INVALID');
});

test('design probe: ledger write failure leaves an orphan marker and never performs the action', async () => {
  const context = await fixture();
  const original = await fs.readFile(context.ledgerFile);
  const rename = fs.rename;
  let calls = 0;
  try {
    fs.rename = async () => { throw new Error('PRIVATE_SENTINEL'); };
    const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LEDGER_UNSAFE');
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await fs.readFile(context.ledgerFile), original);
  const files = await fs.readdir(context.root);
  assert.equal(files.filter(name => name.startsWith('.design-reservation-')).length, 1);
  assert.equal(files.filter(name => name.startsWith('.design-ledger-')).length, 0);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(async () => {})), 'LEDGER_CHANGED');
  assert.equal(calls, 0);
});

test('design probe: killed subprocess leaves durable reservation and cannot be retried', async () => {
  const context = await fixture();
  const program = `
    import { runProbe } from ${JSON.stringify(pathToFileURL(script).href)};
    const scope = ${JSON.stringify(scope)};
    const effectCost = ${JSON.stringify(cost({ reads: 1 }))};
    const runner = async ({ perform }) => perform(effectCost, async () => {
      process.stdout.write('EFFECT_READY\\n');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
    await runProbe(${JSON.stringify(runOptions(context.approvalFile))}, {
      runners: { source: runner }, getScope: async () => scope, now: () => ${fixedNow},
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', program], {
    env: { HOME: context.parent, PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const [chunk] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    assert.match(String(chunk), /EFFECT_READY/);
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    const [exitCode, signal] = await closed;
    assert.equal(exitCode, null);
    assert.equal(signal, 'SIGKILL');
    const ledger = await ledgerOf(context);
    assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect']);
    assert.equal(ledger.entries[1].cost.reads, 1);
    const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => {});
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'BUSY');
    await fs.unlink(join(context.root, '.design-probe.lock'));
    await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'PHASE_UNRESOLVED');
    assert.deepEqual((await ledgerOf(context)).entries, ledger.entries);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('design probe: concurrent and stale locks are not stolen', async () => {
  const context = await fixture();
  let entered;
  let release;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const wait = new Promise(resolveWait => { release = resolveWait; });
  const runner = async ({ perform }) => perform(cost({ reads: 1 }), async () => { entered(); await wait; });
  const first = runProbe(runOptions(context.approvalFile), dependencies(runner));
  await started;
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'BUSY');
  release();
  assert.equal((await first).ok, true);
  const another = await fixture();
  const lock = join(another.root, '.design-probe.lock');
  await fs.writeFile(lock, 'PRIVATE_SENTINEL', { mode: 0o600 });
  await rejectsCode(runProbe(runOptions(another.approvalFile), dependencies(runner)), 'BUSY');
  assert.equal(await fs.readFile(lock, 'utf8'), 'PRIVATE_SENTINEL');
});

test('design probe: losing a live lock blocks later reservations and preserves the replacement', async () => {
  const context = await fixture();
  const lock = join(context.root, '.design-probe.lock');
  let calls = 0;
  const runner = async ({ perform }) => {
    await perform(cost({ reads: 1 }), async () => {
      calls++;
      await fs.unlink(lock);
      await rejectsCode(runProbe(runOptions(context.approvalFile, 'mutations'), {
        runners: { mutations: async () => {} }, getScope: async () => ({ ...scope }), now: () => fixedNow,
      }), 'PHASE_UNRESOLVED');
      await fs.writeFile(lock, 'PRIVATE_SENTINEL', { mode: 0o600 });
    });
    await perform(cost({ reads: 1 }), () => { calls++; });
  };
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'LOCK_LOST');
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(lock, 'utf8'), 'PRIVATE_SENTINEL');
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'effect']);
  assert.equal((await fs.readdir(context.root)).filter(name => name.startsWith('.design-reservation-')).length, 2);
});

test('design probe: replacing the evidence root is rejected before another reservation', async () => {
  const context = await fixture();
  const moved = `${context.root}-original`;
  let calls = 0;
  const runner = async ({ perform }) => {
    await perform(cost({ reads: 1 }), async () => {
      calls++;
      await fs.rename(context.root, moved);
      await fs.mkdir(context.root, { mode: 0o700 });
      for (const name of await fs.readdir(moved)) {
        if (name === '.design-probe.lock') await fs.rename(join(moved, name), join(context.root, name));
        else await fs.copyFile(join(moved, name), join(context.root, name));
      }
    });
    await perform(cost({ reads: 1 }), () => { calls++; });
  };
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'ROOT_UNSAFE');
  for (const root of [context.root, moved]) {
    assert.equal((await fs.readdir(root)).filter(name => name.startsWith('.design-reservation-')).length, 2);
  }
  assert.equal(calls, 1);
});

test('design probe: file growth after open is bounded and fails closed', async () => {
  for (const kind of ['approval', 'ledger']) {
    const context = await fixture();
    const target = kind === 'approval' ? context.approvalFile : context.ledgerFile;
    const open = fs.open;
    let injected = false;
    let maximumRequest = 0;
    let calls = 0;
    try {
      fs.open = async (path, ...args) => {
        const handle = await open(path, ...args);
        if (path !== target || injected) return handle;
        injected = true;
        return new Proxy(handle, {
          get(object, property) {
            if (property === 'read') return async (buffer, offset, length, position) => {
              maximumRequest = Math.max(maximumRequest, length);
              await fs.appendFile(target, Buffer.alloc(128 * 1024 + 1));
              return object.read(buffer, offset, length, position);
            };
            const value = Reflect.get(object, property, object);
            return typeof value === 'function' ? value.bind(object) : value;
          },
        });
      };
      const runner = async ({ perform }) => perform(cost({ reads: 1 }), () => { calls++; });
      await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), kind === 'approval' ? 'APPROVAL_UNSAFE' : 'LEDGER_UNSAFE');
    } finally {
      fs.open = open;
    }
    assert.equal(injected, true);
    assert.ok(maximumRequest <= 128 * 1024 + 1);
    assert.equal(calls, 0);
  }
});

test('design probe: workspace aliases resolve to the same directory identity', async () => {
  const workspace = resolve(import.meta.dirname, '..');
  const alias = join(resolve(workspace, '..'), 'CALL-CLAUDE-WEBKIT');
  let aliasStat;
  try { aliasStat = await fs.stat(alias, { bigint: true }); } catch (error) {
    assert.equal(error.code, 'ENOENT');
    return;
  }
  const workspaceStat = await fs.stat(workspace, { bigint: true });
  assert.equal(aliasStat.dev, workspaceStat.dev);
  assert.equal(aliasStat.ino, workspaceStat.ino);
  assert.equal(await fs.realpath(alias), await fs.realpath(workspace));
  const context = await fixture();
  const approval = { ...context.approval, evidenceRoot: alias };
  await context.writeApproval(approval, false);
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(async () => {})), 'ROOT_UNSAFE');
});

test('design probe: test injection is absent from the native MCP and CLI bundles', async () => {
  for (const entry of ['src/mcp-server.mjs', 'bin/ccw.mjs']) {
    const result = await build({
      entryPoints: [resolve(import.meta.dirname, '..', entry)], bundle: true, write: false,
      metafile: true, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.equal(inputs.some(path => path.endsWith('scripts/smoke-design.mjs')), false);
    assert.equal(inputs.some(path => path.endsWith('test/design-probe.test.mjs')), false);
  }
});

test('design probe: concurrent effects cannot overspend or release the lock early', async () => {
  const context = await fixture();
  context.approval.limits.reads = 1;
  await context.writeApproval();
  let entered;
  let release;
  let calls = 0;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const wait = new Promise(resolveWait => { release = resolveWait; });
  const runner = async ({ perform }) => {
    const firstEffect = perform(cost({ reads: 1 }), async () => { calls++; entered(); await wait; });
    await started;
    return Promise.all([firstEffect, perform(cost({ reads: 1 }), async () => { calls++; })]);
  };
  const first = runProbe(runOptions(context.approvalFile), dependencies(runner));
  await started;
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'BUSY');
  release();
  await rejectsCode(first, 'BUSY');
  const ledger = await ledgerOf(context);
  assert.equal(ledger.entries.filter(entry => entry.kind === 'effect').length, 1);
  assert.equal(ledger.entries.at(-1).status, 'failed');
  assert.equal(calls, 1);
});

test('design probe: a runner cannot leave an unawaited effect behind after lock release', async () => {
  const context = await fixture();
  let calls = 0;
  const runner = async ({ perform }) => { void perform(cost({ reads: 1 }), () => { calls++; }).catch(() => {}); };
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(runner)), 'PROBE_FAILED');
  const ledger = await ledgerOf(context);
  assert.equal(ledger.entries.at(-1).status, 'failed');
  assert.equal(calls, 0);
  assert.equal((await fs.readdir(context.root)).includes('.design-probe.lock'), false);
});

test('design probe: a no-op runner is not accepted as probe evidence', async () => {
  const context = await fixture();
  await rejectsCode(runProbe(runOptions(context.approvalFile), dependencies(async () => {})), 'PROBE_FAILED');
  const ledger = await ledgerOf(context);
  assert.deepEqual(ledger.entries.map(entry => entry.kind), ['phase', 'result']);
  assert.equal(ledger.entries.at(-1).status, 'failed');
});
