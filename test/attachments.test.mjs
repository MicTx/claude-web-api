import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeTmpDir, cleanupTmpDirs, FakeCdpServer, ClaudeService, fetchHandlerFor, hangingStream } from './helpers.mjs';
import { SAMPLE_PNG, SAMPLE_PDF, SAMPLE_CODE, OBSERVED_FILE_DELIVERIES, OBSERVED_HUMAN_ATTACHMENTS, OBSERVED_FRAME_PUBLICATION, SYNTHETIC_FRAME_PAGE, observedFrameChain, CONV_ID } from './fixtures.mjs';
import { loadConfig } from '../src/config.mjs';
import { ClaudeBridge } from '../src/bridge.mjs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT } from '../src/tool-contracts.mjs';

after(cleanupTmpDirs);

async function samples() {
  const root = await makeTmpDir('ccw-files-');
  const files = [['sample.png', SAMPLE_PNG], ['sample.pdf', SAMPLE_PDF], ['sample.js', SAMPLE_CODE]];
  for (const [name, data] of files) await fs.writeFile(join(root, name), data);
  const paths = files.map(([name]) => join(root, name));
  // PDF is deliberately not uploadable; it stays on disk to prove it is refused
  return { root, files, paths, uploadPaths: [paths[0], paths[2]] };
}

test('attachments: file policy snapshots only explicitly authorized files', async () => {
  const { prepareAttachments } = await import('../src/attachments.mjs');
  const { root, uploadPaths } = await samples();
  const expected = [['sample.png', SAMPLE_PNG], ['sample.js', SAMPLE_CODE]];
  const opened = [];
  const io = { ...fs, open: (...args) => { opened.push(args[0]); return fs.open(...args); } };
  const prepared = await prepareAttachments(uploadPaths, { attachmentRoot: root }, { io });
  assert.equal(opened.length, 2);
  assert.equal(prepared.length, 2);
  prepared.forEach((file, i) => {
    assert.deepEqual(file.bytes, expected[i][1]);
    assert.equal(file.sha256, createHash('sha256').update(expected[i][1]).digest('hex'));
    assert.equal(file.name, expected[i][0]);
    assert.equal(Object.hasOwn(file, 'path'), false);
  });
  await assert.rejects(prepareAttachments(uploadPaths, {}), { code: 'ATTACHMENT_SCOPE' });
  assert.deepEqual(await prepareAttachments(undefined, {}), []);
});

test('attachments: file policy refuses scope escape, links and duplicate selection', async () => {
  const { prepareAttachments } = await import('../src/attachments.mjs');
  const { root, paths } = await samples();
  const outside = await makeTmpDir('ccw-outside-');
  await fs.writeFile(join(outside, 'other.js'), SAMPLE_CODE);
  await fs.symlink(outside, join(root, 'escape'));
  await fs.symlink(paths[2], join(root, 'link.js'));
  await fs.link(paths[2], join(root, 'hard.js'));
  const cfg = { attachmentRoot: root };
  await assert.rejects(prepareAttachments([join(outside, 'other.js')], cfg), { code: 'ATTACHMENT_SCOPE' });
  for (const name of ['link.js', 'hard.js', 'escape/other.js']) {
    await assert.rejects(prepareAttachments([join(root, name)], cfg), { code: 'FILE_UNSAFE' });
  }
  await assert.rejects(prepareAttachments([paths[0], paths[0]], cfg), { code: 'INVALID_ARGUMENT' });
});

test('attachments: repository guard never expands directories, archives or imports', async () => {
  const { prepareAttachments } = await import('../src/attachments.mjs');
  const { root } = await samples();
  const cfg = { attachmentRoot: root };
  await fs.mkdir(join(root, '.git'));
  await fs.writeFile(join(root, '.git', 'config'), 'synthetic');
  await fs.writeFile(join(root, 'repo.zip'), Buffer.from([80, 75, 3, 4, 0]));
  await fs.writeFile(join(root, 'doc.docx'), Buffer.from([80, 75, 3, 4, 0]));
  await fs.writeFile(join(root, 'masked.js'), Buffer.from([80, 75, 3, 4, 0]));
  await fs.writeFile(join(root, 'selected.js'), 'import "./neighbor.js";\n');
  await fs.writeFile(join(root, 'neighbor.js'), 'not selected');
  for (const path of [root, join(root, '.git', 'config')]) {
    await assert.rejects(prepareAttachments([path], cfg), { code: 'FILE_UNSAFE' });
  }
  await assert.rejects(prepareAttachments([join(root, '*.js')], cfg));
  await assert.rejects(prepareAttachments([join(root, 'repo.zip')], cfg), { code: 'ARCHIVE_NOT_ALLOWED' });
  for (const name of ['doc.docx', 'masked.js']) {
    await assert.rejects(prepareAttachments([join(root, name)], cfg), { code: 'FILE_TYPE' });
  }
  const opened = [];
  await prepareAttachments([join(root, 'selected.js')], cfg, {
    io: { ...fs, open: (...args) => { opened.push(args[0]); return fs.open(...args); } },
  });
  assert.equal(opened.length, 1);
  assert.ok(opened[0].endsWith('/selected.js'));
});

test('attachments: file policy bounds size, count and cancellation before reading', async () => {
  const { prepareAttachments, MAX_FILE_BYTES } = await import('../src/attachments.mjs');
  const { root, paths } = await samples();
  const cfg = { attachmentRoot: root };
  await fs.writeFile(join(root, 'large.png'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await assert.rejects(prepareAttachments([join(root, 'large.png')], cfg), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(prepareAttachments(Array(6).fill(paths[0]), cfg), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(prepareAttachments([paths[0]], cfg, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
});

test('attachments: file policy detects growth and replacement during snapshot', async () => {
  const { prepareAttachments } = await import('../src/attachments.mjs');
  for (const replacement of [false, true]) {
    const { root, paths } = await samples();
    const io = { ...fs, open: async (...args) => {
      const file = await fs.open(...args);
      const read = file.read.bind(file);
      let changed = false;
      file.read = async (...readArgs) => {
        const result = await read(...readArgs);
        if (!changed) {
          changed = true;
          if (replacement) {
            await fs.writeFile(join(root, 'replacement.js'), SAMPLE_CODE);
            await fs.rename(join(root, 'replacement.js'), paths[2]);
          } else await fs.appendFile(paths[2], 'extra');
        }
        return result;
      };
      return file;
    } };
    await assert.rejects(prepareAttachments([paths[2]], { attachmentRoot: root }, { io }), { code: 'FILE_CHANGED' });
  }
});

test('attachments: file policy pins startup scope and rejects before browser access', async () => {
  const { root, paths } = await samples();
  const cfg = loadConfig({ HOME: root }, { stateDir: join(root, 'state'), attachmentRoot: root });
  assert.equal(cfg.attachmentRootReal, await fs.realpath(root));
  assert.throws(() => loadConfig({}, { attachmentRoot: '.' }), { code: 'CONFIG_INVALID' });
  assert.throws(() => loadConfig({}, { attachmentRoot: paths[0] }), { code: 'CONFIG_INVALID' });
  let requests = 0;
  const bridge = new ClaudeBridge(cfg, { withTab: async () => { requests += 1; throw new Error('Unexpected browser access'); } });
  await assert.rejects(bridge.ask({ session: 'invalid', prompt: 'Read', attachments: [root] }), { code: 'FILE_UNSAFE' });
  await assert.rejects(bridge.ask({ session: 'invalid', prompt: 'Read', attachments: ['*.js'] }), { code: 'INVALID_ARGUMENT' });
  const disabled = new ClaudeBridge(loadConfig({ HOME: root }, { stateDir: join(root, 'disabled') }), {
    withTab: async () => { requests += 1; throw new Error('Unexpected browser access'); },
  });
  await assert.rejects(disabled.ask({ session: 'invalid', prompt: 'Read', attachments: paths }), { code: 'ATTACHMENT_SCOPE' });
  assert.equal(requests, 0);
});

test('attachments: file policy enforces aggregate and UTF-8 limits before transfer', async () => {
  const { prepareAttachments, MAX_FILE_BYTES, MAX_TEXT_BYTES } = await import('../src/attachments.mjs');
  const { root } = await samples();
  const paths = ['one.png', 'two.png', 'three.png'].map(name => join(root, name));
  for (const path of paths) await fs.writeFile(path, Buffer.alloc(MAX_FILE_BYTES));
  let opens = 0;
  await assert.rejects(prepareAttachments(paths, { attachmentRoot: root }, {
    io: { ...fs, open: (...args) => { opens += 1; return fs.open(...args); } },
  }), { code: 'FILE_TOO_LARGE' });
  assert.equal(opens, 0);
  await fs.writeFile(join(root, 'large.js'), Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
  await assert.rejects(prepareAttachments([join(root, 'large.js')], { attachmentRoot: root }), { code: 'FILE_TOO_LARGE' });
  for (const data of [Buffer.from([0xff, 0xff]), Buffer.from([0xef, 0xbb, 0xbf, 65]), Buffer.from('not a png')]) {
    const name = data[0] === 110 ? 'bad.png' : 'bad.js';
    await fs.writeFile(join(root, name), data);
    await assert.rejects(prepareAttachments([join(root, name)], { attachmentRoot: root }), { code: 'FILE_TYPE' });
  }
});

test('attachments: file policy cannot retarget an operator-approved root after startup', async () => {
  const { prepareAttachments } = await import('../src/attachments.mjs');
  const parent = await makeTmpDir('ccw-root-pin-');
  const first = join(parent, 'first');
  const second = join(parent, 'second');
  const alias = join(parent, 'anchor');
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.writeFile(join(first, 'chosen.js'), 'first\n');
  await fs.writeFile(join(second, 'chosen.js'), 'second\n');
  await fs.symlink(first, alias);
  const cfg = loadConfig({}, { attachmentRoot: alias });
  await fs.unlink(alias);
  await fs.symlink(second, alias);
  const prepared = await prepareAttachments([join(alias, 'chosen.js')], cfg);
  assert.equal(prepared[0].bytes.toString(), 'first\n');
});

test('attachments: artifacts are bound to public delivery metadata, not arbitrary links', async () => {
  const { publicArtifacts } = await import('../src/core/artifacts.mjs');
  const message = { uuid: CONV_ID, sender: 'assistant', content: [OBSERVED_FILE_DELIVERIES] };
  const files = publicArtifacts(CONV_ID, [message]);
  assert.equal(files.length, 3);
  assert.ok(files.every(f => f.id.length === 64 && f.downloadable && f.messageId === CONV_ID));
  assert.deepEqual(files.map(f => f.name), ['result.md', 'drawing.svg', 'result.js']);
  const otherSandbox = structuredClone(message);
  otherSandbox.content[0].file_deliveries[0].path = '/home/otheruser/result.md';
  assert.deepEqual(publicArtifacts(CONV_ID, [otherSandbox]).map(f => f.name), ['result.md', 'drawing.svg', 'result.js']);
  assert.deepEqual(publicArtifacts(CONV_ID, [{ ...message, content: [{ type: 'text', text: 'https://example.invalid/evil.js' }, { type: 'tool_use', name: 'SendUserFile', input: { file_uuid: CONV_ID } }] }]), []);
  const unsafe = structuredClone(message);
  unsafe.content[0].file_deliveries[0].path = '/home/claude/../secret';
  assert.throws(() => publicArtifacts(CONV_ID, [unsafe]), { code: 'API_CONTRACT' });
});

test('attachments: continuity matches hashes and uploaded identities, including empty manifests', async () => {
  const { attachmentIdentity, matchesAttachments, prepareAttachments } = await import('../src/attachments.mjs');
  const { root, uploadPaths } = await samples();
  const prepared = await prepareAttachments(uploadPaths, { attachmentRoot: root });
  // the observed message predates the PDF removal: its manifest is rebuilt from the fixture
  const manifest = [
    { ...attachmentIdentity(prepared[0]), fileId: OBSERVED_HUMAN_ATTACHMENTS.files[0].file_uuid },
    {
      name: 'sample.pdf', kind: 'document', mimeType: 'application/pdf',
      size: SAMPLE_PDF.length, sha256: createHash('sha256').update(SAMPLE_PDF).digest('hex'),
      fileId: OBSERVED_HUMAN_ATTACHMENTS.files[1].file_uuid,
    },
    attachmentIdentity(prepared[1]),
  ];
  assert.equal(matchesAttachments(OBSERVED_HUMAN_ATTACHMENTS, manifest), true);
  const altered = structuredClone(OBSERVED_HUMAN_ATTACHMENTS);
  altered.attachments[0].extracted_content = altered.attachments[0].extracted_content.replace('8', '9');
  assert.equal(matchesAttachments(altered, manifest), false);
  altered.attachments = OBSERVED_HUMAN_ATTACHMENTS.attachments;
  altered.files[0].file_uuid = CONV_ID;
  assert.equal(matchesAttachments(altered, manifest), false);
  assert.equal(matchesAttachments(OBSERVED_HUMAN_ATTACHMENTS, []), false);
  assert.equal(matchesAttachments({}, []), true);
});

test('attachments: asset-only completion requires a successful public result', async () => {
  const { completedAssistant } = await import('../src/core/artifacts.mjs');
  const base = { uuid: CONV_ID, sender: 'assistant', stop_reason: 'end_turn', content: [] };
  assert.equal(completedAssistant(CONV_ID, base), false);
  assert.equal(completedAssistant(CONV_ID, { ...base, content: [OBSERVED_FILE_DELIVERIES] }), true);
  assert.equal(completedAssistant(CONV_ID, { ...base, truncated: true, content: [OBSERVED_FILE_DELIVERIES] }), false);
  assert.equal(completedAssistant(CONV_ID, { ...base, content: [{ ...OBSERVED_FILE_DELIVERIES, is_error: true }] }), false);
});

async function nativeBridge(t, extra = {}) {
  const sample = await samples();
  const service = new ClaudeService({ replyText: 'native reply' });
  const server = new FakeCdpServer({ fetchHandler: fetchHandlerFor(service), nativeService: service });
  await server.start();
  t.after(() => server.stop());
  const config = loadConfig({ HOME: sample.root }, {
    cdpUrl: server.cdpUrl, stateDir: join(sample.root, 'state'), attachmentRoot: sample.root,
    // CdpClient.connect shares readyTimeoutMs; 400ms races the /json/version
    // fetch under full-suite process load and reports a spurious CDP_UNREACHABLE.
    timeoutMs: 3000, idleTimeoutMs: 1000, readyTimeoutMs: 1000, minIntervalMs: 1, ...extra,
  });
  const bridge = new ClaudeBridge(config);
  return { ...sample, service, server, config, bridge };
}

test('attachments: images and code use real File values and verified server bindings', async t => {
  const { root, uploadPaths, service, server, bridge } = await nativeBridge(t);
  const result = await bridge.ask({ session: 'native', prompt: '  inspect\r\nthese  ', attachments: uploadPaths });
  assert.equal(result.reply, 'native reply');
  assert.equal(result.attachments.length, 2);
  assert.deepEqual(service.uploads.map(f => f.bytes), [SAMPLE_PNG, SAMPLE_CODE]);
  assert.equal(service.posts('/completion').length, 0);
  assert.equal(service.nativeSends.length, 1);
  const human = service.convs.get(result.conversationId).chat_messages[0];
  assert.equal(human.content[0].text, 'inspect\nthese');
  assert.equal(human.files.length, 1);
  assert.equal(human.attachments.length, 1);
  const state = await bridge.store.load();
  assert.equal(state.version, 2);
  assert.equal(state.sessions[0].pending, null);
  assert.ok(!JSON.stringify(state).includes(root));
  assert.ok(!JSON.stringify(state).includes(SAMPLE_CODE.toString()));
  assert.deepEqual(server.closedTargets, server.createdTargets.map(t => t.targetId));
});

test('attachments: code is extracted as exact UTF-8 without reading imports', async t => {
  const { root, paths, service, bridge } = await nativeBridge(t);
  await fs.writeFile(join(root, 'neighbor.js'), 'do not read');
  await fs.writeFile(paths[2], 'import "./neighbor.js";\nexport const value = "中文";\n');
  const result = await bridge.ask({ session: 'code', prompt: 'inspect code', attachments: [paths[2]] });
  assert.equal(service.uploads.length, 1);
  const human = service.convs.get(result.conversationId).chat_messages[0];
  assert.deepEqual(human.files, []);
  assert.equal(human.attachments[0].extracted_content, await fs.readFile(paths[2], 'utf8'));
  assert.equal(result.attachments[0].fileId, null);
});

test('attachments: continuity selects native on upgraded follow-up without reupload', async t => {
  const { uploadPaths, service, bridge } = await nativeBridge(t);
  const first = await bridge.ask({ session: 'follow', prompt: 'one', attachments: uploadPaths });
  const second = await bridge.followUp({ session: 'follow', prompt: 'two' });
  const conv = service.convs.get(first.conversationId);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(conv.chat_messages[2].parent_message_uuid, first.assistantMessageId);
  assert.equal(service.uploads.length, 2);
  assert.equal(service.nativeSends.length, 2);
  assert.equal(service.posts('/completion').length, 0);
  assert.equal((await bridge.transcript({ session: 'follow' })).messages.length, 4);
});

test('attachments: a file that is not ready preserves upload intent and never sends', async t => {
  const { paths, service, bridge } = await nativeBridge(t);
  service.beforeUploadResponse = data => { data.preview_asset = null; };
  await assert.rejects(bridge.ask({ session: 'processing', prompt: 'inspect', attachments: [paths[0]] }), { code: 'FILE_NOT_READY' });
  const pending = (await bridge.store.load()).sessions[0].pending;
  assert.equal(pending.kind, 'upload');
  assert.ok(pending.attachments[0].fileId);
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.transcript({ session: 'processing', recover: true })).recovered, false);
  await assert.rejects(bridge.followUp({ session: 'processing', prompt: 'retry' }), { code: 'PENDING_TURN' });
  assert.equal(service.uploads.length, 1);
});

test('attachments: recovery requires the original attachment identity after an uncertain click', async t => {
  const { uploadPaths, service, bridge } = await nativeBridge(t);
  service.nativeFailure = 'afterCommit';
  await assert.rejects(bridge.ask({ session: 'uncertain', prompt: 'same text', attachments: uploadPaths }), error => error.details.pending === true);
  const state = await bridge.store.load();
  assert.equal(state.version, 2);
  assert.equal(state.sessions[0].pending.kind, 'send');
  const conv = service.convs.get(state.sessions[0].conversationId);
  const original = conv.chat_messages[0].attachments[0].extracted_content;
  conv.chat_messages[0].attachments[0].extracted_content = original.replace('8', '9');
  assert.equal((await bridge.transcript({ session: 'uncertain', recover: true })).recovered, false);
  conv.chat_messages[0].attachments[0].extracted_content = original;
  assert.equal((await bridge.transcript({ session: 'uncertain', recover: true })).recovered, true);
  assert.equal(service.nativeSends.length, 1);
  assert.equal(service.uploads.length, 2);
});

async function completedUploadRecovery(t, priorTurn = false) {
  const context = await nativeBridge(t);
  const { service, bridge, uploadPaths } = context;
  if (priorTurn) await bridge.ask({ session: 'upload-recovery', prompt: 'earlier turn', native: true });
  service.nativeFailure = 'afterCommit';
  const operation = priorTurn ? bridge.followUp.bind(bridge) : bridge.ask.bind(bridge);
  await assert.rejects(operation({
    session: 'upload-recovery', prompt: '  inspect\r\nthese  ', attachments: uploadPaths,
  }), error => error.details.pending === true);
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  entry.pending.kind = 'upload';
  await bridge.store.withLock(() => bridge.store.save(state));
  const conversation = service.convs.get(entry.conversationId);
  return {
    ...context, state, entry, conversation,
    human: conversation.chat_messages.at(-2),
    assistant: conversation.chat_messages.at(-1),
  };
}

for (const priorTurn of [false, true]) {
  test(`attachments: upload recovery reconciles completed native history without resending (${priorTurn ? 'follow-up' : 'first turn'})`, async context => {
    const { service, bridge, conversation, assistant, entry } = await completedUploadRecovery(context, priorTurn);
    const uploadCount = service.uploads.length;
    const sendCount = service.nativeSends.length;
    const observed = await bridge.transcript({ session: 'upload-recovery' });
    assert.equal(observed.recovered, false);
    assert.equal(observed.pending.kind, 'upload');

    const recovered = await bridge.transcript({ session: 'upload-recovery', recover: true });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.pending, null);
    assert.equal(recovered.messages.at(-1).uuid, assistant.uuid);
    assert.equal((await bridge.store.load()).sessions[0].parentMessageId, assistant.uuid);
    assert.equal(service.uploads.length, uploadCount);
    assert.equal(service.nativeSends.length, sendCount);
    assert.equal(service.posts('/completion').length, 0);

    service.nativeFailure = null;
    await bridge.followUp({ session: 'upload-recovery', prompt: 'new review evidence' });
    assert.equal(conversation.chat_messages.at(-2).parent_message_uuid, assistant.uuid);
    assert.equal(service.uploads.length, uploadCount);
    assert.equal(service.nativeSends.length, sendCount + 1);
    assert.equal(conversation.uuid, entry.conversationId);
  });
}

const uploadRecoveryRejections = [
  ['changed prompt', ({ human }) => { human.content[0].text = 'different question'; }],
  ['unknown binary identity', ({ entry }) => { entry.pending.attachments.find(file => file.kind === 'image').fileId = null; }],
  ['changed binary identity', ({ human, service }) => { human.files[0].file_uuid = service.uuid(); }],
  ['missing attachment', ({ human }) => { human.files = []; }],
  ['changed file name', ({ human }) => { human.files[0].file_name = 'different.png'; }],
  ['changed file size', ({ human }) => { human.files[0].size_bytes += 1; }],
  ['changed file kind', ({ human }) => { human.files[0].file_kind = 'document'; }],
  ['changed code bytes', ({ human }) => { human.attachments[0].extracted_content += ' '; }],
  ['unfinished assistant', ({ assistant }) => { assistant.stop_reason = null; }],
  ['missing parent', ({ entry, service }) => {
    entry.parentMessageId = service.uuid();
    entry.pending.parentMessageId = entry.parentMessageId;
  }],
  ['later conversation turn', ({ conversation, service }) => {
    service.commitTurn(conversation, 'later question', conversation.current_leaf_message_uuid, 'later answer');
  }],
];

for (const [reason, mutate] of uploadRecoveryRejections) {
  test(`attachments: upload recovery preserves pending for ${reason}`, async context => {
    const scenario = await completedUploadRecovery(context);
    const { bridge, service, state } = scenario;
    mutate(scenario);
    await bridge.store.withLock(() => bridge.store.save(state));
    const before = await bridge.store.load();
    const uploadCount = service.uploads.length;
    const sendCount = service.nativeSends.length;

    const result = await bridge.transcript({ session: 'upload-recovery', recover: true });
    assert.equal(result.recovered, false);
    assert.equal(result.pending.kind, 'upload');
    assert.deepEqual(await bridge.store.load(), before);
    await assert.rejects(bridge.followUp({ session: 'upload-recovery', prompt: 'must not send' }), { code: 'PENDING_TURN' });
    assert.equal(service.uploads.length, uploadCount);
    assert.equal(service.nativeSends.length, sendCount);
    assert.equal(service.posts('/completion').length, 0);
  });
}

test('attachments: asset-only native reply exposes public files without claiming a download', async t => {
  const { service, bridge } = await nativeBridge(t);
  service.replyText = '';
  service.nativeOutputs = [{ name: 'result.js', bytes: Buffer.from('export const x = 1;\n') }];
  const result = await bridge.ask({ session: 'only-files', prompt: 'make file', native: true });
  assert.equal(result.reply, '');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].downloadable, true);
  assert.equal(result.artifacts[0].localPath, undefined);
  assert.deepEqual((await bridge.transcript({ session: 'only-files' })).artifacts, result.artifacts);
});

test('attachments: terminal truncated native replies clear pending but remain incomplete', async t => {
  const { service, bridge } = await nativeBridge(t);
  service.afterNativeSend = conversation => {
    const assistant = conversation.chat_messages.at(-1);
    assistant.stop_reason = 'max_tokens';
    assistant.truncated = true;
  };
  const result = await bridge.ask({ session: 'partial-native', prompt: 'inspect', native: true });
  assert.equal(result.complete, false);
  assert.equal(result.stopReason, 'max_tokens');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
  assert.equal((await bridge.transcript({ session: 'partial-native' })).messages.at(-1).complete, false);
  const next = await bridge.followUp({ session: 'partial-native', prompt: 'continue', native: true });
  assert.equal(next.previousComplete, false);
});

test('attachments: recovery state rejects missing IDs, downgraded or secret-bearing manifests', async () => {
  const { validateState } = await import('../src/session-store.mjs');
  const now = new Date().toISOString();
  const state = {
    version: 2, lastSubmissionAt: 1, sessions: [{
      session: 's', orgId: CONV_ID, conversationId: CONV_ID, parentMessageId: CONV_ID,
      model: null, createdAt: now, updatedAt: now,
      pending: {
        kind: 'upload', transport: 'native', parentMessageId: CONV_ID, startedAt: now,
        promptSha256: 'a'.repeat(64),
        attachments: [{ name: 'x.png', kind: 'image', mimeType: 'image/png', size: 12, sha256: 'b'.repeat(64), fileId: null }],
      },
    }],
  };
  assert.equal(validateState(state), state);
  const changed = structuredClone(state);
  changed.version = 1;
  assert.throws(() => validateState(changed), { code: 'STATE_CORRUPT' });
  changed.version = 2;
  changed.sessions[0].pending.kind = 'send';
  assert.throws(() => validateState(changed), { code: 'STATE_CORRUPT' });
  changed.sessions[0].pending.kind = 'upload';
  changed.sessions[0].pending.attachments[0].path = '/unwanted/local/path';
  assert.throws(() => validateState(changed), { code: 'STATE_CORRUPT' });
});

test('attachments: recovery after cancellation closes only owned scope and does not resend', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  service.afterNativeSend = () => controller.abort();
  await assert.rejects(bridge.ask({ session: 'abort', prompt: 'inspect', attachments: uploadPaths }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(service.nativeSends.length, 1);
  assert.deepEqual(server.closedTargets, server.createdTargets.map(t => t.targetId));
  await assert.rejects(fs.stat(bridge.store.lockFile), { code: 'ENOENT' });
  assert.equal((await bridge.transcript({ session: 'abort', recover: true })).recovered, true);
  assert.equal(service.uploads.length, 2);
  assert.equal(service.nativeSends.length, 1);
});

test('attachments: recover submits a held text draft exactly once after an interrupted send', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  await assert.rejects(bridge.ask({ session: 'held-draft', prompt: 'held\nprompt', native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  const stuck = (await bridge.store.load()).sessions[0];
  assert.equal(stuck.pending.kind, 'send');
  assert.equal(stuck.pending.transport, 'native');
  server.onMessage = null;
  // the abandoned tab kept the filled prompt; IndexedDB restores it on the next open
  server.onNavigate = page => {
    page.editor.innerText = 'held\n\nprompt';
    page.nativePrompt = 'held\nprompt';
  };
  const result = await bridge.transcript({ session: 'held-draft', recover: true });
  assert.equal(result.recovered, true);
  assert.equal(result.resumed, true);
  assert.equal(service.nativeSends.length, 1);
  const human = service.convs.get(stuck.conversationId).chat_messages.at(-2);
  assert.equal(human.content[0].text, 'held\nprompt');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: recover submits a draft left by the real send at the click boundary', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  let intercepts = 0;
  const originalOnMessage = server.onMessage;
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate'
      && message.params?.expression?.includes('"action":"submit"')) {
      intercepts += 1;
      server.onMessage = originalOnMessage;
      const ws = [...server.sockets][0];
      ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'SUBMIT_INTERRUPTED' } }));
      throw new Error('SUBMIT_INTERRUPTED');
    }
  };
  await assert.rejects(bridge.ask({ session: 'click-boundary', prompt: 'held by the real sender', native: true }),
    { code: 'CDP_ERROR' });
  assert.equal(intercepts, 1);
  assert.equal(service.nativeSends?.length ?? 0, 0);
  const stuck = (await bridge.store.load()).sessions[0];
  assert.equal(stuck.pending.kind, 'send');
  assert.equal(stuck.pending.transport, 'native');
  assert.equal(server.pages.get('session-target-1').editor.innerText, 'held by the real sender');
  server.onNavigate = page => {
    page.editor.innerText = 'held by the real sender';
    page.nativePrompt = 'held by the real sender';
  };
  const result = await bridge.transcript({ session: 'click-boundary', recover: true });
  assert.equal(result.recovered, true);
  assert.equal(result.resumed, true);
  assert.equal(service.nativeSends.length, 1);
  const human = service.convs.get(stuck.conversationId).chat_messages.at(-2);
  assert.equal(human.content[0].text, 'held by the real sender');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: native send waits for a temporarily disabled control and submits once', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  service.nativeSendDisabled = true;
  server.onMessage = message => {
    if (message.method !== 'Runtime.evaluate' || !message.params?.expression?.includes('"action":"ready"')) return;
    const page = server.pages.get(message.sessionId);
    setTimeout(() => { page.sendButton.disabled = false; }, 20);
  };
  const result = await bridge.ask({ session: 'delayed-send', prompt: 'wait for the control', native: true });
  assert.equal(result.autoRecovered, true);
  assert.equal(service.nativeSends.length, 1);
  assert.equal(result.reply, 'native reply');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: a permanently disabled native control preserves the held draft', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  service.nativeSendDisabled = true;
  await assert.rejects(bridge.ask({ session: 'blocked-send', prompt: 'never becomes ready', native: true }), { code: 'UI_NOT_READY' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  const entry = (await bridge.store.load()).sessions[0];
  assert.equal(entry.pending.kind, 'send');
  assert.equal(entry.pending.transport, 'native');
  assert.equal(server.pages.get('session-target-1').editor.innerText, 'never becomes ready');
  assert.equal(server.closedTargets.length, 0);
});

test('attachments: native send rechecks the branch while waiting for the control', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  service.nativeSendDisabled = true;
  let attempted = false;
  server.onMessage = message => {
    if (message.method !== 'Runtime.evaluate' || !message.params?.expression?.includes('"action":"submit"') || attempted) return;
    attempted = true;
    const page = server.pages.get(message.sessionId);
    const conversationId = page.sandbox.location.pathname.split('/').at(-1);
    const conversation = service.convs.get(conversationId);
    service.commitTurn(
      conversation, 'operator continued',
      conversation.current_leaf_message_uuid ?? '00000000-0000-4000-8000-000000000000', 'operator reply',
    );
  };
  await assert.rejects(bridge.ask({ session: 'moved-while-waiting', prompt: 'ours', native: true }), { code: 'REMOTE_BRANCH_CHANGED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  const entry = (await bridge.store.load()).sessions[0];
  assert.equal(entry.pending.kind, 'send');
  assert.equal(server.closedTargets.length, 0);
});

test('attachments: recover refuses a held draft whose text was changed', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  await assert.rejects(bridge.ask({ session: 'held-changed', prompt: 'ours', native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  server.onMessage = null;
  server.onNavigate = page => {
    page.editor.innerText = 'someone else typed this';
    page.nativePrompt = 'someone else typed this';
  };
  await assert.rejects(bridge.transcript({ session: 'held-changed', recover: true }), { code: 'UI_DRAFT_CONFLICT' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'send');
  assert.equal(server.closedTargets.length, 0, 'the retained tab is left for the operator');
});

test('attachments: recover waits for a restored draft to mount before proving it', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  await assert.rejects(bridge.ask({ session: 'late-draft', prompt: 'late draft', native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  server.onMessage = null;
  let restores = 0;
  server.onNavigate = page => {
    page.editor.innerText = '';
    page.nativePrompt = '';
  };
  server.onMessage = message => {
    if (message.method !== 'Runtime.evaluate' || !message.params?.expression?.includes('store:chat-draft:')) return;
    restores += 1;
    if (restores === 3) {
      const page = server.pageFor('session-target-2') ?? [...server.pages.values()].at(-1);
      page.editor.innerText = 'late draft';
      page.nativePrompt = 'late draft';
    }
  };
  const result = await bridge.transcript({ session: 'late-draft', recover: true });
  assert.equal(result.recovered, true);
  assert.equal(result.resumed, true);
  assert.ok(restores >= 3, 'the composer was read repeatedly until the draft mounted');
  assert.equal(service.nativeSends.length, 1);
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: recover refuses a branch changed after draft verification', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  await assert.rejects(bridge.ask({ session: 'recover-moved', prompt: 'ours', native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  const stuck = (await bridge.store.load()).sessions[0];
  server.onNavigate = page => {
    page.editor.innerText = 'ours';
    page.nativePrompt = 'ours';
  };
  server.onMessage = null;
  const handle = service.handle.bind(service);
  let reads = 0;
  service.handle = async request => {
    if (request.method === 'GET' && request.path.includes(`/chat_conversations/${stuck.conversationId}?`)) reads += 1;
    if (reads === 3) {
      service.commitTurn(service.convs.get(stuck.conversationId), 'operator continued', stuck.pending.parentMessageId, 'operator reply');
    }
    return handle(request);
  };
  await assert.rejects(bridge.transcript({ session: 'recover-moved', recover: true }), { code: 'REMOTE_BRANCH_CHANGED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'send');
  assert.equal(server.closedTargets.length, 0);
});

test('attachments: recover resubmits a held draft with verified attachments', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  // abort the moment the 'send' marker lands on disk, before the click
  const save = bridge.store.save.bind(bridge.store);
  bridge.store.save = async state => {
    const result = await save(state);
    if (state.sessions[0]?.pending?.kind === 'send') controller.abort();
    return result;
  };
  await assert.rejects(bridge.ask({ session: 'held-files', prompt: 'with files', attachments: uploadPaths }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  const stuck = (await bridge.store.load()).sessions[0];
  assert.equal(stuck.pending.kind, 'send');
  assert.ok(stuck.pending.attachments.every(file => file.kind === 'text' || file.fileId));
  server.onMessage = null;
  const uploaded = service.uploads.map(file => ({ ...file }));
  server.onNavigate = page => {
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.editor.innerText = 'with files';
    page.nativePrompt = 'with files';
    page.draftStore.set(`store:chat-draft:${stuck.conversationId}`, restoredDraftRow(stuck.conversationId, uploaded));
  };
  const result = await bridge.transcript({ session: 'held-files', recover: true });
  assert.equal(result.recovered, true);
  assert.equal(result.resumed, true);
  assert.equal(service.nativeSends.length, 1);
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
  const human = service.convs.get(stuck.conversationId).chat_messages.at(-2);
  assert.deepEqual(human.files.map(file => file.file_name), ['sample.png']);
  assert.deepEqual(human.attachments.map(file => file.file_name), ['sample.js']);
});

test('attachments: continuity refuses a changed branch before the click', async t => {
  const { paths, service, bridge } = await nativeBridge(t);
  service.beforeUploadResponse = () => {
    const conv = [...service.convs.values()][0];
    service.commitTurn(conv, 'another turn', conv.current_leaf_message_uuid ?? '00000000-0000-4000-8000-000000000000', 'another reply');
  };
  await assert.rejects(bridge.ask({ session: 'branch', prompt: 'inspect', attachments: [paths[0]] }), { code: 'REMOTE_BRANCH_CHANGED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'upload');
});

test('attachments: continuity leaves a reclaimed tab alone and recovers without touching it', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  service.afterNativeSend = (_, page) => { page.sandbox.location.pathname = '/chat/another-conversation'; };
  await assert.rejects(bridge.ask({ session: 'reclaimed', prompt: 'inspect', native: true }), { code: 'UI_CONTEXT_LOST' });
  assert.equal(server.closedTargets.length, 0);
  assert.equal((await bridge.transcript({ session: 'reclaimed', recover: true })).recovered, true);
  assert.ok(!server.closedTargets.includes('target-1'));
  assert.equal(service.nativeSends.length, 1);
});

test('attachments: native wait returns a user-canceled assistant as terminated incomplete', async t => {
  const { service, bridge } = await nativeBridge(t);
  service.afterNativeSend = conv => {
    const assistant = conv.chat_messages.at(-1);
    assistant.stop_reason = 'user_canceled';
    assistant.content = [];
  };
  const result = await bridge.ask({ session: 'canceled-live', prompt: 'stop this reply', native: true });
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, 'user_canceled');
  assert.equal(result.complete, false);
  assert.equal(result.reply, '');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
  assert.equal((await bridge.store.load()).sessions[0].parentMessageId, result.assistantMessageId);
});

test('attachments: recover reconciles a canceled native turn and allows a follow-up', async t => {
  const { service, bridge } = await nativeBridge(t);
  service.nativeFailure = 'afterCommit';
  await assert.rejects(bridge.ask({ session: 'canceled-recover', prompt: 'was it sent?', native: true }), error => error.details.pending === true);
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  assert.equal(entry.pending.kind, 'send');
  // the operator stopped the reply in the browser: terminal, no content
  const assistant = service.convs.get(entry.conversationId).chat_messages.at(-1);
  assistant.stop_reason = 'user_canceled';
  assistant.content = [];
  service.nativeFailure = null;
  const result = await bridge.transcript({ session: 'canceled-recover', recover: true });
  assert.equal(result.recovered, true);
  assert.equal(result.resumed, false);
  assert.equal(result.pending, null);
  assert.equal(result.messages.at(-1).stopReason, 'user_canceled');
  assert.equal(result.messages.at(-1).complete, false);
  assert.equal((await bridge.store.load()).sessions[0].parentMessageId, assistant.uuid);
  const followUp = await bridge.followUp({ session: 'canceled-recover', prompt: 'continue after the stop' });
  assert.equal(followUp.ok, true);
  assert.equal(followUp.previousComplete, false);
});

test('attachments: native discard abandons an unrecoverable pending and re-anchors to the current leaf', async t => {
  const { service, bridge } = await nativeBridge(t);
  service.nativeFailure = 'afterCommit';
  await assert.rejects(bridge.ask({ session: 'discard-send', prompt: 'uncertain send', native: true }), error => error.details.pending === true);
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  assert.equal(entry.pending.kind, 'send');
  // the user continued the conversation in the browser: recover can no longer
  // reconcile the original suffix, and native-resume would refuse the moved branch
  const conv = service.convs.get(entry.conversationId);
  const later = service.commitTurn(conv, 'operator continued elsewhere', conv.current_leaf_message_uuid, 'operator reply');
  service.nativeFailure = null;
  const sendsBefore = service.nativeSends.length;

  await assert.rejects(bridge.transcript({ session: 'discard-send', discardPending: true }), { code: 'INVALID_ARGUMENT' });
  const result = await bridge.transcript({ session: 'discard-send', recover: true, discardPending: true });
  assert.equal(result.discarded, true);
  assert.equal(result.recovered, false);
  assert.equal(result.resumed, false);
  assert.equal(result.pending, null);
  assert.equal(service.nativeSends.length, sendsBefore, 'discard never sends');
  assert.equal((await bridge.store.load()).sessions[0].parentMessageId, later.uuid);
  const followUp = await bridge.followUp({ session: 'discard-send', prompt: 'continue after abandoning' });
  assert.equal(followUp.ok, true);
});

test('attachments: native discard clears a create pending and re-anchors to root', async t => {
  const { service, bridge } = await nativeBridge(t);
  await bridge.store.withLock(() => bridge.store.save({
    version: 2,
    lastSubmissionAt: 0,
    sessions: [{
      orgId: '11111111-2222-4333-8444-555566667777', conversationId: CONV_ID, parentMessageId: '00000000-0000-4000-8000-000000000000',
      model: 'claude-opus-5-5', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      session: 'discard-create',
      pending: { kind: 'create', parentMessageId: '00000000-0000-4000-8000-000000000000', startedAt: new Date().toISOString() },
    }],
  }));
  service.addConversation({ uuid: CONV_ID, messages: [], leaf: null });
  const result = await bridge.transcript({ session: 'discard-create', recover: true, discardPending: true });
  assert.equal(result.discarded, true);
  assert.equal(result.pending, null);
  assert.equal((await bridge.store.load()).sessions[0].parentMessageId, '00000000-0000-4000-8000-000000000000');
});

test('attachments: recovery preserves durable identity when the final save fails', async t => {
  const { uploadPaths, service, bridge } = await nativeBridge(t);
  const save = bridge.store.save.bind(bridge.store);
  bridge.store.save = async state => {
    if (state.version === 2 && state.sessions[0]?.pending === null) throw Object.assign(new Error('injected disk error'), { code: 'EIO' });
    return save(state);
  };
  await assert.rejects(bridge.ask({ session: 'save', prompt: 'inspect', attachments: uploadPaths }), error => error.details.pending === true);
  const state = await bridge.store.load();
  assert.equal(state.sessions[0].pending.kind, 'send');
  assert.ok(state.sessions[0].pending.attachments[0].fileId);
  bridge.store.save = save;
  assert.equal((await bridge.transcript({ session: 'save', recover: true })).recovered, true);
  assert.equal(service.nativeSends.length, 1);
  assert.equal(service.uploads.length, 2);
});

test('attachments: native wait treats a transient missing leaf pointer as not-yet-settled', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  // While a turn is still streaming the live page can omit current_leaf_message_uuid
  // on a non-empty conversation; the wait must keep polling instead of stranding the
  // pending marker on a send the server recorded.
  let stripped = 0;
  const handle = service.handle.bind(service);
  service.handle = async request => {
    const response = await handle(request);
    if (request.method === 'GET' && request.path.includes('?tree=True') && stripped < 3) {
      const body = JSON.parse(response.body);
      if (Array.isArray(body.chat_messages) && body.chat_messages.length) {
        delete body.current_leaf_message_uuid;
        stripped += 1;
        return { ...response, body: JSON.stringify(body) };
      }
    }
    return response;
  };
  const result = await bridge.ask({ session: 'transient-leaf', prompt: 'streaming turn', native: true });
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'native reply');
  assert.equal(stripped > 0, true);
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

async function outputSession(t, extra = {}) {
  // Download tests spawn a writer child, which can exceed the shared 400 ms UI
  // readiness budget under the full suite's load; they do not test startup latency.
  const context = await nativeBridge(t, { readyTimeoutMs: 3000, ...extra });
  context.service.nativeOutputs = [
    { name: 'image.png', bytes: SAMPLE_PNG },
    { name: 'document.pdf', bytes: SAMPLE_PDF },
    { name: 'code.js', bytes: SAMPLE_CODE },
  ];
  const reply = await context.bridge.ask({ session: 'outputs', prompt: 'produce files', native: true });
  return { ...context, artifacts: reply.artifacts, conversationId: reply.conversationId };
}

test('attachments: download returns exact bounded original bytes and metadata', async t => {
  const { bridge, artifacts, service } = await outputSession(t);
  for (const [i, artifact] of artifacts.entries()) {
    const result = await bridge.download({ session: 'outputs', artifact: artifact.id });
    const expected = [SAMPLE_PNG, SAMPLE_PDF, SAMPLE_CODE][i];
    assert.deepEqual(await fs.readFile(result.path), expected);
    assert.equal(result.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal(result.size, expected.length);
    assert.equal(result.mimeType, ['image/png', 'application/pdf', 'text/javascript'][i]);
    assert.equal(result.artifact.id, artifact.id);
    assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
    assert.equal(result.base64, undefined);
  }
  assert.equal(service.nativeSends.length, 1);
  assert.deepEqual((await fs.readdir(join(bridge.config.stateDir, 'downloads'))).sort(), ['code.js', 'document.pdf', 'image.png']);
});

test('attachments: remote source refuses forged and cross-session IDs before file requests', async t => {
  const { bridge, artifacts, service } = await outputSession(t);
  await bridge.ask({ session: 'other', prompt: 'other', native: true });
  for (const args of [
    { session: 'outputs', artifact: 'https://example.invalid/file' },
    { session: 'outputs', artifact: 'a'.repeat(64) },
    { session: 'other', artifact: artifacts[0].id },
  ]) await assert.rejects(bridge.download(args));
  assert.equal(service.requests.filter(r => r.path.endsWith('/contents')).length, 0);
});

test('attachments: remote source rejects redirects, foreign origins, HTML and JSON error bodies', async t => {
  const { bridge, artifacts, service } = await outputSession(t);
  const file = service.files.get(artifacts[2].fileId);
  for (const overrides of [
    { status: 302 },
    { redirected: true },
    { url: 'https://example.invalid/file' },
    { mimeType: 'text/html', bytes: Buffer.from('<html>login</html>') },
    { bytes: Buffer.from('<!DOCTYPE html><html>login</html>') },
    { bytes: Buffer.from('{"error":{"type":"authentication_error"}}') },
  ]) {
    Object.assign(file, { status: 200, redirected: false, url: undefined, mimeType: 'application/octet-stream', bytes: SAMPLE_CODE }, overrides);
    await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[2].id }));
  }
  assert.deepEqual(await fs.readdir(join(bridge.config.stateDir, 'downloads')), []);
});

test('attachments: destination rejects traversal, links and existing files without overwrite', async t => {
  const downloadRoot = await makeTmpDir('ccw-download-');
  const outside = await makeTmpDir('ccw-outside-');
  const { bridge, artifacts, service } = await outputSession(t, { downloadRoot });
  await fs.writeFile(join(downloadRoot, 'keep.js'), 'user data');
  await fs.symlink(outside, join(downloadRoot, 'linked'));
  for (const destination of ['../escape.js', '/absolute.js', 'keep.js', 'linked/escape.js']) {
    await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[2].id, destination }));
  }
  assert.equal(await fs.readFile(join(downloadRoot, 'keep.js'), 'utf8'), 'user data');
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(service.requests.filter(r => r.path.endsWith('/contents')).length, 0);
});

test('attachments: destination cannot be redirected during transfer or overwrite a late conflict', async t => {
  const downloadRoot = await makeTmpDir('ccw-download-');
  const outside = await makeTmpDir('ccw-outside-');
  await fs.mkdir(join(downloadRoot, 'sub'), { mode: 0o700 });
  const { bridge, artifacts, service } = await outputSession(t, { downloadRoot });
  const handle = service.handle.bind(service);
  service.handle = async request => {
    if (request.path.endsWith('/contents')) {
      await fs.rename(join(downloadRoot, 'sub'), join(downloadRoot, 'moved'));
      await fs.symlink(outside, join(downloadRoot, 'sub'));
    }
    return handle(request);
  };
  await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[2].id, destination: 'sub/code.js' }));
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(join(downloadRoot, 'moved')), []);
  service.handle = async request => {
    if (request.path.endsWith('/contents')) await fs.writeFile(join(downloadRoot, 'late.js'), 'new user content');
    return handle(request);
  };
  await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[2].id, destination: 'late.js' }), { code: 'FILE_EXISTS' });
  assert.equal(await fs.readFile(join(downloadRoot, 'late.js'), 'utf8'), 'new user content');
});

test('attachments: download bounds size and interruption and cleans only its temporary files', async t => {
  const { MAX_DOWNLOAD_BYTES } = await import('../src/attachments.mjs');
  // This case tests download bounds/abort, not child-startup latency. Starting
  // a secure writer can exceed 400 ms under the full suite's process load.
  const { bridge, artifacts, service } = await outputSession(t, { readyTimeoutMs: 3000 });
  const file = service.files.get(artifacts[2].fileId);
  file.bytes = Buffer.alloc(MAX_DOWNLOAD_BYTES + 1, 65);
  await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[2].id }), { code: 'PAYLOAD_TOO_LARGE' });
  file.bytes = hangingStream();
  const handle = service.handle.bind(service);
  const controller = new AbortController();
  service.handle = async request => {
    if (request.path.endsWith('/contents')) setTimeout(() => controller.abort(), 20);
    return handle(request);
  };
  await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[2].id }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(controller.signal.aborted, true, 'contents handler was reached and the intended cancellation fired');
  assert.deepEqual(await fs.readdir(join(bridge.config.stateDir, 'downloads')), []);
  await assert.rejects(fs.stat(bridge.store.lockFile), { code: 'ENOENT' });
});

test('attachments: file policy pins the selected list before asynchronous reads', async () => {
  const { prepareAttachments } = await import('../src/attachments.mjs');
  const { root, paths } = await samples();
  const selected = [paths[0]];
  const io = { ...fs, async lstat(...args) {
    if (selected.length === 1) selected.push(paths[2]);
    return fs.lstat(...args);
  } };
  const prepared = await prepareAttachments(selected, { attachmentRoot: root }, { io });
  assert.deepEqual(prepared.map(f => f.name), ['sample.png']);
});

test('attachments: PDF and unverified containers are refused before any browser or network effect', async t => {
  const { root, paths, service, server, bridge } = await nativeBridge(t);
  await fs.writeFile(join(root, 'large.pdf'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await fs.writeFile(join(root, 'unsupported.docx'), Buffer.from('PK\x03\x04'));
  for (const [file, code] of [['sample.pdf', 'FILE_TYPE'], ['large.pdf', 'FILE_TYPE'], ['unsupported.docx', 'FILE_TYPE']]) {
    await assert.rejects(
      bridge.ask({ session: `refuse-${file}`, prompt: 'inspect', attachments: [join(root, file)] }),
      error => error.code === code && /PDF|Unsupported attachment format/.test(error.message), file);
  }
  // a refused selection never creates a conversation, a tab or a remote record
  assert.equal(server.createdTargets.length, 0);
  assert.equal(service.requests.length, 0);
  assert.equal((await bridge.store.load()).sessions.length, 0);

  // the same file is still accepted where the capability exists: downloading a returned PDF artifact
  const { validateDownload, digest } = await import('../src/attachments.mjs');
  const metadata = validateDownload(SAMPLE_PDF, 'document.pdf', 'application/pdf');
  assert.equal(metadata.mimeType, 'application/pdf');
  assert.equal(metadata.size, SAMPLE_PDF.length);
  assert.equal(metadata.sha256, digest(SAMPLE_PDF));

  // an old pending that already carries a document attachment must still load
  const { validateState } = await import('../src/session-store.mjs');
  validateState({
    version: 2, lastSubmissionAt: 0,
    sessions: [{
      session: 'legacy', orgId: '11111111-2222-4333-8444-555566667777', conversationId: CONV_ID,
      parentMessageId: '00000000-0000-4000-8000-000000000000', model: null,
      createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
      pending: {
        kind: 'upload', transport: 'native', parentMessageId: '00000000-0000-4000-8000-000000000000',
        promptSha256: 'a'.repeat(64), startedAt: '2026-11-05T00:00:00.000Z',
        attachments: [{ name: 'sample.pdf', kind: 'document', mimeType: 'application/pdf', size: SAMPLE_PDF.length, sha256: digest(SAMPLE_PDF), fileId: null }],
      },
    }],
  });
});

test('attachments: PDF is refused on follow-up and restored drafts without changing old pending state', async t => {
  const { root, paths, service, server, bridge } = await nativeBridge(t);
  const parentMessageId = '00000000-0000-4000-8000-000000000000';
  const timestamp = '2026-11-05T00:00:00.000Z';
  const entry = {
    session: 'existing', orgId: '11111111-2222-4333-8444-555566667777', conversationId: CONV_ID,
    parentMessageId, model: null, createdAt: timestamp, updatedAt: timestamp, pending: null,
  };
  const pending = {
    kind: 'upload', transport: 'native', parentMessageId, promptSha256: 'a'.repeat(64), startedAt: timestamp,
    attachments: [{
      name: 'sample.pdf', kind: 'document', mimeType: 'application/pdf', size: SAMPLE_PDF.length,
      sha256: createHash('sha256').update(SAMPLE_PDF).digest('hex'), fileId: null,
    }],
  };
  const original = { version: 2, lastSubmissionAt: 0, sessions: [entry, { ...entry, session: 'legacy', pending }] };
  await bridge.store.withLock(() => bridge.store.save(original));
  await fs.writeFile(join(root, 'sample.PDF'), SAMPLE_PDF);

  await assert.rejects(bridge.followUp({ session: 'existing', prompt: 'inspect', attachments: [paths[0], join(root, 'sample.PDF')] }), { code: 'FILE_TYPE' });
  await assert.rejects(bridge.resumeNativeUpload({ session: 'legacy', prompt: 'resume' }), { code: 'FILE_TYPE' });
  assert.deepEqual(await bridge.store.load(), original);
  assert.equal(server.createdTargets.length, 0);
  assert.equal(service.requests.length, 0);
  assert.equal(service.nativeSends?.length ?? 0, 0);
});

test('attachments: PDF bytes renamed as JS are refused before upload', async t => {
  const { root, service, server, bridge } = await nativeBridge(t);
  for (const [name, bytes] of [['renamed.js', SAMPLE_PDF], ['prefixed.js', Buffer.concat([Buffer.from('\n '), SAMPLE_PDF])]]) {
    const path = join(root, name);
    await fs.writeFile(path, bytes);
    await assert.rejects(bridge.ask({ session: 'renamed-pdf', prompt: 'inspect', attachments: [path] }), { code: 'FILE_TYPE' });
  }
  const { prepareAttachments } = await import('../src/attachments.mjs');
  const reference = join(root, 'reference.js');
  await fs.writeFile(reference, 'export const signature = "%PDF-1.4";\n');
  assert.equal((await prepareAttachments([reference], bridge.config))[0].name, 'reference.js');
  assert.equal(server.createdTargets.length, 0);
  assert.equal(service.requests.length, 0);
  assert.equal((await bridge.store.load()).sessions.length, 0);
});

test('attachments: an old completed PDF send can still be reconciled without resending', async t => {
  const { uploadPaths, service, bridge } = await nativeBridge(t);
  service.nativeFailure = 'afterCommit';
  await assert.rejects(bridge.ask({ session: 'legacy-send', prompt: 'inspect', attachments: uploadPaths }), error => error.details.pending === true);
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  assert.equal(entry.pending.kind, 'send');
  const fileId = OBSERVED_HUMAN_ATTACHMENTS.files[1].file_uuid;
  entry.pending.attachments.push({
    name: 'sample.pdf', kind: 'document', mimeType: 'application/pdf', size: SAMPLE_PDF.length,
    sha256: createHash('sha256').update(SAMPLE_PDF).digest('hex'), fileId,
  });
  await bridge.store.withLock(() => bridge.store.save(state));
  const human = service.convs.get(entry.conversationId).chat_messages[0];
  human.files.push({ file_uuid: fileId, file_name: 'sample.pdf', file_kind: 'document', size_bytes: SAMPLE_PDF.length });
  const sendsBefore = service.nativeSends.length;
  const uploadsBefore = service.uploads.length;

  assert.equal((await bridge.transcript({ session: 'legacy-send', recover: true })).recovered, true);
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
  assert.equal(service.nativeSends.length, sendsBefore);
  assert.equal(service.uploads.length, uploadsBefore);
});

test('attachments: an unknown binary identity cannot be adopted', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  service.hideUploadFinish = record => record.kind === 'image';
  await assert.rejects(bridge.ask({ session: 'unknown-id', prompt: 'first', attachments: uploadPaths }), { code: 'UI_NOT_READY' });
  service.hideUploadFinish = null;
  const before = await bridge.store.load();
  const targetsBefore = server.createdTargets.length;
  await assert.rejects(bridge.resumeNativeUpload({ session: 'unknown-id', prompt: 'resume' }), { code: 'FILE_NOT_READY' });
  assert.deepEqual(await bridge.store.load(), before);
  assert.equal(server.createdTargets.length, targetsBefore);
  assert.equal(service.nativeSends?.length ?? 0, 0);
});

test('attachments: restored draft refuses an ID different from a recorded receipt', async () => {
  const { resolveAdoptedAttachments } = await import('../src/attachments.mjs');
  const original = '11111111-1111-4111-8111-111111111111';
  const replacement = '22222222-2222-4222-8222-222222222222';
  const manifest = [{ name: 'sample.png', kind: 'image', mimeType: 'image/png', size: SAMPLE_PNG.length,
    sha256: createHash('sha256').update(SAMPLE_PNG).digest('hex'), fileId: original }];
  const draft = { editorText: '', entries: [{ name: 'sample.png', kind: 'image', size: SAMPLE_PNG.length, fileId: replacement }] };
  assert.throws(() => resolveAdoptedAttachments(manifest, draft), { code: 'UI_DRAFT_CONFLICT' });
});

test('attachments: artifacts bind Frame publication versions but refuse unverified originals', async t => {
  const { publicArtifacts, completedAssistant } = await import('../src/core/artifacts.mjs');
  const message = { uuid: CONV_ID, sender: 'assistant', text: '', stop_reason: 'end_turn', truncated: false, content: [structuredClone(OBSERVED_FRAME_PUBLICATION)] };
  const first = publicArtifacts(CONV_ID, [message])[0];
  assert.equal(first.kind, 'frame-artifact');
  assert.equal(first.downloadable, false);
  assert.equal(completedAssistant(CONV_ID, message), true);
  const data = JSON.parse(message.content[0].content[0].text);
  data.version = '0000000001-next';
  message.content[0].content[0].text = JSON.stringify(data);
  assert.notEqual(publicArtifacts(CONV_ID, [message])[0].id, first.id);
  const { bridge, service } = await nativeBridge(t);
  service.replyText = '';
  service.afterNativeSend = conv => { conv.chat_messages.at(-1).content = [structuredClone(OBSERVED_FRAME_PUBLICATION)]; };
  const reply = await bridge.ask({ session: 'frame', prompt: 'publish', native: true });
  assert.equal(reply.artifacts[0].downloadable, false);
  await assert.rejects(bridge.download({ session: 'frame', artifact: reply.artifacts[0].id }), { code: 'FRAME_EXPORT_UNVERIFIED' });
  assert.equal(service.requests.filter(r => r.path.endsWith('/contents')).length, 0);
});

async function frameSession(t, content, extra = {}) {
  const context = await nativeBridge(t, extra);
  context.service.replyText = '';
  context.service.afterNativeSend = conv => { conv.chat_messages.at(-1).content = structuredClone(content); };
  const reply = await context.bridge.ask({ session: 'frame', prompt: 'publish', native: true });
  return { ...context, reply };
}

test('attachments: frame download writes the provable Write original bound to each version', async t => {
  const second = '<!doctype html><html><head><title>Second</title></head><body>v2</body></html>';
  const { bridge, service, reply } = await frameSession(t, [
    { type: 'text', text: 'publishing' }, ...observedFrameChain(),
    ...observedFrameChain({ tag: 'b', page: second, slug: '88888888-aaaa-4bbb-8ccc-ddddeeeeffff', version: '0000000001-next' }),
  ], { readyTimeoutMs: 3000 });
  assert.deepEqual(reply.artifacts.map(a => [a.kind, a.downloadable, a.unsupportedReason]), [['frame-artifact', true, undefined], ['frame-artifact', true, undefined]]);
  assert.notEqual(reply.artifacts[0].id, reply.artifacts[1].id);
  const first = await bridge.download({ session: 'frame', artifact: reply.artifacts[0].id });
  assert.equal((await fs.readFile(first.path)).toString('utf8'), SYNTHETIC_FRAME_PAGE);
  assert.equal(first.path, join(await fs.realpath(bridge.config.stateDir), 'downloads', 'index.html'));
  assert.equal(first.sha256, createHash('sha256').update(SYNTHETIC_FRAME_PAGE).digest('hex'));
  assert.deepEqual([first.size, first.mimeType, first.sourceMimeType, first.artifact.version], [Buffer.byteLength(SYNTHETIC_FRAME_PAGE), 'text/html', null, '0000000000-test']);
  assert.equal((await fs.stat(first.path)).mode & 0o777, 0o600);
  await assert.rejects(bridge.download({ session: 'frame', artifact: reply.artifacts[0].id }), { code: 'FILE_EXISTS' });
  assert.equal((await fs.readFile(first.path)).toString('utf8'), SYNTHETIC_FRAME_PAGE);
  const next = await bridge.download({ session: 'frame', artifact: reply.artifacts[1].id, destination: 'next.html' });
  assert.equal((await fs.readFile(next.path)).toString('utf8'), second);
  assert.equal(next.artifact.version, '0000000001-next');
  assert.equal(service.requests.filter(r => r.path.endsWith('/contents')).length, 0);
});

test('attachments: frame provenance refuses any chain that cannot prove the published bytes', async t => {
  const { publicArtifacts } = await import('../src/core/artifacts.mjs');
  const meta = (blocks, i) => JSON.parse(blocks[i].content[0].text);
  const cases = {
    'no tool_use_id': b => { delete b[4].tool_use_id; },
    'publish call missing': b => { b.splice(3, 1); },
    'tool between write and publish': b => { b.splice(2, 0, { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'sed -i s/a/b/ f' } }, { type: 'tool_result', tool_use_id: 'toolu_x', name: 'Bash', is_error: false, content: [] }); },
    'parallel tool before write result': b => { b.splice(1, 0, { type: 'tool_use', id: 'toolu_y', name: 'Edit', input: {} }); },
    'tool between publish call and result': b => { b.splice(4, 0, { type: 'tool_use', id: 'toolu_z', name: 'Bash', input: {} }); },
    'write failed': b => { b[1].is_error = true; },
    'write result for another call': b => { b[1].tool_use_id = 'toolu_other'; },
    'path differs': b => { b[3].input.files[0].path = '/home/claude/other.html'; },
    'two files': b => { b[3].input.files.push({ path: '/home/claude/style.css', as: 'style.css' }); },
    'not published as index': b => { b[3].input.files[0].as = 'page.html'; },
    'republish with slug': b => { b[3].input.slug = meta(b, 4).slug; b[3].input.base_version = 'x'; },
    'multi-file artifact': b => { const d = meta(b, 4); d.own_file_count = 2; b[4].content[0].text = JSON.stringify(d); },
    'later sequence': b => { const d = meta(b, 4); d.seq = 2; d.history = ['0000000000-old', d.version]; b[4].content[0].text = JSON.stringify(d); },
    'not html': b => { b[0].input.content = 'just text'; },
    'empty page': b => { b[0].input.content = ''; },
    'oversized page': b => { b[0].input.content = `<!DOCTYPE html>${'a'.repeat(2 * 1024 * 1024)}`; },
    'non-ASCII page': b => { b[0].input.content = '<!DOCTYPE html><html><body>编码 café 🎉</body></html>\n'; },
    'CRLF line endings': b => { b[0].input.content = '<!DOCTYPE html>\r\n<html><body>x</body></html>\r\n'; },
    'BOM-prefixed page': b => { b[0].input.content = '\uFEFF<!DOCTYPE html><html><body>x</body></html>\n'; },
    'lone surrogate': b => { b[0].input.content = '<!DOCTYPE html><html><body>\uD800</body></html>\n'; },
    'duplicate publish call id': b => { b.splice(3, 0, { ...structuredClone(b[3]), input: { files: [{ path: '/home/claude/x.html', as: 'index.html' }] } }); },
  };
  const base = { uuid: CONV_ID, sender: 'assistant', stop_reason: 'end_turn', truncated: false };
  const sources = new Map();
  assert.equal(publicArtifacts(CONV_ID, [{ ...base, content: observedFrameChain() }], sources)[0].downloadable, true);
  assert.equal(sources.size, 1);
  const tabbed = observedFrameChain({ page: '<!DOCTYPE html>\n<html>\n\t<body>tab-indented</body>\n</html>\n' });
  assert.equal(publicArtifacts(CONV_ID, [{ ...base, content: tabbed }])[0].downloadable, true);
  for (const [name, mutate] of Object.entries(cases)) {
    const blocks = observedFrameChain();
    mutate(blocks);
    const found = new Map();
    const [artifact] = publicArtifacts(CONV_ID, [{ ...base, content: blocks }], found);
    assert.deepEqual([artifact?.downloadable, artifact?.unsupportedReason, found.size], [false, 'FRAME_EXPORT_UNVERIFIED', 0], name);
  }
  const twin = observedFrameChain({ tag: 'b', page: '<!DOCTYPE html><html><body>other</body></html>' });
  assert.throws(() => publicArtifacts(CONV_ID, [{ ...base, content: [...observedFrameChain(), ...twin] }]), { code: 'API_CONTRACT' });
  const { bridge, service, reply } = await frameSession(t, (() => { const b = observedFrameChain(); b[1].is_error = true; return b; })());
  await assert.rejects(bridge.download({ session: 'frame', artifact: reply.artifacts[0].id }), { code: 'FRAME_EXPORT_UNVERIFIED' });
  assert.deepEqual(await fs.readdir(join(bridge.config.stateDir, 'downloads')).catch(() => []), []);
  assert.equal(service.requests.filter(r => r.path.endsWith('/contents')).length, 0);
});

test('attachments: frame download cancellation leaves no file and releases the lock', async t => {
  const { bridge, service, reply } = await frameSession(t, observedFrameChain());
  const handle = service.handle.bind(service);
  const controller = new AbortController();
  service.handle = async request => {
    if (request.path.includes('/chat_conversations/')) controller.abort();
    return handle(request);
  };
  await assert.rejects(bridge.download({ session: 'frame', artifact: reply.artifacts[0].id }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.deepEqual(await fs.readdir(join(bridge.config.stateDir, 'downloads')).catch(() => []), []);
  await assert.rejects(fs.stat(bridge.store.lockFile), { code: 'ENOENT' });
});

test('attachments: recovery never navigates or closes a reclaimed pre-navigation page or draft', async t => {
  for (const mode of ['path', 'draft']) {
    const { service, server, bridge } = await nativeBridge(t);
    const handle = service.handle.bind(service);
    const navigations = [];
    server.onMessage = msg => { if (msg.method === 'Page.navigate') navigations.push(msg); };
    service.handle = async request => {
      const result = await handle(request);
      if (request.method === 'POST' && request.path.endsWith('/chat_conversations')) {
        const page = [...server.pages.values()].at(-1);
        if (mode === 'path') page.sandbox.location.pathname = `/chat/${CONV_ID}`;
        else page.editor.innerText = 'user draft';
      }
      return result;
    };
    await assert.rejects(bridge.ask({ session: 'reclaimed', prompt: 'not sent', native: true }));
    assert.equal(navigations.length, 0);
    assert.equal(service.nativeSends?.length ?? 0, 0);
    assert.equal(server.closedTargets.length, 0);
  }
});

test('attachments: remote source stops when a plain read page is reclaimed', async t => {
  const { bridge, artifacts, service, server } = await outputSession(t);
  const handle = service.handle.bind(service);
  service.handle = async request => {
    const result = await handle(request);
    if (request.method === 'GET' && request.path.includes('chat_conversations/')) {
      [...server.pages.values()].at(-1).sandbox.location.pathname = `/chat/${CONV_ID}`;
    }
    return result;
  };
  await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[0].id }), { code: 'UI_CONTEXT_LOST' });
  assert.equal(service.requests.filter(r => r.path.endsWith('/contents')).length, 0);
  assert.equal(server.closedTargets.length, 1);
  assert.equal(server.createdTargets.length, 2);
});

test('attachments: download reports incomplete cleanup without deleting a replacement', async t => {
  const { bridge, artifacts, service } = await outputSession(t);
  const handle = service.handle.bind(service);
  let replacement;
  service.handle = async request => {
    if (request.path.endsWith('/contents')) {
      const root = join(bridge.config.stateDir, 'downloads');
      const name = (await fs.readdir(root)).find(name => name.startsWith('.ccw-'));
      replacement = join(root, name);
      await fs.rename(replacement, `${replacement}.moved`);
      await fs.writeFile(replacement, 'replacement owned by another actor');
      return { status: 503, contentType: 'application/json', body: '{}' };
    }
    return handle(request);
  };
  await assert.rejects(bridge.download({ session: 'outputs', artifact: artifacts[0].id }), error => {
    assert.equal(error.details.cleanupPending, true);
    return true;
  });
  assert.equal(await fs.readFile(replacement, 'utf8'), 'replacement owned by another actor');
});

test('attachments: download permits absent MIME only for verified file formats', async t => {
  const { bridge, service, artifacts } = await outputSession(t);
  const originals = [...service.files.values()];
  originals.forEach(file => { file.mimeType = ''; });
  for (let index = 0; index < artifacts.length; index++) {
    const result = await bridge.download({ session: 'outputs', artifact: artifacts[index].id });
    assert.deepEqual(await fs.readFile(result.path), originals[index].bytes);
    assert.equal(result.sourceMimeType, null);
  }
  const { validateDownload } = await import('../src/attachments.mjs');
  assert.equal(validateDownload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'drawing.svg', '').mimeType, 'image/svg+xml');
  assert.equal(validateDownload(Buffer.from('# result'), 'result.md', '').mimeType, 'text/markdown');
  for (const [bytes, name] of [
    [Buffer.from('<!doctype html><html>login</html>'), 'result.md'],
    [Buffer.from('{"error":"login"}'), 'result.js'],
    [Buffer.from('not a PDF'), 'result.pdf'],
    [Buffer.from('opaque'), 'unknown.bin'],
  ]) assert.throws(() => validateDownload(bytes, name, ''), { code: name.endsWith('.pdf') ? 'FILE_TYPE' : 'FILE_CONTENT' });
});

test('attachments: recovery preserves user drafts after upload failure timeout or cancellation', async t => {
  for (const mode of ['failed', 'timeout', 'abort']) {
    const { paths, service, server, bridge } = await nativeBridge(t, { readyTimeoutMs: 80 });
    const controller = new AbortController();
    let page;
    service.pauseUploads = mode === 'timeout';
    service.beforeUploadResponse = data => {
      page = [...server.pages.values()][0];
      page.editor.innerText = 'new user draft';
      if (mode === 'failed') data.success = false;
      if (mode === 'abort') controller.abort();
    };
    await assert.rejects(bridge.ask({ session: mode, prompt: 'inspect', attachments: [paths[0]] }, { signal: controller.signal }));
    assert.equal(server.closedTargets.length, 0, mode);
    assert.equal(page.editor.innerText, 'new user draft');
    assert.equal(service.nativeSends?.length ?? 0, 0);
    assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'upload');
  }
});

// ---------- adopting a restored draft for an uncertain upload ---------------

const restoredDraftRow = (conversationId, files) => ({
  key: `store:chat-draft:${conversationId}`,
  state: {
    tipTapEditorState: { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
    attachments: files.filter(f => f.kind === 'text').map(f => ({
      file_name: f.name, file_type: f.mimeType, file_size: f.bytes.length,
      extracted_content: f.bytes.toString('utf8'), origin: 'user_upload', kind: 'file',
    })),
    files: files.filter(f => f.kind !== 'text').map(f => ({
      file_name: f.name, file_kind: f.kind, size_bytes: f.bytes.length,
      file_uuid: `client-${f.name}`, serverFileUuid: f.fileId, success: true,
    })),
  },
});

test('attachments: native submit refuses a changed file ID before clicking', async t => {
  const { paths, service, server, bridge } = await nativeBridge(t);
  let swapped = false;
  server.onMessage = message => {
    if (message.method !== 'Runtime.evaluate' || !message.params?.expression?.includes('"action":"ready"')) return;
    const page = server.pages.get(message.sessionId);
    if (!page?.nativeFiles?.length || swapped) return;
    page.nativeFiles[0].fileId = '22222222-2222-4222-8222-222222222222';
    const id = page.sandbox.location.pathname.split('/').at(-1);
    page.draftStore.set(`store:chat-draft:${id}`, restoredDraftRow(id, page.nativeFiles));
    swapped = true;
  };
  await assert.rejects(bridge.ask({ session: 'changed-id', prompt: 'inspect', attachments: [paths[0]] }), { code: 'UI_DRAFT_CONFLICT' });
  assert.equal(swapped, true);
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'upload');
});

test('attachments: native send waits for the page to persist the uploaded draft exactly', async t => {
  for (const mode of ['placeholder', 'missing']) {
    const { uploadPaths, service, server, bridge } = await nativeBridge(t);
    let reads = 0;
    service.onDraftRead = response => {
      if (++reads !== 1) return;
      response.result = structuredClone(response.result);
      if (mode === 'missing') response.result = undefined;
      else response.result.state.files[0].file_kind = 'blob';
    };
    const result = await bridge.ask({ session: 'lagged', prompt: 'inspect', attachments: uploadPaths });
    assert.equal(reads, 2, mode);
    assert.deepEqual([service.nativeSends.length, result.attachments.length], [1, 2], mode);
    assert.equal(server.closedTargets.length, 1, mode);
  }
});

test('attachments: draft settling times out or aborts without losing upload identity or sending', async t => {
  for (const mode of ['timeout', 'abort', 'navigation']) {
    const { uploadPaths, service, server, bridge } = await nativeBridge(t);
    const controller = new AbortController();
    let timer;
    service.onDraftRead = (response, page) => {
      response.result = structuredClone(response.result);
      response.result.state.files[0].file_kind = 'blob';
      if (mode === 'abort' && !timer) timer = setTimeout(() => controller.abort(), 10);
      if (mode === 'navigation') page.sandbox.location.pathname = '/new';
    };
    t.after(() => clearTimeout(timer));
    await assert.rejects(bridge.ask({ session: mode, prompt: 'inspect', attachments: uploadPaths }, { signal: controller.signal }),
      // a placeholder that never settles reports its own transient code, not an operator conflict
      { code: { timeout: 'FILE_NOT_READY', abort: 'ABORTED', navigation: 'UI_CONTEXT_LOST' }[mode] });
    assert.equal(service.nativeSends?.length ?? 0, 0, mode);
    assert.equal(service.uploads.length, 2, mode);
    assert.equal(server.closedTargets.length, 0, mode);
    const entry = (await bridge.store.load()).sessions[0];
    assert.equal(entry.pending.kind, 'upload', mode);
    assert.equal(entry.pending.attachments.find(file => file.kind === 'image').fileId,
      service.uploads.find(file => file.kind === 'image').fileId, mode);
  }
});

test('attachments: a permanent draft conflict fails fast instead of settling into its timeout', async t => {
  for (const mode of ['size', 'text', 'extra']) {
    const { uploadPaths, service, server, bridge } = await nativeBridge(t);
    let reads = 0;
    service.onDraftRead = (response, page) => {
      reads += 1;
      response.result = structuredClone(response.result);
      if (mode === 'size') response.result.state.files[0].size_bytes += 1;
      if (mode === 'extra') response.result.state.files.push({ file_name: 'other.png', file_kind: 'image', size_bytes: 1, serverFileUuid: '99999999-8888-4777-8666-555544443333' });
      if (mode === 'text') page.editor.innerText = 'someone else typed this';
    };
    await assert.rejects(bridge.ask({ session: mode, prompt: 'inspect', attachments: uploadPaths }), { code: 'UI_DRAFT_CONFLICT' });
    assert.equal(reads, 1, `${mode}: an unretryable conflict must be reported on the first read`);
    assert.equal(service.nativeSends?.length ?? 0, 0, mode);
    assert.equal(server.closedTargets.length, 0, mode);
    assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'upload', mode);
  }
});

test('attachments: guided native resume preserves the original pending prompt identity', async t => {
  const { uploadPaths, service, server, config, bridge: web } = await nativeBridge(t);
  const bridge = new ConsultBridge(config, { mode: 'web', web, webStore: web.store });
  const prompt = '最初的\n问题';
  const canonical = `${prompt}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`;
  service.onDraftRead = response => {
    response.result = structuredClone(response.result);
    response.result.state.files[0].file_kind = 'blob';
  };
  await assert.rejects(bridge.ask({ session: 'guided-draft', prompt, attachments: uploadPaths, guidance: true }),
    { code: 'FILE_NOT_READY' });
  service.onDraftRead = null;
  const state = await web.store.load();
  const entry = state.sessions[0];
  const initialDigest = entry.pending.promptSha256;
  assert.equal(initialDigest, createHash('sha256').update(canonical).digest('hex'));
  const uploaded = service.uploads.map(file => ({ ...file }));
  assert.equal(entry.pending.attachments.find(file => file.kind === 'image').fileId, uploaded.find(file => file.kind === 'image').fileId);
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(entry.conversationId)) return;
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.editor.innerText = '';
    page.nativePrompt = '';
    page.draftStore.set(`store:chat-draft:${entry.conversationId}`, restoredDraftRow(entry.conversationId, uploaded));
  };

  const targetsBefore = server.createdTargets.length;
  const requestsBefore = service.requests.length;
  const pendingBefore = await web.store.load();
  for (const args of [
    { prompt: '不同的问题', guidance: true },
    { prompt, guidance: false },
    { prompt: `${prompt} `, guidance: true },
    { prompt: `${prompt}\n\n【可执行指导要求 v2】\n旧版内容\n【可执行指导要求结束】`, guidance: false },
  ]) {
    await assert.rejects(bridge.resumeNativeUpload({ session: 'guided-draft', ...args }), { code: 'PROMPT_MISMATCH' });
    assert.deepEqual(await web.store.load(), pendingBefore);
    assert.equal(server.createdTargets.length, targetsBefore, 'mismatch must not open a browser tab');
    assert.equal(service.requests.length, requestsBefore, 'mismatch must not make a browser request');
    assert.equal(service.nativeSends?.length ?? 0, 0);
    assert.equal(service.uploads.length, uploaded.length);
  }

  const result = await bridge.resumeNativeUpload({ session: 'guided-draft', prompt: '  最初的\r\n问题', guidance: true });
  assert.equal(result.adopted, true);
  assert.equal(result.guidanceAppended, true);
  assert.equal(service.nativeSends.length, 1);
  assert.equal(service.uploads.length, uploaded.length);
  assert.equal(service.convs.get(entry.conversationId).chat_messages.at(-2).content[0].text, canonical);
  assert.equal((await web.store.load()).sessions[0].pending, null);
});

test('attachments: a caller-composed legacy guidance block can be resumed after a contract change', async t => {
  const { uploadPaths, service, server, config, bridge: web } = await nativeBridge(t);
  const bridge = new ConsultBridge(config, { mode: 'web', web, webStore: web.store });
  const prompt = '旧问题\n\n【可执行指导要求 v2】\n旧版完整内容\n【可执行指导要求结束】';
  service.onDraftRead = response => {
    response.result = structuredClone(response.result);
    response.result.state.files[0].file_kind = 'blob';
  };
  await assert.rejects(bridge.ask({ session: 'old-guidance', prompt, attachments: uploadPaths }), { code: 'FILE_NOT_READY' });
  service.onDraftRead = null;
  const state = await web.store.load();
  const entry = state.sessions[0];
  const uploaded = service.uploads.map(file => ({ ...file }));
  assert.equal(entry.pending.attachments.find(file => file.kind === 'image').fileId, uploaded.find(file => file.kind === 'image').fileId);
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(entry.conversationId)) return;
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.editor.innerText = '';
    page.nativePrompt = '';
    page.draftStore.set(`store:chat-draft:${entry.conversationId}`, restoredDraftRow(entry.conversationId, uploaded));
  };

  const result = await bridge.resumeNativeUpload({ session: 'old-guidance', prompt });
  assert.equal(result.adopted, true);
  assert.equal(result.guidanceAppended, false);
  assert.equal(service.nativeSends.length, 1);
  assert.equal(service.uploads.length, uploaded.length);
  assert.equal(service.convs.get(entry.conversationId).chat_messages.at(-2).content[0].text, prompt);
  assert.equal((await web.store.load()).sessions[0].pending, null);
});

test('attachments: ambiguous replacement-character pending never opens a browser or submits', async t => {
  const { uploadPaths, service, server, config, bridge: web } = await nativeBridge(t);
  const bridge = new ConsultBridge(config, { mode: 'web', web, webStore: web.store });
  const prompt = '历史文本�';
  const legacyOriginal = '历史文本\ud800';
  assert.equal(createHash('sha256').update(prompt).digest('hex'), createHash('sha256').update(legacyOriginal).digest('hex'));
  service.onDraftRead = response => {
    response.result = structuredClone(response.result);
    response.result.state.files[0].file_kind = 'blob';
  };
  await assert.rejects(bridge.ask({ session: 'legacy-unicode', prompt, attachments: uploadPaths }), { code: 'FILE_NOT_READY' });
  service.onDraftRead = null;
  const state = await web.store.load();
  const entry = state.sessions[0];
  const uploaded = service.uploads.map(file => ({ ...file }));
  assert.equal(entry.pending.attachments.find(file => file.kind === 'image').fileId, uploaded.find(file => file.kind === 'image').fileId);
  const targetsBefore = server.createdTargets.length;
  const requestsBefore = service.requests.length;
  for (const restoredText of ['', prompt]) {
    server.onNavigate = (page, url) => {
      if (!url.pathname.endsWith(entry.conversationId)) return;
      page.nativeFiles = uploaded.map(file => ({ ...file }));
      page.editor.innerText = restoredText;
      page.nativePrompt = restoredText;
      page.draftStore.set(`store:chat-draft:${entry.conversationId}`, restoredDraftRow(entry.conversationId, uploaded));
    };
    await assert.rejects(bridge.resumeNativeUpload({ session: 'legacy-unicode', prompt }), { code: 'PROMPT_IDENTITY_AMBIGUOUS' });
    assert.deepEqual(await web.store.load(), state);
    assert.equal(service.nativeSends?.length ?? 0, 0);
    assert.equal(server.createdTargets.length, targetsBefore);
    assert.equal(service.requests.length, requestsBefore);
    assert.equal(service.uploads.length, uploaded.length);
  }
});

test('attachments: legacy replacement-character history still reconciles without resending', async t => {
  const { uploadPaths, service, bridge } = await nativeBridge(t);
  const prompt = '历史文本�';
  service.nativeFailure = 'afterCommit';
  await assert.rejects(bridge.ask({ session: 'legacy-history', prompt, attachments: uploadPaths }), error => error.details.pending === true);
  const before = await bridge.store.load();
  assert.equal(before.sessions[0].pending.kind, 'send');
  const sends = service.nativeSends.length;
  const uploads = service.uploads.length;
  const result = await bridge.transcript({ session: 'legacy-history', recover: true });
  assert.equal(result.recovered, true);
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
  assert.equal(service.nativeSends.length, sends);
  assert.equal(service.uploads.length, uploads);
});

test('attachments: native-resume settles a draft that is still persisting the upload', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  // the image upload response is never observed, so the first attempt stays pending: upload
  service.hideUploadFinish = record => record.kind === 'image';
  await assert.rejects(bridge.ask({ session: 'resume-settle', prompt: 'resume', attachments: uploadPaths }),
    error => error.code === 'UI_NOT_READY' && error.details.browserCleanup?.closeUnconfirmed === true);
  service.hideUploadFinish = null;
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  const uploaded = service.uploads.map(file => ({ ...file }));
  const uploadsBefore = service.uploads.length;
  entry.pending.attachments.find(file => file.name === 'sample.png').fileId = uploaded.find(file => file.name === 'sample.png').fileId;
  await bridge.store.withLock(() => bridge.store.save(state));
  const conversationId = entry.conversationId;
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(conversationId)) return;
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.draftStore.set(`store:chat-draft:${conversationId}`, restoredDraftRow(conversationId, uploaded));
  };
  // the recovery path must tolerate the same placeholder the normal send path tolerates
  let reads = 0;
  service.onDraftRead = (response, page) => {
    reads += 1;
    if (reads !== 1) return;
    response.result = structuredClone(response.result);
    response.result.state.files[0].file_kind = 'blob';
    page.draftStore.set(`store:chat-draft:${conversationId}`, restoredDraftRow(conversationId, uploaded));
  };
  const result = await bridge.resumeNativeUpload({ session: 'resume-settle', prompt: 'resume' });
  assert.equal(result.adopted, true);
  assert.ok(reads >= 2, 'the recovery path must re-read the draft instead of refusing on the placeholder');
  assert.equal(service.uploads.length, uploadsBefore, 'no file may be uploaded again');
  assert.equal(service.nativeSends.length, 1, 'exactly one submission');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: restored draft rechecks a branch changed during navigation', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  service.hideUploadFinish = record => record.kind === 'image';
  await assert.rejects(bridge.ask({ session: 'moved-during-adopt', prompt: 'first', attachments: uploadPaths }), { code: 'UI_NOT_READY' });
  service.hideUploadFinish = null;
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  const uploaded = service.uploads.map(file => ({ ...file }));
  entry.pending.attachments.find(file => file.kind === 'image').fileId = uploaded.find(file => file.kind === 'image').fileId;
  await bridge.store.withLock(() => bridge.store.save(state));
  const conversation = service.convs.get(entry.conversationId);
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(entry.conversationId)) return;
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.draftStore.set(`store:chat-draft:${entry.conversationId}`, restoredDraftRow(entry.conversationId, uploaded));
    service.commitTurn(conversation, 'other turn', entry.pending.parentMessageId, 'other response');
  };
  await assert.rejects(bridge.resumeNativeUpload({ session: 'moved-during-adopt', prompt: 'first' }), { code: 'REMOTE_BRANCH_CHANGED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'upload');
});

test('attachments: native-resume rechecks a branch changed at the click boundary', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  service.hideUploadFinish = record => record.kind === 'image';
  await assert.rejects(bridge.ask({ session: 'resume-moved', prompt: 'first', attachments: uploadPaths }), { code: 'UI_NOT_READY' });
  service.hideUploadFinish = null;
  const state = await bridge.store.load();
  const entry = state.sessions[0];
  const uploaded = service.uploads.map(file => ({ ...file }));
  entry.pending.attachments.find(file => file.kind === 'image').fileId = uploaded.find(file => file.kind === 'image').fileId;
  await bridge.store.withLock(() => bridge.store.save(state));
  const conversation = service.convs.get(entry.conversationId);
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(entry.conversationId)) return;
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.draftStore.set(`store:chat-draft:${entry.conversationId}`, restoredDraftRow(entry.conversationId, uploaded));
  };
  const handle = service.handle.bind(service);
  let reads = 0;
  service.handle = async request => {
    if (request.method === 'GET' && request.path.includes(`/chat_conversations/${entry.conversationId}?`)) reads += 1;
    if (reads === 3) {
      service.commitTurn(conversation, 'operator continued', entry.pending.parentMessageId, 'operator reply');
    }
    return handle(request);
  };
  await assert.rejects(bridge.resumeNativeUpload({ session: 'resume-moved', prompt: 'first' }), { code: 'REMOTE_BRANCH_CHANGED' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'send');
  assert.equal(server.closedTargets.length, 0);
});

for (const restoredText of ['', 'adopted draft']) test(`attachments: an uncertain upload adopts the restored draft and submits exactly once (${restoredText ? 'prefilled' : 'empty'})`, async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  // the image upload response is never observed, so the attempt stays pending: upload
  service.hideUploadFinish = record => record.kind === 'image';
  await assert.rejects(bridge.ask({ session: 'adopt', prompt: 'adopted draft', attachments: uploadPaths }),
    error => error.code === 'UI_NOT_READY' && error.details.browserCleanup?.closeUnconfirmed === true);
  service.hideUploadFinish = null;
  assert.equal(service.nativeSends?.length ?? 0, 0);
  let state = await bridge.store.load();
  assert.equal(state.sessions[0].pending.kind, 'upload');
  assert.equal(state.sessions[0].pending.attachments.find(f => f.name === 'sample.png').fileId, null);
  const conversationId = state.sessions[0].conversationId;
  const uploaded = service.uploads.map(f => ({ ...f }));
  const uploadsBefore = service.uploads.length;
  // Model a pending upload whose image receipt was already checkpointed.
  state.sessions[0].pending.attachments.find(f => f.name === 'sample.png').fileId = uploaded.find(f => f.name === 'sample.png').fileId;
  await bridge.store.withLock(() => bridge.store.save(state));

  // the browser restored the draft with the same attachments
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(conversationId)) return;
    page.nativeFiles = uploaded.map(f => ({ ...f }));
    page.editor.innerText = restoredText;
    page.nativePrompt = restoredText;
    page.draftStore.set(`store:chat-draft:${conversationId}`, restoredDraftRow(conversationId, uploaded));
  };

  const result = await bridge.resumeNativeUpload({ session: 'adopt', prompt: 'adopted draft' });
  assert.equal(result.adopted, true);
  assert.equal(result.reply, 'native reply');
  assert.equal(service.uploads.length, uploadsBefore, 'no file may be uploaded again');
  assert.equal(service.nativeSends.length, 1, 'exactly one submission');
  state = await bridge.store.load();
  assert.equal(state.sessions[0].pending, null);
  assert.equal(state.sessions[0].parentMessageId, result.assistantMessageId);
  const human = service.convs.get(conversationId).chat_messages.at(-2);
  assert.equal(human.content[0].text, 'adopted draft');
  assert.deepEqual(human.files.map(f => f.file_name).sort(), ['sample.png']);
  assert.deepEqual(result.attachments.filter(f => f.kind !== 'text').map(f => f.fileId).sort(),
    uploaded.filter(f => f.kind !== 'text').map(f => f.fileId).sort());
  assert.deepEqual(server.closedTargets, ['target-2']);
  assert.equal(server.pageFor('session-target-1').nativeFiles.length, 2);
  assert.ok(!JSON.stringify(state).includes(uploadPaths[0]));
});

test('attachments: adopting refuses a changed draft, a moved branch or a send that is already uncertain', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  service.hideUploadFinish = record => record.kind === 'image';
  await assert.rejects(bridge.ask({ session: 'adopt', prompt: 'x', attachments: uploadPaths }), { code: 'UI_NOT_READY' });
  service.hideUploadFinish = null;
  const state = await bridge.store.load();
  const conversationId = state.sessions[0].conversationId;
  const uploaded = service.uploads.map(f => ({ ...f }));
  state.sessions[0].pending.attachments.find(f => f.name === 'sample.png').fileId = uploaded.find(f => f.name === 'sample.png').fileId;
  await bridge.store.withLock(() => bridge.store.save(state));
  const sendsBefore = service.nativeSends?.length ?? 0;

  // a draft holding a different file never submits
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(conversationId)) return;
    page.nativeFiles = uploaded.map(f => ({ ...f }));
    const row = restoredDraftRow(conversationId, uploaded);
    row.state.files.find(f => f.file_name === 'sample.png').size_bytes += 2;
    page.draftStore.set(`store:chat-draft:${conversationId}`, row);
  };
  await assert.rejects(() => bridge.resumeNativeUpload({ session: 'adopt', prompt: 'x' }), { code: 'UI_DRAFT_CONFLICT' });
  assert.equal(service.nativeSends?.length ?? 0, sendsBefore);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'upload');
  assert.notDeepEqual(server.closedTargets, server.createdTargets.map(target => target.targetId));

  // a conversation that moved since the upload never submits
  const conv = service.convs.get(conversationId);
  service.commitTurn(conv, 'somebody else wrote here', '00000000-0000-4000-8000-000000000000', 'not ours');
  server.onNavigate = (page, url) => {
    if (!url.pathname.endsWith(conversationId)) return;
    page.nativeFiles = uploaded.map(f => ({ ...f }));
    page.draftStore.set(`store:chat-draft:${conversationId}`, restoredDraftRow(conversationId, uploaded));
  };
  await assert.rejects(() => bridge.resumeNativeUpload({ session: 'adopt', prompt: 'x' }), { code: 'REMOTE_BRANCH_CHANGED' });
  assert.equal(service.nativeSends?.length ?? 0, sendsBefore);

  // a send pending whose recorded prompt no longer matches is refused before the
  // browser opens; the same mismatch guards resumeNativeUpload on 'send' pendings
  const current = await bridge.store.load();
  const identified = state.sessions[0].pending.attachments.map(file => (file.kind !== 'text' && file.fileId === null
    ? { ...file, fileId: '77777777-8888-4999-8aaa-bbbbccccdddd' } : file));
  await bridge.store.save({
    ...current,
    sessions: [{
      ...current.sessions[0],
      pending: {
        kind: 'send', transport: 'native', parentMessageId: state.sessions[0].pending.parentMessageId,
        promptSha256: 'a'.repeat(64), startedAt: new Date().toISOString(), attachments: identified,
      },
    }],
  });
  await assert.rejects(() => bridge.resumeNativeUpload({ session: 'adopt', prompt: 'x' }), { code: 'PROMPT_MISMATCH' });
  await assert.rejects(() => bridge.resumeNativeUpload({ session: 'absent', prompt: 'x' }), { code: 'SESSION_NOT_FOUND' });
});

test('attachments: native-resume submits a send pending whose held draft was consumed', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  await assert.rejects(bridge.ask({ session: 'send-pending', prompt: 'consumed draft', native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  const stuck = (await bridge.store.load()).sessions[0];
  assert.equal(stuck.pending.kind, 'send');
  assert.equal(service.nativeSends?.length ?? 0, 0);
  server.onMessage = null;
  // the interrupted click consumed the draft: the composer comes back empty
  server.onNavigate = () => {};
  const result = await bridge.resumeNativeUpload({ session: 'send-pending', prompt: 'consumed draft' });
  assert.equal(result.adopted, true);
  assert.equal(service.nativeSends.length, 1);
  const human = service.convs.get(stuck.conversationId).chat_messages.at(-2);
  assert.equal(human.content[0].text, 'consumed draft');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: native-resume on a send pending refuses mismatches before any send', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  await assert.rejects(bridge.ask({ session: 'send-pending', prompt: 'ours', native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  const stuck = (await bridge.store.load()).sessions[0];
  assert.equal(stuck.pending.kind, 'send');
  server.onMessage = null;
  const targetsBefore = server.createdTargets.length;

  await assert.rejects(bridge.resumeNativeUpload({ session: 'send-pending', prompt: 'different prompt' }), { code: 'PROMPT_MISMATCH' });
  assert.equal(server.createdTargets.length, targetsBefore, 'both refusals happen before the browser opens');

  server.onNavigate = page => {
    page.editor.innerText = 'operator retyped this';
    page.nativePrompt = 'operator retyped this';
  };
  await assert.rejects(bridge.resumeNativeUpload({ session: 'send-pending', prompt: 'ours' }), { code: 'UI_DRAFT_CONFLICT' });
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'send');
});

test('attachments: native-resume on a send pending never opens the browser for ambiguous identity', async t => {
  const { service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  server.onMessage = message => {
    if (message.method === 'Runtime.evaluate' && message.params?.expression?.includes('"action":"ready"')) controller.abort();
  };
  const prompt = 'ambiguous � text';
  await assert.rejects(bridge.ask({ session: 'send-ambiguous', prompt, native: true }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'send');
  server.onMessage = null;
  const targetsBefore = server.createdTargets.length;
  await assert.rejects(bridge.resumeNativeUpload({ session: 'send-ambiguous', prompt }), { code: 'PROMPT_IDENTITY_AMBIGUOUS' });
  assert.equal(server.createdTargets.length, targetsBefore);
  assert.equal(service.nativeSends?.length ?? 0, 0);
  assert.equal((await bridge.store.load()).sessions[0].pending.kind, 'send');
});

test('attachments: native-resume on a send pending with files adopts verified chips only', async t => {
  const { uploadPaths, service, server, bridge } = await nativeBridge(t);
  const controller = new AbortController();
  const save = bridge.store.save.bind(bridge.store);
  bridge.store.save = async state => {
    const result = await save(state);
    if (state.sessions[0]?.pending?.kind === 'send') controller.abort();
    return result;
  };
  await assert.rejects(bridge.ask({ session: 'send-files', prompt: 'files turn', attachments: uploadPaths }, { signal: controller.signal }), { code: 'ABORTED' });
  const stuck = (await bridge.store.load()).sessions[0];
  assert.equal(stuck.pending.kind, 'send');
  assert.equal(service.nativeSends?.length ?? 0, 0);
  server.onMessage = null;
  const uploaded = service.uploads.map(file => ({ ...file }));
  const uploadsBefore = service.uploads.length;
  server.onNavigate = page => {
    page.nativeFiles = uploaded.map(file => ({ ...file }));
    page.editor.innerText = 'files turn';
    page.nativePrompt = 'files turn';
    page.draftStore.set(`store:chat-draft:${stuck.conversationId}`, restoredDraftRow(stuck.conversationId, uploaded));
  };
  const result = await bridge.resumeNativeUpload({ session: 'send-files', prompt: 'files turn' });
  assert.equal(result.adopted, true);
  assert.equal(service.nativeSends.length, 1);
  assert.equal(service.uploads.length, uploadsBefore, 'no file may be uploaded again');
  assert.equal((await bridge.store.load()).sessions[0].pending, null);
});

test('attachments: adopting is refused when there is no pending upload at all', async t => {
  const { bridge, uploadPaths } = await nativeBridge(t);
  await assert.rejects(() => bridge.resumeNativeUpload({ session: 'nothing', prompt: 'x' }), { code: 'SESSION_NOT_FOUND' });
  const done = await bridge.ask({ session: 'settled', prompt: 'with files', attachments: uploadPaths });
  assert.equal(done.ok, true);
  await assert.rejects(() => bridge.resumeNativeUpload({ session: 'settled', prompt: 'x' }), { code: 'NO_PENDING' });
});

test('attachments: adopted identities must match name, size, kind and text digest exactly', async () => {
  const { resolveAdoptedAttachments, digest } = await import('../src/attachments.mjs');
  const manifest = [
    { name: 'sample.png', kind: 'image', mimeType: 'image/png', size: SAMPLE_PNG.length, sha256: digest(SAMPLE_PNG), fileId: '55555555-6666-4777-8888-99990000aaaa' },
    { name: 'sample.js', kind: 'text', mimeType: 'text/javascript', size: SAMPLE_CODE.length, sha256: digest(SAMPLE_CODE), fileId: null },
  ];
  const good = {
    editorText: '\n',
    entries: [
      { name: 'sample.png', kind: 'image', size: SAMPLE_PNG.length, fileId: '55555555-6666-4777-8888-99990000aaaa', content: null },
      { name: 'sample.js', kind: 'text', size: SAMPLE_CODE.length, mimeType: 'text/javascript', content: SAMPLE_CODE.toString('utf8'), fileId: null },
    ],
  };
  const resolved = resolveAdoptedAttachments(manifest, good);
  assert.equal(resolved[0].fileId, '55555555-6666-4777-8888-99990000aaaa');
  assert.equal(resolved[1].fileId, null);

  const mutate = (fn) => {
    const draft = structuredClone(good);
    fn(draft);
    return draft;
  };
  for (const [label, draft, code] of [
    ['wrong digest', mutate(d => { d.entries[1].content = 'export function compute(x) { return x * 9 + 16; }\n'; }), 'UI_DRAFT_CONFLICT'],
    ['wrong size', mutate(d => { d.entries[0].size += 1; }), 'UI_DRAFT_CONFLICT'],
    ['wrong kind', mutate(d => { d.entries[0].kind = 'document'; }), 'UI_DRAFT_CONFLICT'],
    ['missing identity', mutate(d => { d.entries[0].fileId = null; }), 'FILE_NOT_READY'],
    ['missing attachment', mutate(d => { d.entries.pop(); }), 'UI_DRAFT_CONFLICT'],
    ['extra attachment', mutate(d => { d.entries.push({ name: 'extra.png', kind: 'image', size: 1, fileId: '66666666-7777-4888-9999-aaaa1111bbbb', content: null }); }), 'UI_DRAFT_CONFLICT'],
    ['foreign text', mutate(d => { d.editorText = 'typed by the user'; }), 'UI_DRAFT_CONFLICT'],
    ['no stored row', mutate(d => { d.entries = []; }), 'UI_DRAFT_CONFLICT'],
  ]) {
    assert.throws(() => resolveAdoptedAttachments(manifest, draft), { code }, label);
  }
});
