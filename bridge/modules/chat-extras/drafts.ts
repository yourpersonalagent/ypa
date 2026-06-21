'use strict';

// ── /v1/drafts/current ───────────────────────────────────────────────────────
// Phase 0 of the ContextGenerator pipeline — server-side autosave for the chat
// input draft. The frontend lazy-saves the textarea value (debounced + only
// while idle) so a tab refresh or accidental nav doesn't lose work-in-progress.
//
// Single-user system: one draft file at bridge/draft.json (matches the
// input-history.json convention next to it). Schema:
//   { "text": string, "updatedAt": number }
//
// Endpoints:
//   GET    /v1/drafts/current  → { text, updatedAt }
//   PUT    /v1/drafts/current  { text } → { ok, updatedAt }
//   DELETE /v1/drafts/current  → { ok }

const fs = require('fs');
const path = require('path');

// User-state file kept at bridge/draft.json across the modular migration.
// __dirname is bridge/modules/chat-extras; two `..` reach bridge/.
const FILE = path.join(__dirname, '..', '..', 'draft.json');
const MAX_LEN = 1_000_000; // 1 MB safety cap — the input is plain text.

interface DraftFile {
  text: string;
  updatedAt: number;
}

const EMPTY: DraftFile = { text: '', updatedAt: 0 };

// ── Read cache (mtime-keyed) ──────────────────────────────────────────────────
// Frontend debounces PUTs (typing pause), but GETs happen on every session
// switch / tab focus, so the read path is the hot one. Cache parsed JSON
// keyed on mtimeMs; write() and clearFile() refresh / invalidate.
let _cache: { mtimeMs: number; value: DraftFile } | null = null;

function read(): DraftFile {
  try {
    const st = fs.statSync(FILE);
    if (_cache && _cache.mtimeMs === st.mtimeMs) return _cache.value;
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw) as DraftFile;
    const value: DraftFile = {
      text: typeof parsed?.text === 'string' ? parsed.text : '',
      updatedAt: Number.isFinite(parsed?.updatedAt) ? Number(parsed.updatedAt) : 0,
    };
    _cache = { mtimeMs: st.mtimeMs, value };
    return value;
  } catch (e: any) {
    // Missing file (fresh slate) → silent return of EMPTY. Anything else
    // (parse error, EACCES, EIO) silently dropped the user's draft historically;
    // surface those so a corrupt draft.json is debuggable.
    if (e?.code !== 'ENOENT') {
      console.warn('[drafts] read failed:', e?.code || '', e?.message || String(e));
    }
    _cache = null;
    return { ...EMPTY };
  }
}

function write(draft: DraftFile): void {
  // Atomic write — same pattern as input-history.ts. Avoids a half-written
  // JSON file if the process crashes mid-save (which would lose the draft
  // entirely on next read because JSON.parse would throw).
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2));
  fs.renameSync(tmp, FILE);
  try {
    const st = fs.statSync(FILE);
    _cache = { mtimeMs: st.mtimeMs, value: draft };
  } catch (_) {
    _cache = null;
  }
}

function clearFile(): void {
  try {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch (e: any) {
    // Best-effort — the next PUT will overwrite anyway. But ENOENT-after-exists
    // is the only expected race; anything else (EACCES, EBUSY) indicates a
    // genuine problem worth seeing.
    if (e?.code !== 'ENOENT') {
      console.warn('[drafts] clearFile failed:', e?.code || '', e?.message || String(e));
    }
  }
  _cache = null;
}

function registerDraftRoutes(app): void {
  app.get('/v1/drafts/current', (_req, res) => {
    res.json(read());
  });

  app.put('/v1/drafts/current', (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (text.length > MAX_LEN) {
      return res.status(413).json({ error: `text exceeds ${MAX_LEN} bytes` });
    }
    // Empty draft → drop the file rather than persist a zero-length entry.
    // Keeps GET → { text: '', updatedAt: 0 } consistent on a fresh slate.
    if (!text) {
      clearFile();
      return res.json({ ok: true, updatedAt: 0 });
    }
    const draft: DraftFile = { text, updatedAt: Date.now() };
    write(draft);
    res.json({ ok: true, updatedAt: draft.updatedAt });
  });

  app.delete('/v1/drafts/current', (_req, res) => {
    clearFile();
    res.json({ ok: true });
  });
}

module.exports = { registerDraftRoutes };
