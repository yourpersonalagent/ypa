// ── Context Sorter — batch / candidate selection ─────────────────────────────
// Pure scanning over `displaySessions` to compute the next batch, the index
// member-list, and the count of stuck/abandoned sessions for the dashboard.
'use strict';

const path = require('path');

const { _fingerprint, _relatedKey } = require('./util');
const { _computeAllSlugs, _computeRelatedMap } = require('./slug-graph');

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

interface _BatchMaps {
  slugs:   Map<string, _SlugMeta>;
  related: Map<string, _RelatedRef[]>;
}

interface _Member { sid: string; s: any; slug: string; }

// Snapshot of the inputs both `_getNextBatch` and `_renderSessionPage` need
// for a single sorter pass. Computed once per pass via `_computeBatchMaps()`.
function _computeBatchMaps(): _BatchMaps {
  const slugs   = _computeAllSlugs();
  const related = _computeRelatedMap(slugs);
  return { slugs, related };
}

// ── Candidate scanning ────────────────────────────────────────────────────────
// Eligibility:
//   • not in-memory only
//   • has a category (categorizer ran)
//   • either no wikiGenerated yet OR wikiContentHash differs from the
//     current fingerprint (session got new messages / renamed / re-categorised).

function _getNextBatch(
  size: number,
  skip: ReadonlySet<string> = new Set(),
  maps?: _BatchMaps,
): Array<{ sid: string; s: any; related: _RelatedRef[]; relatedKey: string }> {
  const { displaySessions } = require('../../../core/state');
  const m = maps || _computeBatchMaps();
  const out: Array<{ sid: string; s: any; related: _RelatedRef[]; relatedKey: string; ts: number }> = [];

  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    if (skip.has(sid)) continue;
    // Phase 5.3 — sessions auto-skipped after MAX_SORT_ATTEMPTS write
    // failures (or user-skipped via /skip-stuck) are excluded from the
    // queue so they stop blocking `isClear()`. Cleared by /force-retry.
    if (s._sortSkipped === true) continue;
    const related = m.related.get(sid) || [];
    const rk = _relatedKey(related);
    const fp = _fingerprint(s, rk);
    if (s.wikiGenerated && s.wikiContentHash === fp) continue;
    out.push({ sid, s, related, relatedKey: rk, ts: s.updatedAt ?? s.lastUsed ?? s.createdAt ?? 0 });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, size).map(({ sid, s, related, relatedKey }) => ({ sid, s, related, relatedKey }));
}

// ── Aggregate-index rebuild ───────────────────────────────────────────────────
// Cheap because we already hold every session in memory. Run once at the end
// of each batch to keep `_index.md`, by-category, by-type, by-date in sync.

function _collectAllForIndex(): _Member[] {
  const { displaySessions } = require('../../../core/state');
  const out: _Member[] = [];
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    if (!s.wikiPath) continue; // page not yet written → nothing to link to
    const slug = path.basename(s.wikiPath, '.md');
    out.push({ sid, s, slug });
  }
  return out;
}

// ── Phase 5.3 — stuck-session counting ───────────────────────────────────────

function _countStuckSessions(): { pending: number; abandoned: number } {
  const { displaySessions } = require('../../../core/state');
  let pending = 0, abandoned = 0;
  const m = _computeBatchMaps();
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    if (s._sortSkipped === true) { abandoned++; continue; }
    const related = m.related.get(sid) || [];
    const fp = _fingerprint(s, _relatedKey(related));
    if (s.wikiGenerated && s.wikiContentHash === fp) continue;
    pending++;
  }
  return { pending, abandoned };
}

module.exports = {
  _computeBatchMaps,
  _getNextBatch,
  _collectAllForIndex,
  _countStuckSessions,
};
