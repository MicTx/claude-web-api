import { createHash } from 'node:crypto';
import { parseStrictJson } from './design-probe-json.mjs';

const MAX_BODY = 256 * 1024;
const MAX_EVENTS = 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[\x21-\x7e]{1,128}$/;
const CDP_ID = /^[\x21-\x7e]{1,128}$/;
const QUERY_KEYS = new Set(['org', 'via', 'bk', 'actor', 'vt', 'rw']);

function unavailable(reason = 'unverified') {
  return { kind: 'claim', status: 'unverified', reason };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validScope(scope) {
  return scope && typeof scope === 'object' && !Array.isArray(scope)
    && typeof scope.sessionId === 'string' && CDP_ID.test(scope.sessionId)
    && typeof scope.mainFrameId === 'string' && CDP_ID.test(scope.mainFrameId)
    && typeof scope.loaderId === 'string' && CDP_ID.test(scope.loaderId)
    && typeof scope.orgId === 'string' && UUID.test(scope.orgId)
    && typeof scope.frameUuid === 'string' && UUID.test(scope.frameUuid);
}

function acceptedUrl(raw, scope) {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('https://claude.ai/')
    || /[\x00-\x20\x7f\\#]/u.test(raw)) return false;
  const question = raw.indexOf('?');
  const path = question === -1 ? raw : raw.slice(0, question);
  if (!/^https:\/\/claude\.ai\/api\/frame\/[a-f0-9-]{36}$/i.test(path)) return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:' || url.hostname !== 'claude.ai' || url.port || url.username || url.password || url.hash
    || url.pathname.toLowerCase() !== `/api/frame/${scope.frameUuid.toLowerCase()}`) return false;
  const keys = [...url.searchParams.keys()];
  return keys.length <= QUERY_KEYS.size && new Set(keys).size === keys.length
    && keys.every(key => QUERY_KEYS.has(key)) && url.searchParams.getAll('org').length === 1
    && url.searchParams.get('org')?.toLowerCase() === scope.orgId.toLowerCase();
}

function acceptableLength(headers, maximum = MAX_BODY) {
  if (headers === undefined || headers === null) return true;
  if (typeof headers !== 'object' || Array.isArray(headers)) return false;
  const keys = Object.keys(headers).filter(key => key.toLowerCase() === 'content-length');
  if (keys.length === 0) return true;
  if (keys.length !== 1) return false;
  const value = headers[keys[0]];
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value);
  return /^\d{1,12}$/.test(text) && Number(text) > 0 && Number(text) <= maximum;
}

function expectedShape(expected) {
  return expected && typeof expected === 'object' && !Array.isArray(expected)
    && typeof expected.version === 'string' && VERSION.test(expected.version)
    && Number.isSafeInteger(expected.size) && expected.size > 0 && expected.size <= 2 * 1024 * 1024
    && typeof expected.sha256 === 'string' && SHA256.test(expected.sha256);
}

function claimFromBody(bytes, expected) {
  try {
    if (!expectedShape(expected) || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BODY) return unavailable('metadata');
    const data = parseStrictJson(bytes, { rejectPrototypeKeys: true });
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || typeof data.ver !== 'string' || !VERSION.test(data.ver)
      || !Number.isSafeInteger(data.seq) || data.seq < 1
      || !Array.isArray(data.history) || data.history.length < 1 || data.history.length > 256
      || data.history.some(version => typeof version !== 'string' || !VERSION.test(version))
      || new Set(data.history).size !== data.history.length
      || !data.history.includes(data.ver) || data.fileCount !== 1
      || !Array.isArray(data.files) || data.files.length !== 1) return unavailable('metadata');
    const file = data.files[0];
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.path !== 'index.html'
      || typeof file.contentType !== 'string' || file.contentType.split(';')[0].trim().toLowerCase() !== 'text/html'
      || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 2 * 1024 * 1024
      || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) return unavailable('metadata');
    const claimMatchesExpected = data.ver === expected.version && file.size === expected.size && file.sha256 === expected.sha256;
    return {
      kind: 'claim', status: claimMatchesExpected ? 'matched' : 'mismatch', claimMatchesExpected,
      version: data.ver, sequence: data.seq,
      file: { path: 'index.html', contentType: 'text/html', size: file.size, serverClaimedSha256: file.sha256 },
    };
  } catch {
    return unavailable('metadata');
  }
}

export class SourceClaimCapture {
  #scope;
  #candidate = null;
  #invalid = false;
  #reading = false;
  #events = 0;

  constructor(scope) {
    try {
      const candidate = { sessionId: scope.sessionId, mainFrameId: scope.mainFrameId, loaderId: scope.loaderId,
        orgId: scope.orgId, frameUuid: scope.frameUuid };
      if (!validScope(candidate)) throw new Error('invalid');
      this.#scope = Object.freeze(candidate);
    } catch {
      throw new TypeError('Invalid capture scope');
    }
  }

  get status() {
    return this.#invalid ? 'unverified' : this.#candidate?.complete ? 'ready' : 'pending';
  }

  invalidate() {
    this.#invalid = true;
  }

  observe(event) {
    try {
      if (!event || typeof event !== 'object' || this.#invalid) return;
      if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === this.#scope.sessionId) {
        this.#invalid = true;
        return;
      }
      if (event.sessionId !== this.#scope.sessionId) return;
      if (event.method === 'Network.requestWillBeSentExtraInfo' || event.method === 'Network.responseReceivedExtraInfo') return;
      if (++this.#events > MAX_EVENTS) { this.#invalid = true; return; }
      const params = event.params ?? {};
      if (event.method === 'Page.frameNavigated' && params.frame?.id === this.#scope.mainFrameId) {
        this.#invalid = true;
      } else if (event.method === 'Page.frameDetached' && params.frameId === this.#scope.mainFrameId) {
        this.#invalid = true;
      } else if (event.method === 'Network.requestWillBeSent') {
        if (this.#candidate && params.requestId === this.#candidate.id) { this.#invalid = true; return; }
        if (params.frameId !== this.#scope.mainFrameId || params.loaderId !== this.#scope.loaderId
          || params.request?.method !== 'GET' || !acceptedUrl(params.request?.url, this.#scope)) return;
        if (params.redirectResponse !== undefined || !CDP_ID.test(params.requestId ?? '') || this.#candidate) {
          this.#invalid = true;
          return;
        }
        this.#candidate = { id: params.requestId, urlHash: hash(params.request.url), response: false, complete: false, received: 0 };
      } else if (this.#candidate && params.requestId === this.#candidate.id) {
        if (event.method === 'Network.requestServedFromCache' || event.method === 'Network.loadingFailed') {
          this.#invalid = true;
        } else if (event.method === 'Network.responseReceived') {
          const response = params.response;
          if (this.#candidate.response || params.frameId !== this.#scope.mainFrameId || params.loaderId !== this.#scope.loaderId
            || !response || response.status !== 200 || typeof response.mimeType !== 'string'
            || response.mimeType.split(';')[0].trim().toLowerCase() !== 'application/json'
            || response.fromDiskCache === true || response.fromPrefetchCache === true || response.fromServiceWorker === true
            || !acceptedUrl(response.url, this.#scope) || hash(response.url) !== this.#candidate.urlHash
            || !acceptableLength(response.headers)) this.#invalid = true;
          else this.#candidate.response = true;
        } else if (event.method === 'Network.dataReceived') {
          if (!this.#candidate.response || this.#candidate.complete || !Number.isSafeInteger(params.dataLength) || params.dataLength < 0
            || this.#candidate.received + params.dataLength > MAX_BODY) this.#invalid = true;
          else this.#candidate.received += params.dataLength;
        } else if (event.method === 'Network.loadingFinished') {
          if (!this.#candidate.response || this.#candidate.complete || this.#candidate.received < 1) this.#invalid = true;
          else this.#candidate.complete = true;
        }
      }
    } catch {
      this.#invalid = true;
    }
  }

  async claim(expected, readBody, verifyScope) {
    let pinnedExpected;
    try {
      const candidate = { version: expected.version, size: expected.size, sha256: expected.sha256 };
      if (this.#invalid || this.#reading || !this.#candidate?.complete || !expectedShape(candidate)
        || typeof readBody !== 'function' || typeof verifyScope !== 'function') return unavailable('capture');
      pinnedExpected = candidate;
    } catch {
      return unavailable('capture');
    }
    this.#reading = true;
    try {
      if (await verifyScope() !== true || this.#invalid) return unavailable('capture');
      const result = await readBody(this.#candidate.id);
      const body = result?.body;
      const base64Encoded = result?.base64Encoded;
      if (this.#invalid || typeof body !== 'string' || typeof base64Encoded !== 'boolean') return unavailable('body');
      let bytes;
      if (base64Encoded) {
        if (body.length > Math.ceil(MAX_BODY / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) return unavailable('body');
        bytes = Buffer.from(body, 'base64');
        if (bytes.toString('base64') !== body) return unavailable('body');
      } else {
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY) return unavailable('body');
        bytes = Buffer.from(body, 'utf8');
        if (bytes.toString('utf8') !== body) return unavailable('body');
      }
      if (await verifyScope() !== true || this.#invalid) return unavailable('capture');
      return claimFromBody(bytes, pinnedExpected);
    } catch {
      return unavailable('body');
    }
  }
}

function acceptedSourceUrl(raw, target) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x20\x7f\\#]/u.test(raw)) return false;
  const host = `${target.frameId.toLowerCase()}.frame.claudeusercontent.com`;
  if (!raw.startsWith(`https://${host}/`)) return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  const keys = [...url.searchParams.keys()];
  return url.protocol === 'https:' && url.hostname === host && !url.port && !url.username && !url.password && !url.hash
    && url.pathname === `/_f/${target.version}/_src/index.html` && keys.length === 1 && keys[0] === '__frame_t';
}

export class SourceByteCapture {
  #scope;
  #target;
  #candidate = null;
  #invalid = false;
  #reading = false;
  #events = 0;

  constructor(scope, target) {
    try {
      const candidate = { sessionId: scope.sessionId, mainFrameId: scope.mainFrameId };
      const approved = { frameId: target.frameId, version: target.version, size: target.size, sha256: target.sha256 };
      if (typeof candidate.sessionId !== 'string' || !CDP_ID.test(candidate.sessionId)
        || typeof candidate.mainFrameId !== 'string' || !CDP_ID.test(candidate.mainFrameId)
        || typeof approved.frameId !== 'string' || !UUID.test(approved.frameId)
        || typeof approved.version !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(approved.version)
        || !Number.isSafeInteger(approved.size) || approved.size < 1 || approved.size > 2 * 1024 * 1024
        || typeof approved.sha256 !== 'string' || !SHA256.test(approved.sha256)) throw new Error('invalid');
      this.#scope = Object.freeze(candidate);
      this.#target = Object.freeze(approved);
    } catch {
      throw new TypeError('Invalid capture scope');
    }
  }

  get status() {
    return this.#invalid ? 'unverified' : this.#candidate?.complete ? 'ready' : 'pending';
  }

  invalidate() {
    this.#invalid = true;
  }

  observe(event) {
    try {
      if (!event || typeof event !== 'object' || this.#invalid) return;
      if (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === this.#scope.sessionId) {
        this.#invalid = true;
        return;
      }
      if (event.sessionId !== this.#scope.sessionId) return;
      if (event.method === 'Network.requestWillBeSentExtraInfo' || event.method === 'Network.responseReceivedExtraInfo') return;
      if (++this.#events > MAX_EVENTS) { this.#invalid = true; return; }
      const params = event.params ?? {};
      if (event.method === 'Page.frameNavigated' && params.frame?.id === this.#scope.mainFrameId) this.#invalid = true;
      else if (event.method === 'Page.frameDetached' && (params.frameId === this.#scope.mainFrameId || params.frameId === this.#candidate?.frameId)) this.#invalid = true;
      else if (event.method === 'Network.requestWillBeSent') {
        if (this.#candidate && params.requestId === this.#candidate.id) { this.#invalid = true; return; }
        if (params.request?.method !== 'GET' || !acceptedSourceUrl(params.request?.url, this.#target)) return;
        if (params.redirectResponse !== undefined || typeof params.requestId !== 'string' || !CDP_ID.test(params.requestId)
          || typeof params.frameId !== 'string' || !CDP_ID.test(params.frameId)
          || typeof params.loaderId !== 'string' || !CDP_ID.test(params.loaderId) || this.#candidate) { this.#invalid = true; return; }
        this.#candidate = { id: params.requestId, frameId: params.frameId, loaderId: params.loaderId,
          urlHash: hash(params.request.url), response: false, complete: false, received: 0 };
      } else if (this.#candidate && params.requestId === this.#candidate.id) {
        if (event.method === 'Network.requestServedFromCache' || event.method === 'Network.loadingFailed') this.#invalid = true;
        else if (event.method === 'Network.responseReceived') {
          const response = params.response;
          const mime = typeof response?.mimeType === 'string' ? response.mimeType.split(';')[0].trim().toLowerCase() : '';
          if (this.#candidate.response || params.frameId !== this.#candidate.frameId || params.loaderId !== this.#candidate.loaderId
            || !response || response.status !== 200 || !['text/html', 'text/plain', 'application/octet-stream'].includes(mime)
            || response.fromDiskCache === true || response.fromPrefetchCache === true || response.fromServiceWorker === true
            || !acceptedSourceUrl(response.url, this.#target) || hash(response.url) !== this.#candidate.urlHash
            || !acceptableLength(response.headers, this.#target.size)) this.#invalid = true;
          else this.#candidate.response = true;
        } else if (event.method === 'Network.dataReceived') {
          if (!this.#candidate.response || this.#candidate.complete || !Number.isSafeInteger(params.dataLength) || params.dataLength < 0
            || this.#candidate.received + params.dataLength > this.#target.size) this.#invalid = true;
          else this.#candidate.received += params.dataLength;
        } else if (event.method === 'Network.loadingFinished') {
          if (!this.#candidate.response || this.#candidate.complete || this.#candidate.received < 1) this.#invalid = true;
          else this.#candidate.complete = true;
        }
      }
    } catch {
      this.#invalid = true;
    }
  }

  async check(manifest, readBody, pageHash, verifyScope) {
    try {
      if (this.#invalid || this.#reading || !this.#candidate?.complete || manifest?.kind !== 'claim'
        || manifest.status !== 'matched' || manifest.file?.serverClaimedSha256 !== this.#target.sha256
        || manifest.file?.size !== this.#target.size || manifest.version !== this.#target.version
        || typeof readBody !== 'function' || typeof pageHash !== 'function' || typeof verifyScope !== 'function') return { kind: 'byte-check', status: 'unverified' };
    } catch {
      return { kind: 'byte-check', status: 'unverified' };
    }
    this.#reading = true;
    try {
      if (await verifyScope() !== true || this.#invalid) return { kind: 'byte-check', status: 'unverified' };
      const response = await readBody(this.#candidate.id);
      const body = response?.body;
      const encoded = response?.base64Encoded;
      if (this.#invalid || typeof body !== 'string' || typeof encoded !== 'boolean') return { kind: 'byte-check', status: 'unverified' };
      let bytes;
      if (encoded) {
        if (body.length > Math.ceil(this.#target.size / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) return { kind: 'byte-check', status: 'unverified' };
        bytes = Buffer.from(body, 'base64');
        if (bytes.toString('base64') !== body) return { kind: 'byte-check', status: 'unverified' };
      } else {
        if (Buffer.byteLength(body, 'utf8') > this.#target.size) return { kind: 'byte-check', status: 'unverified' };
        bytes = Buffer.from(body, 'utf8');
        if (bytes.toString('utf8') !== body) return { kind: 'byte-check', status: 'unverified' };
      }
      const localHash = hash(bytes);
      if (bytes.length !== this.#target.size || localHash !== this.#target.sha256) return { kind: 'byte-check', status: 'mismatch' };
      if (await verifyScope() !== true || this.#invalid) return { kind: 'byte-check', status: 'unverified' };
      const browserHash = await pageHash(bytes);
      if (await verifyScope() !== true || this.#invalid || browserHash !== localHash) return { kind: 'byte-check', status: 'unverified' };
      return { kind: 'byte-check', status: 'matched', size: bytes.length, sha256: localHash };
    } catch {
      return { kind: 'byte-check', status: 'unverified' };
    }
  }
}
