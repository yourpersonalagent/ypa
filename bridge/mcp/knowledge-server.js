#!/usr/bin/env node
// @ts-check
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

// ── Roots ───────────────────────────────────────────────────────────────────
// Resolved through bridge/core/paths.ts so the data root tracks the Q16
// per-user migration: legacy is bridge/knowledge/, post-migration moves to
// bridge/users/<email>/knowledge/. Single source of truth.
const KNOWLEDGE_ROOT = require('../core/paths').knowledgeRoot;
const DIRS_ROOT      = path.join(KNOWLEDGE_ROOT, 'dirs');
const INDEX_JSON     = path.join(KNOWLEDGE_ROOT, 'index.json');

// Bridge HTTP (for RAG fan-out). Same env-loading pattern as rag-search-server.js.
(function loadBridgeEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();
const BRIDGE_PORT = parseInt(process.env.PORT || '8443', 10);
const BRIDGE_USE_HTTP = process.env.USE_HTTP === 'true';
const BRIDGE_BASE = `${BRIDGE_USE_HTTP ? 'http' : 'https'}://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_KEY  = process.env.BRIDGE_INTERNAL_KEY || '';
if (!BRIDGE_USE_HTTP) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function bridgeFetch(method, urlPath, body) {
  const init = { method, headers: { Authorization: `Bearer ${BRIDGE_KEY}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BRIDGE_BASE + urlPath, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { success: false, error: text.slice(0, 200) }; }
  if (!res.ok || json.success === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ── Per-workingDir path resolution ──────────────────────────────────────────
function slugifyCwd(workingDir) {
  return workingDir
    .toLowerCase()
    .replace(/^[/\\]+|[/\\]+$/g, '')
    .replace(/[/\\]+/g, '___');
}

function readIndex() {
  if (!fs.existsSync(INDEX_JSON)) return {};
  try { return JSON.parse(fs.readFileSync(INDEX_JSON, 'utf8')); }
  catch (_) { return {}; }
}

function writeIndex(idx) {
  fs.mkdirSync(KNOWLEDGE_ROOT, { recursive: true });
  fs.writeFileSync(INDEX_JSON, JSON.stringify(idx, null, 2) + '\n');
}

function recordSlug(slug, workingDir) {
  const idx = readIndex();
  if (idx[slug] && idx[slug] !== workingDir) {
    throw new Error(`slug collision: '${slug}' already maps to '${idx[slug]}', refusing to overwrite with '${workingDir}'`);
  }
  if (idx[slug] !== workingDir) {
    idx[slug] = workingDir;
    writeIndex(idx);
  }
}

function resolveDirs(workingDir) {
  if (!workingDir || typeof workingDir !== 'string')
    throw new Error("workingDir is required; pass the absolute path of the project this knowledge belongs to");
  if (!path.isAbsolute(workingDir))
    throw new Error(`workingDir must be an absolute path, got: ${workingDir}`);
  if (!fs.existsSync(workingDir))
    throw new Error(`workingDir does not exist: ${workingDir}`);

  const slug          = slugifyCwd(workingDir);
  const KNOWLEDGE_DIR = path.join(DIRS_ROOT, slug);
  const GRAPH_DIR     = path.join(KNOWLEDGE_DIR, 'graph');
  const SYN_DIR       = path.join(KNOWLEDGE_DIR, 'synthesis');
  const dirs = {
    slug,
    workingDir,
    KNOWLEDGE_DIR,
    GRAPH_DIR,
    GRAPH_JSON:   path.join(GRAPH_DIR, 'graph.json'),
    GRAPH_REPORT: path.join(GRAPH_DIR, 'GRAPH_REPORT.md'),
    SYN_DIR,
    SYN_INDEX: path.join(SYN_DIR, 'index.md'),
    SYN_LOG:   path.join(SYN_DIR, 'log.md'),
  };

  for (const d of [GRAPH_DIR, SYN_DIR,
                   path.join(SYN_DIR, 'concepts'),
                   path.join(SYN_DIR, 'decisions'),
                   path.join(SYN_DIR, 'summaries')]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(dirs.SYN_INDEX)) fs.writeFileSync(dirs.SYN_INDEX, '# Knowledge Index\n\n');
  if (!fs.existsSync(dirs.SYN_LOG))   fs.writeFileSync(dirs.SYN_LOG,   '# Activity Log\n\n');

  recordSlug(slug, workingDir);
  return dirs;
}

// ── One-shot legacy migration ───────────────────────────────────────────────
// Old layout: bridge/knowledge/{graph,synthesis}/...
// New layout: bridge/knowledge/dirs/<slug>/{graph,synthesis}/...
(function migrateLegacy() {
  const legacyGraph = path.join(KNOWLEDGE_ROOT, 'graph');
  const legacySyn   = path.join(KNOWLEDGE_ROOT, 'synthesis');
  if (fs.existsSync(DIRS_ROOT)) return;
  if (!fs.existsSync(legacyGraph) && !fs.existsSync(legacySyn)) return;

  const yhaRoot = path.resolve(__dirname, '..', '..');
  const slug    = slugifyCwd(yhaRoot);
  const target  = path.join(DIRS_ROOT, slug);
  fs.mkdirSync(target, { recursive: true });

  if (fs.existsSync(legacyGraph)) fs.renameSync(legacyGraph, path.join(target, 'graph'));
  if (fs.existsSync(legacySyn))   fs.renameSync(legacySyn,   path.join(target, 'synthesis'));

  const idx = readIndex();
  idx[slug] = yhaRoot;
  writeIndex(idx);
})();

// ── MCP stdio transport (same framing as code-server.js) ────────────────────
let inputBuffer = '';
function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    return sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'knowledge-memory', version: '2.0.0' },
      },
    });
  }
  if (msg.method === 'initialized' || msg.method === 'notifications/initialized') return;
  if (msg.method === 'ping') return sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });

  if (msg.method === 'tools/list') {
    return sendMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  }
  if (msg.method === 'tools/call') {
    return handleToolCall(msg.id, msg.params.name, msg.params.arguments || {});
  }
  if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id,
                  error: { code: -32601, message: 'Method not found' } });
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
    if (Buffer.byteLength(inputBuffer, 'utf8') < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (_) {}
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();

// ── Tool catalog ────────────────────────────────────────────────────────────
const CWD_PROP = {
  type: 'string',
  description: 'Absolute path of the working directory whose knowledge bucket to use. Each working directory has its own graph + synthesis pages under bridge/knowledge/dirs/<slug>/.',
};

// ── Tool ordering ────────────────────────────────────────────────────────────
// `knowledge_ask` is the FIRST entry on purpose: it is the unified retrieval
// surface that fans out across graph + synthesis + log + RAG and is the right
// answer for ~every conceptual question about a codebase. The legacy granular
// readers (synthesize, search_synthesis, list/read_synthesis_page,
// query_code_graph) stay listed so admin / debug callers can target one layer,
// but their descriptions defer to `knowledge_ask` so models don't route there
// by default. Writers (write_synthesis_page, append_log, build_code_graph)
// keep their existing weight — they have no `knowledge_ask` equivalent.
const TOOLS = [
  { name: 'knowledge_ask',
    description: 'PRIMARY knowledge-retrieval tool for any codebase question. One call fans out across the code graph, synthesis pages, activity log, and RAG databases, cross-ranks the hits, and returns a tier-shaped JSON bundle with a `health` field that surfaces silent failures (wrong slug, stale graph, empty RAG). USE THIS FIRST for any "why / how / where / what does X do" question about a workingDir — it replaces a multi-tool dance over synthesize/search_synthesis/query_code_graph/rag_search. Auto-resolves cwd → slug, auto-classifies intent. Every evidence row carries a `cursor` — call again with `follow_up: "<cursor>"` to expand a hit. Pick `model_tier` to size the response: `tiny` (~700 tok, top-3), `small` (~3k tok, top-8 + graph neighborhood, default), `large` (~10k tok, top-20). Falls back gracefully when no bucket exists yet.',
    inputSchema: { type: 'object', properties: {
      query:        { type: 'string', description: 'Natural-language question or topic.' },
      cwd:          { type: 'string', description: 'Optional absolute path; defaults to process.cwd(). Sparse slugs auto-escalate to the nearest non-sparse parent (reported in health.escalated).' },
      intent:       { type: 'string', enum: ['auto','concept','code','history','howto'], description: 'Routing hint. `auto` (default) uses a regex classifier.' },
      model_tier:   { type: 'string', enum: ['tiny','small','large'], description: 'Response sizing. tiny=haiku, small=sonnet (default), large=opus.' },
      budget_tokens:{ type: 'number', description: 'Soft cap on response tokens; trailing evidence is dropped to fit.' },
      follow_up:    { type: 'string', description: 'Opaque cursor from a prior evidence row. When set, query is ignored and the cursor is expanded.' },
    }, required: ['query'] } },

  { name: 'write_synthesis_page',
    description: 'Create or overwrite a durable synthesis page in `workingDir`\'s bucket. Use ONLY when you have just figured out something a future session would benefit from re-reading: a concept (`concepts/<topic>.md`), a decision and its rationale (`decisions/<topic>.md`), or a summary of a sprawling subsystem (`summaries/<topic>.md`). Do NOT use for transient task state (use TodoWrite), short personal notes (use important_add), or one-off scratch — those become write-only memory and pure cost. Pick a stable page path so future updates supersede in place instead of fragmenting across files. Aim for short curated prose, not a raw dump.',
    inputSchema: { type: 'object', properties: {
      workingDir: CWD_PROP,
      page:       { type: 'string', description: 'Relative path under synthesis/, e.g. concepts/auth.md or decisions/drop-redis.md' },
      content:    { type: 'string', description: 'Markdown body. Keep it short and curated — readers in a future session.' },
    }, required: ['workingDir','page','content'] } },

  { name: 'append_log',
    description: 'Append a one-paragraph timestamped entry to `workingDir`/log.md — a chronological narrative of meaningful events. Use to leave a breadcrumb for future sessions about WHAT HAPPENED (e.g. "rebuilt graph after auth refactor", "decided to drop X library because Y", "ingested new dataset"). Pick `kind`: `ingest` (added/scanned data), `query` (notable lookup), `lint` (quality finding), `decision` (a choice with rationale). For durable concept/decision NOTES use write_synthesis_page instead — log is the diary, synthesis is the encyclopaedia. Do not log every tool call; reserve for events worth re-reading.',
    inputSchema: { type: 'object', properties: {
      workingDir: CWD_PROP,
      kind:       { type: 'string', description: 'ingest | query | lint | decision' },
      title:      { type: 'string', description: 'One-line headline' },
      body:       { type: 'string', description: 'Optional paragraph of detail' },
    }, required: ['workingDir','kind','title'] } },

  { name: 'build_code_graph',
    description: 'Rebuild the cached code graph for `workingDir`. Indexes code files (AST-based, deterministic) and, by default, .md/.txt/.rst document nodes alongside — most YHA-shaped repos keep architecture in markdown. Pass `includeDocs: false` to skip docs, or `incremental: true` to skip HTML output for a faster rebuild when only querying. Use ONLY when the cache is stale or missing; do NOT run pre-emptively (the bridge logs a STALE banner at boot when refresh is needed).',
    inputSchema: { type: 'object', properties: {
      workingDir:  CWD_PROP,
      target:      { type: 'string', description: 'Optional comma-separated files or folders to scan. Default: whole project.' },
      includeDocs: { type: 'boolean', description: 'Index .md/.txt/.rst files as document nodes (default: true). Pass false to skip docs.' },
      incremental: { type: 'boolean', description: 'Skip HTML generation; faster when you only need to query, not visualise.' },
    }, required: ['workingDir'] } },

  // ── Granular fallbacks ─────────────────────────────────────────────────────
  // The four tools below are kept for admin / introspection paths. For routine
  // retrieval, prefer `knowledge_ask` — it fans out across these layers, ranks
  // the results, and reports per-layer health. Reach for a granular tool only
  // when `knowledge_ask` is the wrong shape (e.g. you want the raw graph slice
  // without any synthesis or RAG context, or you already know the exact page).

  { name: 'query_code_graph',
    description: 'FALLBACK — prefer `knowledge_ask` for code questions. Use directly only when you specifically need the raw graph slice without synthesis / RAG context (e.g. listing every dependent of a file, or walking a community). Query the cached code graph for `workingDir`. Modes: `deps` (X\'s imports), `dependents` (who imports X), `impact` (transitive dependents), `find` (search paths/symbols), `summary` (one-module overview), `hubs` (most-imported files), `orphans` (no edges), `stats` (graph-wide counts), `community` (all nodes in a cluster), `god_nodes` (top N most-connected), `path` (shortest connection), `traverse` (BFS within `budget` tokens).',
    inputSchema: { type: 'object', properties: {
      workingDir:   CWD_PROP,
      mode:         { type: 'string', enum: ['deps','dependents','impact','find','summary','hubs','orphans','stats','community','god_nodes','path','traverse'] },
      module:       { type: 'string', description: 'Path or partial path, e.g. bridge/server.ts. Required for most modes; for community, identifies which cluster.' },
      target:       { type: 'string', description: 'Second node for path mode (the destination).' },
      limit:        { type: 'number', description: 'Max results (default 20).' },
      community_id: { type: 'number', description: 'Explicit community ID for community mode (alternative to resolving via module).' },
      budget:       { type: 'number', description: 'Token budget for traverse mode (default 2000).' },
    }, required: ['workingDir','mode'] } },

  { name: 'list_synthesis_pages',
    description: 'FALLBACK — prefer `knowledge_ask` for content discovery. Use directly when you want a directory-style listing of every synthesis page in `workingDir` (one-line summaries each), regardless of relevance to a query. Returns nothing if the bucket is empty (a signal that the bucket has not yet been seeded).',
    inputSchema: { type: 'object', properties: {
      workingDir: CWD_PROP,
    }, required: ['workingDir'] } },

  { name: 'read_synthesis_page',
    description: 'Read the full markdown of one named synthesis page in `workingDir`. Use after `knowledge_ask` (or list_synthesis_pages / search_synthesis) hands you a page path. Returns the entire page; pages are intentionally short curated notes — read in full rather than slicing.',
    inputSchema: { type: 'object', properties: {
      workingDir: CWD_PROP,
      page:       { type: 'string', description: 'Relative path under that workingDir\'s synthesis/, e.g. concepts/auth.md' },
    }, required: ['workingDir','page'] } },

  { name: 'search_synthesis',
    description: 'FALLBACK — prefer `knowledge_ask` for natural-language search. Use directly only for ripgrep-style exact-substring / regex hits over `workingDir`\'s synthesis pages (e.g. find every page that literally contains a specific symbol or magic string). Returns matches with file/line; follow up promising hits with read_synthesis_page.',
    inputSchema: { type: 'object', properties: {
      workingDir: CWD_PROP,
      query:      { type: 'string', description: 'Plain query or regex.' },
      limit:      { type: 'number', description: 'Max matches (default 30)' },
    }, required: ['workingDir','query'] } },

  { name: 'synthesize',
    description: 'LEGACY — superseded by `knowledge_ask`. Use `knowledge_ask` instead: it covers the same fan-out (graph slice + synthesis pages) plus RAG / log layers, ships health diagnostics, and supports follow-up cursors. This tool is retained only for callers that hard-coded against the older API.',
    inputSchema: { type: 'object', properties: {
      workingDir: CWD_PROP,
      question:   { type: 'string', description: 'Natural-language why/how/where question scoped to this codebase.' },
    }, required: ['workingDir','question'] } },
];

// ── Tool dispatch ───────────────────────────────────────────────────────────
// See data-server.js for the rationale. graph traversal queries can return
// large subgraphs that buffer in V8 heap on both ends; cap at 256 KB by
// default, overridable via YHA_MCP_TOOL_RESULT_MAX_BYTES.
const MCP_TOOL_RESULT_MAX_BYTES = (() => {
  const v = Number(process.env.YHA_MCP_TOOL_RESULT_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 262144;
})();

function _capResultText(text) {
  if (typeof text !== 'string') return { text, truncated: false };
  const buf = Buffer.byteLength(text, 'utf8');
  if (buf <= MCP_TOOL_RESULT_MAX_BYTES) return { text, truncated: false };
  const slice = text.slice(0, MCP_TOOL_RESULT_MAX_BYTES);
  return {
    text: `${slice}\n\n[truncated: ${buf} bytes → ${MCP_TOOL_RESULT_MAX_BYTES}; set YHA_MCP_TOOL_RESULT_MAX_BYTES to raise]`,
    truncated: true,
  };
}

function ok(id, text)  {
  const capped = _capResultText(text);
  sendMessage({
    jsonrpc:'2.0', id,
    result: {
      content: [{ type:'text', text: capped.text }],
      ...(capped.truncated ? { _truncated: true } : {}),
    },
  });
}
function err(id, text) { sendMessage({ jsonrpc:'2.0', id,
                                       result: { content: [{ type:'text', text: `ERROR: ${text}` }], isError: true } }); }

async function handleToolCall(id, name, args) {
  try {
    // knowledge_ask manages its own slug resolution (auto-escalates sparse slugs),
    // so it does not require a workingDir argument.
    if (name === 'knowledge_ask')       return ok(id, await knowledgeAsk(args));
    // Read-path tools auto-escalate sparse slugs and surface a health banner.
    if (name === 'search_synthesis' || name === 'synthesize') {
      const ctx = getReadDirs(args.workingDir);
      if (name === 'search_synthesis') {
        const hits = await searchSynthesisFiltered(ctx.dirs, args.query, args.limit || 30);
        const banner = healthBanner(ctx.resolved, ctx.coverage);
        return ok(id, `${banner}\n\n${hits}`);
      }
      return ok(id, await synthesize(ctx.dirs, args.question, ctx));
    }
    const dirs = resolveDirs(args.workingDir);
    if (name === 'build_code_graph') {
      // includeDocs defaults to true: markdown nodes (skill READMEs, decision
      // notes, todo.md) are usually the highest-value architectural signal in
      // a YHA repo. Callers must pass `includeDocs: false` explicitly to skip.
      const includeDocs  = args.includeDocs  === undefined ? true  : !!args.includeDocs;
      const incremental  = args.incremental  === undefined ? false : !!args.incremental;
      return ok(id, await buildGraph(dirs, args.target, { includeDocs, incremental }));
    }
    if (name === 'query_code_graph')    return ok(id, await queryGraph(dirs, args));
    if (name === 'list_synthesis_pages')return ok(id, listSynthesis(dirs));
    if (name === 'read_synthesis_page') return ok(id, readSynthesis(dirs, args.page));
    if (name === 'write_synthesis_page')return ok(id, writeSynthesis(dirs, args.page, args.content));
    if (name === 'append_log')          return ok(id, appendLog(dirs, args));
    err(id, `Unknown tool: ${name}`);
  } catch (e) { err(id, e.message || String(e)); }
}

// ── Graph layer (Graphify) ──────────────────────────────────────────────────
const GRAPHIFY_VENV_DIR = path.join(__dirname, '.graphify-venv');
const GRAPHIFY_PYTHON   = path.join(GRAPHIFY_VENV_DIR, 'bin', 'python');
const GRAPHIFY_BUILD    = path.join(__dirname, 'graphify_build.py');
const GRAPHIFY_VERSION  = '0.7.0';
const FILE_DEPS_RELATIONS = new Set(['imports', 'imports_from', 'calls', 'method']);

function execFileAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout = '', stderr = '') => {
      if (error) return reject(Object.assign(error, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });
}

async function ensureGraphifyRuntime() {
  if (fs.existsSync(GRAPHIFY_PYTHON)) return;
  await execFileAsync('python3', ['-m', 'venv', GRAPHIFY_VENV_DIR], { maxBuffer: 32 * 1024 * 1024 });
  await execFileAsync(GRAPHIFY_PYTHON, ['-m', 'pip', 'install', `graphifyy==${GRAPHIFY_VERSION}`], { maxBuffer: 256 * 1024 * 1024 });
}

function extractTrailingJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Graphify returned no JSON summary');
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch (_) {}
  }
  throw new Error('Could not parse Graphify build summary');
}

function isGraphifyGraph(g) {
  return Array.isArray(g?.nodes) && Array.isArray(g?.links);
}

function isFileNode(node) {
  if (!node || typeof node.source_file !== 'string' || typeof node.label !== 'string') return false;
  return path.posix.basename(node.source_file) === node.label && node.source_location === 'L1';
}

function buildGraphifyState(g) {
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const links = Array.isArray(g.links) ? g.links : [];
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const fileNodes = nodes.filter(isFileNode).sort((a, b) => a.source_file.localeCompare(b.source_file));
  const fileNodesBySource = new Map(fileNodes.map((node) => [node.source_file, node]));
  const containsByFile = new Map();
  const depsMap = new Map();
  const dependentsMap = new Map();
  const neighborsByNode = new Map();

  function addSet(map, key, value) {
    if (!key || !value) return;
    const set = map.get(key) || new Set();
    set.add(value);
    map.set(key, set);
  }

  for (const link of links) {
    if (!link || typeof link.source !== 'string' || typeof link.target !== 'string') continue;
    const srcNode = nodesById.get(link.source);
    const tgtNode = nodesById.get(link.target);
    if (!srcNode || !tgtNode) continue;

    addSet(neighborsByNode, srcNode.id, tgtNode.id);
    addSet(neighborsByNode, tgtNode.id, srcNode.id);

    if (link.relation === 'contains' && isFileNode(srcNode)) {
      const items = containsByFile.get(srcNode.source_file) || [];
      items.push(tgtNode);
      containsByFile.set(srcNode.source_file, items);
    }

    if (!FILE_DEPS_RELATIONS.has(link.relation)) continue;
    const srcFile = srcNode.source_file;
    const tgtFile = tgtNode.source_file;
    if (!srcFile || !tgtFile || srcFile === tgtFile) continue;
    if (!fileNodesBySource.has(srcFile) || !fileNodesBySource.has(tgtFile)) continue;
    addSet(depsMap, srcFile, tgtFile);
    addSet(dependentsMap, tgtFile, srcFile);
  }

  return {
    nodes,
    links,
    nodesById,
    fileNodes,
    fileNodesBySource,
    containsByFile,
    depsMap,
    dependentsMap,
    neighborsByNode,
  };
}

function resolveFileModule(state, input) {
  if (!input) return { error: 'module is required for this mode' };
  const exact = state.fileNodesBySource.get(input);
  if (exact) return { sourceFile: exact.source_file };
  const q = String(input).trim().toLowerCase();
  const matches = state.fileNodes
    .map((node) => node.source_file)
    .filter((sourceFile) => sourceFile.toLowerCase().includes(q));
  if (!matches.length) return { error: `Module not found: ${input}` };
  if (matches.length === 1) return { sourceFile: matches[0] };
  const preview = matches.slice(0, 10).map((sourceFile) => `- ${sourceFile}`).join('\n');
  return { error: `Module '${input}' is ambiguous. Matches:\n${preview}${matches.length > 10 ? '\n- …' : ''}` };
}

function resolveNode(state, input) {
  if (!input) return { error: 'module is required for this mode' };
  const exactId = state.nodesById.get(input);
  if (exactId) return { node: exactId };
  const q = String(input).trim().toLowerCase();
  const exactLabel = state.nodes.filter((node) => String(node.label || '').toLowerCase() === q);
  if (exactLabel.length === 1) return { node: exactLabel[0] };
  const matches = state.nodes.filter((node) => {
    const label = String(node.label || '').toLowerCase();
    const sourceFile = String(node.source_file || '').toLowerCase();
    return label.includes(q) || sourceFile.includes(q);
  });
  if (!matches.length) return { error: `Node not found: ${input}` };
  if (matches.length === 1) return { node: matches[0] };
  const preview = matches.slice(0, 10).map((node) => `- ${node.label} [${node.source_file || node.id}]`).join('\n');
  return { error: `Node '${input}' is ambiguous. Matches:\n${preview}${matches.length > 10 ? '\n- …' : ''}` };
}

function transitiveDependents(state, sourceFile) {
  const seen = new Set([sourceFile]);
  const queue = [...(state.dependentsMap.get(sourceFile) || [])];
  const out = [];
  while (queue.length) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    for (const dep of state.dependentsMap.get(next) || []) queue.push(dep);
  }
  return out.sort();
}

function graphifyMatches(state, needle, limit) {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return [];
  const fileLines = state.fileNodes
    .map((node) => node.source_file)
    .filter((sourceFile) => sourceFile.toLowerCase().includes(q))
    .map((sourceFile) => `file\t${sourceFile}`);
  const nodeLines = state.nodes
    .filter((node) => !isFileNode(node))
    .filter((node) => String(node.label || '').toLowerCase().includes(q) || String(node.source_file || '').toLowerCase().includes(q))
    .slice(0, limit)
    .map((node) => `node\t${node.label}\t${node.source_file || node.id}`);
  return [...fileLines, ...nodeLines].slice(0, limit);
}

async function buildGraph(dirs, target, { includeDocs = false, incremental = false } = {}) {
  await ensureGraphifyRuntime();
  const extraFlags = [];
  if (includeDocs)  extraFlags.push('--include-docs');
  if (incremental)  extraFlags.push('--incremental');
  let summary;
  try {
    const { stdout } = await execFileAsync(
      GRAPHIFY_PYTHON,
      [GRAPHIFY_BUILD, dirs.workingDir, target || '.', dirs.GRAPH_DIR, ...extraFlags],
      { cwd: dirs.workingDir, maxBuffer: 256 * 1024 * 1024 },
    );
    summary = extractTrailingJson(stdout);
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : '';
    const stdout = error?.stdout ? String(error.stdout).trim() : '';
    throw new Error(stderr || stdout || error.message || 'Graphify build failed');
  }

  const parsed = JSON.parse(fs.readFileSync(dirs.GRAPH_JSON, 'utf8'));
  parsed.yhaMeta = {
    backend: 'graphify',
    generatedAt: new Date().toISOString(),
    workingDir: dirs.workingDir,
    target: target || '.',
    indexedInputs: summary.indexed_files,
    docFiles: summary.doc_files || 0,
    indexedSample: summary.sample_files || [],
    communities: summary.communities,
    nodes: summary.nodes,
    edges: summary.edges,
    builtAtCommit: summary.built_at_commit || null,
  };
  fs.writeFileSync(dirs.GRAPH_JSON, JSON.stringify(parsed, null, 2) + '\n');

  const report = fs.existsSync(dirs.GRAPH_REPORT)
    ? fs.readFileSync(dirs.GRAPH_REPORT, 'utf8')
    : '# Graph Report\n';
  return `Graph rebuilt for ${dirs.workingDir} → ${path.join('dirs', dirs.slug, 'graph', 'graph.json')} (${summary.indexed_files} indexed files, ${summary.nodes} nodes, ${summary.edges} edges, ${summary.communities} communities)\n\n${report.split('\n').slice(0, 16).join('\n')}\n…`;
}

/**
 * @param {*} dirs
 * @param {{ mode?: string, module?: any, limit?: number, target?: any, budget?: number, community_id?: any }} opts
 */
function queryGraph(dirs, { mode, module: rawModule, limit = 20, target: rawTarget, budget = 2000, community_id }) {
  if (!fs.existsSync(dirs.GRAPH_JSON)) return 'No graph yet. Run build_code_graph first.';
  const g = JSON.parse(fs.readFileSync(dirs.GRAPH_JSON, 'utf8'));
  if (!isGraphifyGraph(g)) {
    if (Array.isArray(g?.modules)) return 'Legacy dependency-cruiser graph detected. Re-run build_code_graph to migrate to Graphify.';
    return 'Unsupported graph format. Re-run build_code_graph.';
  }
  const state = buildGraphifyState(g);

  if (mode === 'find') {
    if (!rawModule) return 'module is required for find mode';
    return graphifyMatches(state, rawModule, limit).map((line) => `- ${line}`).join('\n') || '(no matches)';
  }
  if (mode === 'deps') {
    const resolved = resolveFileModule(state, rawModule);
    if (resolved.error) return resolved.error;
    return [...(state.depsMap.get(resolved.sourceFile) || [])].sort().slice(0, limit).map((s) => `- ${s}`).join('\n') || '(no dependencies)';
  }
  if (mode === 'dependents') {
    const resolved = resolveFileModule(state, rawModule);
    if (resolved.error) return resolved.error;
    return [...(state.dependentsMap.get(resolved.sourceFile) || [])].sort().slice(0, limit).map((s) => `- ${s}`).join('\n') || '(no dependents)';
  }
  if (mode === 'impact') {
    const resolved = resolveFileModule(state, rawModule);
    if (resolved.error) return resolved.error;
    return transitiveDependents(state, resolved.sourceFile).slice(0, limit).map((s) => `- ${s}`).join('\n') || '(no transitive dependents)';
  }
  if (mode === 'summary') {
    const fileResolved = resolveFileModule(state, rawModule);
    if (!fileResolved.error) {
      const fileNode = state.fileNodesBySource.get(fileResolved.sourceFile);
      const deps = [...(state.depsMap.get(fileResolved.sourceFile) || [])].sort();
      const directDependents = [...(state.dependentsMap.get(fileResolved.sourceFile) || [])].sort();
      const impact = transitiveDependents(state, fileResolved.sourceFile);
      const contained = (state.containsByFile.get(fileResolved.sourceFile) || [])
        .filter((node) => node && node.label && node.label !== fileNode.label)
        .map((node) => node.label)
        .sort();
      return [
        `File: ${fileResolved.sourceFile}`,
        `Community: ${fileNode?.community ?? ''}`,
        `Direct deps: ${deps.length}`,
        `Direct dependents: ${directDependents.length}`,
        `Transitive impact: ${impact.length}`,
        `Contained symbols: ${contained.length}`,
        '',
        'Dependencies:',
        deps.slice(0, limit).map((s) => `- ${s}`).join('\n') || '(none)',
        '',
        'Dependents:',
        directDependents.slice(0, limit).map((s) => `- ${s}`).join('\n') || '(none)',
        '',
        'Contained symbols:',
        contained.slice(0, limit).map((s) => `- ${s}`).join('\n') || '(none)',
      ].join('\n');
    }

    const nodeResolved = resolveNode(state, rawModule);
    if (nodeResolved.error) return fileResolved.error;
    const node = nodeResolved.node;
    const neighborIds = [...(state.neighborsByNode.get(node.id) || [])];
    const neighbors = neighborIds
      .map((id) => state.nodesById.get(id))
      .filter(Boolean)
      .sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
    return [
      `Node: ${node.label}`,
      `Source file: ${node.source_file || ''}`,
      `Source location: ${node.source_location || ''}`,
      `Community: ${node.community ?? ''}`,
      `Neighbors: ${neighbors.length}`,
      '',
      'Connected nodes:',
      neighbors.slice(0, limit).map((neighbor) => `- ${neighbor.label} [${neighbor.source_file || neighbor.id}]`).join('\n') || '(none)',
    ].join('\n');
  }
  if (mode === 'hubs') {
    return state.fileNodes
      .map((node) => [node.source_file, (state.dependentsMap.get(node.source_file) || new Set()).size])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([sourceFile, count]) => `${count}\t${sourceFile}`)
      .join('\n');
  }
  if (mode === 'orphans') {
    return state.fileNodes
      .map((node) => node.source_file)
      .filter((sourceFile) => !(state.depsMap.get(sourceFile)?.size) && !(state.dependentsMap.get(sourceFile)?.size))
      .slice(0, limit)
      .map((sourceFile) => `- ${sourceFile}`)
      .join('\n') || '(no orphans)';
  }

  // ── New modes ──────────────────────────────────────────────────────────────

  if (mode === 'stats') {
    const nodeTypeCount = {};
    const confCount = { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };
    for (const node of state.nodes) {
      const t = node.file_type || 'unknown';
      nodeTypeCount[t] = (nodeTypeCount[t] || 0) + 1;
    }
    for (const link of state.links) {
      const c = link.confidence;
      if (c && c in confCount) confCount[c]++;
    }
    const communityIds = new Set(state.nodes.map((n) => n.community).filter((c) => c !== undefined && c !== null));
    return [
      `Nodes: ${state.nodes.length}  Edges: ${state.links.length}  Communities: ${communityIds.size}`,
      `Files indexed: ${g.yhaMeta?.indexedInputs ?? state.fileNodes.length}  Doc files: ${g.yhaMeta?.docFiles ?? 0}`,
      `Built: ${g.yhaMeta?.generatedAt ?? 'unknown'}  Commit: ${g.yhaMeta?.builtAtCommit ?? 'unknown'}`,
      '',
      'Node types:',
      ...Object.entries(nodeTypeCount).sort((a, b) => b[1] - a[1]).map(([t, n]) => `  ${t}: ${n}`),
      '',
      'Edge confidence:',
      ...Object.entries(confCount).filter(([, n]) => n > 0).map(([c, n]) => `  ${c}: ${n}`),
    ].join('\n');
  }

  if (mode === 'god_nodes') {
    const nodeDegree = new Map();
    for (const link of state.links) {
      nodeDegree.set(link.source, (nodeDegree.get(link.source) || 0) + 1);
      nodeDegree.set(link.target, (nodeDegree.get(link.target) || 0) + 1);
    }
    const results = state.nodes
      .filter((n) => !isFileNode(n))
      .map((n) => [n, nodeDegree.get(n.id) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    if (!results.length) return '(no semantic nodes in graph — run build_code_graph first)';
    return results.map(([n, deg]) => `${deg}\t${n.label}\t${n.source_file || n.id}${n.source_location ? ':' + n.source_location : ''}`).join('\n');
  }

  if (mode === 'community') {
    let cid;
    if (community_id !== undefined) {
      cid = community_id;
    } else if (rawModule) {
      const fileRes = resolveFileModule(state, rawModule);
      if (!fileRes.error) {
        cid = state.fileNodesBySource.get(fileRes.sourceFile)?.community;
      } else {
        const nodeRes = resolveNode(state, rawModule);
        if (!nodeRes.error) cid = nodeRes.node?.community;
      }
      if (cid === undefined || cid === null) return `No community found for: ${rawModule}`;
    } else {
      return 'community mode requires either module or community_id';
    }
    const members = state.nodes.filter((n) => n.community === cid).sort((a, b) => String(a.label).localeCompare(String(b.label)));
    const fileMembers = members.filter(isFileNode);
    const symMembers  = members.filter((n) => !isFileNode(n));
    return [
      `Community ${cid}: ${members.length} nodes (${fileMembers.length} files, ${symMembers.length} symbols)`,
      '',
      'Files:',
      fileMembers.slice(0, limit).map((n) => `  ${n.source_file}`).join('\n') || '  (none)',
      '',
      'Symbols (top by label):',
      symMembers.slice(0, limit).map((n) => `  ${n.label}  [${n.source_file}${n.source_location ? ':' + n.source_location : ''}]`).join('\n') || '  (none)',
    ].join('\n');
  }

  if (mode === 'path') {
    if (!rawModule || !rawTarget) return 'path mode requires both module (source) and target params';
    const srcRes = resolveFileModule(state, rawModule);
    const tgtRes = resolveFileModule(state, rawTarget);
    let srcId, tgtId;
    if (!srcRes.error) srcId = state.fileNodesBySource.get(srcRes.sourceFile)?.id;
    else { const r = resolveNode(state, rawModule); if (!r.error) srcId = r.node?.id; }
    if (!tgtRes.error) tgtId = state.fileNodesBySource.get(tgtRes.sourceFile)?.id;
    else { const r = resolveNode(state, rawTarget);  if (!r.error) tgtId = r.node?.id; }
    if (!srcId) return `Could not resolve source: ${rawModule}`;
    if (!tgtId) return `Could not resolve target: ${rawTarget}`;
    if (srcId === tgtId) return 'Source and target are the same node.';

    const prev = new Map([[srcId, null]]);
    const queue = [srcId];
    let found = false;
    bfs: while (queue.length) {
      const curr = queue.shift();
      for (const nbr of state.neighborsByNode.get(curr) || []) {
        if (!prev.has(nbr)) {
          prev.set(nbr, curr);
          if (nbr === tgtId) { found = true; break bfs; }
          queue.push(nbr);
        }
      }
    }
    if (!found) return `No path found between ${rawModule} and ${rawTarget} (graph may be disconnected here)`;

    const hops = [];
    let cur = tgtId;
    while (cur !== null) { hops.unshift(cur); cur = prev.get(cur); }
    const lines = hops.map((id, i) => {
      const n = state.nodesById.get(id);
      const label = n ? `${n.label}  [${n.source_file || id}${n.source_location ? ':' + n.source_location : ''}]` : id;
      return i === 0 ? `START  ${label}` : `  →${i}   ${label}`;
    });
    return `Path (${hops.length - 1} hops):\n${lines.join('\n')}`;
  }

  if (mode === 'traverse') {
    if (!rawModule) return 'traverse mode requires module';
    let startId;
    const fileRes = resolveFileModule(state, rawModule);
    if (!fileRes.error) startId = state.fileNodesBySource.get(fileRes.sourceFile)?.id;
    else { const r = resolveNode(state, rawModule); if (!r.error) startId = r.node?.id; }
    if (!startId) return `Could not find node: ${rawModule}`;

    const charBudget = budget * 4;
    const visited = new Set([startId]);
    const queue = [[startId, 0]];
    const byDepth = new Map();
    let chars = 0;

    while (queue.length && chars < charBudget) {
      const [curr, depth] = /** @type {any[]} */ (queue.shift());
      const node = state.nodesById.get(curr);
      if (!node) continue;
      const line = `  ${node.label}  (${node.file_type || 'code'})  [${node.source_file || node.id}${node.source_location ? ':' + node.source_location : ''}]`;
      const depthList = byDepth.get(depth) || [];
      depthList.push(line);
      byDepth.set(depth, depthList);
      chars += line.length + 1;
      if (depth < 4) {
        for (const nbr of state.neighborsByNode.get(curr) || []) {
          if (!visited.has(nbr)) { visited.add(nbr); queue.push([nbr, depth + 1]); }
        }
      }
    }

    const sections = [];
    for (const [depth, lines] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      sections.push(depth === 0 ? `Layer 0 (origin):` : `Layer ${depth}:`);
      sections.push(...lines.slice(0, limit));
      sections.push('');
    }
    return `BFS traversal from '${rawModule}' (${visited.size} nodes, budget ${budget} tokens):\n\n${sections.join('\n')}`;
  }

  return `Unknown mode: ${mode}`;
}

// ── Synthesis layer ─────────────────────────────────────────────────────────
function safePage(SYN_DIR, p) {
  const full = path.resolve(SYN_DIR, p);
  if (!full.startsWith(SYN_DIR + path.sep)) throw new Error('Path escapes synthesis dir');
  if (!full.endsWith('.md')) throw new Error('Synthesis pages must be .md');
  return full;
}

function listSynthesis(dirs) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const rel = path.relative(dirs.SYN_DIR, full);
        const first = firstSummaryLine(fs.readFileSync(full, 'utf8'));
        out.push(`- ${rel} — ${first}`);
      }
    }
  })(dirs.SYN_DIR);
  return out.join('\n') || '(empty)';
}

function firstSummaryLine(text) {
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] && lines[0].trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++;
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t) return t.replace(/^#+ */, '');
  }
  return '';
}

function readSynthesis(dirs, page) { return fs.readFileSync(safePage(dirs.SYN_DIR, page), 'utf8'); }

function writeSynthesis(dirs, page, content) {
  const full = safePage(dirs.SYN_DIR, page);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return `Wrote ${page} (${content.length} chars) to ${dirs.slug}`;
}

function searchSynthesis(dirs, query, limit) {
  return new Promise((resolve, reject) => {
    execFile('rg', ['-n', '--no-heading', '-S', '-m', String(limit), query, dirs.SYN_DIR],
      { maxBuffer: 8 * 1024 * 1024 },
      (e, stdout) => {
        if (e && e.code !== 1) return reject(e); // 1 = no matches
        resolve(stdout || '(no matches)');
      });
  });
}

function appendLog(dirs, { kind, title, body = '' }) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n## [${date}] ${kind} | ${title}\n${body ? body + '\n' : ''}`;
  fs.appendFileSync(dirs.SYN_LOG, entry);
  return `Logged: ${date} ${kind} | ${title}`;
}

// ── Combined retrieval ──────────────────────────────────────────────────────
async function synthesize(dirs, question, healthCtx) {
  const parts = [`# Context for: ${question}`, `_(workingDir: ${dirs.workingDir})_`];
  if (healthCtx) parts.push(healthBanner(healthCtx.resolved, healthCtx.coverage));
  parts.push('');
  try {
    const terms = question.split(/\s+/).filter(w => w.length > 2).slice(0,4).join('|');
    if (terms) {
      const hits = await searchSynthesisFiltered(dirs, terms, 20);
      parts.push('## Synthesis matches', '```', hits, '```', '');
    }
  } catch (_) {}
  try { parts.push('## Top architectural hubs', queryGraph(dirs, { mode:'hubs', limit: 10 }), ''); } catch (_) {}
  return parts.join('\n');
}

// ── Unified knowledge_ask ───────────────────────────────────────────────────
// One tool that fans out across every layer (graph, synthesis, RAG, docs),
// cross-ranks, then compresses for the caller's model tier. See
// docs/knowledge-unified-plan.md for the design.

const NOISE_PATTERNS = [
  /\/docs\/generated\/_index\.conflict-\d+\.md$/,
  /\/node_modules\//,
  /\/\.venv\//,
  /\/\.git\//,
];
function isNoise(p) {
  if (!p) return false;
  return NOISE_PATTERNS.some((re) => re.test(p));
}

function _sparseSlug(slug) {
  const dir = path.join(DIRS_ROOT, slug);
  if (!fs.existsSync(dir)) return true;
  const synDir = path.join(dir, 'synthesis');
  if (!fs.existsSync(synDir)) return true;
  const codeDir = path.join(synDir, 'code');
  const codeCount = fs.existsSync(codeDir) ? fs.readdirSync(codeDir).filter((f) => f.endsWith('.md')).length : 0;
  const graphJson = path.join(dir, 'graph', 'graph.json');
  return codeCount < 5 && !fs.existsSync(graphJson);
}

function resolveSlug(workingDir) {
  const requestedSlug = slugifyCwd(workingDir);
  const idx = readIndex();

  // Direct hit and not sparse → use as-is.
  if (idx[requestedSlug] && !_sparseSlug(requestedSlug)) {
    return { slug: requestedSlug, escalated: false, requestedSlug };
  }

  // Walk up the path looking for a known non-sparse slug.
  let probe = workingDir;
  while (probe && probe !== path.dirname(probe)) {
    probe = path.dirname(probe);
    const probeSlug = slugifyCwd(probe);
    if (idx[probeSlug] && !_sparseSlug(probeSlug)) {
      return { slug: probeSlug, escalated: true, requestedSlug, escalatedFrom: workingDir, escalatedTo: probe };
    }
  }

  // No better slug found; fall back to the most-populated slug overall.
  const slugs = Object.keys(idx).filter((s) => !_sparseSlug(s));
  if (slugs.length) {
    slugs.sort((a, b) => {
      const ac = _countMd(path.join(DIRS_ROOT, a, 'synthesis'));
      const bc = _countMd(path.join(DIRS_ROOT, b, 'synthesis'));
      return bc - ac;
    });
    return { slug: slugs[0], escalated: true, requestedSlug, escalatedFrom: workingDir, escalatedTo: idx[slugs[0]] };
  }
  return { slug: requestedSlug, escalated: false, requestedSlug };
}

function _countMd(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) n++;
    }
  })(dir);
  return n;
}

function loadCoverage(slug) {
  const dir = path.join(DIRS_ROOT, slug);
  const synDir = path.join(dir, 'synthesis');
  const graphJson = path.join(dir, 'graph', 'graph.json');
  const cov = {
    slug,
    synthesisCode:    _countMd(path.join(synDir, 'code')),
    synthesisSummaries: _countMd(path.join(synDir, 'summaries')),
    logBytes:         fs.existsSync(path.join(synDir, 'log.md')) ? fs.statSync(path.join(synDir, 'log.md')).size : 0,
    graphAvailable:   fs.existsSync(graphJson),
    graphBuiltAt:     null,
    graphNodes:       0,
  };
  if (cov.graphAvailable) {
    try {
      const g = JSON.parse(fs.readFileSync(graphJson, 'utf8'));
      cov.graphBuiltAt = g?.yhaMeta?.generatedAt || null;
      cov.graphNodes   = Array.isArray(g.nodes) ? g.nodes.length : 0;
    } catch (_) {}
  }
  return cov;
}

// Read-path helper. Auto-resolves to a non-sparse slug (escalates if needed) and
// returns dirs + escalation report + coverage. Write tools should keep using
// resolveDirs() directly so they never silently target the wrong bucket.
function getReadDirs(workingDir) {
  const resolved = resolveSlug(workingDir);
  const idx = readIndex();
  const actualWorkingDir = idx[resolved.slug] || workingDir;
  const dirs = resolveDirs(actualWorkingDir);
  const coverage = loadCoverage(resolved.slug);
  return { dirs, resolved, coverage };
}

function healthBanner(resolved, coverage) {
  const lines = [];
  if (resolved.escalated) {
    lines.push(`> ⚠ slug escalated: requested \`${resolved.requestedSlug}\` was sparse → using \`${resolved.slug}\` (path: ${resolved.escalatedFrom || '?'})`);
  } else {
    lines.push(`> slug: \`${resolved.slug}\``);
  }
  const synth = coverage.synthesisCode + coverage.synthesisSummaries;
  const graph = coverage.graphAvailable ? `${coverage.graphNodes} nodes (built ${coverage.graphBuiltAt || '?'})` : 'none';
  lines.push(`> coverage: synthesis=${synth} pages · graph=${graph} · log=${coverage.logBytes}B`);
  return lines.join('\n');
}

// Wraps searchSynthesis() with the same noise filter knowledge_ask uses, so
// the standalone tool no longer drowns its caller in docs/generated/_index.conflict-* hits.
async function searchSynthesisFiltered(dirs, query, limit) {
  const raw = await searchSynthesis(dirs, query, limit * 2);
  if (!raw || raw === '(no matches)') return raw;
  const kept = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = line.match(/^([^:]+):/);
    if (m && isNoise(m[1])) continue;
    kept.push(line);
    if (kept.length >= limit) break;
  }
  return kept.length ? kept.join('\n') : '(no matches)';
}

// Phase-3 handoff manifest. Each slug has an optional handoff.json built nightly
// by bridge/mcp/build_handoff.js. knowledge_ask returns a trimmed slice in every
// response so even cold callers get a free orientation.
function loadHandoff(slug) {
  try {
    const p = path.join(DIRS_ROOT, slug, 'handoff.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function sliceHandoffForTier(h, tier) {
  if (!h) return null;
  const caps = tier === 'tiny'
    ? { gods: 0, mods: 0, activity: 0, gloss: 0 }
    : tier === 'large'
      ? { gods: 20, mods: 30, activity: 10, gloss: 20 }
      : { gods: 5, mods: 10, activity: 3, gloss: 5 };
  return {
    slug: h.slug,
    last_built: h.last_built,
    coverage: h.coverage,
    god_nodes: (h.god_nodes || []).slice(0, caps.gods),
    module_index: (h.module_index || []).slice(0, caps.mods),
    recent_activity: (h.recent_activity || []).slice(0, caps.activity),
    glossary: (h.glossary || []).slice(0, caps.gloss),
    category_counts: h.category_counts || null,
  };
}

function classifyIntent(query) {
  const q = String(query || '').trim();
  if (!q) return 'concept';
  if (/^(how (do|does|can|should)|how to|where (do|is|can)|what command)/i.test(q)) return 'howto';
  if (/^(why (did|do|is)|when (did|was)|who (changed|wrote)|history of|origin of)/i.test(q)) return 'history';
  if (/(\b[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*\b)|([A-Z][a-z]+[A-Z])|\/[a-z0-9_-]+\.(ts|tsx|js|jsx|py|go|md)|\.tsx?:\d+/.test(q)) return 'code';
  return 'concept';
}

// Opaque cursor codec — base64url over JSON, never parsed by callers.
function packCursor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function unpackCursor(s) {
  try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); }
  catch { return null; }
}

// ── Per-layer fetchers ──────────────────────────────────────────────────────

async function _layerSynthesisGrep(dirs, query, limit) {
  try {
    const terms = String(query).split(/\s+/).filter((w) => w.length > 2).slice(0, 4).join('|') || query;
    const raw = await searchSynthesis(dirs, terms, limit);
    if (!raw || raw === '(no matches)') return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const full = m[1];
      if (isNoise(full)) continue;
      const rel = path.relative(dirs.SYN_DIR, full);
      out.push({
        layer: 'synthesis',
        source_path: rel,
        snippet: m[3].trim(),
        line: parseInt(m[2], 10),
        score: 0.5,
        cursor: packCursor({ layer: 'synthesis', page: rel }),
      });
    }
    return out;
  } catch (_) { return []; }
}

function _layerGraphFind(dirs, query, limit) {
  try {
    if (!fs.existsSync(dirs.GRAPH_JSON)) return [];
    const g = JSON.parse(fs.readFileSync(dirs.GRAPH_JSON, 'utf8'));
    if (!isGraphifyGraph(g)) return [];
    const state = buildGraphifyState(g);
    const lines = graphifyMatches(state, query, limit);
    return lines.map((l) => {
      const parts = l.split('\t');
      const ref = parts[parts.length - 1];
      const isFile = parts[0] === 'file';
      return {
        layer: 'graph',
        source_path: ref,
        snippet: isFile ? `file: ${ref}` : `${parts[1]} in ${ref}`,
        score: 0.6,
        cursor: packCursor({ layer: 'graph', mode: isFile ? 'summary' : 'find', module: ref }),
      };
    });
  } catch (_) { return []; }
}

async function _layerRag(query, cwd, k, sourceKind) {
  if (!BRIDGE_KEY) return [];
  try {
    const body = { query, cwd, k, rerank: true };
    if (sourceKind) body.sourceKind = sourceKind;
    const result = await bridgeFetch('POST', '/proxy/context-rag/search', body);
    const hits = result.hits || [];
    return hits.map((h) => ({
      layer: 'rag',
      source_path: h.sourceId,
      source_url:  h.sourceUrl || null,
      snippet:     String(h.text || '').replace(/\s+/g, ' ').trim(),
      score:       h.rerankScore != null ? Number(h.rerankScore) : 1 - Number(h.distance ?? 1),
      db:          h.dbId,
      cursor:      packCursor({ layer: 'rag', dbId: h.dbId, sourceId: h.sourceId }),
    })).filter((h) => !isNoise(h.source_path));
  } catch (_) { return []; }
}

function _layerLog(dirs, query, limit) {
  try {
    if (!fs.existsSync(dirs.SYN_LOG)) return [];
    const body = fs.readFileSync(dirs.SYN_LOG, 'utf8');
    const blocks = body.split(/\n(?=## )/).filter(Boolean);
    const terms = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const scored = blocks.map((b) => {
      const lb = b.toLowerCase();
      const score = terms.reduce((s, t) => s + (lb.includes(t) ? 1 : 0), 0);
      return { b, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
    return scored.map(({ b, score }, i) => ({
      layer: 'log',
      source_path: 'synthesis/log.md',
      snippet: b.split('\n').slice(0, 3).join(' ').replace(/^##\s*/, '').slice(0, 240),
      score: 0.3 + 0.1 * score,
      cursor: packCursor({ layer: 'log', offset: i }),
    }));
  } catch (_) { return []; }
}

// ── Cross-rank + dedup ──────────────────────────────────────────────────────
function crossRank(allHits, limit) {
  const byPath = new Map();
  for (const h of allHits) {
    const key = `${h.layer}:${h.source_path}`;
    const prev = byPath.get(key);
    if (!prev || prev.score < h.score) byPath.set(key, h);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Tier compression ────────────────────────────────────────────────────────
const TIER_BUDGETS = {
  tiny:  { topN: 3,  snipMax: 200, includeGraph: false, includeHandoff: false },
  small: { topN: 8,  snipMax: 600, includeGraph: true,  includeHandoff: true  },
  large: { topN: 20, snipMax: 1200, includeGraph: true, includeHandoff: true  },
};

function _snip(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function compressForTier(bundle, tier) {
  const t = TIER_BUDGETS[tier] || TIER_BUDGETS.small;
  const out = {
    answer_card: bundle.answer_card,
    evidence: bundle.evidence.slice(0, t.topN).map((h) => ({
      layer: h.layer,
      source: h.source_path,
      url:    h.source_url,
      score:  Number(h.score.toFixed(3)),
      snippet: _snip(h.snippet, t.snipMax),
      cursor: h.cursor,
    })),
    health: bundle.health,
  };
  if (t.includeGraph && bundle.graph_neighborhood) out.graph_neighborhood = bundle.graph_neighborhood;
  if (t.includeHandoff && bundle.handoff)          out.handoff = bundle.handoff;
  const see = bundle.evidence.slice(t.topN, t.topN + 5).map((h) => ({ source: h.source_path, cursor: h.cursor }));
  if (see.length) out.see_also = see;
  return out;
}

// ── follow_up resolver ──────────────────────────────────────────────────────
async function resolveFollowUp(dirs, cursor) {
  const c = unpackCursor(cursor);
  if (!c) return { error: 'invalid cursor' };
  if (c.layer === 'synthesis') {
    try { return { layer: 'synthesis', page: c.page, content: readSynthesis(dirs, c.page) }; }
    catch (e) { return { error: e.message }; }
  }
  if (c.layer === 'graph') {
    try { return { layer: 'graph', result: queryGraph(dirs, { mode: c.mode || 'summary', module: c.module, limit: 30 }) }; }
    catch (e) { return { error: e.message }; }
  }
  if (c.layer === 'rag') {
    return { layer: 'rag', source: c.sourceId, dbId: c.dbId, note: 'Re-issue knowledge_ask with this source_path quoted for a deeper RAG fetch.' };
  }
  if (c.layer === 'log') {
    try {
      const body = fs.readFileSync(dirs.SYN_LOG, 'utf8');
      const blocks = body.split(/\n(?=## )/).filter(Boolean);
      return { layer: 'log', block: blocks[c.offset] || null };
    } catch (e) { return { error: e.message }; }
  }
  return { error: `unknown cursor layer: ${c.layer}` };
}

// ── Top-level knowledge_ask ─────────────────────────────────────────────────
async function knowledgeAsk(args) {
  const {
    query, cwd, intent: rawIntent, model_tier = 'small', budget_tokens, follow_up,
  } = args;

  if (!query || !String(query).trim()) throw new Error('query is required');

  const workingDir = cwd && path.isAbsolute(cwd) ? cwd : process.cwd();
  const resolved = resolveSlug(workingDir);
  const dirs = resolveDirs(readIndex()[resolved.slug] || workingDir);
  const coverage = loadCoverage(resolved.slug);

  // Follow-up drill: short-circuit fan-out and return the expanded cursor.
  if (follow_up) {
    const drilled = await resolveFollowUp(dirs, follow_up);
    return JSON.stringify({
      mode: 'follow_up',
      cursor_payload: drilled,
      health: { slug: resolved.slug, escalated: resolved.escalated, coverage },
    }, null, 2);
  }

  const intent = (rawIntent && rawIntent !== 'auto') ? rawIntent : classifyIntent(query);

  // Fan out in parallel based on intent.
  const tasks = [];
  if (intent === 'concept' || intent === 'howto') {
    tasks.push(_layerSynthesisGrep(dirs, query, 20));
    tasks.push(_layerRag(query, workingDir, 8, 'knowledge'));
  }
  if (intent === 'code') {
    tasks.push(Promise.resolve(_layerGraphFind(dirs, query, 12)));
    tasks.push(_layerRag(query, workingDir, 8, 'file'));
    tasks.push(_layerSynthesisGrep(dirs, query, 12));
  }
  if (intent === 'history') {
    tasks.push(Promise.resolve(_layerLog(dirs, query, 10)));
    tasks.push(_layerRag(query, workingDir, 8, 'session'));
  }
  // Always include cross-cutting RAG hit if nothing else fires.
  if (!tasks.length) tasks.push(_layerRag(query, workingDir, 8));

  const settled = await Promise.allSettled(tasks);
  const allHits = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) allHits.push(...s.value);
  }

  const ranked = crossRank(allHits, (TIER_BUDGETS[model_tier]?.topN || 8) + 10);

  // Build an answer_card: one to three lines summarising the strongest hits.
  const answer_card = ranked.length
    ? ranked.slice(0, 3).map((h, i) => `(${i + 1}) [${h.layer}] ${h.source_path} — ${_snip(h.snippet, 160)}`).join('\n')
    : `(no hits for "${_snip(query, 80)}" in ${resolved.slug}; coverage=${JSON.stringify(coverage)})`;

  // Optional 2-hop graph neighborhood for code intent.
  let graph_neighborhood = null;
  if (intent === 'code' && coverage.graphAvailable) {
    const firstGraphHit = ranked.find((h) => h.layer === 'graph');
    if (firstGraphHit) {
      try {
        graph_neighborhood = queryGraph(dirs, { mode: 'traverse', module: firstGraphHit.source_path, budget: 600, limit: 12 });
      } catch (_) {}
    }
  }

  const handoffRaw = loadHandoff(resolved.slug);
  const bundle = {
    answer_card,
    evidence: ranked,
    graph_neighborhood,
    handoff: sliceHandoffForTier(handoffRaw, model_tier),
    health: {
      slug: resolved.slug,
      escalated: resolved.escalated,
      escalated_from: resolved.escalatedFrom,
      intent,
      coverage,
      probed_layers: settled.map((s, i) => ({ idx: i, status: s.status, n: s.status === 'fulfilled' ? (s.value || []).length : 0 })),
    },
  };

  const compressed = compressForTier(bundle, model_tier);

  // Budget cap (soft): drop trailing evidence if oversized.
  let json = JSON.stringify(compressed, null, 2);
  if (budget_tokens && json.length > budget_tokens * 4) {
    while (compressed.evidence.length > 1 && JSON.stringify(compressed).length > budget_tokens * 4) {
      compressed.evidence.pop();
    }
    json = JSON.stringify(compressed, null, 2);
  }
  return json;
}
