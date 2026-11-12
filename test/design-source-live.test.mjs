import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError } from '../src/core/errors.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';
import { computeCodeHashes, runProbe } from '../scripts/smoke-design.mjs';
import { runPassiveSource } from '../scripts/design-probe-live.mjs';

after(cleanupTmpDirs);
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
const codeHashes = await computeCodeHashes();
const taskPack = { branch: 'spec/2026-11-06_add-claude-design-integration', commit: 'a'.repeat(40), specSha256: 'b'.repeat(64) };
const bytes = Buffer.from('<!DOCTYPE html><html><body>设计 😀 ` ${value} \" \' \u2028 </script></body></html>', 'utf8');
const target = { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', frameId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  shortId: 'SyntheticFrame01', version: 'version-1', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const ownedTargetId = 'A'.repeat(32);
const userTargetId = 'B'.repeat(32);
const sessionId = 'own-session';
const mainFrameId = 'own-frame';
const loaderId = 'own-loader';
const metadataUrl = `https://claude.ai/api/frame/${target.frameId}?org=${target.organizationId}&vt=SENTINEL_VT`;
const sourceUrl = `https://${target.frameId}.frame.claudeusercontent.com/_f/${target.version}/_src/index.html?__frame_t=SENTINEL_FRAME_TOKEN`;
const metadata = JSON.stringify({ ver: target.version, seq: 1, history: [target.version], fileCount: 1,
  files: [{ path: 'index.html', contentType: 'text/html', size: target.size, sha256: target.sha256 }],
  assetToken: 'TOKEN_SENTINEL', author: { email: 'redacted@example.invalid' } });

async function fixture() {
  const parent = await fs.realpath(await makeTmpDir('ccw-design-source-'));
  const root = join(parent, 'evidence');
  const approvalFile = join(parent, 'approval.json');
  const ledgerFile = join(root, 'ledger.json');
  await fs.mkdir(root, { mode: 0o700 });
  const approval = {
    schema: 'ccw-design-probe-approval/2', approvalId: 'source_test_001', issuer: 'host-under-user-authorization',
    scopeSummary: 'Synthetic source; one design; at most two revisions; no uploads or sharing', taskPack, codeHashes, evidenceRoot: root,
    sourceTarget: target, phases: { source: 1, mutations: 0, 'versioned-files': 0, acceptance: 0 },
    limits: { reads: 64, sessions: 0, messages: 0, downloads: 1, uploads: 0, shares: 0 },
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z',
  };
  const approvalBytes = Buffer.from(JSON.stringify(approval));
  await fs.writeFile(approvalFile, approvalBytes, { mode: 0o600 });
  await fs.writeFile(ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: approval.approvalId,
    approvalSha256: createHash('sha256').update(approvalBytes).digest('hex'), entries: [] }), { mode: 0o600 });
  return { parent, root, approvalFile, ledgerFile };
}

class FakeClient {
  constructor({ asset = true, focus = false, createFailure = null, signal = null, ledgerFile = null, duplicate = false,
    overflow = false, sameDocumentEscape = false, artifactReady = true, blankReady = true } = {}) {
    this.asset = asset;
    this.focus = focus;
    this.createFailure = createFailure;
    this.signal = signal;
    this.ledgerFile = ledgerFile;
    this.duplicate = duplicate;
    this.overflow = overflow;
    this.sameDocumentEscape = sameDocumentEscape;
    this.artifactReady = artifactReady;
    this.blankReady = blankReady;
    this.beforeSend = null;
    this.url = 'about:blank';
    this.calls = [];
    this.listeners = new Set();
    this.closed = false;
    this.closedTargets = [];
    this.lastReservation = 0;
    this.remainingReads = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params) {
    const message = { method, sessionId, params };
    for (const listener of this.listeners) listener(message);
  }

  emitNetwork(requestId, url, frameId, loader, body) {
    this.emit('Network.requestWillBeSent', { requestId, frameId, loaderId: loader,
      request: { method: 'GET', url, headers: { cookie: 'TOKEN_SENTINEL' } } });
    this.emit('Network.responseReceived', { requestId, frameId, loaderId: loader,
      response: { url, status: 200, mimeType: requestId === 'meta' ? 'application/json' : 'text/html',
        headers: { 'content-length': String(Buffer.byteLength(body)), 'set-cookie': 'TOKEN_SENTINEL' } } });
    this.emit('Network.dataReceived', { requestId, dataLength: Buffer.byteLength(body), data: 'TOKEN_SENTINEL' });
    this.emit('Network.loadingFinished', { requestId });
  }

  async send(method, params = {}, options = {}) {
    this.calls.push({ method, targetId: params.targetId ?? null, sessionId: options.sessionId ?? null });
    if (this.ledgerFile && !this.cleanup) {
      const ledger = JSON.parse(await fs.readFile(this.ledgerFile, 'utf8'));
      const entry = ledger.entries.at(-1);
      assert.equal(entry.kind, 'effect');
      if (entry.sequence > this.lastReservation) {
        this.lastReservation = entry.sequence;
        this.remainingReads = entry.cost.reads;
      }
      assert.ok(this.remainingReads > 0, `${method} must have a durable reserved read`);
      this.remainingReads--;
    }
    if (this.beforeSend) await this.beforeSend(method, params, options);
    switch (method) {
      case 'Target.createTarget':
        if (this.createFailure) throw new BridgeError(this.createFailure, 'TOKEN_SENTINEL');
        this.signal?.abort();
        return { targetId: ownedTargetId };
      case 'Target.attachToTarget': return { sessionId };
      case 'Page.enable': case 'Network.enable': return {};
      case 'Target.getTargetInfo': return { targetInfo: { targetId: ownedTargetId, url: this.url } };
      case 'Page.getFrameTree': return { frameTree: { frame: { id: mainFrameId } } };
      case 'Page.createIsolatedWorld': return { executionContextId: this.url === 'about:blank' ? 1 : 2 };
      case 'Runtime.callFunctionOn': {
        if (params.functionDeclaration.includes('crypto.subtle')) {
          this.hashCall = { declaration: params.functionDeclaration, encoded: params.arguments[0].value };
          const data = Buffer.from(params.arguments[0].value, 'base64');
          return { result: { value: createHash('sha256').update(data).digest('hex') } };
        }
        const blank = params.arguments[1].value;
        return { result: { value: { same: blank ? this.url === 'about:blank' : this.url === `https://claude.ai/artifact/${target.shortId}`,
          empty: true, hidden: !this.focus, focused: this.focus, ready: blank ? this.blankReady : this.artifactReady } } };
      }
      case 'Page.navigate':
        this.url = params.url;
        this.emit('Page.frameNavigated', { frame: { id: mainFrameId, loaderId, url: this.url } });
        this.emitNetwork('meta', metadataUrl, mainFrameId, loaderId, metadata);
        if (this.duplicate) this.emitNetwork('meta-duplicate', metadataUrl, mainFrameId, loaderId, metadata);
        if (this.overflow) {
          for (let index = 0; index < 1025; index++) this.emit('Page.navigatedWithinDocument', { frameId: mainFrameId, url: this.url });
        }
        if (this.sameDocumentEscape) {
          this.emit('Page.navigatedWithinDocument', { frameId: mainFrameId, url: 'https://claude.ai/new' });
          this.emit('Page.navigatedWithinDocument', { frameId: mainFrameId, url: this.url });
        }
        if (this.asset) this.emitNetwork('asset', sourceUrl, 'child-frame', 'child-loader', bytes.toString('utf8'));
        return { frameId: mainFrameId, loaderId };
      case 'Network.getResponseBody':
        return params.requestId === 'meta' ? { body: metadata, base64Encoded: false } : { body: bytes.toString('base64'), base64Encoded: true };
      case 'Target.closeTarget': this.closedTargets.push(params.targetId); return { success: true };
      default: throw new Error(`Unexpected method ${method}`);
    }
  }

  close() { this.closed = true; }
}

async function execute(context, fake, signal) {
  return runProbe({ live: true, phase: 'source', approvalFile: context.approvalFile }, {
    runners: { source: runnerContext => runPassiveSource(runnerContext, { connect: async () => fake, timeoutMs: 20 }) },
    getScope: async () => ({ ...taskPack }), now: () => fixedNow, signal,
  });
}

test('passive source: each browser operation is durably reserved and fake original is independently checked', async () => {
  const context = await fixture();
  const fake = new FakeClient({ ledgerFile: context.ledgerFile });
  const result = await execute(context, fake);
  assert.deepEqual(result, { ok: true, phase: 'source', evidence: { size: bytes.length, sha256: target.sha256,
    metadataMatched: true, sourceObserved: true, targetRetained: true } });
  assert.equal(fake.closed, true);
  assert.deepEqual(fake.closedTargets, []);
  assert.equal(fake.calls.some(call => call.targetId === userTargetId), false);
  assert.equal(fake.calls.some(call => call.method.startsWith('Browser.') || call.method.startsWith('Input.')), false);
  assert.match(fake.hashCall.declaration, /^async function\(encoded\)/);
  assert.equal(fake.hashCall.declaration.includes(bytes.toString('utf8')), false);
  assert.deepEqual(Buffer.from(fake.hashCall.encoded, 'base64'), bytes);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SENTINEL|SENTINEL_FRAME_TOKEN|redacted@example|设计/);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile, 'utf8'));
  assert.equal(ledger.entries.at(-1).status, 'completed');
  assert.equal(ledger.entries.filter(entry => entry.kind === 'effect' && entry.cost.downloads === 1).length, 1);
  assert.equal(ledger.entries.reduce((total, entry) => total + entry.cost.sessions + entry.cost.messages, 0), 0);
  assert.doesNotMatch(JSON.stringify(ledger), /TOKEN_SENTINEL|SENTINEL_FRAME_TOKEN|redacted@example|SyntheticFrame01/);
});

test('passive source: missing automatic source request stays unverified and retains the owned page', async () => {
  const context = await fixture();
  const fake = new FakeClient({ asset: false, ledgerFile: context.ledgerFile });
  await assert.rejects(execute(context, fake), error => {
    assert.equal(error.code, 'SOURCE_UNVERIFIED');
    assert.deepEqual(error.details, { metadataMatched: true, sourceObserved: false, targetRetained: true, creationUncertain: false });
    return true;
  });
  assert.equal(fake.calls.filter(call => call.method === 'Network.getResponseBody').length, 1);
  assert.deepEqual(fake.closedTargets, []);
  assert.equal(JSON.parse(await fs.readFile(context.ledgerFile, 'utf8')).entries.at(-1).status, 'failed');
});

test('passive source: a loading artifact can be checked without weakening blank-page readiness', async () => {
  const context = await fixture();
  const fake = new FakeClient({ artifactReady: false });
  const result = await execute(context, fake);
  assert.equal(result.evidence.metadataMatched, true);
  assert.equal(result.evidence.sourceObserved, true);
  assert.equal(result.evidence.targetRetained, true);
  const blankContext = await fixture();
  const blankFake = new FakeClient({ blankReady: false });
  await assert.rejects(execute(blankContext, blankFake), error => error.code === 'SOURCE_UNVERIFIED' && error.details.targetRetained === true);
  assert.equal(blankFake.calls.some(call => call.method === 'Page.navigate'), false);
  assert.deepEqual(blankFake.closedTargets, []);
});

test('passive source: a foregrounded blank page is never navigated or closed', async () => {
  const context = await fixture();
  const fake = new FakeClient({ focus: true });
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED' && error.details.targetRetained === true);
  assert.equal(fake.calls.some(call => call.method === 'Page.navigate'), false);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: an uncertain target receipt is reported without guessing or closing', async () => {
  const context = await fixture();
  const fake = new FakeClient({ createFailure: 'CDP_TIMEOUT' });
  await assert.rejects(execute(context, fake), error => error.code === 'TARGET_CREATION_UNCERTAIN' && error.details.creationUncertain === true);
  assert.deepEqual(fake.closedTargets, []);
  assert.equal(fake.calls.some(call => call.targetId === userTargetId), false);
});

test('passive source: cancellation after target creation preserves an unidentified blank tab', async () => {
  const context = await fixture();
  const controller = new AbortController();
  const fake = new FakeClient({ signal: controller });
  await assert.rejects(execute(context, fake, controller.signal), error => error.code === 'ABORTED' && error.details.targetRetained === true);
  assert.equal(fake.calls.some(call => call.method === 'Page.navigate'), false);
  assert.deepEqual(fake.closedTargets, []);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile, 'utf8'));
  assert.equal(ledger.entries.at(-1).status, 'interrupted');
});

test('passive source: user takeover just before navigation prevents navigation and cleanup', async () => {
  const context = await fixture();
  const fake = new FakeClient();
  let inspections = 0;
  fake.beforeSend = async method => {
    if (method === 'Target.getTargetInfo' && ++inspections === 2) fake.url = 'https://example.invalid/user-page';
  };
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED' && error.details.targetRetained === true);
  assert.equal(fake.calls.some(call => call.method === 'Page.navigate'), false);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: user takeover after navigation prevents credential-bearing body reads', async () => {
  const context = await fixture();
  const fake = new FakeClient();
  let inspections = 0;
  fake.beforeSend = async method => {
    if (method === 'Target.getTargetInfo' && ++inspections === 3) fake.focus = true;
  };
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED' && error.details.targetRetained === true);
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: duplicate metadata is unverified before any body read', async () => {
  const context = await fixture();
  const fake = new FakeClient({ duplicate: true });
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED');
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: pre-navigation event overflow fails closed', async () => {
  const context = await fixture();
  const fake = new FakeClient({ overflow: true });
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED');
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
});

test('passive source: event overflow during the source body read invalidates both captures', async () => {
  const context = await fixture();
  const fake = new FakeClient();
  fake.beforeSend = async (method, params) => {
    if (method !== 'Network.getResponseBody' || params.requestId !== 'asset') return;
    for (let index = 0; index < 20; index++) {
      fake.emit('Network.requestWillBeSent', { requestId: `unrelated-${index}`, frameId: mainFrameId, loaderId,
        request: { method: 'GET', url: `https://claude.ai/api/frame/${target.frameId}` } });
    }
  };
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED' && error.details.targetRetained === true);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: same-document escape and return invalidates the capture', async () => {
  const context = await fixture();
  const fake = new FakeClient({ sameDocumentEscape: true });
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED');
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
});

test('passive source: navigation timeout retains the possibly navigated target', async () => {
  const context = await fixture();
  const fake = new FakeClient();
  fake.beforeSend = async method => { if (method === 'Page.navigate') throw new BridgeError('CDP_TIMEOUT', 'PRIVATE_SENTINEL'); };
  await assert.rejects(execute(context, fake), error => error.code === 'SOURCE_UNVERIFIED' && error.details.targetRetained === true);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: even a known empty background target is retained after failure', async () => {
  const context = await fixture();
  const fake = new FakeClient();
  let inspections = 0;
  fake.beforeSend = async method => {
    if (method === 'Runtime.callFunctionOn' && ++inspections === 1) throw new Error('PRIVATE_SENTINEL');
  };
  await assert.rejects(execute(context, fake), error => {
    assert.equal(error.code, 'SOURCE_UNVERIFIED');
    assert.equal(error.details.targetRetained, true);
    assert.doesNotMatch(`${error.message}\n${error.stack}`, /PRIVATE_SENTINEL/);
    return true;
  });
  assert.deepEqual(fake.closedTargets, []);
  assert.equal(fake.calls.some(call => call.targetId === userTargetId), false);
});

test('passive source: limited budget fails before target creation', async () => {
  const context = await fixture();
  const approval = JSON.parse(await fs.readFile(context.approvalFile, 'utf8'));
  approval.limits.reads = 1;
  const bytes = Buffer.from(JSON.stringify(approval));
  await fs.writeFile(context.approvalFile, bytes);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile, 'utf8'));
  ledger.approvalSha256 = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  const fake = new FakeClient();
  await assert.rejects(execute(context, fake), error => error.code === 'BUDGET_EXHAUSTED' && error.details.targetRetained === false);
  assert.equal(fake.calls.some(call => call.method === 'Target.createTarget'), false);
});

test('passive source: cancellation while target receipt is in flight waits for identity and preserves it', async () => {
  const context = await fixture();
  const controller = new AbortController();
  const fake = new FakeClient();
  fake.beforeSend = async method => {
    if (method === 'Target.createTarget') {
      controller.abort();
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
  };
  await assert.rejects(execute(context, fake, controller.signal), error => error.code === 'ABORTED' && error.details.targetRetained === true);
  assert.equal(fake.calls.some(call => call.method === 'Page.navigate'), false);
  assert.deepEqual(fake.closedTargets, []);
});

test('passive source: cleanup status survives a final ledger write failure', async () => {
  const context = await fixture();
  const fake = new FakeClient({ asset: false });
  const rename = fs.rename;
  fake.close = () => { fake.closed = true; fs.rename = async () => { throw new Error('TOKEN_SENTINEL'); }; };
  try {
    await assert.rejects(execute(context, fake), error => {
      assert.equal(error.code, 'LEDGER_UNSAFE');
      assert.equal(error.details.targetRetained, true);
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /TOKEN_SENTINEL/);
      return true;
    });
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(fake.closedTargets, []);
});
