import { randomUUID, createHash } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { BridgeError } from './core/errors.mjs';
import { ClaudeApi, ROOT_PARENT, activeBranch } from './core/claude-api.mjs';
import { withClaudeTab } from './core/tab.mjs';
import { SessionStore, ALIAS_RE } from './session-store.mjs';
import { prepareAttachments, verifiedAttachments, attachmentIdentity, matchesAttachments, resolveAdoptedAttachments, validateDestination, prepareDownload, validateDownload, validateFrameOriginal, MAX_DOWNLOAD_BYTES } from './attachments.mjs';
import { NativeComposer, chooseTransport, normalizeWebPrompt, wait } from './core/ui.mjs';
import { messageText, publicArtifacts, completedAssistant, assistantCompletion, settledAssistant } from './core/artifacts.mjs';
import { scanHostModelCatalog, modelEquivalent, normalizeModelId, selectHostModel } from './model-catalog.mjs';
import { inspectWebModelPicker, resolveWebModel, selectWebModel } from './core/model-picker.mjs';

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 200;
const iso = () => new Date().toISOString();

// Shared so the routed preflight (`auto`) can report the same doctor payload
// from a single browser check instead of probing the tab twice.
export async function webDoctorPayload(config, tab, orgId, modelCatalog = null) {
  let webpage = null;
  try {
    const picker = await inspectWebModelPicker(tab);
    webpage = {
      selected: picker.triggerModel,
      available: picker.options.map(option => option.normalized),
    };
  } catch (error) {
    webpage = { selected: null, available: [], error: error.code ?? 'MODEL_INSPECT_FAILED' };
  }
  let selection = null;
  try {
    selection = selectHostModel({ catalog: modelCatalog ?? { models: [] }, availableModels: webpage.available });
  } catch {}
  return {
    ok: true,
    cdpUrl: tab.cdpUrl ?? config.cdpUrl,
    browser: tab.client.versionInfo?.Browser ?? null,
    authenticated: true,
    orgId,
    protocol: 'rest-sse',
    attachments: {
      configured: Boolean(config.attachmentRootReal),
      source: config.attachmentRootReal ? (config.attachmentRootSource ?? 'unknown') : null,
      configFile: config.attachmentConfigFile ?? null,
      environmentVariable: 'CCW_ATTACHMENT_ROOT',
      supported: true,
    },
    model: {
      catalog: modelCatalog?.models ?? [],
      defaultModel: modelCatalog?.defaultModel ?? null,
      webpage,
      selection: selection?.normalized ?? null,
    },
  };
}
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

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(new BridgeError('ABORTED', 'Operation aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BridgeError('ABORTED', 'Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// One deadline for a whole public operation (validation stays outside).
async function boundedOperation(timeoutMs, callerSignal, fn) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
  try {
    return await fn(signal);
  } catch (error) {
    if (deadline.signal.aborted && !callerSignal?.aborted) {
      throw new BridgeError('TIMEOUT', 'Operation deadline exceeded', error.details ?? {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Failures that left a pending marker must carry recovery metadata.
function enrichPendingError(error, entry) {
  if (entry?.pending) {
    // page-side failures carry .code without being BridgeError instances
    const coded = typeof error?.code === 'string';
    throw new BridgeError(
      coded ? error.code : 'STATE_IO',
      coded || error instanceof BridgeError ? error.message : 'Could not persist the conversation state; inspect the saved session',
      {
        ...(error instanceof BridgeError ? error.details : (error?.details ?? {})),
        session: entry.session,
        conversationId: entry.conversationId,
        pending: true,
      });
  }
  throw error;
}

function findEntry(state, session) {
  return state.sessions.find((e) => e.session === session);
}

// A pending turn is safe to auto-submit only when every selected non-text file
// already carries its verified server identity; a manifest that is missing an
// identity was never upload-verified, so the draft cannot be trusted as ours.
function manifestSubmittable(manifest) {
  return Array.isArray(manifest) && manifest.every(file => file.kind === 'text' || typeof file.fileId === 'string');
}

// The held draft's innerText is itself the submission the page will make; the
// pending marker only carries its digest, so both the raw form and its collapsed
// double-newline rendering are accepted as proof of identity.
function heldDraftMatchesPending(editorText, promptSha256) {
  const sha = text => sha256hex(normalizeWebPrompt(text));
  return sha(editorText) === promptSha256 || sha(editorText.replaceAll('\n\n', '\n')) === promptSha256;
}

// Only states the page produces while it is still persisting the draft are retried: a missing
// row or a `blob` placeholder (both FILE_NOT_READY) and an unreadable draft row. A real operator
// conflict stays UI_DRAFT_CONFLICT and is reported on the first read.
const DRAFT_RETRY = new Set(['FILE_NOT_READY', 'UI_DRAFT_UNAVAILABLE']);

async function settleDraft(composer, manifest, options, signal) {
  const end = Date.now() + composer.tab.config.readyTimeoutMs;
  let failure;
  for (;;) {
    try {
      return resolveAdoptedAttachments(manifest, await composer.readDraft({ retain: false }), options);
    } catch (error) {
      if (!DRAFT_RETRY.has(error?.code)) throw error;
      failure = error;
    }
    if (Date.now() >= end) {
      composer.tab.retainTarget = true;
      throw failure;
    }
    await wait(Math.min(100, end - Date.now()), signal);
  }
}

export class ClaudeBridge {
  constructor(config = loadConfig(), { store = new SessionStore(config.stateDir), withTab = withClaudeTab, modelCatalog } = {}) {
    this.config = config;
    this.store = store;
    this.withTab = withTab;
    this.modelCatalog = modelCatalog;
  }

  async ask({ session, prompt, title, attachments, native = false, model }, { signal } = {}) {
    checkAlias(session);
    checkPrompt(prompt);
    checkTitle(title);
    chooseTransport({}, [], native);
    return boundedOperation(this.config.timeoutMs, signal, (opSignal) => this.#ask({ session, prompt, title, attachments, native, model }, opSignal));
  }

  async #ask({ session, prompt, title, attachments, native, model }, signal) {
    const prepared = await this.store.withLock(async () => {
      const state = await this.store.load();
      if (findEntry(state, session)) {
        throw new BridgeError('SESSION_EXISTS', `Session "${session}" already exists`);
      }
      return verifiedAttachments(await prepareAttachments(attachments, this.config, { signal }));
    }, { signal });

    return this.withTab(this.config, async (tab) => {
      const api = new ClaudeApi(tab, this.config);
      const orgId = await api.discoverOrganization({ signal });
      const catalog = await this.#catalog();
      const modelChoice = await resolveWebModel(tab, { explicitModel: model, catalog, signal });
      const conversationId = randomUUID();
      const now = iso();
      const { entry } = await this.store.createSession(session, {
        orgId,
        conversationId,
        parentMessageId: ROOT_PARENT,
        model: modelChoice.normalized,
        createdAt: now,
        updatedAt: now,
        pending: { kind: 'create', startedAt: now },
      }, { signal });
      try {
        const created = await api.createConversation(orgId, conversationId, title ?? `[ccw] ${session}`, { signal });
        if (!modelEquivalent(created.model, modelChoice.normalized)) {
          throw new BridgeError('MODEL_UNVERIFIED', 'Conversation creation did not confirm the selected webpage model');
        }
        const saved = await this.#patchSession(session, { pending: null, updatedAt: iso() });
        return await this.#sendTurn(session, saved, api, ROOT_PARENT, prompt, { signal, files: prepared, native, conversation: created, modelChoice });
      } catch (error) {
        const current = await this.store.load();
        const failed = findEntry(current, session);
        if (failed?.pending) enrichPendingError(error, failed);
        throw error;
      }
    }, { signal });
  }

  async followUp({ session, prompt, attachments, native = false }, { signal } = {}) {
    checkAlias(session);
    checkPrompt(prompt);
    chooseTransport({}, [], native);
    return boundedOperation(this.config.timeoutMs, signal, (opSignal) => this.#followUp({ session, prompt, attachments, native }, opSignal));
  }

  async #followUp({ session, prompt, attachments, native }, signal) {
    const prepared = await this.store.withLock(async () => {
      const state = await this.store.load();
      const entry = findEntry(state, session);
      if (!entry) {
        throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      }
      if (entry.pending) {
        throw new BridgeError('PENDING_TURN', `Session "${session}" has an uncertain send; inspect and recover the transcript first`, {
          session,
          conversationId: entry.conversationId,
          pending: true,
        });
      }
      return verifiedAttachments(await prepareAttachments(attachments, this.config, { signal }));
    }, { signal });

    return this.withTab(this.config, async (tab) => {
      const entry = await this.#entry(session);
      const api = new ClaudeApi(tab, this.config);
      const conv = await api.conversation(entry.orgId, entry.conversationId, { signal });
      const pinnedModel = normalizeModelId(entry.model);
      if (pinnedModel && !modelEquivalent(conv.model, pinnedModel)) {
        throw new BridgeError('MODEL_MISMATCH', 'The webpage conversation no longer uses the model pinned at alias creation', {
          session,
          conversationId: entry.conversationId,
          expected: entry.model,
        });
      }
      const branch = activeBranch(conv);
      let parent;
      let previousComplete = null;
      if (branch.length === 0) {
        parent = ROOT_PARENT;
      } else {
        const leaf = branch[branch.length - 1];
        previousComplete = assistantCompletion(leaf);
        if (settledAssistant(entry.conversationId, leaf)
          && (previousComplete === true || leaf.uuid === entry.parentMessageId)) {
          parent = leaf.uuid;
        } else {
          throw new BridgeError('REMOTE_IN_PROGRESS', 'The server conversation leaf is not a completed assistant message', {
            session,
            conversationId: entry.conversationId,
          });
        }
      }
      const pinnedChoice = pinnedModel ? { id: entry.model, normalized: pinnedModel, source: 'pinned' } : null;
      try {
        const sent = await this.#sendTurn(session, entry, api, parent, prompt, {
          signal, files: prepared, native, conversation: conv, modelChoice: pinnedChoice,
        });
        return { ...sent, previousComplete };
      } catch (error) {
        const current = await this.store.load();
        const failed = findEntry(current, session);
        if (failed?.pending) enrichPendingError(error, failed);
        throw error;
      }
    }, { signal });
  }

  async #entry(session) {
    const state = await this.store.load();
    const entry = findEntry(state, session);
    if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
    return entry;
  }

  async #patchSession(session, patch, statePatch = {}) {
    return this.store.withLock(async () => {
      const state = await this.store.load();
      const index = state.sessions.findIndex(entry => entry.session === session);
      if (index === -1) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      const entry = { ...state.sessions[index], ...patch };
      if (entry.session !== session) {
        throw new BridgeError('STATE_UNSAFE', 'A session update cannot move or rename its alias');
      }
      state.sessions[index] = entry;
      if (statePatch.lastSubmissionAt !== undefined) {
        state.lastSubmissionAt = Math.max(state.lastSubmissionAt, statePatch.lastSubmissionAt);
      }
      if (statePatch.version !== undefined && state.version < statePatch.version) state.version = statePatch.version;
      await this.store.save(state);
      return entry;
    });
  }

  async #sendTurn(session, entry, api, parentMessageId, prompt, {
    signal, files = [], native = false, conversation = {}, modelChoice = null,
  }) {
    const transport = chooseTransport(conversation, files, native);
    for (;;) {
      const waitMs = this.config.minIntervalMs - (Date.now() - (await this.store.load()).lastSubmissionAt);
      if (waitMs <= 0) break;
      await delay(waitMs, signal);
    }
    if (transport === 'native') return this.#sendNative(session, entry, api, parentMessageId, prompt, files, signal, modelChoice);
    const now = iso();
    const sent = await this.#patchSession(session, {
      pending: {
        kind: 'send',
        parentMessageId,
        promptSha256: sha256hex(prompt),
        startedAt: now,
      },
      updatedAt: now,
    }, { lastSubmissionAt: Date.now() });
    entry = sent;
    const result = await api.complete(entry.orgId, entry.conversationId, parentMessageId, prompt, { signal });
    if (modelChoice && !modelEquivalent(result.model, modelChoice.normalized)) {
      throw new BridgeError('MODEL_MISMATCH', 'The completion response used a different model than the verified webpage selection');
    }
    const patch = {
      parentMessageId: result.assistantMessageId,
      pending: null,
      updatedAt: iso(),
    };
    if (typeof result.model === 'string' && result.model !== '' && !entry.model) patch.model = result.model;
    else patch.model = entry.model;
    try {
      await this.#patchSession(session, patch, { lastSubmissionAt: Date.now() });
    } catch (error) {
      const current = await this.store.load();
      const failed = findEntry(current, session);
      if (failed?.pending) enrichPendingError(error, failed);
      throw error;
    }
    return {
      ok: true,
      session: entry.session,
      conversationId: entry.conversationId,
      assistantMessageId: result.assistantMessageId,
      reply: result.reply,
      model: result.model ?? entry.model,
      stopReason: result.stopReason ?? null,
      complete: result.complete ?? null,
      quota: result.quota ?? null,
      url: `https://claude.ai/chat/${entry.conversationId}`,
    };
  }

  // Explicit operator recovery for an uncertain native upload: adopt the draft the
  // page already restored, resolve its identities, submit exactly once. Never
  // re-selects, re-uploads, or retries a send whose outcome is already unknown.
  async resumeNativeUpload({ session, prompt }, { signal } = {}) {
    checkAlias(session);
    checkPrompt(prompt);
    return boundedOperation(this.config.timeoutMs, signal, (opSignal) => this.#resumeNativeUpload({ session, prompt }, opSignal));
  }

  async #resumeNativeUpload({ session, prompt }, signal) {
    const entry = await this.#entry(session);
    const pending = entry.pending;
    if (!pending) throw new BridgeError('NO_PENDING', `Session "${session}" has no uncertain upload to resume`, { session });
    if ((pending.kind !== 'upload' && pending.kind !== 'send')
      || pending.transport !== 'native' || !Array.isArray(pending.attachments)) {
      throw new BridgeError('PENDING_TURN', 'Only an uncertain native upload or send can adopt a restored draft; nothing was sent', {
        session, pending: pending.kind,
      });
    }
    verifiedAttachments(pending.attachments);
    if (pending.attachments.some(file => file.kind !== 'text' && !file.fileId)) {
      throw new BridgeError('FILE_NOT_READY', 'The original uploaded identity is unknown; the draft cannot be safely resumed');
    }
    const canonical = normalizeWebPrompt(prompt);
    if (sha256hex(canonical) !== pending.promptSha256) {
      throw new BridgeError('PROMPT_MISMATCH', 'The supplied prompt does not match the pending upload; nothing was sent', { session });
    }
    // Legacy UTF-8 digests conflate unpaired surrogates with U+FFFD. The
    // original code units cannot be proven from the digest or current draft.
    if (canonical.includes('\uFFFD')) {
      throw new BridgeError('PROMPT_IDENTITY_AMBIGUOUS', 'The original prompt identity cannot be verified; nothing was sent', { session, pending: true });
    }
    return this.withTab(this.config, async (tab) => {
      const api = new ClaudeApi(tab, this.config);
      const conversation = await api.conversation(entry.orgId, entry.conversationId, { signal });
      const branch = activeBranch(conversation);
      if ((branch.at(-1)?.uuid ?? ROOT_PARENT) !== pending.parentMessageId) {
        throw new BridgeError('REMOTE_BRANCH_CHANGED', 'The conversation moved since this upload; nothing was sent', {
          session, conversationId: entry.conversationId,
        });
      }
      const composer = new NativeComposer(tab, entry.orgId, entry.conversationId, { signal });
      try {
        await composer.openDraft(pending.attachments.map(file => file.name), { expectedText: canonical });
        let resolved;
        try {
          resolved = pending.attachments.length
            ? await settleDraft(composer, pending.attachments, { expectedEditorText: canonical }, signal)
            : [];
        } catch (error) {
          // an adopted draft belongs to the operator: leave the page open for inspection
          tab.retainTarget = true;
          throw error;
        }
        let current = await this.#patchSession(session, {
          pending: {
            kind: 'upload', transport: 'native', parentMessageId: pending.parentMessageId,
            promptSha256: sha256hex(canonical), startedAt: iso(), attachments: resolved,
          },
          updatedAt: iso(),
        }, { version: 2 });
        await composer.fillPrompt(canonical);
        try {
          if (resolved.length) await settleDraft(composer, resolved, { expectedEditorText: canonical }, signal);
        } catch (error) {
          tab.retainTarget = true;
          throw error;
        }
        const latest = activeBranch(await api.conversation(current.orgId, current.conversationId, { signal }));
        if ((latest.at(-1)?.uuid ?? ROOT_PARENT) !== pending.parentMessageId) {
          throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Conversation changed before native submission');
        }
        current = await this.#patchSession(session, { pending: { ...current.pending, kind: 'send' } }, { lastSubmissionAt: Date.now() });
        await composer.submit({
          beforeAttempt: async () => {
            const latest = activeBranch(await api.conversation(current.orgId, current.conversationId, { signal }));
            if ((latest.at(-1)?.uuid ?? ROOT_PARENT) !== pending.parentMessageId) {
              api.tab.retainTarget = true;
              throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Conversation changed before native submission');
            }
          },
        });
        const { conversation: serverConversation, assistant } = await this.#waitNative(current, api, composer, signal);
        const artifacts = publicArtifacts(current.conversationId, [assistant]);
        const model = typeof serverConversation.model === 'string' ? serverConversation.model : current.model;
        current = await this.#patchSession(session, {
          parentMessageId: assistant.uuid, pending: null, model, updatedAt: iso(),
        }, { version: 2, lastSubmissionAt: Date.now() });
        return {
          ok: true,
          session: current.session,
          conversationId: current.conversationId,
          assistantMessageId: assistant.uuid,
          reply: messageText(assistant),
          model,
          stopReason: assistant.stop_reason,
          complete: assistantCompletion(assistant),
          quota: null,
          url: `https://claude.ai/chat/${current.conversationId}`,
          attachments: resolved,
          artifacts,
          adopted: true,
        };
      } finally {
        await composer.dispose();
      }
    }, { signal });
  }

  async #sendNative(session, entry, api, parentMessageId, prompt, files, signal, modelChoice = null) {
    const canonical = normalizeWebPrompt(prompt);
    const composer = new NativeComposer(api.tab, entry.orgId, entry.conversationId, {
      signal,
      onUpload: async receipt => {
        const attachments = entry.pending.attachments.map(file => file.name === receipt.name ? { ...file, fileId: receipt.fileId } : file);
        entry = await this.#patchSession(session, { pending: { ...entry.pending, attachments }, updatedAt: iso() });
      },
    });
    try {
      await composer.open();
      if (modelChoice) await selectWebModel(api.tab, modelChoice.normalized, { signal });
      if (files.length) {
        entry = await this.#patchSession(session, {
          pending: {
            kind: 'upload', transport: 'native', parentMessageId,
            promptSha256: sha256hex(canonical), startedAt: iso(), attachments: files.map(attachmentIdentity),
          },
          updatedAt: iso(),
        }, { version: 2 });
        await composer.attachFiles(files);
      } else {
        // No upload stage exists to catch a moved branch, so the continuity
        // check runs before the send marker is written: a moved branch leaves
        // no pending behind and the prompt never reaches the page.
        const current = activeBranch(await api.conversation(entry.orgId, entry.conversationId, { signal }));
        if ((current.at(-1)?.uuid ?? ROOT_PARENT) !== parentMessageId) {
          throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Conversation changed before native submission');
        }
        // A text-only turn never carries an 'upload' pending: the send attempt is
        // recorded before the prompt reaches the page so a later crash leaves a
        // resumable 'send' marker instead of an unsubmitted draft nobody can claim.
        entry = await this.#patchSession(session, {
          pending: {
            kind: 'send', transport: 'native', parentMessageId,
            promptSha256: sha256hex(canonical), startedAt: iso(), attachments: [],
          },
          updatedAt: iso(),
        }, { version: 2, lastSubmissionAt: Date.now() });
      }
      await composer.compose(canonical, { waitReady: false });
      if (files.length) {
        try {
          await settleDraft(composer, entry.pending.attachments, { expectedEditorText: canonical }, signal);
        } catch (error) {
          api.tab.retainTarget = true;
          throw error;
        }
        // Last read-only confirmation that the turn still appends to the same
        // parent; a failure here stays an 'upload' pending for native-resume.
        const current = activeBranch(await api.conversation(entry.orgId, entry.conversationId, { signal }));
        if ((current.at(-1)?.uuid ?? ROOT_PARENT) !== parentMessageId) {
          api.tab.retainTarget = true;
          throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Conversation changed before native submission');
        }
        entry = await this.#patchSession(session, { pending: { ...entry.pending, kind: 'send' } }, { lastSubmissionAt: Date.now() });
      }
      const branchUnchanged = async () => {
        const current = activeBranch(await api.conversation(entry.orgId, entry.conversationId, { signal }));
        if ((current.at(-1)?.uuid ?? ROOT_PARENT) !== parentMessageId) {
          api.tab.retainTarget = true;
          throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Conversation changed before native submission');
        }
      };
      await composer.submit({ beforeAttempt: branchUnchanged });
      const { conversation, assistant } = await this.#waitNative(entry, api, composer, signal);
      if (modelChoice && !modelEquivalent(conversation.model, modelChoice.normalized)) {
        throw new BridgeError('MODEL_MISMATCH', 'The native response used a different model than the verified webpage selection');
      }
      const artifacts = publicArtifacts(entry.conversationId, [assistant]);
      const inputs = entry.pending.attachments;
      const model = entry.model ?? (typeof conversation.model === 'string' ? conversation.model : null);
      entry = await this.#patchSession(session, {
        parentMessageId: assistant.uuid, pending: null, model, updatedAt: iso(),
      }, { lastSubmissionAt: Date.now() });
      return {
        ok: true, session: entry.session, conversationId: entry.conversationId, assistantMessageId: assistant.uuid,
        reply: messageText(assistant), model, stopReason: assistant.stop_reason,
        complete: assistantCompletion(assistant), quota: null, autoRecovered: composer.autoRecovered,
        url: `https://claude.ai/chat/${entry.conversationId}`, attachments: inputs, artifacts,
      };
    } finally {
      await composer.dispose();
    }
  }

  async #waitNative(entry, api, composer, signal) {
    let lastProgress = Date.now();
    let previous = null;
    for (;;) {
      await composer.assertScope();
      let conversation;
      try {
        conversation = await api.conversation(entry.orgId, entry.conversationId, { signal });
      } catch (error) {
        // While a turn is still streaming the page can omit the leaf pointer on a
        // non-empty conversation; that is a not-yet-settled read, not a send
        // failure. Keep polling within the idle budget instead of stranding the
        // pending marker on a turn the server already recorded.
        if (error?.code === 'API_CONTRACT' && /current_leaf_message_uuid/.test(error.message)) {
          await wait(Math.min(500, this.config.idleTimeoutMs), signal);
          continue;
        }
        throw error;
      }
      const branch = activeBranch(conversation);
      const pending = entry.pending;
      const index = pending.parentMessageId === ROOT_PARENT ? -1 : branch.findIndex(m => m.uuid === pending.parentMessageId);
      if (index === -1 && pending.parentMessageId !== ROOT_PARENT) throw new BridgeError('REMOTE_BRANCH_CHANGED', 'The submitted parent is no longer on the active branch');
      const suffix = branch.slice(index + 1);
      if (suffix.length > 2) throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Unexpected turns followed native submission');
      if (suffix.length) {
        if (suffix[0].sender !== 'human' || sha256hex(normalizeWebPrompt(messageText(suffix[0]))) !== pending.promptSha256
          || !matchesAttachments(suffix[0], pending.attachments)) {
          throw new BridgeError('TURN_MISMATCH', 'Server history does not identify the intended text and attachments');
        }
        if (suffix.length === 2 && suffix[1].stop_reason) {
          if (!settledAssistant(entry.conversationId, suffix[1])) throw new BridgeError('STREAM_INCOMPLETE', 'The native response is empty or has no recognized terminal status');
          return { conversation, assistant: suffix[1] };
        }
      }
      const fingerprint = sha256hex(JSON.stringify(branch));
      if (fingerprint !== previous) { previous = fingerprint; lastProgress = Date.now(); }
      if (Date.now() - lastProgress >= this.config.idleTimeoutMs) throw new BridgeError('IDLE_TIMEOUT', 'No native conversation progress');
      await wait(Math.min(500, this.config.idleTimeoutMs), signal);
    }
  }

  async sessions() {
    const state = await this.store.load();
    return {
      ok: true,
      sessions: state.sessions.map((e) => ({
        session: e.session,
        orgId: e.orgId,
        conversationId: e.conversationId,
        parentMessageId: e.parentMessageId,
        model: e.model,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        pending: e.pending === null ? null : {
          kind: e.pending.kind,
          parentMessageId: e.pending.parentMessageId ?? null,
          startedAt: e.pending.startedAt,
        },
      })),
    };
  }

  async download({ session, artifact, destination }, { signal } = {}) {
    checkAlias(session);
    if (typeof artifact !== 'string' || !/^[a-f0-9]{64}$/.test(artifact)) throw new BridgeError('INVALID_ARGUMENT', 'artifact must be an ID returned by this conversation');
    validateDestination(destination);
    return boundedOperation(this.config.timeoutMs, signal, async opSignal => {
      const state = await this.store.load();
      const entry = findEntry(state, session);
      if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      return this.withTab(this.config, async tab => {
        const api = new ClaudeApi(tab, this.config);
        const branch = activeBranch(await api.conversation(entry.orgId, entry.conversationId, { signal: opSignal }));
        const frames = new Map();
        const item = publicArtifacts(entry.conversationId, branch, frames).find(file => file.id === artifact);
        if (!item) throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact is not on this conversation branch');
        if (!item.downloadable) throw new BridgeError('FRAME_EXPORT_UNVERIFIED', 'Independent Frame Artifact export has not been verified');
        if (!completedAssistant(entry.conversationId, branch.find(message => message.uuid === item.messageId))) {
          throw new BridgeError('ARTIFACT_NOT_READY', 'The source message is not complete');
        }
        const frame = item.kind === 'frame-artifact' ? frames.get(item.id) : null;
        if (item.kind === 'frame-artifact' && !frame) throw new BridgeError('FRAME_EXPORT_UNVERIFIED', 'Independent Frame Artifact export has not been verified');
        const writer = await prepareDownload(this.config, destination ?? (frame ? frame.name : item.name), { signal: opSignal });
        let failure;
        try {
          if (frame) {
            const metadata = validateFrameOriginal(frame.bytes);
            const saved = await writer.finish(frame.bytes, metadata);
            return { ok: true, session, conversationId: entry.conversationId, artifact: item, ...metadata, ...saved };
          }
          const data = await api.contents(entry.orgId, item.fileId, { signal: opSignal });
          if (!data || typeof data.base64 !== 'string' || data.base64.length > Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4
            || !Number.isSafeInteger(data.size) || data.size < 1 || data.size > MAX_DOWNLOAD_BYTES) throw new BridgeError('FILE_CONTENT', 'Invalid binary response envelope');
          const bytes = Buffer.from(data.base64, 'base64');
          if (bytes.length !== data.size || bytes.toString('base64') !== data.base64) throw new BridgeError('FILE_CONTENT', 'Binary response was truncated');
          const metadata = validateDownload(bytes, item.name, data.contentType);
          const saved = await writer.finish(bytes, metadata);
          return { ok: true, session, conversationId: entry.conversationId, artifact: item, ...metadata, ...saved };
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          const cleanup = await writer.dispose();
          if (failure && cleanup.cleanupPending) {
            throw new BridgeError(failure.code ?? 'FILE_IO', failure.message, { ...(failure.details ?? {}), ...cleanup });
          }
        }
      }, { signal: opSignal });
    });
  }

  async transcript({ session, recover = false, discardPending = false }, { signal } = {}) {
    checkAlias(session);
    return boundedOperation(this.config.timeoutMs, signal, (opSignal) => this.#transcript({ session, recover, discardPending }, opSignal));
  }

  async #transcript({ session, recover, discardPending = false }, signal) {
    if (discardPending && !recover) {
      throw new BridgeError('INVALID_ARGUMENT', 'discardPending requires recover=true in the same call');
    }
    if (!recover) {
      const state = await this.store.load();
      const entry = findEntry(state, session);
      if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
      return this.withTab(this.config, async (tab) => {
        const api = new ClaudeApi(tab, this.config);
        const conv = await api.conversation(entry.orgId, entry.conversationId, { signal });
        return this.#transcriptResult(entry, conv, false);
      }, { signal });
    }
    let entry = await this.#entry(session);
    return this.withTab(this.config, async (tab) => {
      const state = await this.store.load();
      const api = new ClaudeApi(tab, this.config);
      let conv = await api.conversation(entry.orgId, entry.conversationId, { signal });
      if (!entry.pending) {
        return this.#transcriptResult(entry, conv, false);
      }
      const branch = activeBranch(conv);
      if (discardPending) {
        // Explicit operator abandonment: the pending turn is given up, never
        // resent. Re-anchor to the current server leaf so the alias can continue;
        // without this the next send would reject a stale parent.
        const leaf = branch.at(-1)?.uuid ?? ROOT_PARENT;
        entry = await this.#patchSession(session, { pending: null, parentMessageId: leaf, updatedAt: iso() });
        return this.#transcriptResult(entry, conv, false, false, true);
      }
      let recovered = false;
      let resumed = false;
      if (entry.pending.kind === 'create') {
        if (branch.length === 0) {
          entry = await this.#patchSession(session, { pending: null, updatedAt: iso() });
          recovered = true;
        }
      } else if (entry.pending.kind === 'send'
        || (entry.pending.kind === 'upload' && entry.pending.transport === 'native')) {
        const parentId = entry.pending.parentMessageId;
        let index = -1;
        if (parentId !== ROOT_PARENT) {
          index = branch.findIndex((m) => m.uuid === parentId);
        }
        if (index !== -1 || parentId === ROOT_PARENT) {
          const suffix = branch.slice(index + 1);
          if (suffix.length === 2
            && suffix[0].sender === 'human'
            && suffix[1].sender === 'assistant') {
            const text = entry.pending.transport === 'native' ? normalizeWebPrompt(messageText(suffix[0])) : messageText(suffix[0]);
            const humanOk = sha256hex(text) === entry.pending.promptSha256
              && matchesAttachments(suffix[0], entry.pending.attachments ?? []);
            const assistant = suffix[1];
            const assistantOk = settledAssistant(entry.conversationId, assistant)
              && (entry.pending.transport === 'native' || messageText(assistant).trim() !== '' || assistant.stop_reason === 'user_canceled');
            if (humanOk && assistantOk) {
              const patch = {
                parentMessageId: assistant.uuid,
                model: typeof conv.model === 'string' && conv.model !== '' ? conv.model : entry.model,
                pending: null,
                updatedAt: iso(),
              };
              entry = await this.#patchSession(session, patch, { lastSubmissionAt: Date.now() });
              recovered = true;
            }
          }
          // The server has no trace of the turn. A native 'send' pending may still
          // be sitting in the owned tab's composer: adopt the draft, verify it is
          // exactly this turn, and click once. 'upload' pendings stay with
          // native-resume: an upload that never reached 'send' is still uncertain
          // about its server-side file identity. Anything unprovable keeps the
          // pending marker and leaves the tab for the operator.
          if (!recovered && suffix.length === 0 && entry.pending.transport === 'native'
            && entry.pending.kind === 'send'
            && manifestSubmittable(entry.pending.attachments)) {
            const result = await this.#completePendingDraft(entry, api, signal);
            entry = result.entry;
            recovered = result.recovered;
            resumed = result.resumed;
            conv = result.conversation;
          }
        }
      }
      return this.#transcriptResult(entry, conv, recovered, resumed);
    }, { signal });
  }

  // Adopts the draft the page kept, proves it is the pending turn, then clicks
  // send exactly once and waits out the reply. Only called from recover; any
  // identity mismatch retains the tab and rethrows without touching the draft.
  async #completePendingDraft(entry, api, signal) {
    const session = entry.session;
    const pending = entry.pending;
    const composer = new NativeComposer(api.tab, entry.orgId, entry.conversationId, { signal });
    const manifest = pending.attachments ?? [];
    try {
      const conv = await api.conversation(entry.orgId, entry.conversationId, { signal });
      const branch = activeBranch(conv);
      const index = pending.parentMessageId === ROOT_PARENT ? -1 : branch.findIndex(m => m.uuid === pending.parentMessageId);
      if (index === -1 && pending.parentMessageId !== ROOT_PARENT || branch.slice(index + 1).length) {
        return { entry, recovered: false, resumed: false, conversation: conv };
      }
      // The page restores the held draft from IndexedDB after landing on the
      // conversation; read it before adopting so its text can be proven against
      // the saved digest. A text-only turn has no attachment row to wait for,
      // so the row may legitimately be absent (expectEmpty).
      await composer.navigateDraft();
      // A freshly navigated page restores its IndexedDB draft into the composer
      // asynchronously. Reading the editor before it mounts yields an empty
      // string and would be misreported as a draft mismatch.
      const restoreDeadline = Date.now() + Math.min(this.config.readyTimeoutMs, 10_000);
      let draft;
      for (;;) {
        draft = await composer.readDraft({ retain: false, expectEmpty: manifest.length === 0 });
        if (draft.editorText.trim() !== '' || Date.now() >= restoreDeadline) break;
        await wait(100, signal);
      }
      if (!heldDraftMatchesPending(draft.editorText, pending.promptSha256)) {
        api.tab.retainTarget = true;
        throw new BridgeError('UI_DRAFT_CONFLICT', 'The held draft does not match the pending turn; nothing was sent', {
          session, conversationId: entry.conversationId,
        });
      }
      await composer.adoptDraft(manifest.map(file => file.name), {
        expectedText: draft.editorText, timeoutMs: Math.max(this.config.readyTimeoutMs, 5_000),
      });
      if (manifest.length) {
        await settleDraft(composer, manifest, { expectedEditorText: draft.editorText }, signal);
      }
      // The editor already holds exactly this text; fill confirms it in place
      // rather than re-typing, and the click sends what the page displays.
      await composer.fillPrompt(draft.editorText);
      await composer.submit({
        beforeAttempt: async () => {
          const latest = activeBranch(await api.conversation(entry.orgId, entry.conversationId, { signal }));
          if ((latest.at(-1)?.uuid ?? ROOT_PARENT) !== pending.parentMessageId) {
            api.tab.retainTarget = true;
            throw new BridgeError('REMOTE_BRANCH_CHANGED', 'Conversation changed before native submission');
          }
        },
      });
      const { conversation: serverConversation, assistant } = await this.#waitNative(entry, api, composer, signal);
      const model = typeof serverConversation.model === 'string' && serverConversation.model !== '' ? serverConversation.model : entry.model;
      const patched = await this.#patchSession(session, {
        parentMessageId: assistant.uuid, pending: null, model, updatedAt: iso(),
      }, { lastSubmissionAt: Date.now() });
      return { entry: patched, recovered: true, resumed: true, conversation: serverConversation };
    } finally {
      await composer.dispose();
    }
  }

  #transcriptResult(entry, conv, recovered, resumed = false, discarded = false) {
    const branch = activeBranch(conv);
    const artifacts = publicArtifacts(entry.conversationId, branch);
    return {
      ok: true,
      session: entry.session,
      conversationId: entry.conversationId,
      currentLeafMessageId: conv.current_leaf_message_uuid ?? null,
      pending: entry.pending === null ? null : {
        kind: entry.pending.kind,
        parentMessageId: entry.pending.parentMessageId ?? null,
        startedAt: entry.pending.startedAt,
      },
      recovered,
      resumed,
      discarded,
      artifacts,
      messages: branch.map((m) => ({
        uuid: m.uuid,
        parentMessageId: m.parent_message_uuid,
        sender: m.sender,
        text: messageText(m),
        stopReason: typeof m.stop_reason === 'string' ? m.stop_reason : null,
        ...(m.sender === 'assistant' ? { complete: assistantCompletion(m) } : {}),
        artifacts: artifacts.filter(a => a.messageId === m.uuid),
      })),
    };
  }

  async doctor({}, { signal } = {}) {
    return boundedOperation(this.config.timeoutMs, signal, (opSignal) => this.#doctor(opSignal));
  }

  async #doctor(signal) {
    return this.withTab(this.config, async (tab) => {
      const api = new ClaudeApi(tab, this.config);
      const orgId = await api.discoverOrganization({ signal });
      return await webDoctorPayload(this.config, tab, orgId, await this.#catalog());
    }, { signal });
  }

  async #catalog() {
    return await (this.modelCatalog?.() ?? this.config.modelCatalog?.() ?? scanHostModelCatalog({
      home: this.config.home,
      env: this.config.env,
      platform: this.config.platform,
    }));
  }

  async unlock() {
    const unlocked = await this.store.unlockDeadOwner();
    return { ok: true, unlocked };
  }
}
