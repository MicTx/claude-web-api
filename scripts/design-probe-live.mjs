import { SourceByteCapture, SourceClaimCapture } from './design-probe-source.mjs';
import { BridgeError } from '../src/core/errors.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TARGET_ID = /^[a-f0-9]{32}$/i;
const SHORT_ID = /^[A-Za-z0-9_-]{10,80}$/;
const VERSION = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BUFFERED = 1024;
const MAX_WAIT_MS = 12_000;
const CREATE_TIMEOUT_MS = 5_000;
const NAVIGATE_TIMEOUT_MS = 15_000;
const SAFE_FAILURES = new Set(['ABORTED', 'APPROVAL_CHANGED', 'APPROVAL_INVALID', 'APPROVAL_SCOPE', 'BUDGET_EXHAUSTED',
  'LEDGER_CHANGED', 'LEDGER_INVALID', 'LEDGER_UNSAFE', 'LOCK_LOST', 'ROOT_UNSAFE']);
const READ_COST = Object.freeze({ reads: 1, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0 });
const DOWNLOAD_COST = Object.freeze({ reads: 1, sessions: 0, messages: 0, downloads: 1, uploads: 0, shares: 0 });
const SCOPE_FUNCTION = `function(expected, blank) {
  const same = blank ? location.href === 'about:blank' : location.origin === 'https://claude.ai' && location.pathname === expected;
  const body = document.body;
  const empty = !blank || (!!body && body.childNodes.length === 0 && !!document.head && document.head.childNodes.length === 0);
  return { same, empty, hidden: document.visibilityState === 'hidden', focused: document.hasFocus(), ready: document.readyState === 'complete' };
}`;
const HASH_FUNCTION = `async function(encoded) {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}`;

function fail(code, details = {}) {
  throw new BridgeError(code, 'The passive source probe did not establish a verified result', details);
}

function checkAbort(signal) {
  if (signal?.aborted) fail('ABORTED');
}

function validTarget(target) {
  return target && typeof target === 'object' && !Array.isArray(target)
    && typeof target.organizationId === 'string' && UUID.test(target.organizationId)
    && typeof target.frameId === 'string' && UUID.test(target.frameId)
    && typeof target.shortId === 'string' && SHORT_ID.test(target.shortId)
    && typeof target.version === 'string' && VERSION.test(target.version)
    && Number.isSafeInteger(target.size) && target.size > 0 && target.size <= 2 * 1024 * 1024
    && typeof target.sha256 === 'string' && SHA256.test(target.sha256);
}

function isArtifactUrl(raw, path) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && parsed.hostname === 'claude.ai' && !parsed.port
      && !parsed.username && !parsed.password && parsed.pathname === path;
  } catch {
    return false;
  }
}

function relevantUrl(raw, target) {
  if (typeof raw !== 'string' || raw.length > 4096) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return false;
    return (parsed.hostname === 'claude.ai' && parsed.pathname.toLowerCase() === `/api/frame/${target.frameId.toLowerCase()}`)
      || (parsed.hostname === `${target.frameId.toLowerCase()}.frame.claudeusercontent.com`
        && parsed.pathname === `/_f/${target.version}/_src/index.html`);
  } catch {
    return false;
  }
}

function responseHeaders(headers) {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers !== 'object' || Array.isArray(headers)) return 'invalid';
  const keys = Object.keys(headers).filter(key => key.toLowerCase() === 'content-length');
  if (keys.length > 1) return 'invalid';
  return keys.length === 0 ? {} : { 'content-length': headers[keys[0]] };
}

function sanitizeEvent(message, sessionId, target, knownRequests) {
  if (!message || typeof message !== 'object') return null;
  const method = message.method;
  if (method === 'Target.detachedFromTarget') {
    return message.params?.sessionId === sessionId ? { method, params: { sessionId } } : null;
  }
  if (message.sessionId !== sessionId || method === 'Network.requestWillBeSentExtraInfo'
    || method === 'Network.responseReceivedExtraInfo') return null;
  const params = message.params ?? {};
  if (method === 'Page.frameNavigated') {
    let path = null;
    try {
      const parsed = new URL(params.frame?.url);
      if (parsed.origin === 'https://claude.ai') path = parsed.pathname;
    } catch {}
    return { method, sessionId, params: { frame: { id: params.frame?.id, loaderId: params.frame?.loaderId, path } } };
  }
  if (method === 'Page.navigatedWithinDocument') {
    let path = null;
    try {
      const parsed = new URL(params.url);
      if (parsed.origin === 'https://claude.ai') path = parsed.pathname;
    } catch {}
    return { method, sessionId, params: { frameId: params.frameId, path } };
  }
  if (method === 'Page.frameDetached') return { method, sessionId, params: { frameId: params.frameId } };
  if (method === 'Network.requestWillBeSent') {
    const known = knownRequests.has(params.requestId);
    if (!known && !relevantUrl(params.request?.url, target)) return null;
    if (typeof params.requestId !== 'string' || params.requestId.length > 128) return null;
    if (!known && knownRequests.size >= 16) throw new Error('event limit');
    knownRequests.add(params.requestId);
    return { method, sessionId, params: { requestId: params.requestId, frameId: params.frameId, loaderId: params.loaderId,
      request: { method: params.request?.method, url: relevantUrl(params.request?.url, target) ? params.request.url : 'invalid' },
      ...(params.redirectResponse === undefined ? {} : { redirectResponse: {} }) } };
  }
  if (!knownRequests.has(params.requestId)) return null;
  if (method === 'Network.responseReceived') {
    const response = params.response ?? {};
    return { method, sessionId, params: { requestId: params.requestId, frameId: params.frameId, loaderId: params.loaderId,
      response: { url: relevantUrl(response.url, target) ? response.url : 'invalid', status: response.status,
        mimeType: response.mimeType, fromDiskCache: response.fromDiskCache, fromPrefetchCache: response.fromPrefetchCache,
        fromServiceWorker: response.fromServiceWorker, headers: responseHeaders(response.headers) } } };
  }
  if (method === 'Network.dataReceived') return { method, sessionId, params: { requestId: params.requestId, dataLength: params.dataLength } };
  if (['Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache'].includes(method)) {
    return { method, sessionId, params: { requestId: params.requestId } };
  }
  return null;
}

function observePage(client, sessionId, target, path) {
  const knownRequests = new Set();
  const buffer = [];
  const waiters = new Set();
  let metadata = null;
  let bytes = null;
  let overflow = false;
  let initialNavigation = false;
  let navigation = null;
  const notify = () => { for (const waiter of waiters) waiter(); };
  const invalidate = () => {
    overflow = true;
    metadata?.invalidate();
    bytes?.invalidate();
    notify();
  };
  const feed = item => {
    if (item.method === 'Page.navigatedWithinDocument' && item.params.frameId === navigation.frameId) {
      if (item.params.path !== path) {
        const invalidation = { method: 'Page.frameDetached', sessionId, params: { frameId: navigation.frameId } };
        metadata.observe(invalidation);
        bytes.observe(invalidation);
        notify();
      }
      return;
    }
    if (item.method === 'Page.frameNavigated' && item.params.frame?.id === navigation.frameId && !initialNavigation
      && item.params.frame.loaderId === navigation.loaderId && item.params.frame.path === path) {
      initialNavigation = true;
      notify();
      return;
    }
    metadata.observe(item);
    bytes.observe(item);
    notify();
  };
  const unsubscribe = client.subscribe(message => {
    try {
      const item = sanitizeEvent(message, sessionId, target, knownRequests);
      if (!item) return;
      if (metadata) feed(item);
      else if (buffer.length < MAX_BUFFERED) buffer.push(item);
      else invalidate();
    } catch {
      invalidate();
    }
  });
  return {
    start(value) {
      if (overflow || typeof value?.frameId !== 'string' || typeof value?.loaderId !== 'string') fail('SOURCE_UNVERIFIED');
      navigation = { frameId: value.frameId, loaderId: value.loaderId };
      const scope = { sessionId, mainFrameId: value.frameId, loaderId: value.loaderId,
        orgId: target.organizationId, frameUuid: target.frameId };
      metadata = new SourceClaimCapture(scope);
      bytes = new SourceByteCapture(scope, target);
      for (const item of buffer) feed(item);
      buffer.length = 0;
      if (overflow) fail('SOURCE_UNVERIFIED');
    },
    get metadata() { return metadata; },
    get bytes() { return bytes; },
    get navigationReady() { return initialNavigation; },
    async wait(capture, signal, timeoutMs) {
      if (overflow) return 'unverified';
      if (capture.status !== 'pending') return capture.status;
      return new Promise(resolve => {
        let timer;
        const finish = value => {
          clearTimeout(timer);
          waiters.delete(onChange);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish('aborted');
        const onChange = () => {
          if (overflow) finish('unverified');
          else if (capture.status !== 'pending') finish(capture.status);
        };
        waiters.add(onChange);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish('timeout'), timeoutMs);
        if (signal?.aborted) onAbort();
        else onChange();
      });
    },
    async waitNavigation(signal, timeoutMs) {
      if (overflow) return false;
      if (initialNavigation) return true;
      return new Promise(resolve => {
        let timer;
        const finish = value => {
          clearTimeout(timer);
          waiters.delete(onChange);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => finish(false);
        const onChange = () => { if (overflow || initialNavigation) finish(!overflow && initialNavigation); };
        waiters.add(onChange);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(false), timeoutMs);
        if (signal?.aborted) onAbort();
        else onChange();
      });
    },
    close() { unsubscribe(); buffer.length = 0; knownRequests.clear(); },
  };
}

async function defaultConnect(signal) {
  const [{ CdpClient }, { loadConfig }] = await Promise.all([import('../src/core/cdp.mjs'), import('../src/config.mjs')]);
  const config = loadConfig();
  return CdpClient.connect(config.cdpUrl, { signal, timeoutMs: config.readyTimeoutMs });
}

function scopeResult(result, { requireReady = true } = {}) {
  if (result?.exceptionDetails || !result?.result || !result.result.value || typeof result.result.value !== 'object') return false;
  const value = result.result.value;
  return value.same === true && value.empty === true && value.hidden === true && value.focused === false
    && typeof value.ready === 'boolean' && (!requireReady || value.ready === true);
}

export async function runPassiveSource(context, { connect = defaultConnect, timeoutMs = MAX_WAIT_MS } = {}) {
  let target;
  try {
    target = { organizationId: context.sourceTarget.organizationId, frameId: context.sourceTarget.frameId,
      shortId: context.sourceTarget.shortId, version: context.sourceTarget.version,
      size: context.sourceTarget.size, sha256: context.sourceTarget.sha256 };
    if (!validTarget(target) || typeof context.perform !== 'function' || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS) throw new Error('invalid');
  } catch {
    fail('SOURCE_UNVERIFIED');
  }
  const deadline = AbortSignal.timeout(120_000);
  const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
  const path = `/artifact/${target.shortId}`;
  let client;
  let targetId;
  let sessionId;
  let frameId;
  let observer;
  let creationUncertain = false;
  let metadataMatched = false;
  let sourceObserved = false;
  let targetRetained = false;
  let outcome;
  let failure;
  const perform = (cost, action) => context.perform(cost, action);
  const read = (method, params = {}, session = sessionId) => perform(READ_COST, () => {
    checkAbort(signal);
    return client.send(method, params, { ...(session ? { sessionId: session } : {}), signal, timeoutMs: CREATE_TIMEOUT_MS });
  });
  try {
    checkAbort(signal);
    client = await perform(READ_COST, () => connect(signal));
    checkAbort(signal);
    let created;
    let creationDispatched = false;
    try {
      created = await perform(READ_COST, () => {
        creationDispatched = true;
        return client.send('Target.createTarget', { url: 'about:blank', background: true }, { timeoutMs: CREATE_TIMEOUT_MS });
      });
    } catch (error) {
      if (creationDispatched) creationUncertain = true;
      throw error;
    }
    if (!TARGET_ID.test(created?.targetId ?? '')) { creationUncertain = true; fail('SOURCE_UNVERIFIED'); }
    targetId = created.targetId;
    checkAbort(signal);
    const attached = await read('Target.attachToTarget', { targetId, flatten: true }, null);
    if (typeof attached.sessionId !== 'string' || !attached.sessionId) fail('SOURCE_UNVERIFIED');
    sessionId = attached.sessionId;
    await read('Page.enable');
    await read('Network.enable');
    const initial = await read('Target.getTargetInfo', { targetId }, null);
    if (initial.targetInfo?.targetId !== targetId || initial.targetInfo?.url !== 'about:blank') fail('SOURCE_UNVERIFIED');
    const tree = await read('Page.getFrameTree');
    frameId = tree.frameTree?.frame?.id;
    if (typeof frameId !== 'string' || !frameId) fail('SOURCE_UNVERIFIED');
    const blankWorld = await read('Page.createIsolatedWorld', { frameId, worldName: 'ccw-design-blank' });
    if (!Number.isSafeInteger(blankWorld.executionContextId)) fail('SOURCE_UNVERIFIED');
    const blank = await read('Runtime.callFunctionOn', { functionDeclaration: SCOPE_FUNCTION,
      executionContextId: blankWorld.executionContextId, arguments: [{ value: '' }, { value: true }], returnByValue: true });
    if (!scopeResult(blank)) fail('SOURCE_UNVERIFIED');
    observer = observePage(client, sessionId, target, path);
    const navigation = await perform({ ...READ_COST, reads: 3 }, async () => {
      checkAbort(signal);
      const info = await client.send('Target.getTargetInfo', { targetId }, { signal, timeoutMs: CREATE_TIMEOUT_MS });
      if (info.targetInfo?.targetId !== targetId || info.targetInfo?.url !== 'about:blank') fail('SOURCE_UNVERIFIED');
      const state = await client.send('Runtime.callFunctionOn', { functionDeclaration: SCOPE_FUNCTION,
        executionContextId: blankWorld.executionContextId, arguments: [{ value: '' }, { value: true }], returnByValue: true },
      { sessionId, signal, timeoutMs: CREATE_TIMEOUT_MS });
      if (!scopeResult(state)) fail('SOURCE_UNVERIFIED');
      checkAbort(signal);
      return client.send('Page.navigate', { url: `https://claude.ai${path}` }, { sessionId, signal, timeoutMs: NAVIGATE_TIMEOUT_MS });
    });
    if (navigation.errorText || navigation.frameId !== frameId || typeof navigation.loaderId !== 'string') fail('SOURCE_UNVERIFIED');
    observer.start(navigation);
    if (!(await observer.waitNavigation(signal, timeoutMs))) fail('SOURCE_UNVERIFIED');
    const world = await read('Page.createIsolatedWorld', { frameId, worldName: 'ccw-design-artifact' });
    if (!Number.isSafeInteger(world.executionContextId)) fail('SOURCE_UNVERIFIED');
    const verifyScope = async () => {
      const info = await read('Target.getTargetInfo', { targetId }, null);
      if (info.targetInfo?.targetId !== targetId || !isArtifactUrl(info.targetInfo.url, path)) return false;
      const status = await read('Runtime.callFunctionOn', { functionDeclaration: SCOPE_FUNCTION,
        executionContextId: world.executionContextId, arguments: [{ value: path }, { value: false }], returnByValue: true });
      return scopeResult(status, { requireReady: false });
    };
    if (!(await verifyScope())) fail('SOURCE_UNVERIFIED');
    if (await observer.wait(observer.metadata, signal, timeoutMs) !== 'ready') fail('SOURCE_UNVERIFIED');
    const expected = { version: target.version, size: target.size, sha256: target.sha256 };
    const manifest = await observer.metadata.claim(expected, requestId => read('Network.getResponseBody', { requestId }), verifyScope);
    if (manifest.status !== 'matched') fail('SOURCE_UNVERIFIED');
    metadataMatched = true;
    if (await observer.wait(observer.bytes, signal, timeoutMs) !== 'ready') fail('SOURCE_UNVERIFIED');
    sourceObserved = true;
    const checked = await observer.bytes.check(manifest,
      requestId => perform(DOWNLOAD_COST, () => client.send('Network.getResponseBody', { requestId },
        { sessionId, signal, timeoutMs: CREATE_TIMEOUT_MS })),
      bytes => read('Runtime.callFunctionOn', { functionDeclaration: HASH_FUNCTION, executionContextId: world.executionContextId,
        arguments: [{ value: bytes.toString('base64') }], returnByValue: true, awaitPromise: true }).then(result => result?.result?.value),
      verifyScope);
    if (checked.status !== 'matched') fail('SOURCE_UNVERIFIED');
    outcome = { kind: 'source-evidence', size: checked.size, sha256: checked.sha256, metadataMatched: true, sourceObserved: true };
  } catch (error) {
    try {
      const code = error?.code;
      failure = context.signal?.aborted ? 'ABORTED' : deadline.aborted ? 'SOURCE_TIMEOUT'
        : typeof code === 'string' && SAFE_FAILURES.has(code) ? code : 'SOURCE_UNVERIFIED';
    }
    catch { failure = 'SOURCE_UNVERIFIED'; }
  } finally {
    try { observer?.close(); } catch { failure ??= 'SOURCE_UNVERIFIED'; }
    targetRetained = Boolean(targetId);
    try { client?.close(); } catch { targetRetained = Boolean(targetId); failure ??= 'SOURCE_UNVERIFIED'; }
  }
  const details = { metadataMatched, sourceObserved, targetRetained, creationUncertain };
  if (failure) fail(creationUncertain ? 'TARGET_CREATION_UNCERTAIN' : failure, details);
  return { ...outcome, targetRetained };
}
