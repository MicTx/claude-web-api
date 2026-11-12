import { randomUUID, createHash } from 'node:crypto';
import { BridgeError } from './core/errors.mjs';
import { ApiStore, MAX_API_MESSAGES, MAX_API_PROMPT_BYTES, MAX_API_SESSIONS, assertApiCapacity } from './api-store.mjs';
import { ALIAS_RE } from './session-store.mjs';
import { prepareApiRequest, sendApiMessage } from './api-client.mjs';
import {
  readApiKeyFile, createCredentialBinding, matchesCredentialBinding,
  apiProtocol, apiReasoningEffort, apiWireMaxTokens,
} from './api-config.mjs';
import { apiWireSettings } from './api-protocol.mjs';
import { scanHostModelCatalog, selectHostModel } from './model-catalog.mjs';
import { POST_RETRY_POLICY } from './transport-policy.mjs';

const MAX_TITLE_CHARS = 200;
const iso = () => new Date().toISOString();
const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

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
  if (Buffer.byteLength(prompt, 'utf8') > MAX_API_PROMPT_BYTES) {
    throw new BridgeError('INVALID_ARGUMENT', 'prompt exceeds the 64KiB limit');
  }
}

function checkTitle(title) {
  if (title === undefined || title === null) return;
  if (typeof title !== 'string' || [...title].length > MAX_TITLE_CHARS) {
    throw new BridgeError('INVALID_ARGUMENT', 'title must be a string of at most 200 characters');
  }
}

// The API channel is text-only; silently dropping files or a native request would lie about the send.
function checkTextOnly(attachments, native) {
  if (attachments !== undefined && attachments !== null
    && (!Array.isArray(attachments) ? true : attachments.length > 0)) {
    throw new BridgeError('API_UNSUPPORTED_INPUT', 'The fallback API channel sends text only; no attachment was sent');
  }
  if (native === true) {
    throw new BridgeError('API_UNSUPPORTED_INPUT', 'The fallback API channel cannot request generated web files');
  }
}

function findEntry(state, session) {
  return state.apiSessions.find((entry) => entry.session === session);
}

export class ApiBridge {
  constructor(config, { store = new ApiStore(config.stateDir), fetchImpl, modelCatalog } = {}) {
    this.config = config;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.modelCatalog = modelCatalog;
  }

  // Read-only view of the configured fallback profile. Never reads the credential.
  profile() {
    const configured = Boolean(this.config.apiBaseUrl
      && this.config.apiCredentialConfigured === true);
    return {
      configured,
      enabled: this.config.backend !== 'web',
      baseUrl: this.config.apiBaseUrl,
      model: this.config.apiModel,
      modelSelection: this.config.apiModel ? 'configured' : 'dynamic-latest-opus',
      protocol: apiProtocol(this.config),
      request: apiWireSettings(this.config),
      maxTokens: apiWireMaxTokens(this.config),
      reasoning: {
        level: this.config.apiReasoning,
        effort: apiReasoningEffort(this.config),
        configuredMaxTokens: this.config.apiMaxTokens,
      },
      cache: this.config.apiCache,
      context: {
        policy: 'rolling-window',
        tokenBudget: this.config.apiContextTokens,
        estimator: 'conservative-utf8',
      },
      limits: {
        inputTokenBudget: this.config.apiContextTokens,
        inputEstimator: 'conservative-utf8',
        requestBytes: 256 * 1024,
        outputTokenLimit: apiWireMaxTokens(this.config),
        outputIncludesReasoning: true,
      },
      transport: {
        retry: POST_RETRY_POLICY,
        idempotencyConfirmed: false,
      },
      concurrency: {
        sameSession: 'single-in-flight',
        differentSessions: 'concurrent-network-short-state-lock',
        globalSessionLimit: null,
      },
    };
  }

  // Local-only credential check for diagnostics: never sends a request, never returns the key.
  async credentialStatus() {
    try {
      await this.config.readApiKey();
      return { readable: true };
    } catch (error) {
      return { readable: false, code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR' };
    }
  }

  async sessions() {
    const state = await this.store.load();
    return {
      ok: true,
      sessions: state.apiSessions.map((entry) => ({
        backend: 'api',
        session: entry.session,
        sessionId: entry.sessionId,
        model: entry.model,
        protocol: entry.protocol ?? 'messages',
        apiBaseUrl: entry.apiBaseUrl,
        title: entry.title,
        messageCount: entry.messages.length,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        pending: entry.pending === null ? null : {
          kind: entry.pending.kind,
          transport: entry.pending.transport,
          startedAt: entry.pending.startedAt,
        },
      })),
    };
  }

  async ask({ session, prompt, title, attachments, native, model }, { signal } = {}) {
    checkAlias(session);
    checkPrompt(prompt);
    checkTitle(title);
    checkTextOnly(attachments, native);
    this.#requireEnabled();
    const modelChoice = await this.#resolveModel(model);
    return this.#turn({ session, prompt, title: title ?? null, modelChoice }, { signal, create: true });
  }

  async followUp({ session, prompt, attachments, native }, { signal } = {}) {
    checkAlias(session);
    checkPrompt(prompt);
    checkTextOnly(attachments, native);
    this.#requireEnabled();
    return this.#turn({ session, prompt, title: undefined }, { signal, create: false });
  }

  #requireEnabled() {
    if (this.config.backend === 'web') {
      throw new BridgeError('API_DISABLED', 'The fallback API channel is disabled; set backend to api or auto');
    }
    if (!this.config.apiBaseUrl) {
      throw new BridgeError('API_NOT_CONFIGURED', 'Configure the API base URL before using the fallback channel');
    }
  }

  async #resolveModel(explicitModel) {
    const catalog = await (this.modelCatalog
      ? this.modelCatalog()
      : scanHostModelCatalog({ home: this.config.home, env: this.config.env, platform: this.config.platform }));
    if (explicitModel !== undefined && explicitModel !== null) {
      return selectHostModel({
        explicitModel,
        catalog,
        availableModels: catalog.models.map(model => model.normalized),
      });
    }
    if (this.config.apiModel) return selectHostModel({ configuredModel: this.config.apiModel, catalog: { models: [] } });
    return selectHostModel({ catalog });
  }

  // The request profile is pinned to whatever the alias was created with, so an
  // operator configuration change can never silently move a paid conversation.
  #requestConfig(entry) {
    return {
      apiBaseUrl: entry.apiBaseUrl,
      apiModel: entry.model,
      apiProtocol: entry.protocol ?? 'messages',
      apiReasoning: this.config.apiReasoning,
      apiMaxTokens: this.config.apiMaxTokens,
      apiContextTokens: this.config.apiContextTokens,
      apiCache: this.config.apiCache,
      timeoutMs: this.config.timeoutMs,
    };
  }

  async #turn({ session, prompt, title, modelChoice }, { signal, create }) {
    const key = await this.config.readApiKey();
    const withLock = this.store.withLock.bind(this.store);
    const prepared = await withLock(async () => {
      const state = await this.store.load();
      const existing = findEntry(state, session);
      if (create && existing) {
        throw new BridgeError('SESSION_EXISTS', `Session "${session}" already exists`);
      }
      if (!create && !existing) {
        throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      }
      if (existing && (existing.apiBaseUrl !== this.config.apiBaseUrl
        || (existing.modelSelection !== 'explicit' && this.config.apiModel != null && existing.model !== this.config.apiModel)
        || (existing.protocol ?? 'messages') !== apiProtocol(this.config))) {
        throw new BridgeError('API_PROFILE_CHANGED', 'This alias stays on its original endpoint, explicitly configured model and protocol; use a new alias for a changed profile', {
          session,
          recorded: { apiBaseUrl: existing.apiBaseUrl, model: existing.model, protocol: existing.protocol ?? 'messages' },
          configured: { apiBaseUrl: this.config.apiBaseUrl, model: this.config.apiModel, protocol: apiProtocol(this.config) },
        });
      }
      if (existing?.pending) {
        throw new BridgeError('PENDING_TURN', `Session "${session}" has an uncertain API send; inspect and explicitly discard it before sending again`, {
          session,
          backend: 'api',
          pending: true,
        });
      }
      if (existing && existing.messages.length >= MAX_API_MESSAGES) {
        throw new BridgeError('API_CONTEXT_LIMIT', `Session "${session}" reached the stored turn limit; history was not trimmed or summarised and nothing was sent`, {
          session,
          messages: existing.messages.length,
          limit: MAX_API_MESSAGES,
        });
      }
      if (!existing && state.apiSessions.length >= MAX_API_SESSIONS) {
        throw new BridgeError('API_SESSION_LIMIT', `Private API history already holds ${MAX_API_SESSIONS} aliases; nothing was sent`, {
          sessions: state.apiSessions.length,
          limit: MAX_API_SESSIONS,
        });
      }
      const entry = existing ?? this.#newEntry(session, title, modelChoice);
      const previousComplete = entry.messages.at(-1)?.complete ?? null;
      const messages = [...entry.messages, { role: 'user', content: prompt }];
      const requestConfig = this.#requestConfig(entry);
      const request = prepareApiRequest(requestConfig, messages, entry.sessionId);
      assertApiCapacity(existing ? state : { ...state, apiSessions: [...state.apiSessions, entry] }, prompt);

      if (existing && !entry.credentialBinding) {
        throw new BridgeError('API_CREDENTIAL_UNBOUND', 'The original credential identity is unknown; explicitly adopt this legacy history before sending', { session });
      }
      if (existing && !(await matchesCredentialBinding(key, entry.sessionId, entry.credentialBinding))) {
        throw new BridgeError('API_CREDENTIAL_CHANGED', 'The configured credential does not match this history; rotate it explicitly before sending', { session });
      }
      if (!existing) entry.credentialBinding = await createCredentialBinding(key, entry.sessionId);
      if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');

      const now = iso();
      entry.pending = {
        kind: 'send',
        transport: 'api',
        promptSha256: sha256hex(prompt),
        startedAt: now,
        messageCount: entry.messages.length,
      };
      entry.updatedAt = now;
      if (!existing) state.apiSessions.push(entry);
      await this.#saveOrThrow(state, entry, { beforeSend: true });
      return { entry, messages, requestConfig: this.#requestConfig(entry), request, previousComplete };
    }, { signal });

    let result;
    try {
      result = await sendApiMessage(prepared.requestConfig, {
        messages: prepared.messages,
        sessionId: prepared.entry.sessionId,
        key,
        prepared: prepared.request,
      }, { signal, fetchImpl: this.fetchImpl });
    } catch (error) {
      throw new BridgeError(
        typeof error?.code === 'string' ? error.code : 'API_REQUEST_FAILED',
        error instanceof BridgeError ? error.message : 'API request failed; it was not retried',
        { ...(error instanceof BridgeError ? error.details : {}), session, backend: 'api', pending: true, retried: false });
    }

    const completed = iso();
    try {
      await withLock(async () => {
        const state = await this.store.load();
        const index = state.apiSessions.findIndex(current => current.session === session);
        if (index === -1) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
        const current = state.apiSessions[index];
        if (current.pending?.messageCount !== prepared.entry.messages.length
          || current.pending.promptSha256 !== prepared.entry.pending.promptSha256) {
          throw new BridgeError('PENDING_TURN', 'The uncertain send changed before the reply could be written; it was not resent', {
            session, backend: 'api', pending: true,
          });
        }
        const next = structuredClone(current);
        next.messages.push({ role: 'user', content: prompt });
        next.messages.push({ role: 'assistant', content: result.reply, stopReason: result.stopReason, complete: result.complete });
        next.lastAssistantMessageId = result.assistantMessageId;
        next.lastUsage = { ...result.usage, observedAt: completed };
        next.pending = null;
        next.updatedAt = completed;
        state.apiSessions[index] = next;
        await this.store.save(state);
      }, { signal });
    } catch (error) {
      throw new BridgeError('API_STATE_IO', 'Could not write the private API history; the reply was received but the attempt remains pending', {
        session, backend: 'api', responseReceived: true, pending: true, cause: error?.code ?? 'IO',
      });
    }
    const entry = prepared.entry;
    return {
      ok: true,
      backend: 'api',
      session: entry.session,
      protocol: entry.protocol ?? 'messages',
      sessionId: entry.sessionId,
      conversationId: entry.sessionId,
      assistantMessageId: result.assistantMessageId,
      reply: result.reply,
      model: result.model ?? entry.model,
      stopReason: result.stopReason,
      complete: result.complete,
      previousComplete: prepared.previousComplete,
      title: entry.title,
      usage: result.usage,
      cache: this.#cache(result.usage),
      context: result.context,
      limits: {
        inputTokenBudget: this.config.apiContextTokens,
        inputEstimator: 'conservative-utf8',
        requestBytes: 256 * 1024,
        outputTokenLimit: apiWireMaxTokens(this.config),
        outputIncludesReasoning: true,
      },
      truncation: result.complete === false ? {
        stopReason: result.stopReason,
        outputTokenLimit: apiWireMaxTokens(this.config),
        reasoningTokens: result.usage.reasoningTokens,
        reasoningConsumesOutputBudget: true,
      } : null,
      url: null,
    };
  }

  async #saveOrThrow(state, entry, { beforeSend }) {
    try {
      await this.store.save(state);
    } catch (error) {
      throw new BridgeError('API_STATE_IO', beforeSend
        ? 'Could not persist the pending send state; no request was made'
        : 'Could not write the private API history', {
        session: entry.session, backend: 'api', pending: beforeSend, cause: error?.code ?? 'IO',
      });
    }
  }

  // Counters only: no cost or saving is inferred when the provider reports nothing.
  #cache(usage) {
    const read = usage.cacheReadInputTokens;
    return {
      control: apiProtocol(this.config) === 'messages' ? this.config.apiCache : 'automatic',
      readInputTokens: read,
      creationInputTokens: usage.cacheCreationInputTokens,
      observed: read !== null,
      hit: read === null ? null : read > 0,
    };
  }

  #newEntry(session, title, modelChoice) {
    const now = iso();
    return {
      session,
      sessionId: randomUUID(),
      apiBaseUrl: this.config.apiBaseUrl,
      model: modelChoice.id,
      ...(modelChoice.source === 'explicit' ? { modelSelection: 'explicit' } : {}),
      protocol: apiProtocol(this.config),
      title: title ?? null,
      messages: [],
      lastAssistantMessageId: null,
      createdAt: now,
      updatedAt: now,
      lastUsage: null,
      pending: null,
    };
  }

  async bindCredential({ session, oldKeyFile, adoptUnbound = false }, { signal } = {}) {
    checkAlias(session);
    this.#requireEnabled();
    if (typeof adoptUnbound !== 'boolean' || Boolean(oldKeyFile) === adoptUnbound) {
      throw new BridgeError('INVALID_ARGUMENT', 'Choose exactly one of an old private key file or explicit legacy adoption');
    }
    return this.store.withLock(async () => {
      const state = await this.store.load();
      const entry = findEntry(state, session);
      if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      if (entry.pending) throw new BridgeError('PENDING_TURN', 'Resolve the uncertain send before changing credential binding', { session, pending: true });
      if (entry.apiBaseUrl !== this.config.apiBaseUrl
        || (entry.modelSelection !== 'explicit' && this.config.apiModel != null && entry.model !== this.config.apiModel)
        || (entry.protocol ?? 'messages') !== apiProtocol(this.config)) {
        throw new BridgeError('API_PROFILE_CHANGED', 'Credential binding requires the original endpoint, explicitly configured model and protocol', { session });
      }
      const bound = Boolean(entry.credentialBinding);
      if (bound === adoptUnbound) {
        throw new BridgeError('INVALID_ARGUMENT', bound ? 'A bound history requires the original key file' : 'Legacy history requires explicit adoption; its original key cannot be verified');
      }
      if (bound) {
        const oldKey = await readApiKeyFile(oldKeyFile);
        if (!(await matchesCredentialBinding(oldKey, entry.sessionId, entry.credentialBinding))) {
          throw new BridgeError('API_CREDENTIAL_MISMATCH', 'The old credential does not match the recorded binding');
        }
      }
      const key = await this.config.readApiKey();
      const binding = await createCredentialBinding(key, entry.sessionId);
      if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
      entry.credentialBinding = binding;
      entry.updatedAt = iso();
      await this.#saveOrThrow(state, entry, { beforeSend: false });
      return { ok: true, backend: 'api', session, identityVerified: bound, sent: false };
    }, { signal });
  }

  async transcript({ session, recover = false, discardPending = false }, { signal } = {}) {
    checkAlias(session);
    if (discardPending && !recover) {
      throw new BridgeError('INVALID_ARGUMENT', 'discardPending requires recover=true: it is an explicit, caller-owned decision');
    }
    if (!discardPending) {
      const state = await this.store.load();
      const entry = findEntry(state, session);
      if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      return this.#view(entry, recover);
    }
    return this.store.withLock(async () => {
      const state = await this.store.load();
      const entry = findEntry(state, session);
      if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      const abandoned = entry.pending;
      if (abandoned) {
        entry.pending = null;
        entry.updatedAt = iso();
        await this.#saveOrThrow(state, entry, { beforeSend: false });
      }
      return {
        ...this.#view(entry, false),
        recovered: false,
        discarded: Boolean(abandoned),
        discardedPending: abandoned,
        retried: false,
      };
    }, { signal });
  }

  #view(entry, recover) {
    const pending = entry.pending === null ? null : {
      kind: entry.pending.kind,
      transport: entry.pending.transport,
      startedAt: entry.pending.startedAt,
      promptSha256: entry.pending.promptSha256,
    };
    const view = {
      ok: true,
      backend: 'api',
      session: entry.session,
      sessionId: entry.sessionId,
      conversationId: entry.sessionId,
      apiBaseUrl: entry.apiBaseUrl,
      model: entry.model,
      protocol: entry.protocol ?? 'messages',
      title: entry.title,
      currentLeafMessageId: entry.lastAssistantMessageId,
      pending,
      pendingRetained: pending !== null,
      // The provider keeps no authority over this stateless history, so recovery never claims success.
      recoveryAvailable: false,
      credentialIdentity: entry.credentialBinding ? 'bound' : 'unknown',
      recovered: false,
      resumed: false,
      retried: false,
      lastUsage: entry.lastUsage,
      messages: entry.messages.map((message) => ({
        role: message.role, text: message.content,
        ...(message.role === 'assistant' ? { stopReason: message.stopReason ?? null, complete: message.complete ?? null } : {}),
      })),
    };
    if (recover && pending) {
      view.reconciliation = {
        status: 'unconfirmed',
        reason: 'API_UNCONFIRMED',
        message: 'The previous attempt may have been billed; its answer was never stored and nothing was resent. Pass discardPending in the same explicit recover call to abandon it, or open a new alias.',
      };
    }
    return view;
  }
}
