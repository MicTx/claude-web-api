// Configuration provenance is deliberately separate from installer ownership,
// endpoint reachability and proof that a running agent loaded a tool schema.
import { constants } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { defaultIo, lstatSafe, sha256 } from './atomic.mjs';
import { readState, installedRelease } from '../release/install-fs.mjs';
import { canonical } from './json-text.mjs';
import { InstallError } from './errors.mjs';
import { isNodeCommand } from './node-command.mjs';

const MAX_CONFIG = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => path === root || path.startsWith(root + sep);
const fail = (code, message) => { throw new InstallError(code, message); };
const sameIdentity = (a, b) => a && b && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const enabled = entry => entry.enabled !== false && entry.disabled !== true;
const flagsValid = entry => ['enabled', 'disabled'].every(key => !Object.hasOwn(entry, key) || typeof entry[key] === 'boolean');
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const nodeIdentity = async (io, path) => path === 'node' ? 'node' : await programPath(io, path, { executable: true });

// A link can be inspected only when it stays within the explicitly supplied
// user HOME. Neither this function nor its result grants write-through rights.
// An fd plus O_NOFOLLOW avoids reading a swapped final-component link; reads
// are bounded even if a file grows between stat and read.
export async function readSourceFile(io, path, { home, allowLink = false, maxBytes = MAX_CONFIG, label = 'source configuration' } = {}) {
  const initial = await lstatSafe(io, path);
  if (!initial) return null;
  if (initial.isSymbolicLink() && (!allowLink || !isAbsolute(home ?? '') || !io.realpath)) fail('UNSAFE_PATH', `${label} is a symlink`);
  let physical = path;
  if (io.realpath) {
    try {
      physical = await io.realpath(path);
      if (isAbsolute(home ?? '') && (initial.isSymbolicLink() || inside(resolve(home), resolve(path)))) {
        if (!inside(await io.realpath(home), physical)) fail('UNSAFE_PATH', `${label} link leaves the user home`);
      }
    } catch (error) {
      if (error instanceof InstallError) throw error;
      fail('UNSAFE_PATH', `${label} path cannot be resolved`);
    }
  }
  const before = await lstatSafe(io, physical);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail('UNSAFE_PATH', `${label} must be a bounded regular file`);
  if (process.getuid && before.uid !== process.getuid()) fail('UNSAFE_PATH', `${label} has a different owner`);
  if (before.mode & 0o022) fail('UNSAFE_PATH', `${label} is writable by other users`);
  let handle;
  try { handle = await io.open(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch { fail('CONFIG_CHANGED', `${label} could not be opened safely`); }
  let bytes;
  try {
    if (!sameIdentity(before, await handle.stat())) fail('CONFIG_CHANGED', `${label} changed before reading`);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    bytes = buffer.subarray(0, length);
    const after = await lstatSafe(io, physical), named = await lstatSafe(io, path);
    if (!sameIdentity(before, await handle.stat()) || !sameIdentity(before, after) || !sameIdentity(initial, named) || length !== before.size) {
      fail('CONFIG_CHANGED', `${label} changed while reading`);
    }
    if (io.realpath && await io.realpath(path) !== physical) fail('CONFIG_CHANGED', `${label} link changed while reading`);
  } finally { await handle.close(); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('CONFIG_INVALID', `${label} is not UTF-8`); }
  return { text, sha256: sha256(bytes), linked: initial.isSymbolicLink(), physical };
}

export function parseSourceJson(text, label = 'configuration') {
  try {
    const document = JSON.parse(text);
    if (!object(document)) throw new Error();
    // Reject duplicate object keys, including objects nested in arrays. A key
    // token is the only valid JSON string immediately followed by a colon.
    // The iterative scan has no recursion/depth dependence on user input.
    const scopes = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') scopes.push(new Set());
      else if (text[i] === '}') scopes.pop();
      else if (text[i] === '"') {
        const start = i++;
        for (; i < text.length; i++) {
          if (text[i] === '\\') i++;
          else if (text[i] === '"') break;
        }
        let next = i + 1;
        while (/\s/.test(text[next] ?? '') && next < text.length) next++;
        if (text[next] === ':') {
          const name = JSON.parse(text.slice(start, i + 1));
          const names = scopes.at(-1);
          if (!names || names.has(name)) throw new Error();
          names.add(name);
        }
      }
    }
    return document;
  } catch { fail('CONFIG_INVALID', `${label} is not an unambiguous JSON object`); }
}

export function sourceServers(host, text) {
  if (text === null || text.trim() === '') return {};
  let document;
  try { document = host.format === 'toml' ? parseToml(text) : parseSourceJson(text, 'host configuration'); }
  catch (error) {
    if (error instanceof InstallError) throw error;
    fail('CONFIG_INVALID', 'host configuration is not valid TOML');
  }
  for (const key of host.format === 'toml' ? ['mcp_servers'] : host.container) {
    if (!object(document)) fail('CONFIG_INVALID', 'host MCP container is not an object');
    if (!Object.hasOwn(document, key)) return {};
    document = document[key];
  }
  if (!object(document)) fail('CONFIG_INVALID', 'host MCP container is not an object');
  return document;
}

export function localHubUrl(raw, hostId) {
  if (typeof raw !== 'string' || raw.length > 2048
    || !/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):[1-9][0-9]{0,4}\/mcp\/magpie\/hub\/[a-z][a-z0-9-]*$/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.href !== raw || url.pathname !== `/mcp/magpie/hub/${hostId}`) return null;
    return url.href;
  } catch { return null; }
}

function directRoute(entry, commandArray = false) {
  if (!object(entry) || !flagsValid(entry) || !enabled(entry) || entry.url != null
    || (entry.type !== undefined && entry.type !== (commandArray ? 'local' : 'stdio'))
    || Array.isArray(entry.command) !== commandArray
    || (commandArray && (entry.type !== 'local' || entry.args !== undefined))) return null;
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  // Magpie omits an empty args list when serializing a zero-argument command.
  // Missing is empty; explicit null or any other malformed value still fails.
  const args = Array.isArray(entry.command) ? entry.command.slice(1) : entry.args === undefined ? [] : entry.args;
  if (typeof command !== 'string' || (!isAbsolute(command) && !isNodeCommand(command)) || /[\0\r\n]/.test(command) || !Array.isArray(args)
    || args.some(arg => typeof arg !== 'string' || /[\0\r\n]/.test(arg))) return null;
  const env = entry.env;
  const environmentRelevant = env !== undefined && (!object(env) || Object.keys(env).some(key => key !== 'CCW_RUNTIME_ROOT')
    || (Object.hasOwn(env, 'CCW_RUNTIME_ROOT') && (typeof env.CCW_RUNTIME_ROOT !== 'string' || !isAbsolute(env.CCW_RUNTIME_ROOT))));
  return { command, args, configuredEnvironment: environmentRelevant, runtimeRoot: object(env) ? env.CCW_RUNTIME_ROOT : undefined };
}
const sameRoute = (a, b) => a && b && a.command === b.command && canonical(a.args) === canonical(b.args);

async function programPath(io, path, { executable = false } = {}) {
  if (!isAbsolute(path ?? '')) return null;
  let physical = path;
  if (io.realpath) { try { physical = await io.realpath(path); } catch { return null; } }
  const stat = await lstatSafe(io, physical);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.mode & 0o022 || (executable && process.platform !== 'win32' && !(stat.mode & 0o111))) return null;
  return physical;
}

// Filename resemblance is NOT evidence. Only the current trusted runtime and
// Node identity (or the exact generated shim for it) qualify for a probe.
async function trustedDirect(io, route, deps) {
  if (!route || !deps.mcpPath) return null;
  const command = deps.nodePath ?? process.execPath;
  const node = await nodeIdentity(io, command);
  const server = await programPath(io, deps.mcpPath);
  if (!node || !server) return null;
  if (route.runtimeRoot !== undefined) {
    if (!deps.sourceRoot || !io.realpath) return null;
    try { if (await io.realpath(route.runtimeRoot) !== await io.realpath(deps.sourceRoot)) return null; }
    catch { return null; }
  }
  if (route.args.length === 1 && await nodeIdentity(io, route.command) === node
    && await programPath(io, route.args[0]) === server) {
    return { type: 'stdio', command, args: [deps.mcpPath], configuredEnvironment: route.configuredEnvironment };
  }
  if (route.args.length === 0 && basename(route.command) === 'ccw-mcp'
    && await programPath(io, route.command, { executable: true })) {
    const shim = await readSourceFile(io, route.command, { home: deps.home, allowLink: true, maxBytes: 16384, label: 'installed MCP shim' });
    const launcher = command === 'node' ? 'export CCW_NODE_COMMAND=node\n' : '';
    const expected = `#!/bin/sh\n${launcher}exec ${quote(command)} ${quote(deps.mcpPath)} "$@"\n`;
    if (shim?.text === expected) return { type: 'stdio', command, args: [deps.mcpPath], configuredEnvironment: route.configuredEnvironment, shimVerified: true };
    // Stable release commands deliberately use runtime/current even if this
    // host process entered via a realpath-resolved releases/vX module. Verify
    // the installer record, manifest, every runtime file and command owner;
    // a basename or a guessed shell script never qualifies.
    if (deps.sourceRoot) {
      const physicalRoot = io.realpath ? await io.realpath(deps.sourceRoot).catch(() => null) : null;
      const match = physicalRoot?.match(/^(.*)[\\/]releases[\\/]v[^\\/]+$/);
      if (match) {
        try {
          const state = await readState(match[1]);
          if (state && route.command === join(state.owner.binDir, 'ccw-mcp')) {
            const installed = await installedRelease(match[1], state.current, state.owner.releases[state.current]);
            if (installed.dir === physicalRoot) return { type: 'stdio', command, args: [deps.mcpPath], configuredEnvironment: route.configuredEnvironment, shimVerified: true, releaseVerified: true };
          }
        } catch { /* modified/unknown release is not a trusted route */ }
      }
    }
  }
  return null;
}

async function libraryFor(io, home, hostId) {
  if (!isAbsolute(home ?? '')) return null;
  const file = await readSourceFile(io, join(home, '.config', 'magpie', 'library.json'), { home, label: 'Magpie Library' });
  if (!file) return null;
  const library = parseSourceJson(file.text, 'Magpie Library');
  if (library.mcp !== undefined && !Array.isArray(library.mcp)) fail('CONFIG_INVALID', 'Magpie Library MCP list is not an array');
  if (library.mcpHub !== undefined && typeof library.mcpHub !== 'boolean') fail('CONFIG_INVALID', 'Magpie Library hub mode is invalid');
  const candidates = (library.mcp ?? []).filter(item => object(item) && item.name === 'claude_web');
  if (candidates.length > 1) fail('SOURCE_CONFLICT', 'Magpie Library has duplicate claude_web definitions');
  const entry = candidates[0];
  if (!entry) return null;
  if (!Array.isArray(entry.agents) || entry.agents.some(agent => typeof agent !== 'string') || new Set(entry.agents).size !== entry.agents.length) {
    fail('CONFIG_INVALID', 'Magpie claude_web agent assignment is invalid');
  }
  if (!entry.agents.includes(hostId)) return null;
  if (!flagsValid(entry) || !enabled(entry) || entry.transport !== 'stdio') fail('SOURCE_CONFLICT', 'Magpie claude_web definition is disabled or has an unsupported transport');
  return { route: directRoute(entry), hub: library.mcpHub === true, sha256: file.sha256 };
}

function validHubEntry(entry, hostId) {
  return object(entry) && flagsValid(entry) && enabled(entry) && localHubUrl(entry.url, hostId)
    && entry.command === undefined && entry.args === undefined
    && (entry.type === undefined || ['http', 'streamable-http', 'remote'].includes(entry.type));
}

export async function inspectSources(host, target, { io = defaultIo(), home, ...deps } = {}) {
  const config = await readSourceFile(io, target.configPath, { home, allowLink: true, label: 'host configuration' });
  const servers = sourceServers(host, config?.text ?? null);
  const directExists = Object.hasOwn(servers, host.serverName);
  const direct = directExists ? servers[host.serverName] : null;
  const record = await lstatSafe(io, target.recordPath);
  if (record && (!record.isFile() || record.isSymbolicLink() || record.size > 256 * 1024
    || record.mode & 0o022 || (process.getuid && record.uid !== process.getuid()))) fail('UNSAFE_PATH', 'install record is not a bounded, owned regular file');
  const library = await libraryFor(io, home, host.id);
  const hubEntries = Object.values(servers).filter(entry => object(entry) && localHubUrl(entry.url, host.id));
  const activeHubs = hubEntries.filter(entry => validHubEntry(entry, host.id));
  const trustedLibrary = library ? await trustedDirect(io, library.route, { ...deps, home }) : null;
  const hub = library?.hub && activeHubs.length === 1 && trustedLibrary ? activeHubs[0] : null;
  const base = { verification: 'configuration-only', ownership: record ? 'unverified-record' : 'external-or-none', configLinked: config?.linked ?? false,
    ...(config ? { configSha256: config.sha256 } : {}), ...(library ? { librarySha256: library.sha256 } : {}) };
  const directIsHub = directExists && validHubEntry(direct, host.id);
  if (activeHubs.length > 1 || (directExists && !directIsHub && activeHubs.length)) {
    return { ...base, kind: 'conflict', healthy: false, issues: ['multiple claude_web delivery sources configured'] };
  }
  if (record && hub) return { ...base, kind: 'conflict', healthy: false, issues: ['external hub and installer record coexist; explicit reconciliation required'] };
  if (record) {
    const route = await trustedDirect(io, directRoute(direct, host.id === 'opencode'), { ...deps, home });
    return { ...base, kind: 'installer', healthy: null, issues: [], ...(route ? { route } : {}) };
  }
  if (host.format === 'toml' && /^# (>>>|<<<) claude-web-api (>>>|<<<)\r?$/m.test(config?.text ?? '')) {
    if (directExists) return { ...base, kind: 'unknown', healthy: false, issues: ['managed-looking markers have no install record; explicit reconciliation required'] };
    // An empty historical marker does not invalidate an independently verified
    // external route, but normal install must not pass through and adopt it.
    base.recoveryIssues = ['orphan managed marker requires explicit reconciliation before any direct installation'];
  }
  if (directExists && !directIsHub) {
    const route = directRoute(direct, host.id === 'opencode');
    const trusted = await trustedDirect(io, route, { ...deps, home });
    if (trusted) return { ...base, kind: library && sameRoute(route, library.route) ? 'magpie-direct' : 'external-direct',
      healthy: true, issues: [], route: trusted, ownership: 'external' };
    return { ...base, kind: 'unknown', healthy: false, issues: ['unowned claude_web route is disabled, unknown, or not the trusted runtime'] };
  }
  if (hub) return { ...base, kind: 'magpie-hub', healthy: true, issues: [], route: { type: 'http', url: localHubUrl(hub.url, host.id),
    configuredAuthentication: ['headers', 'http_headers', 'httpHeaders', 'bearer_token_env_var', 'env'].some(key => hub[key] !== undefined && hub[key] !== null && (!object(hub[key]) || Object.keys(hub[key]).length !== 0)) }, ownership: 'external' };
  if (library?.hub || hubEntries.length) return { ...base, kind: 'unknown', healthy: false, issues: ['Magpie declaration and active local host route do not agree'] };
  return { ...base, kind: 'none', healthy: false, issues: ['install record missing', `${host.format === 'toml' ? 'mcp_servers' : host.container.join('.')}.${host.serverName} is not registered`] };
}

export async function externalSourceResult(host, target, deps, { install = false } = {}) {
  const source = await inspectSources(host, target, deps);
  if (source.kind === 'none' && source.recoveryIssues?.length) {
    if (install) fail('INSTALL_CONFLICT', source.recoveryIssues.join('; '));
    return { source, result: { ok: true, host: host.id, installed: false, configured: false, healthy: false,
      issues: [...source.issues, ...source.recoveryIssues], configPath: target.configPath, source } };
  }
  if (source.kind === 'installer' || source.kind === 'none') return { source, result: null };
  if (!source.healthy) {
    if (install) fail('INSTALL_CONFLICT', source.issues.join('; '));
    return { source, result: { ok: true, host: host.id, installed: false, configured: false, healthy: false, issues: source.issues, configPath: target.configPath, source } };
  }
  return { source, result: { ok: true, host: host.id, installed: false, configured: true, healthy: true,
    ...(install ? { skippedExternal: true, changed: false } : {}), issues: [], configPath: target.configPath, source } };
}
