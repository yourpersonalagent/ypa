// HubGeneratorTab — pipeline-status dashboard for the ContextGenerator.
// Phase 1b / Adaption 2 (Hub) — exposes the engines that power Phase 1a
// and previews the Phase 2/3 stages with disabled state.
//
// Pulls from two existing endpoints (no new ones added in this tab):
//   • GET /v1/config/auto-title/status   → TitleGenerator stage
//   • GET /v1/config/context/status      → Categorizer stage + whitelist size
//                                          + bridge mode + sensitivity policy
//
// Polls every 5 s while the tab is mounted. The dashboard is read-only —
// triggers are deliberately limited to "rescan now" (kicks the watchdog
// without waiting for the 3-min tick); destructive actions live in
// HubSettingsTab.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAppStore, getSessionState } from '../stores/index.js';
import { useMcpRunning } from '../stores/mcpStore.js';
import { bus } from '../state.js';
import { buildSynthesisPrompt } from '../panels/knowledgePrompt.js';
import { seedSkillCommand } from '../chat/seedCommand.js';

interface AutoTitleStatus {
  isRunning?:          boolean;
  watchdogActive?:     boolean;
  pendingCount?:       number;
  /** Sessions promoted to `_nameSource = 'fallback'` after MAX_TITLE_ATTEMPTS
   *  consecutive failures. They no longer block the gate but appear here so
   *  the user can choose to retry or accept the fallback name. Added 2026-05-06. */
  abandonedCount?:     number;
  lastRunAt?:          number | null;
  lastRunTitledCount?: number;
  lifetimeTitled?:     number;
  enabled?:            boolean;
}

/** One row in the /v1/config/auto-title/debug response. Mirrors the backend
 *  `DebugRow` interface in bridge/auto-title.ts. */
interface AutoTitleDebugRow {
  sid:               string;
  name:              string;
  nameSource:        string | null;
  attempts:          number;
  skipReason:        string | null;
  skippedAt:         number | null;
  messageCount:      number;
  userPreview:       string;
  assistantPreview:  string;
  state:             'pending' | 'abandoned';
}

interface SorterStatus {
  isRunning?:            boolean;
  watchdogActive?:       boolean;
  pendingCount?:         number;
  /** Phase 5.3 — sessions auto-skipped after MAX_SORT_ATTEMPTS write
   *  failures or user-skipped via /skip-stuck. */
  abandonedCount?:       number;
  lastRunAt?:            number | null;
  lastRunFilesWritten?:  number;
  lifetimeFilesWritten?: number;
  docsRoot?:             string;
  enabled?:              boolean;
  /** When non-null, the worker is gated behind an upstream stage. */
  gatedBy?:              string | null;
}

/** One row in /v1/config/categorizer/debug. Phase 5.1. */
interface CategorizerDebugRow {
  sid:               string;
  name:              string;
  category:          string | null;
  categorySource:    string | null;
  attempts:          number;
  skipReason:        string | null;
  skippedAt:         number | null;
  messageCount:      number;
  userPreview:       string;
  assistantPreview:  string;
  state:             'pending' | 'abandoned';
}

/** One row in /v1/config/file-categorizer/debug. Phase 5.2. */
interface FileCategorizerDebugRow {
  path:        string;
  relPath:     string;
  attempts:    number;
  status:      string | null;
  skipReason:  string | null;
  bodyPreview: string;
  state:       'pending' | 'abandoned';
}

/** /v1/config/file-categorizer/status. Phase 4.1 + 5.2. */
interface FileCategorizerStatus {
  isRunning?:               boolean;
  watchdogActive?:          boolean;
  pendingCount?:            number;
  abandonedCount?:          number;
  lastRunAt?:               number | null;
  lastRunCategorizedCount?: number;
  lifetimeCategorized?:     number;
  validTopics?:             string[];
  enabled?:                 boolean;
  gatedBy?:                 string | null;
  root?:                    string;
}

/** One row in /v1/config/sorter/debug. Phase 5.3. */
interface SorterDebugRow {
  sid:        string;
  name:       string;
  category:   string | null;
  attempts:   number;
  skipReason: string | null;
  skippedAt:  number | null;
  wikiPath:   string | null;
  state:      'pending' | 'abandoned';
}

interface LinkRunStats {
  pushed?:       number;
  pulled?:       number;
  conflicts?:    number;
  errors?:       Array<{ path: string; error: string }>;
  filesScanned?: number;
}

interface LinkStatus {
  enabled?:           boolean;
  isRunning?:         boolean;
  watchdogActive?:    boolean;
  adapterKind?:       string;
  adapterReachable?:  boolean;
  adapterError?:      string | null;
  adapterCheckedAt?:  number;
  lastRunAt?:         number | null;
  lastRunStats?:      LinkRunStats;
  lifetimePushed?:    number;
  lifetimePulled?:    number;
  lifetimeConflicts?: number;
  syncDirs?:          Record<string, string>;
  conflictPolicies?:  Record<string, string>;
  apiKeyMasked?:      string;
  vaultRoot?:         string;
  syncIntervalMs?:    number;
  syncSensitivity?:   { public?: boolean; private?: boolean; system?: boolean };
}

/** /v1/knowledge/status?workingDir=<cwd>. Per-cwd state of the
 *  graphify_build.py output dir (`bridge/knowledge/dirs/<slug>/graph/`)
 *  and the LLM-authored synthesis pages (`…/synthesis/`).
 *  Same endpoint KnowledgeButtons polls — Hub piggy-backs at the 5 s tick
 *  instead of the action-button surface's 15 s tick so the dashboard feels
 *  live while the user has it open. */
interface KnowledgeStatus {
  graphExists: boolean;
  synthCount:  number;
}

/** /v1/context-rag/status. Surfaced on the Generator-tab as a 5th stage card
 *  so RAG ingest is visible alongside title/categorizer/sorter/LINK — the
 *  full management UI (DB list, migrate, probe entitlements, …) still lives
 *  in the 🧬 RAG tab. */
interface RagStatus {
  enabled?:              boolean;
  hasDbs?:               boolean;
  running?:              boolean;
  watchdog?:             boolean;
  queue?:                { total?: number; byKind?: Record<string, number> };
  lastRunAt?:            number | null;
  lastRunIngestedCount?: number;
  lifetimeIngested?:     number;
  lastError?:            string | null;
}

interface CategorizerStatus {
  isRunning?:               boolean;
  watchdogActive?:          boolean;
  pendingCount?:            number;
  /** Phase 5.1 — sessions auto-skipped or user-skipped after
   *  MAX_CATEGORIZE_ATTEMPTS failures. They no longer block the gate but
   *  appear in the Inspector for review. */
  abandonedCount?:          number;
  lastRunAt?:               number | null;
  lastRunCategorizedCount?: number;
  lifetimeCategorized?:     number;
  validCategories?:         string[];
  whitelistSize?:           number;
  whitelistTtlMs?:          number;
  bridgeMode?:              string;
  sensitivityPolicy?:       string;
  sorter?:                  SorterStatus | null;
  enabled?:                 boolean;
  /** When non-null, the worker is gated behind an upstream stage. */
  gatedBy?:                 string | null;
}

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

function _formatWhen(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000)        return `${Math.round(diffMs / 1_000)} s ago`;
  if (diffMs < 60 * 60_000)   return `${Math.round(diffMs / 60_000)} min ago`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.round(diffMs / (60 * 60_000))} h ago`;
  const d = new Date(ts);
  return d.toLocaleString();
}

interface StageAction {
  /** Button label. */
  label:    string;
  /** Click handler — typically calls a Run-now / Force-rebuild endpoint. */
  onClick:  () => void | Promise<void>;
  /** When true, the button uses the destructive (red-ish) variant. */
  danger?:  boolean;
  /** When set, renders this on the button as a tooltip / aria-label. */
  title?:   string;
  /** When true, the button is disabled (worker already running, no work to do, …). */
  disabled?: boolean;
}

interface StageProps {
  emoji:       string;
  name:        string;
  enabled:     boolean;
  running?:    boolean;
  pending?:    number;
  lastRunAt?:  number | null;
  lastCount?:  number;
  lifetime?:   number;
  hint?:       string;
  /** When non-null, the stage is idle but gated behind the named upstream
   *  stage (`'titler'` | `'categorizer'`). The card renders
   *  "● waiting for X" instead of "● idle". */
  gatedBy?:    string | null;
  /** Per-stage action buttons (Run now, Force rebuild, Force retry, …).
   *  Rendered in a row at the bottom of the card. Empty/omitted = no buttons. */
  actions?:    StageAction[];
  /** Optional warning row, e.g. "5 sessions abandoned". Rendered above actions. */
  warning?:    string;
}

function StageCard(p: StageProps) {
  // Pipeline-gate state takes precedence over plain idle/pending — when an
  // upstream stage has work, the user wants to see the chain explicitly.
  const isGated   = !!p.gatedBy && !p.running;
  const isPending = !isGated && (p.pending ?? 0) > 0;
  const stateLabel = !p.enabled
    ? 'disabled'
    : p.running
      ? 'running…'
      : isGated
        ? `waiting for ${p.gatedBy}`
        : isPending
          ? `${p.pending} pending`
          : 'idle';
  const stateColor = !p.enabled
    ? '#888'
    : p.running
      ? '#4a8'
      : isGated
        ? '#88a'      // muted blue — "queued behind upstream"
        : isPending
          ? '#d90'    // amber — has work, ready to run
          : '#5c5';   // green — fully clear
  return (
    <div
      style={{
        border:        '1px solid var(--border, #2a2a2a)',
        borderRadius:  6,
        padding:       '10px 12px',
        background:    'var(--bg-soft, #1f1f1f)',
        display:       'flex',
        flexDirection: 'column',
        gap:           4,
        opacity:       p.enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden="true">{p.emoji}</span>
        <strong>{p.name}</strong>
        <span style={{ marginLeft: 'auto', color: stateColor, fontSize: '12px' }}>
          ● {stateLabel}
        </span>
      </div>
      {p.enabled && (
        <div style={{ display: 'flex', gap: 14, fontSize: '11.5px', color: 'var(--fg-mute, #aaa)', flexWrap: 'wrap' }}>
          <span>Last run: {_formatWhen(p.lastRunAt)}</span>
          {typeof p.lastCount === 'number' && <span>Last batch: {p.lastCount}</span>}
          {typeof p.lifetime === 'number' && <span>Lifetime: {p.lifetime}</span>}
        </div>
      )}
      {p.hint && (
        <div style={{ fontSize: '11px', color: 'var(--fg-mute, #888)', marginTop: 2 }}>
          {p.hint}
        </div>
      )}
      {p.warning && (
        <div style={{
          fontSize: '11.5px', color: '#e88', marginTop: 4,
          padding: '4px 6px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.10)',
        }}>
          ⚠ {p.warning}
        </div>
      )}
      {p.actions && p.actions.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {p.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={() => { void a.onClick(); }}
              disabled={a.disabled}
              title={a.title}
              className={a.danger ? 'prefs-btn-danger' : 'prefs-btn'}
              style={{ padding: '4px 10px', fontSize: '11.5px' }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inspect panel ────────────────────────────────────────────────────────────
// Rendered inline below the TitleGenerator card when the user clicks
// "Inspect". Shows the most-stuck sessions (abandoned first, then
// highest-attempts) with content previews + skip reason + per-row "Skip"
// button. Lets the user diagnose *why* sessions got stuck without grepping
// pm2 logs.

function _formatSkipReason(r: string | null): string {
  if (!r) return '—';
  if (r.startsWith('junk:'))         return `auto-skipped: ${r.slice(5).replace(/-/g, ' ')}`;
  if (r === 'user-skipped')          return 'user-skipped';
  if (r.startsWith('model-refused:'))return `model refused: ${r.slice(14).replace(/-/g, ' ')}`;
  if (r === 'request-timeout')       return 'request timed out';
  if (r === 'request-error')         return 'request errored';
  if (r === 'too-short')              return 'model output too short';
  if (r === 'too-long')               return 'model output too long';
  if (r === 'empty-response')         return 'model returned nothing';
  if (r === 'invalid-title')          return 'model output invalid';
  // Phase 5 — categorizer / file-categorizer / sorter reason codes.
  if (r === 'rate-limited')           return 'rate-limited (429)';
  if (r.startsWith('http-'))          return `HTTP error ${r.slice(5)}`;
  if (r === 'invalid-category-slug')  return 'model returned invalid category slug';
  if (r === 'invalid-response')       return 'model output invalid';
  if (r === 'invalid-json')           return 'model output not valid JSON';
  if (r === 'all-lists-empty')        return 'model returned no topics/tags/keywords';
  return r;
}

function InspectRow(p: {
  row:        AutoTitleDebugRow;
  busy:       boolean;
  onSkipOne:  (sid: string) => void | Promise<void>;
}) {
  const stateColor = p.row.state === 'abandoned' ? '#e88' : '#d90';
  return (
    <li style={{
      borderTop: '1px solid var(--border, #2a2a2a)',
      padding:   '8px 10px',
      display:   'flex',
      flexDirection: 'column',
      gap:       4,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: stateColor, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
          {p.row.state}
        </span>
        <strong style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.row.name || '(no name)'}
        </strong>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          {p.row.attempts > 0 ? `${p.row.attempts} attempt${p.row.attempts === 1 ? '' : 's'} · ` : ''}
          {p.row.messageCount} msg
        </span>
        <button
          type="button"
          onClick={() => { void p.onSkipOne(p.row.sid); }}
          disabled={p.busy || p.row.state === 'abandoned'}
          className="prefs-btn"
          style={{ padding: '2px 8px', fontSize: 11 }}
          title={p.row.state === 'abandoned'
            ? 'Already abandoned — use Force-retry-abandoned to put it back in the queue.'
            : 'Mark this session as fallback with a synthesized title.'}
        >
          Skip
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute, #aaa)' }}>
        Reason: {_formatSkipReason(p.row.skipReason)} · ID: <code style={{ fontSize: 10.5 }}>{p.row.sid}</code>
      </div>
      {p.row.userPreview && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #bbb)' }}>
          <strong style={{ color: 'var(--fg-mute, #888)' }}>U:</strong> {p.row.userPreview}
        </div>
      )}
      {p.row.assistantPreview && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #bbb)' }}>
          <strong style={{ color: 'var(--fg-mute, #888)' }}>A:</strong> {p.row.assistantPreview}
        </div>
      )}
    </li>
  );
}

function InspectPanel(p: {
  rows:      AutoTitleDebugRow[] | null;
  busy:      boolean;
  error:     string | null;
  onRefresh: () => void | Promise<void>;
  onSkipOne: (sid: string) => void | Promise<void>;
}) {
  return (
    <div style={{
      border:       '1px solid var(--border, #2a2a2a)',
      borderRadius: 6,
      background:   'var(--bg-soft, #1a1a1a)',
    }}>
      <div style={{
        padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border, #2a2a2a)',
      }}>
        <strong style={{ fontSize: 12.5 }}>Stuck sessions</strong>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          {p.rows ? `${p.rows.length} shown (capped at 50)` : 'loading…'}
        </span>
        <button
          type="button"
          onClick={() => { void p.onRefresh(); }}
          disabled={p.busy}
          className="prefs-btn"
          style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: 11 }}
        >
          {p.busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {p.error && (
        <div style={{ padding: '8px 10px', color: '#e88', fontSize: 12 }}>
          {p.error}
        </div>
      )}
      {p.rows && p.rows.length === 0 && !p.busy && (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--fg-mute, #888)' }}>
          Nothing stuck. Pipeline is clear.
        </div>
      )}
      {p.rows && p.rows.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {p.rows.map((row) => (
            <InspectRow key={row.sid} row={row} busy={p.busy} onSkipOne={p.onSkipOne} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Phase 5 — Categorizer / File-Categorizer / Sorter Inspect panels ─────────
// Generalisation of the AutoTitle InspectPanel pattern across the three
// downstream workers. The categorizer + file-categorizer panels also support
// inline Manual-edit mode where the user picks a category/topics + tags +
// keywords and commits — bypassing the model when it keeps failing.

// Shared shell — common chrome (header, refresh, empty/error states).
function InspectShell(p: {
  title:    string;
  count:    number;
  loading:  boolean;
  error:    string | null;
  empty?:   string;
  onRefresh: () => void | Promise<void>;
  busy:     boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      border:       '1px solid var(--border, #2a2a2a)',
      borderRadius: 6,
      background:   'var(--bg-soft, #1a1a1a)',
    }}>
      <div style={{
        padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border, #2a2a2a)',
      }}>
        <strong style={{ fontSize: 12.5 }}>{p.title}</strong>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          {p.loading ? 'loading…' : `${p.count} shown (capped at 50)`}
        </span>
        <button
          type="button"
          onClick={() => { void p.onRefresh(); }}
          disabled={p.busy}
          className="prefs-btn"
          style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: 11 }}
        >
          {p.busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {p.error && (
        <div style={{ padding: '8px 10px', color: '#e88', fontSize: 12 }}>
          {p.error}
        </div>
      )}
      {p.count === 0 && !p.loading && !p.error && (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--fg-mute, #888)' }}>
          {p.empty || 'Nothing stuck. Pipeline is clear.'}
        </div>
      )}
      {p.count > 0 && p.children}
    </div>
  );
}

// Tag-list input — comma-separated kebab-case strings. Used by both the
// categorizer's tag/keyword inputs and the file-categorizer's identical fields.
function TagListInput(p: {
  label:    string;
  value:    string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
      <span style={{ color: 'var(--fg-mute, #888)' }}>{p.label}</span>
      <input
        type="text"
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        placeholder={p.placeholder}
        className="prefs-input"
        style={{ fontSize: 12, padding: '3px 6px' }}
      />
    </label>
  );
}

// ─── Categorizer Inspector ────────────────────────────────────────────────────
function CategorizerInspectRow(p: {
  row:           CategorizerDebugRow;
  validCats:     string[];
  busy:          boolean;
  onSkipOne:     (sid: string) => void | Promise<void>;
  onApplyManual: (sid: string, payload: { category: string; tags: string[]; keywords: string[] }) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [cat,     setCat]     = useState(p.row.category || 'general');
  const [tags,    setTags]    = useState('');
  const [kw,      setKw]      = useState('');
  const stateColor = p.row.state === 'abandoned' ? '#e88' : '#d90';
  const _split = (s: string): string[] =>
    s.split(',').map((x) => x.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')).filter(Boolean);
  return (
    <li style={{
      borderTop: '1px solid var(--border, #2a2a2a)',
      padding:   '8px 10px',
      display:   'flex',
      flexDirection: 'column',
      gap:       4,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: stateColor, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
          {p.row.state}
        </span>
        <strong style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.row.name || '(no name)'}
        </strong>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          {p.row.attempts > 0 ? `${p.row.attempts} attempt${p.row.attempts === 1 ? '' : 's'} · ` : ''}
          {p.row.messageCount} msg
        </span>
        {!editing && (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={p.busy}
              className="prefs-btn"
              style={{ padding: '2px 8px', fontSize: 11 }}
              title="Manually pick a category for this session — bypasses the model."
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => { void p.onSkipOne(p.row.sid); }}
              disabled={p.busy}
              className="prefs-btn"
              style={{ padding: '2px 8px', fontSize: 11 }}
              title={p.row.state === 'abandoned'
                ? 'Re-skip — updates the skip reason.'
                : 'Mark as user-skipped (category falls back to "general").'}
            >
              Skip
            </button>
          </>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute, #aaa)' }}>
        Reason: {_formatSkipReason(p.row.skipReason)}
        {p.row.category ? ` · current cat: ${p.row.category}` : ''}
        {p.row.categorySource ? ` (${p.row.categorySource})` : ''}
        {' · ID: '}
        <code style={{ fontSize: 10.5 }}>{p.row.sid}</code>
      </div>
      {p.row.userPreview && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #bbb)' }}>
          <strong style={{ color: 'var(--fg-mute, #888)' }}>U:</strong> {p.row.userPreview}
        </div>
      )}
      {p.row.assistantPreview && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #bbb)' }}>
          <strong style={{ color: 'var(--fg-mute, #888)' }}>A:</strong> {p.row.assistantPreview}
        </div>
      )}
      {editing && (
        <div style={{
          marginTop: 4, padding: 6, border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 4, background: 'var(--bg-soft, #1f1f1f)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11 }}>
            <span style={{ color: 'var(--fg-mute, #888)' }}>Category</span>
            <select
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              className="prefs-input"
              style={{ fontSize: 12, padding: '3px 6px' }}
            >
              {p.validCats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <TagListInput
            label="Tags (comma-separated, ≤ 5, kebab-case)"
            value={tags}
            onChange={setTags}
            placeholder="react-hooks, typo-fix"
          />
          <TagListInput
            label="Keywords (comma-separated, ≤ 8, kebab-case)"
            value={kw}
            onChange={setKw}
            placeholder="search-terms, user-would-type"
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="prefs-btn"
              style={{ padding: '3px 10px', fontSize: 11 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void p.onApplyManual(p.row.sid, {
                  category: cat,
                  tags:     _split(tags),
                  keywords: _split(kw),
                });
                setEditing(false);
              }}
              disabled={p.busy}
              className="prefs-btn"
              style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600 }}
            >
              Commit
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function CategorizerInspectPanel(p: {
  rows:          CategorizerDebugRow[] | null;
  validCats:     string[];
  busy:          boolean;
  error:         string | null;
  onRefresh:     () => void | Promise<void>;
  onSkipOne:     (sid: string) => void | Promise<void>;
  onApplyManual: (sid: string, payload: { category: string; tags: string[]; keywords: string[] }) => void | Promise<void>;
}) {
  return (
    <InspectShell
      title="Stuck categorizations"
      count={p.rows?.length ?? 0}
      loading={!p.rows}
      error={p.error}
      onRefresh={p.onRefresh}
      busy={p.busy}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(p.rows || []).map((row) => (
          <CategorizerInspectRow
            key={row.sid}
            row={row}
            validCats={p.validCats}
            busy={p.busy}
            onSkipOne={p.onSkipOne}
            onApplyManual={p.onApplyManual}
          />
        ))}
      </ul>
    </InspectShell>
  );
}

// ─── File-Categorizer Inspector ──────────────────────────────────────────────
function FileCategorizerInspectRow(p: {
  row:           FileCategorizerDebugRow;
  validTopics:   string[];
  busy:          boolean;
  onSkipOne:     (path: string) => void | Promise<void>;
  onApplyManual: (path: string, payload: { topics: string[]; tags: string[]; keywords: string[] }) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [topics,  setTopics]  = useState('');
  const [tags,    setTags]    = useState('');
  const [kw,      setKw]      = useState('');
  const stateColor = p.row.state === 'abandoned' ? '#e88' : '#d90';
  const _split = (s: string): string[] =>
    s.split(',').map((x) => x.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')).filter(Boolean);
  return (
    <li style={{
      borderTop: '1px solid var(--border, #2a2a2a)',
      padding:   '8px 10px',
      display:   'flex',
      flexDirection: 'column',
      gap:       4,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: stateColor, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
          {p.row.state}
        </span>
        <strong style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.row.relPath}
        </strong>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          {p.row.attempts > 0 ? `${p.row.attempts} attempt${p.row.attempts === 1 ? '' : 's'}` : ''}
        </span>
        {!editing && (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={p.busy}
              className="prefs-btn"
              style={{ padding: '2px 8px', fontSize: 11 }}
              title="Manually classify this file."
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => { void p.onSkipOne(p.row.path); }}
              disabled={p.busy}
              className="prefs-btn"
              style={{ padding: '2px 8px', fontSize: 11 }}
              title="Mark as user-skipped (empty topics, won't be retried)."
            >
              Skip
            </button>
          </>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute, #aaa)' }}>
        Reason: {_formatSkipReason(p.row.skipReason)}
        {p.row.status ? ` · status: ${p.row.status}` : ''}
      </div>
      {p.row.bodyPreview && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #bbb)' }}>
          {p.row.bodyPreview}{p.row.bodyPreview.length >= 220 ? '…' : ''}
        </div>
      )}
      {editing && (
        <div style={{
          marginTop: 4, padding: 6, border: '1px solid var(--border, #2a2a2a)',
          borderRadius: 4, background: 'var(--bg-soft, #1f1f1f)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <TagListInput
            label={`Topics (comma-separated, ≤ 3, allowlist: ${p.validTopics.slice(0, 6).join(', ')}, …)`}
            value={topics}
            onChange={setTopics}
            placeholder="psychology, religion"
          />
          <TagListInput
            label="Tags (comma-separated, ≤ 5)"
            value={tags}
            onChange={setTags}
            placeholder="trip-paris-2024, shopping-list"
          />
          <TagListInput
            label="Keywords (comma-separated, ≤ 8)"
            value={kw}
            onChange={setKw}
            placeholder="berlin, museum, neighborhood"
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="prefs-btn"
              style={{ padding: '3px 10px', fontSize: 11 }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void p.onApplyManual(p.row.path, {
                  topics:   _split(topics),
                  tags:     _split(tags),
                  keywords: _split(kw),
                });
                setEditing(false);
              }}
              disabled={p.busy}
              className="prefs-btn"
              style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600 }}
            >
              Commit
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function FileCategorizerInspectPanel(p: {
  rows:          FileCategorizerDebugRow[] | null;
  validTopics:   string[];
  busy:          boolean;
  error:         string | null;
  onRefresh:     () => void | Promise<void>;
  onSkipOne:     (path: string) => void | Promise<void>;
  onApplyManual: (path: string, payload: { topics: string[]; tags: string[]; keywords: string[] }) => void | Promise<void>;
}) {
  return (
    <InspectShell
      title="Stuck files"
      count={p.rows?.length ?? 0}
      loading={!p.rows}
      error={p.error}
      onRefresh={p.onRefresh}
      busy={p.busy}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(p.rows || []).map((row) => (
          <FileCategorizerInspectRow
            key={row.path}
            row={row}
            validTopics={p.validTopics}
            busy={p.busy}
            onSkipOne={p.onSkipOne}
            onApplyManual={p.onApplyManual}
          />
        ))}
      </ul>
    </InspectShell>
  );
}

// ─── Sorter Inspector ────────────────────────────────────────────────────────
// Sorter output is deterministic; no manual-edit form (user can only retry
// or accept the auto-skip and move on).
function SorterInspectRow(p: {
  row:       SorterDebugRow;
  busy:      boolean;
  onSkipOne: (sid: string) => void | Promise<void>;
}) {
  const stateColor = p.row.state === 'abandoned' ? '#e88' : '#d90';
  return (
    <li style={{
      borderTop: '1px solid var(--border, #2a2a2a)',
      padding:   '8px 10px',
      display:   'flex',
      flexDirection: 'column',
      gap:       4,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: stateColor, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
          {p.row.state}
        </span>
        <strong style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.row.name || '(no name)'}
        </strong>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          {p.row.attempts > 0 ? `${p.row.attempts} attempt${p.row.attempts === 1 ? '' : 's'}` : ''}
        </span>
        <button
          type="button"
          onClick={() => { void p.onSkipOne(p.row.sid); }}
          disabled={p.busy || p.row.state === 'abandoned'}
          className="prefs-btn"
          style={{ padding: '2px 8px', fontSize: 11 }}
          title={p.row.state === 'abandoned'
            ? 'Already abandoned — use Force-retry-abandoned to put it back in the queue.'
            : 'Mark as user-skipped — sorter stops attempting this session.'}
        >
          Skip
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--fg-mute, #aaa)' }}>
        Reason: {_formatSkipReason(p.row.skipReason)}
        {p.row.category ? ` · cat: ${p.row.category}` : ''}
        {p.row.wikiPath ? ` · path: ${p.row.wikiPath}` : ''}
        {' · ID: '}<code style={{ fontSize: 10.5 }}>{p.row.sid}</code>
      </div>
    </li>
  );
}

function SorterInspectPanel(p: {
  rows:      SorterDebugRow[] | null;
  busy:      boolean;
  error:     string | null;
  onRefresh: () => void | Promise<void>;
  onSkipOne: (sid: string) => void | Promise<void>;
}) {
  return (
    <InspectShell
      title="Stuck wiki-page writes"
      count={p.rows?.length ?? 0}
      loading={!p.rows}
      error={p.error}
      onRefresh={p.onRefresh}
      busy={p.busy}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(p.rows || []).map((row) => (
          <SorterInspectRow
            key={row.sid}
            row={row}
            busy={p.busy}
            onSkipOne={p.onSkipOne}
          />
        ))}
      </ul>
    </InspectShell>
  );
}

export function HubGeneratorTab() {
  const [autoTitle, setAutoTitle] = useState<AutoTitleStatus>({});
  const [categorizer, setCategorizer] = useState<CategorizerStatus>({});
  const [link, setLink] = useState<LinkStatus>({});
  const [rag, setRag]   = useState<RagStatus>({});
  // Graph + Synthesize state — read from /v1/knowledge/status. Re-fetched on
  // every loadStatus() tick because the build button + synthesize prompt
  // both depend on the current cwd.
  const [knowledge, setKnowledge] = useState<KnowledgeStatus>({ graphExists: false, synthCount: 0 });
  // Used to gate the Graph + Synthesize action buttons. KnowledgeButtons uses
  // the same hook for the same gate, so behavior matches the existing UI.
  const mcpKnowledgeRunning = useMcpRunning('knowledge-memory');
  // Per-cwd: the buttons only make sense when we have a working dir.
  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Last manual-trigger result for the toast — used so a user clicking
  // "Run now" with no pending work sees `nothing-to-do` rather than a
  // mute button. Cleared after 4 s.
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Inspect panel — shown inline below the TitleGenerator card when the user
  // clicks the "Inspect" button. Lists pending + abandoned sessions with the
  // info the user needs to decide what to do (skip permanently or retry).
  const [inspectOpen, setInspectOpen]   = useState(false);
  const [inspectRows, setInspectRows]   = useState<AutoTitleDebugRow[] | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectBusy, setInspectBusy]   = useState(false);

  // Phase 5 — Inspector state for the categorizer / file-categorizer / sorter.
  // Each worker has its own toggle, rows, busy, error so the user can keep
  // multiple panels open simultaneously to triage cross-stage stuck items.
  const [fileCategorizer, setFileCategorizer] = useState<FileCategorizerStatus>({});

  const [catInspectOpen,   setCatInspectOpen]   = useState(false);
  const [catInspectRows,   setCatInspectRows]   = useState<CategorizerDebugRow[] | null>(null);
  const [catInspectError,  setCatInspectError]  = useState<string | null>(null);
  const [catInspectBusy,   setCatInspectBusy]   = useState(false);

  const [fcInspectOpen,    setFcInspectOpen]    = useState(false);
  const [fcInspectRows,    setFcInspectRows]    = useState<FileCategorizerDebugRow[] | null>(null);
  const [fcInspectError,   setFcInspectError]   = useState<string | null>(null);
  const [fcInspectBusy,    setFcInspectBusy]    = useState(false);

  const [sortInspectOpen,  setSortInspectOpen]  = useState(false);
  const [sortInspectRows,  setSortInspectRows]  = useState<SorterDebugRow[] | null>(null);
  const [sortInspectError, setSortInspectError] = useState<string | null>(null);
  const [sortInspectBusy,  setSortInspectBusy]  = useState(false);

  async function loadStatus() {
    const url = _baseUrl();
    if (!url) return;
    // Per-cwd: only ask for knowledge status when we have a working dir; the
    // endpoint requires it. Falls back to the empty default below. Read the
    // store fresh on every tick so cwd changes propagate without re-binding
    // the parent useEffect — its closure captures only initial deps.
    const cwd = useAppStore.getState().sessionWorkingDir
      || getSessionState().defaultWorkingDir
      || null;
    try {
      const [a, c, l, f, r, k] = await Promise.all([
        fetch(`${url}/v1/config/auto-title/status`).then((r) => r.json()),
        fetch(`${url}/v1/config/context/status`).then((r) => r.json()),
        // LINK status — Phase 3.1. The endpoint always returns ok:true with
        // a snapshot, even when the adapter isn't reachable; the failure
        // surfaces as `adapterReachable:false + adapterError`.
        fetch(`${url}/v1/config/link/status`).then((r) => r.json()).catch(() => ({ ok: false })),
        fetch(`${url}/v1/config/file-categorizer/status`).then((r) => r.json()).catch(() => ({ success: false })),
        // RAG ingest worker — surfaced as a 5th stage card. Endpoint returns
        // 503 when the module isn't loaded; treat that as "stage disabled".
        fetch(`${url}/v1/context-rag/status`).then((r) => r.json()).catch(() => ({ success: false })),
        // Graph + Synthesize — same endpoint KnowledgeButtons polls. Returns
        // { graphExists, synthCount }; no `success` field. 404 / network err
        // collapses to the safe zero state.
        cwd
          ? fetch(`${url}/v1/knowledge/status?workingDir=${encodeURIComponent(cwd)}`)
              .then((r) => r.ok ? r.json() : { graphExists: false, synthCount: 0 })
              .catch(() => ({ graphExists: false, synthCount: 0 }))
          : Promise.resolve({ graphExists: false, synthCount: 0 }),
      ]);
      if (a?.success) setAutoTitle(a as AutoTitleStatus);
      if (c?.success) setCategorizer(c as CategorizerStatus);
      if (l?.ok) setLink(l as LinkStatus);
      if (f?.success) setFileCategorizer(f as FileCategorizerStatus);
      if (r?.success) setRag(r as RagStatus);
      setKnowledge({
        graphExists: !!(k as { graphExists?: boolean })?.graphExists,
        synthCount:  Number((k as { synthCount?: number })?.synthCount ?? 0),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ── Manual-trigger helpers ────────────────────────────────────────────────
  // Format the bridge's `{ kicked, reason, reset }` reply into a brief status
  // line for the inline message banner. The toast layer fires its own
  // success toast on `auto-title:batch-summary` etc, so this is just an
  // immediate feedback for the click that may or may not start a run.
  function _formatActionResult(r: { kicked?: boolean; reason?: string; reset?: number }, verb: string): string {
    if (r.reset !== undefined) {
      const kicked = r.kicked ? ' — worker started.' : '';
      return `${verb}: reset ${r.reset} session${r.reset === 1 ? '' : 's'}.${kicked}`;
    }
    if (r.kicked) return `${verb}: worker started.`;
    if (r.reason === 'already-running') return `${verb}: worker is already running.`;
    if (r.reason === 'nothing-to-do')   return `${verb}: nothing pending.`;
    if (r.reason === 'disabled')        return `${verb}: stage is disabled.`;
    if (r.reason === 'gated-by-titler') return `${verb}: blocked — title generator still has work.`;
    if (r.reason === 'gated-by-categorizer') return `${verb}: blocked — categorizer still has work.`;
    return `${verb}: ${r.reason || 'no-op'}.`;
  }

  async function _post(pathSuffix: string, verb: string) {
    const url = _baseUrl();
    if (!url) return;
    setBusy(true);
    try {
      const r = await fetch(`${url}/v1/config/${pathSuffix}`, { method: 'POST' });
      const j = await r.json();
      if (!j?.success) {
        setActionMsg(`${verb}: ${j?.error || 'request failed'}`);
      } else {
        setActionMsg(_formatActionResult(j, verb));
      }
      await loadStatus();
    } catch (e) {
      setActionMsg(`${verb}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 4_000);
    }
  }

  // Graph + Synthesize action handlers. Both gate on knowledge-memory MCP +
  // a non-null cwd; the StageCards mirror those gates on the buttons.
  async function runBuildGraph() {
    const url = _baseUrl();
    if (!url) return;
    const cwd = useAppStore.getState().sessionWorkingDir
      || getSessionState().defaultWorkingDir
      || null;
    if (!cwd) { setActionMsg('Graph build: no working directory selected.'); setTimeout(() => setActionMsg(null), 4_000); return; }
    setBusy(true);
    try {
      const verb = knowledge.graphExists ? 'Graph rebuild' : 'Graph build';
      // Build the AST graph first, then write Obsidian pages — same two-step
      // flow KnowledgeButtons runs from the action-button surface.
      const br = await fetch(`${url}/v1/knowledge/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: cwd }),
      });
      if (!br.ok) {
        const e = await br.json().catch(() => ({ error: `HTTP ${br.status}` }));
        throw new Error((e as { error?: string }).error || `HTTP ${br.status}`);
      }
      const er = await fetch(`${url}/v1/knowledge/export-obsidian`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: cwd }),
      });
      if (!er.ok) {
        const e = await er.json().catch(() => ({ error: `HTTP ${er.status}` }));
        throw new Error((e as { error?: string }).error || `HTTP ${er.status}`);
      }
      const ed = (await er.json()) as { filesWritten?: number };
      setActionMsg(`${verb}: ${ed.filesWritten ?? 0} Obsidian pages updated.`);
      await loadStatus();
    } catch (e) {
      setActionMsg(`Graph build: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 4_000);
    }
  }

  // Diagnose pipeline — seeds the chat composer with `#skill-diagnose-pipeline`
  // and closes the Hub. The skill (bridge/modules/context-generator/skills/
  // diagnose-pipeline/SKILL.md) instructs the model to pull /status + /debug
  // for every worker, cluster abandoned rows by skipReason, and report both
  // user-side fixes and code-side suggestions. Same shim as the plugins-folder
  // `+` button — listener lives in ChatInput.
  function runDiagnosePrompt() {
    seedSkillCommand('diagnose-pipeline');
    window.dispatchEvent(new CustomEvent('yha:close-context-hub'));
    requestAnimationFrame(() => {
      (document.getElementById('chat-ta') as HTMLTextAreaElement | null)?.focus();
    });
    setActionMsg('Diagnose: skill seeded in chat input — submit to run.');
    setTimeout(() => setActionMsg(null), 4_000);
  }

  function runSynthesizePrompt() {
    const cwd = useAppStore.getState().sessionWorkingDir
      || getSessionState().defaultWorkingDir
      || null;
    if (!cwd) { setActionMsg('Synthesize: no working directory selected.'); setTimeout(() => setActionMsg(null), 4_000); return; }
    const prompt = buildSynthesisPrompt({
      cwd,
      hasGraph: knowledge.graphExists,
      isUpdate: knowledge.synthCount > 0,
    });
    bus.emit('chat:set-input', prompt);
    // Close the Hub so the user lands on the chat input with the prompt
    // pre-filled — paired with the listener in ContextHub.
    window.dispatchEvent(new CustomEvent('yha:close-context-hub'));
    requestAnimationFrame(() => {
      (document.getElementById('chat-ta') as HTMLTextAreaElement | null)?.focus();
    });
    setActionMsg(knowledge.synthCount > 0
      ? 'Synthesize: re-synthesis prompt added to chat input.'
      : 'Synthesize: prompt added to chat input.');
    setTimeout(() => setActionMsg(null), 4_000);
  }

  async function runNowAutoTitle()       { await _post('auto-title/run-now',     'Auto-title run-now'); }
  async function forceRetryAutoTitle()   {
    if (!confirm('Reset the failure counter on every abandoned session and retry titling?')) return;
    await _post('auto-title/force-retry',   'Auto-title force-retry');
  }
  async function runNowCategorizer()     { await _post('categorizer/run-now',    'Categorizer run-now'); }
  async function forceRebuildCategorizer() {
    if (!confirm('Clear category + tags on EVERY session and re-classify them all? This will also dirty every wiki page so the sorter has to rebuild.')) return;
    await _post('categorizer/force-rebuild','Categorizer force-rebuild');
  }
  async function runNowSorter()          { await _post('sorter/run-now',         'Sorter run-now'); }
  async function forceRebuildSorter()    {
    if (!confirm('Re-render every wiki page from scratch? This is safe but writes one file per categorized session.')) return;
    await _post('sorter/force-rebuild',     'Sorter force-rebuild');
  }
  async function runNowLink()            { await _post('link/run-now',           'LINK sync now'); }

  // RAG run-now lives under /v1/context-rag/ not /v1/config/, so it doesn't
  // share the _post helper. Returns the same { kicked, reason? } shape so
  // _formatActionResult handles it; "queue-empty" / "no-dbs" surface as the
  // brief inline banner just like the other workers.
  async function runNowRag() {
    const url = _baseUrl();
    if (!url) return;
    setBusy(true);
    try {
      const r = await fetch(`${url}/v1/context-rag/run-now`, { method: 'POST' });
      const j = await r.json();
      if (!j?.success) {
        setActionMsg(`RAG run-now: ${j?.error || 'request failed'}`);
      } else if (j.kicked) {
        setActionMsg('RAG run-now: ingest started.');
      } else if (j.reason === 'queue-empty') {
        setActionMsg('RAG run-now: queue is empty.');
      } else if (j.reason === 'no-dbs') {
        setActionMsg('RAG run-now: no vector DBs configured — set one up in the 🧬 RAG tab.');
      } else if (j.reason === 'disabled') {
        setActionMsg('RAG run-now: ingest is disabled.');
      } else if (j.reason === 'already-running') {
        setActionMsg('RAG run-now: worker is already running.');
      } else {
        setActionMsg(`RAG run-now: ${j.reason || 'no-op'}.`);
      }
      await loadStatus();
    } catch (e) {
      setActionMsg(`RAG run-now: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 4_000);
    }
  }
  // "Manage" — jumps to the 🧬 RAG tab where the full DB-management UI lives.
  // Uses the ContextHub-listened CustomEvent so this card doesn't need to know
  // about the parent's setTab callback.
  function openRagTab() {
    window.dispatchEvent(new CustomEvent('yha:context-hub-set-tab', { detail: { tab: 'rag' } }));
  }

  // ── Inspect helpers ───────────────────────────────────────────────────────
  // Loads /v1/config/auto-title/debug into the inline panel. Re-fetched after
  // every per-row Skip / Force-retry so the user sees their action take effect.
  async function loadInspect() {
    const url = _baseUrl();
    if (!url) return;
    setInspectBusy(true);
    setInspectError(null);
    try {
      const r = await fetch(`${url}/v1/config/auto-title/debug`);
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || 'request failed');
      setInspectRows(j.rows || []);
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : String(e));
      setInspectRows([]);
    } finally {
      setInspectBusy(false);
    }
  }
  async function toggleInspect() {
    if (inspectOpen) { setInspectOpen(false); return; }
    setInspectOpen(true);
    await loadInspect();
  }
  // "Skip all stuck" — global skip of every currently-pending session. Uses
  // the no-body POST to /skip-stuck so the backend skips all (rather than a
  // specific list).
  async function skipAllStuck() {
    if (!confirm('Mark every currently-pending session as fallback (synthesized title from first user message)? You can always rename them manually later.')) return;
    setBusy(true);
    try {
      const url = _baseUrl();
      if (!url) return;
      const r = await fetch(`${url}/v1/config/auto-title/skip-stuck`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      });
      const j = await r.json();
      setActionMsg(j?.success
        ? `Skipped ${j.skipped} stuck session${j.skipped === 1 ? '' : 's'}.`
        : `Skip-stuck: ${j?.error || 'request failed'}`);
      await loadStatus();
      if (inspectOpen) await loadInspect();
    } catch (e) {
      setActionMsg(`Skip-stuck: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 4_000);
    }
  }
  // Per-session skip — used by each row's "Skip" button in the inspect panel.
  async function skipOne(sid: string) {
    setInspectBusy(true);
    try {
      const url = _baseUrl();
      if (!url) return;
      const r = await fetch(`${url}/v1/config/auto-title/skip-stuck`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sids: [sid] }),
      });
      const j = await r.json();
      if (!j?.success) setInspectError(j?.error || 'request failed');
      await loadStatus();
      await loadInspect();
    } catch (e) {
      setInspectError(e instanceof Error ? e.message : String(e));
    } finally {
      setInspectBusy(false);
    }
  }

  // ── Phase 5 — Categorizer / File-Categorizer / Sorter inspector helpers ─
  // Mirrors the AutoTitle pattern. Each worker has its own load / toggle /
  // skip-all / skip-one and (for the two categorizers) apply-manual.
  async function loadCatInspect() {
    const url = _baseUrl();
    if (!url) return;
    setCatInspectBusy(true);
    setCatInspectError(null);
    try {
      const r = await fetch(`${url}/v1/config/categorizer/debug`);
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || 'request failed');
      setCatInspectRows(j.rows || []);
    } catch (e) {
      setCatInspectError(e instanceof Error ? e.message : String(e));
      setCatInspectRows([]);
    } finally { setCatInspectBusy(false); }
  }
  async function toggleCatInspect() {
    if (catInspectOpen) { setCatInspectOpen(false); return; }
    setCatInspectOpen(true);
    await loadCatInspect();
  }
  async function skipAllStuckCategorizer() {
    if (!confirm('Skip every currently-stuck session in the categorizer? They get category "general" and stop being retried.')) return;
    setBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/categorizer/skip-stuck`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      setActionMsg(j?.success
        ? `Categorizer: skipped ${j.skipped} stuck session${j.skipped === 1 ? '' : 's'}.`
        : `Categorizer skip-stuck: ${j?.error || 'request failed'}`);
      await loadStatus();
      if (catInspectOpen) await loadCatInspect();
    } catch (e) {
      setActionMsg(`Categorizer skip-stuck: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); setTimeout(() => setActionMsg(null), 4_000); }
  }
  async function skipOneCategorizer(sid: string) {
    setCatInspectBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/categorizer/skip-stuck`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sids: [sid] }),
      });
      const j = await r.json();
      if (!j?.success) setCatInspectError(j?.error || 'request failed');
      await loadStatus(); await loadCatInspect();
    } catch (e) { setCatInspectError(e instanceof Error ? e.message : String(e)); }
    finally { setCatInspectBusy(false); }
  }
  async function forceRetryCategorizer() {
    if (!confirm('Reset the failure counter on every auto-skipped session and retry classifying?')) return;
    await _post('categorizer/force-retry', 'Categorizer force-retry');
    if (catInspectOpen) await loadCatInspect();
  }
  async function applyManualCategorizer(sid: string, payload: { category: string; tags: string[]; keywords: string[] }) {
    setCatInspectBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/categorizer/manual`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, ...payload }),
      });
      const j = await r.json();
      if (!j?.success) setCatInspectError(j?.error || 'request failed');
      await loadStatus(); await loadCatInspect();
    } catch (e) { setCatInspectError(e instanceof Error ? e.message : String(e)); }
    finally { setCatInspectBusy(false); }
  }

  async function loadFcInspect() {
    const url = _baseUrl(); if (!url) return;
    setFcInspectBusy(true); setFcInspectError(null);
    try {
      const r = await fetch(`${url}/v1/config/file-categorizer/debug`);
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || 'request failed');
      setFcInspectRows(j.rows || []);
    } catch (e) {
      setFcInspectError(e instanceof Error ? e.message : String(e));
      setFcInspectRows([]);
    } finally { setFcInspectBusy(false); }
  }
  async function toggleFcInspect() {
    if (fcInspectOpen) { setFcInspectOpen(false); return; }
    setFcInspectOpen(true);
    await loadFcInspect();
  }
  async function runNowFileCategorizer() { await _post('file-categorizer/run-now', 'File-categorizer run-now'); }
  async function forceRebuildFileCategorizer() {
    if (!confirm('Wipe topics/tags/keywords from EVERY keep-notes file and re-classify the corpus from scratch?')) return;
    await _post('file-categorizer/force-rebuild', 'File-categorizer force-rebuild');
  }
  async function skipAllStuckFileCategorizer() {
    if (!confirm('Skip every currently-pending keep-notes file? They get marked auto-skipped and stop being retried. (You can manually classify them later via the Inspector.)')) return;
    setBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/file-categorizer/skip-stuck`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      setActionMsg(j?.success
        ? `File-categorizer: skipped ${j.skipped} stuck file${j.skipped === 1 ? '' : 's'}.`
        : `File-categorizer skip-stuck: ${j?.error || 'request failed'}`);
      await loadStatus();
      if (fcInspectOpen) await loadFcInspect();
    } catch (e) {
      setActionMsg(`File-categorizer skip-stuck: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); setTimeout(() => setActionMsg(null), 4_000); }
  }
  async function skipOneFileCategorizer(filePath: string) {
    setFcInspectBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/file-categorizer/skip-stuck`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [filePath] }),
      });
      const j = await r.json();
      if (!j?.success) setFcInspectError(j?.error || 'request failed');
      await loadStatus(); await loadFcInspect();
    } catch (e) { setFcInspectError(e instanceof Error ? e.message : String(e)); }
    finally { setFcInspectBusy(false); }
  }
  async function forceRetryFileCategorizer() {
    if (!confirm('Reset the failure counter on every auto-skipped keep-notes file and retry classifying?')) return;
    await _post('file-categorizer/force-retry', 'File-categorizer force-retry');
    if (fcInspectOpen) await loadFcInspect();
  }
  async function applyManualFileCategorizer(filePath: string, payload: { topics: string[]; tags: string[]; keywords: string[] }) {
    setFcInspectBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/file-categorizer/manual`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, ...payload }),
      });
      const j = await r.json();
      if (!j?.success) setFcInspectError(j?.error || 'request failed');
      await loadStatus(); await loadFcInspect();
    } catch (e) { setFcInspectError(e instanceof Error ? e.message : String(e)); }
    finally { setFcInspectBusy(false); }
  }

  async function loadSortInspect() {
    const url = _baseUrl(); if (!url) return;
    setSortInspectBusy(true); setSortInspectError(null);
    try {
      const r = await fetch(`${url}/v1/config/sorter/debug`);
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || 'request failed');
      setSortInspectRows(j.rows || []);
    } catch (e) {
      setSortInspectError(e instanceof Error ? e.message : String(e));
      setSortInspectRows([]);
    } finally { setSortInspectBusy(false); }
  }
  async function toggleSortInspect() {
    if (sortInspectOpen) { setSortInspectOpen(false); return; }
    setSortInspectOpen(true);
    await loadSortInspect();
  }
  async function skipAllStuckSorter() {
    if (!confirm('Skip every session whose wiki-page write is currently failing? The session stays categorised but its wiki page won\'t be regenerated until you Force-retry.')) return;
    setBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/sorter/skip-stuck`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const j = await r.json();
      setActionMsg(j?.success
        ? `Sorter: skipped ${j.skipped} stuck session${j.skipped === 1 ? '' : 's'}.`
        : `Sorter skip-stuck: ${j?.error || 'request failed'}`);
      await loadStatus();
      if (sortInspectOpen) await loadSortInspect();
    } catch (e) {
      setActionMsg(`Sorter skip-stuck: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); setTimeout(() => setActionMsg(null), 4_000); }
  }
  async function skipOneSorter(sid: string) {
    setSortInspectBusy(true);
    try {
      const url = _baseUrl(); if (!url) return;
      const r = await fetch(`${url}/v1/config/sorter/skip-stuck`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sids: [sid] }),
      });
      const j = await r.json();
      if (!j?.success) setSortInspectError(j?.error || 'request failed');
      await loadStatus(); await loadSortInspect();
    } catch (e) { setSortInspectError(e instanceof Error ? e.message : String(e)); }
    finally { setSortInspectBusy(false); }
  }
  async function forceRetrySorter() {
    if (!confirm('Reset every auto-skipped session\'s wiki-page state and retry writing?')) return;
    await _post('sorter/force-retry', 'Sorter force-retry');
    if (sortInspectOpen) await loadSortInspect();
  }

  useEffect(() => {
    void loadStatus();
    const t = setInterval(() => void loadStatus(), 5_000);
    // SSE: refresh immediately when the sorter writes a new wiki page so the
    // user sees the "lifetime files" counter tick without waiting up to 5 s
    // for the next poll cycle.
    const onWiki = () => { void loadStatus(); };
    // SSE: same pattern for LINK — refresh on every push/pull tick so the
    // dashboard reflects the freshest counters.
    const onLink = () => { void loadStatus(); };
    window.addEventListener('yha:context:wiki-updated', onWiki as EventListener);
    window.addEventListener('yha:link:synced',          onLink as EventListener);
    return () => {
      clearInterval(t);
      window.removeEventListener('yha:context:wiki-updated', onWiki as EventListener);
      window.removeEventListener('yha:link:synced',          onLink as EventListener);
    };
  }, []);

  // The categorizer chains directly off the title-worker — there is no
  // dedicated rescan endpoint yet. The cheapest "force a tick" today is
  // to PATCH bridge mode to its current value, which doesn't change state
  // but makes the worker pick up newly-eligible sessions sooner. When a
  // proper /v1/config/context/rescan exists (Phase 2), swap this in.
  async function rescan() {
    setBusy(true);
    try { await loadStatus(); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h4 style={{ margin: 0 }}>Pipeline status</h4>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
            Live state of every ContextGenerator stage. Refreshes every 5 s.
          </p>
          <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
            The session pipeline runs <strong>serially</strong>: TitleGenerator
            → Categorizer → Sorter → LINK. Each downstream stage stays "●
            waiting" until the previous one fully drains. RAG + Graph + Synthesize
            run independently per cwd; Graph is automated, Synthesize injects an
            LLM prompt into the chat input.
          </p>
        </div>
        {/* Diagnose pipeline — same #skill-seed shim the plugins-folder `+`
            button uses. Closes the Hub so the user lands on the chat composer
            with `#skill-diagnose-pipeline ` pre-filled; submitting runs the
            SKILL.md at bridge/modules/context-generator/skills/diagnose-pipeline. */}
        <button
          type="button"
          onClick={runDiagnosePrompt}
          disabled={busy}
          className="prefs-btn"
          style={{ padding: '6px 12px', whiteSpace: 'nowrap', flexShrink: 0 }}
          title="Walk every pipeline worker, cluster abandoned rows by failure class, and report both user-side fixes and code-side suggestions. Same #skill is callable from the command picker as #skill-diagnose-pipeline."
        >
          🔍 Diagnose pipeline
        </button>
      </header>

      {error && (
        <div style={{
          padding: '8px 10px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: '12px',
        }}>
          {error}
        </div>
      )}

      {actionMsg && (
        <div style={{
          padding: '6px 10px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 4,
          background: 'var(--bg-soft, #1f1f1f)', color: 'var(--fg, #ccc)', fontSize: '12px',
        }}>
          {actionMsg}
        </div>
      )}

      <StageCard
        emoji="🪪"
        name="TitleGenerator"
        enabled={autoTitle.enabled ?? true}
        running={autoTitle.isRunning}
        pending={autoTitle.pendingCount}
        lastRunAt={autoTitle.lastRunAt}
        lastCount={autoTitle.lastRunTitledCount}
        lifetime={autoTitle.lifetimeTitled}
        hint="Names new sessions using the cheap model (llama-3.1-8b). Junk sessions (failed imports, tweet-sized content) auto-skip without burning API calls. Toggle + model/provider in ⚙ Settings tab."
        warning={(autoTitle.abandonedCount ?? 0) > 0
          ? `${autoTitle.abandonedCount} session${autoTitle.abandonedCount === 1 ? '' : 's'} abandoned after 3 failed retries — they no longer block the pipeline. Click "Inspect" to see why or "Force retry" to ask the model again.`
          : undefined}
        actions={[
          {
            label:    'Run now',
            onClick:  runNowAutoTitle,
            disabled: busy || !(autoTitle.enabled ?? true) || (autoTitle.isRunning ?? false),
            title:    'Skip the 3-min watchdog and process the queue immediately.',
          },
          {
            label:    inspectOpen ? 'Hide inspect' : 'Inspect',
            onClick:  toggleInspect,
            disabled: busy,
            title:    'Show the most-stuck sessions with their content preview and skip reason.',
          },
          ...(((autoTitle.pendingCount ?? 0) > 0 || (autoTitle.abandonedCount ?? 0) > 0) ? [{
            label:    'Skip all stuck',
            onClick:  skipAllStuck,
            disabled: busy,
            danger:   true,
            title:    'Mark every pending session as fallback with a synthesized name. You can always rename them manually later.',
          } as StageAction] : []),
          ...((autoTitle.abandonedCount ?? 0) > 0 ? [{
            label:    'Force retry abandoned',
            onClick:  forceRetryAutoTitle,
            disabled: busy,
            danger:   true,
            title:    'Reset the failure counter on every abandoned session and ask the model again.',
          } as StageAction] : []),
        ]}
      />

      {inspectOpen && (
        <InspectPanel
          rows={inspectRows}
          busy={inspectBusy}
          error={inspectError}
          onRefresh={loadInspect}
          onSkipOne={skipOne}
        />
      )}

      <StageCard
        emoji="🗂"
        name="Categorizer"
        enabled={categorizer.enabled ?? true}
        running={categorizer.isRunning}
        pending={categorizer.pendingCount}
        lastRunAt={categorizer.lastRunAt}
        lastCount={categorizer.lastRunCategorizedCount}
        lifetime={categorizer.lifetimeCategorized}
        gatedBy={categorizer.gatedBy ?? null}
        hint={`Assigns one of ${categorizer.validCategories?.length ?? 12} topic slugs + tags + sensitivity proposals. Toggle in ⚙ Settings tab.`}
        warning={(categorizer.abandonedCount ?? 0) > 0
          ? `${categorizer.abandonedCount} session${categorizer.abandonedCount === 1 ? '' : 's'} auto-skipped after 3 failed retries — they no longer block the pipeline. Click "Inspect" to see why or assign a category manually.`
          : undefined}
        actions={[
          {
            label:    'Run now',
            onClick:  runNowCategorizer,
            disabled: busy || !(categorizer.enabled ?? true) || (categorizer.isRunning ?? false),
            title:    'Skip the watchdog and process the queue (only runs if the title-generator is clear).',
          },
          {
            label:    catInspectOpen ? 'Hide inspect' : 'Inspect',
            onClick:  toggleCatInspect,
            disabled: busy,
            title:    'Show the most-stuck categorizations with reason + manual-edit option.',
          },
          ...(((categorizer.pendingCount ?? 0) > 0 || (categorizer.abandonedCount ?? 0) > 0) ? [{
            label:    'Skip all stuck',
            onClick:  skipAllStuckCategorizer,
            disabled: busy,
            danger:   true,
            title:    'Mark every pending session as user-skipped (category falls back to "general").',
          } as StageAction] : []),
          ...((categorizer.abandonedCount ?? 0) > 0 ? [{
            label:    'Force retry abandoned',
            onClick:  forceRetryCategorizer,
            disabled: busy,
            danger:   true,
            title:    'Reset the failure counter on every auto-skipped session and ask the model again.',
          } as StageAction] : []),
          {
            label:    'Force re-classify all',
            onClick:  forceRebuildCategorizer,
            disabled: busy,
            danger:   true,
            title:    'Wipe category + tags on EVERY session and re-classify from scratch. Destructive.',
          },
        ]}
      />

      {catInspectOpen && (
        <CategorizerInspectPanel
          rows={catInspectRows}
          validCats={categorizer.validCategories ?? []}
          busy={catInspectBusy}
          error={catInspectError}
          onRefresh={loadCatInspect}
          onSkipOne={skipOneCategorizer}
          onApplyManual={applyManualCategorizer}
        />
      )}

      <StageCard
        emoji="🗒"
        name="File-Categorizer (keep-notes)"
        enabled={fileCategorizer.enabled ?? false}
        running={fileCategorizer.isRunning}
        pending={fileCategorizer.pendingCount}
        lastRunAt={fileCategorizer.lastRunAt}
        lastCount={fileCategorizer.lastRunCategorizedCount}
        lifetime={fileCategorizer.lifetimeCategorized}
        gatedBy={fileCategorizer.gatedBy ?? null}
        hint={
          fileCategorizer.root
            ? `LLM-classifies imported keep-notes files into topics + tags + keywords. Walks ${fileCategorizer.root}. Gated behind the session-categorizer.`
            : 'LLM-classifies imported keep-notes files into topics + tags + keywords. Gated behind the session-categorizer.'
        }
        warning={(fileCategorizer.abandonedCount ?? 0) > 0
          ? `${fileCategorizer.abandonedCount} file${fileCategorizer.abandonedCount === 1 ? '' : 's'} auto-skipped after 3 failed retries. Inspect & assign topics manually, or Force-retry once you've fixed the underlying cause.`
          : undefined}
        actions={[
          {
            label:    'Run now',
            onClick:  runNowFileCategorizer,
            disabled: busy || !(fileCategorizer.enabled ?? false) || (fileCategorizer.isRunning ?? false),
            title:    'Skip the 5-min watchdog and process the queue immediately.',
          },
          {
            label:    fcInspectOpen ? 'Hide inspect' : 'Inspect',
            onClick:  toggleFcInspect,
            disabled: busy,
            title:    'Show the most-stuck files with reason + manual-edit option.',
          },
          ...(((fileCategorizer.pendingCount ?? 0) > 0 || (fileCategorizer.abandonedCount ?? 0) > 0) ? [{
            label:    'Skip all stuck',
            onClick:  skipAllStuckFileCategorizer,
            disabled: busy,
            danger:   true,
            title:    'Mark every pending file as user-skipped — empty topics, won\'t be retried.',
          } as StageAction] : []),
          ...((fileCategorizer.abandonedCount ?? 0) > 0 ? [{
            label:    'Force retry abandoned',
            onClick:  forceRetryFileCategorizer,
            disabled: busy,
            danger:   true,
            title:    'Reset the failure counter on every auto-skipped file and re-classify.',
          } as StageAction] : []),
          {
            label:    'Force re-classify all',
            onClick:  forceRebuildFileCategorizer,
            disabled: busy,
            danger:   true,
            title:    'Wipe topics/tags/keywords from EVERY keep-notes file and re-classify from scratch.',
          },
        ]}
      />

      {fcInspectOpen && (
        <FileCategorizerInspectPanel
          rows={fcInspectRows}
          validTopics={fileCategorizer.validTopics ?? []}
          busy={fcInspectBusy}
          error={fcInspectError}
          onRefresh={loadFcInspect}
          onSkipOne={skipOneFileCategorizer}
          onApplyManual={applyManualFileCategorizer}
        />
      )}

      <StageCard
        emoji="📚"
        name="Sorter"
        enabled={categorizer.sorter?.enabled ?? true}
        running={categorizer.sorter?.isRunning}
        pending={categorizer.sorter?.pendingCount}
        lastRunAt={categorizer.sorter?.lastRunAt}
        lastCount={categorizer.sorter?.lastRunFilesWritten}
        lifetime={categorizer.sorter?.lifetimeFilesWritten}
        gatedBy={categorizer.sorter?.gatedBy ?? null}
        hint={
          categorizer.sorter?.docsRoot
            ? `Builds the cross-link context graph (used by the Picker tab) and writes Markdown pages into ${categorizer.sorter.docsRoot}. Toggle in ⚙ Settings tab.`
            : 'Builds the cross-link context graph (used by the Picker tab) and writes Markdown pages into docs/generated/. Toggle in ⚙ Settings tab.'
        }
        warning={(categorizer.sorter?.abandonedCount ?? 0) > 0
          ? `${categorizer.sorter?.abandonedCount} session${categorizer.sorter?.abandonedCount === 1 ? '' : 's'} auto-skipped after 3 failed wiki-page writes (typically EACCES, full disk, or a path-too-long Windows-vault issue). Inspect to see the OS error.`
          : undefined}
        actions={[
          {
            label:    'Run now',
            onClick:  runNowSorter,
            disabled: busy || (categorizer.sorter?.enabled === false) || (categorizer.sorter?.isRunning ?? false),
            title:    'Skip the watchdog and rebuild aggregate indexes immediately.',
          },
          {
            label:    sortInspectOpen ? 'Hide inspect' : 'Inspect',
            onClick:  toggleSortInspect,
            disabled: busy,
            title:    'Show the most-stuck wiki-page writes with the OS error message.',
          },
          ...(((categorizer.sorter?.pendingCount ?? 0) > 0 || (categorizer.sorter?.abandonedCount ?? 0) > 0) ? [{
            label:    'Skip all stuck',
            onClick:  skipAllStuckSorter,
            disabled: busy,
            danger:   true,
            title:    'Mark every session whose wiki write keeps failing as user-skipped.',
          } as StageAction] : []),
          ...((categorizer.sorter?.abandonedCount ?? 0) > 0 ? [{
            label:    'Force retry abandoned',
            onClick:  forceRetrySorter,
            disabled: busy,
            danger:   true,
            title:    'Reset the wiki-page state on every auto-skipped session and retry writing.',
          } as StageAction] : []),
          {
            label:    'Force rebuild',
            onClick:  forceRebuildSorter,
            disabled: busy,
            danger:   true,
            title:    'Re-render every wiki page from scratch (no AI calls — just file I/O).',
          },
        ]}
      />

      {sortInspectOpen && (
        <SorterInspectPanel
          rows={sortInspectRows}
          busy={sortInspectBusy}
          error={sortInspectError}
          onRefresh={loadSortInspect}
          onSkipOne={skipOneSorter}
        />
      )}

      <StageCard
        emoji="🔗"
        name="LINK (Obsidian Sync)"
        enabled={link.enabled ?? false}
        running={link.isRunning}
        lastRunAt={link.lastRunAt}
        // Pushed + pulled per last run so users see "did anything happen?"
        // at a glance. Lifetime counter sums both directions.
        lastCount={
          (link.lastRunStats?.pushed ?? 0) + (link.lastRunStats?.pulled ?? 0)
        }
        lifetime={(link.lifetimePushed ?? 0) + (link.lifetimePulled ?? 0)}
        hint={
          link.enabled === false
            ? 'Disabled — toggle in ⚙ Settings tab. Adapter pattern (mock / obsidian-rest / webdav) is wired; the Obsidian REST adapter needs the plugin running on the desktop + an API key (see LINK Setup below).'
            : `Adapter: ${link.adapterKind ?? 'mock'} · ${
                link.adapterReachable
                  ? '● reachable'
                  : `● unreachable${link.adapterError ? ` (${link.adapterError})` : ''}`
              }${
                link.lastRunStats
                  ? ` · last run ↑${link.lastRunStats.pushed ?? 0} ↓${link.lastRunStats.pulled ?? 0}${(link.lastRunStats.conflicts ?? 0) > 0 ? ` ⚠${link.lastRunStats.conflicts}` : ''}`
                  : ''
              }`
        }
        warning={
          link.enabled && !link.adapterReachable && (link.adapterCheckedAt ?? 0) > 0
            ? `Adapter not reachable: ${link.adapterError || 'unknown error'}. Sync ticks will retry every ${Math.round((link.syncIntervalMs ?? 300_000) / 1000)} s.`
            : undefined
        }
        actions={[
          {
            label: link.isRunning ? 'Syncing…' : 'Sync now',
            onClick: () => void runNowLink(),
            disabled: busy || (link.enabled === false) || (link.isRunning ?? false),
            title: 'Trigger an immediate push/pull sync. Bypasses the 60-second push rate-limit.',
          },
        ]}
      />

      <StageCard
        emoji="🧬"
        name="RAG Ingest"
        enabled={rag.enabled ?? true}
        running={rag.running}
        pending={rag.queue?.total ?? 0}
        lastRunAt={rag.lastRunAt}
        lastCount={rag.lastRunIngestedCount}
        lifetime={rag.lifetimeIngested}
        hint={
          rag.hasDbs === false
            ? 'No vector DBs configured. Open the 🧬 RAG tab or click ⚡ in the chat input to set one up.'
            : (() => {
                const k = rag.queue?.byKind || {};
                const parts: string[] = [];
                if (k.sessions) parts.push(`${k.sessions} session${k.sessions === 1 ? '' : 's'}`);
                if (k.files)    parts.push(`${k.files} file${k.files === 1 ? '' : 's'}`);
                if (k.knowledge) parts.push(`${k.knowledge} keep-note${k.knowledge === 1 ? '' : 's'}`);
                const queueDetail = parts.length ? ` Queue: ${parts.join(' · ')}.` : '';
                return `Embeds sessions, files, and keep-notes into vector DBs for ⚡ retrieval at chat-time.${queueDetail}`;
              })()
        }
        warning={rag.lastError
          ? `Last ingest pass errored: ${rag.lastError}`
          : undefined}
        actions={[
          {
            label:    'Run now',
            onClick:  runNowRag,
            disabled: busy || !(rag.enabled ?? true) || (rag.running ?? false) || (rag.hasDbs === false),
            title:    rag.hasDbs === false
              ? 'No DBs configured — set one up in the 🧬 RAG tab first.'
              : 'Skip the 60-second watchdog and process the ingest queue immediately.',
          },
          {
            label:    'Manage',
            onClick:  openRagTab,
            disabled: busy,
            title:    'Open the 🧬 RAG tab — DB list, migration, entitlements, search test.',
          },
        ]}
      />

      {/* Graph — automated AST + Obsidian export. Per-cwd: gates on cwd
          + knowledge-memory MCP. The "enabled" flag reflects whether the
          stage is *usable right now*, not a config toggle. */}
      <StageCard
        emoji="🕸"
        name="Graph (codebase)"
        enabled={!!sessionWorkingDir && mcpKnowledgeRunning}
        hint={
          !sessionWorkingDir
            ? 'Pick a working directory in the session panel to enable graph builds.'
            : !mcpKnowledgeRunning
              ? 'Start the knowledge-memory MCP (Prefs → MCPs) to enable graph builds.'
              : knowledge.graphExists
                ? `Graph cached for ${sessionWorkingDir}. Rebuild to pick up new files / refactors. Powers \`query_code_graph\` for the synthesize prompt.`
                : `No graph yet for ${sessionWorkingDir}. Build to enable \`query_code_graph\` (god-nodes / hubs / stats) before synthesis.`
        }
        actions={[
          {
            label: knowledge.graphExists ? 'Rebuild' : 'Build now',
            onClick: () => void runBuildGraph(),
            disabled: busy || !sessionWorkingDir || !mcpKnowledgeRunning,
            title: knowledge.graphExists
              ? 'Re-run graphify_build.py + export Obsidian pages. Incremental.'
              : 'Run graphify_build.py + export Obsidian pages for this working directory.',
          },
        ]}
      />

      {/* Synthesize — manual prompt-injection. The action button does NOT
          run the model; it pastes the synthesis prompt into the chat input
          and closes the Hub, so the user (or partner agent) drives the
          MCP-tool sequence. Counts come from the same status endpoint as
          the Graph card. */}
      <StageCard
        emoji="📝"
        name="Synthesize (knowledge pages)"
        enabled={!!sessionWorkingDir && mcpKnowledgeRunning}
        lifetime={knowledge.synthCount > 0 ? knowledge.synthCount : undefined}
        hint={
          !sessionWorkingDir
            ? 'Pick a working directory in the session panel to enable synthesis.'
            : !mcpKnowledgeRunning
              ? 'Start the knowledge-memory MCP (Prefs → MCPs) to enable synthesis.'
              : knowledge.synthCount > 0
                ? `${knowledge.synthCount} synthesis page${knowledge.synthCount === 1 ? '' : 's'} on disk. Re-synthesize updates/merges them; the LLM is driven by the prompt this button injects.`
                : `No synthesis pages yet. The button generates an LLM prompt (using the graph${knowledge.graphExists ? '' : ' — build the graph first for richer output'}) and pastes it into the chat input.`
        }
        actions={[
          {
            label: knowledge.synthCount > 0 ? 'Re-synthesize' : 'Generate prompt',
            onClick: () => runSynthesizePrompt(),
            disabled: busy || !sessionWorkingDir || !mcpKnowledgeRunning,
            title: knowledge.synthCount > 0
              ? 'Inject a re-synthesis prompt (update + merge existing pages) into the chat input and close this hub.'
              : 'Inject a synthesis prompt into the chat input and close this hub. You (or a partner agent) drive the MCP tool calls.',
          },
        ]}
      />

      <div style={{
        marginTop: 4, padding: '10px 12px', border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 6, fontSize: '12px', color: 'var(--fg-mute, #aaa)',
        display: 'flex', gap: 18, flexWrap: 'wrap',
      }}>
        <span>
          <strong style={{ color: 'var(--fg, #ddd)' }}>Bridge mode:</strong>{' '}
          {categorizer.bridgeMode ?? '—'}
        </span>
        <span>
          <strong style={{ color: 'var(--fg, #ddd)' }}>Sensitivity policy:</strong>{' '}
          {categorizer.sensitivityPolicy ?? '—'}
        </span>
        <span>
          <strong style={{ color: 'var(--fg, #ddd)' }}>Whitelist:</strong>{' '}
          {categorizer.whitelistSize ?? 0} item
          {(categorizer.whitelistSize ?? 0) === 1 ? '' : 's'} unlocked
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => void rescan()}
          disabled={busy}
          className="prefs-btn"
          style={{ padding: '6px 12px' }}
        >
          {busy ? 'Refreshing…' : 'Refresh status'}
        </button>
      </div>
    </div>
  );
}
