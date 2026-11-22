import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { ClaudeBridge } from '../src/bridge.mjs';
import { SessionStore, validateState } from '../src/session-store.mjs';
import { BridgeError } from '../src/core/errors.mjs';
import { ROOT_PARENT } from '../src/core/claude-api.mjs';
import { makeTmpDir, ClaudeService, fakeWithTab } from './helpers.mjs';
import * as fx from './fixtures.mjs';
import { cleanupTmpDirs } from './helpers.mjs';
import { promises as realFs } from 'node:fs';
after(() => cleanupTmpDirs());

const baseConfig = (stateDir, extra = {}) => ({
  cdpUrl: 'http://127.0.0.1:9333', stateDir, orgId: null,
  timeoutMs: 10_000, idleTimeoutMs: 5_000, readyTimeoutMs: 5_000, minIntervalMs: 0,
  ...extra,
});

function makeBridge(stateDir, service, extra = {}) {
  const config = baseConfig(stateDir, extra);
  const store = new SessionStore(stateDir);
  return { bridge: new ClaudeBridge(config, { store, withTab: fakeWithTab(service) }), store, config };
}

async function readState(stateDir) {
  return JSON.parse(await fs.readFile(join(stateDir, 'sessions.json'), 'utf8'));
}

test('store: save/load roundtrip, perms, atomic result', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  const state = { version: 1, lastSubmissionAt: 5, sessions: [] };
  await store.save(state);
  const loaded = await store.load();
  assert.deepEqual(loaded, state);
  const st = await fs.stat(join(dir, 'sessions.json'));
  assert.equal(st.mode & 0o777, 0o600);
  const dst = await fs.stat(dir);
  assert.equal(dst.mode & 0o777, 0o700);
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

async function privateStateFixture(testContext, mode, { foreignOwner = false } = {}) {
  const dir = await makeTmpDir();
  const initial = { version: 1, lastSubmissionAt: 5, sessions: [] };
  const original = new SessionStore(dir);
  await original.save(initial);
  const file = original.file;
  await fs.chmod(file, mode);
  const before = await fs.stat(file);
  const bytes = await fs.readFile(file);
  const io = {
    ...fs,
    async lstat(path) {
      const stat = await fs.lstat(path);
      if (foreignOwner && path === file) stat.uid = process.getuid() + 1;
      return stat;
    },
    readFile: testContext.mock.fn(fs.readFile),
    open: testContext.mock.fn(fs.open),
    rename: testContext.mock.fn(fs.rename),
  };
  const store = new SessionStore(dir, { io });
  return {
    load: () => store.load(),
    save: () => store.save({ ...initial, lastSubmissionAt: 6 }),
    async assertUntouched() {
      for (const method of ['readFile', 'open', 'rename']) assert.equal(io[method].mock.callCount(), 0, method);
      const after = await fs.stat(file);
      assert.equal(after.mode, before.mode);
      assert.equal(after.ino, before.ino);
      assert.deepEqual(await fs.readFile(file), bytes);
      assert.deepEqual(await fs.readdir(dir), ['sessions.json']);
    },
  };
}

test('session-store-private: load rejects open modes', async (context) => {
  for (const mode of [0o644, 0o620]) {
    const fixture = await privateStateFixture(context, mode);
    await assert.rejects(fixture.load, { code: 'STATE_UNSAFE' });
    await fixture.assertUntouched();
  }
});

test('session-store-private: save preserves unsafe file', async (context) => {
  for (const mode of [0o644, 0o620]) {
    const fixture = await privateStateFixture(context, mode);
    await assert.rejects(fixture.save, { code: 'STATE_UNSAFE' });
    await fixture.assertUntouched();
  }
});

test('session-store-private: rejects foreign owner', { skip: typeof process.getuid !== 'function' }, async (context) => {
  const fixture = await privateStateFixture(context, 0o600, { foreignOwner: true });
  await assert.rejects(fixture.load, { code: 'STATE_UNSAFE' });
  await assert.rejects(fixture.save, { code: 'STATE_UNSAFE' });
  await fixture.assertUntouched();
});

test('session-store-private: private file roundtrips', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  const initial = { version: 1, lastSubmissionAt: 0, sessions: [] };
  assert.deepEqual(await store.load(), initial);
  assert.deepEqual(await fs.readdir(dir), []);
  for (const lastSubmissionAt of [1, 2]) {
    const state = { ...initial, lastSubmissionAt };
    await store.save(state);
    assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
    assert.deepEqual(await store.load(), state);
  }
});

test('store: corrupt state is rejected, never reset', async () => {
  const dir = await makeTmpDir();
  const file = join(dir, 'sessions.json');
  await fs.writeFile(file, '{oops', { mode: 0o600 });
  const store = new SessionStore(dir);
  await assert.rejects(() => store.load(), (e) => e.code === 'STATE_CORRUPT');
  await fs.writeFile(file, JSON.stringify({ version: 3, lastSubmissionAt: 0, sessions: [] }));
  await assert.rejects(() => store.load(), (e) => e.code === 'STATE_CORRUPT');
  await fs.writeFile(file, JSON.stringify({
    version: 1, lastSubmissionAt: 0,
    sessions: [{ session: 'x', orgId: 'bad', conversationId: fx.CONV_ID, parentMessageId: ROOT_PARENT, model: null, createdAt: 't', updatedAt: 't', pending: null }],
  }));
  await assert.rejects(() => store.load(), (e) => e.code === 'STATE_CORRUPT');
  // the file must be left untouched
  assert.ok((await fs.readFile(file, 'utf8')).includes('bad'));
});

test('store: symlinked sessions.json is refused', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  const target = join(dir, 'elsewhere.json');
  await fs.writeFile(target, '{}');
  await fs.symlink(target, join(dir, 'sessions.json'));
  await assert.rejects(() => store.load(), (e) => e.code === 'STATE_UNSAFE');
  await assert.rejects(() => store.save({ version: 1, lastSubmissionAt: 0, sessions: [] }), (e) => e.code === 'STATE_UNSAFE');
});

test('store: withLock is exclusive and releases on settle', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  let acquired = false;
  let innerDone = false;
  const first = store.withLock(async () => {
    acquired = true;
    await assert.rejects(() => store.withLock(async () => {}), (e) => e.code === 'BUSY');
    innerDone = true;
    return 'first';
  });
  while (!acquired) await new Promise(resolve => setImmediate(resolve));
  const second = store.withLock(async () => 'second');
  assert.equal(await first, 'first');
  assert.equal(innerDone, true);
  assert.equal(await second, 'second');
  assert.ok(!(await fs.readdir(dir)).includes('ccw.lock'));
});

test('store: lock competition from an independent process, dead-pid unlock', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { hostname } from 'node:os';
    fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(join(dir, 'ccw.lock'))}, JSON.stringify({ pid: process.pid, hostname: hostname(), token: 't' }), { flag: 'wx', mode: 0o600 });
    console.log('locked');
    setTimeout(() => {}, 60000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      setTimeout(() => reject(new Error('child did not lock')), 5000);
    });
    await assert.rejects(() => store.withLock(async () => {}), (e) => e.code === 'BUSY');
    await assert.rejects(() => store.unlockDeadOwner(), (e) => e.code === 'LOCK_HELD');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    assert.equal(await store.unlockDeadOwner(), true);
    await store.withLock(async () => 'acquired after unlock');
  } finally {
    child.kill('SIGKILL');
  }
});

test('store: malformed/foreign lock files are never removed', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  const lock = join(dir, 'ccw.lock');

  assert.equal(await store.unlockDeadOwner(), false); // no lock -> false, not error

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(lock, 'garbage');
  await assert.rejects(() => store.unlockDeadOwner(), (e) => e.code === 'LOCK_INVALID');
  assert.ok((await fs.readdir(dir)).includes('ccw.lock'));

  await fs.writeFile(lock, JSON.stringify({ pid: 1, hostname: 'other-host', token: 'x' }));
  await assert.rejects(() => store.unlockDeadOwner(), (e) => e.code === 'LOCK_FOREIGN');
  assert.ok((await fs.readdir(dir)).includes('ccw.lock'));
});

// ---------- bridge flows --------------------------------------------------

test('bridge: ask creates session, persists ids, returns reply and url', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ replyText: 'first answer' });
  const { bridge } = makeBridge(dir, service);
  const r = await bridge.ask({ session: 'topic', prompt: 'hello claude' });
  assert.equal(r.ok, true);
  assert.equal(r.reply, 'first answer');
  assert.equal(r.model, 'claude-opus-5-9');
  assert.ok(r.url.endsWith(r.conversationId));
  const state = await readState(dir);
  assert.equal(state.sessions.length, 1);
  const entry = state.sessions[0];
  assert.equal(entry.parentMessageId, r.assistantMessageId);
  assert.equal(entry.pending, null);
  assert.ok(state.lastSubmissionAt > 0);
  // create POST carried the client uuid and default title
  const createReq = service.posts('chat_conversations')[0];
  assert.equal(createReq.body.uuid, r.conversationId);
  assert.equal(createReq.body.name, '[ccw] topic');
  // completion POST used the documented body shape
  const send = service.posts('/completion')[0];
  assert.equal(send.body.parent_message_uuid, ROOT_PARENT);
  assert.equal(send.body.timezone, 'Asia/Tokyo');
  assert.equal(send.body.locale, 'zh-Hant');
});

test('bridge: token-limited SSE replies expose completion status in history and follow-up', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const original = service.handle.bind(service);
  let first = true;
  service.handle = async request => {
    const result = await original(request);
    if (first && request.path.endsWith('/completion')) {
      first = false;
      result.body = result.body.replace('"end_turn"', '"max_tokens"');
      [...service.convs.values()][0].chat_messages.at(-1).stop_reason = 'max_tokens';
    }
    return result;
  };
  const { bridge } = makeBridge(dir, service);
  const firstResult = await bridge.ask({ session: 'partial', prompt: 'first' });
  assert.equal(firstResult.complete, false);
  assert.equal((await bridge.transcript({ session: 'partial' })).messages.at(-1).complete, false);
  assert.equal((await bridge.followUp({ session: 'partial', prompt: 'continue' })).previousComplete, false);
});

test('bridge: ask rejects duplicate alias and invalid inputs before any request', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  await bridge.ask({ session: 'taken', prompt: 'x' });
  const before = service.requests.length;
  await assert.rejects(() => bridge.ask({ session: 'taken', prompt: 'again' }), (e) => e.code === 'SESSION_EXISTS');
  for (const bad of ['', '   ', null]) {
    await assert.rejects(() => bridge.ask({ session: 'new', prompt: bad }), (e) => e.code === 'INVALID_ARGUMENT');
  }
  await assert.rejects(() => bridge.ask({ session: 'new', prompt: 'x'.repeat(70 * 1024) }), (e) => e.code === 'INVALID_ARGUMENT');
  for (const alias of ['../escape', '.hidden', 'a/b', 'a'.repeat(65), 'with space']) {
    await assert.rejects(() => bridge.ask({ session: alias, prompt: 'x' }), (e) => e.code === 'INVALID_ARGUMENT', alias);
  }
  assert.equal(service.requests.length, before);
});

test('bridge: followUp parents to current server leaf, ignores stale local leaf', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  const r1 = await bridge.ask({ session: 's', prompt: 'one' });
  // a foreign writer advances the server conversation beyond our stored leaf
  const conv = service.convs.get(r1.conversationId);
  const foreign = service.commitTurn(conv, 'foreign', r1.assistantMessageId, 'foreign reply');
  const r2 = await bridge.followUp({ session: 's', prompt: 'two' });
  const send = service.posts('/completion').at(-1);
  assert.equal(send.body.parent_message_uuid, foreign.uuid);
  assert.equal(r2.ok, true);
  const state = await readState(dir);
  assert.equal(state.sessions[0].parentMessageId, r2.assistantMessageId);
});

test('bridge: followUp keeps legacy and dated snapshot models pinned', async () => {
  const cases = [
    { entryModel: null, conversationModel: 'claude-opus-5-10-20261101' },
    { entryModel: 'legacy-provider-model', conversationModel: 'legacy-provider-model' },
    { entryModel: 'claude-opus-5-10', conversationModel: 'claude-opus-5-10-20261101' },
  ];
  for (const { entryModel, conversationModel } of cases) {
    const dir = await makeTmpDir();
    const service = new ClaudeService({ model: conversationModel });
    const { bridge } = makeBridge(dir, service);
    const store = new SessionStore(dir);
    const conversation = service.addConversation({ uuid: fx.CONV_ID, model: conversationModel });
    const now = new Date().toISOString();
    await store.save({
      version: 1,
      lastSubmissionAt: 0,
      sessions: [{
        session: 'legacy', orgId: fx.ORGS[0].uuid, conversationId: conversation.uuid,
        parentMessageId: ROOT_PARENT, model: entryModel, createdAt: now, updatedAt: now, pending: null,
      }],
    });
    const result = await bridge.followUp({ session: 'legacy', prompt: 'continue' });
    assert.equal(result.model, conversationModel);
    const state = await readState(dir);
    assert.equal(state.sessions[0].model, entryModel ?? conversationModel);
  }
});

test('bridge: followUp rejects a drifted pinned model', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  const created = await bridge.ask({ session: 's', prompt: 'one' });
  service.convs.get(created.conversationId).model = 'claude-sonnet-9';
  await assert.rejects(() => bridge.followUp({ session: 's', prompt: 'two' }), (e) => e.code === 'MODEL_MISMATCH');
});

test('bridge: followUp refuses when server leaf is not a completed assistant', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  const r1 = await bridge.ask({ session: 's', prompt: 'one' });
  const conv = service.convs.get(r1.conversationId);
  conv.chat_messages.push({
    uuid: service.uuid(), parent_message_uuid: r1.assistantMessageId,
    sender: 'human', content: [{ type: 'text', text: 'hijack' }],
  });
  conv.current_leaf_message_uuid = conv.chat_messages.at(-1).uuid;
  const before = service.posts('/completion').length;
  await assert.rejects(() => bridge.followUp({ session: 's', prompt: 'two' }), (e) => e.code === 'REMOTE_IN_PROGRESS');
  assert.equal(service.posts('/completion').length, before);

  // truncated assistant leaf is also refused
  conv.chat_messages.push({
    uuid: service.uuid(), parent_message_uuid: conv.current_leaf_message_uuid,
    sender: 'assistant', stop_reason: 'max_tokens', truncated: true,
    content: [{ type: 'text', text: 'cut off' }],
  });
  conv.current_leaf_message_uuid = conv.chat_messages.at(-1).uuid;
  await assert.rejects(() => bridge.followUp({ session: 's', prompt: 'two' }), (e) => e.code === 'REMOTE_IN_PROGRESS');
});

test('bridge: failed send leaves pending marker and never duplicates the POST', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'drop'; // completion POST -> HTTP 500
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'risky' }), (e) => e.code === 'SERVICE_UNAVAILABLE');
  const state = await readState(dir);
  const entry = state.sessions[0];
  assert.equal(entry.pending.kind, 'send');
  assert.equal(entry.pending.parentMessageId, ROOT_PARENT);
  const posts = service.posts('/completion').length;
  await assert.rejects(() => bridge.followUp({ session: 's', prompt: 'retry?' }), (e) => e.code === 'PENDING_TURN');
  assert.equal(service.posts('/completion').length, posts); // no resend
});

test('bridge: recover reconciles a send the server actually completed', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ replyText: 'committed reply' });
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'afterCommit'; // server records the turn, stream dies mid-flight
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'did it land?' }), (e) => e.code === 'STREAM_INCOMPLETE');
  const mid = await bridge.transcript({ session: 's' });
  assert.equal(mid.pending.kind, 'send');
  const t = await bridge.transcript({ session: 's', recover: true });
  assert.equal(t.recovered, true);
  assert.equal(t.pending, null);
  const lastAssistant = t.messages.at(-1);
  assert.equal(lastAssistant.sender, 'assistant');
  assert.equal(lastAssistant.text, 'committed reply');
  const state = await readState(dir);
  assert.equal(state.sessions[0].parentMessageId, lastAssistant.uuid);
  // now a normal follow-up works off the recovered leaf
  const r = await bridge.followUp({ session: 's', prompt: 'next' });
  assert.equal(r.ok, true);
});

test('bridge: recover reconciles a canceled REST turn with an empty assistant', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ replyText: 'partial text' });
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'afterCommit';
  await assert.rejects(() => bridge.ask({ session: 'canceled-rest', prompt: 'sent but stopped' }), { code: 'STREAM_INCOMPLETE' });
  const assistant = [...service.convs.values()][0].chat_messages.at(-1);
  assistant.stop_reason = 'user_canceled';
  assistant.content = [];
  const recovered = await bridge.transcript({ session: 'canceled-rest', recover: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.pending, null);
  assert.equal(recovered.messages.at(-1).stopReason, 'user_canceled');
  assert.equal(recovered.messages.at(-1).complete, false);
  assert.equal((await readState(dir)).sessions[0].parentMessageId, assistant.uuid);
  const followUp = await bridge.followUp({ session: 'canceled-rest', prompt: 'next question' });
  assert.equal(followUp.ok, true);
  assert.equal(followUp.previousComplete, false);
});

test('bridge: recover recognizes a terminal partial answer without repeating the send', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ replyText: 'partial answer' });
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'afterCommit';
  await assert.rejects(() => bridge.ask({ session: 'partial-recovery', prompt: 'question' }), { code: 'STREAM_INCOMPLETE' });
  const assistant = [...service.convs.values()][0].chat_messages.at(-1);
  assistant.stop_reason = 'max_tokens';
  assistant.truncated = true;
  const recovered = await bridge.transcript({ session: 'partial-recovery', recover: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.pending, null);
  assert.equal(recovered.messages.at(-1).complete, false);
  assert.equal(service.posts('/completion').length, 1);
  const continued = await bridge.followUp({ session: 'partial-recovery', prompt: 'continue' });
  assert.equal(continued.previousComplete, false);
  assert.equal(service.posts('/completion').length, 2);
});

test('bridge: REST recovery still requires actual text for a terminal response', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'afterCommit';
  await assert.rejects(() => bridge.ask({ session: 'empty-rest', prompt: 'question' }), { code: 'STREAM_INCOMPLETE' });
  const assistant = [...service.convs.values()][0].chat_messages.at(-1);
  assistant.content = [structuredClone(fx.OBSERVED_FILE_DELIVERIES)];
  const view = await bridge.transcript({ session: 'empty-rest', recover: true });
  assert.equal(view.recovered, false);
  assert.equal(view.pending.kind, 'send');
  assert.equal(service.posts('/completion').length, 1);
});

test('bridge: recover keeps pending when server history cannot prove the turn', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  // fail without committing: server never saw the prompt
  service.failNext = 'drop';
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'lost send' }), (e) => e.code === 'SERVICE_UNAVAILABLE');
  const t = await bridge.transcript({ session: 's', recover: true });
  assert.equal(t.recovered, false);
  assert.equal(t.pending.kind, 'send');
  // still no resend
  await assert.rejects(() => bridge.followUp({ session: 's', prompt: 'x' }), (e) => e.code === 'PENDING_TURN');
  assert.equal(service.posts('/completion').length, 1);
});

test('bridge: recover requires the matching prompt hash, not just any suffix', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'drop';
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'original prompt' }), (e) => e.code === 'SERVICE_UNAVAILABLE');
  const state = await readState(dir);
  const entry = state.sessions[0];
  // someone else committed a different turn at the same parent server-side
  const conv = service.convs.get(entry.conversationId);
  conv.current_leaf_message_uuid = ROOT_PARENT;
  service.commitTurn(conv, 'a different prompt', ROOT_PARENT, 'different reply');
  const t = await bridge.transcript({ session: 's', recover: true });
  assert.equal(t.recovered, false);
  assert.equal(t.pending.kind, 'send');
});

test('bridge: pending create recovery only clears when the conversation exists and is empty', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  service.failNextCreate = 'drop'; // create POST -> 500 before conversation exists
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'x' }), (e) => e.code === 'SERVICE_UNAVAILABLE');
  let state = await readState(dir);
  assert.equal(state.sessions[0].pending.kind, 'create');
  // transcript hits a missing conversation -> NOT_FOUND, pending untouched
  await assert.rejects(() => bridge.transcript({ session: 's' }), (e) => e.code === 'NOT_FOUND');
  // now the conversation shows up empty (e.g. create had actually landed)
  const entry = state.sessions[0];
  service.addConversation({ uuid: entry.conversationId });
  const t = await bridge.transcript({ session: 's', recover: true });
  assert.equal(t.recovered, true);
  assert.equal(t.pending, null);
  // follow-up may now send the first turn at the root parent
  const r = await bridge.followUp({ session: 's', prompt: 'real first turn' });
  assert.equal(r.ok, true);
  const send = service.posts('/completion').at(-1);
  assert.equal(send.body.parent_message_uuid, ROOT_PARENT);
});

test('bridge: pending create stays when the server conversation is not empty', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  service.failNextCreate = 'drop';
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'x' }), (e) => e.code === 'SERVICE_UNAVAILABLE');
  const entry = (await readState(dir)).sessions[0];
  const conv = service.addConversation({ uuid: entry.conversationId });
  service.commitTurn(conv, 'unrelated', ROOT_PARENT, 'unrelated reply');
  const t = await bridge.transcript({ session: 's', recover: true });
  assert.equal(t.recovered, false);
  assert.equal(t.pending.kind, 'create');
});

test('bridge: sessions and transcript shapes', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ replyText: 'answer' });
  const { bridge } = makeBridge(dir, service);
  await bridge.ask({ session: 's', prompt: 'q' });
  const list = await bridge.sessions();
  assert.equal(list.ok, true);
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].session, 's');
  assert.equal(list.sessions[0].pending, null);
  const t = await bridge.transcript({ session: 's' });
  assert.equal(t.recovered, false);
  assert.deepEqual(t.messages.map((m) => m.sender), ['human', 'assistant']);
  assert.equal(t.messages[1].text, 'answer');
  assert.equal(t.messages[1].stopReason, 'end_turn');
  assert.equal(t.currentLeafMessageId, t.messages.at(-1).uuid);
  await assert.rejects(() => bridge.transcript({ session: 'ghost' }), (e) => e.code === 'SESSION_NOT_FOUND');
});

test('bridge: unlock reports boolean', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  assert.deepEqual(await bridge.unlock(), { ok: true, unlocked: false });
});

test('bridge: doctor does a read-only org request', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ orgs: fx.ORGS_DUAL });
  const { bridge } = makeBridge(dir, service);
  const d = await bridge.doctor({});
  assert.equal(d.ok, true);
  assert.equal(d.authenticated, true);
  assert.equal(d.orgId, fx.ORG_ID);
  assert.equal(d.protocol, 'rest-sse');
  assert.deepEqual(d.attachments, {
    configured: false,
    source: null,
    configFile: null,
    environmentVariable: 'CCW_ATTACHMENT_ROOT',
    supported: true,
  });
  assert.ok(d.browser);
  assert.deepEqual(service.posts('/completion'), []);
});

test('bridge: min interval spaces out submissions', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service, { minIntervalMs: 120 });
  await bridge.ask({ session: 's', prompt: 'one' });
  const start = Date.now();
  await bridge.followUp({ session: 's', prompt: 'two' });
  assert.ok(Date.now() - start >= 60, 'follow-up waited for the min interval');
});

test('bridge: min interval survives a slow pre-send checkpoint', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge, store } = makeBridge(dir, service, { minIntervalMs: 120 });
  const times = [];
  const handle = service.handle.bind(service);
  service.handle = request => {
    if (request.path.endsWith('/completion')) times.push(Date.now());
    return handle(request);
  };
  const save = store.save.bind(store);
  let delayed = false;
  store.save = async state => {
    if (!delayed && state.sessions[0]?.pending?.kind === 'send') {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 160));
    }
    return save(state);
  };
  await bridge.ask({ session: 'slow', prompt: 'one' });
  await bridge.followUp({ session: 'slow', prompt: 'two' });
  assert.ok(times[1] - times[0] >= 120, 'actual sends, not checkpoint starts, must be spaced');
});

test('bridge: independent bridge instance resumes persisted sessions', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const first = makeBridge(dir, service);
  await first.bridge.ask({ session: 'shared', prompt: 'one' });
  // a completely new bridge object over the same state dir follows up
  const second = makeBridge(dir, service);
  const r = await second.bridge.followUp({ session: 'shared', prompt: 'two' });
  assert.equal(r.ok, true);
  const send = service.posts('/completion').at(-1);
  assert.notEqual(send.body.parent_message_uuid, ROOT_PARENT);
});

test('bridge: independent aliases run concurrently and persist isolated turns', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService({ replyText: 'Claude reply text' });
  let releaseSlow;
  let slowStarted = false;
  const original = service.handle.bind(service);
  service.handle = async request => {
    const result = await original(request);
    if (request.path.endsWith('/completion') && request.body?.prompt === 'slow turn') {
      slowStarted = true;
      await new Promise(resolve => { releaseSlow = resolve; });
    }
    return result;
  };
  const { bridge } = makeBridge(dir, service);
  const slow = bridge.ask({ session: 'slow-alias', prompt: 'slow turn' });
  while (!slowStarted) await new Promise(resolve => setImmediate(resolve));
  const fast = await bridge.ask({ session: 'fast-alias', prompt: 'fast turn' });
  releaseSlow();
  assert.equal((await slow).reply, 'Claude reply text');
  assert.equal(fast.reply, 'Claude reply text');
  const state = await readState(dir);
  assert.deepEqual(new Set(state.sessions.map(entry => entry.session)), new Set(['slow-alias', 'fast-alias']));
  assert.ok(state.sessions.every(entry => entry.pending === null));
  const slowConversation = service.convs.get(state.sessions.find(entry => entry.session === 'slow-alias').conversationId);
  const fastConversation = service.convs.get(state.sessions.find(entry => entry.session === 'fast-alias').conversationId);
  assert.equal(slowConversation.chat_messages.at(-2).content[0].text, 'slow turn');
  assert.equal(fastConversation.chat_messages.at(-2).content[0].text, 'fast turn');
});

test('store: io write failure leaves original state and no temp/lock', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  await store.save({ version: 1, lastSubmissionAt: 1, sessions: [] });
  const before = await fs.readFile(join(dir, 'sessions.json'), 'utf8');
  const io = { ...realFs, rename: async () => { const e = new Error('io fail'); e.code = 'EIO'; throw e; } };
  const broken = new SessionStore(dir, { io });
  await assert.rejects(() => broken.save({ version: 1, lastSubmissionAt: 2, sessions: [] }), (e) => e.code === 'EIO');
  assert.equal(await fs.readFile(join(dir, 'sessions.json'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
});

test('store: lock owner write failure removes its own lock', async () => {
  const dir = await makeTmpDir();
  const io = { ...realFs, open: async (...a) => { const h = await realFs.open(...a); return { ...h, writeFile: async () => { throw new Error('disk full'); }, close: h.close.bind(h), sync: h.sync?.bind(h) }; } };
  const store = new SessionStore(dir, { io });
  await assert.rejects(() => store.withLock(async () => {}), (e) => e.message === 'disk full');
  assert.ok(!(await fs.readdir(dir)).includes('ccw.lock'));
});

test('store: malformed pid values rejected, no stale stealing', async () => {
  const dir = await makeTmpDir();
  const store = new SessionStore(dir);
  for (const pid of [0, -1, 1.5, 'abc']) {
    await fs.writeFile(join(dir, 'ccw.lock'), JSON.stringify({ pid, hostname: hostname(), token: 't' }));
    await assert.rejects(() => store.unlockDeadOwner(), (e) => e.code === 'LOCK_INVALID', String(pid));
    assert.ok((await fs.readdir(dir)).includes('ccw.lock'));
  }
});

test('bridge: failed send error carries pending metadata', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  service.failNext = 'drop';
  await assert.rejects(() => bridge.ask({ session: 's', prompt: 'risky' }), (e) => {
    assert.equal(e.code, 'SERVICE_UNAVAILABLE');
    assert.equal(e.details.session, 's');
    assert.equal(e.details.pending, true);
    assert.ok(e.details.conversationId);
    return true;
  });
});

test('bridge: malformed conversation response cannot become a root send', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  await bridge.ask({ session: 's', prompt: 'one' });
  const conv = [...service.convs.values()][0];
  delete conv.chat_messages; // server drops required field
  const before = service.posts('/completion').length;
  await assert.rejects(() => bridge.followUp({ session: 's', prompt: 'two' }), (e) => e.code === 'API_CONTRACT');
  assert.equal(service.posts('/completion').length, before);
});

test('bridge: final-save failure keeps durable pending + recovery metadata', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const { bridge } = makeBridge(dir, service);
  await bridge.ask({ session: 's', prompt: 'one' });
  // break rename only for the follow-up save
  const io = { ...realFs };
  const realRename = io.rename;
  let renames = 0;
  io.rename = async (a, b) => {
    if (String(b).endsWith('sessions.json')) {
      renames += 1;
      if (renames === 2) { const e = new Error('io'); e.code = 'EIO'; throw e; } // final clear only; pending write lands first
    }
    return realRename(a, b);
  };
  const { bridge: b2 } = makeBridge(dir, service);
  b2.store = new SessionStore(dir, { io });
  await assert.rejects(() => b2.followUp({ session: 's', prompt: 'two' }), (e) => {
    assert.equal(e.details.pending, true);
    assert.equal(e.details.session, 's');
    return true;
  });
  const disk = JSON.parse(await fs.readFile(join(dir, 'sessions.json'), 'utf8'));
  assert.equal(disk.sessions[0].pending.kind, 'send');
  const recovered = await b2.transcript({ session: 's', recover: true });
  assert.equal(recovered.pending, null);
  assert.equal(service.posts('/completion').length, 2);
});

test('bridge: create-clear save failure preserves recoverable creation without sending', async () => {
  const dir = await makeTmpDir();
  const service = new ClaudeService();
  const io = { ...realFs };
  let saves = 0;
  io.rename = async (source, destination) => {
    if (String(destination).endsWith('sessions.json') && ++saves === 2) {
      const error = new Error('Injected state write failure');
      error.code = 'EIO';
      throw error;
    }
    return realFs.rename(source, destination);
  };
  const { bridge } = makeBridge(dir, service);
  bridge.store = new SessionStore(dir, { io });
  await assert.rejects(() => bridge.ask({ session: 'create-failed', prompt: 'first' }), (error) => {
    assert.equal(error.details.session, 'create-failed');
    assert.equal(error.details.pending, true);
    assert.ok(service.convs.has(error.details.conversationId));
    return true;
  });
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'create');
  assert.equal(service.posts('/completion').length, 0);
  const recovered = await bridge.transcript({ session: 'create-failed', recover: true });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.pending, null);
  assert.equal(service.posts('/completion').length, 0);
});
