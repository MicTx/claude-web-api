import { BridgeError } from './errors.mjs';

const MAX_VERSION_BYTES = 64 * 1024;

function normalizeLoopback(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return 'loopback';
  }
  return host;
}

function validateDebuggerUrl(raw, requested) {
  let wsUrl;
  try {
    wsUrl = new URL(raw);
  } catch {
    throw new BridgeError('CDP_INVALID', 'Browser returned an invalid WebSocket debugger URL');
  }
  if (wsUrl.protocol !== 'ws:') {
    throw new BridgeError('CDP_INVALID', 'Browser debugger URL must use ws://');
  }
  if (normalizeLoopback(wsUrl.hostname) !== 'loopback') {
    throw new BridgeError('CDP_INVALID', 'Browser debugger URL is not loopback');
  }
  if (wsUrl.port !== requested.port) {
    throw new BridgeError('CDP_INVALID', 'Browser debugger URL port does not match the requested endpoint');
  }
  if (!wsUrl.pathname.startsWith('/devtools/browser/')) {
    throw new BridgeError('CDP_INVALID', 'Browser debugger URL is not a browser target');
  }
  if (wsUrl.username !== '' || wsUrl.password !== '' || wsUrl.search !== '' || wsUrl.hash !== '') {
    throw new BridgeError('CDP_INVALID', 'Browser debugger URL must not contain credentials or query');
  }
  return wsUrl.href;
}

async function readBoundedBody(res, maxBytes) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BridgeError('CDP_INVALID', 'CDP version response is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // reader may already be errored
    }
    try {
      reader.releaseLock?.();
    } catch {
      // optional on custom readers
    }
  }
}

export class CdpClient {
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #listeners = new Set();

  constructor(ws, versionInfo) {
    this.#ws = ws;
    this.versionInfo = versionInfo;
    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => this.#onClose());
  }

  static async connect(cdpUrl, { signal, timeoutMs = 5000 } = {}) {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const base = new URL(cdpUrl);
    const versionUrl = new URL('/json/version', base);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let info;
    try {
      // headers arriving must not end the deadline: the timer stays armed
      // through the bounded streaming body read and JSON parse
      const res = await fetch(versionUrl, { redirect: 'error', signal: controller.signal });
      if (!res.ok) {
        throw new BridgeError('CDP_UNREACHABLE', `CDP endpoint returned HTTP ${res.status}`);
      }
      const text = await readBoundedBody(res, MAX_VERSION_BYTES);
      info = JSON.parse(text);
    } catch (error) {
      if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
      if (error instanceof BridgeError) throw error;
      if (controller.signal.aborted) {
        throw new BridgeError('CDP_UNREACHABLE', `Timed out contacting CDP endpoint ${cdpUrl}`);
      }
      throw new BridgeError('CDP_UNREACHABLE', `Cannot reach CDP endpoint ${cdpUrl}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (!info || typeof info !== 'object') {
      throw new BridgeError('CDP_INVALID', 'CDP version response is not valid JSON');
    }
    const wsHref = validateDebuggerUrl(info.webSocketDebuggerUrl, base);

    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');

    const ws = await new Promise((resolve, reject) => {
      const sock = new WebSocket(wsHref);
      let settled = false;
      const cleanup = () => {
        clearTimeout(wtimer);
        signal?.removeEventListener('abort', onAbortWs);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const wtimer = setTimeout(() => {
        try {
          sock.close();
        } catch { /* ignore */ }
        settle(reject, new BridgeError('CDP_UNREACHABLE', 'Timed out opening CDP WebSocket'));
      }, timeoutMs);
      const onAbortWs = () => {
        try {
          sock.close();
        } catch { /* ignore */ }
        settle(reject, new BridgeError('ABORTED', 'Operation aborted'));
      };
      signal?.addEventListener('abort', onAbortWs, { once: true });
      sock.addEventListener('open', () => settle(resolve, sock), { once: true });
      sock.addEventListener('error', () => settle(reject, new BridgeError('CDP_UNREACHABLE', 'Failed to open CDP WebSocket')), { once: true });
    });

    return new CdpClient(ws, { Browser: info.Browser, webSocketDebuggerUrl: wsHref });
  }

  #onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg == null) return;
    if (typeof msg.id !== 'number') {
      if (typeof msg.method === 'string') for (const listener of this.#listeners) listener(msg);
      return;
    }
    const entry = this.#pending.get(msg.id);
    if (!entry) return;
    this.#pending.delete(msg.id);
    entry.cleanup();
    if (msg.error) {
      entry.reject(new BridgeError('CDP_ERROR', `CDP ${entry.method} failed: ${cleanRemote(msg.error.message)}`, {
        method: entry.method,
        cdpCode: typeof msg.error.code === 'number' ? msg.error.code : null,
      }));
    } else {
      entry.resolve(msg.result ?? {});
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    const error = new BridgeError('CDP_CLOSED', 'CDP WebSocket closed');
    for (const entry of this.#pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.#pending.clear();
    this.#listeners.clear();
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get closed() {
    return this.#closed;
  }

  async send(method, params = {}, { sessionId, signal, timeoutMs = 10_000 } = {}) {
    if (this.#closed) throw new BridgeError('CDP_CLOSED', 'CDP WebSocket is closed');
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const id = this.#nextId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
      };
      const failWith = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        failWith(new BridgeError('CDP_TIMEOUT', `CDP ${method} timed out after ${timeoutMs}ms`, { method }));
      }, timeoutMs);
      const onAbort = () => failWith(new BridgeError('ABORTED', 'Operation aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        cleanup,
      });
      try {
        this.#ws.send(JSON.stringify(frame));
      } catch {
        failWith(new BridgeError('CDP_CLOSED', 'CDP WebSocket send failed'));
      }
    });
  }

  close() {
    if (this.#closed) return;
    try {
      this.#ws.close();
    } catch {
      // already gone
    }
    this.#onClose();
  }
}

function cleanRemote(message) {
  if (typeof message !== 'string') return 'remote error';
  return message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
}
