// playwright-mcp search provider — turns the Playwright-driven `search` tool
// of the running `playwright-mcp` MCP server into a regular search-orchestrator
// stage. Lets users place real-Chrome Google/DuckDuckGo lookups anywhere in the
// fallback chain (e.g. as the first backup after Tavily).
//
// The orchestrator runs inside the websearch MCP child process, which can't
// reach the parent bridge's `mcpConnections` map directly. Instead we call
// back over HTTP to /proxy/mcp-bridge/rpc — the same aggregator endpoint that
// external MCP-Tools stubs use. Tool name follows the aggregator's namespacing:
// "<server>__<tool>", here "playwright-mcp__search".
'use strict';

const https = require('node:https');
const http  = require('node:http');

function bridgeBaseUrl() {
  // Prefer an explicit env hint (set by harness instances). Fall back to the
  // bridge's own PORT (inherited from parent) and the standard YHA scheme.
  if (process.env.YHA_BRIDGE_URL) return process.env.YHA_BRIDGE_URL.replace(/\/$/, '');
  const proto = process.env.USE_HTTP === 'true' ? 'http' : 'https';
  const port  = process.env.PORT || '8443';
  return `${proto}://127.0.0.1:${port}`;
}

// /proxy/mcp-bridge/rpc requires x-bridge-key when YHA runs with a shared
// YHA_BRIDGE_KEY. This provider runs inside the websearch MCP child where that
// env var is stripped, so fall back to reading bridge/.env (three dirs up).
// Empty when no shared key exists — the route skips the check in that mode.
const _bridgeKey = (() => {
  if (process.env.YHA_BRIDGE_KEY) return process.env.YHA_BRIDGE_KEY;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const txt = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*YHA_BRIDGE_KEY\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch (_) {}
  return '';
})();

function rpcCall(envelope, timeoutMs) {
  return new Promise((resolve, reject) => {
    const base = bridgeBaseUrl();
    const u = new URL('/proxy/mcp-bridge/rpc', base);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(envelope);
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        rejectUnauthorized: false, // YHA's self-signed localhost cert
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(_bridgeKey ? { 'x-bridge-key': _bridgeKey } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Bad JSON from bridge: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('playwright-mcp rpc timeout'));
    });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  name: 'playwright_mcp',
  // No external API; nothing to meter. cap.limit Infinity is honoured by the
  // orchestrator (skips the quota gate entirely).
  cap: { window: 'month', limit: Infinity },
  // No env key required — the orchestrator skips the env-gate when this is
  // falsy. The provider only works when the playwright-mcp MCP is running.
  envKey: '',
  async search(query, opts) {
    if (!query || !String(query).trim()) return [];
    const num = Math.max(1, Math.min(parseInt(opts && opts.num, 10) || 10, 25));
    const env = await rpcCall({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'playwright-mcp__search',
        arguments: { query, limit: num, engine: 'google' },
      },
    }, 30_000);

    if (env && env.error) {
      throw new Error(env.error.message || 'playwright-mcp rpc error');
    }
    const content = env && env.result && Array.isArray(env.result.content)
      ? env.result.content
      : null;
    if (!content) throw new Error('playwright-mcp returned no content');
    if (env.result.isError) {
      const txt = content.find((c) => c.type === 'text')?.text || 'unknown error';
      throw new Error('playwright-mcp: ' + txt.slice(0, 200));
    }
    const text = content.find((c) => c.type === 'text')?.text || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      throw new Error('playwright-mcp returned non-JSON text');
    }
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    return results.map((r) => ({
      title:   String(r.title || '').slice(0, 300),
      url:     String(r.url || ''),
      snippet: String(r.snippet || '').slice(0, 300),
      source:  'playwright_mcp',
    })).filter((r) => r.url);
  },
};
