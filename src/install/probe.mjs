// An opt-in protocol-only diagnostic. No tools/call, send, manager restart,
// cache rewrite or host reload. Only independently rechecked local routes may
// enter an SDK transport; even remote-provided errors stay out of the report.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { defaultIo, sha256 } from './atomic.mjs';
import { inspectSources, localHubUrl } from './sources.mjs';
import { checkHost } from './engine.mjs';
import { EXECUTABLE_GUIDANCE_CONTRACT, TOOLS } from '../tool-contracts.mjs';
import { InstallError } from './errors.mjs';

const MAX_BODY = 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_TOOLS = 2048;
const MAX_PAGES = 8;
const MAX_REQUESTS = 16;
const fail = (code, message) => { throw new InstallError(code, message); };
const advice = host => `After resolving the reported condition, reconnect ${host.label} through its supported MCP refresh/reload entry and inspect its actual tool list. Do not reinstall, restart the gateway or erase caches to make this probe green.`;

function allowedMethod(message) {
  return message && !Array.isArray(message) && ['initialize', 'notifications/initialized', 'tools/list', 'notifications/cancelled'].includes(message.method);
}

function limitedTransport(transport) {
  const close = transport.close.bind(transport);
  let closing;
  // SDK connect failures may initiate close without awaiting it. Cache that
  // same operation so our finally still waits for the owned process to exit.
  transport.close = () => closing ??= close();
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (!allowedMethod(message)) fail('PROBE_METHOD_REFUSED', 'Probe refused a non-diagnostic MCP method');
    return send(message, options);
  };
  return transport;
}

async function httpTransport(route, host, signal, fetchImpl) {
  const url = localHubUrl(route.url, host.id);
  if (!url || route.configuredAuthentication || new URL(url).hostname === 'localhost') fail('PROBE_ROUTE_REFUSED', 'Probe requires an exact unauthenticated literal loopback hub route; DNS aliases and configured credentials are not copied or guessed');
  let requests = 0, total = 0;
  const boundedFetch = async (input, init = {}) => {
    const destination = String(input instanceof Request ? input.url : input);
    if (destination !== url || ++requests > MAX_REQUESTS) fail('PROBE_ROUTE_REFUSED', 'Probe refused another destination or an excessive request count');
    if (init.method === 'GET') return new Response(null, { status: 405 }); // No background SSE subscription or reconnect.
    if (init.method !== 'POST') fail('PROBE_METHOD_REFUSED', 'Probe allows only MCP diagnostic POST requests');
    let message;
    try { message = JSON.parse(init.body); } catch { fail('PROBE_METHOD_REFUSED', 'Probe request is not a diagnostic MCP message'); }
    if (!allowedMethod(message)) fail('PROBE_METHOD_REFUSED', 'Probe refused a non-diagnostic MCP method');
    const response = await fetchImpl(url, { ...init, redirect: 'manual', credentials: 'omit',
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); fail('PROBE_REDIRECT_REFUSED', 'Loopback MCP redirected; no redirect was followed');
    }
    if (!response.ok) {
      await response.body?.cancel(); fail('PROBE_HTTP_ERROR', `Local MCP returned HTTP ${response.status}; response text was not disclosed`);
    }
    if (response.status === 202 || response.status === 204) { await response.body?.cancel(); return new Response(null, { status: response.status, headers: response.headers }); }
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY)) {
      await response.body?.cancel(); fail('PROBE_LIMIT', 'Local MCP response exceeds the diagnostic size limit');
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
            controller.error(new InstallError('PROBE_LIMIT', 'Local MCP response exceeds the diagnostic size limit')); return;
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
  return limitedTransport(new StreamableHTTPClientTransport(new URL(url), { fetch: boundedFetch,
    requestInit: { redirect: 'manual', credentials: 'omit' }, reconnectionOptions: { maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1, maxRetries: 0 } }));
}

export async function probeHost(host, target, { io = defaultIo(), signal, timeoutMs = 5000, fetchImpl = globalThis.fetch, ...deps } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10000) fail('INVALID_ARGUMENT', 'Probe timeout must be between 10 and 10000 ms');
  const result = { verification: 'protocol-only', hostLoaded: false, claudeSent: false, cacheChanged: false, nextAction: advice(host) };
  let source, transport, client, timer, outcome;
  const control = new AbortController();
  let timedOut = false, protocolError = null, closedEarly = false, abortHandler;
  const finish = () => control.abort();
  const combined = signal ? AbortSignal.any([signal, control.signal]) : control.signal;
  const abortPromise = new Promise((_, reject) => {
    abortHandler = () => reject(new InstallError(timedOut ? 'PROBE_TIMEOUT' : 'PROBE_ABORTED', timedOut ? 'Read-only MCP probe exceeded its deadline' : 'Read-only probe was cancelled'));
    combined.addEventListener('abort', abortHandler, { once: true });
  });
  // Provenance reads share the deadline too. If an underlying filesystem call
  // cannot be cancelled, its eventual continuation must not start transport.
  void abortPromise.catch(() => {});
  timer = setTimeout(() => { timedOut = true; finish(); }, timeoutMs);
  const bounded = operation => Promise.race([operation, abortPromise]);
  try {
    if (signal?.aborted) fail('PROBE_ABORTED', 'Read-only probe was cancelled');
    // Do not trust route data passed in by a caller: read and validate the
    // real config again immediately before connecting.
    const checked = await bounded(checkHost(host, target, { ...deps, io }));
    if (!checked.healthy) fail('PROBE_ROUTE_REFUSED', 'Configuration or installer record validation failed; probe did not contact it');
    source = await bounded(inspectSources(host, target, { ...deps, io }));
    if (checked.source.configSha256 !== source.configSha256 || checked.source.librarySha256 !== source.librarySha256) fail('CONFIG_CHANGED', 'Configuration provenance changed before probing');
    if (!source.route || source.healthy === false || source.route.configuredEnvironment) fail('PROBE_ROUTE_REFUSED', 'Source is unresolved or needs configured process environment; probe did not execute it');
    if (signal?.aborted) fail('PROBE_ABORTED', 'Read-only probe was cancelled');
    const operation = (async () => {
      if (source.route.type === 'http') transport = await httpTransport(source.route, host, combined, fetchImpl);
      else if (source.route.type === 'stdio') {
        const env = Object.fromEntries(['HOME', 'PATH', 'SYSTEMROOT', 'WINDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
        if (deps.home) env.HOME = deps.home;
        transport = limitedTransport(new StdioClientTransport({ command: source.route.command, args: source.route.args, env, stderr: 'pipe', maxBufferSize: MAX_BODY, cwd: deps.home }));
        // Consume but never expose stderr; bound a misbehaving runtime's noise
        // without retaining private paths, configuration values or tokens.
        let stderrBytes = 0;
        transport.stderr?.on('data', chunk => { if ((stderrBytes += chunk.byteLength) > MAX_BODY) finish(); });
      } else fail('PROBE_ROUTE_REFUSED', 'Probe does not support this route');
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if (combined.aborted) fail(timedOut ? 'PROBE_TIMEOUT' : 'PROBE_ABORTED', 'Read-only MCP probe stopped before another request');
        return send(message, options);
      };
      const start = transport.start.bind(transport);
      transport.start = async () => {
        if (combined.aborted) fail('PROBE_ABORTED', 'Read-only MCP probe stopped before transport startup');
        return start();
      };
      client = new Client({ name: 'ccw-read-only-probe', version: '1' }, { capabilities: {} });
      client.onerror = error => { protocolError ??= error; };
      client.onclose = () => { closedEarly = true; };
      await client.connect(transport, { signal: combined, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      const tools = [], cursors = new Set();
      let cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await client.request({ method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) }, ListToolsResultSchema, { signal: combined, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
        tools.push(...response.tools);
        if (tools.length > MAX_TOOLS) fail('PROBE_LIMIT', 'Local MCP exposes too many tools for this bounded probe');
        if (!response.nextCursor) break;
        if (page === MAX_PAGES - 1 || cursors.has(response.nextCursor)) fail('PROBE_LIMIT', 'Local MCP tool pagination did not terminate within the diagnostic bound');
        cursors.add(response.nextCursor); cursor = response.nextCursor;
      }
      const names = new Set();
      for (const tool of tools) {
        if (names.has(tool.name)) fail('PROBE_TOOL_CONFLICT', 'Local MCP returned duplicate tool names');
        names.add(tool.name);
      }
      const matchesName = (name, expected) => name === expected || name === `claude_web__${expected}` || name === `mcp__claude_web__${expected}`;
      if (source.kind === 'magpie-hub' && names.has('find_tools') && names.has('call_tool')
        && !tools.some(tool => TOOLS.some(expected => matchesName(tool.name, expected.name)))) {
        // A discovery-mode hub intentionally exposes meta-tools, not backend
        // schemas. Absence in tools/list is NOT a stale-cache diagnosis. The
        // contract forbids tools/call, including automatic find_tools calls.
        return { ...result, ok: false, reachable: true, source: source.kind, toolCount: tools.length, requiredTools: TOOLS.length,
          discoveryOnly: true, missingTools: null, staleSchemas: null, guidanceInSendSchemas: null,
          guidanceInInitialize: (client.getInstructions() ?? '').includes(EXECUTABLE_GUIDANCE_CONTRACT),
          error: { code: 'PROBE_DISCOVERY_ONLY', message: 'Hub exposes discovery meta-tools; backend schemas are unverified, not proven missing or stale. Probe did not invoke find_tools or call_tool' },
          nextAction: 'In the actual host, inspect find_tools with {server:"claude_web",query:"claude"} and verify all six schemas. This requires explicit metadata-discovery use outside this initialize/tools/list-only probe; do not add direct registration, rewrite caches or restart the gateway.',
          configSha256: source.configSha256, ...(source.librarySha256 ? { librarySha256: source.librarySha256 } : {}) };
      }
      const missing = [], stale = [];
      for (const expected of TOOLS) {
        // Magpie may prefix names with the source namespace. Only one precise
        // source suffix is accepted, not an arbitrary similar-looking tool.
        const matches = tools.filter(tool => matchesName(tool.name, expected.name));
        if (matches.length === 0) missing.push(expected.name);
        else if (matches.length !== 1) fail('PROBE_TOOL_CONFLICT', 'Local MCP has ambiguous claude_web names');
        else if (['claude_ask', 'claude_follow_up'].includes(expected.name)) {
          const schema = matches[0].inputSchema, prompt = schema?.properties?.prompt, guidance = schema?.properties?.guidance;
          if (schema.type !== 'object' || prompt?.type !== 'string' || !schema.required?.includes('prompt')
            || !schema.required?.includes('session') || schema.properties?.session?.type !== 'string'
            || guidance?.type !== 'boolean' || guidance.default !== false || schema.required.includes('guidance')
            || !(prompt.description ?? '').includes(EXECUTABLE_GUIDANCE_CONTRACT)) stale.push(expected.name);
        }
      }
      if (protocolError || closedEarly) fail('PROBE_PROTOCOL_ERROR', 'Local MCP disconnected or returned an invalid protocol message');
      return { ...result, ok: missing.length === 0 && stale.length === 0, reachable: true, source: source.kind, toolCount: tools.length,
        requiredTools: TOOLS.length, missingTools: missing, staleSchemas: stale,
        guidanceInInitialize: (client.getInstructions() ?? '').includes(EXECUTABLE_GUIDANCE_CONTRACT),
        guidanceInSendSchemas: missing.length === 0 && stale.length === 0,
        ...(missing.length || stale.length ? { error: { code: 'PROBE_STALE_SCHEMA', message: 'Endpoint is reachable but required tools or complete send schemas are missing; reconnect the host only after the endpoint metadata is current' } } : {}),
        configSha256: source.configSha256, ...(source.librarySha256 ? { librarySha256: source.librarySha256 } : {}),
        contractSha256: sha256(EXECUTABLE_GUIDANCE_CONTRACT) };
    })();
    outcome = await bounded(operation);
  } catch (error) {
    outcome = { ...result, ok: false, reachable: false, ...(source ? { source: source.kind } : {}),
      error: error instanceof InstallError ? { code: error.code, message: error.message }
        : { code: timedOut ? 'PROBE_TIMEOUT' : (signal?.aborted ? 'PROBE_ABORTED' : 'PROBE_PROTOCOL_ERROR'), message: 'Read-only MCP initialize/tools/list failed; no remote body, stderr or configuration values were disclosed' } };
  } finally {
    clearTimeout(timer);
    if (abortHandler) combined.removeEventListener('abort', abortHandler);
    // Closing a client never sends DELETE/terminateSession to an externally
    // managed endpoint. A stdio close affects only the process we just created.
    finish();
    let cleanupFailed = false;
    if (client) await client.close().catch(() => { cleanupFailed = true; });
    if (transport) await transport.close().catch(() => { cleanupFailed = true; });
    if (cleanupFailed) outcome = { ...outcome, ok: false, cleanupPending: true,
      error: { code: 'PROBE_CLEANUP', message: 'Read-only probe could not confirm cleanup of its own connection; no external process was stopped' } };
  }
  return outcome;
}
