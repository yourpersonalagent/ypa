// ── /v1/context/items & /v1/context/file ─────────────────────────────────────
// Phase 1a / Adaption 3 + 4 + 6 of the ContextGenerator pipeline.
//
// Read-side surface that backs both the QuickContextPicker (input popover)
// and the future ContextHub (header modal). Same engine, two shells — see
// .ContextGenerator.MD §6.
//
//   GET /v1/context/items?cat=&q=&tier=&limit=
//     • cat   — one of the 12 categorizer slugs OR "notes"|"mail"|"calendar"
//               OR omitted (returns all sources).
//     • q     — free-text filter on title/tags.
//     • tier  — comma-separated whitelist (default "public").
//               For non-whitelisted tiers, items are returned with
//               `requiresConfirm: true` and the body stripped to a tiny
//               teaser (title only) so the UI can render the gate.
//     • limit — page size (default 50, max 200).
//
//   GET /v1/context/file?path=&confirmToken=
//     • Resolves `path` under whitelisted roots (docs/notes/, docs/mail/,
//       docs/calendar/). 404 if outside or missing.
//     • Tier comes from pathToDefaultTier(); non-public requires a valid
//       whitelist entry for the encoded item-id, else 403.
'use strict';

const fs = require('fs');
const path = require('path');
const { getModuleApi } = require('../../core/modules');

// ── Constants ────────────────────────────────────────────────────────────────

// Per-user (Q16 A.4) — routed via bridge/core/paths.ts. Legacy fallback:
// `<repo>/docs/`. Post-migration: `bridge/users/<email>/docs/`.
const DOCS_ROOT  = require('../../core/paths').userDocsDir;
// File-based categories — directories under `docs/` whose `.md` files appear
// in the Picker as `kind:'file'` items rather than being routed through the
// session-categorizer. `keep-notes` (Phase 3.4d) was added here so the
// "Import vault folder" workflow's output shows up automatically.
const FILE_CATS  = ['notes', 'keep-notes', 'mail', 'calendar'] as const;
const MAX_LIMIT  = 200;
const DEFAULT_LIMIT = 50;
const PUBLIC_TEASER_CHARS = 240;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _encodeFileId(p: string): string {
  // base64url so the id is safe in URL paths and JSON.
  return 'file:' + Buffer.from(p, 'utf8').toString('base64url');
}

function _decodeFileId(id: string): string | null {
  if (!id?.startsWith('file:')) return null;
  try {
    return Buffer.from(id.slice('file:'.length), 'base64url').toString('utf8');
  } catch (_) {
    return null;
  }
}

function _matchesQuery(haystack: string, q: string): boolean {
  if (!q) return true;
  const hl = haystack.toLowerCase();
  // AND-tokenize the query so multi-word filtering ("react picker") works.
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (!hl.includes(tok)) return false;
  }
  return true;
}

function _firstNonNote(s: any): string {
  for (const m of s.messages || []) {
    if (m.role === 'note') continue;
    let text: string = m.text || '';
    if (!text && Array.isArray(m.blocks)) {
      text = m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
    }
    if (text.trim()) return text.trim();
  }
  return '';
}

// Sessions → context items. Each item carries `requiresConfirm` based on
// the resolved tier vs. the request's tier-whitelist.
function _shapeSessionItem(sid: string, s: any, allowedTiers: Set<string>): Record<string, unknown> {
  const tier = String(s.sensitivity || 'public');
  const requiresConfirm = !allowedTiers.has(tier);
  const id = `session:${sid}`;
  const teaser = _firstNonNote(s).slice(0, PUBLIC_TEASER_CHARS);

  return {
    id,
    sid,
    kind:             'session',
    title:            s.name || '(untitled session)',
    category:         s.category || null,
    tags:             Array.isArray(s.tags)     ? s.tags     : [],
    keywords:         Array.isArray(s.keywords) ? s.keywords : [],
    sensitivity:      tier,
    sensitivitySource: s.sensitivitySource || null,
    requiresConfirm,
    // Only ship the snippet for tiers the caller is already permitted to see.
    snippet:          requiresConfirm ? '' : teaser,
    updatedAt:        s.updatedAt || s.createdAt || 0,
    nameSource:       s._nameSource || null,
  };
}

// Inline `role === 'note'` hits across sessions — the resurrected #notepicker
// flow (Phase 1.10, 2026-05-07). Returns one item per note message so users
// can click to jump back to the originating session. Sensitivity inherits
// from the parent session's tier (a note inside a `private` session stays
// private; the gate fires the same way it does for the session item).
function _scanInlineNotes(allowedTiers: Set<string>, q: string): Array<Record<string, unknown>> {
  const { displaySessions } = require('./../../core/state');
  const items: Array<Record<string, unknown>> = [];
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    const sessionTier = String(s.sensitivity || 'public');
    const requiresConfirm = !allowedTiers.has(sessionTier);
    const msgs = s.messages || [];
    for (let idx = 0; idx < msgs.length; idx++) {
      const m = msgs[idx];
      if (m?.role !== 'note') continue;
      let text = '';
      if (typeof m.text === 'string' && m.text) {
        text = m.text;
      } else if (Array.isArray(m.blocks)) {
        text = m.blocks
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.content || '')
          .join('\n')
          .trim();
      }
      const trimmed = text.trim();
      if (!trimmed) continue;
      // The /context/items query filter still runs on the merged list at the
      // bottom of the route, but to short-circuit huge note histories we skip
      // here too — same lowercase token AND match.
      if (q && !_matchesQuery(`${trimmed} ${s.name || ''}`, q)) continue;
      const ts = m.ts ?? s.updatedAt ?? s.createdAt ?? 0;
      // Title: first line, max 60 chars. Snippet: full text up to teaser cap.
      const firstLine = trimmed.split(/\r?\n/)[0]?.trim() || trimmed;
      const title = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
      items.push({
        id:                `note:${sid}:${idx}`,
        kind:              'note',
        sid,
        msgIdx:            idx,
        sessionName:       s.name || String(sid),
        title,
        category:          'notes',
        tags:              [],
        sensitivity:       sessionTier,
        sensitivitySource: s.sensitivitySource || null,
        requiresConfirm,
        snippet:           requiresConfirm ? '' : trimmed.slice(0, PUBLIC_TEASER_CHARS),
        updatedAt:         ts,
      });
    }
  }
  return items;
}

// File-system items (docs/notes/, docs/mail/, docs/calendar/). Each scan is
// shallow: just *.md files at the top level of the cat dir for now. Deep
// hierarchies are a Phase 2 concern.
// Phase 4.3 — extract the categorizer fields the file-categorizer writes
// (topics, tags, keywords, sensitivity) so file items expose the same
// search surface as session items. Tolerant single-line YAML extractor —
// only the subset our writers produce.
function _readFileFrontmatterFields(buf: string): {
  category:    string | null;
  topics:      string[];
  tags:        string[];
  keywords:    string[];
  sensitivity: string | null;
} {
  const out = {
    category:    null as string | null,
    topics:      [] as string[],
    tags:        [] as string[],
    keywords:    [] as string[],
    sensitivity: null as string | null,
  };
  if (!buf.startsWith('---\n')) return out;
  const end = buf.indexOf('\n---', 4);
  if (end < 0) return out;
  const fm = buf.slice(4, end);
  function get(key: string): string {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(fm);
    return m ? m[1].trim() : '';
  }
  function getList(key: string): string[] {
    const raw = get(key);
    if (!raw) return [];
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw.slice(1, -1).split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    return [raw];
  }
  out.category    = get('category').replace(/^["']|["']$/g, '') || null;
  out.topics      = getList('topics');
  out.tags        = getList('tags');
  out.keywords    = getList('keywords');
  out.sensitivity = get('sensitivity').replace(/^["']|["']$/g, '') || null;
  return out;
}

function _scanFileCategory(cat: 'notes' | 'keep-notes' | 'mail' | 'calendar', allowedTiers: Set<string>): Array<Record<string, unknown>> {
  const dir = path.join(DOCS_ROOT, cat);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f: string) => f.endsWith('.md') && !f.startsWith('_'));
  } catch (_) {
    return [];   // dir doesn't exist yet — no error, no items
  }
  const sensitivity = require('../context-generator/sensitivity');
  const items: Array<Record<string, unknown>> = [];

  for (const f of entries) {
    const full = path.join(dir, f);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile()) continue;

    // Read once — we need both the teaser AND the frontmatter fields.
    let buf: string | null = null;
    try { buf = fs.readFileSync(full, 'utf8'); } catch (_) { /* skip */ }

    // Frontmatter wins over path-based tier; fall back to path heuristic
    // when the file has no `sensitivity:` line yet (file-categorizer
    // hasn't run or file was hand-written).
    const fmFields = buf ? _readFileFrontmatterFields(buf) : { category: null, topics: [], tags: [], keywords: [], sensitivity: null };
    const tier = (fmFields.sensitivity && /^(public|private|system)$/.test(fmFields.sensitivity))
      ? fmFields.sensitivity
      : (sensitivity.pathToDefaultTier(full) || 'public');
    const requiresConfirm = !allowedTiers.has(tier);
    const id = _encodeFileId(full);

    let teaser = '';
    if (!requiresConfirm && buf) {
      const stripped = buf.replace(/^---[\s\S]*?---\s*/, '').trim();
      teaser = stripped.slice(0, PUBLIC_TEASER_CHARS);
    }

    items.push({
      id,
      kind:             'file',
      path:             full,
      title:            f.replace(/\.md$/i, ''),
      category:         fmFields.category || cat,
      topics:           fmFields.topics,
      tags:             fmFields.tags,
      keywords:         fmFields.keywords,
      sensitivity:      tier,
      sensitivitySource: fmFields.sensitivity ? 'frontmatter' : 'path',
      requiresConfirm,
      snippet:          teaser,
      updatedAt:        stat.mtimeMs || 0,
    });
  }
  return items;
}

// ── Route registration ──────────────────────────────────────────────────────

function registerContextItemRoutes(app): void {
  // ── GET /v1/context/items ───────────────────────────────────────────────────
  app.get('/v1/context/items', (req, res) => {
    const cat   = String(req.query.cat   || '').trim();
    const q     = String(req.query.q     || '').trim();
    const tierStr = String(req.query.tier || 'public');
    const limit = Math.min(Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT), MAX_LIMIT);

    const allowedTiers = new Set(
      tierStr.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    );
    if (allowedTiers.size === 0) allowedTiers.add('public');

    const out: Array<Record<string, unknown>> = [];

    // ── File-cat path ────────────────────────────────────────────────────────
    // When cat is one of "notes"/"mail"/"calendar" we read the file root and,
    // for `notes` specifically, ALSO surface inline `#note` hits from chat
    // sessions plus any sessions the categorizer has flagged as the `notes`
    // category. This restores the old #notepicker behaviour the QuickPicker
    // replaced — see .ContextGenerator.MD §3.2 + Phase 1.10 footer.
    if ((FILE_CATS as readonly string[]).includes(cat)) {
      out.push(..._scanFileCategory(cat as any, allowedTiers));
      if (cat === 'notes') {
        out.push(..._scanInlineNotes(allowedTiers, q));
        const { displaySessions } = require('./../../core/state');
        for (const [sid, s] of displaySessions as Map<string, any>) {
          if (!s || s._inMemoryOnly) continue;
          if (s.category !== 'notes') continue;
          out.push(_shapeSessionItem(sid, s, allowedTiers));
        }
      }
    } else {
      // ── Session-cat path ──────────────────────────────────────────────────
      // Empty cat = all sessions. Otherwise filter to the categorizer slug.
      const { displaySessions } = require('./../../core/state');
      for (const [sid, s] of displaySessions as Map<string, any>) {
        if (!s || s._inMemoryOnly) continue;
        if (cat && s.category !== cat) continue;
        out.push(_shapeSessionItem(sid, s, allowedTiers));
      }

      // Special case: cat="" means the picker wants a mixed view; include
      // file categories too so the user sees notes/mail/calendar without
      // switching tabs. Quick-Picker passes a cat explicitly so this only
      // matters for the future Hub.
      if (!cat) {
        for (const fc of FILE_CATS) {
          out.push(..._scanFileCategory(fc, allowedTiers));
        }
      }
    }

    // ── Filter + sort + paginate ─────────────────────────────────────────────
    // Phase 4.3 — search now matches against `tags`, `keywords`, and `topics`
    // (file-cats only have `topics`; sessions only have keywords as a real
    // semantic surface — `topics` is undefined there and joins to `''`).
    const filtered = q
      ? out.filter((it) => _matchesQuery(
          `${it.title} ${(it.tags as string[] | undefined || []).join(' ')} ` +
          `${(it.keywords as string[] | undefined || []).join(' ')} ` +
          `${(it.topics as string[] | undefined || []).join(' ')}`,
          q,
        ))
      : out;

    filtered.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    const page = filtered.slice(0, limit);

    res.json({
      success: true,
      items:   page,
      total:   filtered.length,
      cat:     cat || null,
      q:       q || null,
      tiers:   Array.from(allowedTiers),
    });
  });

  // ── GET /v1/context/graph ───────────────────────────────────────────────────
  // Returns the cross-link context graph the sorter materialises (or builds
  // a fresh one on the fly when the cached file is missing/stale).
  //
  //   ?fresh=1 — bypass the cached `bridge/context-graph.json` and rebuild
  //              live from in-memory sessions. Default falls back to live
  //              when the file doesn't exist yet.
  //
  // Powers the new "By context" view of the Context-Hub picker — see
  // .ContextGenerator.MD §4 (Sorter purpose) for why this lives in the
  // sorter module rather than computing it on the read path.
  app.get('/v1/context/graph', (req, res) => {
    const fresh = String(req.query.fresh || '').trim() === '1';
    try {
      const cg: any = getModuleApi('context-generator');
      if (!cg) {
        return res.status(501).json({ success: false, error: 'context-generator module is disabled' });
      }
      const sorter = cg.sorter;
      let graph: any = null;
      if (!fresh) graph = sorter.readContextGraph();
      if (!graph) {
        graph = sorter.buildLiveContextGraph();
        // graph from buildLive includes fromCache:false; readContextGraph
        // result may not — backfill so the UI can tell whether the data
        // came from disk or memory.
      } else if (graph && typeof graph === 'object' && graph.fromCache === undefined) {
        graph.fromCache = true;
      }
      res.json({ success: true, graph });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── GET /v1/context/session-content?sid= ────────────────────────────────────
  // Returns the assembled "post-context" payload for a session: title,
  // category, tags, plus the user/assistant transcript (clamped to a
  // reasonable byte budget so a 50-message thread doesn't blow the chat
  // input). The frontend "📋 Post Context" button inserts this into the
  // chat-input textarea so the user can ask follow-up questions in their
  // active session about a sibling session's content. The response respects
  // the same sensitivity gate as `/v1/context/items`: a non-public session
  // requires a valid whitelist entry on `session:<sid>` or returns 403.
  app.get('/v1/context/session-content', (req, res) => {
    const sid = String(req.query.sid || '').trim();
    if (!sid) return res.status(400).json({ success: false, error: 'sid required' });
    const { displaySessions } = require('./../../core/state');
    const s = displaySessions.get(sid);
    if (!s || s._inMemoryOnly) {
      return res.status(404).json({ success: false, error: 'session not found' });
    }
    const tier = String(s.sensitivity || 'public');
    if (tier !== 'public') {
      const sensitivity = require('../context-generator/sensitivity');
      const itemId = `session:${sid}`;
      const ok = sensitivity.checkAndConsumeWhitelist(itemId);
      if (!ok) {
        return res.status(403).json({
          success:         false,
          requiresConfirm: true,
          tier,
          itemId,
        });
      }
    }
    // Assemble transcript — honour same role-filter rules as auto-title's
    // content extractor, but with a 12 KB byte cap so the chat input
    // doesn't get a wall of text. The user can re-paste a longer slice
    // manually if they need it.
    const MAX_BYTES = 12_000;
    const lines: string[] = [];
    let bytes = 0;
    for (const m of (s.messages || [])) {
      if (m.role === 'note') continue;
      let text: string = m.text || '';
      if (!text && Array.isArray(m.blocks)) {
        text = m.blocks
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.content || '')
          .join(' ');
      }
      if (!text.trim()) continue;
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : String(m.role || '?');
      const line = `**${role}:** ${text.trim()}`;
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes > MAX_BYTES) {
        lines.push('[…transcript truncated]');
        break;
      }
      lines.push(line);
    }
    res.json({
      success:     true,
      sid,
      title:       s.name || '(untitled)',
      category:    s.category || null,
      tags:        Array.isArray(s.tags) ? s.tags : [],
      sensitivity: tier,
      messageCount: (s.messages || []).length,
      transcript:  lines.join('\n\n'),
      truncated:   bytes > MAX_BYTES,
    });
  });

  // ── GET /v1/context/file ────────────────────────────────────────────────────
  app.get('/v1/context/file', (req, res) => {
    const requested = String(req.query.path || '');
    if (!requested) return res.status(400).json({ success: false, error: 'path required' });
    const resolved = path.resolve(requested);

    // Path must live under one of the whitelisted file-cat roots.
    const allowedRoots = FILE_CATS.map((c) => path.join(DOCS_ROOT, c) + path.sep);
    const insideAllowed = allowedRoots.some((root) => resolved.startsWith(root));
    if (!insideAllowed) {
      return res.status(403).json({ success: false, error: 'path outside allowed roots' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ success: false, error: 'not found' });
    }

    const sensitivity = require('../context-generator/sensitivity');
    const tier = sensitivity.pathToDefaultTier(resolved) || 'public';

    if (tier !== 'public') {
      const id = _encodeFileId(resolved);
      // Optional shortcut: caller can pass `confirmToken=<id>` to indicate
      // they already obtained a whitelist entry for this item via /confirm.
      // We then consume the entry for one-shot items.
      const ok = sensitivity.checkAndConsumeWhitelist(id);
      if (!ok) {
        return res.status(403).json({
          success:         false,
          requiresConfirm: true,
          tier,
          itemId:          id,
        });
      }
    }

    let buf: string;
    try {
      buf = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      return res.status(500).json({
        success: false,
        error:   e instanceof Error ? e.message : String(e),
      });
    }

    res.json({
      success:     true,
      path:        resolved,
      sensitivity: tier,
      content:     buf,
    });
  });
}

module.exports = { registerContextItemRoutes };
