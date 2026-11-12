import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError } from '../src/core/errors.mjs';
import { activeBranch } from '../src/core/claude-api.mjs';
import { MUTATION_PROMPT } from './design-probe-mutations.mjs';
import { confirmMutationTurn, inspectMutationTurn, validPublicationDiagnostic } from './design-probe-turns.mjs';
import { parseStrictJson } from './design-probe-json.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const TARGET = /^[a-f0-9]{32}$/i;
const ROOT = '00000000-0000-4000-8000-000000000000';
const ORIGIN = 'https://claude.ai';
const READ = Object.freeze({ reads: 1, sessions: 0, messages: 0, downloads: 0, uploads: 0, shares: 0 });
const MAX_STATE = 128 * 1024;
const MAX_HISTORY = 4 * 1024 * 1024;
const MAX_MESSAGES = 2048;
const TERMINAL = new Set(['end_turn', 'stop_sequence', 'refusal', 'max_tokens', 'model_context_window_exceeded']);
const TOOL_NAMES = new Set(['Write', 'Read', 'mcp__claude-artifacts__publish_files']);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function invalid() {
  throw new BridgeError('PENDING_BINDING_INVALID', 'The approved pending state is unavailable or changed');
}

export async function readReconciliationBinding(root, binding) {
  let handle;
  try {
    if (!exact(binding, ['organizationId', 'conversationId', 'parentMessageId', 'promptSha256', 'stateSha256'])
      || !UUID.test(binding.organizationId ?? '') || !UUID.test(binding.conversationId ?? '')
      || binding.parentMessageId !== ROOT || !HASH.test(binding.promptSha256 ?? '') || !HASH.test(binding.stateSha256 ?? '')
      || binding.promptSha256 !== hash(MUTATION_PROMPT)) invalid();
    const directory = join(root, 'mutation-state');
    const path = join(directory, 'sessions.json');
    const directoryBefore = await fs.lstat(directory, { bigint: true });
    if (await fs.realpath(directory) !== directory || !directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
      || directoryBefore.uid !== BigInt(process.getuid()) || (directoryBefore.mode & 0o777n) !== 0o700n
      || JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(['sessions.json'])) invalid();
    const named = await fs.lstat(path, { bigint: true });
    if (named.isSymbolicLink() || !named.isFile() || named.nlink !== 1n || named.uid !== BigInt(process.getuid())
      || (named.mode & 0o777n) !== 0o600n || named.size > BigInt(MAX_STATE)) invalid();
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!same(named, before) || !before.isFile() || before.nlink !== 1n) invalid();
    const bytes = Buffer.alloc(MAX_STATE + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, null);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fs.lstat(path, { bigint: true });
    const directoryAfter = await fs.lstat(directory, { bigint: true });
    if (size > MAX_STATE || BigInt(size) !== before.size || !same(before, after) || !same(before, namedAfter)
      || !same(directoryBefore, directoryAfter) || directoryAfter.mtimeNs !== directoryBefore.mtimeNs
      || directoryAfter.ctimeNs !== directoryBefore.ctimeNs || JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(['sessions.json'])
      || ![after, namedAfter].every(stat => stat.size === before.size
        && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.nlink === 1n)
      || hash(bytes.subarray(0, size)) !== binding.stateSha256) invalid();
    const state = parseStrictJson(bytes.subarray(0, size), { rejectPrototypeKeys: true });
    if (!exact(state, ['version', 'lastSubmissionAt', 'sessions']) || state.version !== 1
      || !Number.isFinite(state.lastSubmissionAt) || state.lastSubmissionAt < 0
      || !Array.isArray(state.sessions) || state.sessions.length !== 1) invalid();
    const entry = state.sessions[0];
    if (!exact(entry, ['session', 'orgId', 'conversationId', 'parentMessageId', 'model', 'createdAt', 'updatedAt', 'pending'])
      || entry.session !== 'design-g1-probe' || entry.orgId !== binding.organizationId
      || entry.conversationId !== binding.conversationId || entry.parentMessageId !== binding.parentMessageId
      || entry.model !== null || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))
      || !exact(entry.pending, ['kind', 'parentMessageId', 'promptSha256', 'startedAt']) || entry.pending.kind !== 'send'
      || !Number.isFinite(Date.parse(entry.pending.startedAt)) || entry.pending.parentMessageId !== binding.parentMessageId
      || entry.pending.promptSha256 !== binding.promptSha256) invalid();
    return Object.freeze({ ...binding });
  } catch {
    invalid();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function emptyEvidence(binding, status, reason = null) {
  return { kind: 'reconciliation-evidence', status, reason, stopReason: null, associated: false,
    humanCount: 0, assistantCount: 0, publicationCandidates: null, toolNames: [],
    organizationSha256: hash(binding.organizationId), conversationSha256: hash(binding.conversationId),
    humanSha256: null, assistantSha256: null, revisionStarted: false, targetRetained: true };
}

export function publicationDiagnosticForEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'reconciliation-evidence') {
    throw new BridgeError('PROBE_FAILED', 'Invalid reconciliation evidence');
  }
  if (!Object.hasOwn(value, 'publicationDiagnostic')) return { reasonCodes: ['reason_unrecorded'], unknownToolPresent: null };
  if (!validPublicationDiagnostic(value.publicationDiagnostic)) throw new BridgeError('PROBE_FAILED', 'Invalid publication diagnostic');
  return { reasonCodes: [...value.publicationDiagnostic.reasonCodes], unknownToolPresent: value.publicationDiagnostic.unknownToolPresent };
}

export function projectReconciliation(conversation, binding) {
  const result = { ...emptyEvidence(binding, 'unknown', 'invalid_history'),
    publicationDiagnostic: { reasonCodes: ['turn_unverified'], unknownToolPresent: false } };
  try {
    if (conversation?.uuid !== binding.conversationId || !Array.isArray(conversation.chat_messages)
      || conversation.chat_messages.length > MAX_MESSAGES) return result;
    const branch = activeBranch(conversation);
    const children = conversation.chat_messages.filter(message => message.parent_message_uuid === binding.parentMessageId);
    result.humanCount = children.filter(message => message.sender === 'human').length;
    if (children.length === 0) return { ...result, status: 'human_absent', reason: null };
    if (children.length !== 1 || children[0].sender !== 'human') return { ...result, status: 'ambiguous', reason: null };
    const human = children[0];
    result.humanSha256 = hash(human.uuid);
    const normalize = value => value.replace(/\r\n?/g, '\n').trim();
    if (!human.content.every(block => block?.type === 'text' && typeof block.text === 'string')
      || normalize(human.content.map(block => block.text).join('')) !== normalize(MUTATION_PROMPT)
      || !Array.isArray(human.attachments) || human.attachments.length || !Array.isArray(human.files) || human.files.length) {
      return { ...result, status: 'ambiguous', reason: null };
    }
    const replies = conversation.chat_messages.filter(message => message.parent_message_uuid === human.uuid);
    result.assistantCount = replies.filter(message => message.sender === 'assistant').length;
    if (!replies.length && branch.at(-1)?.uuid === human.uuid) return { ...result, status: 'in_progress_or_nonterminal', reason: null };
    if (replies.length !== 1 || replies[0].sender !== 'assistant' || branch.at(-1)?.uuid !== replies[0].uuid) {
      return { ...result, status: 'ambiguous', reason: null };
    }
    const assistant = replies[0];
    result.assistantSha256 = hash(assistant.uuid);
    result.stopReason = typeof assistant.stop_reason === 'string'
      ? (TERMINAL.has(assistant.stop_reason) || assistant.stop_reason === 'tool_use' ? assistant.stop_reason : 'other') : null;
    result.toolNames = [...new Set(assistant.content.filter(block => block?.type === 'tool_use')
      .map(block => TOOL_NAMES.has(block.name) ? block.name : 'other'))].sort();
    if (!assistant.content.length || assistant.stop_reason == null || assistant.stop_reason === 'tool_use') {
      return { ...result, status: 'in_progress_or_nonterminal', reason: null };
    }
    const confirmed = confirmMutationTurn(conversation, { parentMessageId: binding.parentMessageId, prompt: MUTATION_PROMPT });
    if (confirmed.status !== 'confirmed') return result;
    const inspected = inspectMutationTurn(conversation, { parentMessageId: binding.parentMessageId, prompt: MUTATION_PROMPT });
    const parsed = inspected.result;
    return { ...result, status: confirmed.complete ? 'confirmed_complete' : 'confirmed_truncated', reason: null,
      associated: true, publicationCandidates: parsed.status === 'publication-candidate' ? parsed.publications.length : null,
      publicationDiagnostic: inspected.diagnostic };
  } catch {
    return result;
  }
}

export function inspectReconciliationScope(path) {
  return { sameUrl: location.href === (path === 'about:blank' ? path : 'https://claude.ai' + path),
    hidden: document.visibilityState === 'hidden', focused: document.hasFocus(),
    ready: path === 'about:blank' ? document.readyState === 'complete' : ['interactive', 'complete'].includes(document.readyState),
    empty: path !== 'about:blank' || (!!document.body && document.body.childNodes.length === 0
      && !!document.head && document.head.childNodes.length === 0) };
}

const SCOPE_STAGES = new Set(['create_target', 'blank_scope', 'navigation', 'page_scope', 'history_get', 'history_response']);
const SCOPE_REASONS = new Set(['target_missing', 'target_url_changed', 'main_frame_changed', 'cross_document_navigation',
  'same_document_url_changed', 'loader_changed', 'page_visible', 'page_focused', 'frame_detached', 'context_invalid',
  'navigation_timeout', 'navigation_failed', 'page_not_ready', 'blank_not_empty', 'dialog_opened', 'request_invalid']);

export function validReconciliationDiagnostic(value) {
  return exact(value, ['stage', 'reason', 'requestAttempted']) && SCOPE_STAGES.has(value.stage)
    && SCOPE_REASONS.has(value.reason) && typeof value.requestAttempted === 'boolean';
}

const FETCH_HISTORY = `async function(path, limit, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetch(path, { method: 'GET', headers: {}, credentials: 'same-origin', redirect: 'error',
      cache: 'no-store', signal: controller.signal });
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch {}
      return { status: response.status, text: null, reason: 'http' };
    }
    if (String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      try { await response.body?.cancel(); } catch {}
      return { status: response.status, text: null, reason: 'content_type' };
    }
    if (!response.body || Number(response.headers.get('content-length')) > limit) {
      try { await response.body?.cancel(); } catch {}
      return { status: response.status, text: null, reason: 'too_large' };
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    let text = '';
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) { await reader.cancel(); return { status: response.status, text: null, reason: 'too_large' }; }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return { status: response.status, text, reason: null };
  } catch {
    return { status: null, text: null, reason: 'request_failed' };
  } finally {
    clearTimeout(timer);
    try { await reader?.cancel(); } catch {}
  }
}`;

export async function runDesignReconciliation(context, { connect, navigationTimeoutMs = 10_000 } = {}) {
  const binding = context.reconciliationTarget;
  let client;
  let targetId;
  let sessionId;
  let frameId;
  let unsubscribe;
  let invalidScope = null;
  let navigating = false;
  let navigationStarted = false;
  let initialLoader = null;
  let expectedLoader = null;
  let observedLoader = null;
  let readyLoader = null;
  let stage = 'create_target';
  let requestAttempted = false;
  let requestCount = 0;
  let requestId = null;
  let responseStatus = null;
  let responseFinished = false;
  let permittedRequest = false;
  let creationUncertain = false;
  const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
  const historyPath = `/api/organizations/${binding.organizationId}/chat_conversations/${binding.conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`;
  const send = (method, params = {}, session = sessionId, timeoutMs = 10_000) => {
    if (signal.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    return client.send(method, params, { ...(session ? { sessionId: session } : {}), signal, timeoutMs });
  };
  const invalidate = reason => { invalidScope ??= reason; };
  const scopeFailure = reason => new BridgeError('UI_CONTEXT_LOST', 'The owned page is no longer safely controlled',
    { targetRetained: Boolean(targetId), diagnostic: { stage, reason, requestAttempted } });
  const assertScope = async path => {
    if (invalidScope) throw scopeFailure(invalidScope);
    let info;
    try { info = await send('Target.getTargetInfo', { targetId }, null); }
    catch { throw scopeFailure('target_missing'); }
    const expected = path === 'about:blank' ? path : `${ORIGIN}${path}`;
    if (info.targetInfo?.targetId !== targetId) throw scopeFailure('target_missing');
    if (info.targetInfo.url !== expected) throw scopeFailure('target_url_changed');
    let world;
    let checked;
    try {
      world = await send('Page.createIsolatedWorld', { frameId, worldName: 'ccw-reconciliation-scope' });
      if (!Number.isSafeInteger(world.executionContextId)) throw Error('Missing context');
      checked = await send('Runtime.callFunctionOn', { functionDeclaration: inspectReconciliationScope.toString(),
        executionContextId: world.executionContextId, arguments: [{ value: path }], returnByValue: true });
    } catch { throw scopeFailure('context_invalid'); }
    if (invalidScope) throw scopeFailure(invalidScope);
    const value = checked.result?.value;
    if (checked.exceptionDetails || !exact(value, ['sameUrl', 'hidden', 'focused', 'ready', 'empty'])
      || !Object.values(value).every(item => typeof item === 'boolean')) throw scopeFailure('context_invalid');
    if (!value.sameUrl) throw scopeFailure('target_url_changed');
    if (!value.hidden) throw scopeFailure('page_visible');
    if (value.focused) throw scopeFailure('page_focused');
    if (!value.ready) throw scopeFailure('page_not_ready');
    if (!value.empty) throw scopeFailure('blank_not_empty');
    return world.executionContextId;
  };
  try {
    if (typeof connect !== 'function') {
      connect = async () => {
        const [{ CdpClient }, { loadConfig }] = await Promise.all([import('../src/core/cdp.mjs'), import('../src/config.mjs')]);
        return CdpClient.connect(loadConfig().cdpUrl, { signal, timeoutMs: 5_000 });
      };
    }
    client = await context.perform(READ, () => connect(signal));
    await context.perform(READ, async () => {
      creationUncertain = true;
      const created = await send('Target.createTarget', { url: 'about:blank', background: true }, null, 5_000);
      if (!TARGET.test(created?.targetId ?? '')) throw new BridgeError('TARGET_CREATION_UNCERTAIN', 'Target identity unavailable');
      targetId = created.targetId;
      creationUncertain = false;
      const attached = await send('Target.attachToTarget', { targetId, flatten: true }, null);
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw Error('Missing session');
      sessionId = attached.sessionId;
      unsubscribe = client.subscribe(event => {
        const params = event.params ?? {};
        if (event.method === 'Target.detachedFromTarget' && params.sessionId === sessionId) invalidate('target_missing');
        if (event.sessionId !== sessionId) return;
        if (event.method === 'Page.javascriptDialogOpening') invalidate('dialog_opened');
        if (event.method === 'Page.frameDetached' && params.frameId === frameId) invalidate('frame_detached');
        if (event.method === 'Runtime.executionContextsCleared' && requestAttempted) invalidate('context_invalid');
        if (event.method === 'Page.navigatedWithinDocument' && params.frameId === frameId
          && params.url !== (navigationStarted ? `${ORIGIN}/new` : 'about:blank')) invalidate('same_document_url_changed');
        if (event.method === 'Page.frameNavigated' && params.frame?.id === frameId) {
          const frame = params.frame;
          if (navigating && initialLoader && frame.url === 'about:blank' && frame.loaderId === initialLoader) return;
          if (!navigationStarted || frame.url !== `${ORIGIN}/new`) invalidate('cross_document_navigation');
          else if (typeof frame.loaderId !== 'string' || !frame.loaderId
            || expectedLoader && frame.loaderId !== expectedLoader || observedLoader && frame.loaderId !== observedLoader) invalidate('loader_changed');
          else observedLoader = frame.loaderId;
        }
        if (event.method === 'Page.lifecycleEvent' && params.frameId === frameId
          && ['DOMContentLoaded', 'load'].includes(params.name) && navigationStarted && params.loaderId !== initialLoader) {
          if (typeof params.loaderId !== 'string' || !params.loaderId || expectedLoader && params.loaderId !== expectedLoader
            || readyLoader && params.loaderId !== readyLoader) invalidate('loader_changed');
          else readyLoader = params.loaderId;
        }
        if (event.method === 'Network.requestWillBeSent') {
          let pathname;
          try { pathname = new URL(params.request?.url).pathname; } catch { return; }
          if (pathname !== historyPath.split('?')[0]) return;
          if (!permittedRequest || params.request?.method !== 'GET' || params.request.url !== `${ORIGIN}${historyPath}`
            || params.frameId !== frameId || params.redirectResponse !== undefined || ++requestCount !== 1
            || typeof params.requestId !== 'string' || !params.requestId) invalidate('request_invalid');
          else requestId = params.requestId;
        }
        if (requestId && params.requestId === requestId && event.method === 'Network.responseReceived') {
          const response = params.response ?? {};
          if (responseStatus !== null || params.frameId !== frameId || response.url !== `${ORIGIN}${historyPath}`
            || response.fromDiskCache || response.fromPrefetchCache || response.fromServiceWorker) invalidate('request_invalid');
          else responseStatus = response.status;
        }
        if (requestId && params.requestId === requestId && event.method === 'Network.loadingFinished') responseFinished = true;
        if (requestId && params.requestId === requestId && ['Network.loadingFailed', 'Network.requestServedFromCache'].includes(event.method)) invalidate('request_invalid');
      });
      await send('Page.enable');
      await send('Page.setLifecycleEventsEnabled', { enabled: true });
      await send('Network.enable');
      const tree = await send('Page.getFrameTree');
      frameId = tree.frameTree?.frame?.id;
      initialLoader = tree.frameTree?.frame?.loaderId;
      if (typeof frameId !== 'string' || !frameId || typeof initialLoader !== 'string' || !initialLoader) throw scopeFailure('main_frame_changed');
      stage = 'blank_scope';
      await assertScope('about:blank');
    });
    await context.perform(READ, async () => {
      stage = 'navigation';
      await assertScope('about:blank');
      navigating = true;
      navigationStarted = true;
      let result;
      try { result = await send('Page.navigate', { url: `${ORIGIN}/new` }, sessionId, 20_000); }
      catch (error) { throw scopeFailure(error?.code === 'CDP_TIMEOUT' ? 'navigation_timeout' : 'navigation_failed'); }
      if (result.errorText) throw scopeFailure('navigation_failed');
      if (result.frameId !== frameId) throw scopeFailure('main_frame_changed');
      if (typeof result.loaderId !== 'string' || !result.loaderId) throw scopeFailure('loader_changed');
      expectedLoader = result.loaderId;
      const deadline = Date.now() + navigationTimeoutMs;
      while ((!observedLoader || !readyLoader) && !invalidScope && Date.now() < deadline) {
        if (signal.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (invalidScope) throw scopeFailure(invalidScope);
      if (!observedLoader || !readyLoader) throw scopeFailure('navigation_timeout');
      if (observedLoader !== expectedLoader || readyLoader !== expectedLoader) throw scopeFailure('loader_changed');
      navigating = false;
      stage = 'page_scope';
      await assertScope('/new');
    });
    return await context.perform(READ, async () => {
      stage = 'history_get';
      const world = await assertScope('/new');
      permittedRequest = true;
      requestAttempted = true;
      const response = await send('Runtime.callFunctionOn', { functionDeclaration: FETCH_HISTORY, executionContextId: world,
        arguments: [{ value: historyPath }, { value: MAX_HISTORY }, { value: 30_000 }], awaitPromise: true, returnByValue: true }, sessionId, 35_000);
      if (response.exceptionDetails || invalidScope) throw scopeFailure(invalidScope ?? 'context_invalid');
      stage = 'history_response';
      const value = response.result?.value;
      await assertScope('/new');
      if (['http', 'too_large', 'content_type'].includes(value?.reason)) {
        if (invalidScope || requestCount !== 1 || responseStatus !== value.status) return emptyEvidence(binding, 'unknown', 'network_unverified');
        if (value.status === 404) return emptyEvidence(binding, 'conversation_not_found');
        return emptyEvidence(binding, 'unknown', ['too_large', 'content_type'].includes(value.reason) ? value.reason : 'http_or_request');
      }
      const deadline = Date.now() + 5_000;
      while ((!responseFinished || responseStatus === null) && !invalidScope && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      await assertScope('/new');
      if (invalidScope || requestCount !== 1 || !responseFinished || responseStatus !== response.result?.value?.status) {
        return emptyEvidence(binding, 'unknown', 'network_unverified');
      }
      if (value.status === 404) return emptyEvidence(binding, 'conversation_not_found');
      if (value.status !== 200 || value.reason !== null || typeof value.text !== 'string'
        || Buffer.byteLength(value.text) > MAX_HISTORY) {
        return emptyEvidence(binding, 'unknown', ['too_large', 'content_type'].includes(value.reason) ? value.reason : 'http_or_request');
      }
      let history;
      try { history = parseStrictJson(Buffer.from(value.text), { rejectPrototypeKeys: true }); }
      catch { return emptyEvidence(binding, 'unknown', 'invalid_history'); }
      return projectReconciliation(history, binding);
    });
  } catch (error) {
    if (creationUncertain) throw new BridgeError('TARGET_CREATION_UNCERTAIN', 'Target identity unavailable', { creationUncertain: true });
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(signal.aborted ? 'ABORTED' : 'PROBE_FAILED', 'The read-only reconciliation did not complete safely',
      { targetRetained: Boolean(targetId) });
  } finally {
    try { unsubscribe?.(); } catch {}
    try { client?.close(); } catch {}
  }
}
