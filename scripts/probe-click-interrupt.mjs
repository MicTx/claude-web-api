#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { ClaudeBridge } from '../src/bridge.mjs';
import { SessionStore, ALIAS_RE } from '../src/session-store.mjs';
import { withClaudeTab } from '../src/core/tab.mjs';
import { ROOT_PARENT } from '../src/core/claude-api.mjs';
import { normalizeWebPrompt } from '../src/core/ui.mjs';
import { BridgeError } from '../src/core/errors.mjs';
import { configPath } from '../src/identity.mjs';
import { isMainModule } from '../src/is-main.mjs';

export const FIXED_PROMPT = 'click boundary held-draft probe: reply with exactly ok';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SESSION_RE = /^click-boundary-[0-9a-f]{8}$/;

export function isSubmitEvaluate(method, params) {
  return method === 'Runtime.evaluate'
    && typeof params?.expression === 'string'
    && params.expression.includes('"action":"submit"');
}

function refuse(error) {
  const code = error instanceof BridgeError ? error.code : 'PROBE_FAILED';
  console.error(JSON.stringify({ ok: false, error: { code, message: error.message } }));
  process.exitCode = 1;
}

async function assertPrivateDir(path, label) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw new BridgeError('LIVE_GUARD', `${label} does not exist`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new BridgeError('LIVE_GUARD', `${label} must be a private, owned, non-symlink directory`);
  }
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new BridgeError('LIVE_GUARD', `Refusing to reuse an existing ${path}`);
}

async function assertEmptyDir(path) {
  const entries = await readdir(path);
  if (entries.length) throw new BridgeError('LIVE_GUARD', `${path} must be empty before a live probe`);
}

function assertStateDir(raw) {
  if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) {
    throw new BridgeError('LIVE_GUARD', '--state-dir must be an absolute path');
  }
  return raw;
}

function assertSession(raw) {
  if (typeof raw !== 'string' || !SESSION_RE.test(raw) || !ALIAS_RE.test(raw)) {
    throw new BridgeError('LIVE_GUARD', '--session must be click-boundary-<8 lowercase hex>');
  }
  return raw;
}

function assertCdpUrl(raw) {
  if (typeof raw !== 'string') throw new BridgeError('LIVE_GUARD', '--cdp-url is required with --live');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeError('LIVE_GUARD', '--cdp-url must be a valid URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.port === ''
    || url.username !== '' || url.password !== ''
    || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new BridgeError('LIVE_GUARD', '--cdp-url must be an explicit loopback HTTP endpoint without credentials, path, query or fragment');
  }
  return raw;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: {
        live: { type: 'boolean' },
        'state-dir': { type: 'string' },
        session: { type: 'string' },
        'cdp-url': { type: 'string' },
      },
    });
    if (!values.live) {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: '--live required' }));
      return;
    }
    const stateDir = assertStateDir(values['state-dir']);
    const session = assertSession(values.session);
    const cdpUrl = assertCdpUrl(values['cdp-url']);
    await assertPrivateDir(stateDir, 'state directory');
    const home = dirname(stateDir);
    await assertPrivateDir(home, 'home');
    await assertAbsent(configPath(home));
    await assertEmptyDir(stateDir);
    await assertAbsent(join(stateDir, 'sessions.json'));
    await assertAbsent(join(stateDir, 'api-sessions.json'));

    const env = {
      HOME: home, CCW_STATE_DIR: stateDir, CCW_CDP_URL: cdpUrl, CCW_BACKEND: 'web',
    };
    const config = loadConfig(env);
    config.discoverBrowser = async () => config.cdpUrl;
    const canonical = normalizeWebPrompt(FIXED_PROMPT);
    const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
    let intercepted = 0;
    const withTab = (cfg, fn, options) => withClaudeTab(cfg, async (tab) => {
      const send = tab.client.send.bind(tab.client);
      tab.client.send = (method, params, opts) => {
        if (isSubmitEvaluate(method, params)) {
          intercepted += 1;
          return Promise.reject(new BridgeError('SUBMIT_INTERRUPTED', 'Intercepted before submit evaluate; no click was sent'));
        }
        return send(method, params, opts);
      };
      return fn(tab);
    }, options);
    const bridge = new ClaudeBridge(config, {
      withTab,
      modelCatalog: () => ({ models: [], defaultModel: null }),
    });
    let stageError;
    try {
      await bridge.ask({ session, prompt: FIXED_PROMPT, native: true });
    } catch (error) {
      stageError = error;
    }
    const details = stageError?.details ?? {};
    if (!(stageError instanceof BridgeError) || stageError.code !== 'SUBMIT_INTERRUPTED'
      || intercepted !== 1 || details.pending !== true || details.session !== session
      || typeof details.conversationId !== 'string'
      || typeof details.browserCleanup?.targetId !== 'string') {
      throw new BridgeError('PROBE_FAILED', 'The real send did not stop exactly once before the submit evaluate', {
        intercepted, code: stageError?.code ?? null, details,
      });
    }
    const state = await new SessionStore(config.stateDir).load();
    const entry = state.sessions[0];
    if (state.version !== 2 || state.sessions.length !== 1 || entry?.session !== session
      || entry.conversationId !== details.conversationId
      || entry.pending?.kind !== 'send' || entry.pending.transport !== 'native'
      || entry.pending.parentMessageId !== ROOT_PARENT
      || entry.pending.promptSha256 !== digest
      || !Array.isArray(entry.pending.attachments) || entry.pending.attachments.length !== 0) {
      throw new BridgeError('PROBE_FAILED', 'The staged state is not the expected native send pending', { session });
    }
    await assertAbsent(join(config.stateDir, 'api-sessions.json'));
    console.log(JSON.stringify({
      ok: true, staged: true, session, conversationId: entry.conversationId,
      promptSha256: digest, interceptedCount: intercepted,
      interceptedAt: 'before-submit-evaluate', pending: 'send',
      heldTabTargetId: details.browserCleanup.targetId,
    }));
  } catch (error) {
    refuse(error);
  }
}

if (isMainModule(import.meta.url)) await main();
