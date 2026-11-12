import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.mjs';
import { CdpClient } from './cdp.mjs';
import { consumeCompletion } from './sse.mjs';
import { MAX_DOWNLOAD_BYTES } from '../attachments.mjs';
import { inspectBlankComposer, canCloseBlankComposer } from './ui.mjs';
import { discoverClaudeBrowser } from './browser-discovery.mjs';

const CLAUDE_ORIGIN = 'https://claude.ai';
const CLAUDE_NEW_URL = 'https://claude.ai/new';
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_SSE_BYTES = 8 * 1024 * 1024;
const CLEANUP_MARGIN_MS = 5_000;
const READY_POLL_MS = 250;
const ABORT_CALL_MS = 2_000;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const CONVERSATION_QUERY = '\\?tree=True&rendering_mode=messages&render_all_tools=true';
const ROUTES = [
  { re: new RegExp('^/api/organizations$'), methods: ['GET'] },
  { re: new RegExp(`^/api/organizations/${UUID}/chat_conversations$`), methods: ['POST'] },
  { re: new RegExp(`^/api/organizations/${UUID}/chat_conversations/${UUID}${CONVERSATION_QUERY}$`), methods: ['GET'] },
  { re: new RegExp(`^/api/organizations/${UUID}/chat_conversations/${UUID}/completion$`), methods: ['POST'] },
  { re: new RegExp(`^/api/organizations/${UUID}/files/${UUID}/contents$`), methods: ['GET'], binary: true },
];

// ccwPageRequest is serialized into the Claude tab with
// Function.prototype.toString(); keep it self-contained. It only ever
// receives JSON.stringify'd args - prompts are never concatenated into code.
async function ccwPageRequest(args, consume) {
  const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  const fail = (code, message, details = {}) => ({ ok: false, error: { code, message: clean(message), details } });
  if (location.origin !== 'https://claude.ai') {
    return fail('ORIGIN_MISMATCH', 'Refusing to send requests from a non-Claude origin', { origin: String(location.origin).slice(0, 120) });
  }
  if (args.expectedPath && location.pathname !== args.expectedPath) {
    return fail('UI_CONTEXT_LOST', 'The owned page no longer shows the expected conversation');
  }
  const scopeChanged = () => location.origin !== 'https://claude.ai' || (args.expectedPath && location.pathname !== args.expectedPath);
  const controller = new AbortController();
  let idleTimer = null;
  const bumpIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort('idle'), args.idleMs);
  };
  const totalTimer = setTimeout(() => controller.abort('total'), args.totalMs);
  try {
    globalThis[args.opKey] = () => controller.abort('external');
  } catch {
    // abort handle is best-effort; the tab still gets closed by the owner
  }
  try {
    bumpIdle();
    const headers = {};
    if (args.body !== null && args.body !== undefined) headers['content-type'] = 'application/json';
    if (args.stream) headers.accept = 'text/event-stream';
    const res = await fetch(args.path, {
      method: args.method,
      headers,
      body: args.body ?? undefined,
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
    });
    if (scopeChanged()) return fail('UI_CONTEXT_LOST', 'The owned page changed during the request');
    if (!res.ok) {
      const status = res.status;
      const details = { status };
      let code = 'HTTP_ERROR';
      if (status === 401) code = 'AUTH_REQUIRED';
      else if (status === 403) code = 'ACCESS_DENIED';
      else if (status === 429) {
        code = 'RATE_LIMITED';
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) details.retryAfterSec = Math.min(Math.ceil(retryAfter), 86_400);
      } else if (status === 404) code = 'NOT_FOUND';
      else if (status >= 500 && status < 600) code = 'SERVICE_UNAVAILABLE';
      return fail(code, `Claude API returned HTTP ${status}`, details);
    }
    const ctype = String(res.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
    if (args.binary) {
      if (res.redirected || res.url !== new URL(args.path, location.origin).href) return fail('INVALID_SOURCE', 'File response changed origin or path');
      const length = res.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > args.maxBinaryBytes)) return fail('PAYLOAD_TOO_LARGE', 'File response length is invalid or too large');
      const reader = res.body.getReader();
      let size = 0;
      const parts = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (scopeChanged()) return fail('UI_CONTEXT_LOST', 'The owned page changed during the file transfer');
          if (done) break;
          size += value.byteLength;
          if (size > args.maxBinaryBytes) return fail('PAYLOAD_TOO_LARGE', 'File exceeds download limit');
          parts.push(value);
          bumpIdle();
        }
        let binary = '';
        for (const part of parts) {
          for (let start = 0; start < part.length; start += 8192) binary += String.fromCharCode(...part.subarray(start, start + 8192));
        }
        return { ok: true, value: { base64: btoa(binary), size, contentType: ctype } };
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    if (args.stream) {
      if (ctype !== 'text/event-stream') {
        return fail('API_CONTRACT', 'Completion endpoint did not return an event stream', { contentType: ctype.slice(0, 80) });
      }
      const inner = res.body.getReader();
      const wrapped = {
        getReader() {
          return {
            async read() {
              const r = await inner.read();
              if (!r.done) bumpIdle();
              return r;
            },
            cancel(reason) { return inner.cancel(reason); },
            releaseLock() { try { inner.releaseLock(); } catch { /* optional */ } },
          };
        },
      };
      const value = await consume(wrapped, { maxBytes: args.maxStreamBytes });
      if (scopeChanged()) return fail('UI_CONTEXT_LOST', 'The owned page changed during the response');
      return { ok: true, value };
    }
    if (ctype !== 'application/json') {
      return fail('API_CONTRACT', 'Endpoint did not return JSON', { contentType: ctype.slice(0, 80) });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > args.maxJsonBytes) {
          return fail('PAYLOAD_TOO_LARGE', 'JSON response exceeds size limit', { maxBytes: args.maxJsonBytes });
        }
        text += decoder.decode(value, { stream: true });
        bumpIdle();
      }
      text += decoder.decode();
    } finally {
      try { reader.releaseLock(); } catch { /* optional */ }
    }
    let value;
    if (scopeChanged()) return fail('UI_CONTEXT_LOST', 'The owned page changed during the response');
    try {
      value = JSON.parse(text);
    } catch {
      return fail('API_CONTRACT', 'Response is not valid JSON');
    }
    return { ok: true, value };
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason === 'external') return fail('ABORTED', 'Operation aborted');
      if (reason === 'idle') return fail('IDLE_TIMEOUT', `No data received for ${args.idleMs}ms`);
      return fail('TIMEOUT', `Request exceeded ${args.totalMs}ms`);
    }
    const code = error && typeof error.code === 'string' ? error.code : 'NETWORK_ERROR';
    const details = error && error.details && typeof error.details === 'object' ? error.details : {};
    return fail(code, error && error.message ? error.message : 'Request failed', details);
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    controller.abort('cleanup');
    try {
      delete globalThis[args.opKey];
    } catch {
      try { globalThis[args.opKey] = undefined; } catch { /* best effort */ }
    }
  }
}

function abortableDelay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new BridgeError('ABORTED', 'Operation aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BridgeError('ABORTED', 'Operation aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildExpression(args) {
  const consumeSrc = consumeCompletion.toString();
  const requestSrc = ccwPageRequest.toString();
  return `(async()=>{const consumeCompletion=${consumeSrc};const ccwPageRequest=${requestSrc};return ccwPageRequest(${JSON.stringify(args)},consumeCompletion);})()`;
}

class ClaudeTab {
  constructor(client, sessionId, config, cdpUrl) {
    this.client = client;
    this.sessionId = sessionId;
    this.config = config;
    this.cdpUrl = cdpUrl;
    this.expectedPath = '/new';
  }

  async evaluate(expression, { timeoutMs = 10_000, signal } = {}) {
    const res = await this.client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, { sessionId: this.sessionId, timeoutMs, signal });
    if (res.exceptionDetails) {
      throw new BridgeError('PAGE_EVAL_FAILED', 'Evaluation inside the Claude tab failed', {
        text: typeof res.exceptionDetails.text === 'string' ? res.exceptionDetails.text.slice(0, 200) : null,
      });
    }
    return res.result ? res.result.value : undefined;
  }

  async navigateConversation(conversationId, { signal } = {}) {
    if (!new RegExp(`^${UUID}$`).test(conversationId)) throw new BridgeError('INVALID_PATH', 'Invalid conversation identity');
    await inspectBlankComposer(this, { signal });
    this.expectedPath = `/chat/${conversationId}`;
    const result = await this.client.send('Page.navigate', { url: `${CLAUDE_ORIGIN}${this.expectedPath}` }, {
      sessionId: this.sessionId, signal, timeoutMs: this.config.readyTimeoutMs,
    });
    if (result.errorText || typeof result.frameId !== 'string') throw new BridgeError('UI_CONTEXT_LOST', 'Could not navigate the owned page');
    this.frameId = result.frameId;
    await this.waitReady({ signal });
  }

  async waitReady({ signal } = {}) {
    const deadline = Date.now() + this.config.readyTimeoutMs;
    let lastOrigin = null;
    let lastError = null;
    for (;;) {
      if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
      try {
        const raw = await this.evaluate('JSON.stringify({o:location.origin,r:document.readyState,p:location.pathname})', { timeoutMs: 5_000, signal });
        const state = JSON.parse(raw);
        lastOrigin = state.o;
        if (state.o === CLAUDE_ORIGIN && (!this.expectedPath || state.p === this.expectedPath)
          && (state.r === 'complete' || state.r === 'interactive')) {
          return;
        }
      } catch (error) {
        if (error instanceof BridgeError && error.code === 'ABORTED') throw error;
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await abortableDelay(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())), signal);
    }
    if (lastOrigin !== null && lastOrigin !== CLAUDE_ORIGIN) {
      throw new BridgeError('ORIGIN_MISMATCH', 'Created tab did not stay on the Claude origin', { origin: lastOrigin });
    }
    throw new BridgeError('READY_TIMEOUT', 'Claude tab did not become ready in time', {
      origin: lastOrigin,
      error: lastError ? lastError.code : null,
    });
  }

  async request({ path, method = 'GET', body, stream = false, binary = false }, { signal, timeoutMs, idleTimeoutMs } = {}) {
    const route = ROUTES.find((r) => r.re.test(path));
    if (!route || !route.methods.includes(method) || Boolean(route.binary) !== binary || (binary && (stream || body !== undefined))) {
      throw new BridgeError('INVALID_PATH', 'Refusing non-whitelisted Claude API path', { method, path });
    }
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const totalMs = timeoutMs ?? this.config.timeoutMs;
    const idleMs = Math.min(idleTimeoutMs ?? this.config.idleTimeoutMs, totalMs);
    const opKey = `__ccw_abort_${randomUUID().replaceAll('-', '_')}`;
    const args = {
      path,
      method,
      body: body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
      stream: Boolean(stream),
      binary,
      maxBinaryBytes: MAX_DOWNLOAD_BYTES,
      totalMs,
      idleMs,
      opKey,
      maxJsonBytes: MAX_JSON_BYTES,
      maxStreamBytes: MAX_SSE_BYTES,
      expectedPath: this.expectedPath ?? null,
    };
    const evalPromise = this.evaluate(buildExpression(args), { timeoutMs: totalMs + CLEANUP_MARGIN_MS });

    const settled = await new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        const call = `(globalThis[${JSON.stringify(opKey)}]||function(){})()`;
        this.evaluate(call, { timeoutMs: ABORT_CALL_MS }).catch(() => {});
        reject(new BridgeError('ABORTED', 'Operation aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      evalPromise.then(
        (value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({ status: 'value', value });
        },
        (error) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          resolve({ status: 'error', error });
        },
      );
    });

    if (settled.status === 'error') throw settled.error;
    const payload = settled.value;
    if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
      throw new BridgeError('API_CONTRACT', 'Page request returned an unexpected shape');
    }
    if (payload.ok) return payload.value;
    const err = payload.error && typeof payload.error === 'object' ? payload.error : {};
    throw new BridgeError(
      typeof err.code === 'string' ? err.code : 'REMOTE_ERROR',
      typeof err.message === 'string' ? err.message : 'Page request failed',
      err.details && typeof err.details === 'object' ? err.details : {},
    );
  }
}

async function closeOwnedTarget(client, targetId, tab, config) {
  try {
    const { targetInfo } = await client.send('Target.getTargetInfo', { targetId }, { timeoutMs: 1000 });
    const url = new URL(targetInfo.url);
    if (url.origin !== CLAUDE_ORIGIN || url.pathname !== (tab?.expectedPath ?? '/new')) return false;
    if (!tab) {
      const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }, { timeoutMs: 1000 });
      tab = new ClaudeTab(client, attached.sessionId, config);
    }
    if (tab.retainTarget || !(await canCloseBlankComposer(tab))) return false;
    const result = await client.send('Target.closeTarget', { targetId }, { timeoutMs: 1000 });
    return result.success === true;
  } catch {
    return false;
  }
}

export async function withClaudeTab(config, fn, { signal } = {}) {
  const cdpUrl = await (config.discoverBrowser ?? discoverClaudeBrowser)(config, { signal });
  const client = await CdpClient.connect(cdpUrl, { signal, timeoutMs: config.readyTimeoutMs });
  let targetId = null;
  let tab = null;
  let backgroundCleanup = false;
  let callbackResult;
  let failure;
  try {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const creationAbort = new AbortController();
    const creation = client.send('Target.createTarget', { url: CLAUDE_NEW_URL, background: true }, {
      signal: creationAbort.signal, timeoutMs: config.readyTimeoutMs + 1000,
    }).then(value => ({ value }), error => ({ error }));
    let timer, onAbort;
    const interrupted = new Promise(resolve => {
      timer = setTimeout(() => resolve({ interruption: 'CDP_TIMEOUT' }), config.readyTimeoutMs);
      onAbort = () => resolve({ interruption: 'ABORTED' });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    let outcome = await Promise.race([creation, interrupted]);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (outcome.interruption) {
      const interruption = outcome.interruption;
      outcome = await Promise.race([creation, new Promise(resolve => setTimeout(() => resolve(null), 40))]);
      if (!outcome) {
        backgroundCleanup = true;
        const cleanupDeadline = setTimeout(() => creationAbort.abort(), 1000);
        cleanupDeadline.unref();
        void creation.then(async result => {
          if (typeof result.value?.targetId === 'string') await closeOwnedTarget(client, result.value.targetId, null, config);
        }).finally(() => { clearTimeout(cleanupDeadline); client.close(); });
        throw new BridgeError(interruption, interruption === 'ABORTED' ? 'Operation aborted during target creation' : 'Target creation timed out', {
          cleanupPending: true, targetCreationUncertain: true,
        });
      }
      if (typeof outcome.value?.targetId === 'string') targetId = outcome.value.targetId;
      throw new BridgeError(interruption, interruption === 'ABORTED' ? 'Operation aborted' : 'Target creation timed out');
    }
    if (outcome.error) throw outcome.error;
    targetId = outcome.value?.targetId;
    if (typeof targetId !== 'string' || !targetId) throw new BridgeError('CDP_INVALID', 'Target creation did not return an identity', { cleanupPending: true, targetCreationUncertain: true });
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }, {
      signal,
      timeoutMs: config.readyTimeoutMs,
    });
    tab = new ClaudeTab(client, attached.sessionId, config, cdpUrl);
    await tab.waitReady({ signal });
    callbackResult = await fn(tab);
    return callbackResult;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const closed = targetId && !tab?.retainTarget ? await closeOwnedTarget(client, targetId, tab, config) : false;
    if (targetId && !closed) {
      const browserCleanup = { closeUnconfirmed: true, targetId };
      if (failure instanceof BridgeError) failure.details = { ...failure.details, browserCleanup };
      else if (callbackResult && typeof callbackResult === 'object' && !Array.isArray(callbackResult) && Object.isExtensible(callbackResult)) {
        callbackResult.browserCleanup = browserCleanup;
      }
    }
    if (!backgroundCleanup) client.close();
  }
}
