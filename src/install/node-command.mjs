// The release launcher is a stable command name, not a versioned physical path.
// Host adapters validate it separately from the absolute runtime paths they own.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const NODE_COMMAND = 'node';

export const isNodeCommand = value => value === NODE_COMMAND;

export async function nodeCommandExists(command = NODE_COMMAND) {
  if (!isNodeCommand(command)) return false;
  try {
    await exec('sh', ['-c', 'command -v node'], { env: { PATH: process.env.PATH ?? '' }, timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
