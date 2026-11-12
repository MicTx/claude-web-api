import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SessionStore } from '../src/session-store.mjs';
import { ClaudeApi } from '../src/core/claude-api.mjs';
import { NativeComposer, inspectBlankComposer } from '../src/core/ui.mjs';
import { loadConfig } from '../src/config.mjs';
import { BridgeError } from '../src/core/errors.mjs';
import { confirmMutationTurn, mutationTurn, publicationManifest } from './design-probe-turns.mjs';

export const MUTATION_PROMPT = 'Create a minimal synthetic Design one-pager titled CCW-DESIGN-PROBE. '
  + 'Include one red square and the exact text 设计 😀. Do not share it and do not create any other artifact.';
const ROOT = '00000000-0000-4000-8000-000000000000';
const ORIGIN = 'https://claude.ai';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_ID = /^[a-f0-9]{32}$/i;
const READ = Object.freeze({ reads: 1, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0 });
const SESSION = Object.freeze({ reads: 0, sessions: 1, messages: 0, downloads: 0, uploads: 0, shares: 0 });
const MESSAGE = Object.freeze({ reads: 0, sessions: 0, messages: 1, downloads: 0, uploads: 0, shares: 0 });
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const NAVIGATE_TIMEOUT_MS = 20_000;
const METADATA_TIMEOUT_MS = 30_000;
const API_ROUTES = [
  { pattern: /^\/api\/organizations$/, method: 'GET', cost: READ },
  { pattern: /^\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations$/, method: 'POST', cost: SESSION },
  { pattern: /^\/api\/organizations\/[0-9a-f-]{36}\/chat_conversations\/[0-9a-f-]{36}\?tree=True/, method: 'GET', cost: READ },
];
const completionPath = (orgId, conversationId) =>
  `/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`;

const READY_SNAPSHOT = 'JSON.stringify({o:location.origin,r:document.readyState,p:location.pathname})';
const SCOPE_CHECK = `function(expected, checkFocus) {
  return location.origin === '${ORIGIN}' && location.pathname === expected
    && document.visibilityState === 'hidden' && (!checkFocus || !document.hasFocus());
}`;
const PAGE_FETCH = `async function(args) {
  if (location.origin !== '${ORIGIN}') return { ok: false, code: 'ORIGIN_MISMATCH' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('total'), args.totalMs);
  try {
    const res = await fetch(args.path, { method: args.method,
      headers: args.body == null ? {} : { 'content-type': 'application/json' },
      body: args.body ?? undefined, credentials: 'same-origin', redirect: 'error', signal: controller.signal });
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > args.maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
      }
    }
    return { ok: true, status: res.status, contentType, text };
  } catch {
    return { ok: false, code: controller.signal.reason === 'total' ? 'TIMEOUT' : 'ABORTED' };
  } finally { clearTimeout(timer); }
}`;

const sha256hex = value => createHash('sha256').update(value, 'utf8').digest('hex');
const iso = () => new Date().toISOString();
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new BridgeError('ABORTED', 'Operation aborted')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});

function checkAbort(signal) {
  if (signal.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
}

function metadataUrl(raw, frameId, orgId) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password
      || url.pathname.toLowerCase() !== `/api/frame/${frameId.toLowerCase()}`) return false;
    return url.searchParams.get('org')?.toLowerCase() === orgId.toLowerCase();
  } catch { return false; }
}

function urlPath(raw) {
  try {
    const url = new URL(raw);
    return url.origin === ORIGIN && !url.username && !url.password ? url.pathname : null;
  } catch { return null; }
}

export async function runDesignMutation(context, { connect, completionTimeoutMs } = {}) {
  const prompt = MUTATION_PROMPT;
  let client;
  let targetId;
  let sessionId;
  let frameId;
  let creationUncertain = false;
  let conversationCreated = false;
  let messageSent = false;
  let unsubscribe;
  let expectedMetadata = null;
  let expectedCompletion = null;
  let currentPath = '/new';
  let scopeLost = false;
  let navigatingTo = null;
  const match = { requestId: null, loaderId: null, urlHash: null, received: 0, responseOk: false, finished: false, valid: true };
  const signal = AbortSignal.any(context.signal ? [context.signal, AbortSignal.timeout(900_000)] : [AbortSignal.timeout(900_000)]);
  const send = (method, params = {}, session = sessionId, timeoutMsOverride) => {
    checkAbort(signal);
    return client.send(method, params, { ...(session ? { sessionId: session } : {}), signal, timeoutMs: timeoutMsOverride ?? 10_000 });
  };
  const invalidate = () => {
    scopeLost = true;
    match.valid = false;
    match.finished = false;
    if (expectedCompletion) expectedCompletion.valid = false;
  };
  const observer = event => {
    try {
      const params = event.params ?? {};
      if (event.method === 'Target.detachedFromTarget' && params.sessionId === sessionId) return invalidate();
      if (event.sessionId !== sessionId) return;
      if (event.method === 'Page.navigatedWithinDocument' && params.frameId === frameId
        && params.url !== `${ORIGIN}${currentPath}`) return invalidate();
      if (event.method === 'Page.frameNavigated' && params.frame?.id === frameId) {
        if (!navigatingTo || params.frame.url !== `${ORIGIN}${navigatingTo}`) return invalidate();
        navigatingTo = null;
      }
      if (event.method === 'Page.frameDetached' && params.frameId === frameId) return invalidate();
      if (event.method === 'Page.javascriptDialogOpening') return invalidate();
      if (expectedMetadata && event.method === 'Network.requestWillBeSent' && params.frameId === frameId
        && params.request?.method === 'GET' && metadataUrl(params.request.url, expectedMetadata.frameId, expectedMetadata.orgId)) {
        if (match.requestId || params.redirectResponse !== undefined || typeof params.requestId !== 'string'
          || !params.requestId || params.requestId.length > 128 || typeof params.loaderId !== 'string' || !params.loaderId) {
          return invalidate();
        }
        match.requestId = params.requestId;
        match.loaderId = params.loaderId;
        match.urlHash = sha256hex(params.request.url);
        return;
      }
      if (expectedMetadata && match.requestId && event.method === 'Network.requestWillBeSent'
        && params.requestId === match.requestId) return invalidate();
      if (expectedCompletion && event.method === 'Network.requestWillBeSent'
        && params.frameId === frameId && params.request?.method === 'POST'
        && urlPath(params.request.url) === completionPath(expectedCompletion.orgId, expectedCompletion.conversationId)) {
        if (expectedCompletion.requestId || params.redirectResponse !== undefined || typeof params.requestId !== 'string'
          || !params.requestId || params.requestId.length > 128) {
          expectedCompletion.valid = false;
        } else {
          expectedCompletion.requestId = params.requestId;
        }
        return;
      }
      if (expectedCompletion && !expectedCompletion.requestId) {
        return;
      }
      if (expectedCompletion && params.requestId === expectedCompletion.requestId) {
        if (event.method === 'Network.responseReceived') {
          const response = params.response ?? {};
          if (expectedCompletion.responseOk || params.frameId !== frameId || response.status !== 200
            || String(response.mimeType ?? '').split(';')[0].trim().toLowerCase() !== 'text/event-stream'
            || response.fromDiskCache === true || response.fromPrefetchCache === true || response.fromServiceWorker === true
            || urlPath(response.url) !== completionPath(expectedCompletion.orgId, expectedCompletion.conversationId)) {
            expectedCompletion.valid = false;
          } else expectedCompletion.responseOk = true;
        }
        if (event.method === 'Network.loadingFinished') {
          if (expectedCompletion.responseOk && expectedCompletion.valid) expectedCompletion.finished = true;
          else expectedCompletion.valid = false;
        }
        if (event.method === 'Network.loadingFailed' || event.method === 'Network.requestServedFromCache') {
          expectedCompletion.valid = false;
        }
        return;
      }
      if (!expectedMetadata || !match.valid) return;
      if (!match.requestId) return;
      if (params.requestId !== match.requestId) return;
      if (event.method === 'Network.requestServedFromCache' || event.method === 'Network.loadingFailed') return invalidate();
      if (event.method === 'Network.responseReceived') {
        const response = params.response ?? {};
        match.responseOk = !match.responseOk && params.frameId === frameId && params.loaderId === match.loaderId && response.status === 200
          && String(response.mimeType ?? '').split(';')[0].trim().toLowerCase() === 'application/json'
          && response.fromDiskCache !== true && response.fromPrefetchCache !== true && response.fromServiceWorker !== true
          && metadataUrl(response.url, expectedMetadata.frameId, expectedMetadata.orgId) === true
          && sha256hex(response.url) === match.urlHash;
        if (!match.responseOk) invalidate();
      } else if (event.method === 'Network.dataReceived') {
        match.received += Number.isSafeInteger(params.dataLength) ? params.dataLength : Number.MAX_SAFE_INTEGER;
        if (!match.responseOk || match.received < 1 || match.received > MAX_METADATA_BYTES) invalidate();
      } else if (event.method === 'Network.loadingFinished') {
        if (match.responseOk && match.received >= 1) match.finished = true; else invalidate();
      }
    } catch { invalidate(); }
  };
  const assertScope = async (expected, checkFocus = true) => {
    if (scopeLost) throw new BridgeError('UI_CONTEXT_LOST', 'The owned page is no longer safely controlled');
    const info = await send('Target.getTargetInfo', { targetId }, null);
    if (info.targetInfo?.targetId !== targetId || info.targetInfo.url !== `${ORIGIN}${expected}`) {
      invalidate();
      throw new BridgeError('UI_CONTEXT_LOST', 'The owned page is no longer safely controlled');
    }
    const world = await send('Page.createIsolatedWorld', { frameId, worldName: 'ccw-mutation-scope' });
    const checked = await send('Runtime.callFunctionOn', { functionDeclaration: SCOPE_CHECK,
      executionContextId: world.executionContextId, arguments: [{ value: expected }, { value: checkFocus }], returnByValue: true });
    if (checked.exceptionDetails || checked.result?.value !== true || scopeLost) {
      invalidate();
      throw new BridgeError('UI_CONTEXT_LOST', 'The owned page is no longer safely controlled');
    }
  };
  try {
    if (typeof connect !== 'function') {
      connect = async () => {
        const [{ CdpClient }] = [await import('../src/core/cdp.mjs')];
        return CdpClient.connect(loadConfig().cdpUrl, { signal, timeoutMs: 5_000 });
      };
    }
    const config = loadConfig();
    client = await context.perform(READ, () => connect(signal));
    const tab = {
      client, sessionId: null, config, expectedPath: '/new', frameId: null, retainTarget: false,
      evaluate: async (expression, { timeoutMs = 10_000 } = {}) => {
        const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
        if (res.exceptionDetails) throw new BridgeError('PAGE_EVAL_FAILED', 'Page evaluation failed');
        return res.result?.value;
      },
      waitReady: async path => {
        const end = Date.now() + config.readyTimeoutMs;
        for (;;) {
          checkAbort(signal);
          const state = JSON.parse((await tab.evaluate(READY_SNAPSHOT, { timeoutMs: 5_000 })) ?? '{}');
          if (state.o === ORIGIN && state.p === path && ['complete', 'interactive'].includes(state.r)) return;
          if (Date.now() >= end) throw new BridgeError('READY_TIMEOUT', 'The probe page did not become ready');
          await delay(Math.min(250, Math.max(1, end - Date.now())), signal);
        }
      },
      navigateConversation: async conversationId => {
        await assertScope('/new');
        await inspectBlankComposer(tab, { signal });
        tab.expectedPath = `/chat/${conversationId}`;
        await assertScope('/new');
        navigatingTo = tab.expectedPath;
        const result = await send('Page.navigate', { url: `${ORIGIN}${tab.expectedPath}` }, sessionId, NAVIGATE_TIMEOUT_MS);
        if (result.errorText || result.frameId !== frameId) {
          throw new BridgeError('UI_CONTEXT_LOST', 'Could not navigate the owned page');
        }
        tab.frameId = result.frameId;
        currentPath = tab.expectedPath;
        await tab.waitReady(tab.expectedPath);
      },
    };
    await context.perform(READ, async () => {
      creationUncertain = true;
      const created = await send('Target.createTarget', { url: `${ORIGIN}/new`, background: true }, null, 5_000);
      if (!TARGET_ID.test(created?.targetId ?? '')) throw Error('Unidentified target');
      targetId = created.targetId;
      creationUncertain = false;
      const attached = await send('Target.attachToTarget', { targetId, flatten: true }, null);
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw Error('Unidentified session');
      sessionId = attached.sessionId;
      tab.sessionId = sessionId;
      unsubscribe = client.subscribe(observer);
      await send('Page.enable');
      await send('Network.enable');
      const tree = await send('Page.getFrameTree');
      frameId = tree.frameTree?.frame?.id;
      tab.frameId = frameId;
      if (typeof frameId !== 'string' || !frameId) throw Error('Missing frame');
      await tab.waitReady('/new');
      await assertScope('/new');
    });
    const navigate = async path => {
      await assertScope(currentPath, false);
      navigatingTo = path;
      const result = await send('Page.navigate', { url: `${ORIGIN}${path}` }, sessionId, NAVIGATE_TIMEOUT_MS);
      if (result.errorText || result.frameId !== frameId) throw Error('Navigation failed');
      currentPath = path;
      await tab.waitReady(path);
    };
    const api = new ClaudeApi({
      request: async ({ path, method = 'GET', body }) => {
        const route = API_ROUTES.find(item => item.pattern.test(path) && item.method === method);
        if (!route) throw new BridgeError('INVALID_ARGUMENT', 'Unexpected probe API route');
        return context.perform(route.cost, async () => {
          await assertScope(currentPath, !expectedCompletion);
          const argsJson = JSON.stringify({ path, method, body: body == null ? null : JSON.stringify(body),
            maxBytes: MAX_JSON_BYTES, totalMs: config.timeoutMs });
          const payload = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true,
            expression: `(${PAGE_FETCH})(${argsJson})` }, sessionId, config.timeoutMs + 5_000);
          if (payload.exceptionDetails || !payload.result?.value || payload.result.value.ok !== true) {
            throw new BridgeError('REMOTE_ERROR', 'The page request failed',
              { code: payload.result?.value?.code ?? null, status: payload.result?.value?.status ?? null });
          }
          const response = payload.result.value;
          if (response.status !== 200 && response.status !== 201) {
            throw new BridgeError('REMOTE_ERROR', 'Claude API returned an error', { status: response.status });
          }
          if (response.contentType !== 'application/json') throw new BridgeError('API_CONTRACT', 'Endpoint did not return JSON');
          await assertScope(currentPath, !expectedCompletion);
          return JSON.parse(response.text);
        });
      },
    }, config);
    const store = new SessionStore(join(context.root, 'mutation-state'));
    const state = await store.load();
    if (state.sessions.some(entry => entry.session === 'design-g1-probe')) throw Error('Existing probe state');
    const orgId = await api.discoverOrganization({ signal });
    if (!UUID.test(orgId ?? '')) throw Error('Unverified organization');
    const conversationId = randomUUID();
    const entry = { session: 'design-g1-probe', orgId, conversationId, parentMessageId: ROOT, model: null,
      createdAt: iso(), updatedAt: iso(), pending: { kind: 'create', startedAt: iso() } };
    state.sessions.push(entry);
    await store.save(state);
    await api.createConversation(orgId, conversationId, '[ccw] design-g1-probe', { signal });
    conversationCreated = true;
    entry.pending = { kind: 'send', parentMessageId: ROOT, promptSha256: sha256hex(prompt), startedAt: iso() };
    entry.updatedAt = iso();
    await store.save(state);
    if (entry.pending.promptSha256 !== sha256hex(MUTATION_PROMPT)) throw Error('Prompt binding mismatch');
    const composer = new NativeComposer(tab, orgId, conversationId, { signal });
    try {
      await context.perform(READ, async () => {
        await composer.open();
        await assertScope(`/chat/${conversationId}`);
      });
      await context.perform(MESSAGE, async () => {
        await assertScope(`/chat/${conversationId}`);
        await composer.compose(MUTATION_PROMPT, []);
        await composer.assertScope();
        await assertScope(`/chat/${conversationId}`, false);
        expectedCompletion = { orgId, conversationId, requestId: null, responseOk: false, finished: false, valid: true };
        await composer.submit();
        const end = Date.now() + (completionTimeoutMs ?? config.timeoutMs);
        for (;;) {
          checkAbort(signal);
          if (!expectedCompletion.valid) throw new BridgeError('REMOTE_ERROR', 'The native completion stream failed');
          if (expectedCompletion.finished) break;
          if (Date.now() >= end) throw new BridgeError('REMOTE_ERROR', 'The native completion did not finish in time');
          await delay(250, signal);
        }
        await assertScope(`/chat/${conversationId}`, false);
        if (!expectedCompletion.valid) throw new BridgeError('REMOTE_ERROR', 'The native completion stream failed');
      });
      messageSent = true;
    } finally {
      if (scopeLost) tab.retainTarget = true;
      try { await composer.dispose(); } catch { tab.retainTarget = true; }
    }
    const conversation = await api.conversation(orgId, conversationId, { signal });
    const confirmed = confirmMutationTurn(conversation, { parentMessageId: ROOT, prompt });
    if (confirmed.status !== 'confirmed') throw new BridgeError('TURN_UNVERIFIED', 'The server history does not confirm this turn');
    const parsed = mutationTurn(conversation, { parentMessageId: ROOT, prompt });
    const assistant = (conversation.chat_messages ?? []).find(message => message.uuid === confirmed.assistantMessageId);
    const hasToolUse = (assistant?.content ?? []).some(block => block?.type === 'tool_use');
    let outcome = parsed.status === 'publication-candidate' ? null : (hasToolUse || !confirmed.complete ? 'unverified_turn' : 'no_artifact');
    let artifact = null;
    let publications = [];
    if (parsed.status === 'publication-candidate') {
      publications = parsed.publications;
      outcome = publications.length === 1 ? 'publication_unclassified' : 'ambiguous_publications';
    }
    if (publications.length === 1) {
      const publication = publications[0];
      expectedMetadata = { frameId: publication.frameId, orgId };
      try {
        await context.perform(READ, () => navigate(`/artifact/${publication.shortId}`));
        const metadataDeadline = Date.now() + METADATA_TIMEOUT_MS;
        for (;;) {
          checkAbort(signal);
          if (match.finished) break;
          if (!match.valid) throw Error('Metadata capture invalidated');
          if (Date.now() >= metadataDeadline) throw Error('Metadata capture timed out');
          await delay(100, signal);
        }
        artifact = await context.perform(READ, async () => {
          await assertScope(`/artifact/${publication.shortId}`, false);
          const body = await send('Network.getResponseBody', { requestId: match.requestId });
          if (typeof body?.body !== 'string') throw Error('Missing body');
          const bytes = Buffer.from(body.body, body.base64Encoded === true ? 'base64' : 'utf8');
          if (bytes.length < 1 || bytes.length > MAX_METADATA_BYTES) throw Error('Oversized metadata');
          await assertScope(`/artifact/${publication.shortId}`, false);
          const manifest = publicationManifest(bytes, publication);
          return { frameIdSha256: sha256hex(publication.frameId), shortIdSha256: sha256hex(publication.shortId),
            version: manifest.status === 'manifest-candidate' ? manifest.version : publication.version,
            sequence: manifest.status === 'manifest-candidate' ? manifest.sequence : publication.sequence,
            fileCount: manifest.status === 'manifest-candidate' ? manifest.files.length : publication.fileCount,
            metadataCaptured: true, manifestVerified: manifest.status === 'manifest-candidate',
            sourceClaimsMatch: null, sourceClaimsMatchedCount: manifest.status === 'manifest-candidate' ? manifest.sourceClaimsMatchedCount : null };
        });
      } catch {
        artifact = { frameIdSha256: sha256hex(publication.frameId), shortIdSha256: sha256hex(publication.shortId),
          version: publication.version, sequence: publication.sequence, fileCount: publication.fileCount,
          metadataCaptured: false, manifestVerified: false, sourceClaimsMatch: null, sourceClaimsMatchedCount: null };
      }
    }
    let stateSaved = false;
    await assertScope(currentPath, false);
    try {
      if (typeof conversation.model === 'string' && conversation.model !== '') entry.model = conversation.model;
      entry.parentMessageId = confirmed.assistantMessageId;
      entry.pending = null;
      entry.updatedAt = iso();
      await store.save(state);
      stateSaved = true;
    } catch {}
    return { kind: 'mutation-evidence', outcome, conversationCreated, messageSent,
      turnComplete: confirmed.complete,
      toolNames: parsed.status === 'publication-candidate' ? parsed.toolNames : [],
      artifact, revisionStarted: false, targetRetained: true, stateSaved };
  } catch (error) {
    if (error instanceof BridgeError) {
      error.details = { ...error.details, targetRetained: Boolean(targetId), creationUncertain };
      throw error;
    }
    throw new BridgeError(creationUncertain ? 'TARGET_CREATION_UNCERTAIN' : signal.aborted ? 'ABORTED' : 'PROBE_FAILED',
      'The mutation probe did not complete safely', { targetRetained: Boolean(targetId), creationUncertain,
        conversationCreated, messageSent });
  } finally {
    try { unsubscribe?.(); } catch {}
    try { client?.close(); } catch {}
  }
}
