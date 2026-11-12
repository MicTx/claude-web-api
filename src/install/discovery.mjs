// Opt-in discovery for Magpie hubs. Unlike the initialize/tools/list-only
// probe, this path explicitly invokes the read-only find_tools meta-tool and
// validates the backend schemas it returns. It never calls call_tool, sends a
// Claude question, writes caches, or restarts a managed service.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultIo, sha256 } from './atomic.mjs';
import { inspectSources, localHubUrl } from './sources.mjs';
import { checkHost } from './engine.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT, TOOLS } from '../tool-contracts.mjs';
import { InstallError } from './errors.mjs';

const MAX_BODY = 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_REQUESTS = 8;
const SERVER = 'claude_web';
const QUERIES = ['claude_web__claude_download', 'claude_web__claude_doctor'];
const DISCOVERY_TOOL = 'find_tools';
const fail = (code, message) => { throw new InstallError(code, message); };

const matchesName = (name, expected) => name === expected
  || name === `${SERVER}__${expected}` || name === `mcp__${SERVER}__${expected}`;

export function firstJsonArray(text) {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '[') continue;
    let depth = 0, inString = false, escape = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escape) escape = false;
        else if (char === '\\') escape = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '[') depth++;
      else if (char === ']' && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1));
          if (Array.isArray(value)) return value;
        } catch { /* Try the next candidate array. */ }
        break;
      }
    }
  }
  return null;
}

export function schemaIsCurrent(tool, name) {
  const schema = tool?.inputSchema;
  if (!schema || schema.type !== 'object') return false;
  if (!['claude_ask', 'claude_follow_up'].includes(name)) return true;
  const prompt = schema.properties?.prompt, guidance = schema.properties?.guidance;
  return prompt?.type === 'string' && (prompt.description ?? '').includes(EXECUTABLE_GUIDANCE_CONTRACT)
    && schema.required?.includes('prompt') && schema.required.includes('session')
    && schema.properties?.session?.type === 'string'
    && guidance?.type === 'boolean' && guidance.default === false
    && !schema.required.includes('guidance');
}

export function verifyDiscoveredTools(entries) {
  const names = new Set(), tools = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string') continue;
    if (names.has(entry.name)) fail('DISCOVERY_TOOL_CONFLICT', 'Discovery returned duplicate tool names');
    names.add(entry.name);
    tools.set(entry.name, entry);
  }
  const missing = [], stale = [];
  for (const expected of TOOLS) {
    const matches = [...tools].filter(([name]) => matchesName(name, expected.name));
    if (matches.length === 0) missing.push(expected.name);
    else if (matches.length !== 1) fail('DISCOVERY_TOOL_CONFLICT', 'Discovery has ambiguous claude_web names');
    else if (!schemaIsCurrent(matches[0][1], expected.name)) stale.push(expected.name);
  }
  return { missing, stale, toolCount: tools.size,
    guidanceInSendSchemas: missing.length === 0 && stale.length === 0 };
}

async function httpTransport(route, host, signal, fetchImpl) {
  const url = localHubUrl(route.url, host.id);
  if (!url || route.configuredAuthentication || new URL(url).hostname === 'localhost') {
    fail('DISCOVERY_ROUTE_REFUSED', 'Discovery requires an exact unauthenticated literal loopback hub route');
  }
  let requests = 0, total = 0;
  const boundedFetch = async (input, init = {}) => {
    const destination = String(input instanceof Request ? input.url : input);
    if (destination !== url || ++requests > MAX_REQUESTS) fail('DISCOVERY_ROUTE_REFUSED', 'Discovery refused another destination or an excessive request count');
    if (init.method === 'GET') return new Response(null, { status: 405 });
    if (init.method !== 'POST') fail('DISCOVERY_METHOD_REFUSED', 'Discovery allows only MCP diagnostic POST requests');
    let message;
    try { message = JSON.parse(init.body); } catch { fail('DISCOVERY_METHOD_REFUSED', 'Discovery request is not an MCP message'); }
    const method = message?.method;
    if (!['initialize', 'notifications/initialized', 'tools/list', DISCOVERY_TOOL === 'find_tools' ? 'tools/call' : ''].includes(method)) {
      fail('DISCOVERY_METHOD_REFUSED', 'Discovery refused a non-diagnostic MCP method');
    }
    if (method === 'tools/call' && (message.params?.name !== 'find_tools'
      || message.params?.arguments?.server !== SERVER
      || !QUERIES.includes(message.params?.arguments?.query))) {
      fail('DISCOVERY_METHOD_REFUSED', 'Discovery allows only the exact read-only find_tools queries');
    }
    const response = await fetchImpl(url, { ...init, redirect: 'manual', credentials: 'omit',
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); fail('DISCOVERY_REDIRECT_REFUSED', 'Loopback MCP redirected; no redirect was followed');
    }
    if (!response.ok) {
      await response.body?.cancel(); fail('DISCOVERY_HTTP_ERROR', `Local MCP returned HTTP ${response.status}; response text was not disclosed`);
    }
    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel(); return new Response(null, { status: response.status, headers: response.headers });
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY)) {
      await response.body?.cancel(); fail('DISCOVERY_LIMIT', 'Local MCP response exceeds the diagnostic size limit');
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let count = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { reader.releaseLock(); controller.close(); return; }
          count += value.byteLength; total += value.byteLength;
          if (count > MAX_BODY || total > MAX_TOTAL) {
            await reader.cancel(); reader.releaseLock();
            controller.error(new InstallError('DISCOVERY_LIMIT', 'Local MCP response exceeds the diagnostic size limit')); return;
          }
          controller.enqueue(value);
        } catch (error) {
          try { await reader.cancel(); } catch { /* preserve the stream error */ }
          finally { try { reader.releaseLock(); } catch { /* already released */ } }
          controller.error(error);
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  };
  return new StreamableHTTPClientTransport(new URL(url), { fetch: boundedFetch,
    requestInit: { redirect: 'manual', credentials: 'omit' },
    reconnectionOptions: { maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1, maxRetries: 0 } });
}

export async function discoverHost(host, target, { io = defaultIo(), signal, timeoutMs = 5000, fetchImpl = globalThis.fetch, ...deps } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) fail('INVALID_ARGUMENT', 'Discovery timeout must be between 10 and 10000 ms');
  const result = { verification: 'discovery-schemas', hostLoaded: false, claudeSent: false, cacheChanged: false,
    nextAction: 'Reconnect the actual host through its supported MCP refresh/reload entry and inspect its tool list; discovery does not prove that a running host reloaded its schemas.' };
  const control = new AbortController();
  let timedOut = false, timer, abortHandler, transport, client, outcome, source;
  const combined = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => reject(new InstallError(timedOut ? 'DISCOVERY_TIMEOUT' : 'DISCOVERY_ABORTED',
      timedOut ? 'Read-only MCP discovery exceeded its deadline' : 'Read-only discovery was cancelled'));
    combined.addEventListener('abort', abortHandler, { once: true });
  });
  void abortPromise.catch(() => {});
  const bounded = operation => Promise.race([operation, abortPromise]);
  try {
    if (signal?.aborted) fail('DISCOVERY_ABORTED', 'Read-only discovery was cancelled');
    timer = setTimeout(() => { timedOut = true; control.abort(); }, timeoutMs);
    const checked = await bounded(checkHost(host, target, { ...deps, io }));
    if (!checked.healthy) fail('DISCOVERY_ROUTE_REFUSED', 'Configuration or installer record validation failed; discovery did not contact it');
    source = await bounded(inspectSources(host, target, { ...deps, io }));
    if (checked.source.configSha256 !== source.configSha256 || checked.source.librarySha256 !== source.librarySha256) {
      fail('CONFIG_CHANGED', 'Configuration provenance changed before discovery');
    }
    if (source.kind !== 'magpie-hub' || source.route?.type !== 'http' || source.healthy === false) {
      fail('DISCOVERY_ROUTE_REFUSED', 'Discovery is only defined for a verified Magpie discovery hub');
    }
    const operation = (async () => {
      transport = await httpTransport(source.route, host, combined, fetchImpl);
      client = new Client({ name: 'ccw-read-only-discovery', version: '1' }, { capabilities: {} });
      await client.connect(transport, { signal: combined, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      const { tools } = await client.request({ method: 'tools/list' }, ListToolsResultSchema,
        { signal: combined, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      const meta = tools.find(tool => tool.name === 'find_tools');
      if (!meta || tools.some(tool => tool.name === 'call_tool') === false) {
        fail('DISCOVERY_UNSUPPORTED', 'Hub does not expose the expected find_tools/call_tool discovery pair');
      }
      const entries = new Map(), queries = [];
      for (const query of QUERIES) {
        const response = await client.request({ method: 'tools/call', params: { name: 'find_tools',
          arguments: { server: SERVER, query } } }, CallToolResultSchema,
        { signal: combined, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
        if (response.isError) fail('DISCOVERY_BACKEND_ERROR', 'Discovery meta-tool returned an error; its body was not disclosed');
        const text = response.content?.find(item => item.type === 'text')?.text;
        if (typeof text !== 'string' || text.length > MAX_BODY) fail('DISCOVERY_LIMIT', 'Discovery response is missing bounded text metadata');
        const parsed = firstJsonArray(text);
        if (!parsed) fail('DISCOVERY_PARSE', 'Discovery metadata did not contain a bounded JSON tool array');
        for (const entry of parsed) if (entry && typeof entry.name === 'string') entries.set(entry.name, entry);
        queries.push({ query, count: parsed.length });
      }
      const verified = verifyDiscoveredTools([...entries.values()]);
      const ok = verified.missing.length === 0 && verified.stale.length === 0;
      return { ...result, ok, reachable: true, source: source.kind, discoveryQueries: queries,
        requiredTools: TOOLS.length, toolCount: verified.toolCount, missingTools: verified.missing,
        staleSchemas: verified.stale, guidanceInSendSchemas: verified.guidanceInSendSchemas,
        contractSha256: sha256(EXECUTABLE_GUIDANCE_CONTRACT),
        ...(ok ? {} : { error: { code: 'DISCOVERY_STALE_SCHEMA', message: 'Backend discovery schemas are missing or not current; reconnect the host only after the manager metadata is refreshed' } }),
        configSha256: source.configSha256, ...(source.librarySha256 ? { librarySha256: source.librarySha256 } : {}) };
    })();
    outcome = await bounded(operation);
  } catch (error) {
    outcome = { ...result, ok: false, reachable: false, ...(source ? { source: source.kind } : {}),
      error: error instanceof InstallError ? { code: error.code, message: error.message }
        : { code: timedOut ? 'DISCOVERY_TIMEOUT' : (signal?.aborted ? 'DISCOVERY_ABORTED' : 'DISCOVERY_PROTOCOL_ERROR'),
          message: 'Read-only MCP discovery failed; no remote body, stderr or configuration values were disclosed' } };
  } finally {
    clearTimeout(timer);
    if (abortHandler) combined.removeEventListener('abort', abortHandler);
    control.abort();
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
  }
  return outcome;
}
