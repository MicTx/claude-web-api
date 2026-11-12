import { promises as fs, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ClaudeBridge } from '../src/bridge.mjs';
import { loadConfig } from '../src/config.mjs';
import { prepareAttachments } from '../src/attachments.mjs';
import { withClaudeTab } from '../src/core/tab.mjs';
import { inspectBlankComposer } from '../src/core/ui.mjs';
import { BridgeError, errorResult } from '../src/core/errors.mjs';
import { isMainModule } from '../src/is-main.mjs';

const requireThat = (value, message) => { if (!value) throw new BridgeError('LIVE_GUARD', message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function readBounded(path, limit) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    requireThat(before.isFile() && before.nlink === 1n && before.size <= BigInt(limit), 'Unsafe or oversized evidence file');
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    requireThat(BigInt(count) === before.size && before.size === after.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'Evidence changed while reading');
    return buffer.subarray(0, count);
  } finally {
    await file.close();
  }
}

export function semanticReply(reply, expected, result) {
  let data;
  try { data = JSON.parse(reply.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '')); } catch { return false; }
  return Array.isArray(data.colors) && data.colors.length === 3
    && data.colors.every((color, i) => typeof color === 'string' && color.toLowerCase() === expected.image[i])
    && data.codeResult === result;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv, strict: true, allowPositionals: false,
    options: { live: { type: 'boolean' }, 'evidence-dir': { type: 'string' }, phase: { type: 'string' }, 'cdp-url': { type: 'string' }, 'retry-originals': { type: 'boolean' } },
  });
  if (!values.live) return { ok: true, skipped: true, reason: 'Explicit user authorization and --live are required; no browser or files accessed' };
  requireThat(isAbsolute(values['evidence-dir'] ?? '') && ['inputs', 'follow-up', 'originals'].includes(values.phase), 'Specify an authorized absolute evidence directory and phase');
  const root = await fs.realpath(values['evidence-dir']);
  const rootStat = await fs.lstat(root);
  requireThat(rootStat.isDirectory() && rootStat.uid === process.getuid() && !(rootStat.mode & 0o077), 'Evidence directory must be private and owned');
  const lockPath = join(root, '.bridge-live.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  const locked = await lock.stat();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const load = async name => JSON.parse((await readBounded(join(root, name), 32768)).toString('utf8'));
    const ledgerPath = join(root, 'ledger.json');
    let previousLedger = await readBounded(ledgerPath, 32768);
    const ledger = JSON.parse(previousLedger.toString('utf8'));
    const extended = ledger.limits?.secondSessionUploadsPerFile === 3 && Array.isArray(ledger.authorizations)
      && ledger.authorizations.some(grant => grant?.decision === '追加受限额度'
        && grant.additionalMessageAttempts === 3 && grant.additionalUploadsPerFileInSecondSession === 2
        && grant.previousLimits?.sessions === 2 && grant.previousLimits?.messages === 6
        && grant.previousLimits?.downloads === 12 && grant.previousLimits?.maxDownloadBytes === 2097152);
    const messageLimit = extended ? 8 : 6;
    requireThat(ledger.limits?.sessions === 2 && ledger.limits?.messages === messageLimit && ledger.limits?.downloads === 12
      && ledger.limits?.maxDownloadBytes === 2097152 && ledger.sessions?.length === 2
      && Number.isSafeInteger(ledger.messages) && ledger.messages >= 4 && ledger.messages <= messageLimit
      && Array.isArray(ledger.downloads) && ledger.downloads.length <= 12 && Array.isArray(ledger.uploads), 'Use the original authorized bounded ledger; do not reset it');
    ledger.bridge ??= {};
    const saveLedger = async () => {
      requireThat((await readBounded(ledgerPath, 32768)).equals(previousLedger), 'Ledger changed outside this run');
      const bytes = Buffer.from(JSON.stringify(ledger, null, 2));
      requireThat(bytes.length <= 32768, 'Ledger exceeds bound');
      const temporary = join(root, `.ledger-${randomUUID()}.tmp`);
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, ledgerPath);
      previousLedger = bytes;
    };
    const phase = values.phase;
    const retry = values['retry-originals'] === true;
    requireThat(!retry || phase === 'originals', 'Only a diagnosed, unpublished file-download failure may be explicitly rechecked');
    requireThat(!ledger.bridge[`${phase}Attempted`] || (retry && !ledger.bridge.originals), 'This phase was already attempted; inspect evidence, never blindly retry');
    if (retry) {
      const published = await fs.readdir(join(root, 'bridge-live-state', 'downloads')).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      requireThat(published.length === 0, 'Inspect existing download outputs; this script never overwrites or retries partial publication');
    }
    if (phase !== 'originals') requireThat(ledger.messages < messageLimit, 'Message budget exhausted');
    if (phase === 'follow-up') requireThat(ledger.bridge.inputs?.semantic === true, 'A verified input round is required');
    if (phase === 'originals') requireThat(ledger.downloads.length + 3 <= 12, 'Download budget exhausted');
    const samples = await load('samples.json');
    const names = ['sample.png', 'sample.js'];
    requireThat(samples.files?.length === 3 && samples.expected?.codeResult === 40
      && Array.isArray(samples.expected.image) && samples.expected.image.length === 3, 'Unsupported sample manifest');
    const config = loadConfig({}, {
      cdpUrl: values['cdp-url'] ?? 'http://127.0.0.1:9333', stateDir: join(root, 'bridge-live-state'), attachmentRoot: root,
    });
    const paths = names.map(name => join(root, name));
    const prepared = await prepareAttachments(paths, config, { signal: controller.signal });
    requireThat(prepared.reduce((sum, file) => sum + file.size, 0) < 65536, 'Samples exceed approved total size');
    for (const file of prepared) {
      requireThat(samples.files.some(item => item.name === file.name && item.sha256 === file.sha256)
        && ledger.uploads.some(item => item.index === 1 && item.name === file.name && item.sha256 === file.sha256), 'Samples differ from original approved inputs');
      if (phase === 'inputs') requireThat(!ledger.uploads.some(item => item.index === 2 && item.name === file.name), 'A sample was already attempted in this conversation');
    }
    const baseline = [(await load('ui-probe.json')).leaf, ledger.bridge.inputs?.assistantMessageId ?? (await load('artifact-probe.json')).leaf];
    let preflight = phase !== 'originals';
    const scoped = (cfg, fn, options) => withClaudeTab(cfg, async tab => {
      if (preflight) { await inspectBlankComposer(tab, options); preflight = false; }
      const request = tab.request.bind(tab);
      let firstHistory = true;
      tab.request = async (...args) => {
        const result = await request(...args);
        if (firstHistory && Array.isArray(result?.chat_messages)) {
          firstHistory = false;
          const index = ledger.sessions.findIndex(item => item.conversationId === result.uuid);
          requireThat(index >= 0 && result.current_leaf_message_uuid === baseline[index], 'Approved test conversation has changed; do not send or download');
        }
        return result;
      };
      return fn(tab);
    }, options);
    const bridge = new ClaudeBridge(config, { withTab: scoped });
    const { orgId } = await bridge.doctor({}, { signal: controller.signal });
    await bridge.store.withLock(async () => {
      const state = await bridge.store.load();
      for (let index = 0; index < 2; index++) {
        const session = `attachment-live-${index + 1}`;
        const existing = state.sessions.find(item => item.session === session);
        const conversationId = ledger.sessions[index].conversationId;
        if (existing) requireThat(existing.orgId === orgId && existing.conversationId === conversationId, 'Local alias identity mismatch');
        else state.sessions.push({ session, orgId, conversationId, parentMessageId: baseline[index], model: null, pending: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      await bridge.store.save(state);
    }, { signal: controller.signal });
    ledger.bridge[`${phase}Attempted`] = true;
    if (phase === 'originals') {
      await saveLedger();
      const transcript = await bridge.transcript({ session: 'attachment-live-1' }, { signal: controller.signal });
      const downloads = [];
      for (const name of ['result.md', 'drawing.svg', 'result.js']) {
        const original = await readBounded(join(root, `native-${name}`), 2097152);
        const artifact = transcript.artifacts.find(item => item.name === name && item.downloadable);
        requireThat(artifact, 'Original public file is absent from the approved branch');
        ledger.downloads.push({ sessionIndex: 1, label: `bridge-${name}`, status: 'attempted' });
        await saveLedger();
        const result = await bridge.download({ session: 'attachment-live-1', artifact: artifact.id }, { signal: controller.signal });
        requireThat(result.sha256 === hash(original) && (await readBounded(result.path, 2097152)).equals(original), 'Downloaded original differs from the independent native baseline');
        downloads.push({ name, size: result.size, mimeType: result.mimeType, sha256: result.sha256 });
      }
      ledger.bridge.originals = downloads;
    } else {
      ledger.messages++;
      if (phase === 'inputs') for (const file of prepared) ledger.uploads.push({ index: 2, name: file.name, sha256: file.sha256, status: 'attempted' });
      await saveLedger();
      const prompt = phase === 'inputs'
        ? '请检查本轮两个附件。只回复一行 JSON：colors 为图片从左到右的英文颜色名数组；codeResult 为静态计算 JS 中 compute(3) 的数字结果。不要创建文件，不要执行代码。'
        : '不要重新上传或读取文件，只根据本对话先前附件上下文回复一行 JSON：colors 为先前图片从左到右的英文颜色名数组；codeResult 为静态计算先前 JS 中 compute(4) 的数字结果。不要创建文件，不要执行代码。';
      const result = await bridge.followUp({ session: 'attachment-live-2', prompt, native: true, attachments: phase === 'inputs' ? paths : undefined }, { signal: controller.signal });
      await fs.writeFile(join(root, `bridge-${phase}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      const semantic = semanticReply(result.reply, samples.expected, phase === 'inputs' ? 40 : 48);
      ledger.bridge[phase] = { semantic, assistantMessageId: result.assistantMessageId };
      await saveLedger();
      requireThat(semantic, 'Transfer completed but semantic evidence did not match; inspect the saved result, do not retry');
    }
    await saveLedger();
    return { ok: true, phase, result: ledger.bridge[phase], used: { sessions: ledger.sessions.length, messages: ledger.messages, downloads: ledger.downloads.length } };
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await lock.close();
    const current = await fs.lstat(lockPath).catch(() => null);
    if (current?.dev === locked.dev && current?.ino === locked.ino) await fs.unlink(lockPath);
  }
}

if (isMainModule(import.meta.url)) {
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = 1;
  });
}
