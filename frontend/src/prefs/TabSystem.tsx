import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { colorTheme } from '../color-theme.js';
import { designTheme } from '../design-theme.js';
// bg import removed — WebGL animation system gone.
import { useAppStore } from '../stores/index.js';
import { getAppActions } from '../stores/index.js';
import { store } from '../store.js';
import { session } from '../session.js';
import { PanelSlot } from '../host/slots/PanelSlot.js';
import { PrefsEntriesSlot } from '../host/slots/PrefsEntriesSlot.js';
import { LAYOUTS } from '../layouts/index.js';
import type { LayoutMode } from '../stores/appStore.js';
import {
  COLOR_THEME_FAMILIES,
  AVATAR_CHOICES,
  avatarColorsEqual,
  parseColorThemeId,
  resolveAvatarColor,
} from '../color-themes-config.js';
import { DESIGN_THEMES } from '../design-themes-config.js';

const EVENT_LABELS: Record<string, string> = {
  'cwd:change':        'Working directory changed',
  'node:executed':     'Node executed',
  'chat:done':         'Chat response received',
  'chat:error':        'Chat error',
  'api:error':         'API / network error',
  'workflow:run':      'Workflow run started',
  'auto-title:titled': 'Session auto-titled (batch summary)',
  'context:categorized':  'Sessions categorized (batch summary)',
  'context:wiki-updated': 'Wiki pages generated (batch summary)',
};

const HISTORY_MODES = ['turns', 'turns_chars', 'split_80_20'] as const;

type CfgVerSnapshot = {
  id: string;
  createdAt: number;
  updatedAt: number;
  changeCount: number;
  label: string;
  files: { name: string; sha256: string; size: number }[];
  trigger: string;
};

type CfgVerListResponse = {
  success: boolean;
  activeProfile: string;
  profiles: string[];
  snapshots: CfgVerSnapshot[];
  dirty: boolean;
  pendingBundle: { since: number; changes: number; willFlushAt: number } | null;
  bundleWindowMs: number;
  maxSnapshots: number;
  versionedFiles: string[];
};

function fmtTime(t: number): string {
  return new Date(t).toLocaleString();
}

function fmtSize(n: number): string {
  if (!n) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function ConfigVersionsSection() {
  const apiBase = api.config.baseUrl;
  const [profiles, setProfiles] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState('');
  const [snapshots, setSnapshots] = useState<CfgVerSnapshot[]>([]);
  const [status, setStatus] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const [loading, setLoading] = useState(true);
  const [snapshotMeta, setSnapshotMeta] = useState<{
    total: number;
    max: number;
    dirty: boolean;
    pendingBundle: CfgVerListResponse['pendingBundle'];
  } | null>(null);
  const labelTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  function showStatus(text: string, isError = false) {
    setStatus(text);
    setStatusErr(isError);
    if (text) {
      setTimeout(() => setStatus((cur) => (cur === text ? '' : cur)), 4000);
    }
  }

  const fetchList = useCallback(async () => {
    try {
      const r = await fetch(apiBase + '/v1/config-versions/list');
      const d = (await r.json()) as CfgVerListResponse;
      if (!d.success) throw new Error('list failed');
      setProfiles(d.profiles);
      setActiveProfile(d.activeProfile);
      setSnapshots(d.snapshots);
      setSnapshotMeta({ total: d.snapshots.length, max: d.maxSnapshots, dirty: d.dirty, pendingBundle: d.pendingBundle });
      setStatus((cur) => {
        if (cur) return cur;
        const parts = [`${d.snapshots.length}/${d.maxSnapshots} snapshots`];
        if (d.dirty) parts.push('● unsaved changes');
        if (d.pendingBundle) {
          const remain = Math.max(0, Math.round((d.pendingBundle.willFlushAt - Date.now()) / 1000));
          parts.push(`bundling ${d.pendingBundle.changes} change${d.pendingBundle.changes === 1 ? '' : 's'} (~${remain}s)`);
        }
        return parts.join(' · ');
      });
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { void fetchList(); }, [fetchList]);

  async function handleProfileChange(target: string) {
    if (!confirm(`Switch to profile "${target}"?\nCurrent config will be auto-snapshotted first if there are unsaved changes, then the latest snapshot of "${target}" will be restored.`)) {
      void fetchList();
      return;
    }
    try {
      const r = await fetch(apiBase + '/v1/config-versions/profiles/' + encodeURIComponent(target) + '/switch', { method: 'POST' });
      const j = (await r.json()) as { success?: boolean; error?: string; note?: string };
      if (j.success) showStatus('✓ Switched. ' + (j.note || ''));
      else showStatus('✗ ' + (j.error || 'switch failed'), true);
      await fetchList();
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  async function handleAddProfile() {
    const name = prompt('New profile name (a-z, 0-9, _, -):');
    if (!name) return;
    try {
      const r = await fetch(apiBase + '/v1/config-versions/profiles/' + encodeURIComponent(name), { method: 'POST' });
      const j = (await r.json()) as { success?: boolean; error?: string };
      if (j.success) { showStatus('✓ Profile created'); await fetchList(); }
      else showStatus('✗ ' + (j.error || 'create failed'), true);
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  async function handleDeleteProfile() {
    if (!activeProfile) return;
    if (!confirm(`Delete profile "${activeProfile}" and all of its snapshots? Active profile cannot be deleted.`)) return;
    try {
      const r = await fetch(apiBase + '/v1/config-versions/profiles/' + encodeURIComponent(activeProfile), { method: 'DELETE' });
      const j = (await r.json()) as { success?: boolean; error?: string };
      if (j.success) { showStatus('✓ Profile deleted'); await fetchList(); }
      else showStatus('✗ ' + (j.error || 'delete failed'), true);
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  async function handleRestore(s: CfgVerSnapshot) {
    if (!confirm(`Restore snapshot from ${fmtTime(s.createdAt)}?\nCurrent config will be auto-snapshotted first.`)) return;
    try {
      const r = await fetch(apiBase + '/v1/config-versions/restore/' + encodeURIComponent(s.id), { method: 'POST' });
      const j = (await r.json()) as { success?: boolean; error?: string; note?: string };
      if (j.success) showStatus('✓ Restored. ' + (j.note || ''));
      else showStatus('✗ ' + (j.error || 'restore failed'), true);
      await fetchList();
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  async function handleDelete(s: CfgVerSnapshot) {
    if (!confirm('Delete this snapshot? This cannot be undone.')) return;
    try {
      const r = await fetch(apiBase + '/v1/config-versions/' + encodeURIComponent(s.id), { method: 'DELETE' });
      const j = (await r.json()) as { success?: boolean; error?: string };
      if (j.success) { showStatus('✓ Deleted'); await fetchList(); }
      else showStatus('✗ ' + (j.error || 'delete failed'), true);
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  async function saveLabel(id: string, label: string) {
    try {
      await fetch(apiBase + '/v1/config-versions/label/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      showStatus('✓ Label saved');
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  function handleLabelInput(id: string, label: string) {
    if (labelTimers.current[id]) clearTimeout(labelTimers.current[id]);
    labelTimers.current[id] = setTimeout(() => { void saveLabel(id, label); }, 700);
  }

  function handleLabelBlur(id: string, label: string) {
    if (labelTimers.current[id]) clearTimeout(labelTimers.current[id]);
    void saveLabel(id, label);
  }

  async function handleTestDefaults() {
    if (!confirm('Reset all internal config files to defaults?\nThis simulates a fresh installation. Your current config will be auto-snapshotted first so you can restore it from the list.\n\nNote: a bridge restart is recommended after the reset.')) return;
    try {
      const r = await fetch(apiBase + '/v1/config-versions/test-defaults', { method: 'POST' });
      const j = (await r.json()) as { success?: boolean; note?: string; error?: string };
      if (j.success) showStatus('✓ ' + (j.note || 'Reset to defaults'));
      else showStatus('✗ ' + (j.error || 'failed'), true);
      await fetchList();
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    }
  }

  void snapshotMeta;

  return (
    <section className="prefs-section" data-view="advanced">
      <h4 className="prefs-sec">Configuration Versioning</h4>
      <div className="prefs-hint" style={{ marginBottom: 8 }}>
        Internal config files are auto-snapshotted by the bridge. Any edits within a 5-minute window are bundled into one snapshot; the last 50 snapshots per profile are kept. Your <code>.env</code> file and API keys are never included.
      </div>
      <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Profile</label>
        <select
          className="prefs-select"
          style={{ minWidth: 160 }}
          value={activeProfile}
          onChange={(e) => { void handleProfileChange(e.target.value); }}
        >
          {profiles.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <button className="prefs-btn" title="Create a new profile (initialised from current config)" onClick={() => { void handleAddProfile(); }}>+ New</button>
        <button className="prefs-btn" title="Delete the selected profile" onClick={() => { void handleDeleteProfile(); }}>Delete</button>
      </div>
      <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <button className="prefs-btn-danger" title="Wipe configs to example/empty defaults — current state is auto-snapshotted first" onClick={() => { void handleTestDefaults(); }}>Reset to defaults (test fresh install)</button>
        <span className="prefs-hint" style={{ margin: 0, flex: 1, color: statusErr ? 'var(--err, #f66)' : 'var(--fg-dim)' }}>{status}</span>
      </div>
      <div className="prefs-hint" style={{ marginTop: 12, textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 10, color: 'var(--fg-mute)' }}>Snapshots (newest first)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, maxHeight: 340, overflowY: 'auto', border: '1px solid var(--stroke)', borderRadius: 'var(--radius-sm)', padding: 6, background: 'var(--bg-2)' }}>
        {loading ? (
          <div className="prefs-hint" style={{ margin: 6 }}>Loading…</div>
        ) : snapshots.length === 0 ? (
          <div className="prefs-hint" style={{ margin: 8 }}>No snapshots yet — make a config change or click "Snapshot now".</div>
        ) : snapshots.map((s) => {
          const total = s.files.reduce((acc, f) => acc + (f.size || 0), 0);
          const filledFiles = s.files.filter((f) => f.sha256).length;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--radius-xs)', background: 'var(--bg)', border: '1px solid var(--stroke)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{fmtTime(s.createdAt)}</span>
                  {s.trigger !== 'auto' && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'var(--bg)', color: 'var(--fg-dim)', marginLeft: 6 }}>{s.trigger}</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>· {s.changeCount} change{s.changeCount === 1 ? '' : 's'} · {filledFiles}/{s.files.length} files · {fmtSize(total)}</span>
                </div>
                <input
                  className="prefs-input"
                  type="text"
                  placeholder="Optional label…"
                  defaultValue={s.label}
                  onInput={(e) => handleLabelInput(s.id, (e.target as HTMLInputElement).value)}
                  onBlur={(e) => handleLabelBlur(s.id, e.target.value)}
                  style={{ marginTop: 4, width: '100%', fontSize: 11, background: 'transparent', border: '1px solid transparent', padding: '2px 4px' }}
                />
              </div>
              <button className="prefs-btn" title="Restore this snapshot to live config" onClick={() => { void handleRestore(s); }}>Restore</button>
              <button className="prefs-btn" title="Delete this snapshot" style={{ color: 'var(--err, #f66)' }} onClick={() => { void handleDelete(s); }}>✕</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Per-folder YPA permission ("YOLO") mode selector. Compact control that sits beside
// each directory's action button. Only Y.O.L.O. is wired up today; the safer modes are
// disabled placeholders. This per-folder control is also where net-node folder sharing
// will eventually be configured.
function YoloModeSelect() {
  return (
    <select
      className="prefs-select"
      style={{ width: 132, flexShrink: 0 }}
      value="yolo"
      title="Per-folder YPA mode. Net-node folder sharing will also live here."
      onChange={() => { /* the safer permission modes are not wired up yet */ }}
    >
      <option value="yolo">Y.O.L.O.</option>
      <option value="ask" disabled>Ask only</option>
      <option value="ask_memorize" disabled>Ask and memorize</option>
    </select>
  );
}

export function TabSystem() {
  const apiBase = api.config.baseUrl;
  const currentSession = useAppStore((s) => s.currentSession);
  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const appColorTheme = useAppStore((s) => s.colorTheme);
  const appDesignTheme = useAppStore((s) => s.designTheme);
  const appLayoutMode = useAppStore((s) => s.layoutMode);
  const userName = useAppStore((s) => s.userName);
  const userSymbolColor = useAppStore((s) => s.userSymbolColor);
  const enterToSend = useAppStore((s) => s.enterToSend);

  const toastCfg = (toast.getCfg() || {}) as unknown as Record<string, unknown>;
  const tEvents = (toastCfg.events || {}) as Record<string, boolean>;

  const [stdDir, setStdDir] = useState('');
  const [stdDirPlaceholder, setStdDirPlaceholder] = useState('(loading…)');
  const [resolvedHome, setResolvedHome] = useState('');
  const [stdHint, setStdHint] = useState('Applied to newly created sessions. Existing sessions keep their own directory.');
  const [additionalDirs, setAdditionalDirs] = useState<string[]>([]);
  const [additionalDirsHint, setAdditionalDirsHint] = useState('');
  const [workingDir, setWorkingDir] = useState(sessionWorkingDir || '');
  const [dirHint, setDirHint] = useState('');

  const [historyMode, setHistoryMode] = useState('turns');
  const [historyMaxTurns, setHistoryMaxTurns] = useState('8');
  const [historyMaxChars, setHistoryMaxChars] = useState('8000');
  const [historyHint, setHistoryHint] = useState('');

  const [toastEnabled, setToastEnabled] = useState(toastCfg.enabled !== false);
  const [toastPos, setToastPos] = useState((toastCfg.position as string) || 'bottom-right');
  const [toastEvents, setToastEvents] = useState<Record<string, boolean>>(tEvents);

  const [logEnabled, setLogEnabled] = useState(true);
  const [logHint, setLogHint] = useState('Each API call and response is saved to its own file, organised by chat session.');

  // Auto-title + per-stage pipeline toggles MOVED on 2026-05-06 to the
  // Context Generator modal (header button → ⚙ Settings tab). The previous
  // sections + state hooks lived here under the "Auto-title sessions" and
  // "Context pipeline stages" headings. The migration was per user request:
  // "hol die eigenschaften des Context Generator aus dem system tab in
  //  preferences in die context generator modal Settings". Keeping the move
  // pure (no duplicate UI here) preserves a single source of truth and
  // avoids two surfaces drifting apart on hint/state.

  // bgTheme / bgHint removed — WebGL animations were removed due to GPU overhead.

  const parsedColorTheme = parseColorThemeId(appColorTheme);

  const stdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addDirsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(apiBase + '/v1/logging');
        const d = (await r.json()) as { enabled?: boolean };
        setLogEnabled(d.enabled !== false);
      } catch { }
    })();
  }, [apiBase]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(apiBase + '/v1/config/');
        const d = (await r.json()) as { config?: { defaults?: Record<string, unknown>; homeDir?: string } };
        const sd = (d.config?.defaults?.workingDir as string) || '';
        const home = (d.config?.homeDir as string) || '';
        const wds = Array.isArray(d.config?.defaults?.workingDirs)
          ? (d.config?.defaults?.workingDirs as string[]).filter((s) => typeof s === 'string')
          : [];
        const mt = parseInt(d.config?.defaults?.chat_history_max_turns as string, 10);
        const mc = parseInt(d.config?.defaults?.chat_history_max_chars as string, 10);
        const mm = String(d.config?.defaults?.chat_history_mode || 'turns');
        setStdDir(sd);
        setResolvedHome(home);
        setAdditionalDirs(wds);
        setStdDirPlaceholder(sd ? '' : (home || '(user home directory)'));
        if (Number.isFinite(mt) && mt > 0) setHistoryMaxTurns(String(mt));
        if (Number.isFinite(mc) && mc > 0) setHistoryMaxChars(String(mc));
        if (HISTORY_MODES.includes(mm as typeof HISTORY_MODES[number])) setHistoryMode(mm);
        // Auto-title + categorizer + sorter config moved to the Context
        // Generator modal (Hub > ⚙ Settings) on 2026-05-06.
      } catch {
        setStdDirPlaceholder('(failed to load)');
      }
    })();
  }, [apiBase]);

  async function applyWorkingDir(dirVal: string) {
    const sid = String(currentSession || 'default');
    // session.setWorkingDir handles the full sync (server PATCH + _cache
    // update + appStore mirror). Skipping the cache update here would leave
    // the SessionPoller's next 4 s tick to overwrite appStore back to the
    // stale value — see session.ts comment on setWorkingDir.
    const d = await session.setWorkingDir(sid, dirVal || null);
    if (d.success) {
      setWorkingDir(d.workingDir || '');
      setDirHint(`✓ Set to: ${d.workingDir || '(server default)'}`);
    } else {
      setDirHint(`✗ ${d.error}`);
    }
  }

  async function applyStandardDir(dirVal: string) {
    try {
      const r = await fetch(apiBase + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { workingDir: dirVal || '' } }),
      });
      const d = (await r.json()) as { success?: boolean; defaults?: { workingDir?: string }; error?: string };
      if (d.success) {
        const saved = d.defaults?.workingDir || '';
        setStdDir(saved);
        setStdDirPlaceholder(saved ? '' : (resolvedHome || '(user home directory)'));
        setStdHint(saved ? `✓ Standard set to: ${saved}` : `✓ Standard cleared — new sessions use ${resolvedHome || 'user home directory'}`);
      } else {
        setStdHint(`✗ ${d.error || 'failed'}`);
      }
    } catch (e) {
      setStdHint(`✗ ${(e as Error).message}`);
    }
  }

  async function applyAdditionalDirs(dirs: string[]) {
    const cleaned = dirs.map((s) => (s || '').trim()).filter(Boolean);
    try {
      const r = await fetch(apiBase + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { workingDirs: cleaned } }),
      });
      const d = (await r.json()) as { success?: boolean; defaults?: { workingDirs?: string[] }; error?: string };
      if (d.success) {
        const saved = Array.isArray(d.defaults?.workingDirs) ? d.defaults!.workingDirs! : [];
        setAdditionalDirs(saved);
        setAdditionalDirsHint(saved.length ? `✓ Saved ${saved.length} additional folder${saved.length === 1 ? '' : 's'}` : '✓ Cleared additional folders');
      } else {
        setAdditionalDirsHint(`✗ ${d.error || 'failed'}`);
      }
    } catch (e) {
      setAdditionalDirsHint(`✗ ${(e as Error).message}`);
    }
  }

  function scheduleAdditionalDirsSave(next: string[]) {
    if (addDirsTimer.current) clearTimeout(addDirsTimer.current);
    addDirsTimer.current = setTimeout(() => { void applyAdditionalDirs(next); }, 600);
  }

  async function applyHistoryPolicy(mode: string, turns: string, chars: string) {
    const turnsNum = parseInt(turns, 10);
    const charsNum = parseInt(chars, 10);
    if (!Number.isFinite(turnsNum) || turnsNum < 1 || turnsNum > 100) {
      setHistoryHint('✗ Max turns must be 1-100');
      return;
    }
    if (!Number.isFinite(charsNum) || charsNum < 100) {
      setHistoryHint('✗ Max chars must be at least 100');
      return;
    }
    if (!HISTORY_MODES.includes(mode as typeof HISTORY_MODES[number])) {
      setHistoryHint('✗ Invalid history mode');
      return;
    }
    try {
      const r = await fetch(apiBase + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { chat_history_mode: mode, chat_history_max_turns: turnsNum, chat_history_max_chars: charsNum } }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      if (d.success) {
        setHistoryHint(`✓ Chat history policy saved (${mode}, ${turnsNum} turns, ${charsNum} chars)`);
      } else {
        setHistoryHint(`✗ ${d.error || 'failed'}`);
      }
    } catch (e) {
      setHistoryHint(`✗ ${(e as Error).message}`);
    }
  }

  function scheduleHistorySave(mode: string, turns: string, chars: string, immediate = false) {
    if (histTimer.current) clearTimeout(histTimer.current);
    if (immediate) { void applyHistoryPolicy(mode, turns, chars); return; }
    histTimer.current = setTimeout(() => { void applyHistoryPolicy(mode, turns, chars); }, 600);
  }

  const userLetter = ((userName || 'U')[0] || 'U').toUpperCase();
  const resolvedColor = userSymbolColor ? resolveAvatarColor(userSymbolColor) : 'var(--accent-2)';

  async function handleTestBase() {
    try {
      const r = await fetch(apiBase + '/health');
      const d = (await r.json()) as { ok?: boolean };
      alert(d.ok ? 'OK ✓' : 'Unexpected response');
    } catch {
      alert('Failed ✗');
    }
  }

  async function handleLogChange(checked: boolean) {
    setLogEnabled(checked);
    try {
      const r = await fetch(apiBase + '/v1/logging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked }),
      });
      const d = (await r.json()) as { enabled?: boolean };
      setLogHint(d.enabled ? '✓ Logging enabled' : '✓ Logging disabled');
      setTimeout(() => setLogHint('Each API call and response is saved to its own file, organised by chat session.'), 2000);
    } catch (e) {
      setLogHint(`✗ ${(e as Error).message}`);
    }
  }

  return (
    <>
      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Bridge server</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Server URL</label>
          <div className="prefs-input flex1" style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>{apiBase}</div>
          <button className="prefs-btn" onClick={() => { void handleTestBase(); }}>Test</button>
        </div>
        <div className="prefs-hint">Derived automatically from the current app URL.</div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Working directory</h4>
        <div className="prefs-hint">Each folder has its own YPA mode (next to its button). Only <code>Y.O.L.O.</code> is available today — <code>Ask only</code> and <code>Ask and memorize</code> are coming soon.</div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }} title="Used when new sessions are created">Standard</label>
          <input
            className="prefs-input flex1"
            type="text"
            value={stdDir}
            placeholder={stdDirPlaceholder || '(user home directory)'}
            onChange={(e) => {
              setStdDir(e.target.value);
              if (stdTimer.current) clearTimeout(stdTimer.current);
              stdTimer.current = setTimeout(() => { void applyStandardDir(e.target.value.trim()); }, 600);
            }}
            onBlur={(e) => {
              if (stdTimer.current) clearTimeout(stdTimer.current);
              void applyStandardDir(e.target.value.trim());
            }}
          />
          <YoloModeSelect />
          <button className="prefs-btn" title="Clear standard — fall back to user home directory" onClick={() => {
            if (stdTimer.current) clearTimeout(stdTimer.current);
            setStdDir('');
            void applyStandardDir('');
          }}>Clear</button>
        </div>
        <div className="prefs-hint">{stdHint}</div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Current session</label>
          <input
            className="prefs-input flex1"
            type="text"
            value={workingDir}
            placeholder="(uses standard)"
            onChange={(e) => {
              setWorkingDir(e.target.value);
              if (wdTimer.current) clearTimeout(wdTimer.current);
              wdTimer.current = setTimeout(() => { void applyWorkingDir(e.target.value.trim()); }, 600);
            }}
            onBlur={(e) => {
              if (wdTimer.current) clearTimeout(wdTimer.current);
              void applyWorkingDir(e.target.value.trim());
            }}
          />
          <button className="prefs-btn" title="Reset to standard" onClick={() => {
            if (wdTimer.current) clearTimeout(wdTimer.current);
            setWorkingDir('');
            void applyWorkingDir('');
          }}>Reset</button>
        </div>
        <div className="prefs-hint">{dirHint}</div>

        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 12 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }} title="Extra folders surfaced in the file picker scope dropdown">Additional</label>
          <div className="flex1" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {additionalDirs.map((dir, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  className="prefs-input flex1"
                  type="text"
                  value={dir}
                  placeholder="/absolute/path/to/folder"
                  onChange={(e) => {
                    const next = additionalDirs.slice();
                    next[idx] = e.target.value;
                    setAdditionalDirs(next);
                    scheduleAdditionalDirsSave(next);
                  }}
                  onBlur={() => {
                    if (addDirsTimer.current) clearTimeout(addDirsTimer.current);
                    void applyAdditionalDirs(additionalDirs);
                  }}
                />
                <YoloModeSelect />
                <button
                  className="prefs-btn"
                  title="Remove this folder"
                  onClick={() => {
                    const next = additionalDirs.filter((_, i) => i !== idx);
                    setAdditionalDirs(next);
                    if (addDirsTimer.current) clearTimeout(addDirsTimer.current);
                    void applyAdditionalDirs(next);
                  }}
                >Remove</button>
              </div>
            ))}
            <div>
              <button
                className="prefs-btn"
                onClick={() => {
                  const next = [...additionalDirs, ''];
                  setAdditionalDirs(next);
                }}
              >+ Add folder</button>
            </div>
          </div>
        </div>
        <div className="prefs-hint">{additionalDirsHint || 'Extra folders for the file picker scope dropdown. The standard above is always available.'}</div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Chat history</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }} title="How bridge history is trimmed before being sent to models">Mode</label>
          <select
            className="prefs-select"
            style={{ maxWidth: 320 }}
            value={historyMode}
            onChange={(e) => {
              setHistoryMode(e.target.value);
              scheduleHistorySave(e.target.value, historyMaxTurns, historyMaxChars, true);
            }}
          >
            <option value="turns">1) Keep last X turns only</option>
            <option value="turns_chars">2) Keep last X turns + max chars from newest backward</option>
            <option value="split_80_20">3) Keep last X turns + max chars split 20% start / 80% recent</option>
          </select>
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }} title="Shared bridge history used for context handoff between model paths">Max turns</label>
          <input
            className="prefs-input"
            type="number"
            min={1}
            step={1}
            value={historyMaxTurns}
            placeholder="8"
            style={{ maxWidth: 120 }}
            onChange={(e) => {
              setHistoryMaxTurns(e.target.value);
              scheduleHistorySave(historyMode, e.target.value, historyMaxChars);
            }}
            onBlur={(e) => scheduleHistorySave(historyMode, e.target.value, historyMaxChars, true)}
          />
          <label className="prefs-field-lbl" style={{ minWidth: 90 }} title="Character budget used by history modes 2 and 3">Max chars</label>
          <input
            className="prefs-input"
            type="number"
            min={100}
            step={100}
            value={historyMaxChars}
            placeholder="8000"
            style={{ maxWidth: 140 }}
            onChange={(e) => {
              setHistoryMaxChars(e.target.value);
              scheduleHistorySave(historyMode, historyMaxTurns, e.target.value);
            }}
            onBlur={(e) => scheduleHistorySave(historyMode, historyMaxTurns, e.target.value, true)}
          />
          <button className="prefs-btn" onClick={() => {
            setHistoryMaxTurns('8');
            setHistoryMaxChars('8000');
            setHistoryMode('turns');
            void applyHistoryPolicy('turns', '8', '8000');
          }}>Reset</button>
        </div>
        <div className="prefs-hint">{historyHint}</div>
      </section>

      {/* ── Context Generator settings — moved to ContextHub > ⚙ Settings ─────
          The "Auto-title sessions" + "Context pipeline stages" sections used
          to live here. They migrated to the Context Generator modal on
          2026-05-06 so all pipeline-related controls (toggles, model/provider,
          run-now, force-rebuild) live next to the live status dashboard.
          Open the modal with Alt+C or the header "Context" button. */}
      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Context Generator pipeline</h4>
        <div className="prefs-hint" style={{ marginBottom: 8 }}>
          Auto-title, Categorizer, and Sorter settings — including model/provider,
          enable toggles, manual run-now, and force-rebuild — moved to the
          Context Generator modal.
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            className="prefs-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('yha:open-context-hub'))}
          >
            Open Context Generator (Alt+C)
          </button>
          <span className="prefs-hint" style={{ margin: 0 }}>
            …or click the <code>Context</code> button in the header.
          </span>
        </div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Toast notifications</h4>
        {/* Row 1: Enabled toggle + Position selector */}
        <div className="prefs-toast-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <input
              type="checkbox"
              id="prefs-toast-enabled"
              checked={toastEnabled}
              style={{ accentColor: 'var(--accent)', width: 14, height: 14, cursor: 'pointer' }}
              onChange={(e) => {
                setToastEnabled(e.target.checked);
                toast.setCfg({ enabled: e.target.checked });
              }}
            />
            <label htmlFor="prefs-toast-enabled" style={{ fontSize: '.82rem', color: 'var(--fg-dim)', cursor: 'pointer' }}>Enabled</label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <label htmlFor="prefs-toast-pos" style={{ fontSize: '.82rem', color: 'var(--fg-mute)', whiteSpace: 'nowrap' }}>Position</label>
            <select
              className="prefs-select"
              id="prefs-toast-pos"
              style={{ maxWidth: 160 }}
              value={toastPos}
              onChange={(e) => {
                setToastPos(e.target.value);
                toast.setCfg({ position: e.target.value });
              }}
            >
              {['bottom-right', 'bottom-left', 'bottom-center', 'top-right'].map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
        </div>
        {/* Events grid — 3 columns */}
        <div className="prefs-col-lbl" style={{ marginTop: 4 }}>Events</div>
        <div className="prefs-toast-events">
          {Object.entries(EVENT_LABELS).map(([key, label]) => (
            <label key={key} className="prefs-toast-event">
              <input
                type="checkbox"
                checked={toastEvents[key] !== false}
                onChange={(e) => {
                  const cur = toast.getCfg() || {};
                  const events = { ...(cur.events || {}), [key]: e.target.checked };
                  toast.setCfg({ events });
                  setToastEvents((prev) => ({ ...prev, [key]: e.target.checked }));
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">API Logging</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="prefs-log-enabled"
            checked={logEnabled}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            onChange={(e) => { void handleLogChange(e.target.checked); }}
          />
          <label htmlFor="prefs-log-enabled" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}>
            Enable raw call/response logging (per-session folders in <code>bridge/api-inout-log/</code>)
          </label>
        </div>
        <div className="prefs-hint">{logHint}</div>
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">User identity</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 12 }}>
          <span
            className="pers-tile-av"
            style={{ width: 36, height: 36, fontSize: 14, background: resolvedColor }}
          >{userLetter}</span>
          <div className="pers-tile-info" style={{ flex: 1 }}>
            <span className="pers-tile-name">{userName || 'Signed-in user'}</span>
            <span className="pers-tile-role">Letter is taken from your signed-in name.</span>
          </div>
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }}>Letter color</label>
          <div className="pers-color-pick">
            {AVATAR_CHOICES.map(({ value, label, swatchBg }) => (
              <button
                key={value}
                type="button"
                className={'pers-color-swatch' + (avatarColorsEqual(value, userSymbolColor) ? ' selected' : '')}
                title={label}
                style={{ background: swatchBg }}
                onClick={() => {
                  getAppActions().setUserSymbolColor(value);
                }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">Keyboard shortcuts</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
          <button className="prefs-btn" onClick={() => window.dispatchEvent(new CustomEvent('yha:open-shortcuts'))}>Show all shortcuts</button>
          <span className="prefs-hint" style={{ margin: 0 }}>…or press <code>Alt+K</code> anywhere.</span>
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            type="checkbox"
            id="prefs-enter-to-send"
            checked={enterToSend}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            onChange={(e) => { store.set('enterToSend', e.target.checked); }}
          />
          <label htmlFor="prefs-enter-to-send" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}>
            Send on <code>Enter</code> — uncheck to send on <code>Ctrl+Enter</code> and use plain <code>Enter</code> for new lines
          </label>
        </div>
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">Appearance &amp; Layout</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <label className="prefs-field-lbl" style={{ minWidth: 80 }} title="Visual design language — composes with the color theme and layout below">Design</label>
          <select
            className="prefs-select flex1"
            value={appDesignTheme}
            onChange={(e) => { designTheme.set(e.target.value); }}
          >
            {DESIGN_THEMES.map((d) => (
              <option key={d.id} value={d.id}>{d.icon} {d.name} — {d.description}</option>
            ))}
          </select>
        </div>
        <div className="prefs-cols3">
          <div className="prefs-col">
            <div className="prefs-col-lbl">Layout</div>
            <select
              className="prefs-select"
              style={{ width: '100%' }}
              value={appLayoutMode}
              onChange={(e) => { getAppActions().setLayoutMode(e.target.value as LayoutMode); }}
            >
              {Object.values(LAYOUTS).map((meta) => (
                <option key={meta.id} value={meta.id}>{meta.label}</option>
              ))}
            </select>
          </div>
          <div className="prefs-col">
            <div className="prefs-col-lbl">Color theme family</div>
            <select
              className="prefs-select"
              style={{ width: '100%' }}
              value={parsedColorTheme.family}
              onChange={(e) => { colorTheme?.setFamily?.(e.target.value); }}
            >
              {COLOR_THEME_FAMILIES.map((t) => (
                <option key={t.id} value={t.id}>{t.icon} {t.name}</option>
              ))}
            </select>
          </div>
          <div className="prefs-col">
            <div className="prefs-col-lbl">Variant</div>
            <select
              className="prefs-select"
              style={{ width: '100%' }}
              value={parsedColorTheme.variant}
              onChange={(e) => { colorTheme?.setVariant?.(e.target.value as 'dark' | 'bright'); }}
            >
              <option value="dark">🌙 Dark</option>
              <option value="bright">☀ Bright</option>
            </select>
          </div>
        </div>
        <PanelSlot id="prefs-appearance-pet" />

        <div className="prefs-row" style={{ marginTop: 8 }}>
          <button
            className="prefs-btn-danger"
            style={{ width: '100%' }}
            onClick={() => {
              if (confirm('Clear ALL local settings and data? (color theme, costs, hidden models, workflows, etc.)')) {
                const keep = ['yha.currentSession'];
                const keys = Object.keys(localStorage).filter((k) => k.startsWith('yha.') && !keep.includes(k));
                keys.forEach((k) => localStorage.removeItem(k));
                location.reload();
              }
            }}
          >Clear all local data</button>
        </div>
      </section>

      <ConfigVersionsSection />

      <PrefsEntriesSlot tab="system" heading="Module settings" />
    </>
  );
}
