// Product identity in one place.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP = 'claude-web-api';

export const configPath = (home) => join(home, '.config', APP, 'config.json');

export function defaultStateDir(env = process.env) {
  if (env.CCW_STATE_DIR !== undefined) return env.CCW_STATE_DIR;
  const home = env.HOME || homedir();
  return join(home, '.local', 'share', APP);
}
