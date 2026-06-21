// ── Content extraction + deterministic helpers ───────────────────────────────
// Pure functions reading session content. No state, no module-level side
// effects — safe to require from llm.ts, runner.ts, admin.ts.
'use strict';

// ── Local types ───────────────────────────────────────────────────────────────
type Msg = { role: string; text?: string; content?: unknown; blocks?: Array<{ type: string; content?: string; name?: string; detail?: string }> };

// Claude Code wraps user input with IDE / system metadata wrappers
// (`<ide_selection>…`, `<system-reminder>…`, `<command-name>…`, etc.) that
// dominate the first 400 chars of a session and starve the LLM of real
// signal. Strip them before excerpt-cropping. The `<persisted-output>`
// marker likewise leaks in via tool-result `detail` fields and is just
// "output too large, see file" boilerplate. Bucket analysis 2026-05-10
// found this caused the categorizer to time out on otherwise normal sessions.
const _METADATA_TAGS = [
  'ide_selection', 'ide_opened_file', 'system-reminder',
  'command-name', 'command-message', 'task-notification', 'persisted-output',
  'environment_details', 'user-prompt-submit-hook',
];
const _STRIP_RX = new RegExp(
  `<(?:${_METADATA_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?</(?:${_METADATA_TAGS.join('|')})>`,
  'gi',
);
const _STRIP_OPEN_RX = new RegExp(
  `<(?:${_METADATA_TAGS.join('|')})\\b[^>]*/?>`,
  'gi',
);
function _stripWrappers(text: string): string {
  return text.replace(_STRIP_RX, ' ').replace(_STRIP_OPEN_RX, ' ').replace(/\s+/g, ' ').trim();
}

// ── Content extraction ────────────────────────────────────────────────────────
// Categorization needs much less context than titling — first 200 chars of
// concatenated user/assistant turns is enough for the slug-classifier.
//
// Tool-call NAMES (e.g. `Bash`, `Edit`, `WebFetch`) carry strong category
// signal even when the surrounding text is empty. We append them as a
// compact `[tools: Bash, Edit, …]` suffix so the model sees what kind of
// work the session actually did.

function _extractExcerpt(s: any, maxLen: number = 200): string {
  const parts: string[] = [];
  const toolNames = new Set<string>();
  for (const msg of s.messages || []) {
    if (msg.role === 'note') continue;
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    let text: string = msg.text || '';
    if (!text && Array.isArray(msg.blocks)) {
      text = msg.blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.content || '')
        .join(' ');
    }
    if (Array.isArray(msg.blocks)) {
      for (const b of msg.blocks) {
        if ((b.type === 'tool-call' || b.type === 'tool_use') && typeof b.name === 'string' && b.name) {
          toolNames.add(b.name);
        }
      }
    }
    const stripped = _stripWrappers(text);
    if (stripped) parts.push(`${role}: ${stripped}`);
  }
  let full = parts.join('\n');
  if (toolNames.size > 0) full += `\n[tools: ${[...toolNames].slice(0, 8).join(', ')}]`;
  return full.length <= maxLen ? full : full.slice(0, maxLen);
}

// Best-effort: use s.workingDir or s.cwd; otherwise fall back to empty.
function _extractWorkingDir(s: any): string {
  return (s.workingDir || s.cwd || s._cwd || '') + '';
}

// Extract the full text used for sensitivity-detection. We give the detector
// a larger window than the categorizer because credentials/PII often hide
// deep in code blocks.
function _extractFullForSensitivity(s: any, maxLen: number = 8_000): string {
  const parts: string[] = [];
  for (const msg of s.messages || []) {
    if (msg.role === 'note') continue;
    let text: string = msg.text || '';
    if (!text && Array.isArray(msg.blocks)) {
      text = msg.blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.content || '')
        .join(' ');
    }
    // Sensitivity scanning *should* see the wrappers stripped — credentials
    // hidden inside a `<system-reminder>` are still credentials, but the
    // wrapper itself doesn't help. Wrappers are a tiny fraction of overall
    // bytes so the cap is unaffected.
    const stripped = _stripWrappers(text);
    if (stripped) parts.push(stripped);
  }
  const full = parts.join('\n');
  return full.length <= maxLen ? full : full.slice(0, maxLen);
}

// ── Deterministic notes-category shortcut ─────────────────────────────────────
// Phase 1.10 — the user wants every session that contains either a
// `role === 'note'` message (added via the inline `#note <text>` parser) or
// a user-typed `#note` hashtag in any user message to be categorised as
// `notes` *without* burning a model call. Run before `_classify` in the loop;
// returns the synthesized result or null when the heuristic doesn't match.
//
// Tags:
//   • Always include the literal `note` tag so the picker can filter on it.
//   • Append up to 4 distinct word-tokens from the FIRST inline note's text
//     (or the title when no inline note exists), respecting the same stop-words
//     as `_deriveTags` so the Obsidian frontmatter stays readable.
const HASH_NOTE_RX = /(^|\s)#note(?:\s|$|[:.,;])/i;

function _classifyNotesShortcut(s: any): { category: 'notes'; tags: string[] } | null {
  const messages = (s.messages || []) as Msg[];
  // Path 1: at least one literal `role === 'note'` message.
  const inlineNote = messages.find((m) => m?.role === 'note');
  // Path 2: a user message containing a `#note` hashtag (legacy capture for
  // sessions where the inline parser didn't run — e.g. imports). Only the
  // user side is checked: assistant text discussing `#note ...` shouldn't
  // forcibly recategorise the session.
  let hashtagHit = '';
  if (!inlineNote) {
    for (const m of messages) {
      if (m?.role !== 'user') continue;
      let t: string = m.text || '';
      if (!t && Array.isArray(m.blocks)) {
        t = m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
      }
      if (HASH_NOTE_RX.test(t)) { hashtagHit = t; break; }
    }
    if (!hashtagHit) return null;
  }

  // Build tags. Source text: inline note body if present, else the user
  // message containing the hashtag, else the session title.
  let source = '';
  if (inlineNote) {
    let t: string = inlineNote.text || '';
    if (!t && Array.isArray(inlineNote.blocks)) {
      t = inlineNote.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
    }
    source = t;
  } else {
    source = hashtagHit;
  }
  const baseTags = _deriveTags(source || (s.name || ''), '');
  const tags = ['note', ...baseTags.filter((t) => t !== 'note').slice(0, 4)];
  return { category: 'notes', tags };
}

// Cheap tag derivation — splits the title on word boundaries, dedupes,
// filters stop-words. Good enough as a starting point; refined later.
function _deriveTags(title: string, cwd: string): string[] {
  const STOP = new Set([
    'the','a','an','and','or','of','to','in','for','with','on','at','by',
    'from','is','are','was','were','be','been','being','it','this','that',
    'as','into','about','via','vs','just','some','any','all','no','not',
  ]);
  const tokens = `${title} ${cwd}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of tokens) {
    if (t.length < 3 || t.length > 20) continue;
    if (STOP.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
    if (tags.length >= 5) break; // cap — keeps Obsidian frontmatter readable
  }
  return tags;
}

module.exports = {
  _extractExcerpt,
  _extractWorkingDir,
  _extractFullForSensitivity,
  _classifyNotesShortcut,
  _deriveTags,
};
