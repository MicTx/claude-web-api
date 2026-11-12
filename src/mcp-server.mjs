import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isMainModule } from './is-main.mjs';
import { loadConfig } from './config.mjs';
import { ConsultBridge } from './consult-bridge.mjs';
import { BridgeError, errorResult } from './core/errors.mjs';
import { SERVER_INSTRUCTIONS, TOOLS } from './tool-contracts.mjs';
import { APP } from './identity.mjs';

export const SERVER_VERSION = '0.2.18';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'toString']);

export function validateInput(tool, args) {
  const check = (value, spec, key) => {
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new BridgeError('INVALID_ARGUMENT', `${key} must be a string`);
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        throw new BridgeError('INVALID_ARGUMENT', `${key} is too short`);
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        throw new BridgeError('INVALID_ARGUMENT', `${key} is too long`);
      }
      if (spec.pattern && !(new RegExp(spec.pattern).test(value))) {
        throw new BridgeError('INVALID_ARGUMENT', `${key} has an invalid format`);
      }
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw new BridgeError('INVALID_ARGUMENT', `${key} must be a boolean`);
    } else if (spec.type === 'array') {
      if (!Array.isArray(value) || value.length > spec.maxItems
        || Object.keys(value).length !== value.length
        || Object.keys(value).some((name, i) => name !== String(i))) {
        throw new BridgeError('INVALID_ARGUMENT', `${key} must be a bounded dense array`);
      }
      const items = value.map((item, i) => check(item, spec.items, `${key}[${i}]`));
      if (spec.uniqueItems && new Set(items).size !== items.length) throw new BridgeError('INVALID_ARGUMENT', `${key} contains duplicates`);
      return items;
    } else if (spec.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_ARGUMENT', `${key} must be an object`);
      const out = {};
      for (const name of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(name) || !Object.hasOwn(spec.properties, name)) throw new BridgeError('INVALID_ARGUMENT', `Unknown argument: ${name}`);
        out[name] = check(value[name], spec.properties[name], name);
      }
      for (const name of spec.required ?? []) {
        if (!Object.hasOwn(out, name)) throw new BridgeError('INVALID_ARGUMENT', `Missing required argument: ${name}`);
      }
      for (const [name, property] of Object.entries(spec.properties)) {
        if (!Object.hasOwn(out, name) && Object.hasOwn(property, 'default')) out[name] = property.default;
      }
      return out;
    }
    return value;
  };
  return check(args ?? {}, tool.inputSchema, 'arguments');
}

async function callTool(bridge, name, args, { signal }) {
  switch (name) {
    case 'claude_ask':
      return bridge.ask(args, { signal });
    case 'claude_follow_up':
      return bridge.followUp(args, { signal });
    case 'claude_download':
      return bridge.download(args, { signal });
    case 'claude_sessions':
      return bridge.sessions();
    case 'claude_transcript':
      return bridge.transcript({
        session: args.session,
        recover: args.recover ?? false,
        discardPending: args.discardPending ?? false,
      }, { signal });
    case 'claude_doctor':
      return bridge.doctor({}, { signal });
    default:
      throw new BridgeError('INVALID_ARGUMENT', `Unknown tool: ${name}`);
  }
}

export async function startServer({ config = loadConfig(), transport = new StdioServerTransport() } = {}) {
  const bridge = new ConsultBridge(config);
  const server = new Server({ name: APP, version: SERVER_VERSION }, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  });
  const jobs = new Set();
  const shutdown = new AbortController();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  async function handleCall(request, extra) {
    try {
      const tool = TOOLS.find((t) => t.name === request.params.name);
      if (!tool) throw new BridgeError('INVALID_ARGUMENT', `Unknown tool: ${request.params.name}`);
      const args = validateInput(tool, request.params.arguments);
      const signal = extra?.signal
        ? AbortSignal.any([shutdown.signal, extra.signal])
        : shutdown.signal;
      const result = await callTool(bridge, tool.name, args, { signal });
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      const result = errorResult(error);
      return {
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: true,
      };
    }
  }

  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const job = handleCall(request, extra);
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  });

  await server.connect(transport);

  let closing = null;
  const close = () => {
    if (!closing) {
      closing = (async () => {
        shutdown.abort();
        await Promise.allSettled([...jobs]);
        await server.close();
      })();
    }
    return closing;
  };
  // transport disconnect must abort in-flight work as well
  server.onclose = () => {
    shutdown.abort();
  };
  return { server, close };
}

if (isMainModule(import.meta.url)) {
  const { close } = await startServer();
  let handled = false;
  const onSignal = () => {
    if (handled) return;
    handled = true;
    process.exitCode = 130;
    void close().catch(() => {});
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const onEnd = () => {
    void close().catch(() => { process.exitCode = 1; });
  };
  process.stdin.once('end', onEnd);
  if (process.stdin.readableEnded) onEnd();
}
