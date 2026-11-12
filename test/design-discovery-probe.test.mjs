import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { closeInterruptedProbe, computeCodeHashes, rotateProbeApproval, runProbe } from '../scripts/smoke-design.mjs';
import { discoveryRoute, runDesignDiscovery, validDiscoveryRoutes } from '../scripts/design-probe-discovery.mjs';
import { cleanupTmpDirs, makeTmpDir } from './helpers.mjs';

after(cleanupTmpDirs);
const project = resolve(import.meta.dirname, '..');
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
const codeHashes = await computeCodeHashes();
const scope = { branch: 'spec/2026-11-06_add-claude-design-integration', commit: 'a'.repeat(40), specSha256: 'b'.repeat(64) };
const nextScope = { ...scope, specSha256: 'c'.repeat(64) };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const cost = change => ({ reads: 0, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0, ...change });
const evidence = { kind: 'discovery-evidence', designControl: true, designSystemControl: false,
  draftEmpty: true, hidden: true, targetRetained: true, typeEvidence: 'unknown', routes: [], truncated: false };

async function fixture() {
  const parent = await fs.realpath(await makeTmpDir('ccw-discovery-'));
  const root = join(parent, 'evidence');
  await fs.mkdir(root, { mode: 0o700 });
  const approvalFile = join(parent, 'approval.json');
  const nextApprovalFile = join(parent, 'next.json');
  const ledgerFile = join(root, 'ledger.json');
  const approval = { schema: 'ccw-design-probe-approval/2', approvalId: 'discovery_test_001', issuer: 'host-under-user-authorization',
    scopeSummary: 'Synthetic source; one design; at most two revisions; no uploads or sharing', taskPack: scope,
    codeHashes, evidenceRoot: root, sourceTarget: { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      frameId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', shortId: 'SyntheticFrame01', version: 'v1', size: 625, sha256: 'd'.repeat(64) },
    phases: { source: 1, mutations: 1, 'versioned-files': 1, acceptance: 1 },
    limits: { reads: 64, sessions: 1, messages: 3, downloads: 12, uploads: 0, shares: 0 },
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z' };
  const next = structuredClone(approval);
  next.schema = 'ccw-design-probe-approval/3';
  next.taskPack = nextScope;
  next.phases.discovery = 1;
  const bytes = Buffer.from(JSON.stringify(approval));
  await fs.writeFile(approvalFile, bytes, { mode: 0o600 });
  await fs.writeFile(nextApprovalFile, JSON.stringify(next), { mode: 0o600 });
  await fs.writeFile(ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: approval.approvalId,
    approvalSha256: digest(bytes), entries: [] }), { mode: 0o600 });
  return { parent, root, approvalFile, nextApprovalFile, ledgerFile, approval, next };
}

const settings = (current = nextScope) => ({ getScope: async () => current, now: () => fixedNow });
const rotate = context => rotateProbeApproval({ approvalFile: context.approvalFile, nextApprovalFile: context.nextApprovalFile }, settings());
const execute = (context, phase, runner) => runProbe({ live: true, phase, approvalFile: context.nextApprovalFile },
  { ...settings(), runners: { [phase]: runner } });

test('discovery: v3 splits once without enabling writes or increasing the total budget', async () => {
  const context = await fixture();
  await rotate(context);
  let calls = 0;
  await assert.rejects(execute(context, 'discovery', async ({ perform }) => {
    await perform(cost({ reads: 6 }), () => { calls++; });
    await perform(cost({ reads: 1 }), () => { calls++; });
    return evidence;
  }), error => error.code === 'BUDGET_EXHAUSTED');
  assert.equal(calls, 1);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.reduce((sum, entry) => sum + entry.cost.reads, 0), 6);
  await assert.rejects(execute(context, 'discovery', async () => evidence), error => error.code === 'PHASE_UNRESOLVED');
});

test('discovery: a prior mutation attempt forbids splitting, and v3 cannot return to v2', async () => {
  const context = await fixture();
  await runProbe({ live: true, phase: 'mutations', approvalFile: context.approvalFile }, {
    ...settings(scope), runners: { mutations: async ({ perform }) => perform(cost({ reads: 1 }), async () => {}) },
  });
  context.next.phases.mutations = 0;
  await fs.writeFile(context.nextApprovalFile, JSON.stringify(context.next));
  await assert.rejects(rotate(context), error => error.code === 'ROTATION_CONFLICT');
  const unused = await fixture();
  await rotate(unused);
  const backwards = structuredClone(unused.approval);
  backwards.taskPack = { ...nextScope, specSha256: 'f'.repeat(64) };
  const backwardsFile = join(unused.parent, 'backwards.json');
  await fs.writeFile(backwardsFile, JSON.stringify(backwards), { mode: 0o600 });
  await assert.rejects(rotateProbeApproval({ approvalFile: unused.nextApprovalFile, nextApprovalFile: backwardsFile },
    settings(backwards.taskPack)), error => error.code === 'ROTATION_CONFLICT');
});

test('discovery: completed evidence is hash bound; tampering blocks and accepted runs continue', async () => {
  const context = await fixture();
  await rotate(context);
  const result = await execute(context, 'discovery', async ({ perform }) => {
    await perform(cost({ reads: 1 }), async () => {});
    return evidence;
  });
  const bytes = await fs.readFile(join(context.root, 'discovery-result.json'));
  assert.equal(result.evidence.resultSha256, digest(bytes));
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.at(-1).resultSha256, digest(bytes));
  let calls = 0;
  await fs.writeFile(join(context.root, 'discovery-result.json'), 'TOKEN_SENTINEL');
  await assert.rejects(execute(context, 'mutations', async () => { calls++; }), error => error.code === 'LEDGER_CHANGED');
  assert.equal(calls, 0);
  const fresh = await fixture();
  await rotate(fresh);
  await execute(fresh, 'discovery', async ({ perform }) => {
    await perform(cost({ reads: 1 }), async () => {});
    return evidence;
  });
  await execute(fresh, 'mutations', async ({ perform }) => {
    calls++;
    await perform(cost({ reads: 1 }), async () => {});
  });
  assert.equal(calls, 1);
});

test('discovery: acknowledged read-only interruption keeps charges and permanently closes the phase', async () => {
  const context = await fixture();
  await rotate(context);
  await assert.rejects(execute(context, 'discovery', async ({ perform }) => {
    await perform(cost({ reads: 2 }), async () => {});
    throw Error('interrupted');
  }));
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  ledger.entries.pop();
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  const result = await closeInterruptedProbe({ approvalFile: context.nextApprovalFile, phase: 'discovery' }, { now: () => fixedNow });
  assert.equal(result.usage.reads, 2);
  assert.equal(result.status, 'interrupted_acknowledged');
  await assert.rejects(closeInterruptedProbe({ approvalFile: context.nextApprovalFile, phase: 'discovery' }, { now: () => fixedNow }),
    error => error.code === 'PHASE_UNRESOLVED');
  await assert.rejects(closeInterruptedProbe({ approvalFile: context.nextApprovalFile, phase: 'mutations' }, { now: () => fixedNow }),
    error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(execute(context, 'discovery', async () => evidence), error => error.code === 'PHASE_UNRESOLVED');
  await assert.rejects(execute(context, 'mutations', async () => {}), error => error.code === 'PHASE_UNRESOLVED');
});

test('discovery: killed read-only worker closes locally without resending or refunding its reservation', async () => {
  const context = await fixture();
  await rotate(context);
  const worker = join(context.parent, 'worker.mjs');
  await fs.writeFile(worker, `
import { runProbe } from ${JSON.stringify(pathToFileURL(join(project, 'scripts/smoke-design.mjs')).href)};
await runProbe({ live:true, phase:'discovery', approvalFile:process.argv[2] }, {
  getScope:async()=>(${JSON.stringify(nextScope)}), now:()=>${fixedNow},
  runners:{discovery:async({perform})=>perform(${JSON.stringify(cost({ reads: 2 }))},async()=>process.kill(process.pid,'SIGKILL'))}
});
`, { mode: 0o600 });
  const child = spawn(process.execPath, [worker, context.nextApprovalFile], { stdio: 'ignore' });
  const [exit, signal] = await once(child, 'exit');
  assert.equal(exit, null);
  assert.equal(signal, 'SIGKILL');
  await fs.unlink(join(context.root, '.design-probe.lock'));
  const result = await closeInterruptedProbe({ approvalFile: context.nextApprovalFile, phase: 'discovery' }, { now: () => fixedNow });
  assert.equal(result.usage.reads, 2);
  await assert.rejects(execute(context, 'discovery', async () => evidence), error => error.code === 'PHASE_UNRESOLVED');
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  assert.equal(ledger.entries.filter(record => record.kind === 'effect').length, 1);
  assert.equal(ledger.entries.at(-1).status, 'interrupted_acknowledged');
});

test('discovery: the sealed v2 module refuses a v3 approval before any effect', async () => {
  const context = await fixture();
  const bytes = await fs.readFile(join(import.meta.dirname, 'fixtures/design-probe-v2.txt'));
  assert.equal(digest(bytes), '5cda22743d3f41cdb0976e5d357ee32a166a312ed34a6c2234504b5d9b00d362');
  const legacyRoot = join(context.parent, 'legacy');
  const imports = ['scripts/design-probe-json.mjs', 'scripts/design-probe-live.mjs', 'scripts/design-probe-source.mjs',
    'src/api-config.mjs', 'src/config.mjs', 'src/core/cdp.mjs', 'src/core/errors.mjs', 'src/is-main.mjs'];
  const sealedHashes = {};
  for (const path of imports) {
    await fs.mkdir(dirname(join(legacyRoot, path)), { recursive: true, mode: 0o700 });
    await fs.copyFile(join(project, path), join(legacyRoot, path));
    sealedHashes[path] = digest(await fs.readFile(join(legacyRoot, path)));
  }
  await fs.mkdir(join(legacyRoot, 'scripts'), { recursive: true, mode: 0o700 });
  await fs.writeFile(join(legacyRoot, 'scripts/smoke-design.mjs'), bytes);
  sealedHashes['scripts/smoke-design.mjs'] = digest(bytes);
  const genesis = structuredClone(context.approval);
  genesis.codeHashes = sealedHashes;
  const genesisBytes = Buffer.from(JSON.stringify(genesis));
  await fs.writeFile(context.approvalFile, genesisBytes);
  const ledger = JSON.parse(await fs.readFile(context.ledgerFile));
  ledger.approvalSha256 = digest(genesisBytes);
  await fs.writeFile(context.ledgerFile, JSON.stringify(ledger));
  await rotate(context);
  const legacy = await import(pathToFileURL(join(legacyRoot, 'scripts/smoke-design.mjs')).href);
  let calls = 0;
  await assert.rejects(legacy.runProbe({ live: true, phase: 'mutations', approvalFile: context.nextApprovalFile },
    { ...settings(), runners: { mutations: async () => { calls++; } } }), error => error.code === 'APPROVAL_INVALID');
  await assert.rejects(legacy.runProbe({ live: true, phase: 'mutations', approvalFile: context.approvalFile },
    { ...settings(scope), runners: { mutations: async () => { calls++; } } }), error => error.code === 'APPROVAL_INVALID');
  assert.equal(calls, 0);
});

class DiscoveryClient {
  constructor({ draft = '', foreground = false } = {}) {
    this.draft = draft;
    this.foreground = foreground;
    this.path = 'about:blank';
    this.calls = [];
    this.closed = false;
    this.context = null;
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params = {}) {
    for (const listener of this.listeners) listener({ method, sessionId: 'own-session', params });
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    switch (method) {
      case 'Target.createTarget': return { targetId: 'A'.repeat(32) };
      case 'Target.attachToTarget': return { sessionId: 'own-session' };
      case 'Page.enable': case 'Network.enable': return {};
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main-frame' } } };
      case 'Target.getTargetInfo': return { targetInfo: { targetId: 'A'.repeat(32), url: this.path === 'about:blank' ? this.path : `https://claude.ai${this.path}` } };
      case 'Page.createIsolatedWorld': return { executionContextId: 1 };
      case 'Page.navigate': {
        this.path = new URL(params.url).pathname;
        this.emit('Page.frameNavigated', { frame: { id: 'main-frame', loaderId: 'own-loader', url: params.url } });
        this.emit('Page.domContentEventFired');
        return { frameId: 'main-frame', loaderId: 'own-loader' };
      }
      case 'Runtime.callFunctionOn': {
        const buttons = [{ getAttribute: () => null, innerText: 'PRIVATE_TITLE_SENTINEL' },
          { getAttribute: () => null, innerText: 'Design System' }, { getAttribute: () => null, innerText: 'Design' }];
        const context = vm.createContext({ location: { href: this.path, origin: 'https://claude.ai', pathname: this.path },
          document: { visibilityState: this.foreground ? 'visible' : 'hidden', hasFocus: () => this.foreground,
            body: { childNodes: [] }, head: { childNodes: [] }, readyState: 'complete',
            querySelector: selector => selector.includes('chat-input') ? { innerText: this.draft } : null,
            querySelectorAll: () => buttons }, Date, setTimeout, Promise });
        const fn = vm.runInContext(`(${params.functionDeclaration})`, context);
        return { result: { value: await fn(...(params.arguments ?? []).map(argument => argument.value)) } };
      }
      default: throw Error('Unexpected method');
    }
  }

  close() { this.closed = true; }
}

test('discovery: bounded page inspection never reads full AX trees, list bodies or user text', async () => {
  const fake = new DiscoveryClient();
  let reads = 0;
  const result = await runDesignDiscovery({ perform: async (amount, action) => { reads += amount.reads; return action(); } },
    { connect: async () => fake });
  assert.deepEqual(result, { ...evidence, designSystemControl: true });
  assert.equal(reads, 6);
  assert.equal(fake.closed, true);
  assert.equal(fake.calls.some(call => call.method.includes('getResponseBody') || call.method.startsWith('Accessibility.')
    || call.method === 'Target.closeTarget' || call.method.startsWith('Input.')), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE_SENTINEL/);
});

test('discovery: path templates discard all identifiers and query or header values', async () => {
  const source = 'https://claude.ai/api/organizations/PRIVATE_ORG_SENTINEL/templates/PRIVATE_TEMPLATE_SENTINEL?token=PRIVATE_QUERY_SENTINEL';
  assert.equal(discoveryRoute(source), '/api/organizations/:segment/templates/:segment');
  assert.equal(discoveryRoute('https://example.invalid/api/templates'), null);
  const fake = new DiscoveryClient();
  const send = fake.send.bind(fake);
  fake.send = async (method, params) => {
    const result = await send(method, params);
    if (method === 'Page.navigate') {
      fake.emit('Network.requestWillBeSent', { requestId: 'request', frameId: 'main-frame',
        request: { method: 'GET', url: source, headers: { cookie: 'PRIVATE_HEADER_SENTINEL' } } });
      fake.emit('Network.responseReceived', { requestId: 'request', response: { url: source, mimeType: 'application/json',
        status: 200, encodedDataLength: 1200, body: 'PRIVATE_BODY_SENTINEL', headers: { 'set-cookie': 'PRIVATE_HEADER_SENTINEL' } } });
    }
    return result;
  };
  const result = await runDesignDiscovery({ perform: async (amount, action) => action() }, { connect: async () => fake });
  assert.equal(validDiscoveryRoutes(result.routes), true);
  assert.equal(result.routes.length, 2);
  assert.equal(result.routes[0].path, '/api/organizations/:segment/templates/:segment');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ORG|PRIVATE_TEMPLATE|PRIVATE_QUERY|PRIVATE_HEADER|PRIVATE_BODY/);
  assert.equal(fake.calls.some(call => call.method.includes('getResponseBody')), false);
});

test('discovery: request overflow is explicit without exposing additional values', async () => {
  const fake = new DiscoveryClient();
  const send = fake.send.bind(fake);
  fake.send = async (method, params) => {
    const result = await send(method, params);
    if (method === 'Page.navigate') {
      for (let index = 0; index < 260; index++) fake.emit('Network.requestWillBeSent', { requestId: `req-${index}`,
        frameId: 'main-frame', request: { method: 'GET', url: `https://claude.ai/api/templates/PRIVATE_${index}` } });
    }
    return result;
  };
  const result = await runDesignDiscovery({ perform: async (amount, action) => action() }, { connect: async () => fake });
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('discovery: existing drafts and foregrounded pages stop without input or cleanup', async () => {
  for (const options of [{ draft: 'PRIVATE_DRAFT_SENTINEL' }, { foreground: true }]) {
    const fake = new DiscoveryClient(options);
    await assert.rejects(runDesignDiscovery({ perform: async (amount, action) => action() }, { connect: async () => fake }), error => {
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error.details)}`, /PRIVATE_DRAFT_SENTINEL/);
      return true;
    });
    assert.equal(fake.calls.some(call => call.method.startsWith('Input.') || call.method === 'Target.closeTarget'), false);
  }
});

test('discovery: delayed navigation waits for its own loader and a same-document escape permanently invalidates it', async () => {
  const delayed = new DiscoveryClient();
  const original = delayed.send.bind(delayed);
  delayed.send = async (method, params) => {
    if (method !== 'Page.navigate') return original(method, params);
    delayed.calls.push({ method, params });
    delayed.path = new URL(params.url).pathname;
    setTimeout(() => {
      delayed.emit('Page.frameNavigated', { frame: { id: 'main-frame', loaderId: 'own-loader', url: params.url } });
      delayed.emit('Page.domContentEventFired');
    }, 5);
    return { frameId: 'main-frame', loaderId: 'own-loader' };
  };
  const report = await runDesignDiscovery({ perform: async (amount, action) => action() }, { connect: async () => delayed });
  assert.equal(report.targetRetained, true);
  const escaped = new DiscoveryClient();
  const send = escaped.send.bind(escaped);
  escaped.send = async (method, params) => {
    const result = await send(method, params);
    if (method === 'Page.navigate') {
      escaped.emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: 'https://claude.ai/chat/not-approved' });
      escaped.emit('Page.navigatedWithinDocument', { frameId: 'main-frame', url: params.url });
    }
    return result;
  };
  await assert.rejects(runDesignDiscovery({ perform: async (amount, action) => action() }, { connect: async () => escaped }),
    error => error.code === 'PROBE_FAILED');
  assert.equal(escaped.calls.filter(call => call.method === 'Page.navigate').length, 1);
});

test('discovery: an uncertain target receipt reports uncertainty without guessing or closing pages', async () => {
  const fake = new DiscoveryClient();
  const send = fake.send.bind(fake);
  fake.send = (method, params) => {
    if (method === 'Target.createTarget') throw Error('PRIVATE_RECEIPT_SENTINEL');
    return send(method, params);
  };
  await assert.rejects(runDesignDiscovery({ perform: async (amount, action) => action() }, { connect: async () => fake }), error => {
    assert.equal(error.code, 'TARGET_CREATION_UNCERTAIN');
    assert.equal(error.details.creationUncertain, true);
    assert.doesNotMatch(`${error.message}\n${JSON.stringify(error.details)}`, /PRIVATE_RECEIPT_SENTINEL/);
    return true;
  });
  assert.equal(fake.calls.some(call => call.method === 'Target.closeTarget'), false);
});
