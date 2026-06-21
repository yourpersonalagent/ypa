// ── Context Sorter — slug + related-map + context-graph ──────────────────────
// Phase 2.5 — wikilink resolver helpers + Phase 3 cross-link graph builder.
//
// The Sorter's "Verknüpfte Sessions" section used to be a placeholder
// (`<!-- wikilinks resolved on next sorter pass -->`). It now renders proper
// `[[../sessions/<slug>|Title]]` links computed from the same category+tag
// overlap heuristic as the context-graph, so the JSON graph (consumed by the
// frontend Picker) and the Markdown vault (consumed by Obsidian) agree on
// "what's related."
//
// Algorithm:
//   1. _computeAllSlugs()   — every session's slug snapshotted in one pass
//   2. _computeRelatedMap() — top-N related sids per session (cat + tag score)
//   3. _relatedKey()        — stable hash key fed into _fingerprint() so we
//                              re-render when a linked session gets renamed.
//
// Important: the related-map is a *snapshot* taken at the start of each batch
// run. We do NOT re-compute it after each individual page write — a session
// rename inside the same batch will be picked up on the next sorter tick,
// not within the current run. That's intentional: it keeps the run
// deterministic and avoids O(n²) re-computation.
'use strict';

const fs     = require('fs');
const crypto = require('crypto');

const { CONTEXT_GRAPH_PATH, RELATED_TOP_N } = require('./constants');
const { _slugify } = require('./util');

interface _SlugMeta {
  slug:         string;
  title:        string;
  sensitivity:  string;
  category:     string;
  tags:         string[];
}

interface _RelatedRef {
  sid:   string;
  slug:  string;
  title: string;
}

interface _GraphSessionStub {
  sid:         string;
  title:       string;
  category:    string;
  tags:        string[];
  sensitivity: string;
  updatedAt:   number;
  messageCount: number;
}

function _computeAllSlugs(): Map<string, _SlugMeta> {
  const { displaySessions } = require('../../../core/state');
  const out = new Map<string, _SlugMeta>();
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    out.set(sid, {
      slug:        _slugify(s.name || '', sid),
      title:       String(s.name || sid),
      sensitivity: String(s.sensitivity || 'public'),
      category:    String(s.category || 'general'),
      tags:        Array.isArray(s.tags) ? s.tags.map((t: any) => String(t)) : [],
    });
  }
  return out;
}

function _computeRelatedMap(slugs: Map<string, _SlugMeta>): Map<string, _RelatedRef[]> {
  const byCategory: Record<string, string[]> = {};
  const byTag:      Record<string, string[]> = {};
  for (const [sid, meta] of slugs) {
    (byCategory[meta.category] ||= []).push(sid);
    for (const t of meta.tags) (byTag[t] ||= []).push(sid);
  }
  const out = new Map<string, _RelatedRef[]>();
  for (const [sid, meta] of slugs) {
    const score = new Map<string, number>();
    for (const sib of byCategory[meta.category] || []) {
      if (sib === sid) continue;
      score.set(sib, (score.get(sib) || 0) + 1);
    }
    for (const tag of meta.tags) {
      for (const sib of byTag[tag] || []) {
        if (sib === sid) continue;
        score.set(sib, (score.get(sib) || 0) + 1);
      }
    }
    const top = [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RELATED_TOP_N)
      .map(([rsid]) => {
        const m = slugs.get(rsid);
        return m ? { sid: rsid, slug: m.slug, title: m.title } : null;
      })
      .filter((x): x is _RelatedRef => x !== null);
    out.set(sid, top);
  }
  return out;
}

// ── Context-graph builder ─────────────────────────────────────────────────────
// New on 2026-05-06 — replaces the "Markdown is the primary product" mental
// model with "the graph is the primary product, Markdown is one consumer".
// The graph powers the Context-Hub Picker's "By context" view, where users
// switch sessions or paste a session's full transcript into the chat input.
//
// "Related" sessions are computed from category + tag overlap:
//   • Same category counts as 1 point.
//   • Each shared tag counts as 1 point.
//   • Self-relations are excluded.
// We keep the top 8 highest-scoring per session so a busy category doesn't
// produce a 200-edge fan-out that bloats the JSON file.

function _stubFromSession(sid: string, s: any): _GraphSessionStub {
  return {
    sid,
    title:        String(s.name || '(untitled)'),
    category:     String(s.category || 'general'),
    tags:         Array.isArray(s.tags) ? s.tags.map((t: any) => String(t)) : [],
    sensitivity: String(s.sensitivity || 'public'),
    updatedAt:    Number(s.updatedAt ?? s.lastUsed ?? s.createdAt ?? 0),
    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
  };
}

// ── Read cache (mtime-keyed) ──────────────────────────────────────────────────
// The graph is 2.3 MB and was parsed on every GET /v1/context/graph. Cache
// the parsed object keyed on the file's mtime — if mtime is unchanged since
// last read, skip the I/O and JSON.parse. Cache is invalidated by
// `_buildContextGraph()` writing the new payload (we capture the new mtime
// after the atomic rename and stash the in-memory graph alongside it).
// Module-scoped state dies with the module on hot-reload (loader.ts:338 busts
// require.cache), so no leak.
let _graphCache: { mtimeMs: number; value: Record<string, unknown> } | null = null;

async function _buildContextGraph(): Promise<number> {
  const { displaySessions } = require('../../../core/state');

  const stubs: _GraphSessionStub[] = [];
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    stubs.push(_stubFromSession(sid, s));
  }

  // Index by category + by tag for quick relatedness lookup.
  const byCategory: Record<string, _GraphSessionStub[]> = {};
  const byTag:      Record<string, _GraphSessionStub[]> = {};
  for (const st of stubs) {
    (byCategory[st.category] ||= []).push(st);
    for (const t of st.tags) (byTag[t] ||= []).push(st);
  }

  // Compute related sids per session. O(n × k) where k = avg tag count + cat
  // siblings; cheap for n ≤ 10 000. The score is intentionally simple — a
  // future iteration could swap in tf-idf-weighted tags or session-text
  // embeddings, but the current heuristic is good enough to populate the
  // "By context" Picker.
  const sessionsOut: Record<string, { related: string[] }> = {};
  for (const me of stubs) {
    const score = new Map<string, number>();
    for (const sib of byCategory[me.category] || []) {
      if (sib.sid === me.sid) continue;
      score.set(sib.sid, (score.get(sib.sid) || 0) + 1);
    }
    for (const tag of me.tags) {
      for (const sib of byTag[tag] || []) {
        if (sib.sid === me.sid) continue;
        score.set(sib.sid, (score.get(sib.sid) || 0) + 1);
      }
    }
    const top = [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, RELATED_TOP_N)
      .map(([sid]) => sid);
    sessionsOut[me.sid] = { related: top };
  }

  // Stub-shape per category — sorted by updatedAt, capped to 200 to keep the
  // JSON file from bloating. The full session list is still available via
  // the existing /v1/context/items endpoint; this graph is a quick-pick
  // index.
  const categoriesOut: Record<string, { count: number; sessions: _GraphSessionStub[] }> = {};
  for (const [cat, members] of Object.entries(byCategory)) {
    const sorted = [...members].sort((a, b) => b.updatedAt - a.updatedAt);
    categoriesOut[cat] = { count: sorted.length, sessions: sorted.slice(0, 200) };
  }

  const graph = {
    generatedAt:   Date.now(),
    totalSessions: stubs.length,
    categories:    categoriesOut,
    tags:          Object.fromEntries(
      Object.entries(byTag).map(([t, list]) => [t, list.slice(0, 50)])
    ),
    sessions:      sessionsOut,
  };

  const tmp = CONTEXT_GRAPH_PATH + '.tmp-' + crypto.randomBytes(4).toString('hex');
  await fs.promises.writeFile(tmp, JSON.stringify(graph, null, 0), 'utf8');
  await fs.promises.rename(tmp, CONTEXT_GRAPH_PATH);
  // Refresh the read cache so the very next /v1/context/graph hit returns
  // the just-written payload without re-parsing the 2.3 MB file. We pick up
  // the post-rename mtime to keep the cache key consistent with what a
  // subsequent stat() would observe.
  try {
    const st = fs.statSync(CONTEXT_GRAPH_PATH);
    _graphCache = { mtimeMs: st.mtimeMs, value: graph };
  } catch (_) {
    // If stat() fails (unlikely — we just renamed onto this path), drop the
    // cache so the next read re-parses from disk.
    _graphCache = null;
  }
  return 1; // file count for the index-rebuild stat
}

// ── Graph reader ─────────────────────────────────────────────────────────────
// Used by the /v1/context/graph endpoint. Returns the parsed JSON or null
// if the file doesn't exist yet (sorter never ran on this install). Caller
// is responsible for handling the null path — typically by falling back to
// an on-the-fly graph build (which is cheap enough to inline).

function readContextGraph(): null | Record<string, unknown> {
  try {
    const st = fs.statSync(CONTEXT_GRAPH_PATH);
    if (_graphCache && _graphCache.mtimeMs === st.mtimeMs) return _graphCache.value;
    const raw = fs.readFileSync(CONTEXT_GRAPH_PATH, 'utf8');
    const value = JSON.parse(raw) as Record<string, unknown>;
    _graphCache = { mtimeMs: st.mtimeMs, value };
    return value;
  } catch (_) { return null; }
}

// Build the graph synchronously without writing to disk — used by the
// /v1/context/graph endpoint when the cached file is missing or stale and
// the user wants live data without waiting for the next sorter tick.
function buildLiveContextGraph(): Record<string, unknown> {
  // Mirrors `_buildContextGraph` but returns the in-memory object instead
  // of writing the file. Keeping the duplication explicit so the hot path
  // (sorter run) doesn't need an extra arg + branch.
  const { displaySessions } = require('../../../core/state');
  const stubs: _GraphSessionStub[] = [];
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    stubs.push(_stubFromSession(sid, s));
  }
  const byCategory: Record<string, _GraphSessionStub[]> = {};
  const byTag:      Record<string, _GraphSessionStub[]> = {};
  for (const st of stubs) {
    (byCategory[st.category] ||= []).push(st);
    for (const t of st.tags) (byTag[t] ||= []).push(st);
  }
  const sessionsOut: Record<string, { related: string[] }> = {};
  for (const me of stubs) {
    const score = new Map<string, number>();
    for (const sib of byCategory[me.category] || []) {
      if (sib.sid === me.sid) continue;
      score.set(sib.sid, (score.get(sib.sid) || 0) + 1);
    }
    for (const tag of me.tags) {
      for (const sib of byTag[tag] || []) {
        if (sib.sid === me.sid) continue;
        score.set(sib.sid, (score.get(sib.sid) || 0) + 1);
      }
    }
    sessionsOut[me.sid] = {
      related: [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, RELATED_TOP_N).map(([sid]) => sid),
    };
  }
  const categoriesOut: Record<string, { count: number; sessions: _GraphSessionStub[] }> = {};
  for (const [cat, members] of Object.entries(byCategory)) {
    const sorted = [...members].sort((a, b) => b.updatedAt - a.updatedAt);
    categoriesOut[cat] = { count: sorted.length, sessions: sorted.slice(0, 200) };
  }
  return {
    generatedAt:   Date.now(),
    totalSessions: stubs.length,
    fromCache:     false,
    categories:    categoriesOut,
    tags:          Object.fromEntries(
      Object.entries(byTag).map(([t, list]) => [t, list.slice(0, 50)])
    ),
    sessions:      sessionsOut,
  };
}

module.exports = {
  _computeAllSlugs,
  _computeRelatedMap,
  _stubFromSession,
  _buildContextGraph,
  readContextGraph,
  buildLiveContextGraph,
};
