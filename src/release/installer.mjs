// Bundled into the published Bash entry. Running an unbuilt source module never installs.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { MAX_ARCHIVE, VERSION, sha256, readRelease } from './archive.mjs';
import { APP, COMMANDS, RECONNECT_MARKER, fail, stat, checkDirectory, regular, installedRelease, readState, reconnectPending,
  shims, transaction, fileImage, linkImage, syncDirectory } from './install-fs.mjs';

const BUILD_VERSION = typeof __CCW_RELEASE_VERSION__ === 'string' ? __CCW_RELEASE_VERSION__ : null;
export const HELP = `ccw release installer (macOS/Linux, Node.js >=22)

Usage:
  bash install.sh --version VERSION --release-url HTTPS_URL [options]
  bash install.sh --version VERSION --archive FILE --sha256 HEX [options]
  bash install.sh --status [options]
  bash install.sh --rollback [--dry-run] [options]

Options:
  --version VERSION    Fixed release version (defaults to this installer's version)
  --release-url URL    Version-specific Gitea /releases/download/vVERSION URL
  --archive FILE       Already downloaded regular .tar.gz file
  --sha256 HEX         Independently obtained SHA-256, required with --archive
  --prefix DIR         Independent runtime root (default ~/.local/share/claude-web-api/runtime)
  --bin-dir DIR        Stable command directory (default ~/.local/bin)
  --dry-run            Read-only plan; never downloads or creates files
  --status             Verify installed files and command ownership; no model calls
  --rollback           Switch current and previous verified releases, without downloading
  --timeout-ms N       Per-asset network deadline, 500..120000 (default 30000)
  --allow-loopback-http  Explicit local-fixture exception, literal loopback only
  --help               Show this help

CCW_RELEASE_TOKEN supplies a private Gitea token via environment only when required.
Private downloads require explicit token injection; no Git credential fallback is used.
Installs ccw, ccw-mcp and ccw-hosts. Never edits shell profiles, agent settings,
Magpie Library, sessions, credentials or browser configuration. Reconnect hosts
explicitly after upgrading. Never install into a source worktree.
`;

function releaseURL(raw, version, local) {
  let url;
  try { url = new URL(raw); } catch { throw fail('INVALID_URL', 'A version-specific HTTPS Release URL is required'); }
  const loopback = local && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash
    || !url.pathname.replace(/\/$/, '').endsWith(`/v${version}`)) throw fail('INVALID_URL', 'Use a fixed HTTPS Release URL without userinfo, query or fragment');
  url.pathname = url.pathname.replace(/\/$/, '') + '/';
  return url;
}

async function download(url, max, timeout, token) {
  const origin = url.origin;
  const signal = AbortSignal.timeout(timeout);
  let target = url;
  for (let hop = 0; hop <= 5; hop++) {
    const response = await fetch(target, { redirect: 'manual', signal, headers: token ? { authorization: `token ${token}` } : {} });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      let next;
      try { next = new URL(location, target); } catch { throw fail('DOWNLOAD_FAILED', 'Invalid release redirect'); }
      if (!location || next.origin !== origin || next.username || next.password || hop === 5) throw fail('DOWNLOAD_FAILED', 'Cross-origin or excessive release redirect refused');
      target = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw fail('DOWNLOAD_FAILED', `Release request failed with HTTP ${response.status}`);
    }
    if (Number(response.headers.get('content-length')) > max) {
      await response.body?.cancel();
      throw fail('DOWNLOAD_FAILED', 'Release response exceeds its limit');
    }
    const chunks = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > max) throw fail('DOWNLOAD_FAILED', 'Release response exceeds its limit');
      chunks.push(Buffer.from(part));
    }
    return Buffer.concat(chunks);
  }
  throw fail('DOWNLOAD_FAILED', 'Release download did not complete');
}

function archiveDigest(text, name) {
  const found = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || ![name, 'install.sh'].includes(match[2])) throw fail('BAD_CHECKSUMS', 'Unexpected SHA256SUMS content');
    if (match[2] === name) found.push(match[1]);
  }
  if (found.length !== 1) throw fail('BAD_CHECKSUMS', 'Release checksum must identify exactly one archive');
  return found[0];
}

async function incoming(values, version, timeout) {
  let bytes, expected;
  if (values.archive) {
    if (!/^[a-f0-9]{64}$/.test(values.sha256 ?? '')) throw fail('INVALID_ARGUMENT', '--archive requires a lowercase SHA-256');
    bytes = (await regular(resolve(values.archive))).bytes;
    expected = values.sha256;
  } else {
    const base = releaseURL(values['release-url'], version, values['allow-loopback-http']);
    const token = process.env.CCW_RELEASE_TOKEN ?? '';
    if (token.length > 8192 || /[\r\n\0]/.test(token)) throw fail('INVALID_ARGUMENT', 'Release token has invalid header characters or size');
    const asset = `${APP}-v${version}.tar.gz`;
    const sums = await download(new URL('SHA256SUMS', base), 16384, timeout, token);
    expected = archiveDigest(new TextDecoder('utf-8', { fatal: true }).decode(sums), asset);
    bytes = await download(new URL(asset, base), MAX_ARCHIVE, timeout, token);
  }
  if (sha256(bytes) !== expected) throw fail('SHA_MISMATCH', 'Release archive SHA-256 mismatch; nothing installed');
  const release = readRelease(bytes, version);
  return { ...release, archiveSha256: expected, manifestSha256: sha256(release.files.get('release.json').bytes) };
}

async function withLock(root, fn) {
  await checkDirectory(dirname(root), { create: true });
  const lock = join(dirname(root), `.${basename(root)}.install.lock`);
  const nonce = randomUUID();
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('LOCKED', 'Another install or an unresolved install lock exists; do not remove it without checking ownership'); throw error; }
  try {
    await handle.writeFile(nonce);
    await handle.sync();
    await handle.close();
    handle = null;
    return await fn();
  } finally {
    if (handle) await handle.close();
    const current = await regular(lock, 1024);
    if (current.bytes.toString() !== nonce) throw fail('CONCURRENT_CHANGE', 'Install lock ownership changed; preserved');
    await fs.unlink(lock);
  }
}

async function install(root, binDir, state, release, version) {
  const commands = shims(root, 'node');
  if (state && state.owner.binDir !== binDir) throw fail('OWNERSHIP_CONFLICT', 'Changing an existing command directory requires separate migration');
  if (!state) for (const name of COMMANDS) if (await stat(join(binDir, name))) throw fail('OWNERSHIP_CONFLICT', 'A command already exists without this runtime ownership record');
  const identity = { archiveSha256: release.archiveSha256, manifestSha256: release.manifestSha256 };
  const known = state?.owner.releases[version];
  if (known && (known.archiveSha256 !== identity.archiveSha256 || known.manifestSha256 !== identity.manifestSha256)) throw fail('VERSION_CONFLICT', 'A version is immutable; publish a new version instead of replacing it');
  const dir = join(root, 'releases', `v${version}`);
  if (await stat(dir)) {
    if (!known) throw fail('OWNERSHIP_CONFLICT', 'Unrecorded release directory already exists');
    await installedRelease(root, version, known);
  }
  const unchanged = state?.current === version && COMMANDS.every(name => state.owner.shims[name] === sha256(commands[name]));
  if (unchanged) return { changed: false, previous: state.previous };
  await checkDirectory(root, { create: true });
  await checkDirectory(binDir, { create: true });
  await checkDirectory(join(root, 'releases'), { create: true });
  let created = false;
  if (!await stat(dir)) {
    const stage = join(root, `.stage-${randomUUID()}`);
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      for (const [path, { bytes, mode }] of release.files) {
        await checkDirectory(dirname(join(stage, path)), { create: true });
        const handle = await fs.open(join(stage, path), 'wx', mode);
        try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
        finally { await handle.close(); }
      }
      const directories = [...new Set([stage, ...[...release.files.keys()].map(path => dirname(join(stage, path)))])].sort((a, b) => b.length - a.length);
      for (const path of directories) await syncDirectory(path);
      if (await stat(dir)) throw fail('CONCURRENT_CHANGE', 'Release destination appeared during staging');
      await fs.rename(stage, dir);
      created = true;
      await syncDirectory(dirname(dir));
    } finally { if (await stat(stage)) await fs.rm(stage, { recursive: true }); }
  }
  const owner = { schema: 1, name: APP, root, binDir,
    releases: { ...(state?.owner.releases ?? {}), [version]: identity },
    shims: Object.fromEntries(COMMANDS.map(name => [name, sha256(commands[name])])) };
  const previous = state?.current === version ? state.previous : state?.current;
  const changes = COMMANDS.map(name => ({ path: join(binDir, name), after: fileImage(commands[name], 0o755) }));
  changes.push({ path: join(root, 'install.json'), after: fileImage(Buffer.from(JSON.stringify(owner, null, 2) + '\n')) });
  changes.push({ path: join(root, RECONNECT_MARKER), after: fileImage(Buffer.from(`${version}\n`)) });
  if (previous) changes.push({ path: join(root, 'previous'), after: linkImage(previous) });
  changes.push({ path: join(root, 'current'), after: linkImage(version) });
  try { await transaction(root, changes); }
  catch (error) {
    if (error.code === 'RECOVERY_REQUIRED') throw error;
    if (created) {
      try {
        for (const name of ['current', 'previous']) {
          const s = await stat(join(root, name));
          if (s && (!s.isSymbolicLink() || await fs.readlink(join(root, name)) === `releases/v${version}`)) throw new Error('Release is still referenced');
        }
        await installedRelease(root, version, identity); await fs.rm(dir, { recursive: true });
      }
      catch { throw fail('RECOVERY_REQUIRED', 'Install failed; an inactive release was retained for manual recovery'); }
    }
    throw error;
  }
  return { changed: true, previous: previous ?? null };
}

export async function main(argv) {
  const emit = value => console.log(JSON.stringify(value));
  try {
    if (Number(process.versions.node.split('.')[0]) < 22 || !['darwin', 'linux'].includes(process.platform)) throw fail('PREREQUISITE', 'Bash installer requires macOS/Linux and Node.js >=22');
    let values;
    try {
      ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
        version: { type: 'string' }, 'release-url': { type: 'string' }, archive: { type: 'string' }, sha256: { type: 'string' },
        prefix: { type: 'string' }, 'bin-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, status: { type: 'boolean' },
        rollback: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, 'allow-loopback-http': { type: 'boolean' }, help: { type: 'boolean' },
      } }));
    } catch { throw fail('INVALID_ARGUMENT', 'Invalid arguments; use --help'); }
    if (values.help) { console.log(HELP); return 0; }
    const version = values.version ?? BUILD_VERSION;
    if (!VERSION.test(version ?? '')) throw fail('INVALID_ARGUMENT', 'A fixed release version is required');
    const modes = [values.status, values.rollback, Boolean(values.archive), Boolean(values['release-url'])].filter(Boolean).length;
    if (modes !== 1 || (values.sha256 && !values.archive)) throw fail('INVALID_ARGUMENT', 'Select exactly one of --status, --rollback, --archive, --release-url');
    const home = process.env.HOME ?? homedir();
    const root = values.prefix ?? join(home, '.local/share', APP, 'runtime');
    await checkDirectory(root);
    if (resolve(root) !== root) throw fail('INVALID_ARGUMENT', 'Use a normalized absolute runtime root');
    const state = await readState(root);
    const binDir = values['bin-dir'] ?? state?.owner.binDir ?? join(home, '.local/bin');
    await checkDirectory(binDir);
    if (resolve(binDir) !== binDir) throw fail('INVALID_ARGUMENT', 'Use a normalized absolute command directory');
    if (binDir === root || binDir.startsWith(root + '/')) throw fail('INVALID_ARGUMENT', 'Command directory must be outside the immutable runtime root');
    if (values.status) {
      const pending = state ? await reconnectPending(root) : null;
      emit({ ok: true, action: 'status', installed: Boolean(state), version: state?.current ?? null, previous: state?.previous ?? null, root, binDir,
        reconnectRequired: pending !== null, ...(typeof pending === 'string' ? { reconnectVersion: pending } : {}),
        verification: 'installed-files-and-commands' });
      return 0;
    }
    const timeout = Number(values['timeout-ms'] ?? 30000);
    if (!Number.isInteger(timeout) || timeout < 500 || timeout > 120000) throw fail('INVALID_ARGUMENT', 'Network deadline must be 500..120000 ms');
    if (values.rollback) {
      if (!state?.previous) throw fail('NO_PREVIOUS_RELEASE', 'There is no verified previous release');
      if (values['dry-run']) { emit({ ok: true, action: 'rollback', dryRun: true, version: state.previous, root }); return 0; }
      await withLock(root, async () => {
        const latest = await readState(root);
        if (JSON.stringify(latest) !== JSON.stringify(state)) throw fail('CONCURRENT_CHANGE', 'Runtime changed before rollback');
        await transaction(root, [
          { path: join(root, 'previous'), after: linkImage(state.current) },
          { path: join(root, 'current'), after: linkImage(state.previous) },
          { path: join(root, RECONNECT_MARKER), after: fileImage(Buffer.from(`${state.previous}\n`)) },
        ]);
      });
      emit({ ok: true, action: 'rollback', version: state.previous, previous: state.current, root, reconnectRequired: true });
      return 0;
    }
    if (state && state.owner.binDir !== binDir) throw fail('OWNERSHIP_CONFLICT', 'Existing command directory does not match');
    if (!state) for (const name of COMMANDS) if (await stat(join(binDir, name))) throw fail('OWNERSHIP_CONFLICT', 'Existing command is not owned by this runtime');
    if (values['release-url']) releaseURL(values['release-url'], version, values['allow-loopback-http']);
    if (values.archive && !values.sha256) throw fail('INVALID_ARGUMENT', '--archive requires --sha256');
    if (values['dry-run'] && !values.archive) {
      emit({ ok: true, action: 'install', dryRun: true, version, root, binDir, artifactVerified: false, note: 'No download or filesystem mutation performed' }); return 0;
    }
    const release = await incoming(values, version, timeout);
    const known = state?.owner.releases[version];
    if (known && known.archiveSha256 !== release.archiveSha256) throw fail('VERSION_CONFLICT', 'A published version cannot be replaced');
    if (values['dry-run']) { emit({ ok: true, action: 'install', dryRun: true, version, root, binDir, artifactVerified: true }); return 0; }
    const result = await withLock(root, async () => {
      const latest = await readState(root);
      if (JSON.stringify(latest) !== JSON.stringify(state)) throw fail('CONCURRENT_CHANGE', 'Runtime changed before install');
      return install(root, binDir, state, release, version);
    });
    emit({ ok: true, action: 'install', version, root, binDir, ...result, registeredHosts: false, reconnectRequired: result.changed });
    return 0;
  } catch (error) {
    const timedOut = ['TimeoutError', 'AbortError'].includes(error.name);
    const code = timedOut ? 'DOWNLOAD_TIMEOUT' : typeof error.code === 'string' ? error.code : 'INSTALL_FAILED';
    const own = ['INVALID_ARGUMENT', 'INVALID_URL', 'SHA_MISMATCH', 'BAD_CHECKSUMS', 'DOWNLOAD_FAILED', 'UNSAFE_PATH', 'CONCURRENT_CHANGE',
      'SOURCE_TREE', 'OWNERSHIP_CONFLICT', 'MODIFIED_RELEASE', 'VERSION_CONFLICT', 'NO_PREVIOUS_RELEASE', 'LOCKED', 'RECOVERY_REQUIRED', 'PREREQUISITE'];
    let message = timedOut ? 'Release download exceeded its deadline; installed runtime was not changed'
      : own.includes(code) ? error.message : 'Installer failed; check prerequisites, permissions and release integrity';
    const token = process.env.CCW_RELEASE_TOKEN;
    if (token) message = message.replaceAll(token, '[redacted]');
    emit({ ok: false, error: { code, message } });
    return 1;
  }
}

if (BUILD_VERSION) process.exitCode = await main(process.argv.slice(2));
