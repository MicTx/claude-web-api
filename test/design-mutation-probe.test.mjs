import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { computeCodeHashes, runProbe } from '../scripts/smoke-design.mjs';
import { MUTATION_PROMPT, runDesignMutation } from '../scripts/design-probe-mutations.mjs';
import { cleanupTmpDirs, makeTmpDir } from './helpers.mjs';

after(cleanupTmpDirs);
const fixedNow = Date.parse('2026-11-07T00:00:00.000Z');
const codeHashes = await computeCodeHashes();
const project = join(import.meta.dirname, '..');
const scope = { branch: 'spec/2026-11-06_add-claude-design-integration', commit: 'a'.repeat(40), specSha256: 'b'.repeat(64) };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FRAME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHORT = 'SyntheticDesign01';
const VERSION = 'synthetic-ver-1';
const ASSISTANT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HUMAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROOT = '00000000-0000-4000-8000-000000000000';
const SOURCE = '<!DOCTYPE html>\n<html><body>设计 😀</body></html>\n';
const discovery = { kind: 'discovery-evidence', designControl: false, designSystemControl: false,
  draftEmpty: true, hidden: true, targetRetained: true, typeEvidence: 'unknown', routes: [], truncated: false };
const READ = { reads: 1, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0 };

async function fixture() {
  const parent = await fs.realpath(await makeTmpDir('ccw-mutation-'));
  const root = join(parent, 'evidence');
  await fs.mkdir(root, { mode: 0o700 });
  const approvalFile = join(parent, 'approval.json');
  const ledgerFile = join(root, 'ledger.json');
  const approval = { schema: 'ccw-design-probe-approval/3', approvalId: 'mutation_test_001', issuer: 'host-under-user-authorization',
    scopeSummary: 'Synthetic source; one design; at most two revisions; no uploads or sharing', taskPack: scope,
    codeHashes, evidenceRoot: root, sourceTarget: { organizationId: ORG, frameId: FRAME, shortId: 'SyntheticFrame01',
      version: 'v1', size: 625, sha256: 'd'.repeat(64) },
    phases: { source: 1, mutations: 1, 'versioned-files': 1, acceptance: 1, discovery: 1 },
    limits: { reads: 64, sessions: 1, messages: 3, downloads: 12, uploads: 0, shares: 0 },
    notBefore: '2026-11-06T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z' };
  const bytes = Buffer.from(JSON.stringify(approval));
  await fs.writeFile(approvalFile, bytes, { mode: 0o600 });
  await fs.writeFile(ledgerFile, JSON.stringify({ schema: 'ccw-design-probe-ledger/1', approvalId: approval.approvalId,
    approvalSha256: digest(bytes), entries: [] }), { mode: 0o600 });
  const context = { parent, root, approvalFile, ledgerFile, approval };
  await runProbe({ live: true, phase: 'discovery', approvalFile }, { getScope: async () => ({ ...scope }),
    getCodeHashes: async () => codeHashes, now: () => fixedNow,
    runners: { discovery: async ({ perform }) => { await perform(READ, async () => {}); return discovery; } } });
  return context;
}

function published(version = VERSION, sequence = 1, history = [VERSION]) {
  return { slug: FRAME, url: `https://claude.ai/artifact/${SHORT}`, version, seq: sequence, history, own_file_count: 1,
    title: 'CCW-DESIGN-PROBE', assetToken: 'TOKEN_SENTINEL', author: { email: 'PII_SENTINEL@example.invalid' } };
}

function blocks(source = SOURCE) {
  return [
    { type: 'tool_use', id: 'write_1', name: 'Write', input: { file_path: '/synthetic/index.html', content: source } },
    { type: 'tool_result', name: 'Write', tool_use_id: 'write_1', is_error: false, content: [{ type: 'text', text: 'ok' }] },
    { type: 'tool_use', id: 'publish_1', name: 'mcp__claude-artifacts__publish_files',
      input: { files: [{ path: '/synthetic/index.html', as: 'index.html' }], title: 'CCW-DESIGN-PROBE', icon: 'layout' } },
    { type: 'tool_result', name: 'mcp__claude-artifacts__publish_files', tool_use_id: 'publish_1', is_error: false,
      content: [{ type: 'text', text: JSON.stringify(published()) }] },
    { type: 'text', text: 'Done.' },
  ];
}

function conversation(prompt, { toolBlocks = blocks() } = {}) {
  return { uuid: 'dynamic', current_leaf_message_uuid: ASSISTANT, model: 'claude-opus-4-6', chat_messages: [
    { uuid: HUMAN, parent_message_uuid: ROOT, sender: 'human', content: [{ type: 'text', text: prompt }], attachments: [], files: [] },
    { uuid: ASSISTANT, parent_message_uuid: HUMAN, sender: 'assistant', content: toolBlocks, stop_reason: 'end_turn', truncated: false },
  ] };
}

function metadata() {
  return JSON.stringify({ ver: VERSION, seq: 1, history: [VERSION], fileCount: 1,
    files: [{ path: 'index.html', contentType: 'text/html', size: Buffer.byteLength(SOURCE), sha256: digest(SOURCE) }],
    viewer: { can_edit: true, token: 'TOKEN_SENTINEL' }, author: { email: 'PII_SENTINEL@example.invalid' }, assetToken: 'TOKEN_SENTINEL' });
}

class MutationClient {
  constructor({ root, failure = null, toolBlocks = blocks(), asset = true, publishMeta = metadata(),
    takeoverAtArtifact = false, finishStream = true, completionStatus = 200, conversationChange = null,
    duplicateCompletion = false, visibleAfterSubmit = false, focusAfterCompose = false, metadataEvents = events => events } = {}) {
    this.root = root;
    this.failure = failure;
    this.toolBlocks = toolBlocks;
    this.asset = asset;
    this.publishMeta = publishMeta;
    this.takeoverAtArtifact = takeoverAtArtifact;
    this.finishStream = finishStream;
    this.completionStatus = completionStatus;
    this.conversationChange = conversationChange;
    this.duplicateCompletion = duplicateCompletion;
    this.visibleAfterSubmit = visibleAfterSubmit;
    this.focusAfterCompose = focusAfterCompose;
    this.metadataEvents = metadataEvents;
    this.prompt = null;
    this.path = '/new';
    this.focus = false;
    this.calls = [];
    this.listeners = new Set();
    this.conversationId = null;
    this.submitted = 0;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(method, params = {}) { for (const listener of this.listeners) listener({ method, sessionId: 'own-session', params }); }

  async #reservation(key) {
    const ledger = JSON.parse(await fs.readFile(join(this.root, 'ledger.json'), 'utf8'));
    const last = ledger.entries.at(-1);
    assert.equal(last?.kind, 'effect', `${key} call must follow a durable effect reservation`);
    assert.ok(last.cost[key] > 0, `${key} call must be covered by a durable ${key} reservation`);
  }

  onNativeSubmit() {
    this.submitted++;
    void (async () => {
      await this.#reservation('messages');
      if (!this.finishStream) return;
      const url = `https://claude.ai/api/organizations/${ORG}/chat_conversations/${this.conversationId}/completion`;
      this.emit('Network.requestWillBeSent', { requestId: 'completion', frameId: 'main-frame',
        request: { method: 'POST', url } });
      if (this.duplicateCompletion) this.emit('Network.requestWillBeSent', { requestId: 'completion-duplicate',
        frameId: 'main-frame', request: { method: 'POST', url } });
      this.emit('Network.responseReceived', { requestId: 'completion', frameId: 'main-frame',
        response: { url, status: this.completionStatus, mimeType: 'text/event-stream' } });
      this.emit('Network.dataReceived', { requestId: 'completion', dataLength: 128 });
      this.emit('Network.loadingFinished', { requestId: 'completion' });
      if (this.visibleAfterSubmit) this.focus = true;
    })().catch(() => {});
  }

  #sandbox() {
    if (this.context) return this.context;
    const fake = this;
    const editor = {
      get innerText() { return fake.editorText ?? ''; },
      set innerText(value) { fake.editorText = value; },
      focus() { if (fake.focusAfterCompose) fake.documentFocused = true; },
    };
    const sendButton = { disabled: false, click() { fake.onNativeSubmit(); } };
    const fileInput = { files: [], multiple: true };
    const sandbox = {
      location: { origin: 'https://claude.ai', href: `https://claude.ai${fake.path}`, pathname: fake.path },
      document: {
        get visibilityState() { return fake.focus ? 'visible' : 'hidden'; },
        hasFocus: () => fake.focus || fake.documentFocused === true,
        readyState: 'complete',
        body: { childNodes: [] }, head: { childNodes: [] },
        querySelector: selector => selector.includes('chat-input-send') ? sendButton
          : selector.includes('chat-input') ? editor
          : selector.includes('input[type="file"]') ? fileInput : null,
        querySelectorAll: () => [],
        execCommand: (_command, _ui, value) => { fake.editorText = value; return true; },
      },
      Date, JSON, Math, Object, String, Number, Boolean, Array, Promise, RegExp, Error, TypeError,
      setTimeout, clearTimeout,
    };
    sandbox.globalThis = sandbox;
    this.context = vm.createContext(sandbox);
    return this.context;
  }

  async send(method, params = {}, options = {}) {
    this.calls.push({ method, params, sessionId: options.sessionId ?? null });
    if (this.failure === method) throw new Error('PRIVATE_SENTINEL');
    const key = this.#budgetKey(method, params);
    if (key) await this.#reservation(key);
    switch (method) {
      case 'Target.createTarget': return { targetId: 'A'.repeat(32) };
      case 'Target.attachToTarget': return { sessionId: 'own-session' };
      case 'Page.enable': case 'Network.enable': return {};
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'main-frame' } } };
      case 'Target.getTargetInfo': return { targetInfo: { targetId: 'A'.repeat(32), url: `https://claude.ai${this.path}` } };
      case 'Page.createIsolatedWorld': return { executionContextId: 2 };
      case 'Page.navigate': {
        this.path = new URL(params.url).pathname;
        const sandbox = this.#sandbox();
        sandbox.location.pathname = this.path;
        sandbox.location.href = params.url;
        if (this.asset && this.path.startsWith('/artifact/')) {
          const url = `https://claude.ai/api/frame/${FRAME}?org=${ORG}&vt=TOKEN_SENTINEL`;
          const events = [
            ['Network.requestWillBeSent', { requestId: 'meta', loaderId: 'loader', frameId: 'main-frame',
              request: { method: 'GET', url, headers: { cookie: 'TOKEN_SENTINEL' } } }],
            ['Network.responseReceived', { requestId: 'meta', loaderId: 'loader', frameId: 'main-frame',
              response: { url, status: 200, mimeType: 'application/json', headers: { 'set-cookie': 'TOKEN_SENTINEL' } } }],
            ['Network.dataReceived', { requestId: 'meta', dataLength: Buffer.byteLength(this.publishMeta) }],
            ['Network.loadingFinished', { requestId: 'meta' }],
          ];
          for (const [event, eventParams] of this.metadataEvents(events)) this.emit(event, eventParams);
        }
        return { frameId: 'main-frame', loaderId: 'loader' };
      }
      case 'Runtime.callFunctionOn': {
        const expected = params.arguments?.[0]?.value;
        if (this.takeoverAtArtifact && typeof expected === 'string' && expected.startsWith('/artifact/')) this.focus = true;
        const fn = vm.runInContext(`(${params.functionDeclaration})`, this.#sandbox());
        return { result: { value: await fn(...(params.arguments ?? []).map(argument => argument.value)) } };
      }
      case 'Runtime.evaluate': {
        if (params.expression.startsWith('JSON.stringify({o:location.origin')) {
          return { result: { value: JSON.stringify({ o: 'https://claude.ai', r: 'complete', p: this.path }) } };
        }
        if (params.expression.startsWith('(async function(args)')) {
          const args = JSON.parse(params.expression.slice(params.expression.lastIndexOf(')(') + 2, -1));
          if (args.path === '/api/organizations') {
            return { result: { value: { ok: true, status: 200, contentType: 'application/json',
              text: JSON.stringify([{ uuid: ORG, capabilities: ['chat'] }]) } } };
          }
          if (args.path.endsWith('/chat_conversations')) {
            const body = JSON.parse(args.body);
            if (this.failure === 'create') throw new Error('PRIVATE_SENTINEL');
            this.conversationId = body.uuid;
            const state = JSON.parse(await fs.readFile(join(this.root, 'mutation-state/sessions.json'), 'utf8'));
            assert.equal(state.sessions[0].pending.kind, 'create');
            return { result: { value: { ok: true, status: 201, contentType: 'application/json',
              text: JSON.stringify({ uuid: body.uuid, name: body.name }) } } };
          }
          if (args.path.includes('?tree=True')) {
            const conversationId = args.path.split('/chat_conversations/')[1].split('?')[0];
            const history = { ...conversation(this.editorText ?? MUTATION_PROMPT, { toolBlocks: this.toolBlocks }), uuid: conversationId };
            this.conversationChange?.(history);
            return { result: { value: { ok: true, status: 200, contentType: 'application/json',
              text: JSON.stringify(history) } } };
          }
          throw Error('Unexpected page fetch');
        }
        const value = await vm.runInContext(params.expression, this.#sandbox());
        return { result: { value } };
      }
      case 'Fetch.enable': case 'Fetch.disable': return {};
      case 'Network.getResponseBody': return this.asset ? { body: this.publishMeta, base64Encoded: false } : { body: '{}' };
      default: throw Error(`Unexpected method ${method}`);
    }
  }

  #budgetKey(method, params) {
    if (['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Network.enable', 'Page.getFrameTree',
      'Network.getResponseBody'].includes(method)) return 'reads';
    if (method === 'Page.navigate') return 'reads';
    if (method === 'Runtime.evaluate') {
      if (params.expression.startsWith('(async function(args)')) {
        const args = JSON.parse(params.expression.slice(params.expression.lastIndexOf(')(') + 2, -1));
        if (args.path === '/api/organizations') return 'reads';
        if (args.path.endsWith('/chat_conversations')) return 'sessions';
        if (args.path.includes('?tree=True')) return 'reads';
      }
      return null;
    }
    return null;
  }

  close() {}
}

async function runMutation(context, fake, options = {}) {
  return runProbe({ live: true, phase: 'mutations', approvalFile: context.approvalFile },
    { getScope: async () => ({ ...scope }), getCodeHashes: async () => codeHashes, now: () => fixedNow,
      runners: { mutations: runner => runDesignMutation(runner, { connect: async () => fake, ...options }) } });
}

async function ledgerOf(context) {
  return JSON.parse(await fs.readFile(context.ledgerFile, 'utf8'));
}

test('mutation: the runner never sends or parses the completion itself', async () => {
  const source = await fs.readFile(join(project, 'scripts/design-probe-mutations.mjs'), 'utf8');
  assert.doesNotMatch(source, /api\.complete\b/);
  assert.doesNotMatch(source, /consumeCompletion/);
  assert.doesNotMatch(source, /pattern:[^\n]*completion/);
  assert.match(source, /completionPath/);
});

test('mutation: every page navigation has its own durable read reservation', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root });
  await runMutation(context, fake);
  const navigations = fake.calls.filter(call => call.method === 'Page.navigate');
  assert.equal(navigations.length, 2);
  assert.match(navigations[0].params.url, /\/chat\//);
  assert.match(navigations[1].params.url, /\/artifact\//);
  const ledger = await ledgerOf(context);
  const reads = ledger.entries.filter(entry => entry.kind === 'effect' && entry.phase === 'mutations')
    .reduce((sum, entry) => sum + entry.cost.reads, 0);
  assert.equal(reads, 7);
});

test('mutation: probe closure never uses project state or externally modified files', async () => {
  const source = await fs.readFile(join(project, 'scripts/design-probe-mutations.mjs'), 'utf8');
  assert.match(source, /join\(context\.root, 'mutation-state'\)/);
  assert.doesNotMatch(source, /loadConfig\(\)\.stateDir|withClaudeTab/);
  const ui = await fs.readFile(join(project, 'src/core/ui.mjs'), 'utf8');
  assert.doesNotMatch(ui, /from '\.\/tab\.mjs'|from '\.\.\/session-store\.mjs'|from '\.\.\/bridge\.mjs'/);
  const { CODE_FILES } = await import('../scripts/smoke-design.mjs');
  assert.equal(CODE_FILES.includes('src/bridge.mjs'), false);
  assert.equal(CODE_FILES.includes('test/attachments.test.mjs'), false);
});

test('mutation: one native synthetic creation is budgeted exactly and classified without claiming Design', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root });
  const result = await runMutation(context, fake);
  assert.equal(result.phase, 'mutations');
  assert.equal(result.evidence.outcome, 'publication_unclassified');
  assert.equal(result.evidence.conversationCreated, true);
  assert.equal(result.evidence.messageSent, true);
  assert.equal(result.evidence.turnComplete, true);
  assert.deepEqual(result.evidence.toolNames, ['Write', 'mcp__claude-artifacts__publish_files']);
  assert.equal(result.evidence.artifact.metadataCaptured, true);
  assert.equal(result.evidence.artifact.manifestVerified, true);
  assert.equal(result.evidence.artifact.sourceClaimsMatch, null);
  assert.equal(result.evidence.artifact.sourceClaimsMatchedCount, 1);
  assert.equal(result.evidence.revisionStarted, false);
  assert.equal(result.evidence.targetRetained, true);
  assert.equal(result.evidence.stateSaved, true);
  assert.equal(fake.submitted, 1);
  assert.equal(fake.calls.some(call => call.method === 'Target.closeTarget' || call.method.startsWith('Input.')), false);
  const ledger = await ledgerOf(context);
  const effects = ledger.entries.filter(entry => entry.kind === 'effect' && entry.phase === 'mutations');
  assert.equal(effects.reduce((sum, entry) => sum + entry.cost.reads, 0), 7);
  assert.equal(effects.reduce((sum, entry) => sum + entry.cost.sessions, 0), 1);
  assert.equal(effects.reduce((sum, entry) => sum + entry.cost.messages, 0), 1);
  assert.equal(ledger.entries.at(-1).status, 'completed');
  assert.equal(result.evidence.resultSha256, digest(await fs.readFile(join(context.root, 'mutation-result.json'))));
  const state = await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8');
  assert.doesNotMatch(state, /设计|CCW-DESIGN-PROBE|TOKEN_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN_SENTINEL|PII_SENTINEL|SyntheticDesign01|bbbbbbbb|设计/);
  assert.doesNotMatch(await fs.readFile(context.ledgerFile, 'utf8'), /TOKEN_SENTINEL|PII_SENTINEL|SyntheticDesign01|设计/);
});

test('mutation: a text-only answer records no_artifact and never navigates to a frame', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, toolBlocks: [{ type: 'text', text: 'I need more details.' }] });
  const result = await runMutation(context, fake);
  assert.equal(result.evidence.outcome, 'no_artifact');
  assert.equal(result.evidence.artifact, null);
  assert.equal(fake.calls.filter(call => call.method === 'Page.navigate').length, 1);
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending, null);
});

test('mutation: an uncertain creation keeps durable create intent and never submits', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, failure: 'create' });
  await assert.rejects(runMutation(context, fake), error => error.code === 'PROBE_FAILED');
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending.kind, 'create');
  const ledger = await ledgerOf(context);
  assert.equal(ledger.entries.at(-1).status, 'failed');
  assert.equal(fake.submitted, 0);
});

test('mutation: an unfinished completion stream keeps durable send intent and never resends', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, finishStream: false });
  await assert.rejects(runMutation(context, fake, { completionTimeoutMs: 200 }), error => error.code === 'PROBE_FAILED');
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.equal(state.sessions[0].pending.promptSha256, digest(MUTATION_PROMPT));
  assert.equal(fake.submitted, 1);
  await assert.rejects(runMutation(context, new MutationClient({ root: context.root })), error => error.code === 'PHASE_UNRESOLVED');
});

test('mutation: a terminal HTTP error never clears pending or reads conversation history', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, completionStatus: 403 });
  await assert.rejects(runMutation(context, fake), error => error.code === 'PROBE_FAILED');
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.equal(fake.submitted, 1);
  assert.equal(fake.calls.some(call => call.method === 'Runtime.evaluate' && String(call.params.expression).includes('tree=True')), false);
});

test('mutation: duplicate matching completion requests remain ambiguous', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, duplicateCompletion: true });
  await assert.rejects(runMutation(context, fake), error => error.code === 'PROBE_FAILED');
  assert.equal(fake.submitted, 1);
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.equal(fake.calls.some(call => call.method === 'Runtime.evaluate' && String(call.params.expression).includes('tree=True')), false);
});

test('mutation: editor focus in a hidden owned page does not look like takeover', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, focusAfterCompose: true });
  const result = await runMutation(context, fake);
  assert.equal(result.evidence.outcome, 'publication_unclassified');
  assert.equal(fake.submitted, 1);
});

test('mutation: takeover after submit preserves pending and prevents later navigation', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, visibleAfterSubmit: true });
  await assert.rejects(runMutation(context, fake), error => error.code === 'UI_CONTEXT_LOST');
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.equal(fake.submitted, 1);
  assert.equal(fake.calls.filter(call => call.method === 'Page.navigate').length, 1);
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
});

test('mutation: mismatched or unfinished server history never clears pending', async () => {
  for (const conversationChange of [
    history => { history.chat_messages[0].content[0].text = 'OTHER_PROMPT_SENTINEL'; },
    history => { history.chat_messages[0].content[0].text = `PREFIX${MUTATION_PROMPT}`; },
    history => { history.chat_messages[0].content[0].text = `${MUTATION_PROMPT.slice(0, 8)}\u200b${MUTATION_PROMPT.slice(8)}`; },
    history => { history.chat_messages[1].stop_reason = null; },
    history => { delete history.chat_messages[1].stop_reason; },
    history => { history.chat_messages[1].stop_reason = 'tool_use'; },
    history => { history.chat_messages[1].stop_reason = 'not_a_terminal_reason'; },
    history => { history.chat_messages[1].content = []; },
    history => { history.chat_messages.pop(); history.current_leaf_message_uuid = HUMAN; },
    history => { history.chat_messages[0].attachments = [{ file_name: 'OTHER_ATTACHMENT_SENTINEL' }]; },
  ]) {
    const context = await fixture();
    const fake = new MutationClient({ root: context.root, conversationChange });
    await assert.rejects(runMutation(context, fake), error => error.code === 'TURN_UNVERIFIED');
    const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
    assert.equal(state.sessions[0].pending.kind, 'send');
    assert.equal(fake.submitted, 1);
    assert.equal(fake.calls.filter(call => call.method === 'Page.navigate').length, 1);
    assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
  }
});

test('mutation: competing human or assistant branches never clear pending', async () => {
  for (const conversationChange of [
    history => { history.chat_messages.push({ ...history.chat_messages[0], uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }); },
    history => { history.chat_messages.push({ ...history.chat_messages[1], uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }); },
  ]) {
    const context = await fixture();
    const fake = new MutationClient({ root: context.root, conversationChange });
    await assert.rejects(runMutation(context, fake), error => error.code === 'TURN_UNVERIFIED');
    const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
    assert.equal(state.sessions[0].pending.kind, 'send');
    assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
  }
});

test('mutation: a confirmed turn with unrecognized tool evidence clears pending without claiming a Design', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root,
    toolBlocks: [{ type: 'tool_use', id: 'unknown_1', name: 'UnknownTool', input: {} }, { type: 'text', text: 'Done.' }] });
  const result = await runMutation(context, fake);
  assert.equal(result.evidence.outcome, 'unverified_turn');
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending, null);
});

test('mutation: a confirmed truncated turn clears pending but remains incomplete', async () => {
  for (const stopReason of ['max_tokens', 'model_context_window_exceeded']) {
    const context = await fixture();
    const fake = new MutationClient({ root: context.root, toolBlocks: [{ type: 'text', text: 'Partial reply.' }],
      conversationChange: history => { history.chat_messages[1].stop_reason = stopReason; } });
    const result = await runMutation(context, fake);
    assert.equal(result.evidence.outcome, 'unverified_turn');
    assert.equal(result.evidence.turnComplete, false);
    const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
    assert.equal(state.sessions[0].pending, null);
    assert.equal(fake.submitted, 1);
  }
});

test('mutation: a legacy pending snapshot is read and blocks the runner without changing its bytes', async () => {
  const context = await fixture();
  const { SessionStore } = await import('../src/session-store.mjs');
  const stateDir = join(context.root, 'mutation-state');
  await fs.mkdir(stateDir, { mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify({ version: 1, lastSubmissionAt: 0, sessions: [{
    session: 'design-g1-probe', orgId: ORG, conversationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', parentMessageId: ROOT,
    model: null, createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z',
    pending: { kind: 'send', parentMessageId: ROOT, promptSha256: digest(MUTATION_PROMPT), startedAt: '2026-11-07T00:00:00.000Z' },
  }] }));
  const path = join(stateDir, 'sessions.json');
  await fs.writeFile(path, bytes, { mode: 0o600 });
  const state = await new SessionStore(stateDir).load();
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.deepEqual(await fs.readFile(path), bytes);
  const fake = new MutationClient({ root: context.root });
  await assert.rejects(runMutation(context, fake), error => error.code === 'PROBE_FAILED');
  assert.deepEqual(await fs.readFile(path), bytes);
  assert.equal(fake.submitted, 0);
  assert.equal(fake.calls.some(call => call.method === 'Runtime.evaluate'
    && call.params.expression.startsWith('(async function(args)')), false);
  const ledger = await ledgerOf(context);
  const effects = ledger.entries.filter(entry => entry.kind === 'effect' && entry.phase === 'mutations');
  assert.equal(effects.reduce((sum, entry) => sum + entry.cost.sessions + entry.cost.messages, 0), 0);
});

test('mutation: a foregrounded page stops before creating a conversation', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root });
  fake.focus = true;
  await assert.rejects(runMutation(context, fake), error => error.code === 'UI_CONTEXT_LOST');
  const ledger = await ledgerOf(context);
  const effects = ledger.entries.filter(entry => entry.phase === 'mutations' && entry.kind === 'effect');
  assert.equal(effects.reduce((sum, entry) => sum + entry.cost.sessions + entry.cost.messages, 0), 0);
  assert.equal(fake.submitted, 0);
});

test('mutation: manifest mismatch is recorded without failing the completed turn', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root,
    publishMeta: metadata().replace(digest(SOURCE), '0'.repeat(64)) });
  const result = await runMutation(context, fake);
  assert.equal(result.evidence.outcome, 'publication_unclassified');
  assert.equal(result.evidence.artifact.metadataCaptured, true);
  assert.equal(result.evidence.artifact.manifestVerified, true);
  assert.equal(result.evidence.artifact.sourceClaimsMatch, null);
  assert.equal(result.evidence.artifact.sourceClaimsMatchedCount, 0);
});

test('mutation: ambiguous metadata events preserve pending and never read the body', async () => {
  for (const metadataEvents of [
    events => { events[1][1].loaderId = 'other-loader'; return events; },
    events => { events[1][1].response.url += '&other=1'; return events; },
    events => { events[1][1].response.fromServiceWorker = true; return events; },
    events => { events[0][1].redirectResponse = {}; return events; },
    events => [events[0], events[1], events[1], ...events.slice(2)],
    events => [events[0], events[0], ...events.slice(1)],
  ]) {
    const context = await fixture();
    const fake = new MutationClient({ root: context.root, metadataEvents });
    await assert.rejects(runMutation(context, fake), error => error.code === 'UI_CONTEXT_LOST');
    const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
    assert.equal(state.sessions[0].pending.kind, 'send');
    assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
  }
});

test('mutation: takeover after frame navigation prevents credential-bearing metadata reads', async () => {
  const context = await fixture();
  const fake = new MutationClient({ root: context.root, takeoverAtArtifact: true });
  await assert.rejects(runMutation(context, fake), error => error.code === 'UI_CONTEXT_LOST');
  const state = JSON.parse(await fs.readFile(join(context.root, 'mutation-state/sessions.json'), 'utf8'));
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.equal(fake.calls.some(call => call.method === 'Network.getResponseBody'), false);
});
