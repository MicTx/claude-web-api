import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { NativeComposer, chooseTransport, normalizeWebPrompt } from '../src/core/ui.mjs';
import { CONV_ID, ORG_ID, SAMPLE_PNG, FILE_PNG_ID } from './fixtures.mjs';
import { digest } from '../src/attachments.mjs';

export function composerDouble({ draft = '', labels = [], disabled = false, afterUpload, beforeClick, storedDraft = null } = {}) {
  const events = new Set();
  const calls = [];
  const commands = [];
  const bodies = new Map();
  const input = {
    innerText: draft,
    focus() {},
    getAttribute: name => name === 'contenteditable' ? 'true' : null,
  };
  const removers = labels.map(name => ({ getAttribute: () => `Remove ${name}` }));
  const send = { disabled, click() { beforeClick?.(); calls.push('click'); } };
  const fileInput = {
    multiple: true,
    files: [],
    dispatchEvent() {
      calls.push('attach');
      for (const file of this.files) removers.push({ getAttribute: () => `Remove ${file.name}` });
      afterUpload?.(this.files, emit, bodies);
    },
  };
  const location = { origin: 'https://claude.ai', pathname: `/chat/${CONV_ID}` };
  const document = {
    querySelector: selector => selector.includes('chat-input-send') ? send : selector.includes('chat-input') ? input : null,
    querySelectorAll: selector => selector.includes('type="file"') ? [fileInput] : selector.includes('aria-label') ? removers : [],
    execCommand(command, _, text) {
      assert.equal(command, 'insertText');
      calls.push('fill');
      input.innerText = text.replaceAll('\n', '\n\n');
      return true;
    },
  };
  class Transfer {
    files = [];
    items = { add: file => this.files.push(file) };
  }
  const rows = new Map();
  if (storedDraft !== null) rows.set(`store:chat-draft:${CONV_ID}`, storedDraft);
  const indexedDB = {
    open: () => {
      const request = {};
      setTimeout(() => {
        request.result = {
          transaction: () => ({
            objectStore: () => ({
              get: key => {
                const row = {};
                setTimeout(() => { row.result = rows.get(key); row.onsuccess?.(); }, 0);
                return row;
              },
            }),
          }),
          close() {},
        };
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  const context = vm.createContext({ document, location, File, Uint8Array, atob, DataTransfer: Transfer, Event, indexedDB, setTimeout, clearTimeout });
  const emit = (method, params, sessionId = 'own-session') => {
    for (const callback of events) callback({ method, params, sessionId });
  };
  const client = {
    subscribe: callback => { events.add(callback); return () => events.delete(callback); },
    async send(method, params, options) {
      calls.push(method);
      commands.push({ method, params, options });
      if (method === 'Network.getResponseBody') throw new Error('CDP Network.getResponseBody failed: Request content was evicted from inspector cache');
      if (method === 'Fetch.getResponseBody') return { body: JSON.stringify(bodies.get(params.requestId)), base64Encoded: false };
      return {};
    },
  };
  const tab = {
    client, sessionId: 'own-session', frameId: 'own-frame',
    config: { readyTimeoutMs: 80, timeoutMs: 1000, idleTimeoutMs: 1000 },
    async navigateConversation(id) { assert.equal(id, CONV_ID); },
    async evaluate(expression) { return vm.runInContext(expression, context); },
  };
  return { tab, calls, commands, input, send, fileInput, location, emit, bodies, events, removers, document };
}

const png = { name: 'sample.png', kind: 'image', mimeType: 'image/png', size: SAMPLE_PNG.length, sha256: digest(SAMPLE_PNG), bytes: SAMPLE_PNG };

test('ui: composer refuses a PDF before selecting files or filling a prompt', async () => {
  const { tab, calls } = composerDouble();
  const composer = new NativeComposer(tab, ORG_ID, CONV_ID);
  await assert.rejects(composer.attachFiles([{ name: 'sample.pdf', kind: 'document', mimeType: 'application/pdf', bytes: Buffer.from('pdf') }]), { code: 'FILE_TYPE' });
  assert.deepEqual(calls, []);
});

function uploadEvent(files, emit, bodies) {
  for (const [i, file] of files.entries()) {
    const requestId = `upload-${i}`;
    bodies.set(requestId, { success: true, file_uuid: FILE_PNG_ID, file_name: file.name, size_bytes: file.size, file_kind: 'image', preview_asset: { file_variant: 'preview' } });
    emit('Network.requestWillBeSent', { requestId, frameId: 'own-frame', request: { url: `https://claude.ai/api/${ORG_ID}/upload`, method: 'POST' } });
    emit('Network.responseReceived', { requestId, response: { status: 200, mimeType: 'application/json' } });
    emit('Network.loadingFinished', { requestId, encodedDataLength: 500 });
    emit('Fetch.requestPaused', { requestId, frameId: 'own-frame', request: { url: `https://claude.ai/api/${ORG_ID}/upload`, method: 'POST' },
      responseStatusCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }] });
  }
}

test('ui: transport is chosen before effects, never by retrying', () => {
  assert.equal(chooseTransport({}, []), 'rest');
  assert.equal(chooseTransport({ workspace_upgraded: false }, []), 'rest');
  assert.equal(chooseTransport({ workspace_upgraded: true }, []), 'native');
  assert.equal(chooseTransport({}, [png]), 'native');
  assert.equal(chooseTransport({}, [], true), 'native');
  assert.throws(() => chooseTransport({ workspace_upgraded: 'true' }, []), { code: 'API_CONTRACT' });
  assert.equal(normalizeWebPrompt('  first\r\nsecond  '), 'first\nsecond');
});

test('ui: exact draft is submitted once with prompt passed as data', async () => {
  const d = composerDouble();
  const c = new NativeComposer(d.tab, ORG_ID, CONV_ID);
  await c.open();
  const prompt = 'first\nsecond ` ${globalThis.bad = true}';
  await c.compose(prompt);
  await c.submit();
  await assert.rejects(c.submit(), { code: 'UI_ALREADY_SUBMITTED' });
  assert.equal(d.calls.filter(x => x === 'click').length, 1);
  assert.equal(d.input.innerText, prompt.replaceAll('\n', '\n\n'));
  await c.dispose();
  assert.equal(d.events.size, 0);
});

test('ui: draft, navigation and changed input fail closed', async () => {
  const existing = composerDouble({ draft: 'user draft' });
  const first = new NativeComposer(existing.tab, ORG_ID, CONV_ID);
  await assert.rejects(first.open(), { code: 'UI_DRAFT_CONFLICT' });
  assert.equal(existing.tab.retainTarget, true);
  await first.dispose();
  const d = composerDouble();
  const c = new NativeComposer(d.tab, ORG_ID, CONV_ID);
  await c.open();
  await c.compose('expected');
  d.input.innerText = 'changed';
  await assert.rejects(c.submit(), { code: 'UI_DRAFT_CONFLICT' });
  assert.ok(!d.calls.includes('click'));
  d.location.pathname = '/chat/another';
  await assert.rejects(c.assertScope(), { code: 'UI_CONTEXT_LOST' });
  await c.dispose();
});

test('ui: cleanup retains unexpected attachments and an unreadable composer', async () => {
  for (const mode of ['attachment', 'unreadable']) {
    const d = composerDouble();
    const composer = new NativeComposer(d.tab, ORG_ID, CONV_ID);
    await composer.open();
    if (mode === 'attachment') d.removers.push({ getAttribute: () => 'Remove user-added.png' });
    else d.document.querySelector = () => null;
    await composer.dispose();
    assert.equal(d.tab.retainTarget, true, mode);
  }
});

test('ui: binary snapshot becomes a File, upload identity is checkpointed before submit', async () => {
  const d = composerDouble({ afterUpload: uploadEvent });
  const receipts = [];
  const c = new NativeComposer(d.tab, ORG_ID, CONV_ID, { onUpload: receipt => receipts.push(receipt) });
  await c.open();
  await c.attachFiles([png]);
  await c.compose('inspect the image');
  assert.deepEqual(Buffer.from(await d.fileInput.files[0].arrayBuffer()), SAMPLE_PNG);
  assert.equal(d.fileInput.files[0].type, 'image/png');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].fileId, FILE_PNG_ID);
  assert.ok(!d.calls.includes('click'));
  await c.submit();
  assert.equal(d.calls.filter(x => x === 'attach').length, 1);
  await c.dispose();
  const count = method => d.calls.filter(x => x === method).length;
  assert.deepEqual(['Network.enable', 'Network.getResponseBody', 'Fetch.enable', 'Fetch.getResponseBody', 'Fetch.continueRequest', 'Fetch.disable'].map(count), [0, 0, 1, 1, 1, 1]);
  assert.deepEqual(d.commands.find(command => command.method === 'Fetch.enable').params.patterns,
    [{ urlPattern: `https://claude.ai/api/${ORG_ID}/upload`, requestStage: 'Response' }]);
});

test('ui: a failed upload release aborts the request and never submits', async () => {
  for (const failAbort of [false, true]) {
    const context = composerDouble({ afterUpload: uploadEvent });
    const send = context.tab.client.send.bind(context.tab.client);
    context.tab.client.send = async (method, params, options) => {
      const response = await send(method, params, options);
      if (method === 'Fetch.continueRequest' || (failAbort && method === 'Fetch.failRequest')) throw new Error('release failed');
      return response;
    };
    const composer = new NativeComposer(context.tab, ORG_ID, CONV_ID);
    await composer.open();
    await assert.rejects(composer.attachFiles([png]), { code: 'UPLOAD_UNCERTAIN' });
    await composer.dispose();
    assert.equal(context.calls.filter(method => method === 'Fetch.failRequest').length, 1);
    assert.equal(context.calls.includes('click'), false);
    assert.equal(context.calls.includes('Fetch.disable'), true);
  }
});

test('ui: an unreadable upload keeps its own failure as the cause of the release error', async () => {
  const context = composerDouble({ afterUpload(files, emit, bodies) {
    for (const [i, file] of files.entries()) {
      const requestId = `upload-${i}`;
      bodies.set(requestId, { error: 'rejected' });
      emit('Fetch.requestPaused', { requestId, frameId: 'own-frame', request: { url: `https://claude.ai/api/${ORG_ID}/upload`, method: 'POST' },
        responseStatusCode: 500, responseHeaders: [{ name: 'content-type', value: 'application/json' }] });
    }
  } });
  const send = context.tab.client.send.bind(context.tab.client);
  context.tab.client.send = async (method, params, options) => {
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') throw new Error('release failed');
    return send(method, params, options);
  };
  const composer = new NativeComposer(context.tab, ORG_ID, CONV_ID);
  await composer.open();
  await assert.rejects(composer.attachFiles([png]), error => {
    assert.equal(error.code, 'UPLOAD_UNCERTAIN', 'an unreleased request outranks the original failure');
    assert.equal(error.cause?.code, 'FILE_UPLOAD_FAILED', 'the original upload failure must survive as the cause');
    return true;
  });
  await composer.dispose();
  assert.equal(context.calls.includes('click'), false);
});

test('ui: interrupted upload body reads release without the cancelled signal', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const context = composerDouble({ afterUpload: uploadEvent });
    const send = context.tab.client.send.bind(context.tab.client);
    context.tab.client.send = async (method, params, options) => {
      const response = await send(method, params, options);
      if (method === 'Fetch.getResponseBody') {
        if (cancelled) controller.abort();
        throw new Error('body read failed');
      }
      return response;
    };
    const composer = new NativeComposer(context.tab, ORG_ID, CONV_ID, { signal: controller.signal });
    await composer.open();
    await assert.rejects(composer.attachFiles([png]));
    await composer.dispose();
    const release = context.commands.filter(command => command.method === 'Fetch.continueRequest');
    assert.equal(release.length, 1);
    assert.equal(release[0].options.signal, undefined);
    assert.equal(context.calls.includes('click'), false);
    assert.equal(context.calls.includes('Fetch.disable'), true);
  }
});

test('ui: cleanup drains late paused uploads and retains a page if interception cannot stop', async () => {
  for (const disableFailed of [false, true]) {
    const context = composerDouble();
    const send = context.tab.client.send.bind(context.tab.client);
    let released = false;
    context.tab.client.send = async (method, params, options) => {
      const response = await send(method, params, options);
      if (method === 'Fetch.disable') {
        context.emit('Fetch.requestPaused', { requestId: 'late-foreign', frameId: 'foreign-frame', request: { url: `https://claude.ai/api/${ORG_ID}/upload`, method: 'POST' }, responseStatusCode: 200 });
        if (disableFailed) throw new Error('disable failed');
      }
      if (method === 'Fetch.continueRequest') {
        await new Promise(resolve => setTimeout(resolve, 10));
        released = true;
      }
      return response;
    };
    const composer = new NativeComposer(context.tab, ORG_ID, CONV_ID);
    await composer.open();
    await composer.dispose();
    assert.equal(released, true);
    assert.equal(context.events.size, 0);
    assert.equal(context.calls.includes('Fetch.getResponseBody'), false);
    assert.equal(context.tab.retainTarget === true, disableFailed);
  }
});

test('ui: bad upload, cancellation and disabled composer never submit', async () => {
  for (const mode of ['wrong-size', 'wrong-frame', 'processing', 'checkpoint', 'redirect', 'http-error', 'network-error']) {
    const d = composerDouble({ afterUpload(files, emit, bodies) {
      const wrapped = (name, p) => {
        if (name === 'Fetch.requestPaused') {
          if (mode === 'wrong-frame') p.frameId = 'foreign';
          if (mode === 'wrong-size') bodies.get(p.requestId).size_bytes++;
          if (mode === 'processing') bodies.get(p.requestId).preview_asset = null;
          if (mode === 'redirect') p.responseStatusCode = 302;
          if (mode === 'http-error') p.responseStatusCode = 500;
          if (mode === 'network-error') { delete p.responseStatusCode; p.responseErrorReason = 'ConnectionReset'; }
        }
        emit(name, p);
      };
      uploadEvent(files, wrapped, bodies);
    } });
    const c = new NativeComposer(d.tab, ORG_ID, CONV_ID, { onUpload() { if (mode === 'checkpoint') throw new Error('disk failed'); } });
    await c.open();
    await assert.rejects(c.attachFiles([png]));
    assert.ok(!d.calls.includes('click'), mode);
    await c.dispose();
    assert.deepEqual([d.calls.filter(x => x === 'Fetch.continueRequest').length, d.calls.filter(x => x === 'Fetch.failRequest').length, d.calls.includes('Fetch.disable')],
      mode === 'redirect' ? [0, 1, true] : [1, 0, true], mode);
  }
  const d = composerDouble({ disabled: true });
  const controller = new AbortController();
  const c = new NativeComposer(d.tab, ORG_ID, CONV_ID, { signal: controller.signal });
  await c.open();
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(c.compose('inspect'), { code: 'ABORTED' });
  await c.dispose();
  assert.ok(!d.calls.includes('click'));
});

test('ui: an adopted draft is verified, filled and submitted once', async () => {
  const stored = {
    state: {
      attachments: [{ file_name: 'sample.js', file_type: 'text/javascript', file_size: 52, extracted_content: 'x'.repeat(52) }],
      files: [{ file_name: 'sample.png', file_kind: 'image', size_bytes: SAMPLE_PNG.length, file_uuid: 'client-uuid', serverFileUuid: FILE_PNG_ID }],
    },
  };
  const composer = composerDouble({ labels: ['sample.png', 'sample.js'], storedDraft: stored });
  const native = new NativeComposer(composer.tab, ORG_ID, CONV_ID, {});
  const adopted = await native.openDraft(['sample.js', 'sample.png']);
  assert.deepEqual(adopted, ['sample.png', 'sample.js']);
  assert.equal(Object.getPrototypeOf(adopted), Array.prototype);
  const view = await native.readDraft();
  assert.equal(view.ok, true);
  assert.equal(view.editorText, '');
  assert.deepEqual(view.entries.map(e => [e.name, e.kind, e.fileId]).sort(), [
    ['sample.js', 'text', null],
    ['sample.png', 'image', FILE_PNG_ID],
  ]);
  await native.fillPrompt('合成草稿复用检查');
  assert.equal(composer.input.innerText, '合成草稿复用检查');
  await native.submit();
  assert.equal(composer.calls.filter(c => c === 'click').length, 1);
  assert.equal(composer.calls.filter(c => c === 'attach').length ?? 0, 0); // never re-selected files
});

test('ui: an adopted draft may already hold exactly the resumed prompt', async () => {
  const prompt = 'first\nsecond';
  const composer = composerDouble({ draft: prompt.replaceAll('\n', '\n\n'), labels: ['sample.png'] });
  const native = new NativeComposer(composer.tab, ORG_ID, CONV_ID, {});
  await native.openDraft(['sample.png'], { expectedText: prompt });
  await native.fillPrompt(prompt);
  assert.ok(!composer.calls.includes('fill'));
  await native.submit();
  assert.equal(composer.calls.filter(call => call === 'click').length, 1);
});

test('ui: an adopted draft that does not match the original selection is refused', async () => {
  const stored = { state: { attachments: [], files: [{ file_name: 'other.png', file_kind: 'image', size_bytes: 1, serverFileUuid: FILE_PNG_ID }] } };
  const composer = composerDouble({ labels: ['other.png'], storedDraft: stored });
  const native = new NativeComposer(composer.tab, ORG_ID, CONV_ID, {});
  await assert.rejects(() => native.openDraft(['sample.png']), { code: 'UI_DRAFT_CONFLICT' });
  assert.equal(composer.tab.retainTarget, true);
  assert.equal(composer.calls.includes('click'), false);

  // a conversation that restores nothing at all is a distinct, bounded outcome
  const missing = composerDouble({});
  await assert.rejects(() => new NativeComposer(missing.tab, ORG_ID, CONV_ID, {}).openDraft(['sample.png']), { code: 'UI_DRAFT_UNAVAILABLE' });
  assert.equal(missing.tab.retainTarget, true);
  assert.equal(missing.calls.includes('click'), false);
});

test('ui: a draft with foreign text or no stored row is never adopted', async () => {
  const userDraft = composerDouble({ draft: 'user typed this', labels: ['sample.png'] });
  await assert.rejects(() => new NativeComposer(userDraft.tab, ORG_ID, CONV_ID, {}).openDraft(['sample.png']), { code: 'UI_DRAFT_CONFLICT' });
  await assert.rejects(() => new NativeComposer(userDraft.tab, ORG_ID, CONV_ID, {}).openDraft(['sample.png'], { expectedText: 'expected' }), { code: 'UI_DRAFT_CONFLICT' });

  const noStore = composerDouble({ labels: ['sample.png'] });
  const view = await new NativeComposer(noStore.tab, ORG_ID, CONV_ID, {}).readDraft().catch(error => error);
  assert.equal(view.code, 'UI_DRAFT_UNAVAILABLE');
});
