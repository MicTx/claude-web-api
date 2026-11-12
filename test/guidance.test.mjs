import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { applyGuidanceBlock } from '../src/guidance.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT, TOOLS } from '../src/tool-contracts.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());

const webStoreOf = (sessions = []) => ({ load: async () => ({ sessions }) });
const apiStoreOf = (apiSessions = []) => ({ load: async () => ({ apiSessions }) });

async function config(backend = 'web') {
  const home = await makeTmpDir('ccw-guidance-');
  return { ...loadConfig({ HOME: home, CCW_STATE_DIR: join(home, 'state') }), backend };
}

function fixtures() {
  const calls = [];
  const web = {
    ask: async (args) => { calls.push(['web.ask', args]); return { ok: true, reply: 'web' }; },
    followUp: async (args) => { calls.push(['web.followUp', args]); return { ok: true }; },
    resumeNativeUpload: async (args) => { calls.push(['web.resumeNativeUpload', args]); return { ok: true }; },
  };
  const api = {
    ask: async (args) => { calls.push(['api.ask', args]); return { ok: true, backend: 'api' }; },
    followUp: async (args) => { calls.push(['api.followUp', args]); return { ok: true }; },
    profile: () => ({ configured: true, protocol: 'messages' }),
    credentialStatus: async () => ({ readable: true }),
  };
  return { web, api, calls };
}

function bridgeWith(cfg, f, { webStore = webStoreOf(), apiStore = apiStoreOf() } = {}) {
  return new ConsultBridge(cfg, { mode: cfg.backend === 'api' ? 'api' : 'web', web: f.web, api: f.api, webStore, apiStore });
}

test('guidance: default leaves the prompt byte-for-byte unchanged', async () => {
  const cfg = await config();
  const f = fixtures();
  const result = await bridgeWith(cfg, f).ask({ session: 'default', prompt: '原始请求\r\n保持原样' });
  assert.equal(f.calls[0][1].prompt, '原始请求\r\n保持原样');
  assert.equal(result.guidanceAppended, false);
});

test('guidance: true appends the fixed block exactly once through the web route', async () => {
  const cfg = await config();
  const f = fixtures();
  const result = await bridgeWith(cfg, f).ask({ session: 'guided', prompt: '原始请求', guidance: true });
  const sent = f.calls[0][1].prompt;
  assert.ok(sent.startsWith('原始请求\n\n'));
  assert.equal(sent.split(EXECUTABLE_GUIDANCE_CONTRACT).length, 2);
  assert.equal(result.guidanceAppended, true);
});

test('guidance: an existing marker is never duplicated or replaced', async () => {
  const prompts = [
    `问题\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`,
    '问题\n\n【可执行指导要求 v2】\n1. 旧版要求\n【可执行指导要求结束】',
  ];
  for (const [index, prompt] of prompts.entries()) {
    const cfg = await config();
    const f = fixtures();
    const result = await bridgeWith(cfg, f).ask({ session: `present-${index}`, prompt, guidance: true });
    assert.equal(f.calls[0][1].prompt, prompt);
    assert.equal(result.guidanceAppended, false);
  }
});

test('guidance: the api route receives the same canonical prompt', async () => {
  const cfg = await config('api');
  const f = fixtures();
  const result = await bridgeWith(cfg, f).ask({ session: 'guided-api', prompt: '纯文本问题', guidance: true });
  assert.equal(f.calls[0][0], 'api.ask');
  assert.equal(f.calls[0][1].prompt, `纯文本问题\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`);
  assert.equal(result.guidanceAppended, true);
  assert.equal(result.backend, 'api');
});

test('guidance: follow-up and native-resume use the same canonical text', async () => {
  const cfg = await config();
  const f = fixtures();
  const webStore = webStoreOf([{ session: 'existing' }, { session: 'draft' }]);
  const bridge = bridgeWith(cfg, f, { webStore });
  const followed = await bridge.followUp({ session: 'existing', prompt: '新证据', guidance: true });
  assert.equal(f.calls[0][1].prompt, `新证据\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`);
  assert.equal(followed.guidanceAppended, true);
  const resumed = await bridge.resumeNativeUpload({ session: 'draft', prompt: '恢复草稿', guidance: true });
  assert.equal(f.calls[1][1].prompt, `恢复草稿\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`);
  assert.equal(resumed.guidanceAppended, true);
});

test('guidance: appended text obeys the 64KiB limit and nothing is sent', async () => {
  const cfg = await config();
  const f = fixtures();
  await assert.rejects(() => bridgeWith(cfg, f).ask({ session: 'oversized', prompt: 'x'.repeat(65000), guidance: true }),
    { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(f.calls, []);
});

test('guidance: a non-boolean value is rejected before any routing', async () => {
  const cfg = await config();
  const f = fixtures();
  await assert.rejects(() => bridgeWith(cfg, f).ask({ session: 'bad', prompt: 'x', guidance: 'yes' }),
    { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(f.calls, []);
});

test('guidance: invalid original prompts are rejected before routing on both backends', async () => {
  for (const backend of ['web', 'api']) {
    const cfg = await config(backend);
    const f = fixtures();
    const bridge = bridgeWith(cfg, f, backend === 'web'
      ? { webStore: webStoreOf([{ session: 'existing' }]) }
      : { apiStore: apiStoreOf([{ session: 'existing' }]) });
    for (const prompt of ['', ' \t\r\n', null, undefined, 42, {}]) {
      for (const method of ['ask', 'followUp', 'resumeNativeUpload']) {
        await assert.rejects(() => bridge[method]({ session: 'existing', prompt, guidance: true }),
          { code: 'INVALID_ARGUMENT' }, `${backend}:${method}:${String(prompt)}`);
      }
    }
    assert.deepEqual(f.calls, [], `${backend} must not dispatch an invalid prompt`);
  }
});

test('guidance: malformed Unicode is rejected before any routing', async () => {
  for (const backend of ['web', 'api']) {
    const cfg = await config(backend);
    const f = fixtures();
    const bridge = bridgeWith(cfg, f, backend === 'web'
      ? { webStore: webStoreOf([{ session: 'existing' }]) }
      : { apiStore: apiStoreOf([{ session: 'existing' }]) });
    for (const prompt of ['x\ud800y', 'x\udc00y', '\ud800\ud800', '\udc00\udc00']) {
      for (const method of ['ask', 'followUp', 'resumeNativeUpload']) {
        await assert.rejects(() => bridge[method]({ session: 'existing', prompt, guidance: true }),
          { code: 'INVALID_ARGUMENT' }, `${backend}:${method}`);
      }
    }
    assert.deepEqual(f.calls, []);
  }
});

test('guidance: valid emoji remains byte-for-byte intact', async () => {
  const cfg = await config();
  const f = fixtures();
  const prompt = '核对 👩‍💻 与中文';
  const result = await bridgeWith(cfg, f).ask({ session: 'unicode-valid', prompt, guidance: true });
  assert.equal(result.guidanceAppended, true);
  assert.equal(f.calls[0][1].prompt, `${prompt}\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`);
});

test('guidance: the helper treats any version marker as present', () => {
  assert.deepEqual(applyGuidanceBlock('q', false), { prompt: 'q', appended: false });
  assert.deepEqual(applyGuidanceBlock('q', true), { prompt: `q\n\n${EXECUTABLE_GUIDANCE_CONTRACT}`, appended: true });
  const legacy = 'q\n【可执行指导要求 v2】\n【可执行指导要求结束】';
  assert.deepEqual(applyGuidanceBlock(legacy, true), { prompt: legacy, appended: false });
});

test('guidance: both send schemas expose an opt-in boolean', () => {
  for (const name of ['claude_ask', 'claude_follow_up']) {
    const property = TOOLS.find(tool => tool.name === name).inputSchema.properties.guidance;
    assert.equal(property.type, 'boolean');
    assert.equal(property.default, false);
  }
});

test('guidance: an existing marker suppresses append but never proves the block is complete', () => {
  const incomplete = '资料中提到了【可执行指导要求 v3】，但没有正文';
  assert.deepEqual(applyGuidanceBlock(incomplete, true), { prompt: incomplete, appended: false });
});
