// Execute the documented read-only Bash recipe against real generated assets.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRelease } from '../scripts/build-release.mjs';

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
async function temp() { const p = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'ccw-release-docs-'))); dirs.push(p); return p; }
after(async () => { for (const p of dirs) await fs.rm(p, { recursive: true, force: true }); });
const built = await buildRelease({ outDir: await temp() });
const read = path => fs.readFile(join(ROOT, path), 'utf8');

for (const file of ['docs/install.md', 'docs/install.en.md', 'llms.txt']) {
  test(`release docs: ${file} offline preview is copy-and-run, not a hypothetical command`, async () => {
    const text = await read(file);
    const block = /<!-- verify:release-local-preview -->\n```bash\n([\s\S]*?)\n```/.exec(text);
    assert.ok(block, 'complete executable recipe required');
    const home = await temp();
    const { stdout } = await exec('bash', ['-euo', 'pipefail', '-c', block[1]], {
      cwd: built.outDir, env: { PATH: process.env.PATH, HOME: home, CCW_VERSION: built.version }, timeout: 15000,
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.artifactVerified, true);
    assert.deepEqual(await fs.readdir(home), []);
  });
}

test('release docs: documented install options exist in the published Bash help', async () => {
  const { stdout } = await exec('bash', [join(built.outDir, 'install.sh'), '--help']);
  for (const file of ['docs/install.md', 'docs/install.en.md', 'llms.txt']) {
    const text = await read(file);
    for (const option of ['--version', '--archive', '--sha256', '--release-url', '--prefix', '--bin-dir', '--status', '--rollback', '--dry-run']) {
      assert.ok(text.includes(option), `${file}: ${option}`);
      assert.ok(stdout.includes(option), `actual help: ${option}`);
    }
    assert.match(text, /CCW_RELEASE_TOKEN/);
    assert.match(text, /SHA256SUMS/);
    assert.match(text, /registeredHosts:false/);
    assert.match(text, /artifactVerified:false/);
    assert.match(text, /RECOVERY_REQUIRED/);
    assert.match(text, /LOCKED/);
    assert.doesNotMatch(text, /https:\/\/github\.com\/[^\s]+\/releases\/download/);
  }
});

test('release docs: consumer READMEs no longer install or run from a development worktree', async () => {
  for (const [file, heading] of [['README.md', '## 开发与测试'], ['README.en.md', '## Development and tests']]) {
    const text = await read(file);
    const consumer = text.split(heading)[0];
    assert.doesNotMatch(consumer, /node bin\/ccw\.mjs|node scripts\/install-agents\.mjs|npm ci|marketplace add.*dist/);
    for (const link of ['docs/install.md', 'docs/install.en.md', 'llms.txt']) assert.ok(consumer.includes(link));
    assert.match(consumer, /current/);
    assert.match(consumer, /Magpie/);
  }
  const usage = await read('docs/usage.md');
  assert.doesNotMatch(usage, /node bin\/ccw\.mjs|import.*from.*src\/tool-contracts/);
  const skill = await read('skills/claude/SKILL.md');
  assert.doesNotMatch(skill, /node scripts\/install-agents\.mjs/);
  assert.match(skill, /旧源码直连须经备份对账再迁移/);
});

test('release docs: linked languages and LLM protocol preserve authorization and evidence boundaries', async () => {
  assert.ok((await read('docs/install.md')).includes('(install.en.md)'));
  assert.ok((await read('docs/install.en.md')).includes('(install.md)'));
  const protocol = await read('llms.txt');
  for (const pattern of [/not user authorization/, /No measured trigger rate/, /Do not clone/,
    /not.*remote Release exists/, /Never automatically resend/, /same --prefix/, /actual.*host/i,
    /SHA\/ownership\/path\/permission failures/, /do not create a parallel direct/]) assert.match(protocol, pattern);
});
