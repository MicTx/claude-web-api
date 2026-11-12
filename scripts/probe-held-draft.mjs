#!/usr/bin/env node
// Operator-invoked live diagnostic: stage the exact pending prompt into the
// conversation composer, then let `transcript --recover` verify and submit it.
// The pending marker must already exist (a send interrupted before the click);
// this tool only reproduces the held-draft state and never types a new prompt.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { SessionStore } from '../src/session-store.mjs';
import { withClaudeTab } from '../src/core/tab.mjs';
import { normalizeWebPrompt } from '../src/core/ui.mjs';
import { BridgeError } from '../src/core/errors.mjs';

function usage() {
  console.error('usage: node scripts/probe-held-draft.mjs --session NAME --file PROMPT_TXT [--recover]');
  process.exit(2);
}
const { values: args } = parseArgs({
  args: process.argv.slice(2), strict: true, allowPositionals: false,
  options: { session: { type: 'string' }, file: { type: 'string' }, recover: { type: 'boolean' } },
});
const { session, file, recover = false } = args;
if (!session || !file) usage();

function refuse(error) {
  const code = error instanceof BridgeError ? error.code : 'PROBE_FAILED';
  console.error(JSON.stringify({ ok: false, error: { code, message: error.message } }));
  process.exitCode = 1;
}

try {
  const config = loadConfig();
  const store = new SessionStore(config.stateDir);
  const state = await store.load();
  const entry = state.sessions.find((item) => item.session === session);
  if (!entry) throw new BridgeError('SESSION_NOT_FOUND', `Session "${session}" does not exist`);
  if (entry.pending?.kind !== 'send' || entry.pending.transport !== 'native') {
    throw new BridgeError('PENDING_TURN', 'probe-held-draft requires a native send pending');
  }
  const prompt = normalizeWebPrompt(await readFile(file, 'utf8'));
  const digest = createHash('sha256').update(prompt, 'utf8').digest('hex');
  if (digest !== entry.pending.promptSha256) {
    throw new BridgeError('PROMPT_MISMATCH', 'The supplied prompt does not match the pending turn; nothing was typed');
  }

  await withClaudeTab(config, async (tab) => {
  await tab.navigateConversation(entry.conversationId, {});
  // the composer mounts asynchronously after navigation; wait for it before typing
  const deadline = Date.now() + config.readyTimeoutMs;
  for (;;) {
    const mounted = await tab.evaluate(`Boolean(document.querySelector('[data-testid="chat-input"][contenteditable="true"]'))`, {});
    if (mounted) break;
    if (Date.now() >= deadline) throw new BridgeError('UI_NOT_READY', 'The composer did not mount');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const result = await tab.evaluate(`(() => {
    const editor = document.querySelector('[data-testid="chat-input"][contenteditable="true"]');
    if (!editor) return { ok: false, code: 'UI_CONTRACT' };
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('delete')) return { ok: false, code: 'UI_CONTRACT' };
    if (!document.execCommand('insertText', false, ${JSON.stringify(prompt)})) return { ok: false, code: 'UI_CONTRACT' };
    return { ok: true, text: editor.innerText };
  })()`, {});
  if (!result?.ok) throw new BridgeError(result?.code ?? 'UI_CONTRACT', 'Could not stage the held draft');
    // The next recover opens a fresh tab, so the page must have persisted the
    // draft to IndexedDB before this one closes. Keep each evaluate short: a
    // single long poll can hit the CDP timeout.
    const readOnce = `(() => new Promise((resolve) => {
      const key = ${JSON.stringify(`store:chat-draft:${entry.conversationId}`)};
      const req = indexedDB.open('keyval-store');
      req.onerror = () => resolve({ ok: false });
      req.onsuccess = () => {
        const db = req.result;
        const get = db.transaction('keyval', 'readonly').objectStore('keyval').get(key);
        get.onerror = () => { db.close(); resolve({ ok: false }); };
        get.onsuccess = () => {
          db.close();
          const doc = get.result?.state?.tipTapEditorState;
          const texts = (node, out = []) => {
            if (!node || typeof node !== 'object') return out;
            if (typeof node.text === 'string') out.push(node.text);
            for (const child of node.content ?? []) texts(child, out);
            return out;
          };
          resolve({ ok: true, text: doc ? texts(doc).join('\\n\\n') : null });
        };
      };
    }))()`;
    const persistDeadline = Date.now() + Math.min(config.readyTimeoutMs, 10_000);
    let persisted = false;
    for (;;) {
      const snapshot = await tab.evaluate(readOnce, {});
      if (snapshot?.ok && (snapshot.text === prompt || snapshot.text === prompt.replaceAll('\n', '\n\n'))) {
        persisted = true;
        break;
      }
      if (Date.now() >= persistDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!persisted) throw new BridgeError('UI_DRAFT_UNAVAILABLE', 'The staged draft did not persist to IndexedDB');
    console.log(JSON.stringify({ ok: true, staged: true, session, text: result.text }));
  }, {});

  if (recover) {
    const bridge = new ConsultBridge(config, { mode: 'web' });
    const result = await bridge.transcript({ session, recover: true });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  refuse(error);
}
