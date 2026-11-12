#!/usr/bin/env node
// Codex installer (compatibility entry point).
//
// Keeps the historical CLI contract: `--check`, `--uninstall`, `--codex-home`,
// schema-1 install record, and the same result JSON keys. The heavy lifting
// lives in src/install/ so every other host shares one ownership model.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from '../src/is-main.mjs';
import { defaultIo } from '../src/install/atomic.mjs';
import { InstallError } from '../src/install/errors.mjs';
import { findHost } from '../src/install/hosts.mjs';
import { REPO_ROOT, defaultStateDir, sourcePaths, checkHost, installHost, uninstallHost } from '../src/install/engine.mjs';

const HOST_ID = 'codex';

function codexTarget({ env, codexHome }) {
  const host = findHost(HOST_ID);
  return {
    host,
    target: host.resolve({
      home: env.HOME ?? homedir(), env, override: codexHome, stateDir: defaultStateDir(env),
    }),
  };
}

export async function run(argv, { env = process.env, stdout = process.stdout, sourceRoot = REPO_ROOT, io = defaultIo() } = {}) {
  const emit = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        uninstall: { type: 'boolean' },
        'codex-home': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: `Invalid arguments: ${error.message}` } });
    return 1;
  }
  if (values.check && values.uninstall) {
    emit({ ok: false, error: { code: 'INVALID_ARGUMENT', message: '--check and --uninstall are mutually exclusive' } });
    return 1;
  }
  const home = env.HOME ?? homedir();
  const codexHome = resolve(values['codex-home'] ?? env.CODEX_HOME ?? join(home, '.codex'));
  const { host, target } = codexTarget({ env, codexHome });
  const deps = { ...sourcePaths(sourceRoot), home, io };
  try {
    let result;
    if (values.check) result = await checkHost(host, target, deps);
    else if (values.uninstall) result = await uninstallHost(host, target, deps);
    else result = await installHost(host, target, deps);
    emit({ ...result, codexHome: target.homeDir });
    if (values.check) return result.healthy ? 0 : 1;
    return 0;
  } catch (error) {
    const code = error instanceof InstallError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof InstallError ? error.message : 'Installation failed';
    emit({ ok: false, error: { code, message, ...(error.details ? { details: error.details } : {}) } });
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
