// ── context-rag retrieve glossary ─────────────────────────────────────────────
// Per-cwd concept↔jargon map. Lives next to the synthesis bucket at
// `bridge/knowledge/dirs/<slug>/synthesis/glossary.json` so the cwd-synthesize
// skill can author it as a sibling artifact (same source-of-truth contract as
// the rest of the bucket).
//
// Why it exists
// ─────────────
// The embedder (nv-embedqa-e5-v5) doesn't bridge "professional installation"
// to YHA's invented vocabulary (`yha-professional`, `YHA_PROFILE=professional`)
// on its own. The first big MCP test reproduced this exactly: layperson
// phrasing returned 0 RAG hits; rephrasing with internal jargon returned 12.
// A 20-50-entry alias map covers most of the gap.
//
// File format (a contract the synthesizer skill is expected to honour):
//
//   {
//     "version": 1,
//     "entries": [
//       {
//         "concept": "professional installation",
//         "aliases": ["yha-professional", "YHA_PROFILE=professional",
//                     "multi-tenant yha"]
//       },
//       ...
//     ]
//   }
//
// `concept` is matched case-insensitively as a substring. When multiple
// concepts hit, all their aliases are appended in order, de-duped.
//
// Expansion strategy (additive, not replacing)
// ────────────────────────────────────────────
// We append `[a1, a2, ...]` to the original query string rather than
// rewriting it. Keeping the user's phrasing means the embedder still does
// its normal job for queries where the alias map isn't relevant; the bracket
// list just gives it concrete jargon to anchor on when it would otherwise
// drift. The reranker downstream is responsible for final ordering.
//
// Why glossary lives next to synthesis
// ────────────────────────────────────
// Same authoring tool, same refresh trigger, same staleness model. The
// cwd-synthesize skill already distills "decisions + jargon" — emitting
// glossary.json is the natural place for it. The pipeline is the consumer,
// not the author.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../../core/logger');

const PATHS              = require('../../../../core/paths');
const SYNTHESIS_ROOT_DIR = process.env.YHA_CONTEXT_RAG_SYNTHESIS_DIR
  || path.join(PATHS.knowledgeRoot, 'dirs');

interface GlossaryEntry {
  concept: string;
  aliases: string[];
}

interface ParsedGlossary {
  entries: GlossaryEntry[];
  /** Source path, for logging. */
  path:    string;
  /** File mtime in ms, used as the cache key — a glossary edit invalidates
   *  the cache on next access. */
  mtime:   number;
}

// cwd-normalized → cached parse. Single bridge process; the cache is keyed
// off mtime so an edit refreshes naturally without us touching watchers.
const _cache: Map<string, ParsedGlossary | null> = new Map();

function _normalize(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '');
}

function _slugForCwd(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '___');
}

/** Absolute path glossary.json would live at for a cwd. */
function glossaryPathForCwd(cwd: string): string {
  return path.join(SYNTHESIS_ROOT_DIR, _slugForCwd(cwd), 'synthesis', 'glossary.json');
}

function _parseRaw(raw: any, fromPath: string): GlossaryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  // Accept either {entries: [...]} or a bare array.
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : null;
  if (!list) {
    logger.warn('context-rag.glossary.malformed', { path: fromPath, reason: 'no entries array' });
    return [];
  }
  const out: GlossaryEntry[] = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const concept = String(e.concept || '').trim();
    if (!concept) continue;
    const aliases = Array.isArray(e.aliases)
      ? e.aliases.map((a: any) => String(a).trim()).filter((s: string) => s.length > 0)
      : [];
    if (aliases.length === 0) continue;
    out.push({ concept, aliases });
  }
  return out;
}

/** Load (with mtime cache) the glossary for a given cwd. Returns null when
 *  no glossary file exists — callers treat that as "no expansion." */
function loadGlossaryForCwd(cwd: string | null | undefined): ParsedGlossary | null {
  if (!cwd) return null;
  const key = _normalize(cwd);
  const p = glossaryPathForCwd(key);

  let stat: any;
  try { stat = fs.statSync(p); }
  catch (e: any) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      _cache.set(key, null);
      return null;
    }
    logger.warn('context-rag.glossary.stat-failed', {
      path: p, error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  const mtime = Math.floor(stat.mtimeMs);

  const cached = _cache.get(key);
  if (cached && cached.mtime === mtime) return cached;

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    logger.warn('context-rag.glossary.read-failed', {
      path: p, error: e instanceof Error ? e.message : String(e),
    });
    _cache.set(key, null);
    return null;
  }
  const entries = _parseRaw(raw, p);
  const parsed: ParsedGlossary = { entries, path: p, mtime };
  _cache.set(key, parsed);
  return parsed;
}

interface ExpandResult {
  /** Original query, unchanged. */
  original: string;
  /** Expanded query — original plus bracketed alias list, or === original
   *  when no concepts matched. */
  expanded: string;
  /** Which entries fired; surfaced to retrieve debug so the UI can show
   *  "expanded via X→[a,b,c]". */
  hits: Array<{ concept: string; aliases: string[] }>;
  /** Glossary file path, or null when no glossary existed. */
  glossaryPath: string | null;
}

/** Expand a query string using the glossary for `cwd`. Additive only — the
 *  original query is preserved. Idempotent: re-expanding never compounds. */
function expandQuery(query: string, cwd: string | null | undefined): ExpandResult {
  const original = query;
  const glossary = loadGlossaryForCwd(cwd);
  if (!glossary || glossary.entries.length === 0) {
    return { original, expanded: original, hits: [], glossaryPath: glossary?.path ?? null };
  }
  const lower = query.toLowerCase();
  const hits: Array<{ concept: string; aliases: string[] }> = [];
  const aliasSet = new Set<string>();
  for (const entry of glossary.entries) {
    if (!lower.includes(entry.concept.toLowerCase())) continue;
    hits.push(entry);
    for (const a of entry.aliases) aliasSet.add(a);
  }
  if (hits.length === 0) {
    return { original, expanded: original, hits: [], glossaryPath: glossary.path };
  }
  // Bracket-list format: terse, doesn't drown the original phrasing in noise.
  const expanded = `${query} [${Array.from(aliasSet).join(', ')}]`;
  return { original, expanded, hits, glossaryPath: glossary.path };
}

/** Test/admin: drop the in-memory cache. */
function _reset(): void { _cache.clear(); }

export {
  loadGlossaryForCwd,
  expandQuery,
  glossaryPathForCwd,
  SYNTHESIS_ROOT_DIR,
  _reset,
};
export type { GlossaryEntry, ParsedGlossary, ExpandResult };
