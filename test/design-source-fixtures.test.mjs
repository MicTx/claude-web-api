import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { SourceByteCapture, SourceClaimCapture } from '../scripts/design-probe-source.mjs';

const fixturePath = resolve(import.meta.dirname, 'fixtures/design-source.json');
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const scope = {
  sessionId: 'session-1', mainFrameId: 'frame-1', loaderId: 'loader-1',
  orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', frameUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};
const expected = { version: '1793937601-52f0', size: 625, sha256: '3e2a1161da89e492d2150254d12e852923dba46df8c699b82ee6164b86ae336d' };
const url = `https://claude.ai/api/frame/${scope.frameUuid}?${new URLSearchParams({ org: scope.orgId, ...fixture.requestQuery })}`;
const urlHash = createHash('sha256').update(url).digest('hex');
const responseText = JSON.stringify(fixture.response);

function event(method, params, sessionId = scope.sessionId) {
  return { method, sessionId, params };
}

function request(overrides = {}) {
  return event('Network.requestWillBeSent', {
    requestId: '123.1', frameId: scope.mainFrameId, loaderId: scope.loaderId,
    request: { method: 'GET', url, headers: { Cookie: 'TOKEN_SENTINEL' } }, ...overrides,
  });
}

function response(overrides = {}) {
  return event('Network.responseReceived', {
    requestId: '123.1', frameId: scope.mainFrameId, loaderId: scope.loaderId,
    response: { url, status: 200, mimeType: 'application/json', headers: { 'content-length': String(Buffer.byteLength(responseText)), 'set-cookie': 'TOKEN_SENTINEL' } },
    ...overrides,
  });
}

function data(length = Buffer.byteLength(responseText)) {
  return event('Network.dataReceived', { requestId: '123.1', dataLength: length, data: 'TOKEN_SENTINEL' });
}

function finished() {
  return event('Network.loadingFinished', { requestId: '123.1' });
}

function readyCapture(body = responseText) {
  const capture = new SourceClaimCapture(scope);
  for (const item of [request(), response(), data(Buffer.byteLength(body)), finished()]) capture.observe(item);
  return capture;
}

async function claim(capture, body = responseText, expectedValue = expected) {
  let reads = 0;
  const result = await capture.claim(expectedValue, async identifier => {
    reads++;
    assert.equal(identifier, '123.1');
    return { body, base64Encoded: false };
  }, async () => true);
  return { result, reads };
}

function noSecrets(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /TOKEN_SENTINEL|PRIVATE_SENTINEL|SENTINEL_(?:VIA|BK|ACTOR|VT|RW)|redacted@example\.invalid|claude\.ai\/api/);
  assert.equal(serialized.includes(urlHash), false);
}

test('design source fixture: synthetic metadata remains only a server claim', async () => {
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.derivedFrom, 'evidence.md#E07');
  const { result, reads } = await claim(readyCapture());
  assert.equal(reads, 1);
  assert.deepEqual(result, {
    kind: 'claim', status: 'matched', claimMatchesExpected: true, version: expected.version, sequence: 1,
    file: { path: 'index.html', contentType: 'text/html', size: 625, serverClaimedSha256: expected.sha256 },
  });
  assert.doesNotMatch(Object.keys(result).join(','), /verified|source|bytes/i);
  assert.doesNotMatch(Object.keys(result.file).join(','), /verified|source|bytes/i);
  noSecrets(result);
});

test('design source fixture: strict base64 decoding also yields only a claim', async () => {
  const capture = readyCapture();
  const result = await capture.claim(expected, async () => ({ body: Buffer.from(responseText).toString('base64'), base64Encoded: true }), async () => true);
  assert.equal(result.kind, 'claim');
  assert.equal(result.status, 'matched');
  noSecrets(result);
});

test('design source fixture: mismatched expected version or hash never adopts the latest', async () => {
  for (const alternate of [
    { ...expected, version: 'different-version' },
    { ...expected, size: 624 },
    { ...expected, sha256: 'a'.repeat(64) },
  ]) {
    const { result } = await claim(readyCapture(), responseText, alternate);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.claimMatchesExpected, false);
    noSecrets(result);
  }
});

test('design source fixture: expectations are snapshotted before asynchronous body reads', async () => {
  const capture = readyCapture();
  const changing = { ...expected };
  const pending = capture.claim(changing, async () => {
    changing.sha256 = 'a'.repeat(64);
    changing.version = 'other';
    return { body: responseText, base64Encoded: false };
  }, async () => true);
  assert.equal((await pending).status, 'matched');
});

test('design source fixture: unverified metadata fails closed without disclosing its contents', async () => {
  const cases = [
    body => { body.seq = Number.MAX_SAFE_INTEGER + 1; },
    body => { body.seq = 0; },
    body => { body.ver = 'INVALID VERSION'; },
    body => { body.history = [{ version: body.ver }]; },
    body => { body.history = ['other']; },
    body => { body.history = [body.ver, body.ver]; },
    body => { body.fileCount = 2; },
    body => { body.files = []; },
    body => { body.files.push({ ...body.files[0] }); },
    body => { body.files[0].path = '../index.html'; },
    body => { body.files[0].path = 'i\u0301ndex.html'; },
    body => { body.files[0].size = Number.MAX_SAFE_INTEGER + 1; },
    body => { body.files[0].size = 0.1; },
    body => { body.files[0].size = 0; },
    body => { body.files[0].sha256 = 'TOKEN_SENTINEL'; },
    body => { body.files[0].contentType = 'application/json'; },
  ];
  for (const mutate of cases) {
    const body = structuredClone(fixture.response);
    mutate(body);
    body.untrusted = 'PRIVATE_SENTINEL';
    const text = JSON.stringify(body);
    const { result } = await claim(readyCapture(text), text);
    assert.equal(result.status, 'unverified');
    noSecrets(result);
  }
  const charset = structuredClone(fixture.response);
  charset.files[0].contentType = 'text/html; charset=utf-8';
  const text = JSON.stringify(charset);
  assert.equal((await claim(readyCapture(text), text)).result.status, 'matched');
});

test('design source fixture: duplicate JSON keys and prototype keys are rejected', async () => {
  for (const body of [
    responseText.replace('"ver":', '"ver":"PRIVATE_SENTINEL","\\u0076er":'),
    responseText.replace('{', '{"__proto__":{"token":"TOKEN_SENTINEL"},'),
    '{"ver":"TOKEN_SENTINEL",',
  ]) {
    const { result } = await claim(readyCapture(body), body);
    assert.equal(result.status, 'unverified');
    noSecrets(result);
  }
});

test('design source fixture: body is never requested before matching loadingFinished', async () => {
  for (const sequence of [[], [request()], [request(), response()], [request(), response(), data()]]) {
    const capture = new SourceClaimCapture(scope);
    for (const item of sequence) capture.observe(item);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
});

test('design source fixture: unrelated sessions, frames, loaders and methods cannot nominate a response', async () => {
  const wrongRequests = [
    { ...request(), sessionId: 'other-session' },
    request({ frameId: 'other-frame' }),
    request({ loaderId: 'other-loader' }),
    request({ request: { method: 'POST', url } }),
  ];
  for (const item of wrongRequests) {
    const capture = new SourceClaimCapture(scope);
    for (const next of [item, response(), data(), finished()]) capture.observe(next);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
});

test('design source fixture: unsafe URLs and duplicate query keys are not selected', async () => {
  const unsafe = [
    url.replace('claude.ai/', 'claude.ai.evil.invalid/'),
    url.replace('https://claude.ai/', 'https://user@claude.ai/'),
    url.replace('https://claude.ai/', 'https://claude.ai:443/'),
    url.replace('https://claude.ai/', 'https://claude.ai:8443/'),
    url.replace('/api/frame/', '/api/frame/../frame/'),
    url.replace('/api/frame/', '/api/%2e%2e/api/frame/'),
    `${url}&org=${scope.orgId}`,
    `${url}&unknown=TOKEN_SENTINEL`,
    `${url}#TOKEN_SENTINEL`,
    url.replace(scope.orgId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ];
  for (const value of unsafe) {
    const capture = new SourceClaimCapture(scope);
    capture.observe(request({ request: { method: 'GET', url: value } }));
    for (const next of [response(), data(), finished()]) capture.observe(next);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
    noSecrets(result);
  }
});

test('design source fixture: redirects, duplicate candidates and changed response URLs fail closed', async () => {
  const sequences = [
    [request(), request({ redirectResponse: { status: 302 } })],
    [request(), request({ requestId: '123.2' })],
    [request(), response({ response: { url: `${url}&rw=changed`, status: 200, mimeType: 'application/json' } })],
  ];
  for (const sequence of sequences) {
    const capture = new SourceClaimCapture(scope);
    for (const item of [...sequence, data(), finished()]) capture.observe(item);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
});

test('design source fixture: cache, service worker, failure and 304 are not treated as a fresh claim', async () => {
  const variants = [
    [request(), event('Network.requestServedFromCache', { requestId: '123.1' }), response()],
    [request(), response({ response: { url, status: 200, mimeType: 'application/json', fromDiskCache: true } })],
    [request(), response({ response: { url, status: 200, mimeType: 'application/json', fromPrefetchCache: true } })],
    [request(), response({ response: { url, status: 200, mimeType: 'application/json', fromServiceWorker: true } })],
    [request(), response({ response: { url, status: 304, mimeType: 'application/json' } })],
    [request(), response(), event('Network.loadingFailed', { requestId: '123.1', errorText: 'TOKEN_SENTINEL' })],
  ];
  for (const sequence of variants) {
    const capture = new SourceClaimCapture(scope);
    for (const item of [...sequence, data(), finished()]) capture.observe(item);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
    noSecrets(result);
  }
});

test('design source fixture: decoded transfer and body sizes are bounded independently', async () => {
  for (const length of [256 * 1024 + 1, Number.MAX_SAFE_INTEGER + 1, -1]) {
    const capture = new SourceClaimCapture(scope);
    for (const item of [request(), response(), data(length), finished()]) capture.observe(item);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
  for (const contentLength of ['0', '262145', '-1', 'not-a-number']) {
    const capture = new SourceClaimCapture(scope);
    capture.observe(request());
    capture.observe(response({ response: { url, status: 200, mimeType: 'application/json', headers: { 'Content-Length': contentLength } } }));
    capture.observe(data());
    capture.observe(finished());
    assert.equal((await claim(capture)).reads, 0);
  }
  const oversized = await readyCapture().claim(expected, async () => ({ body: 'a'.repeat(256 * 1024 + 1), base64Encoded: false }), async () => true);
  assert.equal(oversized.status, 'unverified');
});

test('design source fixture: target navigation or detach before and during body reading invalidates the claim', async () => {
  const variants = [
    event('Page.frameNavigated', { frame: { id: scope.mainFrameId } }),
    event('Page.frameDetached', { frameId: scope.mainFrameId }),
    event('Target.detachedFromTarget', { sessionId: scope.sessionId }, 'browser-session'),
  ];
  for (const interruption of variants) {
    const capture = readyCapture();
    capture.observe(interruption);
    const { result, reads } = await claim(capture);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
  const capture = readyCapture();
  const result = await capture.claim(expected, async () => {
    capture.observe(variants[0]);
    return { body: responseText, base64Encoded: false };
  }, async () => true);
  assert.equal(result.status, 'unverified');
  const lost = await readyCapture().claim(expected, async () => ({ body: responseText, base64Encoded: false }), async () => false);
  assert.equal(lost.status, 'unverified');
  let lostReads = 0;
  await readyCapture().claim(expected, async () => { lostReads++; return { body: responseText, base64Encoded: false }; }, async () => false);
  assert.equal(lostReads, 0);
});

test('design source fixture: malformed or failed CDP bodies do not leak or retry', async () => {
  for (const body of [
    { body: '!!!TOKEN_SENTINEL', base64Encoded: true },
    { body: 'AAAA=', base64Encoded: true },
    { body: '\ud800', base64Encoded: false },
    { body: 'TOKEN_SENTINEL', base64Encoded: 'false' },
  ]) {
    const capture = readyCapture();
    let reads = 0;
    const read = async () => { reads++; return body; };
    const result = await capture.claim(expected, read, async () => true);
    assert.equal(result.status, 'unverified');
    assert.equal((await capture.claim(expected, read, async () => true)).status, 'unverified');
    assert.equal(reads, 1);
    noSecrets(result);
  }
  const failed = await readyCapture().claim(expected, async () => { throw new Error('TOKEN_SENTINEL'); }, async () => true);
  assert.equal(failed.status, 'unverified');
  noSecrets(failed);
});

test('design source fixture: credential-bearing ExtraInfo is ignored, not projected', async () => {
  const capture = new SourceClaimCapture(scope);
  for (let index = 0; index < 1100; index++) {
    capture.observe(event('Network.requestWillBeSentExtraInfo', { requestId: '123.1', headers: { Cookie: 'TOKEN_SENTINEL' } }));
  }
  capture.observe({ method: 'Network.responseReceivedExtraInfo', sessionId: scope.sessionId,
    get params() { throw new Error('PRIVATE_SENTINEL'); } });
  for (const item of [request(), response(), data(), finished()]) capture.observe(item);
  const { result } = await claim(capture);
  assert.equal(result.status, 'matched');
  noSecrets(result);
});

test('design source fixture: invalid scope and malicious getters never disclose supplied values', async () => {
  assert.throws(() => new SourceClaimCapture({ ...scope, orgId: 'TOKEN_SENTINEL' }), { message: 'Invalid capture scope' });
  assert.throws(() => new SourceClaimCapture({ ...scope, sessionId: 1 }), { message: 'Invalid capture scope' });
  const poisoned = new Proxy({}, { get: () => { throw new Error('TOKEN_SENTINEL'); } });
  assert.throws(() => new SourceClaimCapture(poisoned), { message: 'Invalid capture scope' });
  const result = await readyCapture().claim(poisoned, async () => { throw new Error('PRIVATE_SENTINEL'); }, async () => true);
  assert.equal(result.status, 'unverified');
  noSecrets(result);
});

test('design source fixture: synthetic fixture contains no recognizable credentials or unrelated identities', async () => {
  const raw = await fs.readFile(fixturePath, 'utf8');
  for (const key of ['via', 'bk', 'actor', 'vt', 'rw']) {
    assert.equal(fixture.requestQuery[key], `SENTINEL_${key.toUpperCase()}`);
  }
  assert.doesNotMatch(raw, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(raw, /\bsk-[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(raw, /[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  for (const token of raw.match(/[A-Za-z0-9_-]{32,}/g) ?? []) {
    assert.equal(token, expected.sha256);
  }
});

const syntheticBytes = Buffer.from('<!DOCTYPE html><html lang="zh"><body>测试 😀</body></html>', 'utf8');
const syntheticTarget = { frameId: scope.frameUuid, version: 'version-1', size: syntheticBytes.length,
  sha256: createHash('sha256').update(syntheticBytes).digest('hex') };
const syntheticManifest = { kind: 'claim', status: 'matched', version: syntheticTarget.version,
  file: { size: syntheticTarget.size, serverClaimedSha256: syntheticTarget.sha256 } };
const sourceUrl = `https://${scope.frameUuid}.frame.claudeusercontent.com/_f/${syntheticTarget.version}/_src/index.html?__frame_t=SENTINEL_FRAME_TOKEN`;

function sourceRequest(overrides = {}) {
  return event('Network.requestWillBeSent', { requestId: '987.1', frameId: 'child-frame', loaderId: 'child-loader',
    request: { method: 'GET', url: sourceUrl, headers: { Cookie: 'TOKEN_SENTINEL' } }, ...overrides });
}

function sourceResponse(overrides = {}) {
  return event('Network.responseReceived', { requestId: '987.1', frameId: 'child-frame', loaderId: 'child-loader',
    response: { url: sourceUrl, status: 200, mimeType: 'text/html', headers: { 'content-length': String(syntheticBytes.length) } }, ...overrides });
}

function readyByteCapture() {
  const capture = new SourceByteCapture(scope, syntheticTarget);
  capture.observe(sourceRequest());
  capture.observe(sourceResponse());
  capture.observe(event('Network.dataReceived', { requestId: '987.1', dataLength: syntheticBytes.length }));
  capture.observe(event('Network.loadingFinished', { requestId: '987.1' }));
  return capture;
}

async function browserHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex');
}

test('design source bytes: synthetic source uses claimed, local and browser hashes without returning bytes', async () => {
  const capture = readyByteCapture();
  const result = await capture.check(syntheticManifest, async identifier => {
    assert.equal(identifier, '987.1');
    return { body: syntheticBytes.toString('utf8'), base64Encoded: false };
  }, browserHash, async () => true);
  assert.deepEqual(result, { kind: 'byte-check', status: 'matched', size: syntheticBytes.length, sha256: syntheticTarget.sha256 });
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL_FRAME_TOKEN|测试|😀|frame\.claudeusercontent\.com/);
  assert.equal((await capture.check(syntheticManifest, async () => { throw new Error('retry'); }, browserHash, async () => true)).status, 'unverified');
});

test('design source bytes: invalid manifest cannot trigger body reading', async () => {
  for (const manifest of [
    { ...syntheticManifest, status: 'mismatch' },
    { ...syntheticManifest, version: 'other' },
    { ...syntheticManifest, file: { ...syntheticManifest.file, size: 1 } },
    { ...syntheticManifest, file: { ...syntheticManifest.file, serverClaimedSha256: 'a'.repeat(64) } },
    new Proxy({}, { get: () => { throw new Error('TOKEN_SENTINEL'); } }),
  ]) {
    let reads = 0;
    const result = await readyByteCapture().check(manifest, async () => { reads++; return {}; }, browserHash, async () => true);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
    noSecrets(result);
  }
});

test('design source bytes: changed payload or browser hash is never accepted', async () => {
  const changed = Buffer.from(syntheticBytes);
  changed[changed.length - 1] ^= 1;
  const mismatch = await readyByteCapture().check(syntheticManifest, async () => ({ body: changed.toString('base64'), base64Encoded: true }), browserHash, async () => true);
  assert.equal(mismatch.status, 'mismatch');
  const wrongBrowser = await readyByteCapture().check(syntheticManifest, async () => ({ body: syntheticBytes.toString('base64'), base64Encoded: true }), async () => 'a'.repeat(64), async () => true);
  assert.equal(wrongBrowser.status, 'unverified');
  const reclaimed = await readyByteCapture().check(syntheticManifest, async () => ({ body: syntheticBytes.toString('base64'), base64Encoded: true }), browserHash, async () => false);
  assert.equal(reclaimed.status, 'unverified');
  let reads = 0;
  await readyByteCapture().check(syntheticManifest, async () => { reads++; return {}; }, browserHash, async () => false);
  assert.equal(reads, 0);
});

test('design source bytes: host, version, target session and cache state must match', async () => {
  const unsafe = [
    sourceUrl.replace(`${scope.frameUuid}.frame`, `evil-${scope.frameUuid}.frame`),
    sourceUrl.replace('/version-1/', '/other/'),
    sourceUrl.replace('https://', 'http://'),
    `${sourceUrl}&__frame_t=OTHER`,
    sourceUrl.replace('_src/index.html', 'index.html'),
  ];
  for (const value of unsafe) {
    const capture = new SourceByteCapture(scope, syntheticTarget);
    capture.observe(sourceRequest({ request: { method: 'GET', url: value } }));
    capture.observe(sourceResponse());
    capture.observe(event('Network.dataReceived', { requestId: '987.1', dataLength: syntheticBytes.length }));
    capture.observe(event('Network.loadingFinished', { requestId: '987.1' }));
    let reads = 0;
    const result = await capture.check(syntheticManifest, async () => { reads++; }, browserHash, async () => true);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
  for (const fault of ['cache', 'redirect', 'wrong-frame', 'oversize', 'wrong-session']) {
    const capture = new SourceByteCapture(scope, syntheticTarget);
    capture.observe(fault === 'wrong-session' ? { ...sourceRequest(), sessionId: 'other' } : sourceRequest());
    if (fault === 'redirect') capture.observe(sourceRequest({ redirectResponse: { status: 302 } }));
    if (fault === 'cache') capture.observe(event('Network.requestServedFromCache', { requestId: '987.1' }));
    capture.observe(fault === 'wrong-frame' ? sourceResponse({ frameId: 'other' }) : sourceResponse());
    capture.observe(event('Network.dataReceived', { requestId: '987.1', dataLength: syntheticBytes.length + (fault === 'oversize' ? 1 : 0) }));
    capture.observe(event('Network.loadingFinished', { requestId: '987.1' }));
    let reads = 0;
    const result = await capture.check(syntheticManifest, async () => { reads++; }, browserHash, async () => true);
    assert.equal(result.status, 'unverified');
    assert.equal(reads, 0);
  }
});

test('design source bytes: navigation during browser hashing invalidates the result', async () => {
  const capture = readyByteCapture();
  const result = await capture.check(syntheticManifest, async () => ({ body: syntheticBytes.toString('base64'), base64Encoded: true }), async bytes => {
    capture.observe(event('Page.frameNavigated', { frame: { id: scope.mainFrameId } }));
    return browserHash(bytes);
  }, async () => true);
  assert.equal(result.status, 'unverified');
});
