// ── Context Sorter — pure helpers ─────────────────────────────────────────────
// Slug / fingerprint / yaml / first-message helpers. No state, no I/O. Used by
// slug-graph, render-pages, file-io, batch.
'use strict';

const crypto = require('crypto');
const path   = require('path');

const {
  DOCS_GENERATED_ROOT,
  TYPE_LABELS,
} = require('./constants');

// ── Slug helpers ──────────────────────────────────────────────────────────────
// `"DOM Issues with Picker!"` → `dom-issues-with-picker`
// Falls back to the session-id when the title yields nothing usable.

function _slugify(input: string, fallback: string): string {
  if (!input || typeof input !== 'string') return fallback;
  const cleaned = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')              // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function _sessionTypePrefix(sid: string): keyof typeof TYPE_LABELS {
  if (!sid) return 'other';
  const m = sid.match(/^([a-z]+)_/i);
  if (!m) return 'other';
  const p = m[1].toLowerCase();
  return (p in TYPE_LABELS ? p : 'other') as keyof typeof TYPE_LABELS;
}

function _quarterFromTs(ts: number): string {
  // 2026-Q2 etc. Falls back to year only when we can't determine the quarter.
  const d = new Date(ts || Date.now());
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

function _isoDate(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toISOString();
}

// ── Path-safety guard ─────────────────────────────────────────────────────────
// Refuse to write outside docs/generated/ — protects against a session whose
// title generates a slug with `..` slipped through (shouldn't happen post-slugify
// but defence-in-depth doesn't cost us anything).

function _assertWithinGenerated(p: string): void {
  const rel = path.relative(DOCS_GENERATED_ROOT, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to write outside docs/generated/: ${p}`);
  }
}

// ── Fingerprint ───────────────────────────────────────────────────────────────
// Stable hash of the inputs that affect the output Markdown. When the
// fingerprint matches `s.wikiContentHash`, we know the session's wiki-page
// is up-to-date and can be skipped this run.

// Bump when the session-page renderer changes shape so existing pages get
// rewritten exactly once on the next sorter pass. Audit 2026-05-10 added
// the "Letzte Antwort" line and the corrected category wikilink, so every
// previously-rendered page is now stale by content but matches the old
// fingerprint — without this bump the file-categorizer would never re-emit
// them. See sorter/render-pages.ts.
const _RENDERER_VERSION = 'v2-2026-05-10-last-assistant';

function _fingerprint(s: any, relatedKey: string = ''): string {
  const hash = crypto.createHash('sha1');
  hash.update(_RENDERER_VERSION);
  hash.update('|');
  hash.update(String(s.id || ''));
  hash.update('|');
  hash.update(String(s.name || ''));
  hash.update('|');
  hash.update(String(s.category || ''));
  hash.update('|');
  hash.update(JSON.stringify(s.tags || []));
  // Phase 4.3 — keywords participate in the fingerprint so a session re-renders
  // when the LLM produces new keywords on a re-classification.
  hash.update('|');
  hash.update(JSON.stringify(s.keywords || []));
  hash.update('|');
  hash.update(String(s.workingDir || s.cwd || ''));
  hash.update('|');
  hash.update(String((s.messages || []).length));
  hash.update('|');
  hash.update(String(s.updatedAt ?? s.lastUsed ?? s.createdAt ?? 0));
  hash.update('|');
  hash.update(String(s.sensitivity || 'public'));
  // Phase 2.5: include the resolved wikilink-set so a session re-renders when
  // one of its related sessions gets renamed (slug changes) or drops in/out
  // of the top-N list. Empty string = legacy fingerprint (no resolver run yet)
  // — first sorter pass after the upgrade dirties every page exactly once.
  hash.update('|');
  hash.update(relatedKey);
  return hash.digest('hex').slice(0, 16);
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

function _firstUserMessage(s: any): string {
  for (const m of s.messages || []) {
    if (m.role !== 'user') continue;
    const text = (m.text || '').trim();
    if (text) return text.slice(0, 240);
    if (Array.isArray(m.blocks)) {
      const joined = m.blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.content || '')
        .join(' ')
        .trim();
      if (joined) return joined.slice(0, 240);
    }
  }
  return '';
}

// Last assistant message text — paired with `_firstUserMessage` in
// session-page rendering so the synthesis page captures both the
// question and the resolution. Audit 2026-05-10 found pages were
// rendering only the first user turn (~10 % of the conversation),
// making them weak for search-index value.
function _lastAssistantMessage(s: any): string {
  const messages = s.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = (m.text || '').trim();
    if (text) return text.slice(0, 320);
    if (Array.isArray(m.blocks)) {
      const joined = m.blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.content || '')
        .join(' ')
        .trim();
      if (joined) return joined.slice(0, 320);
    }
  }
  return '';
}

function _yamlString(v: string): string {
  // Quote when the value contains anything that would confuse a YAML 1.2
  // parser; otherwise leave bare for readable diffs.
  if (!v) return '""';
  if (/^[A-Za-z0-9_\-\/. ]+$/.test(v) && !/^[-?:]/.test(v)) return v;
  return JSON.stringify(v);
}

// Stable sorted key fed into the fingerprint so a session re-renders when its
// related-set changes (sibling renamed, new session became top-N, etc.).
interface _RelatedRefLike { sid: string; slug: string; title: string; }
function _relatedKey(related: ReadonlyArray<_RelatedRefLike>): string {
  return [...related]
    .map((r) => `${r.sid}:${r.slug}`)
    .sort()
    .join('|');
}

module.exports = {
  _slugify,
  _sessionTypePrefix,
  _quarterFromTs,
  _isoDate,
  _assertWithinGenerated,
  _fingerprint,
  _firstUserMessage,
  _lastAssistantMessage,
  _yamlString,
  _relatedKey,
};
