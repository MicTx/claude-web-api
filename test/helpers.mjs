import http from 'node:http';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { pathToFileURL } from 'node:url';

const tmpDirs = [];
export async function makeTmpDir(prefix = 'ccw-test-') {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
export async function cleanupTmpDirs() {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop(), { recursive: true, force: true }).catch(() => {});
}

export async function offlineNodeOptions(directory, cdpUrl) {
  const path = join(directory, 'fixture-network-guard.mjs');
  const hosts = JSON.stringify((Array.isArray(cdpUrl) ? cdpUrl : [cdpUrl]).map(url => new URL(url).host));
  await fs.writeFile(path, `
const allowed = new Set(${hosts});
const check = value => {
  const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url);
  if (!allowed.has(url.host) || !['http:', 'ws:'].includes(url.protocol)) throw new Error('Offline fixture guard blocked a non-fixture request');
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { check(input); return originalFetch(input, options); };
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(target, args, next) { check(args[0]); return Reflect.construct(target, args, next); }
});
`, { mode: 0o600 });
  return `--import=${pathToFileURL(path).href}`;
}

export function streamFromString(text, chunkSize = Infinity) {
  const bytes = new TextEncoder().encode(text);
  return streamFromBytes([bytes], chunkSize);
}

export function streamFromBytes(chunks, chunkSize = Infinity) {
  const pieces = [];
  for (const chunk of chunks) {
    if (chunkSize === Infinity || chunk.byteLength <= chunkSize) pieces.push(chunk);
    else {
      for (let i = 0; i < chunk.byteLength; i += chunkSize) pieces.push(chunk.subarray(i, i + chunkSize));
    }
  }
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < pieces.length) {
        controller.enqueue(pieces[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

export function hangingStream() {
  return new ReadableStream({ start() { /* never produces bytes */ } });
}

export function delayedStream(chunks, delayMs = 50) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(typeof chunks[index] === 'string' ? new TextEncoder().encode(chunks[index]) : chunks[index]);
      index += 1;
    },
  });
}

const ABORTED = Symbol('aborted');
function abortableBody(stream, signal) {
  if (!signal || !stream || typeof stream.getReader !== 'function') return stream;
  const reader = stream.getReader();
  return new ReadableStream({
    async pull(controller) {
      let onAbort;
      const aborted = new Promise((res) => {
        onAbort = () => res(ABORTED);
        if (signal.aborted) res(ABORTED);
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = await Promise.race([reader.read(), aborted]);
      try { signal.removeEventListener('abort', onAbort); } catch { /* optional */ }
      if (result === ABORTED) {
        try { await reader.cancel(); } catch { /* already locked/gone */ }
        controller.error(new Error('The operation was aborted'));
        return;
      }
      if (result.done) controller.close();
      else controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export class FakePage {
  constructor({ origin = 'https://claude.ai', fetchHandler, nativeService, emit, frameId } = {}) {
    this.fetchHandler = fetchHandler;
    const sandbox = {
      location: { origin, pathname: '/new' },
      document: {
        readyState: 'complete',
        querySelector: selector => selector.includes('chat-input-send') ? { disabled: false } : selector.includes('chat-input') ? { innerText: '' } : null,
        querySelectorAll: () => [],
      setTimeout: () => 0,
      clearTimeout: () => {},
      },
      AbortController,
      TextDecoder,
      TextEncoder,
      setTimeout,
      clearTimeout,
      JSON,
      Promise,
      console,
      URL,
      Number,
      Math,
      Object,
      Array,
      String,
      Map,
      Set,
      RegExp,
      Error,
      TypeError,
      Boolean,
      Date,
      Intl,
      Uint8Array,
      ReadableStream,
      File,
      Event,
      atob,
      btoa,
      fetch: async (path, opts = {}) => {
        if (opts.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        const out = await this.fetchHandler(path, opts);
        const res = FakePage.response({ ...out, url: out.url ?? new URL(path, sandbox.location.origin).href });
        if (opts.signal) res.body = abortableBody(res.body, opts.signal);
        return res;
      },
    };
    this.context = vm.createContext(sandbox);
    this.sandbox = sandbox;
    if (nativeService) this.mountComposer(nativeService, emit, frameId);
  }

  mountComposer(service, emit, frameId) {
    this.networkBodies = new Map();
    this.nativeFiles = [];
    this.nativePrompt = '';
    // Restored-draft storage: tests seed draftStore to emulate a page that
    // reloaded with attachments already attached.
    this.draftStore = new Map();
    this.sandbox.indexedDB = {
      open: () => {
        const request = {};
        setTimeout(() => {
          request.result = {
            transaction: () => ({
              objectStore: () => ({
                get: (key) => {
                  const row = {};
                  setTimeout(() => {
                    row.result = this.draftStore.get(key);
                    service.onDraftRead?.(row, this);
                    row.onsuccess?.();
                  }, 0);
                  return row;
                },
              }),
            }),
            close: () => {},
          };
          request.onsuccess?.();
        }, 0);
        return request;
      },
    };
    const editor = this.editor = { innerText: '', focus() {} };
    const modelIds = service.modelOptions?.length ? service.modelOptions : [...new Set([service.model, 'claude-opus-5-9'])];
    const triggerMounted = service.mountModelPicker !== false;
    let modelMenuOpen = service.modelPickerInitiallyOpen === true;
    service.modelPickerClicks ??= 0;
    service.modelPickerMenuOpen = modelMenuOpen;
    const modelLabel = id => `Claude ${id.split('/').at(-1).replace(/^claude-/, '')}`;
    const modelTrigger = {
      innerText: modelLabel(service.model),
      getAttribute(name) {
        if (name === 'aria-expanded') return modelMenuOpen ? 'true' : 'false';
        if (name === 'aria-haspopup') return 'listbox';
        if (name === 'data-model-id') return service.modelPickerTriggerHasModelId === false ? null : service.model;
        return null;
      },
      click() {
        service.modelPickerClicks += 1;
        modelMenuOpen = !modelMenuOpen;
        service.modelPickerMenuOpen = modelMenuOpen;
      },
    };
    const modelOptions = () => (modelMenuOpen || service.keepClosedModelOptions === true ? modelIds : []).map(id => ({
      innerText: modelLabel(id),
      getAttribute(name) {
        if (name === 'data-model-id') return id;
        if (name === 'aria-checked') return service.model === id ? 'true' : null;
        if (name === 'aria-disabled') return null;
        return null;
      },
      click() {
        service.model = id;
        modelTrigger.innerText = modelLabel(id);
        modelMenuOpen = false;
        service.modelPickerMenuOpen = false;
      },
    }));
    const send = this.sendButton = {
      disabled: service.nativeSendDisabled === true,
      click: () => {
        service.nativeSends ??= [];
        service.nativeSends.push({ prompt: this.nativePrompt, files: this.nativeFiles.map(f => ({ name: f.name, fileId: f.fileId })) });
        if (service.nativeFailure === 'drop') return;
        const conv = service.convs.get(this.sandbox.location.pathname.split('/').at(-1));
        if (!conv) throw new Error('No fake native conversation');
        const reply = service.replyFn ? service.replyFn(this.nativePrompt) : service.replyText;
        const assistant = service.commitTurn(conv, this.nativePrompt, conv.current_leaf_message_uuid ?? '00000000-0000-4000-8000-000000000000', reply);
        const human = conv.chat_messages.at(-2);
        human.files = this.nativeFiles.filter(f => f.kind !== 'text').map(f => ({
          file_uuid: f.fileId, file_name: f.name, size_bytes: f.bytes.length, file_kind: f.kind,
        }));
        human.attachments = this.nativeFiles.filter(f => f.kind === 'text').map(f => ({
          id: service.uuid(), file_name: f.name, file_size: f.bytes.length, file_type: f.mimeType, extracted_content: f.bytes.toString('utf8'),
        }));
        if (service.nativeOutputs) {
          service.files ??= new Map();
          const deliveries = service.nativeOutputs.map(file => {
            const fileId = service.uuid();
            service.files.set(fileId, file);
            return { file_uuid: fileId, path: `/home/claude/${file.name}` };
          });
          assistant.content.push({ type: 'tool_result', name: 'SendUserFile', is_error: false, file_deliveries: deliveries });
        }
        conv.workspace_upgraded = true;
        editor.innerText = '';
        this.nativeFiles = [];
        if (service.afterNativeSend) service.afterNativeSend(conv, this);
        if (service.nativeFailure === 'afterCommit') throw new Error('Native response was lost after commit');
      },
    };
    class Transfer {
      files = [];
      items = { add: file => this.files.push(file) };
    }
    const fileInput = this.fileInput = {
      multiple: true,
      files: [],
      dispatchEvent: () => {
        send.disabled = true;
        const selected = [...fileInput.files];
        this.nativeJob = Promise.all(selected.map(async file => {
          const bytes = Buffer.from(await file.arrayBuffer());
          const kind = file.type === 'image/png' ? 'image' : file.type === 'application/pdf' ? 'document' : 'text';
          const record = { name: file.name, mimeType: file.type, kind, bytes, fileId: kind === 'text' ? null : service.uuid() };
          service.uploads ??= [];
          service.uploads.push(record);
          this.nativeFiles.push(record);
          if (kind === 'text') return;
          const requestId = `native-upload-${service.uploads.length}`;
          const data = {
            success: true, file_uuid: record.fileId, file_kind: kind, file_name: file.name, size_bytes: bytes.length,
            preview_asset: kind === 'image' ? { file_variant: 'preview' } : null,
            document_asset: kind === 'document' ? { file_variant: 'document_pdf', page_count: 1 } : null,
          };
          service.beforeUploadResponse?.(data, record);
          this.networkBodies.set(requestId, data);
          const hideFinish = service.pauseUploads || service.hideUploadFinish?.(record) === true;
          if (!hideFinish) emit('Fetch.requestPaused', { requestId, frameId, request: { method: 'POST', url: `https://claude.ai/api/${service.orgs[0].uuid}/upload` },
            responseStatusCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }] });
        })).then(() => {
          const conversationId = this.sandbox.location.pathname.split('/').at(-1);
          this.draftStore.set(`store:chat-draft:${conversationId}`, { state: {
            attachments: this.nativeFiles.filter(f => f.kind === 'text').map(f => ({
              file_name: f.name, file_type: f.mimeType, file_size: f.bytes.length, extracted_content: f.bytes.toString('utf8'),
            })),
            files: this.nativeFiles.filter(f => f.kind !== 'text').map(f => ({
              file_name: f.name, file_kind: f.kind, size_bytes: f.bytes.length, serverFileUuid: f.fileId, success: true,
            })),
          } });
          send.disabled = false;
        });
      },
    };
    this.sandbox.DataTransfer = Transfer;
    Object.assign(this.sandbox.document, {
      querySelector: selector => selector.includes('chat-input-send') ? send
        : selector.includes('chat-input') ? editor : selector.includes('button') ? modelTrigger : null,
      querySelectorAll: selector => selector.includes('type="file"') ? [fileInput]
        : selector.includes('button[aria-label]') ? this.nativeFiles.map(f => ({ getAttribute: () => `Remove ${f.name}` }))
        : triggerMounted && selector.includes('button[data-testid="model-selector-dropdown"]') ? [modelTrigger]
        : selector.includes('[role="option"]') || selector.includes('[role="menuitemradio"]') || selector.includes('[role="menuitem"]') ? modelOptions() : [],
      execCommand: (command, _, value) => {
        if (command !== 'insertText') return false;
        this.nativePrompt = value;
        editor.innerText = value.replaceAll('\n', '\n\n');
        return true;
      },
    });
  }

  static response({ status = 200, contentType = 'application/json', headers = {}, body = '', url, redirected = false } = {}) {
    const headerMap = { 'content-type': contentType, ...headers };
    let stream;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) stream = streamFromBytes([body]);
    else if (body instanceof ReadableStream) stream = body;
    else if (Array.isArray(body)) stream = streamFromBytes(body.map((b) => (typeof b === 'string' ? new TextEncoder().encode(b) : b)));
    else stream = streamFromString(String(body));
    return {
      ok: status >= 200 && status < 300,
      status,
      url,
      redirected,
      headers: { get: (name) => headerMap[String(name).toLowerCase()] ?? null },
      body: stream,
    };
  }

  async evaluate(expression) {
    const result = vm.runInContext(expression, this.context);
    return await result;
  }

  setOrigin(origin) {
    this.sandbox.location.origin = origin;
  }
}

export class FakeCdpServer {
  constructor({ fetchHandler, origin = 'https://claude.ai', wsUrl, nativeService } = {}) {
    this.fetchHandler = fetchHandler;
    this.origin = origin;
    this.wsUrlOverride = wsUrl;
    this.pages = new Map();
    this.createdTargets = [];
    this.closedTargets = [];
    this.evaluateCount = 0;
    this.onMessage = null;
    this.nativeService = nativeService;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/json/version' && req.method === 'GET') {
        const wsUrl = this.wsUrlOverride ?? `ws://127.0.0.1:${this.server.address().port}/devtools/browser/fake-browser-id`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ webSocketDebuggerUrl: wsUrl, Browser: 'FakeChrome/1.0' }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.sockets = new Set();
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (data) => {
        this.#onMessage(ws, data).catch(() => {});
      });
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    this.cdpUrl = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async #onMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const reply = (result) => ws.send(JSON.stringify({ id: msg.id, result }));
    const fail = (message) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message } }));
    const pageForSession = () => {
      const sessionId = msg.sessionId ?? 'browser';
      if (!this.pages.has(sessionId)) {
        const page = new FakePage({
          origin: this.origin, fetchHandler: this.fetchHandler, nativeService: this.nativeService,
          frameId: `frame-${sessionId}`,
          emit: (method, params) => { if (ws.readyState === 1) ws.send(JSON.stringify({ method, params, sessionId })); },
        });
        // tests seed restored drafts and other per-page state before the bridge reads them
        this.onPage?.(page);
        this.pages.set(sessionId, page);
      }
      return this.pages.get(sessionId);
    };
    if (this.onMessage) this.onMessage(msg);
    try {
      switch (msg.method) {
        case 'Target.createTarget': {
          const targetId = `target-${this.createdTargets.length + 1}`;
          this.createdTargets.push({ targetId, url: msg.params?.url });
          if (this.createTargetResponseDelayMs) await new Promise(resolve => setTimeout(resolve, this.createTargetResponseDelayMs));
          if (this.suppressCreateTargetResponse) return;
          return reply({ targetId });
        }
        case 'Target.attachToTarget':
          return reply({ sessionId: `session-${msg.params?.targetId}` });
        case 'Target.closeTarget':
          this.closedTargets.push(msg.params?.targetId);
          return reply({ success: true });
        case 'Target.getTargetInfo': {
          const target = this.createdTargets.find(t => t.targetId === msg.params.targetId);
          const page = this.pages.get(`session-${target.targetId}`);
          return reply({ targetInfo: { targetId: target.targetId, url: page ? `${page.sandbox.location.origin}${page.sandbox.location.pathname}` : target.url } });
        }
        case 'Page.navigate': {
          const page = pageForSession();
          const url = new URL(msg.params.url);
          page.sandbox.location.origin = url.origin;
          page.sandbox.location.pathname = url.pathname;
          // a real page restores its stored draft right after landing on a conversation
          this.onNavigate?.(page, url);
          return reply({ frameId: `frame-${msg.sessionId}` });
        }
        case 'Fetch.enable':
        case 'Fetch.disable':
        case 'Fetch.continueRequest':
        case 'Fetch.failRequest':
          return reply({});
        case 'Fetch.getResponseBody':
          return reply({ body: JSON.stringify(pageForSession().networkBodies.get(msg.params.requestId)), base64Encoded: false });
        case 'Runtime.evaluate': {
          this.evaluateCount += 1;
          const page = pageForSession();
          try {
            const value = await page.evaluate(msg.params.expression);
            return reply({ result: { type: typeof value, value } });
          } catch (error) {
            return reply({ exceptionDetails: { text: String(error && error.message ? error.message : error) } });
          }
        }
        default:
          return fail(`unsupported method ${msg.method}`);
      }
    } catch (error) {
      return fail(String(error));
    }
  }

  pageFor(sessionId = 'session-target-1') {
    return this.pages.get(sessionId);
  }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    await new Promise((resolve) => this.wss.close(resolve));
    await new Promise((resolve) => this.server.close(resolve));
  }
}

// ---- fake Claude service ------------------------------------------------
// In-memory implementation of the documented REST+SSE protocol. Shared by
// the fetch-level fake (through FakeCdpServer pages) and the direct tab
// adapter used in bridge tests.
import { consumeCompletion } from '../src/core/sse.mjs';
import { BridgeError } from '../src/core/errors.mjs';
import * as fx from './fixtures.mjs';

export class ClaudeService {
  constructor({
    orgs = fx.ORGS, replyText = 'Claude reply text', model = 'claude-opus-5-5', modelOptions = null,
    modelPickerInitiallyOpen = false, modelPickerTriggerHasModelId = true, nativeSendDisabled = false,
  } = {}) {
    this.orgs = orgs;
    this.convs = new Map();
    this.requests = [];
    this.replyText = replyText;
    this.model = model;
    this.modelOptions = modelOptions ?? [...new Set([model, 'claude-opus-5-9'])];
    this.counter = 0;
    this.failNext = null; // completion: 'drop' | 'afterCommit' | {status,body}
    this.failNextCreate = null; // create: 'drop' | {status,body}
    this.replyFn = null;  // optional (prompt) => text
    this.modelPickerInitiallyOpen = modelPickerInitiallyOpen;
    this.modelPickerTriggerHasModelId = modelPickerTriggerHasModelId;
    this.nativeSendDisabled = nativeSendDisabled;
  }

  uuid() {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }

  addConversation({ uuid, name = '', messages = [], leaf = null, model = this.model }) {
    const conv = { uuid, name, model, chat_messages: messages, current_leaf_message_uuid: leaf };
    this.convs.set(uuid, conv);
    return conv;
  }

  commitTurn(conv, prompt, parent, replyText) {
    const human = {
      uuid: this.uuid(),
      parent_message_uuid: parent,
      sender: 'human',
      content: [{ type: 'text', text: prompt }],
    };
    const assistant = {
      uuid: this.uuid(),
      parent_message_uuid: human.uuid,
      sender: 'assistant',
      stop_reason: 'end_turn',
      truncated: false,
      content: [{ type: 'text', text: replyText, stop_timestamp: new Date().toISOString() }],
    };
    conv.chat_messages.push(human, assistant);
    conv.current_leaf_message_uuid = assistant.uuid;
    return assistant;
  }

  async handle({ method, path, body }) {
    this.requests.push({ method, path, body });
    const json = (status, obj) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (method === 'GET' && path === '/api/organizations') return json(200, this.orgs);
    const filePath = path.match(/^\/api\/organizations\/[0-9a-f-]+\/files\/([0-9a-f-]+)\/contents$/);
    if (method === 'GET' && filePath) {
      const file = this.files?.get(filePath[1]);
      if (!file) return json(404, { error: 'not found' });
      return { status: file.status ?? 200, contentType: file.mimeType ?? 'application/octet-stream', headers: file.headers ?? {}, body: file.bytes, url: file.url, redirected: file.redirected };
    }
    let m = path.match(/^\/api\/organizations\/([0-9a-f-]+)\/chat_conversations$/);
    if (m && method === 'POST') {
      const mode = this.failNextCreate;
      if (mode) {
        this.failNextCreate = null;
        if (mode === 'drop') return json(500, { error: 'boom' });
        if (typeof mode === 'object') return json(mode.status, mode.body);
      }
      const conv = this.addConversation({ uuid: body.uuid, name: body.name ?? '' });
      return json(201, { uuid: conv.uuid, name: conv.name, model: this.model, settings: {} });
    }
    m = path.match(/^\/api\/organizations\/[0-9a-f-]+\/chat_conversations\/([0-9a-f-]+)\?tree=True/);
    if (m && method === 'GET') {
      const conv = this.convs.get(m[1]);
      if (!conv) return json(404, { error: 'not found' });
      return json(200, conv);
    }
    m = path.match(/^\/api\/organizations\/[0-9a-f-]+\/chat_conversations\/([0-9a-f-]+)\/completion$/);
    if (m && method === 'POST') {
      const conv = this.convs.get(m[1]);
      if (!conv) return json(404, { error: 'not found' });
      const mode = this.failNext;
      this.failNext = null;
      if (mode === 'drop') return json(500, { error: 'boom' });
      if (mode && typeof mode === 'object') return json(mode.status, mode.body);
      const text = this.replyFn ? this.replyFn(body.prompt) : this.replyText;
      const assistant = this.commitTurn(conv, body.prompt, body.parent_message_uuid, text);
      const events = [
        fx.msgStart(assistant.uuid, this.model),
        fx.blockStart(0),
        fx.textDelta(0, text),
        fx.blockStop(0),
      ];
      if (mode !== 'afterCommit') {
        events.push(fx.msgDelta('end_turn'), fx.msgLimit(), fx.msgStop());
      }
      return { status: 200, contentType: 'text/event-stream', body: fx.sse(events) };
    }
    return json(404, { error: 'unhandled path' });
  }

  posts(pathMatch = '/completion') {
    return this.requests.filter((r) => r.method === 'POST' && r.path.includes(pathMatch));
  }
}

export function fetchHandlerFor(service) {
  return async (path, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    return service.handle({ method: opts.method ?? 'GET', path, body });
  };
}

const STATUS_CODES = { 401: 'AUTH_REQUIRED', 403: 'ACCESS_DENIED', 429: 'RATE_LIMITED', 404: 'NOT_FOUND' };

export function tabFor(service) {
  return {
    client: { versionInfo: { Browser: 'FakeChrome/1.0' } },
    request: async ({ path, method = 'GET', body, stream = false }) => {
      const parsedBody = body == null ? null : (typeof body === 'string' ? JSON.parse(body) : body);
      const resp = await service.handle({ method, path, body: parsedBody });
      if (!(resp.status >= 200 && resp.status < 300)) {
        const code = STATUS_CODES[resp.status] ?? (resp.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'HTTP_ERROR');
        throw new BridgeError(code, `Claude API returned HTTP ${resp.status}`, { status: resp.status });
      }
      if (stream) {
        if (!String(resp.contentType).includes('text/event-stream')) {
          throw new BridgeError('API_CONTRACT', 'not an event stream');
        }
        return consumeCompletion(streamFromString(resp.body), {});
      }
      return JSON.parse(resp.body);
    },
  };
}

export function fakeWithTab(service) {
  const catalogOptions = service.modelOptions?.length
    ? service.modelOptions
    : [...new Set([service.model, 'claude-opus-5-9'])];
  const tab = tabFor(service);
  tab.evaluate = async expression => {
    if (!expression.includes('pageModelPicker')) throw new Error('Unexpected fake tab evaluation');
    const match = expression.match(/\)\((\{.*\})\)$/s);
    const args = match ? JSON.parse(match[1]) : {};
    const optionLabel = model => `Claude ${model.split('/').at(-1).replace(/^claude-/, '')}`;
    const options = catalogOptions;
    if (args.action === 'select') {
      const target = options.find(model => args.matchModelIds.includes(model));
      if (target) service.model = target;
    }
    return {
      ok: true,
      ready: true,
      triggerText: optionLabel(service.model),
      triggerModelId: service.model,
      options,
    };
  };
  return async (config, fn) => {
    const hadCatalog = Object.hasOwn(config, 'modelCatalog');
    const oldCatalog = config.modelCatalog;
    config.modelCatalog = async () => ({
      defaultModel: 'claude-opus-5-9',
      models: catalogOptions.map(id => ({
        hostId: 'fixture', id, normalized: id.toLowerCase(), series: id.includes('opus') ? 'opus' : null,
      })),
    });
    try {
      return await fn(tab);
    } finally {
      if (hadCatalog) config.modelCatalog = oldCatalog;
      else delete config.modelCatalog;
    }
  };
}
