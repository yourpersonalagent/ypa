// ── MCP aggregator bridge: re-exposes all running upstream MCPs as ONE MCP ───
// Lets Claude Code (and any other host) connect to a single endpoint and see
// every tool/prompt/resource that YHA currently has loaded.
//
// Wire: stdio stub (bridge/mcp/yha-bridge-stub.js) → POST /proxy/mcp-bridge/rpc
//       Localhost-only; piggybacks on the existing /proxy/* auth bypass.
'use strict';

const { mcpConnections, BRIDGE_INTERNAL_KEY, BRIDGE_KEY_IS_SHARED } = require('../../../core/state');
const { timingSafeEqualStr } = require('../../../core/secure-compare');
const { callMcpTool } = require('./protocol');
const { BridgeNotFoundError } = require('../../../core/errors');
const logger = require('../../../core/logger');

const SEP = '__';
const RES_SCHEME = 'yha-bridge';

// Bridge tools allowlisted into MCP-Tools so subscription-Anthropic / Codex
// harnesses (which only see MCPs, not the OpenAI inline-tools surface) can
// reach selected session-aware YHA capabilities. Namespaced as
// `bridge__<Name>` to match the existing `<server>__<name>` convention.
const BRIDGE_VIRTUAL_SERVER = 'bridge';
const EXPOSED_BRIDGE_TOOLS = ['TodoWrite', 'TodoRead', 'AskUser', 'Frontend'];

function isAlive(conn) {
  try { return !!require('./protocol').isMcpConnAlive(conn); }
  catch (_) { return !!(conn?.proc && conn.proc.exitCode === null && !conn.proc.killed && conn.send); }
}

// Spawned harnesses (Claude CLI, Codex, etc.) reach upstream MCPs only
// through the MCP-Tools aggregator, so this is the 'main' audience seam.
// Hides anything resolved as 'pet-only'; 'chat-only' and 'all' both pass.
// The policy lives in bridge/modules/pet/lib/mcp-audience.ts.
function skipForMain(serverName: string): boolean {
  try {
    return !!require('../../pet/lib/mcp-audience').skipForAudience(serverName, 'main');
  } catch (_e) {
    return false;
  }
}

function bridgeToolEntries() {
  const { BRIDGE_TOOL_DEFS_STATIC } = require('../../../tools/defs');
  const out: any[] = [];
  for (const def of BRIDGE_TOOL_DEFS_STATIC) {
    const fn = def?.function;
    if (!fn?.name || !EXPOSED_BRIDGE_TOOLS.includes(fn.name)) continue;
    out.push({
      name: `${BRIDGE_VIRTUAL_SERVER}${SEP}${fn.name}`,
      description: fn.description || '',
      inputSchema: fn.parameters || { type: 'object', properties: {} },
    });
  }
  return out;
}

function aggregatedTools() {
  const out: any[] = [];
  for (const [server, conn] of mcpConnections) {
    if (!isAlive(conn)) continue;
    if (skipForMain(server)) continue;
    for (const t of conn.tools || []) {
      out.push({
        name: `${server}${SEP}${t.name}`,
        description: t.desc || t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      });
    }
  }
  out.push(...bridgeToolEntries());
  return out;
}

function aggregatedPrompts() {
  const out: any[] = [];
  for (const [server, conn] of mcpConnections) {
    if (!isAlive(conn)) continue;
    if (skipForMain(server)) continue;
    for (const p of conn.prompts || []) {
      out.push({
        name: `${server}${SEP}${p.name}`,
        description: p.desc || p.description || '',
        arguments: p.arguments || [],
      });
    }
  }
  return out;
}

function aggregatedResources() {
  const out: any[] = [];
  for (const [server, conn] of mcpConnections) {
    if (!isAlive(conn)) continue;
    if (skipForMain(server)) continue;
    for (const r of conn.resources || []) {
      out.push({
        uri: `${RES_SCHEME}://${encodeURIComponent(server)}/${encodeURIComponent(r.uri)}`,
        name: r.name || r.uri,
        description: r.desc || r.description || '',
        mimeType: r.mimeType || '',
      });
    }
  }
  return out;
}

function splitNamespaced(name) {
  const idx = String(name || '').indexOf(SEP);
  if (idx < 0) throw new Error(`Name not namespaced (expected "<server>${SEP}<name>"): ${name}`);
  return { server: name.slice(0, idx), original: name.slice(idx + SEP.length) };
}

function parseResourceUri(uri) {
  const m = new RegExp(`^${RES_SCHEME}://([^/]+)/(.*)$`).exec(String(uri || ''));
  if (!m) throw new Error(`Resource URI not from yha-bridge: ${uri}`);
  return { server: decodeURIComponent(m[1]), originalUri: decodeURIComponent(m[2]) };
}

// Generic upstream JSON-RPC call — reuses each conn's pending/send infra.
async function callUpstream(server, method, params, timeoutMs = 60000): Promise<any> {
  const conn = mcpConnections.get(server);
  if (!isAlive(conn))
    throw new BridgeNotFoundError(`MCP server "${server}" is not running`, { serverName: server });
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP ${method} timed out: ${server}`));
    }, timeoutMs);
    conn.pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      conn.send({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      clearTimeout(timer);
      conn.pending.delete(id);
      reject(e);
    }
  });
}

// Gate non-tools reads (prompts/get, resources/read) through the same source
// posture as tools/call. Internal servers and external sources at trust
// 'trusted'/'ask' may be read; a 'disabled' external source exposes nothing —
// otherwise an operator who turned a source off could still have its prompts
// and resources pulled (and a hostile upstream could use resources/read to
// probe internal URIs). Reads aren't write/destructive, so we only enforce the
// disabled gate, not the allowWrite flag.
function assertSourceReadable(server, what) {
  const { resolveSourcePolicy } = require('./policy');
  const { recordAudit } = require('./audit');
  const pol = resolveSourcePolicy(server);
  if (pol.kind === 'external' && pol.trust === 'disabled') {
    const reason = `External MCP source "${server}" is disabled by policy and cannot serve ${what}.`;
    recordAudit({ server, tool: what, kind: pol.kind, status: 'denied', reason });
    throw new Error(reason);
  }
}

// Execute one namespaced upstream tool call through the gateway's safety floor:
// the pet-internal guard, the exposed-bridge-tool allowlist, and (for real
// upstream servers) the policy gate + audit. Shared by the direct `tools/call`
// path and the Smart Gateway `call_mcp_tool` meta-tool so both honor the exact
// same gating and produce the same audit trail.
async function executeNamespacedCall(server, original, args, ctx: { sessionId?: string }) {
  if (skipForMain(server)) {
    throw new Error(`MCP server "${server}" is pet-internal and not available via MCP-Tools`);
  }
  if (server === BRIDGE_VIRTUAL_SERVER) {
    if (!EXPOSED_BRIDGE_TOOLS.includes(original)) {
      throw new Error(`Bridge tool not exposed via MCP-Tools: ${original}`);
    }
    const { executeBridgeTool } = require('../../../tools/exec');
    // sessionId is forwarded by yha-bridge-stub.js as X-Yha-Session-Id —
    // gives session-aware bridge tools (AskUser and Frontend) the right
    // answer/response endpoint to address. Falls back to process.cwd() for tools
    // that only need a WD key (TodoRead/TodoWrite).
    const { getSessionCwd } = require('../../../sessions-internal');
    const sessionCwd = ctx.sessionId ? getSessionCwd(ctx.sessionId) : process.cwd();
    const result = await executeBridgeTool(original, args || {}, sessionCwd, undefined, ctx.sessionId);
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    return { content: [{ type: 'text', text }] };
  }
  // Policy gate + audit for every upstream tool call crossing the gateway.
  // Internal YHA-owned servers pass freely; external sources are gated on
  // trust level and the per-source write flag (see ./policy). Every outcome
  // — denied, ok, or error — is recorded to the audit log (./audit).
  const { evaluateToolCall, resolveSourcePolicy } = require('./policy');
  const { recordAudit } = require('./audit');
  const kind = resolveSourcePolicy(server).kind;
  const decision = evaluateToolCall(server, original);
  if (!decision.allow) {
    recordAudit({ server, tool: original, kind, status: 'denied', reason: decision.reason, session: ctx.sessionId, args });
    throw new Error(decision.reason);
  }
  try {
    const result = await callMcpTool(server, original, args || {});
    recordAudit({ server, tool: original, kind, status: 'ok', session: ctx.sessionId, args });
    return result;
  } catch (e) {
    recordAudit({ server, tool: original, kind, status: 'error', reason: e instanceof Error ? e.message : String(e), session: ctx.sessionId, args });
    throw e;
  }
}

// Connected-source roster for the list_mcp_sources meta-tool: every live,
// non-pet source with its kind + tool count, plus the virtual bridge server.
function listSourcesSummary() {
  const { resolveSourcePolicy } = require('./policy');
  const out: any[] = [];
  for (const [server, conn] of mcpConnections) {
    if (!isAlive(conn)) continue;
    if (skipForMain(server)) continue;
    out.push({ name: server, kind: resolveSourcePolicy(server).kind, tools: (conn.tools || []).length });
  }
  out.push({ name: BRIDGE_VIRTUAL_SERVER, kind: 'internal', tools: bridgeToolEntries().length });
  return out;
}

// Smart Gateway meta-tool dispatch. search/describe/list are read-only and run
// against the audience-filtered corpus; call_mcp_tool re-enters the gated path.
async function dispatchMetaTool(name, args, ctx: { sessionId?: string }) {
  const { searchTools, describeTool } = require('./gateway-tools');
  const wrap = (obj: any) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
  switch (name) {
    case 'search_mcp_tools':
      return wrap(searchTools(aggregatedTools(), String(args?.query || ''), args?.limit));
    case 'describe_mcp_tool': {
      const hit = describeTool(aggregatedTools(), String(args?.name || ''));
      if (!hit) throw new Error(`Unknown MCP tool: ${args?.name}. Use search_mcp_tools to find valid names.`);
      return wrap(hit);
    }
    case 'list_mcp_sources':
      return wrap(listSourcesSummary());
    case 'call_mcp_tool': {
      const { server, original } = splitNamespaced(args?.name);
      return await executeNamespacedCall(server, original, args?.arguments || {}, ctx);
    }
    default:
      throw new Error(`Unknown gateway meta-tool: ${name}`);
  }
}

async function dispatch(method, params, ctx: { sessionId?: string } = {}) {
  const { getGatewayMode } = require('./state');
  const { isMetaTool, metaToolList } = require('./gateway-tools');
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: 'MCP-Tools', version: '1.0' },
      };
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return {};
    case 'tools/list':
      // Search mode advertises only the meta-tools; direct mode the full set.
      return { tools: getGatewayMode() === 'search' ? metaToolList() : aggregatedTools() };
    case 'tools/call': {
      // Meta-tools are honored regardless of mode (harmless in direct mode, and
      // keeps a harness that learned the search verbs working after a flip).
      if (isMetaTool(params?.name)) {
        return await dispatchMetaTool(params.name, params?.arguments || {}, ctx);
      }
      const { server, original } = splitNamespaced(params?.name);
      return await executeNamespacedCall(server, original, params?.arguments || {}, ctx);
    }
    case 'prompts/list':
      return { prompts: aggregatedPrompts() };
    case 'prompts/get': {
      const { server, original } = splitNamespaced(params?.name);
      assertSourceReadable(server, `prompt "${original}"`);
      return await callUpstream(server, 'prompts/get', {
        name: original,
        arguments: params?.arguments || {},
      });
    }
    case 'resources/list':
      return { resources: aggregatedResources() };
    case 'resources/read': {
      const { server, originalUri } = parseResourceUri(params?.uri);
      assertSourceReadable(server, `resource "${originalUri}"`);
      return await callUpstream(server, 'resources/read', { uri: originalUri });
    }
    default:
      throw new Error(`Method not supported by yha-bridge: ${method}`);
  }
}

function registerMcpBridgeRoutes(app) {
  const { getExternalSharing } = require('./state');

  // POST /proxy/mcp-bridge/rpc — single JSON-RPC envelope dispatch.
  // The /proxy/* prefix already bypasses WorkOS auth for localhost (auth.ts).
  app.post('/proxy/mcp-bridge/rpc', async (req, res) => {
    const ip = req.socket?.remoteAddress || req.ip || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) return res.status(403).json({ error: 'mcp-bridge is localhost-only' });
    if (!getExternalSharing()) return res.status(503).json({ error: 'MCP-Tools external sharing is disabled' });

    // The isLocal check above is not sufficient on its own: go-core's front door
    // reverse-proxies funnel traffic to the bridge over loopback, so an external
    // caller can appear local here. When a SHARED bridge key is configured (the
    // funnel-exposed deployments), require it — matching the sibling /proxy/tool
    // route — so only first-party callers that hold the secret can dispatch. In
    // ephemeral/dev mode no out-of-process caller can know the key, so we leave
    // the localhost + external-sharing gates as the sole guard (no regression).
    if (BRIDGE_KEY_IS_SHARED) {
      const key = String(req.headers['x-bridge-key'] || '');
      if (!key || !timingSafeEqualStr(key, BRIDGE_INTERNAL_KEY)) {
        return res.status(401).json({ error: 'invalid bridge key' });
      }
    }

    const body = (req.body as any) || {};
    const { id, method, params } = body;
    const isNotification = id === undefined || id === null;
    const sessionId = String(req.headers['x-yha-session-id'] || '') || undefined;

    try {
      const result = await dispatch(method, params || {}, { sessionId });
      if (isNotification) return res.status(204).end();
      res.json({ jsonrpc: '2.0', id, result });
    } catch (e) {
      logger.warn('mcp-bridge.rpc-error', {
        method,
        error: e instanceof Error ? e.message : String(e),
      });
      if (isNotification) return res.status(204).end();
      res.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
      });
    }
  });

  // GET /proxy/mcp-bridge/health — quick aggregate snapshot for sanity checks
  app.get('/proxy/mcp-bridge/health', (_req, res) => {
    let active = 0, tools = 0, prompts = 0, resources = 0;
    const servers: any[] = [];
    for (const [name, conn] of mcpConnections) {
      if (!isAlive(conn)) continue;
      active++;
      tools     += (conn.tools     || []).length;
      prompts   += (conn.prompts   || []).length;
      resources += (conn.resources || []).length;
      servers.push({
        name,
        tools: (conn.tools || []).length,
        prompts: (conn.prompts || []).length,
        resources: (conn.resources || []).length,
      });
    }
    res.json({ success: true, activeServers: active, tools, prompts, resources, servers });
  });

  // POST /proxy/tool — localhost-only bridge tool executor for RunCode's yha stdlib.
  // Python code running inside RunCode calls back here to invoke any bridge tool
  // (Read, Bash, Grep, WebSearch, MCP tools, …) without those intermediate results
  // ever touching the model's context window.
  app.post('/proxy/tool', async (req, res) => {
    const ip = req.socket?.remoteAddress || req.ip || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) return res.status(403).json({ error: 'proxy/tool is localhost-only' });

    const key = String(req.headers['x-bridge-key'] || '');
    if (!key || !timingSafeEqualStr(key, BRIDGE_INTERNAL_KEY)) return res.status(401).json({ error: 'invalid bridge key' });

    const body = (req.body as any) || {};
    const { name, input, cwd, sessionId } = body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const rewind = require('../../../core/rewind');
    rewind.markToolStart();
    try {
      const { executeBridgeTool } = require('../../../tools/exec');
      // 5th arg `sessionId` (optional) gives session-aware tools — currently
      // AskUser — the right SSE stream to address. Forwarded by Go's
      // nodecallback.Runner so the stream loop's tool calls reach the right
      // session. Older callers (RunCode's yha stdlib) omit sessionId and
      // still work because the bridge tools handle `undefined` cleanly.
      const result = await executeBridgeTool(
        name,
        input || {},
        cwd || undefined,
        undefined,
        sessionId ? String(sessionId) : undefined,
      );
      const out = Array.isArray(result) ? JSON.stringify(result) : String(result ?? '');
      res.json({ result: out });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    } finally {
      rewind.markToolEnd();
    }
  });
}

module.exports = {
  aggregatedTools,
  aggregatedPrompts,
  aggregatedResources,
  dispatch,
  registerMcpBridgeRoutes,
};
