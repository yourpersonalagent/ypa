// ── Smart Gateway: search-first meta-tools ────────────────────────────────────
// When the MCP-Tools gateway runs in 'search' mode, it stops advertising every
// upstream tool and instead exposes a tiny fixed set of meta-tools. A connected
// harness then searches for the tool it needs, reads that tool's schema, and
// calls it by name — instead of loading hundreds of tool schemas into its
// context up front. This is YHA's equivalent of Claude Code's on-demand MCP
// tool search, and it matters once a user has connected many external sources.
//
// This file is intentionally PURE: it owns the meta-tool definitions and the
// search/describe ranking, but it does not touch live connections or the policy
// gate. The aggregator (bridge.ts) feeds it the already-audience-filtered tool
// corpus and routes call_mcp_tool back through the normal gated dispatch path,
// so the search surface can never expose or run anything a direct call couldn't.
'use strict';

const SEP = '__';

// The four meta-tools the gateway advertises in search mode. Names are NOT
// namespaced (no `<server>__`) so they never collide with a real upstream tool.
const META_TOOLS = [
  {
    name: 'search_mcp_tools',
    description:
      'Search across every connected MCP tool by keyword. Returns matching tool names ' +
      '(formatted "<server>__<tool>") with one-line descriptions, ranked by relevance. ' +
      'Use this FIRST to find a tool, then describe_mcp_tool to read its input schema, ' +
      'then call_mcp_tool to run it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match against tool names and descriptions.' },
        limit: { type: 'number', description: 'Max results to return (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'describe_mcp_tool',
    description:
      'Return the full description and JSON input schema for one MCP tool, identified by ' +
      'its namespaced name ("<server>__<tool>"). Call this after search_mcp_tools to learn ' +
      'how to invoke a tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Namespaced tool name, e.g. "data-access__db_query".' },
      },
      required: ['name'],
    },
  },
  {
    name: 'call_mcp_tool',
    description:
      'Invoke an MCP tool by its namespaced name ("<server>__<tool>") with the given ' +
      'arguments. Subject to the same trust/write gating and audit as a direct tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Namespaced tool name, e.g. "data-access__db_query".' },
        arguments: { type: 'object', description: 'Arguments object passed to the tool.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_mcp_sources',
    description:
      'List the connected MCP sources (servers) reachable through the gateway, each with ' +
      'its kind (internal/external) and tool count. Use this to discover which servers exist ' +
      'before searching their tools.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const META_TOOL_NAMES = new Set(META_TOOLS.map((t) => t.name));

// Fresh copies so a caller mutating the returned array can't corrupt the defs.
function metaToolList(): any[] {
  return META_TOOLS.map((t) => ({ ...t, inputSchema: { ...t.inputSchema } }));
}

function isMetaTool(name: unknown): boolean {
  return typeof name === 'string' && META_TOOL_NAMES.has(name);
}

// Rank an aggregated-tool corpus against a free-text query. A name hit weighs
// more than a description hit; a tool must match at least one term to appear.
// `corpus` is the output of bridge.ts aggregatedTools(): [{ name, description,
// inputSchema }], already audience-filtered.
function searchTools(corpus: any[], query: string, limit?: number): any[] {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const cap = Math.min(Math.max(Number.isFinite(limit as number) ? (limit as number) : 20, 1), 50);
  if (!terms.length) {
    return corpus.slice(0, cap).map((t) => ({ name: t.name, description: t.description || '' }));
  }
  const scored: Array<{ name: string; description: string; score: number }> = [];
  for (const t of corpus) {
    const name = String(t.name || '').toLowerCase();
    const desc = String(t.description || '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 3;
      if (desc.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ name: t.name, description: t.description || '', score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, cap).map(({ name, description }) => ({ name, description }));
}

// Full schema for one namespaced tool, or null if it isn't in the corpus.
function describeTool(corpus: any[], name: string): any | null {
  const hit = corpus.find((t) => t.name === name);
  if (!hit) return null;
  return {
    name: hit.name,
    description: hit.description || '',
    inputSchema: hit.inputSchema || { type: 'object', properties: {} },
  };
}

module.exports = { SEP, META_TOOLS, META_TOOL_NAMES, metaToolList, isMetaTool, searchTools, describeTool };
