import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.mjs';
import { checkAbort, verifiedAttachments } from '../attachments.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UPLOAD_RESPONSE = 256 * 1024;

export function normalizeWebPrompt(prompt) {
  return prompt.replace(/\r\n?/g, '\n').trim();
}

export function chooseTransport(conversation, files = [], native = false) {
  if (typeof native !== 'boolean') throw new BridgeError('INVALID_ARGUMENT', 'native must be boolean');
  if (conversation.workspace_upgraded !== undefined && typeof conversation.workspace_upgraded !== 'boolean') {
    throw new BridgeError('API_CONTRACT', 'workspace_upgraded must be boolean');
  }
  return native || files.length || conversation.workspace_upgraded === true ? 'native' : 'rest';
}

export function wait(ms, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new BridgeError('ABORTED', 'Operation aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function pageComposer(args) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (location.origin !== 'https://claude.ai' || location.pathname !== args.path) {
    return fail('UI_CONTEXT_LOST', 'The owned page no longer shows the expected conversation');
  }
  if (args.action === 'forget') {
    const state = globalThis[args.key];
    const raw = document.querySelector('[data-testid="chat-input"][contenteditable="true"]')?.innerText;
    if (!state || typeof raw !== 'string') return fail('UI_CONTEXT_LOST', 'Cannot verify the composer before cleanup');
    const labels = [...document.querySelectorAll('button[aria-label]')]
      .map(b => b.getAttribute('aria-label') ?? '').filter(label => /^(Remove|移除)(\s|$)/u.test(label));
    if (labels.length) return fail('UI_DRAFT_CONFLICT', 'Attachments remain in the composer before cleanup');
    if (raw.trim() && raw !== state.prompt && raw !== state.snapshot
      && raw !== state.prompt?.replaceAll('\n', '\n\n')) {
      return fail('UI_DRAFT_CONFLICT', 'A user draft appeared before cleanup');
    }
    delete globalThis[args.key];
    return { ok: true };
  }
  const state = globalThis[args.key];
  if (args.action === 'scope') {
    return state ? { ok: true, ready: true } : fail('UI_CONTEXT_LOST', 'Composer operation was lost');
  }
  const editor = document.querySelector('[data-testid="chat-input"][contenteditable="true"]');
  const send = document.querySelector('[data-testid="chat-input-send"]');
  if (!editor || !send) return { ok: true, ready: false };
  if (typeof editor.innerText !== 'string') return fail('UI_CONTEXT_LOST', 'Composer content cannot be inspected');
  const raw = String(editor.innerText ?? '');
  const labels = [...document.querySelectorAll('button[aria-label]')]
    .map(b => b.getAttribute('aria-label') ?? '')
    .filter(label => /^(Remove|移除)(\s|$)/u.test(label));
  if (args.action === 'begin' || args.action === 'inspect') {
    if (raw.trim() || labels.length) return fail('UI_DRAFT_CONFLICT', 'The conversation already has a draft or attachments');
    if (args.action === 'inspect') return { ok: true, ready: true };
    if (state) return fail('UI_CONTEXT_LOST', 'Composer operation already exists');
    globalThis[args.key] = { phase: 'empty', names: [], prompt: null, snapshot: null };
    return { ok: true, ready: true };
  }
  if (args.action === 'adopt') {
    if (state) return fail('UI_CONTEXT_LOST', 'Composer operation already exists');
    const expected = typeof args.expectedText === 'string' ? args.expectedText : null;
    if (raw.trim() && (!expected || (raw !== expected && raw !== expected.replaceAll('\n', '\n\n')))) {
      return fail('UI_DRAFT_CONFLICT', 'The conversation holds draft text that is not ours');
    }
    // restored attachments appear asynchronously after the conversation loads; an
    // adoption expecting no attachments is ready as soon as the draft is verified
    if (!labels.length) {
      if (Array.isArray(args.expectedNames) && args.expectedNames.length === 0) {
        globalThis[args.key] = { phase: 'adopted', names: [], prompt: null, snapshot: null };
        return { ok: true, ready: true, names: [] };
      }
      return { ok: true, ready: false };
    }
    const names = labels.map(label => label.replace(/^(?:Remove|移除)\s+/u, ''));
    globalThis[args.key] = { phase: 'adopted', names, prompt: null, snapshot: null };
    return { ok: true, ready: true, names };
  }
  if (!state) return fail('UI_CONTEXT_LOST', 'Composer operation was lost');
  if (args.action === 'attach') {
    if (state.phase !== 'empty' || raw.trim() || labels.length) return fail('UI_DRAFT_CONFLICT', 'Composer changed before attachment selection');
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    if (inputs.length !== 1 || !inputs[0].multiple) return fail('UI_CONTRACT', 'Expected one multiple-file input');
    state.phase = 'attaching';
    state.names = args.files.map(f => f.name);
    const transfer = new DataTransfer();
    for (const f of args.files) {
      const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
      transfer.items.add(new File([bytes], f.name, { type: f.mimeType }));
    }
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    state.phase = 'attached';
    return { ok: true, ready: true };
  }
  const filesMatch = labels.length === state.names.length
    && state.names.every(name => labels.filter(label => label.endsWith(` ${name}`)).length === 1);
  if (args.action === 'fill') {
    const restored = state.phase === 'adopted';
    if (!['empty', 'attached', 'adopted'].includes(state.phase)
      || (raw.trim() && (!restored || (raw !== args.prompt && raw !== args.prompt.replaceAll('\n', '\n\n'))))) {
      return fail('UI_DRAFT_CONFLICT', 'Composer changed before text entry');
    }
    if (!filesMatch) return { ok: true, ready: false };
    if (raw.trim()) {
      state.phase = 'filled';
      state.prompt = args.prompt;
      return { ok: true, ready: true };
    }
    state.phase = 'filling';
    state.prompt = args.prompt;
    editor.focus();
    if (!document.execCommand('insertText', false, args.prompt)) return fail('UI_CONTRACT', 'The native editor did not accept text');
    state.phase = 'filled';
    return { ok: true, ready: true };
  }
  if (state.phase === 'clicked') return fail('UI_ALREADY_SUBMITTED', 'This composer operation was already submitted');
  const matches = raw === state.prompt || raw === state.prompt?.replaceAll('\n', '\n\n');
  if (state.phase !== 'filled' || !matches || !filesMatch) return fail('UI_DRAFT_CONFLICT', 'Draft text or attachment selection changed');
  if (args.action === 'ready') {
    if (send.disabled) return { ok: true, ready: false };
    state.snapshot = raw;
    return { ok: true, ready: true };
  }
  if (args.action === 'submit') {
    if (send.disabled) return { ok: true, ready: false };
    if (state.snapshot === null) state.snapshot = raw;
    if (raw !== state.snapshot) return fail('UI_DRAFT_CONFLICT', 'Draft changed before submit');
    state.phase = 'clicked';
    send.click();
    return { ok: true, ready: true };
  }
  return fail('UI_CONTRACT', 'Unknown composer action');
}

// Reads the attachment identities of a restored draft. Read-only: it never types,
// clicks, uploads or clears anything; it only reports what the draft already holds.
export function pageDraft(args) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (location.origin !== 'https://claude.ai' || location.pathname !== args.path) {
    return fail('UI_CONTEXT_LOST', 'The owned page no longer shows the expected conversation');
  }
  const ask = (fn) => new Promise((resolve) => {
    let req;
    try { req = fn(); } catch { resolve(undefined); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
    req.onblocked = () => resolve(undefined);
  });
  return (async () => {
    const db = await ask(() => indexedDB.open(args.db));
    if (!db) return fail('UI_DRAFT_UNAVAILABLE', 'The stored draft could not be opened');
    let row;
    try {
      row = await ask(() => db.transaction(args.store, 'readonly').objectStore(args.store).get(args.prefix + args.conversation));
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
    if (!row || typeof row !== 'object') {
      // a missing draft row is a settled state for a text-only composer: only an
      // attachment manifest caller still needs the row to exist
      if (args.expectEmpty) {
        return {
          ok: true,
          editorText: String(document.querySelector('[data-testid="chat-input"][contenteditable="true"]')?.innerText ?? ''),
          entries: [],
        };
      }
      return fail('UI_DRAFT_UNAVAILABLE', 'This conversation has no stored attachment draft');
    }
    if (typeof row.state !== 'object' || row.state === null) {
      return fail('UI_DRAFT_UNAVAILABLE', 'This conversation has no stored attachment draft');
    }
    const files = Array.isArray(row.state.files) ? row.state.files : [];
    const texts = Array.isArray(row.state.attachments) ? row.state.attachments : [];
    if (files.length > 8 || texts.length > 8) return fail('API_CONTRACT', 'The stored draft holds too many attachments');
    const entries = [];
    for (const file of files) {
      if (!file || typeof file !== 'object') return fail('API_CONTRACT', 'The stored draft is malformed');
      const fileId = typeof file.serverFileUuid === 'string' ? file.serverFileUuid : (typeof file.uuid === 'string' ? file.uuid : null);
      entries.push({
        name: typeof file.file_name === 'string' ? file.file_name : null,
        kind: typeof file.file_kind === 'string' ? file.file_kind : null,
        size: Number.isSafeInteger(file.size_bytes) ? file.size_bytes : null,
        fileId,
        content: null,
      });
    }
    for (const text of texts) {
      if (!text || typeof text !== 'object') return fail('API_CONTRACT', 'The stored draft is malformed');
      const content = typeof text.extracted_content === 'string' ? text.extracted_content : null;
      if (content !== null && content.length > 200000) return fail('API_CONTRACT', 'The stored draft text attachment is too large');
      entries.push({
        name: typeof text.file_name === 'string' ? text.file_name : null,
        kind: 'text',
        size: Number.isSafeInteger(text.file_size) ? text.file_size : null,
        fileId: null,
        mimeType: typeof text.file_type === 'string' ? text.file_type : null,
        content,
      });
    }
    return {
      ok: true,
      editorText: String(document.querySelector('[data-testid="chat-input"][contenteditable="true"]')?.innerText ?? ''),
      entries,
    };
  })();
}

export async function inspectBlankComposer(tab, { signal } = {}) {
  const deadline = Date.now() + tab.config.readyTimeoutMs;
  const args = { action: 'inspect', path: tab.expectedPath };
  try {
    for (;;) {
      const result = await tab.evaluate(`(${pageComposer.toString()})(${JSON.stringify(args)})`, { signal });
      if (!result || typeof result.ok !== 'boolean') throw new BridgeError('UI_CONTRACT', 'Unexpected pre-navigation composer response');
      if (!result.ok) throw new BridgeError(result.code, result.message);
      if (result.ready) return;
      if (Date.now() >= deadline) throw new BridgeError('UI_NOT_READY', 'Could not verify an empty composer before navigation');
      await wait(50, signal);
    }
  } catch (error) {
    tab.retainTarget = true;
    throw error;
  }
}

export async function canCloseBlankComposer(tab) {
  try {
    const args = { action: 'inspect', path: tab.expectedPath };
    const result = await tab.evaluate(`(${pageComposer.toString()})(${JSON.stringify(args)})`, { timeoutMs: 1000 });
    return result?.ok === true && result.ready === true;
  } catch {
    return false;
  }
}

export class NativeComposer {
  constructor(tab, orgId, conversationId, { signal, onUpload = async () => {} } = {}) {
    if (!UUID.test(orgId) || !UUID.test(conversationId)) throw new BridgeError('INVALID_ARGUMENT', 'Invalid native conversation identity');
    this.tab = tab;
    this.orgId = orgId;
    this.conversationId = conversationId;
    this.signal = signal;
    this.onUpload = onUpload;
    this.key = `__ccw_composer_${randomUUID().replaceAll('-', '_')}`;
    this.path = `/chat/${conversationId}`;
    this.uploadUrl = `https://claude.ai/api/${orgId}/upload`;
    this.uploads = 0;
    this.intercepting = false;
    this.receipts = new Map();
    this.inflight = new Set();
    this.files = [];
    this.checkpoints = Promise.resolve();
    this.error = null;
    this.submitted = false;
    this.autoRecovered = false;
  }

  async call(action, extra = {}) {
    checkAbort(this.signal);
    if (this.error) throw this.error;
    const args = { key: this.key, path: this.path, action, ...extra };
    const result = await this.tab.evaluate(`(${pageComposer.toString()})(${JSON.stringify(args)})`, { signal: this.signal });
    if (!result || typeof result.ok !== 'boolean') throw new BridgeError('UI_CONTRACT', 'Unexpected composer response');
    if (!result.ok) {
      if (result.code === 'UI_DRAFT_CONFLICT' || result.code === 'UI_CONTEXT_LOST') this.tab.retainTarget = true;
      throw new BridgeError(result.code, result.message);
    }
    return result;
  }

  async untilReady(fn) {
    const end = Date.now() + this.tab.config.readyTimeoutMs;
    for (;;) {
      checkAbort(this.signal);
      if (this.error) throw this.error;
      if (await fn()) return;
      if (Date.now() >= end) throw new BridgeError('UI_NOT_READY', 'Native composer or attachments did not become ready');
      await wait(Math.min(100, end - Date.now()), this.signal);
    }
  }

  async open() {
    await this.tab.navigateConversation(this.conversationId, { signal: this.signal });
    await this.untilReady(async () => (await this.call('begin')).ready);
    this.unsubscribe = this.tab.client.subscribe(event => {
      try { this.event(event); } catch (error) { this.error ??= error; }
    });
    this.intercepting = true;
    await this.tab.client.send('Fetch.enable', {
      patterns: [{ urlPattern: this.uploadUrl, requestStage: 'Response' }],
    }, { sessionId: this.tab.sessionId, signal: this.signal });
  }

  event(event) {
    if (event.sessionId !== this.tab.sessionId || event.method !== 'Fetch.requestPaused') return;
    const promise = this.readUpload(event.params ?? {}).catch(error => { this.error ??= error; });
    this.inflight.add(promise);
    promise.finally(() => this.inflight.delete(promise));
  }

  async release(requestId, { fail = false, cause } = {}) {
    const options = { sessionId: this.tab.sessionId, timeoutMs: this.tab.config.readyTimeoutMs };
    if (fail) {
      await this.tab.client.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, options);
      return;
    }
    try {
      await this.tab.client.send('Fetch.continueRequest', { requestId }, options);
    } catch {
      await this.tab.client.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, options).catch(() => {});
      // an unreleased paused request outranks whatever the read was reporting, but it must not
      // erase that report: the original failure stays attached as the cause
      const error = new BridgeError('UPLOAD_UNCERTAIN', 'Could not release the native upload response; no retry will be attempted');
      if (cause) error.cause = cause;
      throw error;
    }
  }

  async readUpload(paused) {
    const request = paused.request ?? {};
    const ours = request.url === this.uploadUrl && request.method === 'POST' && paused.frameId === this.tab.frameId;
    const count = ours ? ++this.uploads : 0;
    const redirected = ours && paused.responseStatusCode >= 300 && paused.responseStatusCode < 400;
    let response;
    let failure;
    try {
      if (!ours) return;                       // the finally block still releases a foreign pause
      const status = paused.responseStatusCode;
      if (count > this.files.filter(file => file.kind !== 'text').length || redirected) {
        throw new BridgeError('UPLOAD_UNCERTAIN', 'Unexpected duplicate or redirected upload; no retry will be attempted');
      }
      if (paused.responseErrorReason || !Number.isInteger(status)) throw new BridgeError('UPLOAD_UNCERTAIN', 'Native upload failed or was interrupted');
      const headerValue = name => String((paused.responseHeaders ?? []).find(header => String(header?.name).toLowerCase() === name)?.value ?? '');
      if (status !== 200 || headerValue('content-type').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new BridgeError('FILE_UPLOAD_FAILED', 'Upload did not return successful JSON', { status });
      }
      if (Number(headerValue('content-length')) > MAX_UPLOAD_RESPONSE) throw new BridgeError('API_CONTRACT', 'Invalid upload response envelope');
      response = await this.tab.client.send('Fetch.getResponseBody', { requestId: paused.requestId }, {
        sessionId: this.tab.sessionId, signal: this.signal, timeoutMs: this.tab.config.readyTimeoutMs,
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await this.release(paused.requestId, { fail: redirected, cause: failure });
    }
    if (typeof response?.body !== 'string' || response.body.length > MAX_UPLOAD_RESPONSE * 2) throw new BridgeError('API_CONTRACT', 'Upload response is too large');
    const bytes = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
    if (bytes.length > MAX_UPLOAD_RESPONSE) throw new BridgeError('API_CONTRACT', 'Upload response is too large');
    let data;
    try { data = JSON.parse(bytes.toString('utf8')); }
    catch { throw new BridgeError('API_CONTRACT', 'Upload response is not JSON'); }
    const file = this.files.find(f => f.kind !== 'text' && f.name === data?.file_name);
    if (!file || !UUID.test(data.file_uuid ?? '') || data.size_bytes !== file.size
      || data.file_kind !== file.kind || this.receipts.has(file.name)) {
      throw new BridgeError('API_CONTRACT', 'Upload identity does not match the selected file');
    }
    const ready = data.success === true && file.kind === 'image' && data.preview_asset?.file_variant === 'preview';
    const receipt = { name: file.name, fileId: data.file_uuid, ready };
    this.checkpoints = this.checkpoints.then(() => this.onUpload(receipt));
    await this.checkpoints;
    this.receipts.set(file.name, receipt);
    if (!ready) throw new BridgeError('FILE_NOT_READY', 'The upload is not a verified usable file; asynchronous processing is not supported');
  }

  // Selects the files and waits for every non-text upload receipt. Split from
  // compose() so the caller can persist its pending state between uploads and
  // text entry; never fills or submits.
  async attachFiles(files) {
    verifiedAttachments(files);
    this.files = files;
    if (!files.length) return;
    await this.call('attach', { files: files.map(f => ({ name: f.name, mimeType: f.mimeType, base64: f.bytes.toString('base64') })) });
    await this.untilReady(async () => this.receipts.size === files.filter(f => f.kind !== 'text').length && this.inflight.size === 0);
  }

  // Fills the verified prompt and snapshots it for the click. Call after
  // attachFiles(); for a text-only turn call it directly once the composer is open.
  async compose(prompt, { waitReady = true } = {}) {
    await this.untilReady(async () => (await this.call('fill', { prompt: normalizeWebPrompt(prompt) })).ready);
    if (waitReady) await this.untilReady(async () => (await this.call('ready')).ready);
    else await this.call('ready');
    await this.checkpoints;
    return [...this.receipts.values()];
  }

  async assertScope() {
    const result = await this.call('scope');
    if (!result.ready) throw new BridgeError('UI_CONTEXT_LOST', 'Native composer disappeared');
  }

  // Adopt a restored draft instead of re-selecting and re-uploading its files.
  // Only used by the explicit operator recovery path, never during a normal send.
  // An empty expectedNames marks a text-only draft: the page does not need any
  // restored attachments for the adoption to be ready.
  async navigateDraft() {
    await this.tab.navigateConversation(this.conversationId, { signal: this.signal });
  }

  async adoptDraft(expectedNames, { expectedText, timeoutMs } = {}) {
    const end = Date.now() + (timeoutMs ?? this.tab.config.readyTimeoutMs);
    let names;
    for (;;) {
      const extra = { expectedNames: [...expectedNames] };
      if (expectedText !== undefined) extra.expectedText = expectedText;
      const result = await this.call('adopt', extra);
      if (result.ready) { names = Array.isArray(result.names) ? result.names : []; break; }
      if (Date.now() >= end) {
        this.tab.retainTarget = true;
        throw new BridgeError('UI_DRAFT_UNAVAILABLE', 'This conversation restored no attachments to adopt');
      }
      await wait(Math.min(100, end - Date.now()), this.signal);
    }
    const expected = [...expectedNames].sort().join('\u0000');
    if (names.slice().sort().join('\u0000') !== expected) {
      this.tab.retainTarget = true;
      throw new BridgeError('UI_DRAFT_CONFLICT', 'The restored attachments do not match the original selection', {
        restored: names.slice(0, 8),
        expected: [...expectedNames].slice(0, 8),
      });
    }
    // normalize out of the page realm so callers get ordinary values
    return Array.from(names, name => String(name));
  }

  async openDraft(expectedNames, { expectedText, timeoutMs } = {}) {
    await this.navigateDraft();
    return this.adoptDraft(expectedNames, { expectedText, timeoutMs });
  }

  async readDraft({ retain = true, expectEmpty = false } = {}) {
    const args = {
      path: this.path, db: 'keyval-store', store: 'keyval',
      prefix: 'store:chat-draft:', conversation: this.conversationId, expectEmpty,
    };
    const result = await this.tab.evaluate(`(${pageDraft.toString()})(${JSON.stringify(args)})`, { signal: this.signal });
    if (!result || typeof result.ok !== 'boolean') throw new BridgeError('UI_CONTRACT', 'Unexpected draft response');
    if (!result.ok) {
      if (retain) this.tab.retainTarget = true;
      throw new BridgeError(result.code, result.message);
    }
    return {
      ok: true,
      editorText: String(result.editorText ?? ''),
      entries: Array.from(result.entries ?? [], entry => ({
        name: entry?.name ?? null,
        kind: entry?.kind ?? null,
        size: Number.isSafeInteger(entry?.size) ? entry.size : null,
        fileId: entry?.fileId ?? null,
        mimeType: entry?.mimeType ?? null,
        content: typeof entry?.content === 'string' ? entry.content : null,
      })),
    };
  }

  async fillPrompt(prompt) {
    await this.untilReady(async () => (await this.call('fill', { prompt: normalizeWebPrompt(prompt) })).ready);
    await this.untilReady(async () => (await this.call('ready')).ready);
    return [...this.receipts.values()];
  }

  async submit({ beforeAttempt } = {}) {
    if (this.submitted) throw new BridgeError('UI_ALREADY_SUBMITTED', 'Native submit was already attempted');
    const end = Date.now() + this.tab.config.readyTimeoutMs;
    let unavailable = false;
    for (;;) {
      if (beforeAttempt) await beforeAttempt();
      let result;
      try {
        result = await this.call('submit');
      } catch (error) {
        this.submitted = true;
        throw error;
      }
      if (result.ready) {
        this.submitted = true;
        if (unavailable) this.autoRecovered = true;
        return;
      }
      unavailable = true;
      if (Date.now() >= end) {
        this.tab.retainTarget = true;
        throw new BridgeError('UI_NOT_READY', 'Native send control did not become ready');
      }
      await wait(Math.min(100, end - Date.now()), this.signal);
    }
  }

  async dispose() {
    await Promise.allSettled([...this.inflight]);
    if (this.intercepting) await this.tab.client.send('Fetch.disable', {}, { sessionId: this.tab.sessionId, timeoutMs: 1000 })
      .catch(() => { this.tab.retainTarget = true; });
    this.unsubscribe?.();
    await Promise.allSettled([...this.inflight]);
    await this.checkpoints.catch(() => {});
    if (!this.tab.retainTarget) {
      const result = await this.tab.evaluate(`(${pageComposer.toString()})(${JSON.stringify({ action: 'forget', key: this.key, path: this.path })})`, { timeoutMs: 1000 }).catch(() => null);
      if (result?.ok !== true) this.tab.retainTarget = true;
    }
  }
}
