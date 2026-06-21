// ── File-Categorizer frontmatter helpers ──────────────────────────────────────
// Idempotent splice-style updates so we never duplicate keys, never
// clobber a user-set `sensitivity:` (their override wins), and never
// fight the LINK sync if the file is also being edited from Obsidian.
'use strict';

const { MAX_BODY_CHARS } = require('./constants');

interface ParsedFm {
  hasFm: boolean;
  fm:    string;       // raw YAML body between `---\n` and `\n---`, no markers
  body:  string;       // everything after the closing `---`
}

function _parseFrontmatter(content: string): ParsedFm {
  if (!content.startsWith('---\n')) {
    return { hasFm: false, fm: '', body: content };
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { hasFm: false, fm: '', body: content };
  const fm   = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\n/, '');
  return { hasFm: true, fm, body };
}

function _hasField(fm: string, key: string): boolean {
  const re = new RegExp(`^${key}\\s*:`, 'm');
  return re.test(fm);
}

function _yamlString(v: string): string {
  if (!v) return '""';
  if (/^[A-Za-z0-9_\-/. ]+$/.test(v) && !/^[-?:]/.test(v)) return v;
  return JSON.stringify(v);
}

function _yamlList(items: ReadonlyArray<string>): string {
  return '[' + items.map((it) => _yamlString(it)).join(', ') + ']';
}

// Phase 5.2 — read the persisted attempt counter / status / skip reason so
// the Inspector and the auto-promote logic can both reason about per-file
// stuck-state without a side-channel state file. Frontmatter IS the state.

function _readFrontmatterValue(content: string, key: string): string | null {
  const parsed = _parseFrontmatter(content);
  if (!parsed.hasFm) return null;
  const re = new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, 'm');
  const m  = parsed.fm.match(re);
  if (!m) return null;
  // Strip surrounding quotes if YAML-quoted.
  let v = m[1];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function _readCategorizerAttempts(content: string): number {
  const v = _readFrontmatterValue(content, 'categorizerAttempts');
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function _readCategorizerStatus(content: string): string | null {
  return _readFrontmatterValue(content, 'categorizerStatus');
}

// Splice ONLY the failure-counter fields. Used during partial failures so the
// next watchdog tick knows it's attempt N+1 (rather than re-starting from 0).
// Does NOT write topics/keywords — those are still missing, so
// `_isUncategorised` keeps returning true and the file stays in the queue.
function _writeAttemptCounter(
  content: string,
  fields:  { attempts: number; reason: string },
): string {
  const parsed = _parseFrontmatter(content);
  let fm = parsed.hasFm ? parsed.fm : '';
  function setOwned(key: string, value: string): void {
    const re = new RegExp(`^${key}\\s*:.*$`, 'm');
    const line = `${key}: ${value}`;
    if (re.test(fm)) fm = fm.replace(re, line);
    else { if (fm && !fm.endsWith('\n')) fm += '\n'; fm += line; }
  }
  setOwned('categorizerAttempts',   String(fields.attempts));
  setOwned('categorizerSkipReason', _yamlString(fields.reason));
  return `---\n${fm}\n---\n${parsed.body.replace(/^\n+/, '')}`;
}

// Splice the auto-skipped marker — empty topics/tags/keywords (so the
// eligibility check stops returning the file) plus a `categorizerStatus:
// auto-skipped` breadcrumb the Inspector reads to show "auto-skipped after 3
// retries — last error: rate-limited".
function _writeAutoSkippedFrontmatter(
  content: string,
  fields:  { attempts: number; reason: string; sensitivity: string; sensitivitySource: string },
): string {
  const parsed = _parseFrontmatter(content);
  let fm = parsed.hasFm ? parsed.fm : '';
  function ensure(key: string, value: string): void {
    if (_hasField(fm, key)) return;
    if (fm && !fm.endsWith('\n')) fm += '\n';
    fm += `${key}: ${value}`;
  }
  function setOwned(key: string, value: string): void {
    const re = new RegExp(`^${key}\\s*:.*$`, 'm');
    const line = `${key}: ${value}`;
    if (re.test(fm)) fm = fm.replace(re, line);
    else { if (fm && !fm.endsWith('\n')) fm += '\n'; fm += line; }
  }
  ensure('sensitivity',        fields.sensitivity);
  ensure('sensitivitySource',  fields.sensitivitySource);
  ensure('category',           'keep-notes');
  setOwned('topics',           _yamlList([]));
  setOwned('tags',             _yamlList([]));
  setOwned('keywords',         _yamlList([]));
  setOwned('categorizedAt',    _yamlString(new Date().toISOString()));
  setOwned('categorizerStatus','auto-skipped');
  setOwned('categorizerSkipReason', _yamlString(fields.reason));
  setOwned('categorizerAttempts',   String(fields.attempts));
  return `---\n${fm}\n---\n${parsed.body.replace(/^\n+/, '')}`;
}

// Splice the categorizer-output fields into the frontmatter (creating it if
// absent). We never overwrite an existing `sensitivity:` line — user-set tier
// always wins. Same for `category:` (the import-step locked it to
// `keep-notes`; the user might have manually moved a file to a different cat).
function _writeCategorizerFrontmatter(
  content: string,
  fields: {
    sensitivity:        string;
    sensitivitySource:  string;
    category:           string;
    topics:             string[];
    tags:               string[];
    keywords:           string[];
    /** Optional — when present, marks the source as `user` (manual edit) so
     *  the Inspector can distinguish AI-classified vs user-classified files.
     *  Phase 5.2. */
    source?:            'ai' | 'user';
  },
): string {
  const parsed = _parseFrontmatter(content);
  let fm = parsed.fm;

  // Helper: append a key only if missing.
  function ensure(key: string, value: string): void {
    if (_hasField(fm, key)) return;
    if (fm && !fm.endsWith('\n')) fm += '\n';
    fm += `${key}: ${value}`;
  }
  // Helper: replace-or-append a key. Used for fields the categorizer OWNS
  // (topics, tags, keywords, categorizedAt) — even on a re-run we want the
  // freshest LLM output rather than the historical value. `sensitivity` /
  // `category` / `sensitivitySource` use `ensure()` so user overrides survive.
  function setOwned(key: string, value: string): void {
    const re = new RegExp(`^${key}\\s*:.*$`, 'm');
    const line = `${key}: ${value}`;
    if (re.test(fm)) {
      fm = fm.replace(re, line);
    } else {
      if (fm && !fm.endsWith('\n')) fm += '\n';
      fm += line;
    }
  }

  // Helper: drop a key entirely (used to clean up stuck-state breadcrumbs
  // once a successful classification supersedes the previous failure).
  function dropKey(key: string): void {
    const re = new RegExp(`^${key}\\s*:.*\\n?`, 'm');
    if (re.test(fm)) fm = fm.replace(re, '');
  }

  ensure('sensitivity',        fields.sensitivity);
  ensure('sensitivitySource',  fields.sensitivitySource);
  ensure('category',           _yamlString(fields.category));
  setOwned('topics',           _yamlList(fields.topics));
  setOwned('tags',             _yamlList(fields.tags));
  setOwned('keywords',         _yamlList(fields.keywords));
  setOwned('categorizedAt',    _yamlString(new Date().toISOString()));
  // Phase 5.2 — record source (`ai` default, `user` when caller passes it
  // through from the manual-edit form) so the Inspector can show "user-
  // classified" rows distinctly from the auto-classified bulk.
  setOwned('categorizerStatus', _yamlString(fields.source ?? 'ai'));
  // Successful classification supersedes any previous failure breadcrumbs.
  dropKey('categorizerAttempts');
  dropKey('categorizerSkipReason');

  return `---\n${fm.replace(/\n+$/, '')}\n---\n${parsed.body.replace(/^\n+/, '')}`;
}

// ── Eligibility ───────────────────────────────────────────────────────────────
// A file is "uncategorised" when its frontmatter has no `topics:` line.
// `keywords:` is also a marker for completeness (a partial run that wrote
// topics but failed before keywords would still re-fire).

function _isUncategorised(content: string): boolean {
  const parsed = _parseFrontmatter(content);
  if (!parsed.hasFm) return true;
  if (!_hasField(parsed.fm, 'topics'))   return true;
  if (!_hasField(parsed.fm, 'keywords')) return true;
  return false;
}

// ── Body extraction (LLM input) ───────────────────────────────────────────────
// Strip frontmatter, collapse runs of whitespace, cap to MAX_BODY_CHARS.

function _extractBodyForLlm(content: string): string {
  const parsed = _parseFrontmatter(content);
  let body = parsed.body.trim();
  body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  if (body.length <= MAX_BODY_CHARS) return body;
  // Keep head + tail — middle of a long note is usually the least decisive.
  const head = body.slice(0, Math.floor(MAX_BODY_CHARS * 0.7));
  const tail = body.slice(-Math.floor(MAX_BODY_CHARS * 0.25));
  return `${head}\n[…]\n${tail}`;
}

module.exports = {
  _parseFrontmatter,
  _hasField,
  _yamlString,
  _yamlList,
  _readFrontmatterValue,
  _readCategorizerAttempts,
  _readCategorizerStatus,
  _writeAttemptCounter,
  _writeAutoSkippedFrontmatter,
  _writeCategorizerFrontmatter,
  _isUncategorised,
  _extractBodyForLlm,
};
