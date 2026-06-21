// ── File-Categorizer admin / Inspector surface ────────────────────────────────
// Status, manual classification, force-rebuild, stuck-file machinery.
// All routes under /v1/config/file-categorizer/* land here.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../core/logger');

const { KEEP_NOTES_ROOT, TOPIC_SLUGS, TOPIC_SET } = require('./constants');
const {
  _parseFrontmatter,
  _isUncategorised,
  _readFrontmatterValue,
  _readCategorizerAttempts,
  _readCategorizerStatus,
  _writeAutoSkippedFrontmatter,
  _writeCategorizerFrontmatter,
} = require('./frontmatter');
const { _sanitiseStringList } = require('./llm');
const { _walkMd, _getNextBatch, _countPending, _countAbandoned } = require('./walk');
const runner = require('./runner');

interface FileCatDebugRow {
  path:             string;
  relPath:          string;
  attempts:         number;
  status:           string | null;
  skipReason:       string | null;
  bodyPreview:      string;
  state:            'pending' | 'abandoned';
}

function getFileCategorizerStatus(): {
  isRunning:               boolean;
  watchdogActive:          boolean;
  pendingCount:            number;
  /** Phase 5.2 — files marked auto-skipped after MAX_FILE_CATEGORIZE_ATTEMPTS
   *  failures, or user-skipped via /v1/config/file-categorizer/skip-stuck.
   *  They no longer block the queue but appear in the Inspector for review. */
  abandonedCount:          number;
  lastRunAt:               number | null;
  lastRunCategorizedCount: number;
  lifetimeCategorized:     number;
  validTopics:             ReadonlyArray<string>;
  enabled:                 boolean;
  gatedBy:                 string | null;
  root:                    string;
} {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.fileCategorizer ?? config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  const enabled = !!cfg?.enabled;
  let gatedBy: string | null = null;
  if (enabled && !runner._getIsRunning()) {
    try {
      const cc = require('../categorizer');
      if (typeof cc.isClear === 'function' && !cc.isClear()) gatedBy = 'session-categorizer';
    } catch (_) { /* not loaded */ }
  }
  return {
    isRunning:               runner._getIsRunning(),
    watchdogActive:          runner._getWatchdogActive(),
    pendingCount:            enabled ? _countPending(9_999) : 0,
    abandonedCount:          _countAbandoned(9_999),
    lastRunAt:               runner._getLastRunAt(),
    lastRunCategorizedCount: runner._getLastRunCategorizedCount(),
    lifetimeCategorized:     runner._getLifetimeCategorized(),
    validTopics:             TOPIC_SLUGS,
    enabled,
    gatedBy,
    root:                    KEEP_NOTES_ROOT,
  };
}

function runNow(): { kicked: boolean; reason?: string } {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.fileCategorizer ?? config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return { kicked: false, reason: 'disabled' };
  if (runner._getIsRunning()) return { kicked: false, reason: 'already-running' };
  try {
    const cc = require('../categorizer');
    if (typeof cc.isClear === 'function' && !cc.isClear()) return { kicked: false, reason: 'gated-by-session-categorizer' };
  } catch (_) { /* upstream unavailable */ }
  if (_getNextBatch(1).length === 0) return { kicked: false, reason: 'nothing-to-do' };
  void runner._startProcess();
  return { kicked: true };
}

// Force-rebuild — strip topics/tags/keywords/categorizedAt + the Phase 5.2
// stuck-state breadcrumbs from every file under KEEP_NOTES_ROOT so the
// worker re-classifies the entire corpus from scratch. Use-case: the user
// changed the topic allowlist or wants to re-run with a new model.
// Sensitivity / category lines are NOT touched (those carry user overrides).
function forceRebuild(): { reset: number; kicked: boolean } {
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return { reset: 0, kicked: false };
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);
  let reset = 0;
  for (const abs of all) {
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const parsed = _parseFrontmatter(content);
    if (!parsed.hasFm) continue;
    let fm = parsed.fm;
    let touched = false;
    const wipeKeys = [
      'topics', 'tags', 'keywords', 'categorizedAt',
      // Phase 5.2 — wipe stuck breadcrumbs so auto-skipped files re-enter
      // the queue alongside the normal pending pile.
      'categorizerStatus', 'categorizerAttempts', 'categorizerSkipReason',
    ];
    for (const key of wipeKeys) {
      const re = new RegExp(`^${key}\\s*:.*\\n?`, 'm');
      if (re.test(fm)) { fm = fm.replace(re, ''); touched = true; }
    }
    if (!touched) continue;
    const next = `---\n${fm.replace(/\n+$/, '')}\n---\n${parsed.body.replace(/^\n+/, '')}`;
    try { fs.writeFileSync(abs, next, 'utf8'); reset++; }
    catch (e) { logger.warn('file-categorizer.reset-failed', { path: abs, error: (e as Error).message }); }
  }
  logger.info('file-categorizer.force-rebuild', { reset });
  let kicked = false;
  if (reset > 0 && !runner._getIsRunning()) {
    try {
      const cc = require('../categorizer');
      if (typeof cc.isClear !== 'function' || cc.isClear()) { void runner._startProcess(); kicked = true; }
    } catch (_) {
      void runner._startProcess(); kicked = true;
    }
  }
  return { reset, kicked };
}

// ── Phase 5.2 — stuck-file machinery ─────────────────────────────────────────
// Generalised from auto-title.ts / context-categorizer.ts so users have the
// same Inspector + Skip-all-stuck + Force-retry + Manual-edit affordances
// for the file categorizer. Per user feedback 2026-05-07 ("automatic skip
// all stuck for categorizer and the sorter would make sense").

// Mark every currently-pending file as user-skipped. Bulk-skip path: writes
// empty topics/tags/keywords + `categorizerStatus: user-skipped` so the
// worker stops re-attempting. Optional `paths` filter targets specific files.
function skipStuck(paths?: ReadonlyArray<string>): { skipped: number; details: Array<{ path: string }> } {
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return { skipped: 0, details: [] };
  const targetSet = paths && paths.length > 0
    ? new Set(paths.map((p) => path.isAbsolute(p) ? p : path.join(KEEP_NOTES_ROOT, p)))
    : null;
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);
  const details: Array<{ path: string }> = [];
  for (const abs of all) {
    if (targetSet && !targetSet.has(abs)) continue;
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    // Without a filter: only skip pending (uncategorised) files. With a
    // filter: also skip already-skipped files (idempotent — user can re-skip
    // an auto-skipped file to update the reason if needed).
    if (!targetSet && !_isUncategorised(content)) continue;
    const status = _readCategorizerStatus(content);
    if (!targetSet && (status === 'user' || status === 'ai')) continue;
    const attempts = _readCategorizerAttempts(content) || 0;
    const next = _writeAutoSkippedFrontmatter(content, {
      attempts,
      reason:            'user-skipped',
      sensitivity:       _readFrontmatterValue(content, 'sensitivity') || 'public',
      sensitivitySource: _readFrontmatterValue(content, 'sensitivitySource') || 'auto',
    });
    // Override the `categorizerStatus` to user-skipped (the helper writes
    // `auto-skipped` by default — but a manually-skipped file deserves a
    // different reason).
    const finalContent = next.replace(/^categorizerStatus:.*$/m, 'categorizerStatus: user-skipped');
    try {
      fs.writeFileSync(abs, finalContent, 'utf8');
      details.push({ path: abs });
    } catch (e) {
      logger.warn('file-categorizer.skip-stuck-write-failed', {
        path: abs, error: (e as Error).message,
      });
    }
  }
  logger.info('file-categorizer.skip-stuck', { skipped: details.length, targeted: !!targetSet });
  return { skipped: details.length, details };
}

// Resets the stuck-state breadcrumbs on every previously auto-skipped /
// user-skipped file so they re-enter the queue.
function forceRetryAbandoned(): { reset: number; kicked: boolean } {
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return { reset: 0, kicked: false };
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);
  let reset = 0;
  for (const abs of all) {
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const status = _readCategorizerStatus(content);
    if (status !== 'auto-skipped' && status !== 'user-skipped') continue;
    const parsed = _parseFrontmatter(content);
    if (!parsed.hasFm) continue;
    let fm = parsed.fm;
    for (const key of [
      'topics', 'tags', 'keywords', 'categorizedAt',
      'categorizerStatus', 'categorizerAttempts', 'categorizerSkipReason',
    ]) {
      const re = new RegExp(`^${key}\\s*:.*\\n?`, 'm');
      if (re.test(fm)) fm = fm.replace(re, '');
    }
    const next = `---\n${fm.replace(/\n+$/, '')}\n---\n${parsed.body.replace(/^\n+/, '')}`;
    try { fs.writeFileSync(abs, next, 'utf8'); reset++; }
    catch (e) { logger.warn('file-categorizer.retry-write-failed', { path: abs, error: (e as Error).message }); }
  }
  logger.info('file-categorizer.force-retry-abandoned', { reset });
  let kicked = false;
  if (reset > 0 && !runner._getIsRunning()) {
    try {
      const cc = require('../categorizer');
      if (typeof cc.isClear !== 'function' || cc.isClear()) { void runner._startProcess(); kicked = true; }
    } catch (_) { void runner._startProcess(); kicked = true; }
  }
  return { reset, kicked };
}

// Apply a user-supplied classification to a single file. Used by the
// "Edit & commit" form in the Inspector for files where the model keeps
// failing or the user wants to set a specific value.
function applyManualCategory(
  filePath: string,
  payload:  { topics?: string[]; tags?: string[]; keywords?: string[] },
): { applied: boolean; reason?: string; path?: string } {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(KEEP_NOTES_ROOT, filePath);
  // Refuse paths outside the keep-notes root (defence against ../-traversal
  // through a malformed UI request).
  if (!abs.startsWith(KEEP_NOTES_ROOT + path.sep) && abs !== KEEP_NOTES_ROOT) {
    return { applied: false, reason: 'path-outside-keep-notes' };
  }
  if (!fs.existsSync(abs)) return { applied: false, reason: 'file-not-found' };
  let content: string;
  try { content = fs.readFileSync(abs, 'utf8'); }
  catch (e) { return { applied: false, reason: `read-failed: ${(e as Error).message}` }; }

  const topics   = _sanitiseStringList(payload.topics,   { allowed: TOPIC_SET, cap: 3 });
  const tags     = _sanitiseStringList(payload.tags,     { maxLen: 20, cap: 5 });
  const keywords = _sanitiseStringList(payload.keywords, { maxLen: 25, cap: 8 });
  if (topics.length === 0 && tags.length === 0 && keywords.length === 0) {
    return { applied: false, reason: 'all-lists-empty' };
  }

  const next = _writeCategorizerFrontmatter(content, {
    sensitivity:       _readFrontmatterValue(content, 'sensitivity') || 'public',
    sensitivitySource: _readFrontmatterValue(content, 'sensitivitySource') || 'auto',
    category:          _readFrontmatterValue(content, 'category') || 'keep-notes',
    topics, tags, keywords,
    source:            'user',
  });
  try {
    fs.writeFileSync(abs, next, 'utf8');
  } catch (e) {
    return { applied: false, reason: `write-failed: ${(e as Error).message}` };
  }
  logger.info('file-categorizer.manual-applied', {
    path: path.relative(path.resolve(__dirname, '..', '..', '..', '..'), abs),
    topics, tags, keywords,
  });
  return { applied: true, path: path.relative(path.resolve(__dirname, '..', '..', '..', '..'), abs) };
}

// Returns up to 50 most-stuck rows for the Inspector. Auto-skipped first,
// then pending (with attempt counters). Walks the entire keep-notes corpus
// so it's bounded by disk speed — fine because the route is hit on demand,
// not in the polling loop.
function getDebugInfo(): { rows: FileCatDebugRow[]; pending: number; abandoned: number } {
  const rows: FileCatDebugRow[] = [];
  let pending = 0, abandoned = 0;
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return { rows, pending, abandoned };
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);

  for (const abs of all) {
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const status   = _readCategorizerStatus(content);
    const attempts = _readCategorizerAttempts(content);
    const skipReason = _readFrontmatterValue(content, 'categorizerSkipReason');
    const isAbandoned = status === 'auto-skipped' || status === 'user-skipped';
    const isPending   = !isAbandoned && _isUncategorised(content);
    if (!isAbandoned && !isPending) continue;
    if (isPending && attempts === 0) continue;            // never-attempted-yet — not "stuck", just pending
    const parsed = _parseFrontmatter(content);
    const bodyPreview = parsed.body.trim().slice(0, 220).replace(/\s+/g, ' ');
    rows.push({
      path:        abs,
      relPath:     path.relative(path.resolve(__dirname, '..', '..', '..', '..'), abs),
      attempts,
      status,
      skipReason,
      bodyPreview,
      state:       isAbandoned ? 'abandoned' : 'pending',
    });
    if (isAbandoned) abandoned++; else pending++;
  }
  rows.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'abandoned' ? -1 : 1;
    return b.attempts - a.attempts;
  });
  return { rows: rows.slice(0, 50), pending, abandoned };
}

module.exports = {
  getFileCategorizerStatus,
  runNow,
  forceRebuild,
  skipStuck,
  forceRetryAbandoned,
  applyManualCategory,
  getDebugInfo,
};
