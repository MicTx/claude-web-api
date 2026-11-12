import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BridgeError } from './errors.mjs';
import { CdpClient } from './cdp.mjs';

const MAX_ACTIVE_PORT_BYTES = 4096;
const MAX_ORGANIZATIONS_BYTES = 512 * 1024;
const LOOPBACK_ADDRESSES = new Set(['', '127.0.0.1', 'localhost', '::1', '[::1]']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const execFileAsync = promisify(execFile);

function argumentValue(args, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index++) {
    if (args[index].startsWith(prefix)) return args[index].slice(prefix.length);
    if (args[index] === `--${name}` && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  }
  return null;
}

function hasArgument(args, name) {
  return args.some((arg, index) => arg === `--${name}`
    || arg.startsWith(`--${name}=`)
    || (arg === `--${name}` && index < args.length - 1));
}

function isMainBrowser(args) {
  const command = args.join(' ');
  if (!command || hasArgument(args, 'type') || hasArgument(args, 'remote-debugging-pipe')) return false;
  return /(?:^|[/\\ ])(?:google[- ]chrome(?:[- ](?:stable|beta|dev|unstable|canary))?|chromium(?:[- ]browser)?|chrome)(?:\.exe)?(?:$|\s)/i.test(command);
}

function validPort(raw) {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

function activePortPath({ args, home, platform }) {
  const explicit = argumentValue(args, 'user-data-dir');
  if (explicit) return join(explicit, 'DevToolsActivePort');
  const command = args.join(' ').toLowerCase();
  const channel = command.includes('chromium') ? 'chromium'
    : /google[- ]chrome[- ]canary/.test(command) ? 'canary'
      : /google[- ]chrome[- ]beta/.test(command) ? 'beta'
        : /google[- ]chrome[- ](?:dev|unstable)/.test(command) ? 'dev'
          : 'chrome';
  if (platform === 'darwin') {
    if (channel === 'chromium') return join(home, 'Library', 'Application Support', 'Chromium', 'DevToolsActivePort');
    const dataDir = { chrome: 'Chrome', canary: 'Chrome Canary', beta: 'Chrome Beta', dev: 'Chrome Dev' }[channel];
    return join(home, 'Library', 'Application Support', 'Google', dataDir, 'DevToolsActivePort');
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    if (channel === 'chromium') return join(localAppData, 'Chromium', 'User Data', 'DevToolsActivePort');
    if (channel === 'canary') return join(localAppData, 'Google', 'Chrome SxS', 'User Data', 'DevToolsActivePort');
    return join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
  }
  const dataDir = {
    chrome: 'google-chrome', canary: 'google-chrome-canary', beta: 'google-chrome-beta',
    dev: 'google-chrome-unstable', chromium: 'chromium',
  }[channel];
  return join(home, '.config', dataDir, 'DevToolsActivePort');
}

async function readActivePort(path) {
  let handle;
  try {
    const initial = await fs.lstat(path, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_ACTIVE_PORT_BYTES) return null;
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat({ bigint: true });
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    if (size !== Number(before.size)
      || [initial, after, named].some(stat => stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size)) return null;
    const port = validPort(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)).split(/\r?\n/, 1)[0]?.trim() ?? '');
    return port;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function defaultProcessEntries() {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-axo', 'pid=,args='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split('\n').map(line => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), args: match[2].split(/\s+/) } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function pageOrganizationProbe(client, targetId, config, signal) {
  const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }, {
    signal,
    timeoutMs: config.readyTimeoutMs,
  });
  const expression = `(async()=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),${config.readyTimeoutMs});
try{const r=await fetch('/api/organizations',{credentials:'same-origin',redirect:'error',signal:c.signal});
const ct=String(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
if(!r.ok||ct!=='application/json')return{ok:false,status:r.status};
const text=await r.text();if(text.length>512*1024)return{ok:false};return{ok:true,value:JSON.parse(text)}}catch{return{ok:false}}finally{clearTimeout(t)}})()`;
  try {
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, { sessionId: attached.sessionId, signal, timeoutMs: config.readyTimeoutMs + 1000 });
    if (result.exceptionDetails) return null;
    const value = result.result?.value;
    if (!value?.ok || !Array.isArray(value.value)) return null;
    const chatOrgs = value.value.filter(org => org && typeof org === 'object' && UUID_RE.test(org.uuid ?? '')
      && Array.isArray(org.capabilities) && org.capabilities.includes('chat'));
    if (config.orgId) return chatOrgs.some(org => org.uuid === config.orgId) ? config.orgId : null;
    return chatOrgs.length === 1 ? chatOrgs[0].uuid : null;
  } finally {
    await client.send('Target.detachFromTarget', { sessionId: attached.sessionId }, { timeoutMs: 1000 }).catch(() => {});
  }
}

async function defaultLoginProbe(cdpUrl, config, signal, { connect = CdpClient.connect } = {}) {
  const client = await connect(cdpUrl, { signal, timeoutMs: config.readyTimeoutMs });
  try {
    const { targetInfos } = await client.send('Target.getTargets', {}, {
      signal,
      timeoutMs: config.readyTimeoutMs,
    });
    for (const target of targetInfos ?? []) {
      if (target.type !== 'page') continue;
      let url;
      try {
        url = new URL(target.url);
      } catch {
        continue;
      }
      if (url.origin !== 'https://claude.ai') continue;
      const orgId = await pageOrganizationProbe(client, target.targetId, config, signal).catch(() => null);
      if (orgId) return { authenticated: true, orgId };
    }
    return { authenticated: false, orgId: null };
  } finally {
    client.close();
  }
}

export async function discoverClaudeBrowser(config, {
  signal,
  processEntries = defaultProcessEntries,
  readDevToolsPort = readActivePort,
  loginProbe = defaultLoginProbe,
} = {}) {
  if (config.cdpUrl) return config.cdpUrl;
  if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');

  const entries = (await processEntries()).filter(({ args }) => isMainBrowser(args));
  const candidates = new Map();
  for (const entry of entries) {
    const address = argumentValue(entry.args, 'remote-debugging-address') ?? '';
    if (!LOOPBACK_ADDRESSES.has(address)) continue;
    const explicit = validPort(argumentValue(entry.args, 'remote-debugging-port') ?? '');
    const port = explicit ?? await readDevToolsPort(activePortPath({ ...entry, home: config.home ?? process.env.HOME, platform: config.platform ?? process.platform }));
    if (port === null) continue;
    const url = `http://127.0.0.1:${port}`;
    if (!candidates.has(url)) candidates.set(url, { url, source: explicit ? 'flag' : 'DevToolsActivePort' });
  }
  if (candidates.size === 0) {
    throw new BridgeError('BROWSER_NOT_FOUND', 'No running Chrome or Chromium with an explicitly open loopback CDP endpoint was found');
  }

  const authenticated = [];
  for (const candidate of candidates.values()) {
    const probe = await loginProbe(candidate.url, config, signal).catch(error => {
      if (signal?.aborted) throw error;
      return null;
    });
    if (probe?.authenticated === true) authenticated.push(candidate);
  }
  if (authenticated.length === 0) {
    throw new BridgeError('BROWSER_NOT_FOUND', 'No discovered Chrome or Chromium CDP endpoint has an accessible logged-in Claude page');
  }
  if (authenticated.length > 1) {
    throw new BridgeError('BROWSER_AMBIGUOUS', 'Multiple logged-in Chrome or Chromium CDP endpoints were found; set CCW_CDP_URL explicitly', {
      endpoints: authenticated.map(candidate => candidate.url),
    });
  }
  return authenticated[0].url;
}

export { MAX_ORGANIZATIONS_BYTES };
