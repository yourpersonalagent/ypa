#!/usr/bin/env node
// @ts-check
// Stdio MCP server "websearch" — exposes a single tool: search.
// Delegates to bridge/search/orchestrator.js, which walks the configured
// providers (Tavily → Exa → Google CSE → Bing → free DDG/Brave) and tracks
// per-provider quota usage in bridge/search-usage.json.
'use strict';

const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

// Load bridge/.env so the child process sees TAVILY_API_KEY, EXA_API_KEY, etc.
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

const orchestrator = require('../modules/search/orchestrator');

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
        serverInfo: { name: 'websearch', version: '1.0.0' },
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
        tools: [{
          name: 'search',
          description:
            'Web search across multiple providers (Tavily, Exa, Google Custom Search, Bing) with automatic quota-aware fallback. Returns up to N results with title, URL, snippet, and (when available) cleaned page content. Falls through to a free DuckDuckGo/Brave fallback if all paid providers are exhausted or unconfigured.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              num_results: {
                type: 'integer',
                minimum: 1,
                maximum: 25,
                default: 10,
                description: 'Max number of results to return',
              },
            },
            required: ['query'],
          },
        }],
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
  if (name !== 'search') {
    sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
    return;
  }
  try {
    const out = await orchestrator.search(String(args.query || ''), { num: args.num_results || 10 });
    const md = orchestrator.formatMarkdown(out.results, out.used);
    const meta = `_attempts: ${out.attempts.map((a) => a.provider + ':' + a.status).join(', ')}_`;
    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: md + '\n\n' + meta }] },
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
