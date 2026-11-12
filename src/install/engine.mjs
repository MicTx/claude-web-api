// Install engine: resolves host targets and dispatches to the TOML or JSON
// adapter. One entry point per operation so the CLI, the Codex compatibility
// wrapper and the tests all exercise the same code path.
import { join, resolve, dirname, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir as identityStateDir } from '../identity.mjs';
import { defaultIo } from './atomic.mjs';
import { HOSTS, UNSUPPORTED_HOSTS, SUPPORTED_IDS, findHost, resolveTargets, isDetected, inventory } from './hosts.mjs';
import { inspectExternalSkill } from './external-skill.mjs';
import { inspectSharedSkill } from './shared-skill.mjs';
import { installTomlHost, uninstallTomlHost, checkTomlHost } from './toml-host.mjs';
import { installJsonHost, uninstallJsonHost, checkJsonHost } from './host-json.mjs';
import { externalSourceResult } from './sources.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function defaultStateDir(env = process.env) {
  return identityStateDir(env);
}

// The source paths an install registers: the MCP server entry and the CLI the
// skill calls back into.
export function sourcePaths(sourceRoot = REPO_ROOT) {
  const root = resolve(sourceRoot);
  const nodePath = process.env.CCW_NODE_COMMAND === 'node' ? 'node' : process.execPath;
  return {
    sourceRoot: root,
    nodePath,
    mcpPath: join(root, 'src', 'mcp-server.mjs'),
    cliPath: join(root, 'bin', 'ccw.mjs'),
    skillSrc: join(root, 'skills', 'claude'),
  };
}

const mergeSpec = (host, target, deps) => ({ ...host, ...target, ...deps });

export async function installHost(host, target, deps) {
  const { source, result } = await externalSourceResult(host, target, deps, { install: true });
  if (result) return result; // An external route is observed, never adopted.
  // If a manager changes config between provenance inspection and adapter
  // preflight, do not install against that newer, unchecked route snapshot.
  const guarded = { ...deps, expectedSourceConfigSha256: source.configSha256 ?? null };
  const spec = mergeSpec(host, target, guarded);
  const installed = host.format === 'toml'
    ? await installTomlHost(spec, guarded)
    : await installJsonHost(spec, target, guarded);
  return { ...installed, sourceBefore: source };
}

export async function uninstallHost(host, target, deps) {
  const spec = mergeSpec(host, target, deps);
  if (host.format === 'toml') return uninstallTomlHost(spec, deps);
  return uninstallJsonHost(spec, target, deps);
}

export async function checkHost(host, target, deps) {
  const { source, result } = await externalSourceResult(host, target, deps);
  if (result) {
    if (result.configured !== true || !target.skillDest) return result;
    const shared = await inspectSharedSkill({ ...deps, home: deps.home, skillName: host.skillName });
    const skill = await inspectExternalSkill({ ...deps, home: deps.home,
      skillDest: shared?.enabled ? shared.dest : target.skillDest, skillSrc: deps.skillSrc });
    if (!skill) return result;
    const externalSkill = shared?.enabled ? { ...skill, shared: true, via: shared.dest,
      linkExists: shared.linkExists, ...(shared.managerOwned ? { managerOwned: true } : {}) } : skill;
    return { ...result, externalSkill,
      issues: externalSkill.status === 'stale'
        ? [...result.issues, 'manager-owned skill copy differs from current runtime; refresh through the original manager; configuration health is unchanged']
        : result.issues };
  }
  const spec = mergeSpec(host, target, deps);
  const checked = host.format === 'toml'
    ? await checkTomlHost(spec, deps)
    : await checkJsonHost(spec, target, deps);
  return { ...checked, configured: checked.healthy, source: { ...source,
    ownership: checked.installed ? 'installer-record-validated' : source.ownership } };
}

export {
  HOSTS, UNSUPPORTED_HOSTS, SUPPORTED_IDS, findHost, resolveTargets, isDetected, inventory, defaultIo,
};

// Absolute-path test for the running platform: `C:\x` is absolute on win32 and
// not on posix, so a `/` prefix check is wrong on half the platforms we target.
export const absoluteOn = (platform = process.platform) => (platform === 'win32' ? win32.isAbsolute : posix.isAbsolute);

// Parse `--home <host>=<dir>` / `--home codex=/tmp/x` style overrides.
export function parseHomeOverrides(values = [], platform = process.platform) {
  const absolute = absoluteOn(platform);
  const overrides = {};
  for (const raw of values) {
    const index = raw.indexOf('=');
    if (index <= 0) throw new Error(`--home needs <host>=<dir>, got: ${raw}`);
    const id = raw.slice(0, index);
    const dir = raw.slice(index + 1);
    if (!findHost(id)) throw new Error(`--home names an unknown host: ${id}`);
    if (!absolute(dir)) throw new Error(`--home needs an absolute directory, got: ${dir}`);
    overrides[id] = dir;
  }
  return overrides;
}

export function parseHostSelection(values = []) {
  const ids = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  const unknown = ids.filter((id) => !findHost(id));
  if (unknown.length) throw new Error(`Unknown host(s): ${unknown.join(', ')}`);
  return [...new Set(ids)];
}
