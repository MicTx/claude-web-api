#!/usr/bin/env node
// Multi-host installer: registers the Claude Web MCP server (and, where the
// host supports it, the claude skill) for every supported agent host.
//
// Ownership rules are those of the host adapters: only the install record
// proves an entry is ours, an unknown pre-existing entry is a conflict, and a
// per-host failure never aborts the remaining hosts.
//
// Usage:
//   node scripts/install-agents.mjs [--host id[,id]] [--all] [--check] [--uninstall]
//                                   [--dry-run] [--list] [--home id=DIR]...
//                                   [--state-dir DIR]
//
// Output is one JSON line. Exit 0 when every targeted host succeeded.
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../src/is-main.mjs';
import { defaultIo } from '../src/install/atomic.mjs';
import { InstallError } from '../src/install/errors.mjs';
import {
  HOSTS, SUPPORTED_IDS, absoluteOn, defaultStateDir, installHost, inventory,
  parseHomeOverrides, parseHostSelection, resolveTargets, sourcePaths, uninstallHost, checkHost,
} from '../src/install/engine.mjs';
import { isDetected } from '../src/install/hosts.mjs';
import { reconcileHost } from '../src/install/reconcile.mjs';
import { probeHost } from '../src/install/probe.mjs';
import { discoverHost } from '../src/install/discovery.mjs';
import { readState, clearReconnectMarker as removeReconnectMarker } from '../src/release/install-fs.mjs';
import { VERSION } from '../src/release/archive.mjs';
export { readState, VERSION };

async function releaseSourceRoot(sourceRoot, io) {
  if (!sourceRoot || !io.realpath) throw new InstallError('RELEASE_REQUIRED', 'Use the verified release wrapper');
  const physical = await io.realpath(sourceRoot);
  const moduleRoot = await io.realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  if (physical !== moduleRoot) throw new InstallError('RELEASE_REQUIRED', 'The release entrypoint and runtime root do not match');
  const releases = dirname(physical);
  const version = basename(physical);
  if (basename(releases) !== 'releases' || !version.startsWith('v') || !VERSION.test(version.slice(1))) return sourceRoot;
  const root = dirname(releases);
  try {
    const state = await readState(root);
    if (!state || state.current !== version.slice(1) || await io.realpath(join(root, 'current')) !== physical) {
      throw new Error('not the verified current release');
    }
  } catch {
    throw new InstallError('RELEASE_REQUIRED', 'Use the verified current release wrapper');
  }
  return join(root, 'current');
}

// A green --check --probe proves the verified route answers the MCP contract at
// the currently installed release; only then is an upgrade's reconnect marker
// cleared. Marker removal is best-effort and never changes the check result.
async function clearReconnectMarker(sourceRoot) {
  if (typeof sourceRoot !== 'string') return 'no-release-root';
  const runtimeRoot = dirname(sourceRoot);
  try {
    const state = await readState(runtimeRoot);
    if (!state || join(runtimeRoot, 'current') !== sourceRoot) return 'not-current-release';
    return await removeReconnectMarker(runtimeRoot) ? 'cleared' : 'absent';
  } catch { return 'failed'; }
}

const HELP = `ccw agent hosts installer

Usage:
  node scripts/install-agents.mjs [options]

Options:
  --host <id[,id]>   Install only these hosts (default: every detected host)
  --all              Include supported hosts even when their directory is missing
  --check            Read configuration provenance instead of installing
  --probe            With --check only: bounded initialize/tools/list on verified local routes
  --discover         With --check only: explicit read-only find_tools schema inspection on a verified hub
  --uninstall        Remove our entry and the installed skill
  --reconcile        Explicitly retire proven stale records or an empty orphan marker
  --dry-run          Report what would change; writes nothing
  --list             Print the host inventory (supported + unsupported)
  --home <id=DIR>    Override one host's directory (repeatable; absolute path)
                     This is not whole-HOME isolation; set HOME for Magpie too
  --state-dir <DIR>  Override the installer state directory
  --help             Print this help

Supported hosts: ${SUPPORTED_IDS.join(', ')}
Results are printed as one JSON line on stdout. Errors exit non-zero.
`;

// The state directory holds the install records, so it must be a real absolute
// path: a relative value would scatter records under whatever cwd the command
// ran from, and the next run elsewhere would report the install as missing.
// The runtime enforces the same rule for CCW_STATE_DIR (src/config.mjs).
export function resolveBase({ env = process.env, overrides = {}, stateDir, platform = process.platform } = {}) {
  const absolute = absoluteOn(platform);
  const home = env.HOME ?? homedir();
  if (typeof home !== 'string' || !absolute(home) || home.includes('\0')) throw new Error('HOME must be an absolute directory path');
  let dir;
  let source;
  if (stateDir !== undefined) {
    dir = stateDir;
    source = '--state-dir';
  } else if (env.CCW_STATE_DIR !== undefined) {
    dir = env.CCW_STATE_DIR;
    source = 'CCW_STATE_DIR';
  } else {
    dir = defaultStateDir(env);
    source = 'state directory';
  }
  if (typeof dir !== 'string' || !absolute(dir)) {
    throw new Error(`${source} must be an absolute path, got: ${dir}`);
  }
  return {
    home,
    env,
    platform,
    stateDir: dir,
    overrides,
  };
}

function selectTargets(base, { hosts }) {
  if (hosts) {
    return HOSTS.filter((h) => hosts.includes(h.id))
      .map((host) => ({ host, target: host.resolve({ ...base, override: base.overrides[host.id] ?? null }) }));
  }
  return resolveTargets(base);
}

async function detectedOnly(io, entries) {
  const seen = [];
  for (const entry of entries) {
    try { if (await isDetected(io, entry.host, entry.target)) seen.push(entry); }
    catch (detectionError) { seen.push({ ...entry, detectionError }); }
  }
  return seen;
}

const hasInstallRecord = async (io, target) => {
  try {
    return await io.lstat(target.recordPath) !== null;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

// Default target selection depends on the action. Install is a write, so it only
// touches hosts that are actually present. Check and uninstall are verification
// and cleanup: they must also cover a host whose directory is gone but whose
// install record survives, otherwise a stale record is silently reported as
// "nothing to check" and can never be reclaimed.
async function detectedOrRecorded(io, entries) {
  const seen = [];
  for (const entry of entries) {
    try {
      if (await isDetected(io, entry.host, entry.target)) seen.push(entry);
      else if (await hasInstallRecord(io, entry.target)) seen.push(entry);
    } catch (detectionError) { seen.push({ ...entry, detectionError }); }
  }
  return seen;
}

export async function run(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr, io = defaultIo(), sourceRoot,
} = {}) {
  const emit = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
  if (typeof __CCW_RELEASE_INTERNAL_ENTRY__ !== 'undefined' && __CCW_RELEASE_INTERNAL_ENTRY__) {
    try { sourceRoot = await releaseSourceRoot(sourceRoot, io); }
    catch (error) {
      emit({ ok: false, error: { code: 'RELEASE_REQUIRED', message: 'Use the verified current release wrapper' } });
      return 1;
    }
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        host: { type: 'string', multiple: true },
        all: { type: 'boolean' },
        check: { type: 'boolean' },
        probe: { type: 'boolean' },
        discover: { type: 'boolean' },
        uninstall: { type: 'boolean' },
        reconcile: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        list: { type: 'boolean' },
        home: { type: 'string', multiple: true },
        'state-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: `Invalid arguments: ${error.message}` } });
    return 1;
  }

  if (values.help) {
    stdout.write(HELP);
    return 0;
  }

  let overrides;
  let hosts;
  let base;
  try {
    overrides = parseHomeOverrides(values.home ?? []);
    hosts = parseHostSelection(values.host ?? []);
    base = resolveBase({ env, overrides, stateDir: values['state-dir'] });
  } catch (error) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: error.message } });
    return 1;
  }

  const actions = [values.check, values.uninstall, values.reconcile].filter(Boolean).length;
  if (actions > 1 || (values.list && (actions > 0 || values.probe || values.discover))) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '--check, --uninstall, --reconcile and --list are mutually exclusive' } });
    return 1;
  }
  if ((values.probe || values.discover) && (!values.check || values['dry-run'])) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '--probe and --discover require --check and cannot be combined with --dry-run' } });
    return 1;
  }
  if (values.probe && values.discover) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '--probe and --discover are mutually exclusive' } });
    return 1;
  }
  if (values.list) {
    emit({ ok: true, action: 'list', stateDir: base.stateDir, hosts: inventory(base) });
    return 0;
  }

  const action = values.check ? 'check' : (values.uninstall ? 'uninstall' : (values.reconcile ? 'reconcile' : 'install'));
  let entries = selectTargets(base, { hosts });
  if (!hosts && !values.all) {
    entries = action === 'install'
      ? await detectedOnly(io, entries)
      : await detectedOrRecorded(io, entries);
  }

  if (entries.length === 0) {
    emit({
      ok: true, action,
      stateDir: base.stateDir, hosts: [], note: 'no supported host detected; pass --host <id> or --all',
    });
    return 0;
  }

  const deps = { ...sourcePaths(sourceRoot), home: base.home };
  if (values['dry-run']) deps.dryRun = true;
  const results = [];
  for (const { host, target, detectionError } of entries) {
    try {
      if (detectionError) throw new InstallError('SOURCE_UNREADABLE', 'Host presence or install-record location could not be read; this host was not changed');
      const result = values.check
        ? await checkHost(host, target, { ...deps, io })
        : (values.uninstall
          ? await uninstallHost(host, target, { ...deps, io })
          : (values.reconcile
            ? await reconcileHost(host, target, { ...deps, io })
            : await installHost(host, target, { ...deps, io })));
      const diagnostic = values.probe && result.healthy === true
        ? await probeHost(host, target, { ...deps, io })
        : (values.discover && result.healthy === true
          ? await discoverHost(host, target, { ...deps, io }) : null);
      const diagnosticKey = values.probe ? 'probe' : (values.discover ? 'discovery' : null);
      results.push({ host: host.id, label: host.label, ...result,
        ...(diagnosticKey ? { [diagnosticKey]: diagnostic ?? { ok: false, skipped: true, verification: 'none', hostLoaded: false, claudeSent: false,
          error: { code: values.probe ? 'PROBE_CONFIG_UNHEALTHY' : 'DISCOVERY_CONFIG_UNHEALTHY',
            message: 'Resolve configuration provenance before diagnostics; no endpoint was contacted' } } } : {}) });
    } catch (error) {
      const code = error instanceof InstallError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof InstallError ? error.message : String(error?.message ?? error);
      results.push({
        host: host.id, label: host.label, ok: false, configPath: target.configPath,
        error: { code, message, ...(error?.details && Object.keys(error.details).length ? { details: error.details } : {}) },
      });
    }
  }

  const failed = results.filter((r) => r.ok === false || (values.check && r.healthy === false)
    || (values.probe && r.probe?.ok !== true) || (values.discover && r.discovery?.ok !== true));
  const reconnectMarker = values.check && values.probe && !values['dry-run'] && failed.length === 0
    ? await clearReconnectMarker(sourceRoot) : 'not-attempted';
  const reconnectWarning = values.check && values.probe && !values['dry-run'] && reconnectMarker !== 'cleared' && reconnectMarker !== 'absent'
    ? 'reconnect marker cleanup did not complete; see reconnectMarker' : null;
  emit({
    ok: failed.length === 0,
    action,
    stateDir: base.stateDir,
    ...(values['dry-run'] ? { dryRun: true } : {}),
    ...(values.check && values.probe && !values['dry-run'] ? { reconnectCleared: reconnectMarker === 'cleared', reconnectMarker } : {}),
    ...(reconnectWarning ? { warning: reconnectWarning } : {}),
    hosts: results,
    ...(failed.length ? { failed: failed.map((r) => r.host) } : {}),
  });
  if (failed.length && stderr) {
    for (const r of failed) {
      const error = r.error ?? r.probe?.error ?? r.discovery?.error;
      stderr.write(`ccw: ${r.host} failed: ${error?.code ?? 'UNHEALTHY'} ${error?.message ?? (r.issues ?? []).join('; ')}\n`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  if (typeof __CCW_RELEASE_INTERNAL_ENTRY__ !== 'undefined' && __CCW_RELEASE_INTERNAL_ENTRY__) {
    process.stderr.write('Use the verified scripts/install-agents.mjs wrapper instead of this internal module.\n');
    process.exitCode = 1;
  } else {
    process.exitCode = await run(process.argv.slice(2));
  }
}
