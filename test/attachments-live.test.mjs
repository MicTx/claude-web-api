import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { makeTmpDir, cleanupTmpDirs, offlineNodeOptions } from './helpers.mjs';
import { semanticReply } from '../scripts/smoke-attachments.mjs';
import { FIXED_PROMPT, isSubmitEvaluate } from '../scripts/probe-click-interrupt.mjs';

after(cleanupTmpDirs);
const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../scripts/smoke-attachments.mjs');
const probe = resolve(import.meta.dirname, '../scripts/probe-held-draft.mjs');
const clickProbe = resolve(import.meta.dirname, '../scripts/probe-click-interrupt.mjs');

async function probeFixture(pending = null) {
  const home = await makeTmpDir('ccw-probe-guard-');
  const stateDir = join(home, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const promptPath = join(home, 'prompt.txt');
  const prompt = 'live held-draft probe: please reply with exactly the word ok\n';
  await fs.writeFile(promptPath, prompt, { mode: 0o600 });
  const entry = {
    session: 'probe-guard', orgId: 'e1c20612-4b83-4594-aca7-644d223852e7',
    conversationId: '9ab3d65e-3222-458a-8a83-fc0b5be8f112',
    parentMessageId: '00000000-0000-4000-8000-000000000000', model: null,
    createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:00.000Z',
    pending: pending ?? {
      kind: 'send', transport: 'native', parentMessageId: '00000000-0000-4000-8000-000000000000',
      promptSha256: createHash('sha256').update(prompt.trim(), 'utf8').digest('hex'),
      startedAt: '2026-11-11T00:00:00.000Z', attachments: [],
    },
  };
  await fs.writeFile(join(stateDir, 'sessions.json'), JSON.stringify({ version: 2, lastSubmissionAt: 0, sessions: [entry] }), { mode: 0o600 });
  return {
    home, promptPath, prompt,
    env: {
      HOME: home, PATH: process.env.PATH ?? '', CCW_STATE_DIR: stateDir,
      CCW_CDP_URL: 'http://127.0.0.1:1',
      NODE_OPTIONS: await offlineNodeOptions(home, 'http://127.0.0.1:1'),
    },
  };
}

test('attachments: live smoke checks only supported image and code content', () => {
  const expected = { image: ['blue', 'red', 'green'] };
  assert.equal(semanticReply('{"colors":["blue","red","green"],"codeResult":40}', expected, 40), true);
  assert.equal(semanticReply('{"colors":["blue","green","red"],"codeResult":40}', expected, 40), false);
  assert.equal(semanticReply('{"colors":["blue","red","green"],"codeResult":41}', expected, 40), false);
});

async function clickProbeFixture() {
  const home = await makeTmpDir('ccw-click-probe-');
  const stateDir = join(home, 'state');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  return {
    home, stateDir,
    env: {
      HOME: home, PATH: process.env.PATH ?? '',
      NODE_OPTIONS: await offlineNodeOptions(home, 'http://127.0.0.1:1'),
    },
  };
}

test('click-boundary probe skips without --live and never touches state', async () => {
  const fixture = await clickProbeFixture();
  const { stdout, stderr } = await exec(process.execPath, [clickProbe, '--state-dir', fixture.stateDir,
    '--session', 'click-boundary-1234abcd', '--cdp-url', 'http://127.0.0.1:1'], { env: fixture.env });
  assert.deepEqual(JSON.parse(stdout), { ok: true, skipped: true, reason: '--live required' });
  assert.equal(stderr, '');
  assert.deepEqual(await fs.readdir(fixture.stateDir), []);
  assert.equal(FIXED_PROMPT, 'click boundary held-draft probe: reply with exactly ok');
});

test('click-boundary probe guards live state before browser access', async () => {
  const fixture = await clickProbeFixture();
  const live = ['--live', '--session', 'click-boundary-1234abcd', '--cdp-url', 'http://127.0.0.1:1'];
  const refuse = async (args, match) => assert.rejects(
    exec(process.execPath, [clickProbe, ...args], { env: fixture.env }),
    error => error.code === 1 && JSON.parse(error.stderr).error.code === 'LIVE_GUARD'
      && match.test(JSON.parse(error.stderr).error.message) && error.stdout === '');
  await refuse(['--live', ...live.slice(1)], /absolute path/);
  await refuse([...live, '--state-dir', fixture.stateDir, '--session', 'not-click-boundary'], /click-boundary/);
  await refuse([...live, '--state-dir', fixture.stateDir, '--cdp-url', 'http://example.com:1'], /loopback/);
  await fs.writeFile(join(fixture.stateDir, 'sessions.json'), '{}', { mode: 0o600 });
  await refuse(['--live', '--state-dir', fixture.stateDir, '--session', 'click-boundary-1234abcd',
    '--cdp-url', 'http://127.0.0.1:1'], /must be empty/);
});

test('click-boundary probe intercepts only the submit evaluate', () => {
  const evaluate = (action) => isSubmitEvaluate('Runtime.evaluate', { expression: `({"action":"${action}"})` });
  assert.equal(evaluate('submit'), true);
  for (const action of ['ready', 'fill', 'forget', 'inspect', 'scope']) assert.equal(evaluate(action), false);
  assert.equal(isSubmitEvaluate('Page.navigate', { expression: '"action":"submit"' }), false);
  assert.equal(isSubmitEvaluate('Fetch.enable', { expression: '"action":"submit"' }), false);
  assert.equal(isSubmitEvaluate('Runtime.evaluate', {}), false);
  assert.equal(isSubmitEvaluate('Runtime.evaluate', { expression: 'action:"submit"' }), false);
});

test('attachments: live smoke without explicit flag cannot access a browser or files', async () => {
  const home = await makeTmpDir('ccw-no-live-');
  const { stdout, stderr } = await exec(process.execPath, [script, '--evidence-dir', '/does-not-exist', '--phase', 'inputs'], {
    env: { HOME: home, PATH: process.env.PATH ?? '', NODE_OPTIONS: await offlineNodeOptions(home, 'http://127.0.0.1:1') },
  });
  assert.equal(JSON.parse(stdout).skipped, true);
  assert.equal(stderr, '');
});

test('attachments: live smoke refuses an incomplete explicit invocation before browser access', async () => {
  const home = await makeTmpDir('ccw-no-live-');
  await assert.rejects(exec(process.execPath, [script, '--live'], {
    env: { HOME: home, PATH: process.env.PATH ?? '', NODE_OPTIONS: await offlineNodeOptions(home, 'http://127.0.0.1:1') },
  }), error => error.code === 1 && JSON.parse(error.stdout).error.code === 'LIVE_GUARD');
});

test('attachments: live smoke requires a recorded extension and never resets an exhausted budget', async () => {
  const home = await makeTmpDir('ccw-live-budget-');
  const limits = { sessions: 2, messages: 8, downloads: 12, maxDownloadBytes: 2097152, secondSessionUploadsPerFile: 3 };
  const ledger = { limits, sessions: [{}, {}], messages: 8, downloads: [], uploads: [] };
  for (const extended of [false, true]) {
    if (extended) ledger.authorizations = [{
      decision: '追加受限额度', additionalMessageAttempts: 3, additionalUploadsPerFileInSecondSession: 2,
      previousLimits: { sessions: 2, messages: 6, downloads: 12, maxDownloadBytes: 2097152 },
    }];
    const before = JSON.stringify(ledger);
    await fs.writeFile(resolve(home, 'ledger.json'), before, { mode: 0o600 });
    await assert.rejects(exec(process.execPath, [script, '--live', '--evidence-dir', home, '--phase', 'inputs'], {
      env: { HOME: home, PATH: process.env.PATH ?? '', NODE_OPTIONS: await offlineNodeOptions(home, 'http://127.0.0.1:1') },
    }), error => {
      const result = JSON.parse(error.stdout);
      assert.equal(result.error.code, 'LIVE_GUARD');
      assert.match(result.error.message, extended ? /Message budget exhausted/ : /original authorized bounded ledger/);
      return true;
    });
    assert.equal(await fs.readFile(resolve(home, 'ledger.json'), 'utf8'), before);
  }
});

test('held-draft probe refuses missing arguments without browser or state access', async () => {
  const fixture = await probeFixture();
  await assert.rejects(exec(process.execPath, [probe, '--session', 'probe-guard'], { env: fixture.env }),
    error => error.code === 2);
  await assert.rejects(exec(process.execPath, [probe, '--file', fixture.promptPath], { env: fixture.env }),
    error => error.code === 2);
});

test('held-draft probe refuses a prompt or session mismatch before browser access', async () => {
  const fixture = await probeFixture();
  const refuse = async (args, code) => assert.rejects(
    exec(process.execPath, [probe, ...args], { env: fixture.env }),
    error => error.code === 1 && JSON.parse(error.stderr).error.code === code && error.stdout === '');
  const otherPrompt = join(fixture.home, 'other.txt');
  await fs.writeFile(otherPrompt, 'a different question\n', { mode: 0o600 });
  await refuse(['--session', 'probe-guard', '--file', otherPrompt, '--recover'], 'PROMPT_MISMATCH');
  await refuse(['--session', 'missing-alias', '--file', fixture.promptPath, '--recover'], 'SESSION_NOT_FOUND');
});

test('held-draft probe refuses non-native or settled pendings before browser access', async () => {
  const fixture = await probeFixture({ kind: 'create', startedAt: '2026-11-11T00:00:00.000Z' });
  await assert.rejects(
    exec(process.execPath, [probe, '--session', 'probe-guard', '--file', fixture.promptPath, '--recover'], { env: fixture.env }),
    error => error.code === 1 && JSON.parse(error.stderr).error.code === 'PENDING_TURN' && error.stdout === '');
});
