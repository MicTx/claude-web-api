import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { BridgeError } from './core/errors.mjs';
import { resolveTargets } from './install/hosts.mjs';

export const MAX_MODEL_SCAN_DEPTH = 3;
export const MAX_MODEL_FILES_PER_HOST = 64;
export const MAX_MODEL_FILE_BYTES = 2 * 1024 * 1024;

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ALLOWED_BASENAMES = new Set([
  'config.toml', 'settings.json', 'models.json', 'models-store.json', 'opencode.json',
  '.claude.json', 'providers.json', 'plugin-providers.json',
]);
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', '.git', 'cache', 'caches', 'history', 'histories', 'backup', 'backups',
  'hooks', 'credentials', 'credential', 'secrets', 'secret', 'cookies', 'sessions',
  'session-storage', 'local-storage', 'databases',
]);
const DIRECT_MODEL_KEYS = new Set([
  'model', 'apiModel', 'defaultModel', 'default_text_model', 'small_model',
]);
const ENV_MODEL_KEYS = new Set([
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]);
const MODEL_LIST_KEYS = new Set(['models', 'options']);
const MODEL_ITEM_KEYS = new Set(['id', 'model', 'apiId']);

function validModelId(value) {
  return typeof value === 'string' && MODEL_ID_RE.test(value);
}

export function normalizeModelId(value) {
  if (!validModelId(value)) return null;
  const segments = value.split('/');
  const claudeIndex = segments.findIndex(segment => /^claude(?:[-_.]|$)/i.test(segment));
  return (claudeIndex === -1 ? segments : segments.slice(claudeIndex)).join('/')
    .toLowerCase()
    .replace(/\./g, '-');
}

// A webpage label identifies the model family while the conversation readback
// may append the provider's dated snapshot. Treat only that date suffix as the
// same pinned identity; arbitrary variants such as "thinking" still differ.
export function modelEquivalent(left, right) {
  const first = normalizeModelId(left);
  const second = normalizeModelId(right);
  if (!first || !second) return false;
  if (first === second) return true;
  const dated = (base, candidate) => candidate.startsWith(`${base}-`)
    && /^\d{8}$/.test(candidate.slice(base.length + 1));
  return dated(first, second) || dated(second, first);
}

function addModel(models, hostId, id) {
  const normalized = normalizeModelId(id);
  if (!normalized) return;
  const key = `${hostId}\0${id}`;
  if (!models.some(model => model.key === key)) {
    models.push({ key, hostId, id, normalized, series: claudeSeries(normalized) });
  }
}

function extractFrom(value, hostId, models, inModelList = false, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (inModelList && validModelId(item)) addModel(models, hostId, item);
      else extractFrom(item, hostId, models, inModelList, depth + 1);
    }
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (DIRECT_MODEL_KEYS.has(key) || ENV_MODEL_KEYS.has(key)) {
      if (validModelId(child)) addModel(models, hostId, child);
    } else if (MODEL_LIST_KEYS.has(key) && Array.isArray(child)) {
      extractFrom(child, hostId, models, true, depth + 1);
    } else if (inModelList && MODEL_ITEM_KEYS.has(key) && validModelId(child)) {
      addModel(models, hostId, child);
    } else if (key === 'name' && inModelList && validModelId(child)) {
      addModel(models, hostId, child);
    } else {
      extractFrom(child, hostId, models, false, depth + 1);
    }
  }
}

export function extractModels(document, hostId) {
  const models = [];
  extractFrom(document, hostId, models);
  return models;
}

function excluded(name) {
  return EXCLUDED_SEGMENTS.has(name.toLowerCase());
}

async function candidateFiles(root, exact, io) {
  const files = [];
  if (exact && files.length < MAX_MODEL_FILES_PER_HOST) files.push({ path: exact, depth: 0 });
  async function walk(dir, depth) {
    if (depth > MAX_MODEL_SCAN_DEPTH || files.length >= MAX_MODEL_FILES_PER_HOST) return;
    let entries;
    try {
      entries = await io.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (files.length >= MAX_MODEL_FILES_PER_HOST) return;
      const path = join(dir, entry.name);
      if (excluded(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) await walk(path, depth + 1);
        continue;
      }
      if (depth + 1 > MAX_MODEL_SCAN_DEPTH) continue;
      if (entry.isFile() && ALLOWED_BASENAMES.has(basename(path))) files.push({ path, depth: depth + 1 });
    }
  }
  await walk(root, 0);
  return files.slice(0, MAX_MODEL_FILES_PER_HOST);
}

async function readModelFile(path, io) {
  let handle;
  try {
    const initial = await io.lstat(path, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > BigInt(MAX_MODEL_FILE_BYTES)
      || (process.getuid && initial.uid !== BigInt(process.getuid()))) return null;
    handle = await io.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat({ bigint: true });
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await io.lstat(path, { bigint: true });
    if (size !== Number(before.size)
      || [initial, after, named].some(stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => String(stat[field]) !== String(before[field])))) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } catch {
    return null;
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

export function claudeSeries(model) {
  const normalized = normalizeModelId(model);
  if (!normalized) return null;
  return normalized.match(/^claude-(opus|sonnet|haiku)(?:-[a-z0-9.-]+)?$/i)?.[1]?.toLowerCase() ?? null;
}

function versionParts(model) {
  const tail = model.replace(/^claude-(?:opus|sonnet|haiku)-/i, '');
  return tail.split(/[.-]/).map(part => /^\d+$/.test(part) ? Number(part) : part).filter(part => part !== '');
}

export function compareClaudeModels(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const first = left[index];
    const second = right[index];
    if (first === undefined) return -1;
    if (second === undefined) return 1;
    if (first === second) continue;
    if (typeof first === 'number' && typeof second === 'number') return first - second;
    return String(first).localeCompare(String(second), 'en');
  }
  return a.localeCompare(b, 'en');
}

export function latestClaudeOpus(models) {
  const unique = new Map();
  for (const model of models) {
    if (typeof model === 'string') {
      const normalized = normalizeModelId(model);
      if (normalized && claudeSeries(normalized) === 'opus' && !unique.has(normalized)) unique.set(normalized, model);
    } else if (model?.normalized && model.series === 'opus' && !unique.has(model.normalized)) {
      unique.set(model.normalized, model.id);
    }
  }
  const best = [...unique.entries()].sort((a, b) => compareClaudeModels(b[0], a[0])).at(0);
  return best?.[0] ?? null;
}

export async function scanHostModelCatalog({
  home,
  env = process.env,
  platform = process.platform,
  stateDir = '/tmp',
  overrides = {},
  io = fs,
} = {}) {
  if (typeof home !== 'string' || home.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'home must be a non-empty path');
  if (!env || typeof env !== 'object') throw new BridgeError('INVALID_ARGUMENT', 'env must be an object');
  const models = [];
  const roots = [
    ...resolveTargets({ home, env, platform, stateDir, overrides }).map(({ host, target }) => ({
      id: host.id,
      root: target.homeDir,
      exact: target.configPath,
    })),
    { id: 'magpie', root: join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'magpie'), exact: null },
  ];
  for (const root of roots) {
    try {
      const stat = await io.lstat(root.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const seen = new Set();
    for (const file of await candidateFiles(root.root, root.exact, io)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const text = await readModelFile(file.path, io);
      if (text === null || text.trim() === '') continue;
      let document;
      try {
        document = file.path.endsWith('.toml') ? parseToml(text) : JSON.parse(text);
      } catch {
        continue;
      }
      for (const model of extractModels(document, root.id)) addModel(models, root.id, model.id);
    }
  }
  const publicModels = [...new Map(models.map(model => [`${model.hostId}\0${model.id}`, model])).values()]
    .map(({ hostId, id, normalized, series }) => ({ hostId, id, normalized, series }))
    .sort((a, b) => a.hostId.localeCompare(b.hostId, 'en') || a.id.localeCompare(b.id, 'en'));
  return {
    models: publicModels,
    defaultModel: latestClaudeOpus(publicModels),
  };
}

export function checkRequestedModel(value) {
  if (!validModelId(value)) {
    throw new BridgeError('INVALID_ARGUMENT', 'model must be a bounded model identifier');
  }
  return value;
}

export function selectHostModel({ explicitModel, configuredModel, catalog, availableModels = null }) {
  if (explicitModel !== undefined && explicitModel !== null) {
    const requested = checkRequestedModel(explicitModel);
    const normalized = normalizeModelId(requested);
    if (availableModels && !availableModels.some(model => modelEquivalent(model, normalized))) {
      throw new BridgeError('MODEL_UNAVAILABLE', 'The requested model is not present in the verified webpage model catalog');
    }
    return { id: requested, normalized, source: 'explicit' };
  }
  if (configuredModel) {
    const normalized = normalizeModelId(configuredModel);
    if (availableModels && !availableModels.some(model => modelEquivalent(model, normalized))) {
      throw new BridgeError('MODEL_UNAVAILABLE', 'The configured model is not present in the verified webpage model catalog');
    }
    return { id: configuredModel, normalized, source: 'configured' };
  }
  const available = availableModels === null
    ? catalog.models
    : catalog.models.filter(model => availableModels.some(candidate => modelEquivalent(candidate, model.normalized)));
  const normalized = latestClaudeOpus(available) ?? (availableModels === null ? null : latestClaudeOpus(availableModels));
  if (!normalized) throw new BridgeError('MODEL_UNAVAILABLE', 'No Claude Opus model is available in the host or verified webpage catalog');
  const original = available.find(model => modelEquivalent(model.normalized, normalized))?.id ?? normalized;
  return { id: original, normalized, source: 'latest-opus' };
}
