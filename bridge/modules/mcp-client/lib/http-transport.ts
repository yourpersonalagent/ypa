// ── MCP Streamable-HTTP / JSON-RPC transport helpers ────────────────────────
// Minimal remote MCP client for user-added external sources. Supports the
// common Streamable HTTP shape: JSON-RPC POST to the server URL, optional
// `Mcp-Session-Id` response header after initialize, and either plain JSON or
// text/event-stream responses containing JSON-RPC result events.
'use strict';

const crypto = require('crypto');

function descHash(desc: string): string {
  if (!desc) return 'none';
  return crypto.createHash('sha1').update(desc).digest('hex').slice(0, 8);
}

function authHeaders(cfg: any): Record<string, string> {
  const out: Record<string, string> = {};
  const auth = cfg?.auth || 'none';
  if (auth === 'bearer') {
    const token = cfg?.token || (cfg?.tokenEnv ? process.env[String(cfg.tokenEnv)] : '') || '';
    if (token) out.authorization = `Bearer ${token}`;
  }
  // OAuth is persisted by the external-source store, but a full browser/device
  // flow is intentionally not hidden in transport startup. If an OAuth source
  // already has an access token from a future flow, honor it as bearer here.
  if (auth === 'oauth') {
    const token = cfg?.accessToken || (cfg?.tokenEnv ? process.env[String(cfg.tokenEnv)] : '') || '';
    if (token) out.authorization = `Bearer ${token}`;
  }
  return out;
}

function parseSse(text: string): any {
  const events = text.split(/\r?\n\r?\n/);
  for (const ev of events) {
    const data = ev.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    try { return JSON.parse(data); } catch (_) {}
  }
  return null;
}

function normalizeResultPayload(payload: any, id: number): any {
  if (Array.isArray(payload)) payload = payload.find((p) => p?.id === id) || payload[0];
  if (payload?.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'result')) return payload.result;
  return payload;
}

async function httpRpc(connOrCfg: any, method: string, params: any = {}, timeoutMs = 60000): Promise<any> {
  const cfg = connOrCfg?.http || connOrCfg || {};
  const id = cfg.nextId = (cfg.nextId || 10) + 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': cfg.protocolVersion || '2024-11-05',
    ...(cfg.headers || {}),
    ...authHeaders(cfg),
  };
  if (cfg.sessionId) headers['mcp-session-id'] = cfg.sessionId;
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }),
      signal: controller.signal,
    });
    const session = res.headers.get('mcp-session-id');
    if (session) cfg.sessionId = session;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    const ctype = res.headers.get('content-type') || '';
    let payload: any = null;
    if (/text\/event-stream/i.test(ctype)) payload = parseSse(text);
    else if (text.trim()) payload = JSON.parse(text);
    return normalizeResultPayload(payload, id);
  } catch (e) {
    if ((e as any)?.name === 'AbortError') throw new Error(`MCP HTTP ${method} timed out`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function mapTools(result: any): any[] {
  return (result?.tools || []).map((t) => ({
    name: t.name,
    desc: t.description || '',
    descHash: descHash(t.description || ''),
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
    annotations: t.annotations || null,
  }));
}

function mapPrompts(result: any): any[] {
  return (result?.prompts || []).map((p) => ({
    name: p.name,
    desc: p.description || '',
    arguments: p.arguments || [],
  }));
}

function mapResources(result: any): any[] {
  return (result?.resources || []).map((r) => ({
    uri: r.uri,
    name: r.name || r.uri,
    desc: r.description || '',
    mimeType: r.mimeType || '',
  }));
}

async function startHttpMcpServer(name: string, cfg: any): Promise<any> {
  const http = {
    url: cfg.url,
    auth: cfg.auth || 'none',
    token: cfg.token,
    tokenEnv: cfg.tokenEnv,
    accessToken: cfg.accessToken,
    headers: cfg.headers || {},
    protocolVersion: cfg.protocolVersion || '2024-11-05',
    nextId: 10,
    sessionId: cfg.sessionId || null,
  };
  if (!http.url) throw new Error(`HTTP MCP source "${name}" missing url`);
  const init = await httpRpc({ http }, 'initialize', {
    protocolVersion: http.protocolVersion,
    capabilities: {},
    clientInfo: { name: 'yha-bridge', version: '1.0' },
  }, 15000);
  try { await httpRpc({ http }, 'notifications/initialized', {}, 5000); } catch (_) { /* optional */ }

  const [toolsR, promptsR, resourcesR] = await Promise.allSettled([
    httpRpc({ http }, 'tools/list', {}, 15000),
    httpRpc({ http }, 'prompts/list', {}, 10000),
    httpRpc({ http }, 'resources/list', {}, 10000),
  ]);
  const tools = toolsR.status === 'fulfilled' ? mapTools(toolsR.value) : [];
  const prompts = promptsR.status === 'fulfilled' ? mapPrompts(promptsR.value) : [];
  const resources = resourcesR.status === 'fulfilled' ? mapResources(resourcesR.value) : [];
  const exposesAny = tools.length + prompts.length + resources.length > 0;
  return {
    proc: null,
    transport: 'http',
    http,
    tools,
    prompts,
    resources,
    ok: exposesAny,
    error: exposesAny ? null : 'Remote MCP connected but exposes no tools, prompts, or resources',
    serverInfo: init?.serverInfo || null,
    pending: new Map(),
    nextId: http.nextId || 10,
    stdoutBuf: Buffer.alloc(0),
    send: null,
    _cfg: cfg,
    _userStopRequested: false,
  };
}

async function callHttpMcpTool(conn: any, toolName: string, args: any): Promise<any> {
  return await httpRpc(conn, 'tools/call', { name: toolName, arguments: args || {} }, 60000);
}

async function httpRequest(conn: any, method: string, params: any, timeoutMs = 5000): Promise<any> {
  return await httpRpc(conn, method, params || {}, timeoutMs);
}

module.exports = { startHttpMcpServer, callHttpMcpTool, httpRequest, _parseSse: parseSse };
