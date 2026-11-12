#!/usr/bin/env node
import { isMainModule } from '../src/is-main.mjs';
import { main } from '../src/cli.mjs';

export { main };

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
