import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { discoverClaudeBrowser } from '../src/core/browser-discovery.mjs';
import { withClaudeTab } from '../src/core/tab.mjs';
import { ClaudeService, FakeCdpServer, fetchHandlerFor, makeTmpDir } from './helpers.mjs';

const config = (extra = {}) => ({
  cdpUrl: null,
  orgId: null,
  timeoutMs: 10_000,
  idleTimeoutMs: 5_000,
  readyTimeoutMs: 2_000,
  minIntervalMs: 0,
  stateDir: '/tmp/ccw-browser-discovery',
  ...extra,
});

const chrome = (port, extra = '', profile = '/tmp/profile') =>
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profile} ${extra}${port ? `--remote-debugging-port=${port}` : ''}`;

test('browser discovery: explicit cdpUrl wins and never probes processes', async () => {
  let processes = 0;
  const result = await discoverClaudeBrowser(config({ cdpUrl: 'http://127.0.0.1:9333' }), {
    processEntries: async () => {
      processes += 1;
      return [];
    },
  });
  assert.equal(result, 'http://127.0.0.1:9333');
  assert.equal(processes, 0);
});

test('browser discovery: selects the only logged-in explicit-port browser', async () => {
  const probes = [];
  const result = await discoverClaudeBrowser(config(), {
    processEntries: async () => [
      { pid: 1, args: chrome(9222).split(' ') },
      { pid: 2, args: chrome(9333).split(' ') },
    ],
    loginProbe: async endpoint => {
      probes.push(endpoint);
      return { authenticated: endpoint.endsWith('9333'), orgId: 'org' };
    },
  });
  assert.equal(result, 'http://127.0.0.1:9333');
  assert.deepEqual(probes, ['http://127.0.0.1:9222', 'http://127.0.0.1:9333']);
});

test('browser discovery: no and multiple logged-in candidates fail closed', async () => {
  const entries = [{ pid: 1, args: chrome(9222).split(' ') }];
  await assert.rejects(
    () => discoverClaudeBrowser(config(), {
      processEntries: async () => entries,
      loginProbe: async () => ({ authenticated: false }),
    }),
    { code: 'BROWSER_NOT_FOUND' },
  );
  await assert.rejects(
    () => discoverClaudeBrowser(config(), {
      processEntries: async () => [...entries, { pid: 2, args: chrome(9333).split(' ') }],
      loginProbe: async () => ({ authenticated: true, orgId: 'org' }),
    }),
    error => error.code === 'BROWSER_AMBIGUOUS' && error.details.endpoints.length === 2,
  );
});

test('browser discovery: DevToolsActivePort supplies a dynamic loopback port', async () => {
  const home = await makeTmpDir('ccw-discovery-');
  const profile = join(home, 'profile');
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(profile, 'DevToolsActivePort'), '9444\n/browser-token\n', { mode: 0o600 });
  const result = await discoverClaudeBrowser(config({ home, platform: 'darwin' }), {
    processEntries: async () => [{ pid: 1, args: chrome('', '--headless=new ', profile).split(' ') }],
    loginProbe: async endpoint => {
      assert.equal(endpoint, 'http://127.0.0.1:9444');
      return { authenticated: true, orgId: 'org' };
    },
  });
  assert.equal(result, 'http://127.0.0.1:9444');
});

test('browser discovery: Linux package names and space-separated browser flags are recognized', async () => {
  const home = await makeTmpDir('ccw-discovery-linux-');
  const profile = join(home, 'profile with space');
  let requestedPath;
  const result = await discoverClaudeBrowser(config({ home, platform: 'linux' }), {
    processEntries: async () => [{
      pid: 1,
      args: ['/usr/bin/chromium-browser', '--user-data-dir', profile],
    }],
    readDevToolsPort: async path => {
      requestedPath = path;
      return 9444;
    },
    loginProbe: async () => ({ authenticated: true, orgId: 'org' }),
  });
  assert.equal(result, 'http://127.0.0.1:9444');
  assert.equal(requestedPath, join(profile, 'DevToolsActivePort'));

  const explicit = await discoverClaudeBrowser(config(), {
    processEntries: async () => [{
      pid: 2,
      args: ['/usr/bin/google-chrome-stable', '--remote-debugging-address', '127.0.0.1', '--remote-debugging-port', '9555'],
    }],
    loginProbe: async endpoint => {
      assert.equal(endpoint, 'http://127.0.0.1:9555');
      return { authenticated: true, orgId: 'org' };
    },
  });
  assert.equal(explicit, 'http://127.0.0.1:9555');
});

test('browser discovery: macOS Chrome channels use their own default profile roots', async () => {
  const home = await makeTmpDir('ccw-discovery-channel-');
  let requestedPath;
  const result = await discoverClaudeBrowser(config({ home, platform: 'darwin' }), {
    processEntries: async () => [{
      pid: 1,
      args: ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
    }],
    readDevToolsPort: async path => {
      requestedPath = path;
      return 9666;
    },
    loginProbe: async () => ({ authenticated: true, orgId: 'org' }),
  });
  assert.equal(result, 'http://127.0.0.1:9666');
  assert.equal(requestedPath, join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta', 'DevToolsActivePort'));
});

test('browser discovery: non-loopback, invalid, duplicate and helper processes are ignored', async () => {
  const endpoints = [];
  await discoverClaudeBrowser(config(), {
    processEntries: async () => [
      { pid: 1, args: chrome(9555, '--remote-debugging-address=0.0.0.0 ').split(' ') },
      { pid: 2, args: chrome(0).split(' ') },
      { pid: 3, args: chrome(9666).split(' ') },
      { pid: 4, args: chrome(9777).split(' ') },
      { pid: 5, args: `${chrome(9888)} --type=renderer`.split(' ') },
    ],
    loginProbe: async endpoint => {
      endpoints.push(endpoint);
      return { authenticated: endpoint.endsWith('9666') || endpoint.endsWith('9777') };
    },
  }).catch(() => {});
  assert.deepEqual(endpoints, ['http://127.0.0.1:9666', 'http://127.0.0.1:9777']);
});

test('browser discovery: withClaudeTab uses the resolved endpoint', async () => {
  const service = new ClaudeService();
  const server = await new FakeCdpServer({ fetchHandler: fetchHandlerFor(service) }).start();
  try {
    const seen = [];
    const result = await withClaudeTab(config({
      discoverBrowser: async candidate => {
        seen.push(candidate);
        return server.cdpUrl;
      },
    }), async tab => {
      seen.push(tab.cdpUrl);
      return true;
    });
    assert.equal(result, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].cdpUrl, null);
    assert.equal(seen[1], server.cdpUrl);
  } finally {
    await server.stop();
  }
});
