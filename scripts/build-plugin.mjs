#!/usr/bin/env node
// Build the standalone native Codex plugin marketplace into dist/.
import { promises as fs } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleRuntime as bundle } from './bundle-runtime.mjs';
import { assertPublishableContent } from '../src/release/content-scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const marketRoot = join(dist, 'marketplace');

async function main() {
  await fs.mkdir(dist, { recursive: true });
  const stage = await fs.mkdtemp(join(dist, '.marketplace-'));
  try {
    const pluginRoot = join(stage, 'plugins', 'claude');
    await fs.mkdir(join(stage, '.agents', 'plugins'), { recursive: true });
    await fs.mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
    await fs.mkdir(join(pluginRoot, 'bin'), { recursive: true });
    await fs.mkdir(join(pluginRoot, 'skills', 'claude', 'scripts'), { recursive: true });

    await bundle(join(root, 'src', 'mcp-server.mjs'), join(pluginRoot, 'server.mjs'));
    await bundle(join(root, 'bin', 'ccw.mjs'), join(pluginRoot, 'bin', 'ccw.mjs'));
    await fs.chmod(join(pluginRoot, 'bin', 'ccw.mjs'), 0o755);

    await fs.copyFile(join(root, 'plugin', '.codex-plugin', 'plugin.json'), join(pluginRoot, '.codex-plugin', 'plugin.json'));
    await fs.copyFile(join(root, 'plugin', '.mcp.json'), join(pluginRoot, '.mcp.json'));
    await fs.copyFile(join(root, 'plugin', 'marketplace.json'), join(stage, '.agents', 'plugins', 'marketplace.json'));

    const skillAllowlist = [
      ['SKILL.md', join('skills', 'claude', 'SKILL.md')],
      [join('scripts', 'ccw.mjs'), join('skills', 'claude', 'scripts', 'ccw.mjs')],
    ];
    for (const [src, dest] of skillAllowlist) {
      await fs.copyFile(join(root, 'skills', 'claude', src), join(pluginRoot, dest));
    }

    // The payload must not contain spec/state files or sensitive content.
    const payloadFiles = [];
    const walk = async (dir) => {
      for (const item of await fs.readdir(dir, { withFileTypes: true })) {
        const p = join(dir, item.name);
        if (item.isDirectory()) await walk(p);
        else if (item.isFile()) payloadFiles.push(p);
        else throw new Error(`Unsafe file in plugin payload: ${p.slice(stage.length + 1)}`);
      }
    };
    await walk(stage);
    const scanEntries = [];
    for (const p of payloadFiles) {
      const rel = p.slice(stage.length + 1);
      if (rel.includes('.spec') || rel.includes('sessions.json') || rel.includes('runtime.json')) {
        throw new Error(`Unexpected file in plugin payload: ${rel}`);
      }
      scanEntries.push({ path: rel, bytes: await fs.readFile(p) });
    }
    assertPublishableContent(scanEntries);
    await fs.rm(marketRoot, { recursive: true, force: true });
    await fs.rename(stage, marketRoot);
    console.log(`Built plugin marketplace at ${marketRoot}`);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`build-plugin failed: ${error.message}\n`);
  process.exit(1);
});
