import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { ConsultBridge } from '../src/consult-bridge.mjs';
import { loadConfig } from '../src/config.mjs';
import { normalizeWebLabel } from '../src/core/model-picker.mjs';
import { makeTmpDir, cleanupTmpDirs, ClaudeService, FakeCdpServer, fetchHandlerFor } from './helpers.mjs';
import { writeProtocolReply } from './api-protocol-fixtures.mjs';
import * as contracts from '../src/tool-contracts.mjs';

after(() => cleanupTmpDirs());

const SECRET = 'offline-model-fixture-key-not-a-real-credential';
const configured = {
  CCW_API_BASE_URL: 'https://api.example.com',
  CCW_API_MODEL: 'claude-opus-5-5',
  CCW_API_KEY: SECRET,
  CCW_BACKEND: 'api',
  CCW_CDP_URL: 'http://127.0.0.1:1',
};

const apiEntry = (session, model) => ({
  session, sessionId: '17e50c0d-769a-4219-a61b-e70a37f6630a', apiBaseUrl: 'https://api.example.com',
  model, protocol: 'messages', title: null, messages: [], lastAssistantMessageId: null,
  createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z', lastUsage: null, pending: null,
});

test('model selection: both channels accept and pin a model for new aliases', async () => {
  await withApi(async ({ home, requests, url }) => {
    const web = new ClaudeService({ model: 'claude-opus-5-9', modelOptions: ['claude-opus-5-9', 'claude-opus-5-10'] });
    const cdp = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(web), nativeService: web }).start();
    try {
      const env = isolatedApiEnv(home, cdp.cdpUrl, url);
      const bridge = new ConsultBridge(loadConfig(env), { mode: 'web', modelCatalog: async () => catalogFor(web) });
      const result = await bridge.ask({ session: 'explicit-web', prompt: 'verify explicit model', model: 'claude-opus-5-10' });
      assert.equal(result.ok, true);
      assert.equal(result.backend, 'web');
      assert.equal(result.model, 'claude-opus-5-10');
      assert.equal(web.posts('/completion')[0].body.parent_message_uuid, '00000000-0000-4000-8000-000000000000');

      const apiBridge = new ConsultBridge(loadConfig(env), { mode: 'api', modelCatalog: async () => catalogFor(web) });
      const apiResult = await apiBridge.ask({ session: 'explicit-api', prompt: 'verify explicit model', model: 'claude-opus-5-9' });
      assert.equal(apiResult.ok, true);
      assert.equal(apiResult.backend, 'api');
      assert.equal(apiResult.model, 'claude-opus-5-9');
      assert.equal(apiBridge.api.profile().model, 'claude-opus-5-5');
      assert.equal(apiBridge.api.profile().modelSelection, 'configured');
      assert.equal(requests.at(-1).body.model, 'claude-opus-5-9');

      const sessions = await bridge.sessions();
      assert.deepEqual(sessions.sessions.map(({ session, backend, model }) => ({ session, backend, model })), [
        { session: 'explicit-web', backend: 'web', model: 'claude-opus-5-10' },
        { session: 'explicit-api', backend: 'api', model: 'claude-opus-5-9' },
      ]);
      await apiBridge.followUp({ session: 'explicit-api', prompt: 'keep the pinned model' });
      assert.equal(requests.at(-1).body.model, 'claude-opus-5-9');
      const changedApi = new ConsultBridge(loadConfig({ ...env, CCW_API_MODEL: 'claude-other-1' }), {
        mode: 'api', modelCatalog: async () => catalogFor(web),
      });
      await changedApi.followUp({ session: 'explicit-api', prompt: 'keep the explicit alias after configuration changes' });
      assert.equal(requests.at(-1).body.model, 'claude-opus-5-9');
    } finally {
      await cdp.stop();
    }
  });
});

test('model selection: opens a closed menu once and leaves it closed', async () => {
  await withApi(async ({ home, url }) => {
    for (const triggerHasModelId of [true, false]) {
      const web = new ClaudeService({
        model: 'claude-opus-5-9',
        modelOptions: ['claude-opus-5-9', 'claude-opus-5-10'],
        modelPickerTriggerHasModelId: triggerHasModelId,
        keepClosedModelOptions: !triggerHasModelId,
      });
      const cdp = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(web), nativeService: web }).start();
      try {
        const env = isolatedApiEnv(home, cdp.cdpUrl, url);
        const bridge = new ConsultBridge(loadConfig(env), { mode: 'web', modelCatalog: async () => catalogFor(web) });
        const result = await bridge.ask({ session: `menu-${triggerHasModelId}`, prompt: 'switch model', model: 'claude-opus-5-10' });
        assert.equal(result.model, 'claude-opus-5-10');
        assert.equal(web.model, 'claude-opus-5-10');
        assert.equal(web.modelPickerClicks, triggerHasModelId ? 1 : 3);
        assert.equal(web.modelPickerMenuOpen, false);
      } finally {
        await cdp.stop();
      }
    }
  });
});

test('model selection: defaults use the host catalog and reject unavailable explicit models', async () => {
  await withApi(async ({ home, requests, url }) => {
    const env = isolatedApiEnv(home, null, url);
    delete env.CCW_API_MODEL;
    const catalog = {
      models: [
        { hostId: 'fixture', id: 'anthropic/claude-opus-5-9', normalized: 'claude-opus-5-9', series: 'opus' },
        { hostId: 'fixture', id: 'claude-opus-5-10', normalized: 'claude-opus-5-10', series: 'opus' },
        { hostId: 'fixture', id: 'claude-sonnet-9', normalized: 'claude-sonnet-9', series: 'sonnet' },
      ],
      defaultModel: 'claude-opus-5-10',
    };
    const bridge = new ConsultBridge(loadConfig(env), { mode: 'api', modelCatalog: async () => catalog });
    const result = await bridge.ask({ session: 'dynamic-api', prompt: 'verify dynamic model' });
    assert.equal(result.model, 'claude-opus-5-10');
    assert.equal(requests.at(-1).body.model, 'claude-opus-5-10');
    await assert.rejects(() => bridge.ask({ session: 'bad-api', prompt: 'bad model', model: 'claude-opus-unknown' }), { code: 'MODEL_UNAVAILABLE' });
  });
});

test('model selection: doctor exposes host, webpage and default evidence', async () => {
  await withApi(async ({ home, url }) => {
    const web = new ClaudeService({ model: 'claude-opus-5-9', modelOptions: ['claude-opus-5-9', 'claude-opus-5-10'] });
    const cdp = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(web), nativeService: web }).start();
    try {
      const env = isolatedApiEnv(home, cdp.cdpUrl, url);
      const result = await new ConsultBridge(loadConfig(env), {
        mode: 'web', modelCatalog: async () => catalogFor(web),
      }).doctor({});
      assert.equal(result.backend, 'web');
      assert.equal(result.model.catalog.length, 2);
      assert.equal(result.model.webpage.selected, 'claude-opus-5-9');
      assert.deepEqual(result.model.webpage.available, ['claude-opus-5-9', 'claude-opus-5-10']);
      assert.equal(result.model.selection, 'claude-opus-5-10');
    } finally {
      await cdp.stop();
    }
  });
});

test('model selection: picker waits for the model trigger to mount', async () => {
  await withApi(async ({ home, url }) => {
    const web = new ClaudeService({ model: 'claude-opus-5-9', modelOptions: ['claude-opus-5-9', 'claude-opus-5-10'] });
    const cdp = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(web), nativeService: web }).start();
    try {
      const env = isolatedApiEnv(home, cdp.cdpUrl, url);
      const bridge = new ConsultBridge(loadConfig(env), { mode: 'web', modelCatalog: async () => catalogFor(web) });
      const result = await bridge.doctor({});
      assert.equal(result.model.webpage.selected, 'claude-opus-5-9');
    } finally {
      await cdp.stop();
    }
  });
});

function catalogFor(service) {
  const ids = [...new Set([...(service.modelOptions ?? []), service.model])];
  return {
    models: ids.map(id => ({ hostId: 'fixture', id, normalized: id.toLowerCase(), series: id.includes('opus') ? 'opus' : null })),
    defaultModel: 'claude-opus-5-10',
  };
}

test('model selection: MCP schema keeps model only on claude_ask', () => {
  const ask = contracts.TOOLS.find(tool => tool.name === 'claude_ask');
  const followUp = contracts.TOOLS.find(tool => tool.name === 'claude_follow_up');
  assert.equal(ask.inputSchema.properties.model.pattern, '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$');
  assert.equal(Object.hasOwn(followUp.inputSchema.properties, 'model'), false);
});

test('model selection: webpage labels normalize bounded model identities', () => {
  assert.equal(normalizeWebLabel('Claude Opus 5.9'), 'claude-opus-5-9');
  assert.equal(normalizeWebLabel('5.9 Opus\nCurrent model'), 'claude-opus-5-9');
  assert.equal(normalizeWebLabel('Claude Opus 5.10 (20261101)'), 'claude-opus-5-10-20261101');
  assert.equal(normalizeWebLabel('claude-opus-5.10'), 'claude-opus-5-10');
  assert.equal(normalizeWebLabel('Claude Opus 5.10 Thinking'), 'claude-opus-5-10-thinking');
  assert.equal(normalizeWebLabel('Provider / Claude Sonnet 4.5'), 'claude-sonnet-4-5');
  assert.equal(normalizeWebLabel('Settings and plan'), null);
});

test('model selection: legacy API aliases keep their stored model', async () => {
  const { ApiStore } = await import('../src/api-store.mjs');
  const home = await makeTmpDir('ccw-model-selection-legacy-');
  try {
    const store = new ApiStore(join(home, 'state'));
    await store.save({ version: 1, apiSessions: [apiEntry('legacy', 'legacy-provider-model')] });
    const env = isolatedApiEnv(home, null);
    const bridge = new ConsultBridge(loadConfig(env), { mode: 'api' });
    const sessions = await bridge.sessions();
    assert.equal(sessions.sessions[0].model, 'legacy-provider-model');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

function isolatedApiEnv(home, cdpUrl, apiUrl) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCW_'))),
    HOME: home,
    CCW_STATE_DIR: join(home, 'state'),
    ...configured,
    ...(apiUrl ? { CCW_API_BASE_URL: apiUrl } : {}),
    ...(cdpUrl ? { CCW_CDP_URL: cdpUrl } : {}),
  };
}

async function withApi(fn) {
  const home = await makeTmpDir('ccw-model-selection-');
  const requests = [];
  const { createServer } = await import('node:http');
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    writeProtocolReply(res, 'messages', {
      id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: requests.at(-1).body.model,
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    return await fn({ home, requests, url: `http://127.0.0.1:${http.address().port}` });
  } finally {
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
}
