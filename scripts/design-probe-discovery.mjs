import { BridgeError } from '../src/core/errors.mjs';

const TARGET = /^[a-f0-9]{32}$/i;
const COST = Object.freeze({ reads: 1, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0 });
const ROUTE_SEGMENTS = new Set(['api', 'frame', 'frames', 'artifacts', 'folders', 'external', 'templates', 'types', 'catalog',
  'artifact_types', 'config', 'bootstrap', 'organizations', 'capabilities', 'settings', 'feature_flags', 'design', 'systems',
  'user_settings', 'chat_conversations', 'startup']);
const MIME_TYPES = new Set(['application/json', 'text/html', 'text/plain', 'text/event-stream']);

export function discoveryRoute(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x20\x7f\\]/u.test(raw)) return null;
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password
      || !url.pathname.startsWith('/api/')) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length > 12) return null;
    return `/${segments.map(segment => ROUTE_SEGMENTS.has(segment) ? segment : ':segment').join('/')}`;
  } catch { return null; }
}

export function validDiscoveryRoutes(value) {
  return Array.isArray(value) && value.length <= 32 && value.every(route => route && typeof route === 'object'
    && Object.keys(route).length === 4 && ['page', 'path', 'mime', 'statusClass'].every(key => Object.hasOwn(route, key))
    && ['/new', '/artifacts'].includes(route.page) && typeof route.path === 'string' && route.path.startsWith('/api/')
    && route.path.split('/').slice(1).every(segment => ROUTE_SEGMENTS.has(segment) || segment === ':segment')
    && ['application/json', 'text/html', 'text/plain', 'text/event-stream', 'other'].includes(route.mime)
    && ['2xx', '3xx', '4xx', '5xx', 'other'].includes(route.statusClass));
}
const BLANK = `function() {
  return location.href === 'about:blank' && document.visibilityState === 'hidden' && !document.hasFocus()
    && document.readyState === 'complete' && document.body?.childNodes.length === 0 && document.head?.childNodes.length === 0;
}`;
const INSPECT = `async function(expected) {
  const end = Date.now() + 8000;
  for (;;) {
    if (location.origin !== 'https://claude.ai' || location.pathname !== expected
      || document.visibilityState !== 'hidden' || document.hasFocus()) return null;
    const editor = document.querySelector('[data-testid="chat-input"][contenteditable="true"]');
    if (editor && (typeof editor.innerText !== 'string' || editor.innerText.trim())) return null;
    if (document.querySelector('input[type="file"]')?.files?.length) return null;
    const buttons = [...document.querySelectorAll('button,[role="button"],a')];
    if (buttons.some(button => /^(Remove|移除)(\\s|$)/u.test(button.getAttribute('aria-label') || ''))) return null;
    if ((document.readyState === 'complete' || document.readyState === 'interactive') && (expected !== '/new' || editor)) {
      const exact = names => buttons.some(button => names.includes((button.getAttribute('aria-label') || button.innerText || '').trim()));
      return { designControl: exact(['Design','设计']), designSystemControl: exact(['Design system','Design System','设计系统']),
        draftEmpty: true, hidden: true };
    }
    if (Date.now() >= end) return null;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}`;

export async function runDesignDiscovery(context, { connect } = {}) {
  let client;
  let targetId;
  let sessionId;
  let creationUncertain = false;
  let unsubscribe;
  let invalidScope = false;
  let currentPath = 'about:blank';
  let nextPath = null;
  let mainFrameId;
  let observedNavigation = null;
  let navigationReady = false;
  const listeners = new Set();
  const requests = new Map();
  const routes = new Map();
  let requestCount = 0;
  let truncated = false;
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  try {
    if (typeof connect !== 'function') {
      connect = async () => {
        const [{ CdpClient }, { loadConfig }] = await Promise.all([import('../src/core/cdp.mjs'), import('../src/config.mjs')]);
        const config = loadConfig();
        return CdpClient.connect(config.cdpUrl, { signal, timeoutMs: 5_000 });
      };
    }
    client = await context.perform(COST, () => connect(signal));
    const send = (method, params = {}, session = sessionId) => {
      if (signal.aborted) throw Error('Aborted');
      return client.send(method, params, { ...(session ? { sessionId: session } : {}), signal, timeoutMs: 10_000 });
    };
    let frameId;
    await context.perform(COST, async () => {
      creationUncertain = true;
      const created = await client.send('Target.createTarget', { url: 'about:blank', background: true }, { timeoutMs: 5_000 });
      if (!TARGET.test(created?.targetId ?? '')) throw Error('Unidentified target');
      targetId = created.targetId;
      creationUncertain = false;
      const attached = await send('Target.attachToTarget', { targetId, flatten: true }, null);
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw Error('Unidentified session');
      sessionId = attached.sessionId;
      unsubscribe = client.subscribe(event => {
        if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === sessionId) invalidScope = true;
        if (event.sessionId !== sessionId) return;
        if (event.method === 'Network.requestWillBeSent' && event.params?.request?.method === 'GET'
          && event.params.frameId === mainFrameId) {
          const path = discoveryRoute(event.params.request.url);
          const page = nextPath ?? currentPath;
          if (path && ['/new', '/artifacts'].includes(page)) {
            if (++requestCount > 256) truncated = true;
            else requests.set(event.params.requestId, { path, page });
          }
        }
        if (event.method === 'Network.responseReceived') {
          const request = requests.get(event.params?.requestId);
          requests.delete(event.params?.requestId);
          const response = event.params?.response;
          if (request && discoveryRoute(response?.url) === request.path) {
            const mime = MIME_TYPES.has(response.mimeType) ? response.mimeType : 'other';
            const statusClass = Number.isInteger(response.status) && response.status >= 200 && response.status < 600
              ? `${Math.floor(response.status / 100)}xx` : 'other';
            const route = { page: request.page, path: request.path, mime, statusClass };
            const identity = JSON.stringify(route);
            if (routes.size < 32 || routes.has(identity)) routes.set(identity, route);
            else truncated = true;
          }
        }
        if (event.method === 'Page.javascriptDialogOpening') invalidScope = true;
        const frame = event.params?.frame;
        if (event.method === 'Page.frameNavigated' && frame?.id === mainFrameId) {
          const expected = nextPath ?? currentPath;
          if (frame.url !== `https://claude.ai${expected}` || !nextPath || observedNavigation) invalidScope = true;
          else observedNavigation = { frameId: frame.id, loaderId: frame.loaderId };
        }
        if (event.method === 'Page.navigatedWithinDocument' && event.params?.frameId === mainFrameId
          && event.params.url !== `https://claude.ai${nextPath ?? currentPath}`) invalidScope = true;
        if (event.method === 'Page.frameDetached' && event.params?.frameId === mainFrameId) invalidScope = true;
        if (event.method === 'Page.domContentEventFired' && observedNavigation) navigationReady = true;
        for (const listener of listeners) listener();
      });
      await send('Page.enable');
      await send('Network.enable');
      const tree = await send('Page.getFrameTree');
      frameId = tree.frameTree?.frame?.id;
      mainFrameId = frameId;
      if (typeof frameId !== 'string' || !frameId) throw Error('Missing frame');
      const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'ccw-discovery-blank' });
      if (!Number.isSafeInteger(world.executionContextId)) throw Error('Missing world');
      const blank = await send('Runtime.callFunctionOn', { functionDeclaration: BLANK, executionContextId: world.executionContextId, returnByValue: true });
      if (blank.exceptionDetails || blank.result?.value !== true) throw Error('Unverified blank page');
    });
    let expectedPath = 'about:blank';
    const navigate = path => context.perform(COST, async () => {
      if (invalidScope) throw Error('Changed page');
      const info = await send('Target.getTargetInfo', { targetId }, null);
      if (info.targetInfo?.targetId !== targetId || info.targetInfo.url !== (expectedPath === 'about:blank' ? expectedPath : `https://claude.ai${expectedPath}`)) throw Error('Changed target');
      const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'ccw-discovery-scope' });
      if (!Number.isSafeInteger(world.executionContextId)) throw Error('Missing world');
      const checked = await send('Runtime.callFunctionOn', { functionDeclaration: expectedPath === 'about:blank' ? BLANK : INSPECT,
        executionContextId: world.executionContextId, arguments: [{ value: expectedPath }], returnByValue: true, awaitPromise: true });
      if (checked.exceptionDetails || !(expectedPath === 'about:blank' ? checked.result?.value === true : checked.result?.value?.hidden === true)) throw Error('Changed page');
      nextPath = path;
      observedNavigation = null;
      navigationReady = false;
      const result = await send('Page.navigate', { url: `https://claude.ai${path}` });
      if (result.errorText || result.frameId !== frameId || typeof result.loaderId !== 'string') throw Error('Navigation failed');
      if (!navigationReady && !invalidScope) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(false), 8_000);
        const onAbort = () => finish(false);
        const check = () => { if (navigationReady || invalidScope) finish(navigationReady && !invalidScope); };
        const finish = ready => {
          clearTimeout(timer);
          listeners.delete(check);
          signal.removeEventListener('abort', onAbort);
          if (ready) resolve(); else reject(Error('Navigation unavailable'));
        };
        listeners.add(check);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort(); else check();
      });
      if (invalidScope || observedNavigation?.loaderId !== result.loaderId) throw Error('Changed navigation');
      expectedPath = path;
      currentPath = path;
      nextPath = null;
    });
    const inspect = path => context.perform(COST, async () => {
      if (invalidScope) throw Error('Changed page');
      const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'ccw-discovery-inspect' });
      if (!Number.isSafeInteger(world.executionContextId)) throw Error('Missing world');
      const result = await send('Runtime.callFunctionOn', { functionDeclaration: INSPECT, executionContextId: world.executionContextId,
        arguments: [{ value: path }], returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails || invalidScope) throw Error('Inspection failed');
      return result;
    });
    await navigate('/new');
    const first = await inspect('/new');
    const initial = first?.result?.value;
    if (!initial || initial.draftEmpty !== true || initial.hidden !== true) throw Error('Unverified scope');
    await navigate('/artifacts');
    const second = await inspect('/artifacts');
    const current = second?.result?.value;
    if (!current || current.draftEmpty !== true || current.hidden !== true) throw Error('Unverified scope');
    return { kind: 'discovery-evidence', designControl: initial.designControl === true || current.designControl === true,
      designSystemControl: initial.designSystemControl === true || current.designSystemControl === true,
      draftEmpty: true, hidden: true, targetRetained: true, typeEvidence: 'unknown', routes: [...routes.values()], truncated };
  } catch {
    throw new BridgeError(creationUncertain ? 'TARGET_CREATION_UNCERTAIN' : signal.aborted ? 'ABORTED' : 'PROBE_FAILED',
      'The read-only Design discovery did not establish a verified scope', { targetRetained: Boolean(targetId), creationUncertain });
  } finally {
    try { unsubscribe?.(); } catch {}
    try { client?.close(); } catch {}
  }
}
