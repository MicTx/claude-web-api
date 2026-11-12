import { loadConfig } from './config.mjs';
import { ClaudeBridge, webDoctorPayload } from './bridge.mjs';
import { ApiBridge } from './api-bridge.mjs';
import { ApiStore } from './api-store.mjs';
import { SessionStore, StateLock, ALIAS_RE } from './session-store.mjs';
import { withClaudeTab } from './core/tab.mjs';
import { ClaudeApi } from './core/claude-api.mjs';
import { BridgeError } from './core/errors.mjs';
import { rejectPdfAttachments } from './attachments.mjs';
import { applyGuidanceBlock } from './guidance.mjs';
import { createHash } from 'node:crypto';
import { scanHostModelCatalog, selectHostModel, checkRequestedModel } from './model-catalog.mjs';

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 200;

// Read-only web failures that prove the browser route is unusable before any
// remote effect. A cancelled, invalid or already-started send is never here.
export const WEB_FALLBACK_CODES = new Set([
  'CDP_UNREACHABLE', 'CDP_TIMEOUT', 'CDP_CLOSED', 'CDP_INVALID', 'READY_TIMEOUT',
  'UI_NOT_READY', 'ORIGIN_MISMATCH', 'TIMEOUT', 'AUTH_REQUIRED', 'ORG_NOT_FOUND', 'ORG_AMBIGUOUS',
  'BROWSER_NOT_FOUND',
]);

function checkAlias(session) {
  if (typeof session !== 'string' || !ALIAS_RE.test(session)) {
    throw new BridgeError('INVALID_ARGUMENT', 'session must be 1-64 chars of [A-Za-z0-9._-] starting with a letter or digit');
  }
}

function checkPrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new BridgeError('INVALID_ARGUMENT', 'prompt must be a non-empty string');
  }
  if (!prompt.isWellFormed()) {
    throw new BridgeError('INVALID_ARGUMENT', 'prompt must contain well-formed Unicode');
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new BridgeError('INVALID_ARGUMENT', 'prompt exceeds the 64KiB limit');
  }
}

function checkTitle(title) {
  if (title === undefined || title === null) return;
  if (typeof title !== 'string' || [...title].length > MAX_TITLE_CHARS) {
    throw new BridgeError('INVALID_ARGUMENT', 'title must be a string of at most 200 characters');
  }
}

function checkModel(model) {
  if (model !== undefined && model !== null) checkRequestedModel(model);
}

function checkGuidance(guidance) {
  if (guidance !== undefined && typeof guidance !== 'boolean') {
    throw new BridgeError('INVALID_ARGUMENT', 'guidance must be a boolean');
  }
}

// The appended prompt is what the backend actually sends: its digest is stored
// in pending state and later matched against the server branch or browser draft.
function guidedPrompt(prompt, guidance) {
  checkGuidance(guidance);
  checkPrompt(prompt);
  const guided = applyGuidanceBlock(prompt, guidance);
  checkPrompt(guided.prompt);
  return guided;
}

// Routes each operation to the backend that already owns the alias, and only
// chooses a backend for a *new* session, before anything is created or sent.
// `mode` is an explicit per-invocation choice from `ccw web` / `ccw api`: it
// overrides the configured backend, never probes, and never switches silently.
export class ConsultBridge {
  constructor(config = loadConfig(), {
    mode = null, web, api, webStore, apiStore, withTab = withClaudeTab, modelCatalog,
  } = {}) {
    if (mode !== null && mode !== 'web' && mode !== 'api') {
      throw new BridgeError('INVALID_ARGUMENT', 'mode must be web or api');
    }
    this.config = config;
    this.mode = mode;
    this.withTab = withTab;
    this.modelCatalog = modelCatalog ?? (() => scanHostModelCatalog({
      home: config.home,
      env: config.env,
      platform: config.platform,
    }));
    this.webStore = webStore ?? new SessionStore(config.stateDir);
    this.apiStore = apiStore ?? new ApiStore(config.stateDir);
    this.aliasLocks = new Map();
    // the browser seam is shared, so an injected tab adapter cannot be bypassed
    this.web = web ?? new ClaudeBridge(config, { store: this.webStore, withTab, modelCatalog: this.modelCatalog });
    this.api = api ?? new ApiBridge(config, { store: this.apiStore, modelCatalog: this.modelCatalog });
  }

  async #owner(session) {
    const state = await this.apiStore.load();
    const inApi = state.apiSessions.some((entry) => entry.session === session);
    const webState = await this.webStore.load();
    const inWeb = webState.sessions.some((entry) => entry.session === session);
    if (inApi && inWeb) {
      throw new BridgeError('SESSION_CONFLICT', `Session "${session}" exists in both backends; refuse to guess its history`, { session });
    }
    if (inApi) return 'api';
    if (inWeb) return 'web';
    return null;
  }

  #aliasLock(session) {
    const hash = createHash('sha256').update(session, 'utf8').digest('hex');
    if (!this.aliasLocks.has(hash)) {
      this.aliasLocks.set(hash, new StateLock(this.config.stateDir, {
        file: `alias-${hash}.lock`, recoveryFile: `alias-${hash}.recovery.lock`,
      }));
    }
    return this.aliasLocks.get(hash);
  }

  #backend() {
    return this.mode ?? this.config.backend;
  }

  // An explicit mode is a contract with the caller: naming the other backend's
  // session is a mistake to report, not a reason to route somewhere else.
  #checkMode(owner, session) {
    if (this.mode !== null && owner !== null && owner !== this.mode) {
      throw new BridgeError('MODE_MISMATCH',
        `Session "${session}" belongs to the ${owner} backend; the ${this.mode} command does not switch modes`,
        { session, backend: owner, requested: this.mode });
    }
  }

  #apiReady() {
    return this.#backend() !== 'web' && this.api.profile().configured;
  }

  // `describe` turns the same single browser check into the doctor payload, so a
  // routed health check never opens a second tab to answer the same question.
  async #probeWeb(signal, describe = false) {
    try {
      const result = await this.withTab(this.config, async (tab) => {
        const api = new ClaudeApi(tab, this.config);
        const orgId = await api.discoverOrganization({ signal });
        return describe ? await webDoctorPayload(this.config, tab, orgId, await this.modelCatalog()) : { ok: true };
      }, { signal });
      const cleanup = result?.browserCleanup ? { browserCleanup: result.browserCleanup } : null;
      if (!describe) return { ok: true, cleanup };
      const { browserCleanup, ...payload } = result ?? {};
      return { ok: true, result: { ...payload, ...cleanup }, cleanup };
    } catch (error) {
      if (signal?.aborted) throw error;
      const details = error?.details ?? {};
      const cleanup = {};
      if (details.cleanupPending === true) cleanup.cleanupPending = true;
      if (details.targetCreationUncertain === true) cleanup.targetCreationUncertain = true;
      if (details.browserCleanup) cleanup.browserCleanup = details.browserCleanup;
      return { ok: false, code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR', error,
        cleanup: Object.keys(cleanup).length ? cleanup : null };
    }
  }

  async #selectForNewSession({ signal, attachments, native }) {
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    const backend = this.#backend();
    if (backend === 'web') return { backend: 'web' };
    if (backend === 'api') {
      if (!this.api.profile().configured) {
        throw new BridgeError('API_NOT_CONFIGURED', 'Configure the API base URL and private credential before use');
      }
      return { backend: 'api' };
    }
    const probe = await this.#probeWeb(signal);
    if (probe.ok) return { backend: 'web', cleanup: probe.cleanup };
    if (!WEB_FALLBACK_CODES.has(probe.code)) throw probe.error;
    if (!this.api.profile().configured) throw probe.error;
    if (Array.isArray(attachments) && attachments.length > 0) {
      throw new BridgeError('API_UNSUPPORTED_INPUT', 'The web route is unavailable and the fallback API channel sends text only; no attachment was sent', {
        webError: probe.code, ...(probe.cleanup ? { webPreflightCleanup: probe.cleanup } : {}),
      });
    }
    if (native === true) {
      throw new BridgeError('API_UNSUPPORTED_INPUT', 'The web route is unavailable and the fallback API channel cannot request generated web files', {
        webError: probe.code, ...(probe.cleanup ? { webPreflightCleanup: probe.cleanup } : {}),
      });
    }
    return { backend: 'api', cleanup: probe.cleanup };
  }

  async ask({ session, prompt, title, attachments, native, model, guidance }, { signal } = {}) {
    checkAlias(session);
    const guided = guidedPrompt(prompt, guidance);
    checkTitle(title);
    checkModel(model);
    rejectPdfAttachments(attachments);
    return this.#aliasLock(session).withLock(async () => {
      const args = { session, prompt: guided.prompt, title, attachments, native, model };
      const owner = await this.#owner(session);
      if (owner) {
        this.#checkMode(owner, session);
        throw new BridgeError('SESSION_EXISTS', `Session "${session}" already exists`, { session, backend: owner });
      }
      const selection = await this.#selectForNewSession({ signal, attachments, native });
      try {
        const result = selection.backend === 'api'
          ? await this.api.ask(args, { signal }) : this.#webResult(await this.web.ask(args, { signal }));
        const withCleanup = selection.cleanup ? { ...result, webPreflightCleanup: selection.cleanup } : result;
        return { ...withCleanup, guidanceAppended: guided.appended };
      } catch (error) {
        if (selection.cleanup && error instanceof BridgeError) error.details = { ...error.details, webPreflightCleanup: selection.cleanup };
        throw error;
      }
    }, { signal });
  }

  // Every routed result names the backend that actually performed the work.
  #webResult(result) {
    return result && typeof result === 'object' ? { ...result, backend: 'web' } : result;
  }

  async followUp({ session, prompt, attachments, native, guidance }, { signal } = {}) {
    checkAlias(session);
    const guided = guidedPrompt(prompt, guidance);
    return this.#aliasLock(session).withLock(async () => {
      const owner = await this.#owner(session);
      if (!owner) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      this.#checkMode(owner, session);
      const args = { session, prompt: guided.prompt, attachments, native };
      const result = owner === 'api' ? await this.api.followUp(args, { signal }) : this.#webResult(await this.web.followUp(args, { signal }));
      return { ...result, guidanceAppended: guided.appended };
    }, { signal });
  }

  async bindApiCredential(args, { signal } = {}) {
    checkAlias(args.session);
    return this.#aliasLock(args.session).withLock(async () => {
      const owner = await this.#owner(args.session);
      this.#checkMode(owner, args.session);
      if (owner !== 'api') throw new BridgeError(owner ? 'API_UNSUPPORTED_INPUT' : 'SESSION_NOT_FOUND', 'Credential binding requires an existing API session');
      return this.api.bindCredential(args, { signal });
    }, { signal });
  }

  // Operator-only recovery of an uncertain native upload; never reachable from a plain send.
  async resumeNativeUpload({ session, prompt, guidance }, { signal } = {}) {
    checkAlias(session);
    const guided = guidedPrompt(prompt, guidance);
    const owner = await this.#owner(session);
    this.#checkMode(owner, session);
    if (owner !== 'web') {
      throw new BridgeError(owner === 'api' ? 'API_UNSUPPORTED_INPUT' : 'SESSION_NOT_FOUND',
        owner === 'api' ? 'The fallback API channel has no native draft to resume' : `Session "${session}" does not exist`, { session });
    }
    return this.#aliasLock(session).withLock(async () => {
      const result = await this.web.resumeNativeUpload({ session, prompt: guided.prompt }, { signal });
      return { ...result, guidanceAppended: guided.appended };
    }, { signal });
  }

  async transcript({ session, recover = false, discardPending = false }, { signal } = {}) {
    checkAlias(session);
    const owner = await this.#owner(session);
    if (!owner) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
    this.#checkMode(owner, session);
    return this.#aliasLock(session).withLock(async () => owner === 'api'
      ? this.api.transcript({ session, recover, discardPending }, { signal })
      : this.#webResult(await this.web.transcript({ session, recover, discardPending }, { signal })), { signal });
  }

  async download({ session, artifact, destination }, { signal } = {}) {
    checkAlias(session);
    const owner = await this.#owner(session);
    if (!owner) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
    this.#checkMode(owner, session);
    if (owner === 'api') {
      throw new BridgeError('API_UNSUPPORTED_INPUT', 'The fallback API channel has no artifacts to download; nothing was written', { session });
    }
    return this.web.download({ session, artifact, destination }, { signal });
  }

  async sessions() {
    const webState = await this.webStore.load();
    const web = webState.sessions.map((entry) => ({
      backend: 'web',
      session: entry.session,
      orgId: entry.orgId,
      conversationId: entry.conversationId,
      parentMessageId: entry.parentMessageId,
      model: entry.model,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      pending: entry.pending === null ? null : {
        kind: entry.pending.kind,
        parentMessageId: entry.pending.parentMessageId ?? null,
        startedAt: entry.pending.startedAt,
      },
    }));
    const api = (await this.api.sessions()).sessions;
    return { ok: true, sessions: [...web, ...api] };
  }

  async doctor({}, { signal } = {}) {
    const profile = this.api.profile();
    if (this.#backend() === 'api' && !profile.configured) {
      throw new BridgeError('API_NOT_CONFIGURED', 'Configure the API base URL and private credential before use');
    }
    if (this.#backend() === 'web') {
      const result = await this.web.doctor({}, { signal });
      return { ...result, backend: 'web' };
    }
    const credential = this.config.apiCredentialConfigured ? await this.api.credentialStatus() : { readable: false, code: 'API_NOT_CONFIGURED' };
    const catalog = await this.modelCatalog();
    let dynamicModel = null;
    let dynamicModelError = null;
    if (!profile.model) {
      try {
        dynamicModel = selectHostModel({ configuredModel: null, catalog }).id;
      } catch (error) {
        if (error?.code !== 'MODEL_UNAVAILABLE') throw error;
        dynamicModelError = error.code;
      }
    }
    const apiProfile = {
      ...profile,
      model: profile.model ?? dynamicModel,
      modelSelection: profile.model ? 'configured' : 'dynamic-latest-opus',
      catalog,
      credential,
      ...(dynamicModelError ? { dynamicModelError } : {}),
    };
    if (this.#backend() === 'api') {
      // No request is sent; the credential file is only checked locally.
      return { ok: true, backend: 'api', protocol: profile.protocol, api: apiProfile };
    }
    const probe = await this.#probeWeb(signal, true);
    if (probe.ok) return { ...probe.result, backend: 'web' };
    if (profile.configured && WEB_FALLBACK_CODES.has(probe.code)) {
      return { ok: true, backend: 'api', protocol: profile.protocol, fallback: true, webError: probe.code, api: apiProfile,
        ...(probe.cleanup ? { webPreflightCleanup: probe.cleanup } : {}) };
    }
    throw probe.error;
  }

  async unlock({ session } = {}) {
    if (session !== undefined) {
      checkAlias(session);
      return { ok: true, unlocked: await this.#aliasLock(session).unlockDeadOwner(), session };
    }
    const web = await this.web.unlock();
    if (this.#backend() === 'web') return web;
    const api = await this.apiStore.unlockDeadOwner();
    return { ok: true, unlocked: Boolean(web.unlocked) || api };
  }
}
