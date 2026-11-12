import { BridgeError } from './errors.mjs';
import { modelEquivalent, normalizeModelId, selectHostModel } from '../model-catalog.mjs';

async function pageModelPicker(args) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (location.origin !== 'https://claude.ai') {
    return fail('UI_CONTEXT_LOST', 'The owned page is not on the Claude origin');
  }
  const text = element => [
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.innerText,
  ].filter(value => typeof value === 'string' && value.trim()).join(' ').trim();
  const triggers = () => [...document.querySelectorAll('button[data-testid="model-selector-dropdown"]')]
    .filter(button => button.getAttribute('aria-haspopup') !== null || button.getAttribute('aria-expanded') !== null);
  const options = () => [...document.querySelectorAll('[role="menuitemradio"][data-model-id]')]
    .filter(option => option.getAttribute('aria-disabled') !== 'true' && option.disabled !== true)
    .map(option => ({
      text: text(option),
      modelId: option.getAttribute('data-model-id'),
      selected: option.getAttribute('aria-checked') === 'true',
      element: option,
    }))
    .filter(option => option.modelId);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const expanded = trigger => trigger.getAttribute('aria-expanded') === 'true';
  const menuOpen = expanded;
  return (async () => {
    const end = Date.now() + args.timeoutMs;
    const closeMenu = async trigger => {
      if (!menuOpen(trigger)) return true;
      trigger.click();
      for (;;) {
        if (!menuOpen(trigger)) return true;
        if (Date.now() >= end) return false;
        await delay(Math.min(100, end - Date.now()));
      }
    };
    if (args.action === 'close') {
      const closeTrigger = triggers()[0];
      if (!closeTrigger) return { ok: true, ready: false };
      if (!await closeMenu(closeTrigger)) return fail('UI_NOT_READY', 'The model menu did not close');
      return { ok: true, ready: true };
    }
    let trigger = triggers()[0];
    while (!trigger) {
      if (Date.now() >= end) return { ok: true, ready: false };
      await delay(Math.min(100, end - Date.now()));
      trigger = triggers()[0];
    }
    if (!menuOpen(trigger)) {
      trigger.click();
      for (;;) {
        if (menuOpen(trigger) && options().length) break;
        if (Date.now() >= end) return { ok: true, ready: false };
        await delay(Math.min(100, end - Date.now()));
      }
    }
    let current = options();
    for (;;) {
      if (current.length) break;
      if (Date.now() >= end) return { ok: true, ready: false };
      await delay(Math.min(100, end - Date.now()));
      current = options();
    }
    if (args.action === 'select') {
      const target = current.find(option => [...args.matchModelIds].includes(option.modelId));
      if (!target) return fail('UI_CONTRACT', 'The requested model disappeared from the accessible menu');
      target.element?.click?.();
    }
    let verifiedModelId = null;
    for (;;) {
      current = options();
      const selected = current.find(option => option.selected);
      const triggerModelId = trigger.getAttribute('data-model-id');
      if (selected) {
        if (args.action !== 'select' || [...args.matchModelIds].includes(selected.modelId)) {
          verifiedModelId = selected.modelId;
          break;
        }
      } else if (args.action === 'select' && !menuOpen(trigger)) {
        if (triggerModelId && [...args.matchModelIds].includes(triggerModelId)) {
          verifiedModelId = triggerModelId;
          break;
        }
        if (!triggerModelId) trigger.click();
      }
      if (Date.now() >= end) return fail(args.action === 'select' ? 'UI_MODEL_UNVERIFIED' : 'UI_NOT_READY',
        args.action === 'select' ? 'The selected model did not become the accessible current model' : 'The model menu did not expose a selection');
      await delay(Math.min(100, end - Date.now()));
    }
    if (!args.leaveOpen && !await closeMenu(trigger)) return fail('UI_NOT_READY', 'The model menu did not close');
    return { ok: true, ready: true, triggerText: text(trigger), triggerModelId: verifiedModelId, options: current.map(option => option.modelId) };
  })();
}

export function normalizeWebLabel(value) {
  const lines = String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const split = line.match(/(?:claude[\s:_-]*)?(\d+(?:[._-]\d+)*)[\s._-]+(opus|sonnet|haiku)\b/i);
    const named = line.match(/(?:claude[\s:_-]*)?(opus|sonnet|haiku)\b(?:[\s._-]+(\d+(?:[._-]\d+)*))?/i);
    const match = [named, split]
      .filter(Boolean)
      .sort((left, right) => left.index - right.index)[0];
    if (!match) continue;
    const series = (match[1] && /^(?:opus|sonnet|haiku)$/i.test(match[1]) ? match[1] : match[2]).toLowerCase();
    const version = String(match[2] && /^(?:opus|sonnet|haiku)$/i.test(match[2]) ? match[1] : (match[2] ?? '')).replace(/[._]/g, '-');
    const suffix = line.slice(match.index + match[0].length)
      .replace(/^[^a-z0-9]+/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-|-$/g, '');
    const identity = `claude-${series}${version ? `-${version}` : ''}${suffix ? `-${suffix}` : ''}`;
    return normalizeModelId(identity);
  }
  return null;
}

async function callPicker(tab, action, extra, signal) {
  const timeoutMs = Math.max(1_000, tab.config?.readyTimeoutMs ?? 10_000);
  const args = {
    action,
    timeoutMs,
    ...extra,
  };
  const result = await tab.evaluate(`(${pageModelPicker.toString()})(${JSON.stringify(args)})`, { timeoutMs: timeoutMs + 1_000, signal });
  if (!result || typeof result.ok !== 'boolean') throw new BridgeError('UI_CONTRACT', 'Unexpected model picker response');
  if (!result.ok) throw new BridgeError(result.code, result.message);
  return result;
}

export async function inspectWebModelPicker(tab, { signal, leaveOpen = false } = {}) {
  const result = await callPicker(tab, 'inspect', { leaveOpen }, signal);
  if (!result.ready) throw new BridgeError('UI_MODEL_UNAVAILABLE', 'The Claude page exposes no accessible model menu');
  const options = result.options.map(modelId => ({ modelId, normalized: normalizeModelId(modelId) }))
    .filter(option => option.normalized);
  if (!options.length) throw new BridgeError('UI_MODEL_UNAVAILABLE', 'The accessible model menu contains no bounded model identities');
  return {
    triggerText: result.triggerText,
    triggerModel: options.find(option => option.modelId === result.triggerModelId)?.normalized ?? null,
    options,
  };
}

export async function selectWebModel(tab, desiredNormalized, { signal } = {}) {
  const before = await inspectWebModelPicker(tab, { signal, leaveOpen: true });
  if (modelEquivalent(before.triggerModel, desiredNormalized)) {
    await callPicker(tab, 'close', {}, signal);
    return before;
  }
  const matches = before.options.filter(option => modelEquivalent(option.normalized, desiredNormalized)).map(option => option.modelId);
  if (!matches.length) {
    throw new BridgeError('MODEL_UNAVAILABLE', 'The requested model is not present in the verified webpage model catalog');
  }
  await callPicker(tab, 'select', { matchModelIds: matches }, signal);
  return { triggerText: before.triggerText, triggerModel: desiredNormalized, options: before.options };
}

export async function resolveWebModel(tab, { explicitModel, configuredModel, catalog, signal }) {
  const available = await inspectWebModelPicker(tab, { signal, leaveOpen: true });
  const choice = selectHostModel({
    explicitModel,
    configuredModel,
    catalog,
    availableModels: available.options.map(option => option.normalized),
  });
  if (!modelEquivalent(available.triggerModel, choice.normalized)) await selectWebModel(tab, choice.normalized, { signal });
    return { ...choice, availableModels: available.options.map(option => option.normalized) };
}
