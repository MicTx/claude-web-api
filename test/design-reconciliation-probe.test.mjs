import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { BridgeError } from '../src/core/errors.mjs';
import { ClaudeApi } from '../src/core/claude-api.mjs';
import { CODE_FILES, computeCodeHashes, inspectProbeApproval, rotateProbeApproval, runProbe } from '../scripts/smoke-design.mjs';
import { MUTATION_PROMPT } from '../scripts/design-probe-mutations.mjs';
import { inspectReconciliationScope, projectReconciliation, readReconciliationBinding,
  runDesignReconciliation } from '../scripts/design-probe-reconciliation.mjs';
import { cleanupTmpDirs, makeTmpDir } from './helpers.mjs';

after(cleanupTmpDirs);
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
const hashes = await computeCodeHashes();
const scope = { branch: 'spec/2026-11-06_add-claude-design-integration', commit: 'a'.repeat(40), specSha256: 'b'.repeat(64) };
const nextScope = { ...scope, specSha256: 'c'.repeat(64) };
const finalScope = { ...scope, specSha256: 'd'.repeat(64) };
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FRAME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HUMAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ASSISTANT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ROOT = '00000000-0000-4000-8000-000000000000';
const digest = value => createHash('sha256').update(value).digest('hex');
const cost = reads => ({ reads, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0 });
const discovery = { kind: 'discovery-evidence', designControl: false, designSystemControl: false,
  draftEmpty: true, hidden: true, targetRetained: true, typeEvidence: 'unknown', routes: [], truncated: false };

function conversation() {
  return { uuid: CONVERSATION, current_leaf_message_uuid: ASSISTANT, chat_messages: [
    { uuid: HUMAN, parent_message_uuid: ROOT, sender: 'human', content: [{ type: 'text', text: MUTATION_PROMPT }], attachments: [], files: [] },
    { uuid: ASSISTANT, parent_message_uuid: HUMAN, sender: 'assistant', stop_reason: 'end_turn', truncated: false,
      content: [
        { type: 'tool_use', id: 'write_1', name: 'Write', input: { file_path: '/PRIVATE_SENTINEL/index.html', content: 'SOURCE_SENTINEL' } },
        { type: 'tool_result', name: 'Write', tool_use_id: 'write_1', is_error: false, content: [{ type: 'text', text: 'ok' }] },
        { type: 'tool_use', id: 'publish_1', name: 'mcp__claude-artifacts__publish_files',
          input: { files: [{ path: '/PRIVATE_SENTINEL/index.html', as: 'index.html' }] } },
        { type: 'tool_result', name: 'mcp__claude-artifacts__publish_files', tool_use_id: 'publish_1', is_error: false,
          content: [{ type: 'text', text: JSON.stringify({ slug: FRAME, url: 'https://claude.ai/artifact/SyntheticDesign01',
            version: 'synthetic-v1', seq: 1, history: ['synthetic-v1'], own_file_count: 1, token: 'TOKEN_SENTINEL' }) }] },
        { type: 'tool_use', id: 'other_1', name: 'PRIVATE_TOOL_SENTINEL', input: { text: 'INPUT_SENTINEL' } },
        { type: 'text', text: 'REPLY_SENTINEL' },
      ] },
  ] };
}

async function fixture() {
  const parent = await fs.realpath(await makeTmpDir('ccw-reconciliation-'));
  const root = join(parent, 'evidence');
  const stateDir = join(root, 'mutation-state');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(stateDir, { mode: 0o700 });
  const state = { version: 1, lastSubmissionAt: 0, sessions: [{ session: 'design-g1-probe', orgId: ORG,
    conversationId: CONVERSATION, parentMessageId: ROOT, model: null, createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z', pending: { kind: 'send', parentMessageId: ROOT,
      promptSha256: digest(MUTATION_PROMPT), startedAt: '2026-11-07T00:00:00.000Z' } }] };
  const stateBytes = Buffer.from(JSON.stringify(state));
  const stateFile = join(stateDir, 'sessions.json');
  await fs.writeFile(stateFile, stateBytes, { mode: 0o600 });
  const binding = { organizationId: ORG, conversationId: CONVERSATION, parentMessageId: ROOT,
    promptSha256: digest(MUTATION_PROMPT), stateSha256: digest(stateBytes) };
  const approvalFile = join(parent, 'approval.json');
  const nextApprovalFile = join(parent, 'next.json');
  const ledgerFile = join(root, 'ledger.json');
  const approval = { schema: 'ccw-design-probe-approval/3', approvalId: 'reconcile_test_001',
    issuer: 'host-under-user-authorization', scopeSummary: 'Synthetic source; one design; at most two revisions; no uploads or sharing',
    taskPack: scope, codeHashes: hashes, evidenceRoot: root,
    sourceTarget: { organizationId: ORG, frameId: FRAME, shortId: 'SyntheticFrame01', version: 'v1', size: 625, sha256: 'd'.repeat(64) },
    phases: { source: 0, mutations: 1, 'versioned-files': 1, acceptance: 1, discovery: 1 },
    limits: { reads: 64, sessions: 1, messages: 3, downloads: 12, uploads: 0, shares: 0 },
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z' };
  const approvalBytes = Buffer.from(JSON.stringify(approval));
  await fs.writeFile(approvalFile, approvalBytes, { mode: 0o600 });
  await fs.writeFile(ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: approval.approvalId,
    approvalSha256: digest(approvalBytes), entries: [] }), { mode: 0o600 });
  const settings = selected => ({ getScope: async () => selected, getCodeHashes: async () => hashes, now: () => fixedNow });
  await runProbe({ live: true, phase: 'discovery', approvalFile }, { ...settings(scope), runners: { discovery: async ({ perform }) => {
    await perform(cost(1), async () => {}); return discovery;
  } } });
  await assert.rejects(runProbe({ live: true, phase: 'mutations', approvalFile }, { ...settings(scope), runners: {
    mutations: async ({ perform }) => { await perform(cost(1), async () => {}); throw new BridgeError('PROBE_FAILED', 'synthetic'); },
  } }), error => error.code === 'PROBE_FAILED');
  const next = { ...structuredClone(approval), schema: 'ccw-design-probe-approval/4', taskPack: nextScope,
    phases: { source: 0, mutations: 0, 'versioned-files': 0, acceptance: 1, discovery: 0, reconciliation: 1 },
    reconciliationTarget: binding };
  await fs.writeFile(nextApprovalFile, JSON.stringify(next), { mode: 0o600 });
  return { parent, root, stateDir, stateFile, stateBytes, binding, approvalFile, nextApprovalFile, ledgerFile, approval, next, settings };
}

async function rotate(context) {
  return rotateProbeApproval({ approvalFile: context.approvalFile, nextApprovalFile: context.nextApprovalFile }, context.settings(nextScope));
}

async function execute(context, client, { phase = 'reconciliation', approvalFile = context.nextApprovalFile,
  selectedScope = nextScope, ...options } = {}) {
  return runProbe({ live: true, phase, approvalFile }, {
    ...context.settings(selectedScope), runners: { [phase]: runner => runDesignReconciliation(runner, { ...options, connect: async () => {
      await client.reservation(); return client;
    } }) },
  });
}

async function finalFixture() {
  const context = await fixture();
  await rotate(context);
  await assert.rejects(execute(context, new ReconciliationClient(context.root, { foreground: true })),
    error => error.code === 'UI_CONTEXT_LOST');
  const final = { ...structuredClone(context.next), schema: 'ccw-design-probe-approval/5', taskPack: finalScope,
    phases: { source: 0, mutations: 0, 'versioned-files': 0, acceptance: 0, discovery: 0, reconciliation: 0, 'reconciliation-final': 1 } };
  const finalApprovalFile = join(context.parent, 'final.json');
  await fs.writeFile(finalApprovalFile, JSON.stringify(final), { mode: 0o600 });
  return { ...context, final, finalApprovalFile };
}

function rotateFinal(context, extra = {}) {
  return rotateProbeApproval({ approvalFile: context.nextApprovalFile, nextApprovalFile: context.finalApprovalFile },
    { ...context.settings(finalScope), ...extra });
}

function executeFinal(context, options = {}) {
  const client = new ReconciliationClient(context.root, { phase: 'reconciliation-final', ...options });
  return { client, run: () => execute(context, client, { phase: 'reconciliation-final',
    approvalFile: context.finalApprovalFile, selectedScope: finalScope }) };
}

class ReconciliationClient {
  constructor(root, { status = 200, history = conversation(), chunks = null, redirect = false, foreground = false,
    contentType = 'application/json', sameDocument = null, lateBlank = false, delayedNavigation = false, phase = 'reconciliation' } = {}) {
    Object.assign(this, { root, status, history, chunks, redirect, foreground, contentType, sameDocument, lateBlank, delayedNavigation, phase });
    this.path = 'about:blank';
    this.href = 'about:blank';
    this.readyState = 'complete';
    this.epoch = 0;
    this.nextContextId = 1;
    this.contexts = new Map();
    this.calls = [];
    this.listeners = new Set();
    this.fetches = 0;
    this.cancelled = 0;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(method, params) { for (const listener of this.listeners) listener({ method, sessionId: 'own-session', params }); }
  async reservation() {
    const ledger = JSON.parse(await fs.readFile(join(this.root, 'ledger.json'), 'utf8'));
    const last = ledger.entries.at(-1);
    assert.equal(last.kind, 'effect');
    assert.equal(last.phase, this.phase);
    assert.deepEqual(last.cost, cost(1));
  }
  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (['Target.createTarget', 'Page.navigate'].includes(method)) await this.reservation();
    switch (method) {
      case 'Target.createTarget': return { targetId: 'A'.repeat(32) };
      case 'Target.attachToTarget': return { sessionId: 'own-session' };
      case 'Page.enable': case 'Network.enable': case 'Page.setLifecycleEventsEnabled': return {};
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main-frame', loaderId: 'initial-loader', url: this.href } } };
      case 'Target.getTargetInfo': return { targetInfo: { targetId: 'A'.repeat(32), url: this.href } };
      case 'Page.createIsolatedWorld': {
        const executionContextId = this.nextContextId++;
        this.contexts.set(executionContextId, this.epoch);
        return { executionContextId };
      }
      case 'Page.navigate': {
        this.path = new URL(params.url).pathname;
        this.href = params.url;
        this.readyState = 'loading';
        this.epoch++;
        this.emit('Runtime.executionContextsCleared', {});
        const events = () => {
          this.emit('Page.frameStartedLoading', { frameId: 'main-frame' });
          if (this.lateBlank) this.emit('Page.frameNavigated', { frame: { id: 'main-frame', loaderId: 'initial-loader', url: 'about:blank' } });
          this.emit('Page.frameNavigated', { frame: { id: 'main-frame', loaderId: 'loader', url: params.url } });
          if (this.sameDocument) {
            this.href = this.sameDocument;
            this.emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: this.sameDocument });
          }
          this.readyState = 'interactive';
          this.emit('Page.lifecycleEvent', { frameId: 'main-frame', loaderId: 'loader', name: 'DOMContentLoaded' });
          this.readyState = 'complete';
          this.emit('Page.lifecycleEvent', { frameId: 'main-frame', loaderId: 'loader', name: 'load' });
        };
        if (this.delayedNavigation) setTimeout(events, 5); else events();
        return { frameId: 'main-frame', loaderId: 'loader' };
      }
      case 'Runtime.callFunctionOn': {
        if (this.contexts.get(params.executionContextId) !== this.epoch) throw new BridgeError('CDP_ERROR', 'STALE_CONTEXT_SENTINEL');
        if (!params.functionDeclaration.includes('async function(path, limit')) {
          const location = new URL(this.href);
          const fn = vm.runInNewContext(`(${params.functionDeclaration})`, { location,
            document: { visibilityState: this.foreground ? 'visible' : 'hidden', hasFocus: () => this.foreground,
              readyState: this.readyState, body: { childNodes: this.bodyChildren ?? [] }, head: { childNodes: [] },
              ...(this.focused === undefined ? {} : { hasFocus: () => this.focused }) } });
          return { result: { value: await fn(...(params.arguments ?? []).map(argument => argument.value)) } };
        }
        await this.reservation();
        this.fetches++;
        const [path, limit, timeout] = params.arguments.map(argument => argument.value);
        const url = `https://claude.ai${path}`;
        this.emit('Network.requestWillBeSent', { frameId: 'main-frame', requestId: 'history', request: { method: 'GET', url } });
        if (this.redirect) throw Error('REDIRECT_SENTINEL');
        this.emit('Network.responseReceived', { frameId: 'main-frame', requestId: 'history', response: { url, status: this.status } });
        const chunks = this.chunks ?? [new TextEncoder().encode(JSON.stringify(this.history))];
        let index = 0;
        const reader = { read: async () => {
          if (index < chunks.length) return { done: false, value: chunks[index++] };
          this.emit('Network.loadingFinished', { requestId: 'history' });
          return { done: true };
        }, cancel: async () => { this.cancelled++; } };
        const sandbox = { AbortController, setTimeout, clearTimeout, TextDecoder,
          fetch: async (_path, options) => {
            assert.equal(options.method, 'GET');
            assert.deepEqual(Object.keys(options.headers), []);
            assert.equal(options.body, undefined);
            assert.equal(options.credentials, 'same-origin');
            assert.equal(options.redirect, 'error');
            assert.equal(options.cache, 'no-store');
            return { status: this.status, headers: { get: name => name === 'content-type' ? this.contentType : null },
              body: { getReader: () => reader, cancel: async () => { this.cancelled++; } } };
          } };
        const fn = vm.runInNewContext(`(${params.functionDeclaration})`, sandbox);
        const value = await fn(path, limit, timeout);
        if (this.status !== 200) this.emit('Network.loadingFinished', { requestId: 'history' });
        return { result: { value } };
      }
      default: throw Error(`Unexpected ${method}`);
    }
  }
  close() {}
}

async function stateSnapshot(context) {
  const names = (await fs.readdir(context.stateDir)).sort();
  const entries = await Promise.all(names.map(async name => {
    const stat = await fs.lstat(join(context.stateDir, name), { bigint: true });
    return { name, mode: stat.mode, mtimeNs: stat.mtimeNs, bytes: await fs.readFile(join(context.stateDir, name)) };
  }));
  const dir = await fs.stat(context.stateDir, { bigint: true });
  return { entries, mode: dir.mode, mtimeNs: dir.mtimeNs };
}

test('reconciliation final: dedicated rotation preserves the failed phase and grants four read-only effects once', async () => {
  const context = await finalFixture();
  const before = JSON.parse(await fs.readFile(context.ledgerFile));
  const oldFailure = await fs.readFile(join(context.root, 'reconciliation-failure.json'));
  const pending = await stateSnapshot(context);
  const rotated = await rotateFinal(context);
  assert.equal(rotated.usage.reads, 4);
  const after = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
  assert.equal(after.entries.length, before.entries.length + 1);
  await assert.rejects(inspectProbeApproval({ approvalFile: context.nextApprovalFile }, context.settings(nextScope)),
    error => error.code === 'APPROVAL_SUPERSEDED');
  const inspection = await inspectProbeApproval({ approvalFile: context.finalApprovalFile }, context.settings(finalScope));
  assert.deepEqual(Object.entries(inspection.phases).filter(([, enabled]) => enabled).map(([phase]) => phase), ['reconciliation-final']);
  let oldCalls = 0;
  await assert.rejects(runProbe({ live: true, phase: 'reconciliation', approvalFile: context.finalApprovalFile }, {
    ...context.settings(finalScope), runners: { reconciliation: async () => { oldCalls++; } },
  }), error => error.code === 'APPROVAL_INVALID');
  assert.equal(oldCalls, 0);
  const { client, run } = executeFinal(context, { sameDocument: 'https://claude.ai/new', delayedNavigation: true });
  const output = await run();
  assert.equal(output.evidence.status, 'confirmed_complete');
  assert.equal(client.fetches, 1);
  assert.equal(output.evidence.resultSha256, digest(await fs.readFile(join(context.root, 'reconciliation-final-result.json'))));
  assert.deepEqual(await fs.readFile(join(context.root, 'reconciliation-failure.json')), oldFailure);
  assert.deepEqual(await stateSnapshot(context), pending);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.filter(entry => entry.kind === 'effect' && entry.phase === 'reconciliation-final').length, 4);
  await assert.rejects(executeFinal(context).run(), error => error.code === 'PHASE_UNRESOLVED');
  assert.doesNotMatch(JSON.stringify(output), /SENTINEL|SyntheticDesign01|bbbbbbbb|设计|https:/);
});

test('reconciliation final: changed scope, binding, expiry and extra phase rights cannot rotate', async () => {
  for (const mutate of [
    value => { value.phases.reconciliation = 1; },
    value => { value.phases.acceptance = 1; },
    value => { value.phases.extra = 1; },
    value => { value.schema = 'ccw-design-probe-approval/6'; },
    value => { value.reconciliationTarget.stateSha256 = 'f'.repeat(64); },
    value => { value.sourceTarget.version = 'other-version'; },
    value => { value.expiresAt = '2026-11-09T00:00:00.000Z'; },
    value => { value.limits.reads = 63; },
  ]) {
    const context = await finalFixture();
    const candidate = structuredClone(context.final);
    mutate(candidate);
    await fs.writeFile(context.finalApprovalFile, JSON.stringify(candidate));
    const before = await fs.readFile(context.ledgerFile);
    await assert.rejects(rotateFinal(context));
    assert.deepEqual(await fs.readFile(context.ledgerFile), before);
  }
});

test('reconciliation final: four reads is a hard limit and every write effect is refused', async () => {
  for (const forbidden of [{ ...cost(5) }, ...['sessions', 'messages', 'downloads', 'uploads', 'shares'].map(key => ({ ...cost(0), [key]: 1 }))]) {
    const context = await finalFixture();
    await rotateFinal(context);
    let calls = 0;
    await assert.rejects(runProbe({ live: true, phase: 'reconciliation-final', approvalFile: context.finalApprovalFile }, {
      ...context.settings(finalScope), runners: { 'reconciliation-final': async ({ perform }) => {
        await perform(forbidden, async () => { calls++; });
      } },
    }), error => ['BUDGET_EXHAUSTED', 'LIVE_GUARD'].includes(error.code));
    assert.equal(calls, 0);
    await assert.rejects(executeFinal(context).run(), error => error.code === 'PHASE_UNRESOLVED');
  }
});

test('reconciliation final: prerequisites and a second generation cannot reopen any attempt', async () => {
  for (const state of ['unfinished', 'completed']) {
    const context = await finalFixture();
    const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
    if (state === 'unfinished') ledger.entries.pop();
    else {
      const last = ledger.entries.at(-1);
      last.status = 'completed';
      last.hash = digest(JSON.stringify([last.sequence, last.kind, last.phase, last.cost,
        last.reservation, last.status, last.at, last.previous, last.resultSha256]));
    }
    await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
    await assert.rejects(rotateFinal(context));
  }
  const context = await finalFixture();
  await rotateFinal(context);
  await assert.rejects(executeFinal(context, { foreground: true }).run(), error => error.code === 'UI_CONTEXT_LOST');
  const failure = JSON.parse(await fs.readFile(join(context.root, 'reconciliation-final-failure.json')));
  assert.equal(failure.diagnostic.reason, 'page_visible');
  await assert.rejects(executeFinal(context).run(), error => error.code === 'PHASE_UNRESOLVED');
  for (const change of [value => { value.schema = 'ccw-design-probe-approval/6'; },
    value => { value.phases.reconciliation = 1; }, value => { value.phases.extra = 1; }, value => {}]) {
    const later = structuredClone(context.final);
    change(later);
    const laterFile = join(context.parent, 'later-final.json');
    await fs.writeFile(laterFile, JSON.stringify(later), { mode: 0o600 });
    await assert.rejects(rotateProbeApproval({ approvalFile: context.finalApprovalFile, nextApprovalFile: laterFile },
      context.settings(finalScope)));
  }
});

test('reconciliation final: interrupted rotation recovers the same candidate without resetting usage', async () => {
  const context = await finalFixture();
  const before = JSON.parse(await fs.readFile(context.ledgerFile));
  await assert.rejects(rotateFinal(context, { afterStep: async step => { if (step === 'marker') throw Error('stop'); } }));
  await assert.rejects(executeFinal(context).run());
  const result = await rotateFinal(context);
  assert.equal(result.usage.reads, 4);
  const after = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
  assert.equal(after.entries.length, before.entries.length + 1);
  assert.equal(after.entries.filter(entry => entry.kind === 'rotate').length, 2);
});

test('reconciliation final: concurrent rotation has one owner and no duplicate grant', async () => {
  const context = await finalFixture();
  const results = await Promise.allSettled([rotateFinal(context), rotateFinal(context)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BUSY');
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.filter(entry => entry.kind === 'rotate').length, 2);
  const result = await rotateFinal(context);
  assert.equal(result.alreadyRotated, true);
  assert.equal(result.usage.reads, 4);
});

test('reconciliation final: sealed v4 closure refuses final approval and superseded old approval before effects', async () => {
  const context = await finalFixture();
  const legacyRoot = join(context.parent, 'legacy-v4');
  const sealedHashes = {};
  const frozen = { 'scripts/smoke-design.mjs': ['design-probe-v4-sealed.txt', '11b287a5dd125a2ea878f8a18effd16c5fe4aba0fd8be8c7244df17479c2b8ab'],
    'scripts/design-probe-reconciliation.mjs': ['design-reconciliation-v4-sealed.txt', '9375e65d6bb4444667341e34b138994f31f928b36c885de9437fb095d8a492ec'] };
  for (const path of CODE_FILES) {
    const bytes = await fs.readFile(frozen[path] ? join(import.meta.dirname, 'fixtures', frozen[path][0]) : join(import.meta.dirname, '..', path));
    if (frozen[path]) assert.equal(digest(bytes), frozen[path][1]);
    else assert.equal(digest(bytes), hashes[path]);
    const destination = join(legacyRoot, path);
    await fs.mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, bytes, { mode: 0o600 });
    sealedHashes[path] = digest(bytes);
  }
  const legacy = await import(pathToFileURL(join(legacyRoot, 'scripts/smoke-design.mjs')).href);
  // The frozen closure hashes only the files it shipped with; extra current
  // files are copied so its imports resolve but stay outside its hash set.
  const legacyHashes = await legacy.computeCodeHashes();
  assert.deepEqual(legacyHashes, Object.fromEntries(Object.keys(legacyHashes).map(path => [path, sealedHashes[path]])));
  await rotateFinal(context);
  let calls = 0;
  for (const approvalFile of [context.nextApprovalFile, context.finalApprovalFile]) {
    await assert.rejects(legacy.runProbe({ live: true, phase: 'reconciliation', approvalFile }, {
      ...context.settings(nextScope), runners: { reconciliation: async () => { calls++; } },
    }));
  }
  assert.equal(calls, 0);
  await assert.rejects(runProbe({ live: true, phase: 'reconciliation-final', approvalFile: context.nextApprovalFile }, {
    ...context.settings(nextScope), runners: { 'reconciliation-final': async () => { calls++; } },
  }));
  assert.equal(calls, 0);
});

test('reconciliation final: a killed final reader cannot rerun and keeps prior charges', async () => {
  const context = await finalFixture();
  await rotateFinal(context);
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '../scripts/smoke-design.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runProbe } from ${JSON.stringify(moduleUrl)};
    await runProbe(${JSON.stringify({ live: true, phase: 'reconciliation-final', approvalFile: context.finalApprovalFile })}, {
      getScope: async () => (${JSON.stringify(finalScope)}), getCodeHashes: async () => (${JSON.stringify(hashes)}),
      now: () => ${fixedNow}, runners: { 'reconciliation-final': async ({ perform }) => {
        await perform(${JSON.stringify(cost(1))}, async () => {
          process.stdout.write('reserved\\n');
          await new Promise(() => { setInterval(() => {}, 1000); });
        });
      } },
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  const [exit, signal] = await once(child, 'exit');
  assert.equal(exit, null);
  assert.equal(signal, 'SIGKILL');
  await fs.unlink(join(context.root, '.design-probe.lock'));
  await assert.rejects(executeFinal(context).run(), error => error.code === 'PHASE_UNRESOLVED');
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.at(-1).kind, 'effect');
  assert.deepEqual(ledger.entries.at(-1).cost, cost(1));
  assert.equal(ledger.entries.filter(entry => entry.kind === 'effect').reduce((sum, entry) => sum + entry.cost.reads, 0), 5);
});

test('reconciliation: v3 rotation preserves history and grants exactly one read-only phase', async () => {
  const context = await fixture();
  const before = JSON.parse(await fs.readFile(context.ledgerFile));
  const result = await rotate(context);
  const after = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(result.usage.reads, 2);
  assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
  assert.equal(after.entries.at(-1).kind, 'rotate');
  const client = new ReconciliationClient(context.root);
  const stateBefore = await stateSnapshot(context);
  const output = await execute(context, client);
  assert.equal(output.evidence.status, 'confirmed_complete');
  assert.equal(output.evidence.associated, true);
  assert.equal(output.evidence.publicationCandidates, 1);
  assert.equal(client.fetches, 1);
  assert.deepEqual(await stateSnapshot(context), stateBefore);
  assert.equal(client.calls.filter(call => call.method === 'Page.navigate').length, 1);
  assert.equal(client.calls.find(call => call.method === 'Page.navigate').params.url, 'https://claude.ai/new');
  assert.equal(client.calls.some(call => /artifact|\/frame\/|\/chat\//.test(JSON.stringify(call.params))), false);
  assert.doesNotMatch(JSON.stringify(output), /SENTINEL|SyntheticDesign01|bbbbbbbb|设计|https:/);
  assert.doesNotMatch(await fs.readFile(context.ledgerFile, 'utf8'), /SENTINEL|SyntheticDesign01|bbbbbbbb|设计|https:/);
  assert.equal(digest(await fs.readFile(join(context.root, 'reconciliation-result.json'))), output.evidence.resultSha256);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  const effects = ledger.entries.filter(entry => entry.kind === 'effect' && entry.phase === 'reconciliation');
  assert.equal(effects.length, 4);
  assert.ok(effects.every(entry => JSON.stringify(entry.cost) === JSON.stringify(cost(1))));
  await assert.rejects(execute(context, new ReconciliationClient(context.root)), error => error.code === 'PHASE_UNRESOLVED');
});

test('reconciliation: invalid transitions and pending changes reject before rotation', async () => {
  for (const mutate of [
    value => { value.limits.reads = 65; },
    value => { value.phases.mutations = 1; },
    value => { value.phases['versioned-files'] = 1; },
    value => { value.phases.extra = 1; },
    value => { value.reconciliationTarget.stateSha256 = 'f'.repeat(64); },
  ]) {
    const context = await fixture();
    const value = structuredClone(context.next);
    mutate(value);
    await fs.writeFile(context.nextApprovalFile, JSON.stringify(value));
    const before = await fs.readFile(context.ledgerFile);
    await assert.rejects(rotate(context));
    assert.deepEqual(await fs.readFile(context.ledgerFile), before);
  }
  for (const change of ['bytes', 'symlink']) {
    const context = await fixture();
    if (change === 'bytes') await fs.appendFile(context.stateFile, ' ');
    else { await fs.rename(context.stateFile, `${context.stateFile}.saved`); await fs.symlink(`${context.stateFile}.saved`, context.stateFile); }
    const before = await fs.readFile(context.ledgerFile);
    await assert.rejects(rotate(context));
    assert.deepEqual(await fs.readFile(context.ledgerFile), before);
  }
});

test('reconciliation: a failed mutation and an unused versioned allowance are prerequisites', async () => {
  for (const previous of ['completed', 'versioned']) {
    const context = await fixture();
    if (previous === 'completed') {
      const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
      const last = ledger.entries.at(-1);
      last.status = 'completed';
      last.hash = digest(JSON.stringify([last.sequence, last.kind, last.phase, last.cost,
        last.reservation, last.status, last.at, last.previous]));
      await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
    } else {
      await runProbe({ live: true, phase: 'versioned-files', approvalFile: context.approvalFile }, {
        ...context.settings(scope), runners: { 'versioned-files': async ({ perform }) => perform(cost(1), async () => {}) },
      });
    }
    const before = await fs.readFile(context.ledgerFile);
    await assert.rejects(rotate(context));
    assert.deepEqual(await fs.readFile(context.ledgerFile), before);
  }
});

test('reconciliation: pending drift after rotation prevents every effect', async () => {
  const context = await fixture();
  await rotate(context);
  await fs.appendFile(context.stateFile, ' ');
  const before = await fs.readFile(context.ledgerFile);
  const client = new ReconciliationClient(context.root);
  await assert.rejects(execute(context, client), error => error.code === 'PENDING_BINDING_INVALID');
  assert.equal(client.calls.length, 0);
  assert.deepEqual(await fs.readFile(context.ledgerFile), before);
});

test('reconciliation: a later approval cannot change binding or reopen the phase', async () => {
  const context = await fixture();
  await rotate(context);
  await execute(context, new ReconciliationClient(context.root));
  for (const mutate of [
    value => { value.reconciliationTarget.stateSha256 = 'f'.repeat(64); value.phases.reconciliation = 0; },
    value => { value.phases.reconciliation = 1; },
  ]) {
    const later = structuredClone(context.next);
    later.taskPack = { ...nextScope, specSha256: 'e'.repeat(64) };
    mutate(later);
    const file = join(context.parent, `later-${later.phases.reconciliation}.json`);
    await fs.writeFile(file, JSON.stringify(later), { mode: 0o600 });
    await assert.rejects(rotateProbeApproval({ approvalFile: context.nextApprovalFile, nextApprovalFile: file },
      context.settings(later.taskPack)));
  }
});

test('reconciliation: the exact sealed v3 module rejects new and superseded approvals before effects', async () => {
  const context = await fixture();
  const bytes = await fs.readFile(new URL('./fixtures/design-probe-v3-sealed.txt', import.meta.url));
  assert.equal(digest(bytes), 'cde6188e9f2e52659c9df527f313eedf8c2e0f7b00762fbb952d88755c012a40');
  const legacyRoot = join(context.parent, 'legacy');
  const dependencies = ['scripts/design-probe-json.mjs', 'scripts/design-probe-discovery.mjs', 'src/core/errors.mjs', 'src/is-main.mjs'];
  for (const path of dependencies) {
    await fs.mkdir(dirname(join(legacyRoot, path)), { recursive: true, mode: 0o700 });
    await fs.copyFile(join(import.meta.dirname, '..', path), join(legacyRoot, path));
  }
  const modulePath = join(legacyRoot, 'scripts/smoke-design.mjs');
  await fs.writeFile(modulePath, bytes, { mode: 0o600 });
  const legacy = await import(pathToFileURL(modulePath).href);
  await rotate(context);
  let calls = 0;
  const settings = { ...context.settings(scope), runners: { mutations: async () => { calls++; } } };
  await assert.rejects(legacy.runProbe({ live: true, phase: 'mutations', approvalFile: context.nextApprovalFile }, settings));
  await assert.rejects(legacy.runProbe({ live: true, phase: 'mutations', approvalFile: context.approvalFile }, settings));
  assert.equal(calls, 0);
});

test('reconciliation: every state is projected without prompt, body, tool input or identifiers', async () => {
  const context = await fixture();
  const cases = [
    ['confirmed_complete', value => value],
    ['confirmed_truncated', value => { value.chat_messages[1].stop_reason = 'max_tokens'; return value; }],
    ['in_progress_or_nonterminal', value => { value.chat_messages.pop(); value.current_leaf_message_uuid = HUMAN; return value; }],
    ['human_absent', value => { value.chat_messages = []; value.current_leaf_message_uuid = ROOT; return value; }],
    ['ambiguous', value => { value.chat_messages.push({ ...value.chat_messages[0], uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }); return value; }],
    ['unknown', value => { value.uuid = ORG; return value; }],
  ];
  for (const [status, mutate] of cases) {
    const before = await stateSnapshot(context);
    const output = projectReconciliation(mutate(conversation()), context.binding);
    assert.equal(output.status, status);
    assert.doesNotMatch(JSON.stringify(output), /SENTINEL|SyntheticDesign01|bbbbbbbb|设计|https:/);
    assert.deepEqual(await stateSnapshot(context), before);
  }
});

test('reconciliation: publication rejection reasons survive the real probe entry without leaking tool data', async () => {
  const context = await fixture();
  await rotate(context);
  const history = conversation();
  history.chat_messages[1].content[3].content[0].text = 'RESULT_BODY_SENTINEL';
  const client = new ReconciliationClient(context.root, { history });
  const result = await execute(context, client);
  assert.equal(result.evidence.status, 'confirmed_complete');
  assert.equal(result.evidence.publicationCandidates, null);
  assert.deepEqual(result.evidence.publicationDiagnostic, { reasonCodes: ['result_unparsable'], unknownToolPresent: true });
  const bytes = await fs.readFile(join(context.root, 'reconciliation-result.json'));
  assert.equal(digest(bytes), result.evidence.resultSha256);
  assert.deepEqual(JSON.parse(bytes).publicationDiagnostic, result.evidence.publicationDiagnostic);
  assert.doesNotMatch(bytes.toString('utf8') + JSON.stringify(result) + await fs.readFile(context.ledgerFile, 'utf8'),
    /SENTINEL|SyntheticDesign01|bbbbbbbb|设计|https:/);
  assert.deepEqual(await fs.readFile(context.stateFile), context.stateBytes);
});

test('reconciliation: untrusted diagnostic strings never enter result files or CLI-safe errors', async () => {
  const context = await fixture();
  await rotate(context);
  const evidence = projectReconciliation(conversation(), context.binding);
  evidence.publicationDiagnostic.reasonCodes = ['PRIVATE_DIAGNOSTIC_SENTINEL'];
  await assert.rejects(runProbe({ live: true, phase: 'reconciliation', approvalFile: context.nextApprovalFile }, {
    ...context.settings(nextScope), runners: { reconciliation: async ({ perform }) => {
      await perform(cost(1), async () => {});
      return evidence;
    } },
  }), error => {
    assert.equal(error.code, 'PROBE_FAILED');
    assert.doesNotMatch(error.message + JSON.stringify(error.details), /SENTINEL/);
    return true;
  });
  await assert.rejects(fs.access(join(context.root, 'reconciliation-result.json')), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(context.ledgerFile, 'utf8'), /SENTINEL/);
});

test('reconciliation: its GET matches the real ClaudeApi conversation request and rejects a competing tree branch', async () => {
  const context = await fixture();
  const history = conversation();
  history.chat_messages.push({ ...history.chat_messages[0], uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
  let expected;
  const api = new ClaudeApi({ request: async request => { expected = request; return history; } }, { readyTimeoutMs: 10_000 });
  await api.conversation(ORG, CONVERSATION);
  await rotate(context);
  const client = new ReconciliationClient(context.root, { history });
  const output = await execute(context, client);
  const call = client.calls.find(item => item.method === 'Runtime.callFunctionOn'
    && item.params.functionDeclaration.includes('async function(path, limit'));
  const observedPath = call.params.arguments[0].value;
  assert.equal(observedPath, expected.path);
  const observed = new URL(observedPath, 'https://claude.ai');
  const oracle = new URL(expected.path, 'https://claude.ai');
  assert.equal(observed.pathname, oracle.pathname);
  assert.deepEqual([...observed.searchParams.entries()], [...oracle.searchParams.entries()]);
  assert.equal(expected.method ?? 'GET', 'GET');
  assert.equal(expected.body, undefined);
  assert.equal(expected.stream, undefined);
  assert.equal(output.evidence.status, 'ambiguous');
  assert.equal(output.evidence.associated, false);
  assert.equal(output.evidence.humanCount, 2);
  assert.deepEqual(await fs.readFile(context.stateFile), context.stateBytes);
});

test('reconciliation: 404, 403, non-JSON and oversized bodies stay bounded without retries or state writes', async () => {
  for (const options of [{ status: 404 }, { status: 403 }, { contentType: 'text/html' },
    { chunks: [new Uint8Array(4 * 1024 * 1024 + 1)] }]) {
    const context = await fixture();
    await rotate(context);
    const before = await stateSnapshot(context);
    const client = new ReconciliationClient(context.root, options);
    const output = await execute(context, client);
    assert.equal(output.evidence.status, options.status === 404 ? 'conversation_not_found' : 'unknown');
    if (options.chunks) assert.equal(output.evidence.reason, 'too_large');
    assert.equal(client.fetches, 1);
    assert.deepEqual(await stateSnapshot(context), before);
  }
});

test('reconciliation: redirects and foreground takeover fail without retry or state writes', async () => {
  for (const options of [{ redirect: true }, { foreground: true }]) {
    const context = await fixture();
    await rotate(context);
    const before = await stateSnapshot(context);
    const client = new ReconciliationClient(context.root, options);
    await assert.rejects(execute(context, client));
    assert.ok(client.fetches <= 1);
    assert.deepEqual(await stateSnapshot(context), before);
    const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
    assert.equal(ledger.entries.at(-1).status, 'failed');
    await assert.rejects(execute(context, new ReconciliationClient(context.root)), error => error.code === 'PHASE_UNRESOLVED');
  }
});

test('reconciliation: same-URL history events and delayed navigation preserve the owned document', async () => {
  for (const options of [{ sameDocument: 'https://claude.ai/new' }, { delayedNavigation: true }, { lateBlank: true }]) {
    const context = await fixture();
    await rotate(context);
    const client = new ReconciliationClient(context.root, options);
    const result = await execute(context, client);
    assert.equal(result.evidence.status, 'confirmed_complete');
    assert.equal(client.fetches, 1);
    const navigationIndex = client.calls.findIndex(call => call.method === 'Page.navigate');
    const readIndex = client.calls.findIndex(call => call.method === 'Runtime.callFunctionOn'
      && call.params.functionDeclaration.includes('async function(path, limit'));
    assert.ok(client.calls.slice(navigationIndex + 1, readIndex).some(call => call.method === 'Page.createIsolatedWorld'));
  }
});

test('reconciliation: real scope function distinguishes loading, visibility, focus and exact URLs', () => {
  for (const path of ['about:blank', '/new']) {
    for (const readyState of ['loading', 'interactive', 'complete']) {
      for (const hidden of [true, false]) {
        for (const focused of [true, false]) {
          const href = path === 'about:blank' ? path : `https://claude.ai${path}`;
          const scope = vm.runInNewContext(`(${inspectReconciliationScope.toString()})`, {
            location: new URL(href), document: { visibilityState: hidden ? 'hidden' : 'visible', hasFocus: () => focused,
              readyState, body: { childNodes: [] }, head: { childNodes: [] } },
          })(path);
          assert.deepEqual(JSON.parse(JSON.stringify(scope)), { sameUrl: true, hidden, focused,
            ready: path === 'about:blank' ? readyState === 'complete' : readyState !== 'loading', empty: true });
        }
      }
    }
  }
  const wrong = vm.runInNewContext(`(${inspectReconciliationScope.toString()})`, {
    location: new URL('https://claude.ai/new?PRIVATE_SENTINEL=1'), document: { visibilityState: 'hidden',
      hasFocus: () => false, readyState: 'complete', body: { childNodes: [] }, head: { childNodes: [] } },
  })('/new');
  assert.equal(wrong.sameUrl, false);
  assert.doesNotMatch(JSON.stringify(wrong), /PRIVATE_SENTINEL/);
});

test('reconciliation: scope failures persist only exact stage and reason enums', async () => {
  const cases = [
    { reason: 'target_missing', method: 'Target.getTargetInfo', response: () => ({}) },
    { reason: 'target_url_changed', method: 'Target.getTargetInfo', response: result => ({ targetInfo: {
      ...result.targetInfo, url: 'https://example.invalid/PRIVATE_SENTINEL' } }) },
    { reason: 'main_frame_changed', method: 'Page.navigate', response: result => ({ ...result, frameId: 'other-frame' }) },
    { reason: 'loader_changed', method: 'Page.navigate', response: result => ({ ...result, loaderId: 'other-loader' }) },
    { reason: 'page_visible', setup: client => { client.foreground = true; } },
    { reason: 'page_focused', setup: client => { client.focused = true; } },
    { reason: 'blank_not_empty', setup: client => { client.bodyChildren = [{}]; } },
    { reason: 'page_not_ready', setup: client => { client.readyState = 'loading'; } },
    { reason: 'context_invalid', method: 'Page.createIsolatedWorld', response: () => ({ executionContextId: null }) },
    { reason: 'frame_detached', method: 'Page.navigate', event: ['Page.frameDetached', { frameId: 'main-frame' }] },
    { reason: 'dialog_opened', method: 'Page.navigate', event: ['Page.javascriptDialogOpening', { message: 'PRIVATE_SENTINEL' }] },
    { reason: 'same_document_url_changed', setup: client => { client.sameDocument = 'https://claude.ai/other?PRIVATE_SENTINEL'; } },
    { reason: 'cross_document_navigation', method: 'Page.navigate', event: ['Page.frameNavigated', {
      frame: { id: 'main-frame', loaderId: 'other-loader', url: 'https://example.invalid/PRIVATE_SENTINEL' } }] },
    { reason: 'navigation_timeout', method: 'Page.navigate', response: result => ({ ...result }), suppressLifecycle: true },
  ];
  for (const scenario of cases) {
    const context = await fixture();
    await rotate(context);
    const before = await stateSnapshot(context);
    const client = new ReconciliationClient(context.root);
    scenario.setup?.(client);
    if (scenario.suppressLifecycle) {
      const emit = client.emit.bind(client);
      client.emit = (method, params) => { if (method !== 'Page.lifecycleEvent') emit(method, params); };
    }
    const send = client.send.bind(client);
    client.send = async (method, params) => {
      const result = await send(method, params);
      if (method !== scenario.method) return result;
      if (scenario.event) client.emit(...scenario.event);
      return scenario.response ? scenario.response(result) : result;
    };
    await assert.rejects(execute(context, client, { navigationTimeoutMs: 5 }), error => {
      assert.equal(error.code, 'UI_CONTEXT_LOST');
      assert.equal(error.details.diagnostic.reason, scenario.reason);
      assert.equal(error.details.diagnostic.requestAttempted, false);
      return true;
    });
    const bytes = await fs.readFile(join(context.root, 'reconciliation-failure.json'));
    const failure = JSON.parse(bytes);
    assert.equal(failure.code, 'UI_CONTEXT_LOST');
    assert.equal(failure.diagnostic.reason, scenario.reason);
    assert.equal(failure.targetRetained, true);
    assert.doesNotMatch(bytes.toString('utf8'), /PRIVATE_SENTINEL|https:|cccccccc|设计/);
    const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
    assert.equal(ledger.entries.at(-1).status, 'failed');
    assert.equal(ledger.entries.at(-1).resultSha256, digest(bytes));
    assert.equal(client.fetches, 0);
    assert.deepEqual(await stateSnapshot(context), before);
  }
});

test('reconciliation: session and message effects are refused before action', async () => {
  for (const key of ['sessions', 'messages', 'downloads', 'uploads', 'shares']) {
    const context = await fixture();
    await rotate(context);
    let calls = 0;
    await assert.rejects(runProbe({ live: true, phase: 'reconciliation', approvalFile: context.nextApprovalFile }, {
      ...context.settings(nextScope), runners: { reconciliation: async ({ perform }) => {
        await perform({ ...cost(0), [key]: 1 }, async () => { calls++; });
      } },
    }), error => error.code === 'LIVE_GUARD');
    assert.equal(calls, 0);
  }
});

test('reconciliation: a killed worker retains its charged read and cannot rerun', async () => {
  const context = await fixture();
  await rotate(context);
  const moduleUrl = pathToFileURL(join(import.meta.dirname, '../scripts/smoke-design.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runProbe } from ${JSON.stringify(moduleUrl)};
    const options = ${JSON.stringify({ live: true, phase: 'reconciliation', approvalFile: context.nextApprovalFile })};
    const scope = ${JSON.stringify(nextScope)};
    const hashes = ${JSON.stringify(hashes)};
    await runProbe(options, { getScope: async () => scope, getCodeHashes: async () => hashes,
      now: () => ${fixedNow}, runners: { reconciliation: async ({ perform }) => {
        await perform(${JSON.stringify(cost(1))}, async () => {
          process.stdout.write('reserved\\n');
          await new Promise(() => { setInterval(() => {}, 1000); });
        });
      } } });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  const [exit, signal] = await once(child, 'exit');
  assert.equal(exit, null);
  assert.equal(signal, 'SIGKILL');
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.at(-1).kind, 'effect');
  assert.deepEqual(ledger.entries.at(-1).cost, cost(1));
  await fs.unlink(join(context.root, '.design-probe.lock'));
  await assert.rejects(execute(context, new ReconciliationClient(context.root)), error => error.code === 'PHASE_UNRESOLVED');
});

test('reconciliation: prompt binding is immutable and no SessionStore is invoked', async () => {
  const context = await fixture();
  assert.deepEqual(await readReconciliationBinding(context.root, context.binding), context.binding);
  const source = await fs.readFile(new URL('../scripts/design-probe-reconciliation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SessionStore|Page\.navigate[^\n]*\/chat\//);
});
