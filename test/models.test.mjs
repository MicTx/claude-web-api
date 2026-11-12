import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  compareClaudeModels,
  extractModels,
  latestClaudeOpus,
  modelEquivalent,
  scanHostModelCatalog,
  selectHostModel,
} from '../src/model-catalog.mjs';
import { makeTmpDir, cleanupTmpDirs } from './helpers.mjs';

after(() => cleanupTmpDirs());

async function writeConfig(path, value) {
  await fs.mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}

test('models: synthetic host schemas are merged into a sanitized catalog', async () => {
  const home = await makeTmpDir('ccw-models-');
  await writeConfig(join(home, '.claude', 'settings.json'), {
    model: 'claude-opus-5-10',
    modelPicker: { options: [{ model: 'claude-opus-5-9' }] },
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-8' },
  });
  await writeConfig(join(home, '.claude.json'), { mcpServers: {}, model: 'claude-opus-5-7' });
  await writeConfig(join(home, '.codex', 'config.toml'), 'model = "gpt-custom"\nmodel_provider = "test"\n');
  await writeConfig(join(home, '.pi', 'agent', 'settings.json'), { defaultModel: 'anthropic/claude-opus-5-10' });
  await writeConfig(join(home, '.pi', 'agent', 'models.json'), {
    providers: { anthropic: { models: [{ id: 'claude-opus-5-10', name: 'provider custom' }] } },
  });
  await writeConfig(join(home, '.deepseek', 'config.toml'), 'default_text_model = "deepseek-test"\n');
  await writeConfig(join(home, '.config', 'opencode', 'opencode.json'), { model: 'opencode-test', small_model: 'opencode-small' });
  await writeConfig(join(home, '.config', 'magpie', 'providers.json'), {
    providers: [{ models: [{ id: 'anthropic/claude-opus-5-10', description: 'private description' }] }],
  });
  await writeConfig(join(home, '.config', 'magpie', 'plugin-providers.json'), [{ models: [{ apiId: 'claude-opus-5-6' }] }]);

  const catalog = await scanHostModelCatalog({ home, env: {}, platform: 'darwin' });
  const serialized = JSON.stringify(catalog);
  assert.equal(catalog.defaultModel, 'claude-opus-5-10');
  assert.ok(catalog.models.some(model => model.hostId === 'claude' && model.id === 'claude-opus-5-10'));
  assert.ok(catalog.models.some(model => model.hostId === 'pi' && model.id === 'anthropic/claude-opus-5-10'));
  assert.ok(catalog.models.some(model => model.hostId === 'magpie' && model.normalized === 'claude-opus-5-6'));
  assert.ok(!serialized.includes('private description'));
  assert.ok(!serialized.includes(home));
});

test('models: numeric Opus versions sort naturally and latest selection respects priority', () => {
  assert.equal(compareClaudeModels('claude-opus-5.9', 'claude-opus-5.10'), -1);
  assert.equal(latestClaudeOpus(['claude-opus-5.9', 'claude-opus-5.10', 'claude-sonnet-9']), 'claude-opus-5-10');
  assert.equal(modelEquivalent('claude-opus-5-10', 'claude-opus-5-10-20261101'), true);
  assert.equal(modelEquivalent('claude-opus-5-10-thinking', 'claude-opus-5-10'), false);
  const catalog = { models: [
    { hostId: 'test', id: 'anthropic/claude-opus-5-10', normalized: 'claude-opus-5-10', series: 'opus' },
    { hostId: 'test', id: 'claude-opus-5-9', normalized: 'claude-opus-5-9', series: 'opus' },
  ] };
  assert.deepEqual(
    selectHostModel({ catalog, availableModels: ['Claude Opus 5.9', 'claude-opus-5-10'] }),
    { id: 'anthropic/claude-opus-5-10', normalized: 'claude-opus-5-10', source: 'latest-opus' },
  );
  assert.equal(selectHostModel({ explicitModel: 'claude-sonnet-9', catalog }).id, 'claude-sonnet-9');
  assert.deepEqual(
    selectHostModel({ configuredModel: 'provider/claude-opus-5.9', catalog }),
    { id: 'provider/claude-opus-5.9', normalized: 'claude-opus-5-9', source: 'configured' },
  );
  assert.deepEqual(
    selectHostModel({ explicitModel: 'claude-opus-5-10', catalog, availableModels: ['claude-opus-5-10-20261101'] }),
    { id: 'claude-opus-5-10', normalized: 'claude-opus-5-10', source: 'explicit' },
  );
  assert.throws(() => selectHostModel({ explicitModel: 'claude-opus-x', catalog, availableModels: ['claude-opus-5.9'] }), { code: 'MODEL_UNAVAILABLE' });
});

test('models: scanner is bounded and excludes unsafe model sources', async () => {
  const parent = await makeTmpDir('ccw-model-security-');
  const home = join(parent, 'cache', 'isolated-home');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await writeConfig(join(home, '.claude', 'settings.json'), { model: 'claude-opus-5-10' });
  await writeConfig(join(home, '.claude', 'cache', 'settings.json'), { model: 'claude-opus-3' });
  await writeConfig(join(home, '.claude', 'hooks', 'settings.json'), { model: 'claude-opus-2' });
  await writeConfig(join(home, '.claude', 'credentials.json'), { model: 'claude-opus-1' });
  await writeConfig(join(home, '.claude', 'deep', 'deeper', 'too-deep', 'settings.json'), { model: 'claude-opus-4' });
  await fs.writeFile(join(home, '.claude', 'large.json'), 'x'.repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
  await writeConfig(join(home, '.claude', 'models.json'), { models: [{ id: 'claude-opus-5-8' }] });
  const target = join(home, '.claude', 'settings.json');
  await fs.rm(target);
  await fs.symlink(join(home, '.claude', 'elsewhere'), target);
  const catalog = await scanHostModelCatalog({ home, env: {}, platform: 'darwin' });
  assert.deepEqual(catalog.models.map(model => model.id), ['claude-opus-5-8']);
});

test('models: extraction only trusts model-bearing fields', () => {
  const models = extractModels({
    model: 'claude-opus-5.10',
    title: 'not-a-model',
    models: [{ id: 'claude-opus-5.9', description: 'private' }, { name: 'claude-opus-5.8' }, 'claude-opus-5.6'],
    env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5.7' },
  }, 'test');
  assert.deepEqual(models.map(model => model.id), ['claude-opus-5.10', 'claude-opus-5.9', 'claude-opus-5.8', 'claude-opus-5.6', 'claude-opus-5.7']);
  assert.ok(models.every(model => !Object.hasOwn(model, 'description')));
});
