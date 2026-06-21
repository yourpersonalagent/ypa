#!/usr/bin/env node
// @ts-check
// Stdio MCP server "rag-search" — exposes the context-rag retrieve path to
// partner agents (Claude Code, Codex, etc.) as two tools:
//
//   rag_list_dbs()                 → enumerate available RAG databases
//   rag_search(query, ...filters)  → top-K similarity hits across one or
//                                    more DBs, with optional NIM rerank
//
// All work goes through the bridge's HTTP layer (/proxy/context-rag/*) so
// the bridge stays the single writer for vector-store state. Same protocol
// as agent-tools-server.js — different surface.
'use strict';

const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

// Inherit BRIDGE_INTERNAL_KEY + PORT from the parent process.env (set by
// the bridge's MCP launcher). Fall back to bridge/.env for any env vars
// the bridge knew about that didn't propagate into the child.
{
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

const BRIDGE_PORT = parseInt(process.env.PORT || '8443', 10);
const USE_HTTP = process.env.USE_HTTP === 'true';
const BRIDGE_BASE = `${USE_HTTP ? 'http' : 'https'}://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_KEY = process.env.BRIDGE_INTERNAL_KEY || '';

// Allow self-signed bridge certs when running over https
if (!USE_HTTP) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function bridgeFetch(method, urlPath, body) {
  const url = BRIDGE_BASE + urlPath;
  const init = {
    method,
    headers: { 'Authorization': `Bearer ${BRIDGE_KEY}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { success: false, error: text.slice(0, 200) }; }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

// Truncate hit body for display. The full chunk text can run to 800
// chars; the MCP tool's purpose is to give the caller enough signal to
// decide whether to fetch the source, not to paste the chunk verbatim.
function _snip(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ── MCP stdio transport ──────────────────────────────────────────────────────
const _stdinDecoder = new StringDecoder('utf8');
let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rag-search', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'rag_list_dbs',
            description:
              'List the RAG databases the host has configured (id, displayName, what kind of source each one indexes, which embedding model it uses). Use before rag_search to discover which dbIds are worth targeting — e.g. when the user asks about "last week\'s meeting notes", route to a sessions DB; when they ask about repo files, route to a files DB. Returns an empty list if the context-generator module is disabled.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'rag_search',
            description:
              "Search one or more YHA RAG databases for chunks most similar to a query. Returns up to k hits, each with the chunk text snippet, sourceKind (session|file|knowledge), sourceId (so you can fetch the full document), sourceUrl (file://... for file/knowledge hits, directly readable; yha://session/<id> for sessions — documentary), distance (lower = closer), optional rerankScore (when NIM reranker is available), and which dbId the hit came from. If dbIds isn't supplied, the search auto-routes — pass cwd to bias toward DBs that match the user's current project, or all=true to query every DB. Defaults to k=8 with rerank enabled.",
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Natural-language query. No need to phrase as a question — embedding-based retrieval works on topical similarity.',
                },
                dbIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Explicit list of database ids to query (from rag_list_dbs). Unknown ids are silently dropped. Omit to use auto-routing.',
                },
                cwd: {
                  type: 'string',
                  description: 'Current working directory of the caller. When supplied (and dbIds is omitted), auto-route biases toward DBs whose source filter matches this path.',
                },
                all: {
                  type: 'boolean',
                  description: 'If true and dbIds is omitted, query every configured DB regardless of cwd. Defaults to false.',
                },
                k: {
                  type: 'integer',
                  description: 'Number of hits to return after merge + rerank. Defaults to 8. Higher values cost more rerank tokens.',
                },
                rerank: {
                  type: 'boolean',
                  description: 'When true (default) and a NIM provider is available in the route, candidates are reranked with nvidia/rerank-qa-mistral-4b. Set false to use raw embedding distance only.',
                },
                sourceKind: {
                  type: 'string',
                  enum: ['session', 'file', 'knowledge'],
                  description:
                    'Restrict hits to a single source kind. Use "session" for transcript/chat history queries ("what did we decide last week?"), "file" for repository/codebase queries ("where is X defined?"), and "knowledge" for the user\'s curated keep-notes / saved decisions / handoff notes. Omit to search every kind.',
                },
                allowTiers: {
                  type: 'array',
                  items: { type: 'string', enum: ['public', 'system', 'sensitive'] },
                  description: 'Sensitivity tiers permitted in the result set. Defaults to ["public"]; pass ["public","system"] etc. only when the caller has the appropriate clearance.',
                },
              },
              required: ['query'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    handleToolCall(msg.id, name, args || {});
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

async function handleToolCall(id, name, args) {
  try {
    let text;

    if (name === 'rag_list_dbs') {
      const result = await bridgeFetch('GET', '/proxy/context-rag/dbs');
      const dbs = result.dbs || [];
      if (!dbs.length) {
        text = 'No RAG databases configured. The host can add one in the Hub → 🧬 RAG tab.';
      } else {
        const lines = dbs.map((d) => {
          const src = d.source?.kind || d.source?.sessions?.mode || 'mixed';
          return `• ${d.id} — ${d.displayName} [source:${src}, embed:${d.embedProvider}/${d.embedModel}]`;
        });
        text = `RAG databases (${dbs.length}):\n${lines.join('\n')}`;
      }

    } else if (name === 'rag_search') {
      if (!args.query || !String(args.query).trim()) throw new Error('query is required');
      const body = {
        query: String(args.query),
        dbIds: Array.isArray(args.dbIds) ? args.dbIds.map(String) : undefined,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        all: args.all === true,
        k: Number.isInteger(args.k) ? args.k : 8,
        rerank: args.rerank !== false,
        sourceKind: args.sourceKind,
        allowTiers: Array.isArray(args.allowTiers) ? args.allowTiers.map(String) : undefined,
      };
      const result = await bridgeFetch('POST', '/proxy/context-rag/search', body);
      const hits = result.hits || [];
      if (!hits.length) {
        text = `No hits for query "${_snip(args.query, 80)}".`;
        if (result.debug?.perDb?.length) {
          const errs = result.debug.perDb.filter((p) => p.error).map((p) => `${p.dbId}: ${p.error}`);
          if (errs.length) text += `\nErrors: ${errs.join('; ')}`;
        }
      } else {
        const lines = hits.map((h, i) => {
          const score = h.rerankScore != null
            ? `rerank=${Number(h.rerankScore).toFixed(3)}`
            : `dist=${Number(h.distance).toFixed(3)}`;
          const tag = `${h.dbDisplayName || h.dbId}/${h.sourceKind}`;
          const url = h.sourceUrl ? `\n    url: ${h.sourceUrl}` : '';
          return `[${i + 1}] ${tag} (${score}) ${h.sourceId}${url}\n    ${_snip(h.text, 240)}`;
        });
        text = `${hits.length} hit${hits.length === 1 ? '' : 's'} for "${_snip(args.query, 80)}":\n\n${lines.join('\n\n')}`;
      }

    } else {
      sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      return;
    }

    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text }] },
    });
  } catch (e) {
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: 'Error: ' + (e instanceof Error ? e.message : String(e)) }],
        isError: true,
      },
    });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer += _stdinDecoder.write(chunk);
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const clMatch = inputBuffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) { inputBuffer = inputBuffer.slice(headerEnd + 4); break; }
    const len = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (_) { /* ignore parse errors */ }
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();
