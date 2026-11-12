// A deliberately restricted USTAR profile: regular files only, no PAX, links or devices.
// Keeping the format narrow makes extraction bounded and independent of system tar flags.
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { APP } from '../identity.mjs';
import { DOC_FILES } from './docs.mjs';

export const MAX_ARCHIVE = 32 * 1024 * 1024;
export const MAX_PAYLOAD = 64 * 1024 * 1024;
export const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const safePath = path => typeof path === 'string' && path.length < 100
  && /^[A-Za-z0-9_./-]+$/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));
const octal = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0';

export function pack(files) {
  const chunks = [];
  let total = 1024;
  const seen = new Set();
  for (const { path, bytes, mode = 0o644 } of files) {
    if (!safePath(path) || seen.has(path) || ![0o644, 0o755].includes(mode)) throw new Error('Invalid archive entry');
    seen.add(path);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE) throw new Error('Archive file exceeds limit');
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, 'ascii');
    header.write(octal(mode, 8), 100, 'ascii');
    header.write(octal(0, 8), 108, 'ascii');
    header.write(octal(0, 8), 116, 'ascii');
    header.write(octal(bytes.length, 12), 124, 'ascii');
    header.write(octal(0, 12), 136, 'ascii');
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    const checksum = header.reduce((sum, b) => sum + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const padding = Buffer.alloc((512 - bytes.length % 512) % 512);
    total += 512 + bytes.length + padding.length;
    if (total > MAX_PAYLOAD || seen.size > 64) throw new Error('Archive exceeds payload limit');
    chunks.push(header, bytes, padding);
  }
  const archive = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
  if (archive.length > MAX_ARCHIVE) throw new Error('Compressed archive exceeds limit');
  return archive;
}

export function unpack(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE) throw new Error('Compressed archive exceeds limit');
  const tar = gunzipSync(archive, { maxOutputLength: MAX_PAYLOAD });
  const files = new Map();
  const number = field => {
    const text = field.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(text)) throw new Error('Invalid USTAR number');
    return Number.parseInt(text, 8);
  };
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(b => b === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(b => b === 0)) throw new Error('Invalid archive terminator');
      if (!files.size) throw new Error('Empty archive');
      return files;
    }
    const expected = number(h.subarray(148, 156));
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : h[i];
    const path = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const mode = number(h.subarray(100, 108));
    const size = number(h.subarray(124, 136));
    if (expected !== actual || h.subarray(257, 263).toString('ascii') !== 'ustar\0'
      || !h.subarray(345, 500).every(b => b === 0) || h[156] !== 48
      || !h.subarray(157, 257).every(b => b === 0)
      || !safePath(path) || files.has(path) || ![0o644, 0o755].includes(mode)) throw new Error('Unsafe or unsupported archive entry');
    const end = offset + 512 + size;
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (size > MAX_ARCHIVE || next > tar.length || files.size >= 64) throw new Error('Truncated or oversized archive');
    files.set(path, { bytes: tar.subarray(offset + 512, end), mode });
    offset = next;
  }
  throw new Error('Missing archive terminator');
}

export const RUNTIME_FILES = ['bin/ccw.mjs', 'package.json', 'scripts/install-agents.mjs',
  'skills/claude/SKILL.md', 'skills/claude/scripts/ccw.mjs',
  'src/install/entry.mjs', 'src/mcp-server.mjs'];
export { DOC_FILES };

export function readRelease(archive, version) {
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  const entries = unpack(archive);
  const prefix = `${APP}-v${version}/`;
  const files = new Map();
  for (const [path, file] of entries) {
    if (!path.startsWith(prefix)) throw new Error('Archive version/root mismatch');
    files.set(path.slice(prefix.length), file);
  }
  return validateReleaseFiles(files, version);
}

export function validateReleaseFiles(files, version) {
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  const manifestFile = files.get('release.json');
  if (!manifestFile || manifestFile.bytes.length > 32768 || manifestFile.mode !== 0o644) throw new Error('Missing release manifest');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes));
  if (manifest.schema !== 1 || manifest.name !== APP || manifest.version !== version
    || !Array.isArray(manifest.files) || manifest.files.length !== files.size - 1) throw new Error('Invalid release manifest');
  const seen = new Set();
  for (const item of manifest.files) {
    if (!item || ![...RUNTIME_FILES, ...DOC_FILES].includes(item.path) || seen.has(item.path)) throw new Error('Unexpected release file');
    seen.add(item.path);
    const file = files.get(item.path);
    if (!file || !Number.isSafeInteger(item.size) || item.size !== file.bytes.length || item.mode !== file.mode
      || !/^[a-f0-9]{64}$/.test(item.sha256) || sha256(file.bytes) !== item.sha256) throw new Error('Release file integrity mismatch');
  }
  if (RUNTIME_FILES.some(path => !seen.has(path))) throw new Error('Incomplete runtime');
  const pkg = JSON.parse(files.get('package.json').bytes.toString('utf8'));
  if (pkg.name !== manifest.name || pkg.version !== version || pkg.type !== 'module') throw new Error('Package identity mismatch');
  return { manifest, files };
}
