import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webStoreOf = (sessions = []) => ({ load: async () => ({ sessions }) });
const apiStoreOf = (apiSessions = []) => ({ load: async () => ({ apiSessions }) });

function fixtures({ configured = true } = {}) {
  const calls = [];
  const web = {
    ask: async (args) => { calls.push(['web.ask', args.session]); return { ok: true, reply: 'web' }; },
    followUp: async (args) => { calls.push(['web.followUp', args.session]); return { ok: true }; },
    transcript: async (args) => { calls.push(['web.transcript', args.session]); return { ok: true }; },
    download: async () => { calls.push(['web.download']); return { ok: true }; },
    resumeNativeUpload: async () => { calls.push(['web.resumeNativeUpload']); return { ok: true }; },
    doctor: async () => { calls.push(['web.doctor']); return { ok: true }; },
  };
  const api = {
    ask: async (args) => { calls.push(['api.ask', args.session]); return { ok: true, backend: 'api', reply: 'api' }; },
    followUp: async (args) => { calls.push(['api.followUp', args.session]); return { ok: true }; },
    transcript: async (args) => { calls.push(['api.transcript', args.session]); return { ok: true }; },
    bindCredential: async () => { calls.push(['api.bindCredential']); return { ok: true }; },
    profile: () => ({ configured, protocol: 'messages' }),
    credentialStatus: async () => ({ readable: configured }),
  };
  return { web, api, calls };
}

// `backend` is set after loadConfig: an api/auto config value would itself
// require a complete API profile, which these routing tests deliberately stub.
async function baseConfig(backend = 'web') {
  const home = await makeTmpDir('ccw-modes-');
  return { ...loadConfig({ HOME: home, CCW_STATE_DIR: join(home, 'state') }), backend };
}

const noProbe = (counter) => () => { counter.probes += 1; throw new Error('the web route must not be probed'); };

test('modes: explicit api overrides the configured web backend without probing', async () => {
  const config = await baseConfig('web');
  const f = fixtures();
  const counter = { probes: 0 };
  const bridge = new ConsultBridge(config, {
    mode: 'api', web: f.web, api: f.api, webStore: webStoreOf(), apiStore: apiStoreOf(), withTab: noProbe(counter),
  });
  const result = await bridge.ask({ session: 'newapi', prompt: 'hello' });
  assert.equal(result.backend, 'api');
  assert.equal(counter.probes, 0);
  assert.deepEqual(f.calls, [['api.ask', 'newapi']]);
});

test('modes: explicit api without a configured profile fails instead of falling back', async () => {
  const config = await baseConfig('web');
  const f = fixtures({ configured: false });
  const counter = { probes: 0 };
  const bridge = new ConsultBridge(config, {
    mode: 'api', web: f.web, api: f.api, webStore: webStoreOf(), apiStore: apiStoreOf(), withTab: noProbe(counter),
  });
  await assert.rejects(() => bridge.ask({ session: 'noprofile', prompt: 'x' }), { code: 'API_NOT_CONFIGURED' });
  await assert.rejects(() => bridge.doctor({}), { code: 'API_NOT_CONFIGURED' });
  assert.equal(counter.probes, 0);
  assert.deepEqual(f.calls, []);
});

test('modes: explicit web overrides a configured api backend', async () => {
  const config = await baseConfig('api');
  const f = fixtures();
  const bridge = new ConsultBridge(config, {
    mode: 'web', web: f.web, api: f.api, webStore: webStoreOf(), apiStore: apiStoreOf(),
  });
  const result = await bridge.ask({ session: 'newweb', prompt: 'x' });
  assert.equal(result.backend, 'web');
  assert.equal((await bridge.doctor({})).backend, 'web');
  assert.deepEqual(f.calls, [['web.ask', 'newweb'], ['web.doctor']]);
});

test('modes: an explicit mode refuses sessions owned by the other backend', async () => {
  const config = await baseConfig('auto');
  const f = fixtures();
  const webStore = webStoreOf([{ session: 'webowned' }]);
  const apiStore = apiStoreOf([{ session: 'apiowned' }]);
  const apiMode = new ConsultBridge(config, { mode: 'api', web: f.web, api: f.api, webStore, apiStore });
  const mismatch = (error) => error.code === 'MODE_MISMATCH'
    && error.details.backend === 'web' && error.details.requested === 'api';
  for (const call of [
    () => apiMode.ask({ session: 'webowned', prompt: 'x' }),
    () => apiMode.followUp({ session: 'webowned', prompt: 'x' }),
    () => apiMode.transcript({ session: 'webowned' }),
    () => apiMode.download({ session: 'webowned', artifact: 'a'.repeat(64) }),
    () => apiMode.resumeNativeUpload({ session: 'webowned', prompt: 'x' }),
  ]) {
    await assert.rejects(call, mismatch);
  }
  const webMode = new ConsultBridge(config, { mode: 'web', web: f.web, api: f.api, webStore, apiStore });
  await assert.rejects(() => webMode.transcript({ session: 'apiowned' }),
    (error) => error.code === 'MODE_MISMATCH' && error.details.backend === 'api' && error.details.requested === 'web');
  await assert.rejects(() => webMode.bindApiCredential({ session: 'apiowned' }), { code: 'MODE_MISMATCH' });
  assert.deepEqual(f.calls, []);
});

test('modes: a matching explicit mode and the unconfigured default still route', async () => {
  const config = await baseConfig('web');
  const f = fixtures();
  const apiMode = new ConsultBridge(config, {
    mode: 'api', web: f.web, api: f.api, webStore: webStoreOf(), apiStore: apiStoreOf([{ session: 'apiowned' }]),
  });
  await apiMode.followUp({ session: 'apiowned', prompt: 'next' });
  assert.deepEqual(f.calls, [['api.followUp', 'apiowned']]);
  f.calls.length = 0;
  const plain = new ConsultBridge(config, { web: f.web, api: f.api, webStore: webStoreOf(), apiStore: apiStoreOf() });
  await plain.ask({ session: 'plain', prompt: 'x' });
  assert.deepEqual(f.calls, [['web.ask', 'plain']]);
  assert.throws(() => new ConsultBridge(config, { mode: 'auto' }), { code: 'INVALID_ARGUMENT' });
});

test('modes: one alias serializes sends while different aliases stay concurrent', async () => {
  const config = await baseConfig('web');
  const f = fixtures();
  let release;
  let started;
  let active = 0;
  let maxActive = 0;
  const firstStarted = new Promise(resolve => { started = resolve; });
  f.web.followUp = async args => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (args.prompt === 'first') {
      started();
      await new Promise(resolve => { release = resolve; });
    }
    active -= 1;
    return { ok: true };
  };
  const bridge = new ConsultBridge(config, {
    mode: 'web', web: f.web, api: f.api,
    webStore: webStoreOf([{ session: 'shared' }, { session: 'other' }]), apiStore: apiStoreOf(),
  });
  const first = bridge.followUp({ session: 'shared', prompt: 'first' });
  await firstStarted;
  const second = bridge.followUp({ session: 'shared', prompt: 'second' });
  const other = bridge.followUp({ session: 'other', prompt: 'other' });
  await other;
  assert.equal(active, 1, 'the same alias must not enter the backend concurrently');
  release();
  await Promise.all([first, second]);
  assert.equal(maxActive, 2, 'different aliases must not be serialized together');
});

test('modes: credential rebinding waits for an in-flight send on the same alias', async () => {
  const config = await baseConfig('web');
  const f = fixtures();
  let releaseBinding;
  let bindingStarted;
  const bindingStartedPromise = new Promise(resolve => { bindingStarted = resolve; });
  f.api.bindCredential = async args => {
    f.calls.push(['api.bindCredential', args.session]);
    bindingStarted();
    await new Promise(resolve => { releaseBinding = resolve; });
    return { ok: true, backend: 'api' };
  };
  const bridge = new ConsultBridge(config, {
    mode: 'api', web: f.web, api: f.api, webStore: webStoreOf(), apiStore: apiStoreOf([{ session: 'apiowned' }]),
  });
  const binding = bridge.bindApiCredential({ session: 'apiowned' });
  await bindingStartedPromise;
  const send = bridge.followUp({ session: 'apiowned', prompt: 'must wait' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(([kind]) => kind === 'api.followUp'), false, 'the send must not enter while binding owns the alias');
  releaseBinding();
  await Promise.all([binding, send]);
  assert.deepEqual(f.calls.map(([kind]) => kind), ['api.bindCredential', 'api.followUp']);
});

function runCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'ccw.mjs'), ...args], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code, out, err }));
  });
}

test('modes: the CLI prefix selects the bridge mode before any backend work', async () => {
  const home = await makeTmpDir('ccw-modes-cli-');
  const env = { HOME: home, CCW_STATE_DIR: join(home, 'state') };
  const help = await runCli(['api'], env);
  assert.equal(help.code, 0);
  assert.ok(help.out.includes('Modes:'));
  // Without a configured API profile the forced api route must fail, not fall
  // back to the default web backend.
  const ask = await runCli(['api', 'ask', '--session', 'x', '--prompt', 'hello'], env);
  assert.equal(ask.code, 1);
  assert.equal(JSON.parse(ask.out.trim()).error.code, 'API_NOT_CONFIGURED');
  const sessions = await runCli(['sessions'], env);
  assert.equal(sessions.code, 0);
  assert.deepEqual(JSON.parse(sessions.out.trim()).sessions, []);
});
