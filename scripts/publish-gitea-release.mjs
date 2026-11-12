#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { APP } from '../src/identity.mjs';
import { VERSION, sha256 } from '../src/release/archive.mjs';
import { assertPublishableContent } from '../src/release/content-scan.mjs';
import { isMainModule } from '../src/is-main.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ASSET = 32 * 1024 * 1024;
const MAX_API_RESPONSE = 1024 * 1024;
const EXPECTED_ASSETS = version => [`${APP}-v${version}.tar.gz`, 'SHA256SUMS', 'install.sh'];
const TOKEN_RE = /^[\x21-\x7e]{1,8192}$/;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_RELEASE_NOTES = 64 * 1024;

export class PublishError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => { throw new PublishError(code, message, details); };

export function parseRepo(value) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) fail('INVALID_ARGUMENT', 'Use --repo OWNER/REPO');
  return value;
}

export function parseApiBase(value) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ARGUMENT', '--api-base must be a valid URL'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    fail('INVALID_ARGUMENT', '--api-base must be HTTPS without userinfo, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function validateToken(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
    fail('CREDENTIALS', 'A release token must be a non-empty printable token');
  }
  return token;
}

export async function resolveToken({ env, tokenFile }) {
  if (tokenFile !== undefined && env.CCW_RELEASE_TOKEN !== undefined) {
    fail('CREDENTIALS', 'Use either CCW_RELEASE_TOKEN or --token-file, not both');
  }
  if (tokenFile !== undefined) {
    const path = resolve(tokenFile);
    const stat = await fs.lstat(path).catch(error => {
      if (error.code === 'ENOENT') fail('CREDENTIALS', 'Token file does not exist');
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 8192) {
      fail('CREDENTIALS', 'Token file must be a bounded regular file');
    }
    if ((stat.mode & 0o077) !== 0) fail('CREDENTIALS', 'Token file must not be readable by group or others');
    const bytes = await fs.readFile(path);
    const text = bytes.toString('utf8').replace(/\r?\n$/, '');
    return validateToken(text);
  }
  return validateToken(env.CCW_RELEASE_TOKEN);
}

// Git credential helper is an explicit opt-in fallback: never used unless the
// caller passes --credential-helper and no CCW_RELEASE_TOKEN/--token-file is
// present. The helper receives only protocol+host; its stdout is parsed for a
// password line and never echoed, logged or placed in an error message.
function helperHost(apiBase) {
  const url = parseApiBase(apiBase);
  const u = new URL(url);
  return { host: u.hostname, port: u.port };
}

export function credentialFromGitHelper({ apiBase, execImpl = execFile } = {}) {
  const { host, port } = helperHost(apiBase);
  const query = `protocol=https\nhost=${host}\n${port ? `port=${port}\n` : ''}\n`;
  return new Promise((resolvePromise, reject) => {
    const child = execImpl('git', ['credential', 'fill'], {
      timeout: 5000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error) return reject(new PublishError('CREDENTIALS', 'git credential helper failed or timed out'));
      const fields = new Map();
      for (const line of stdout.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
      }
      const password = fields.get('password');
      if (typeof password !== 'string' || !password) {
        return reject(new PublishError('CREDENTIALS', 'git credential helper returned no password'));
      }
      resolvePromise(validateToken(password));
    });
    child.stdin?.on('error', () => {});
    child.stdin?.write(query);
    child.stdin?.end();
  });
}

function requestPath(apiBase, repo, suffix) {
  const [owner, name] = repo.split('/');
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

function parseResponse(bytes, status, url) {
  if (bytes.length > MAX_API_RESPONSE) fail('RESPONSE_TOO_LARGE', 'Gitea response exceeds 1 MiB', { url });
  if (bytes.length === 0) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('RESPONSE_INVALID', 'Gitea returned invalid JSON', { url, status }); }
}

async function giteaRequest(url, { token, method = 'GET', body, fetchImpl = globalThis.fetch, expected = [200] } = {}) {
  const response = await fetchImpl(url, {
    method,
    redirect: 'manual',
    headers: {
      authorization: `token ${token}`,
      accept: 'application/json',
      ...(body ? { 'content-type': method === 'POST' && url.includes('/assets?') ? 'application/octet-stream' : 'application/json' } : {}),
    },
    ...(body ? { body } : {}),
  });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_API_RESPONSE) {
      await response.body?.cancel();
      fail('RESPONSE_TOO_LARGE', 'Gitea response exceeds 1 MiB', { url });
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (!expected.includes(response.status)) {
    fail('GITEA_API', `Gitea request failed with HTTP ${response.status}`, { url, status: response.status });
  }
  const data = parseResponse(bytes, response.status, url);
  return response.status === 404 ? null : data;
}

export async function loadReleaseAssets(assetDir, version) {
  if (!VERSION.test(version)) fail('INVALID_ARGUMENT', 'Release version is invalid');
  const dir = resolve(assetDir);
  const names = EXPECTED_ASSETS(version);
  const files = new Map();
  for (const name of names) {
    const path = join(dir, name);
    const stat = await fs.lstat(path).catch(error => {
      if (error.code === 'ENOENT') fail('ASSET_MISSING', `Release asset is missing: ${name}`);
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET) fail('ASSET_UNSAFE', `Release asset is not a bounded regular file: ${name}`);
    files.set(name, await fs.readFile(path));
  }
  const entries = (await fs.readdir(dir)).filter(name => !name.startsWith('.')).sort();
  if (entries.some(name => !names.includes(name))) fail('ASSET_UNEXPECTED', 'Release directory contains an asset outside the allowlist');
  const sums = files.get('SHA256SUMS').toString('utf8');
  for (const name of names.filter(name => name !== 'SHA256SUMS')) {
    const expected = `${sha256(files.get(name))}  ${name}`;
    if (!sums.split(/\r?\n/).includes(expected)) fail('SHA_MISMATCH', `SHA256SUMS does not match ${name}`);
  }
  return { files, names };
}

export async function loadReleaseNotes(path) {
  if (path === undefined) return '';
  const resolved = resolve(path);
  const stat = await fs.lstat(resolved).catch(error => {
    if (error.code === 'ENOENT') fail('NOTES_MISSING', 'Release notes file does not exist');
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RELEASE_NOTES) {
    fail('NOTES_UNSAFE', 'Release notes must be a bounded regular file');
  }
  const bytes = await fs.readFile(resolved);
  let notes;
  try { notes = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('NOTES_UNSAFE', 'Release notes must be valid UTF-8'); }
  if (bytes.includes(0) || notes.length > MAX_RELEASE_NOTES) fail('NOTES_UNSAFE', 'Release notes are not bounded UTF-8 text');
  try { assertPublishableContent([{ path: resolved, bytes }]); }
  catch (error) { fail('NOTES_UNSAFE', error.message); }
  return notes;
}

export async function publishGiteaRelease({
  apiBase, repo, tag, version, assetDir, token, notes = '',
  fetchImpl = globalThis.fetch,
}) {
  const base = parseApiBase(apiBase);
  const slug = parseRepo(repo);
  const releaseToken = validateToken(token);
  if (typeof notes !== 'string' || notes.length > MAX_RELEASE_NOTES) fail('NOTES_UNSAFE', 'Release notes are not bounded text');
  if (tag !== `v${version}` || !VERSION.test(version)) fail('INVALID_ARGUMENT', 'Use --version X --tag vX');
  const { files, names } = await loadReleaseAssets(assetDir, version);
  const releaseUrl = requestPath(base, slug, `/releases/tags/${encodeURIComponent(tag)}`);
  let release = await giteaRequest(releaseUrl, { token: releaseToken, fetchImpl, expected: [200, 404] });
  if (release && release.id === undefined) fail('GITEA_API', 'Gitea tag lookup returned no release identity');
  if (!release) {
    release = await giteaRequest(requestPath(base, slug, '/releases'), {
      token: releaseToken,
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: `v${version}`, body: notes }),
      fetchImpl,
      expected: [201],
    }).catch(error => {
      if (error instanceof PublishError && error.details?.status === 409) return null;
      throw error;
    });
    if (!release) release = await giteaRequest(releaseUrl, { token: releaseToken, fetchImpl, expected: [200] });
    if (!release || release.id === undefined) fail('GITEA_API', 'Gitea did not return a release identity after creation');
  }
  const uploaded = [];
  for (const name of names) {
    const body = files.get(name);
    const url = requestPath(base, slug, `/releases/${encodeURIComponent(release.id)}/assets?name=${encodeURIComponent(name)}`);
    const result = await giteaRequest(url, {
      token: releaseToken, method: 'POST', body: new Uint8Array(body), fetchImpl, expected: [201],
    }).catch(error => {
      if (error instanceof PublishError && error.details?.status === 409) return null;
      throw error;
    });
    if (result && result.name !== undefined && result.name !== name) fail('GITEA_API', 'Gitea uploaded an asset under a different name');
    if (result && result.size !== undefined && result.size !== body.length) fail('GITEA_API', 'Gitea uploaded an asset with the wrong size');
    uploaded.push(name);
  }
  return {
    ok: true, apiBase: base, repo: slug, tag, version, releaseId: release.id, releaseNotes: Boolean(notes), assets: uploaded,
    sha256: Object.fromEntries(names.filter(name => name !== 'SHA256SUMS').map(name => [name, sha256(files.get(name))])),
  };
}

function help() {
  return `publish-gitea-release

Usage:
  node scripts/publish-gitea-release.mjs --repo OWNER/REPO --version VERSION --tag vVERSION [options]

Options:
  --api-base URL       Gitea API base (or CCW_GITEA_API_BASE)
  --asset-dir DIR      Built release directory (default dist/releases/vVERSION)
  --notes-file FILE    Bounded UTF-8 Release notes file (empty body by default)
  --token-file FILE    Read the Gitea token from a 0600 file instead of the environment
  --credential-helper  Fall back to 'git credential fill' when no explicit token is set
  --dry-run            Validate the allowlist and SHA256SUMS without network access
  --help               Show this help

  CCW_RELEASE_TOKEN or --token-file supplies the token; --credential-helper is the
  only opt-in fallback to 'git credential fill' and is never used by default. The
  token is never printed.
`;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let values;
  let activeToken;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'api-base': { type: 'string' },
        repo: { type: 'string' },
        version: { type: 'string' },
        tag: { type: 'string' },
        'asset-dir': { type: 'string' },
        'notes-file': { type: 'string' },
        'token-file': { type: 'string' },
        'credential-helper': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
    if (values.help) {
      process.stdout.write(help());
      return 0;
    }
    const pkg = JSON.parse(await fs.readFile(join(ROOT, 'package.json'), 'utf8'));
    const version = values.version ?? pkg.version;
    const tag = values.tag ?? `v${version}`;
    const assetDir = values['asset-dir'] ?? join(ROOT, 'dist', 'releases', `v${version}`);
    const apiBase = values['api-base'] ?? env.CCW_GITEA_API_BASE;
    if (!apiBase) fail('INVALID_ARGUMENT', 'Provide --api-base or CCW_GITEA_API_BASE');
    const repo = parseRepo(values.repo);
    if (!VERSION.test(version) || tag !== `v${version}`) fail('INVALID_ARGUMENT', 'Use --version X --tag vX');
    const assets = await loadReleaseAssets(assetDir, version);
    const notes = await loadReleaseNotes(values['notes-file']);
    if (values['dry-run']) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun: true, artifactVerified: true, version, tag,
        assets: assets.names, releaseNotes: Boolean(notes) }) + '\n');
      return 0;
    }
    if (values['credential-helper'] && (env.CCW_RELEASE_TOKEN !== undefined || values['token-file'] !== undefined)) {
      fail('CREDENTIALS', 'Use either CCW_RELEASE_TOKEN/--token-file or --credential-helper, not both');
    }
    activeToken = values['credential-helper']
      ? await credentialFromGitHelper({ apiBase })
      : await resolveToken({ env, tokenFile: values['token-file'] });
    const result = await publishGiteaRelease({ apiBase, repo, tag, version, assetDir, token: activeToken, notes });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    return 0;
  } catch (error) {
    const code = error instanceof PublishError ? error.code : 'PUBLISH_FAILED';
    const message = error instanceof PublishError ? error.message : error.message;
    const token = activeToken ?? env.CCW_RELEASE_TOKEN;
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message: token ? message.replaceAll(token, '[redacted]') : message } }) + '\n');
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
