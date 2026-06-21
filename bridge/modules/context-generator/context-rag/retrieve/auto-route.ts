// ── context-rag retrieve auto-route ───────────────────────────────────────────
// Decides which VectorDBs answer a given query. Three modes:
//
//   • routeByIds(ids)       explicit caller-supplied list (the ⚡ picker
//                           toggle in the chat composer). IDs that don't
//                           exist are silently dropped.
//
//   • routeFromCwd(cwd)     "auto" mode used when the caller hasn't pinned
//                           anything. Returns the union of:
//                             - every DB with a `sessions.mode='all'` or
//                               `files.mode` cwd/roots matching `cwd`
//                             - every DB with `knowledge.mode='all'`
//                             - every DB with `sessions.mode='cwd'` whose
//                               cwd matches the active session's cwd
//                           — i.e. "what RAG corpora the current workspace
//                           plausibly cares about."
//
//   • routeAll()            every DB; used by the MCP `rag_search` tool when
//                           the caller wants the widest possible recall and
//                           is happy to pay the N-embed-call cost.
//
// This file does NOT touch embed clients or run any IO. It's pure registry
// filtering. The retrieve query layer (./query.ts) calls one of these and
// then iterates the result.
'use strict';

import type { VectorDB } from '../registry/types';
import { listDbs, getDb } from '../registry/store';

interface RouteAutoInput {
  /** Active session's working_dir, or null when the user is in a bare chat
   *  with no project context. `null` only matches DBs whose sources are
   *  `'all'` (since cwd-keyed routing can't fire). */
  cwd: string | null;
}

interface RouteResult {
  dbs: VectorDB[];
  /** Why each DB ended up in (or out of) the route — surfaced to the UI so
   *  the user can see "this query went to: alpha (cwd match), beta (all)". */
  reasons: Record<string, string>;
}

function _normalize(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '');
}

function _isInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const P = _normalize(parent);
  const C = _normalize(child);
  if (C === P) return true;
  return C.startsWith(P + '/');
}

/** Explicit-id route. Order is preserved from the caller; unknown ids are
 *  dropped silently because the chat picker may carry stale ids after a
 *  rename or delete. */
function routeByIds(ids: readonly string[]): RouteResult {
  const reasons: Record<string, string> = {};
  const dbs: VectorDB[] = [];
  for (const id of ids) {
    const db = getDb(id);
    if (!db) continue;
    dbs.push(db);
    reasons[id] = 'explicit';
  }
  return { dbs, reasons };
}

/** All DBs, no filtering. Caller pays N embed calls — used by MCP when the
 *  agent explicitly asks for wide recall. */
function routeAll(): RouteResult {
  const reasons: Record<string, string> = {};
  const dbs = listDbs();
  for (const db of dbs) reasons[db.id] = 'all-route';
  return { dbs, reasons };
}

/** "Auto" mode: pick the DBs the current workspace plausibly cares about.
 *  See header for the union rules. */
function routeFromCwd(input: RouteAutoInput): RouteResult {
  const cwd = input.cwd ? _normalize(input.cwd) : null;
  const reasons: Record<string, string> = {};
  const dbs: VectorDB[] = [];
  for (const db of listDbs()) {
    const why: string[] = [];

    const s = db.source.sessions;
    if (s.mode === 'all') why.push('sessions:all');
    else if (s.mode === 'cwd' && cwd && s.cwd && _normalize(s.cwd) === cwd) {
      why.push('sessions:cwd-match');
    }

    const f = db.source.files;
    if (f.mode === 'cwd' && cwd && f.cwd && _isInside(f.cwd, cwd)) {
      why.push('files:cwd-match');
    } else if (f.mode === 'roots' && cwd && Array.isArray(f.roots)) {
      if (f.roots.some((r) => _isInside(r, cwd))) why.push('files:root-match');
    }

    const k = db.source.knowledge;
    if (k.mode === 'all') why.push('knowledge:all');

    const syn = db.source.synthesis;
    if (syn) {
      if (syn.mode === 'all') why.push('synthesis:all');
      else if (syn.mode === 'cwd' && cwd && syn.cwd && _normalize(syn.cwd) === cwd) {
        why.push('synthesis:cwd-match');
      }
    }

    if (why.length > 0) {
      dbs.push(db);
      reasons[db.id] = why.join('+');
    }
  }
  return { dbs, reasons };
}

export { routeByIds, routeAll, routeFromCwd };
export type { RouteAutoInput, RouteResult };
