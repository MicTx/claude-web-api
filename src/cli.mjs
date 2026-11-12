import { parseArgs } from 'node:util';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { ConsultBridge } from './consult-bridge.mjs';
import { BridgeError, errorResult } from './core/errors.mjs';
import { APP, readState, reconnectPending } from './release/install-fs.mjs';

const MAX_READ_BYTES = 128 * 1024;

const HELP = `ccw - consult Claude through the local browser (web) or the Messages API (api)

Usage:
  ccw [web|api] <command> [options]

Modes:
  ccw web <command>    Force the local-browser route; never falls back.
  ccw api <command>    Force the text-only Messages API route; never falls back.
  ccw <command>        Use the configured backend (web, api or auto).

Commands:
  ccw --status [--prefix DIR] [--bin-dir DIR]
  ccw doctor
  ccw ask --session NAME (--prompt TEXT | --stdin | --file PATH) [--title TEXT] [--attach ABS_PATH ...] [--native] [--model ID] [--guidance]
  ccw follow-up --session NAME (--prompt TEXT | --stdin | --file PATH) [--attach ABS_PATH ...] [--native] [--guidance]
  ccw sessions
  ccw transcript --session NAME [--recover] [--discard-pending]
  ccw api-bind-credential --session NAME (--old-key-file ABS_PATH | --adopt-unbound)
  ccw native-resume --session NAME (--prompt TEXT | --stdin | --file PATH) [--guidance]
  ccw download --session NAME --artifact ID [--destination RELATIVE_FILE]
  ccw unlock [--session NAME]
  ccw --help

Results are printed as one JSON line on stdout. Errors exit non-zero.
Read-only startup settings: $HOME/.config/claude-web-api/config.json.
An explicit mode never falls back; a session owned by the other backend fails
with MODE_MISMATCH. Without a mode prefix, backend=api|auto keeps the text-only
fallback channel.
Optional fallback API channel (backend=api|auto) keeps text-only, sticky sessions
keyed by the alias; transcripts show real usage counters, never cost estimates.
--recover reconciles and may complete one verified held native draft; it never
resends a sent request. --discard-pending explicitly abandons an unconfirmed
pending attempt (API or native), requires --recover, and for native sessions
re-anchors the alias to the current server leaf. It never sends.
api-bind-credential changes local history binding without sending; adoption of
legacy history cannot verify its original credential identity.
Uploads require attachmentRoot or CCW_ATTACHMENT_ROOT; supported formats: PNG, UTF-8 .js (PDF is refused).
native-resume requires the original normalized prompt and, for attachment turns, binary file IDs; mismatches are refused. It submits once and never re-uploads or retries.
Native sends recheck the server branch before each click while waiting for a temporarily disabled control; success reports autoRecovered.
--file reads question text only. Independent Frame Artifacts download only when listed as downloadable; other Frame exports stay unverified.
--guidance appends the fixed executable-guidance block only when the prompt has no guidance marker and reports guidanceAppended. A marker alone suppresses append; it does not prove a complete current block.
Each command runs once; reuse the same session to execute, verify and request review until stage acceptance.
`;

function parse(argv, options) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new BridgeError('INVALID_ARGUMENT', `Invalid arguments: ${error.message}`);
  }
  if (parsed.positionals.length > 0) {
    throw new BridgeError('INVALID_ARGUMENT', `Unexpected arguments: ${parsed.positionals.join(' ')}`);
  }
  return parsed.values;
}

function noArgs(argv) {
  parse(argv, {});
}

async function readBounded(stream, signal) {
  const chunks = [];
  let total = 0;
  const onAbort = () => stream.destroy(new BridgeError('ABORTED', 'Operation aborted'));
  if (signal?.aborted) {
    stream.destroy();
    throw new BridgeError('ABORTED', 'Operation aborted');
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += bytes.byteLength;
      if (total > MAX_READ_BYTES) throw new BridgeError('INVALID_ARGUMENT', 'Prompt input exceeds the read limit');
      chunks.push(bytes);
    }
    if (signal?.aborted) throw new BridgeError('ABORTED', 'Operation aborted');
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    stream.destroy();
  }
}

async function readPrompt(values, stdin, signal) {
  const sources = [values.prompt !== undefined, values.stdin === true, values.file !== undefined]
    .filter(Boolean).length;
  if (sources === 0) {
    throw new BridgeError('INVALID_ARGUMENT', 'Exactly one prompt source is required: --prompt, --stdin or --file');
  }
  if (sources > 1) {
    throw new BridgeError('INVALID_ARGUMENT', 'Only one prompt source is allowed: --prompt, --stdin or --file');
  }
  if (values.prompt !== undefined) return values.prompt;
  if (values.stdin === true) return readBounded(stdin, signal);
  const st = await stat(values.file).catch(() => {
    throw new BridgeError('INVALID_ARGUMENT', `Cannot read prompt file: ${values.file}`);
  });
  if (!st.isFile() || st.size > MAX_READ_BYTES) {
    throw new BridgeError('INVALID_ARGUMENT', 'Prompt file is missing, not a regular file, or too large');
  }
  // stream through the bounded reader so a growing file cannot slip past stat
  return readBounded(createReadStream(values.file), signal);
}

const PROMPT_OPTIONS = {
  session: { type: 'string' },
  prompt: { type: 'string' },
  stdin: { type: 'boolean' },
  file: { type: 'string' },
  attach: { type: 'string', multiple: true },
  native: { type: 'boolean' },
  guidance: { type: 'boolean' },
};

async function runCommand(command, argv, { env, stdin, signal, mode = null }) {
  if (command === '--status') {
    const values = parse(argv, { prefix: { type: 'string' }, 'bin-dir': { type: 'string' } });
    const home = typeof env.HOME === 'string' && env.HOME.startsWith('/') ? env.HOME : null;
    const root = values.prefix ?? (home ? join(home, '.local/share', APP, 'runtime') : null);
    const binDir = values['bin-dir'] ?? (home ? join(home, '.local/bin') : null);
    if (!root || !binDir || !root.startsWith('/') || !binDir.startsWith('/')) {
      throw new BridgeError('INVALID_ARGUMENT', 'Status requires an absolute HOME or explicit --prefix and --bin-dir');
    }
    let state;
    let reconnect;
    try {
      state = await readState(root);
      reconnect = state ? await reconnectPending(root) : null;
    } catch (error) {
      if (!['UNSAFE_PATH', 'CONCURRENT_CHANGE'].includes(error.code)) throw error;
      throw new BridgeError(error.code, error.message);
    }
    const reportedBinDir = state?.owner.binDir ?? binDir;
    return {
      ok: true,
      action: 'status',
      installed: Boolean(state),
      version: state?.current ?? null,
      previous: state?.previous ?? null,
      root,
      binDir: reportedBinDir,
      reconnectRequired: reconnect !== null,
      ...(typeof reconnect === 'string' ? { reconnectVersion: reconnect } : {}),
      verification: 'installed-files-and-commands',
    };
  }
  const bridge = new ConsultBridge(loadConfig(env), { mode });
  switch (command) {
    case 'doctor': {
      noArgs(argv);
      return bridge.doctor({}, { signal });
    }
    case 'sessions': {
      noArgs(argv);
      return bridge.sessions();
    }
    case 'unlock': {
      const values = parse(argv, { session: { type: 'string' } });
      return bridge.unlock({ session: values.session });
    }
    case 'ask': {
      const values = parse(argv, { ...PROMPT_OPTIONS, title: { type: 'string' }, model: { type: 'string' } });
      if (values.session === undefined) {
        throw new BridgeError('INVALID_ARGUMENT', 'ask requires --session NAME');
      }
      const prompt = await readPrompt(values, stdin, signal);
      return bridge.ask({ session: values.session, prompt, title: values.title, attachments: values.attach, native: values.native, model: values.model, guidance: values.guidance }, { signal });
    }
    case 'follow-up': {
      const values = parse(argv, PROMPT_OPTIONS);
      if (values.session === undefined) {
        throw new BridgeError('INVALID_ARGUMENT', 'follow-up requires --session NAME');
      }
      const prompt = await readPrompt(values, stdin, signal);
      return bridge.followUp({ session: values.session, prompt, attachments: values.attach, native: values.native, guidance: values.guidance }, { signal });
    }
    case 'native-resume': {
      const values = parse(argv, PROMPT_OPTIONS);
      if (values.session === undefined) {
        throw new BridgeError('INVALID_ARGUMENT', 'native-resume requires --session NAME');
      }
      const prompt = await readPrompt(values, stdin, signal);
      return bridge.resumeNativeUpload({ session: values.session, prompt, guidance: values.guidance }, { signal });
    }
    case 'transcript': {
      const values = parse(argv, {
        session: { type: 'string' },
        recover: { type: 'boolean' },
        'discard-pending': { type: 'boolean' },
      });
      if (values.session === undefined) {
        throw new BridgeError('INVALID_ARGUMENT', 'transcript requires --session NAME');
      }
      return bridge.transcript({
        session: values.session,
        recover: values.recover ?? false,
        discardPending: values['discard-pending'] ?? false,
      }, { signal });
    }
    case 'api-bind-credential': {
      const values = parse(argv, { session: { type: 'string' }, 'old-key-file': { type: 'string' }, 'adopt-unbound': { type: 'boolean' } });
      if (values.session === undefined) throw new BridgeError('INVALID_ARGUMENT', 'api-bind-credential requires --session NAME');
      return bridge.bindApiCredential({ session: values.session, oldKeyFile: values['old-key-file'], adoptUnbound: values['adopt-unbound'] ?? false }, { signal });
    }
    case 'download': {
      const values = parse(argv, { session: { type: 'string' }, artifact: { type: 'string' }, destination: { type: 'string' } });
      if (values.session === undefined || values.artifact === undefined) throw new BridgeError('INVALID_ARGUMENT', 'download requires --session NAME and --artifact ID');
      return bridge.download(values, { signal });
    }
    default:
      throw new BridgeError('INVALID_ARGUMENT', `Unknown command: ${command}`);
  }
}

const MODES = new Set(['web', 'api']);

export async function main(argv = process.argv.slice(2), {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
} = {}) {
  const emit = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
  const mode = MODES.has(argv[0]) ? argv[0] : null;
  const args = mode === null ? argv : argv.slice(1);
  const command = args[0];
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    stdout.write(HELP);
    return 0;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const result = await runCommand(command, args.slice(1), { env, stdin, signal: controller.signal, mode });
    emit(result);
    return 0;
  } catch (error) {
    emit(errorResult(error));
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
