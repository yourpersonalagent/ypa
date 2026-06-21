// HubLinkTab — Obsidian-vault sync dashboard + API-key UI.
// Phase 3.4 (frontend, full surface) — companion of the slim StageCard
// summary in HubGeneratorTab. Where the Generator-tab card answers
// "is LINK working?" at a glance, this tab is where the user actually
// configures the adapter, pastes the API key, sees per-folder policies,
// and inspects last-run errors.
//
// Backend wiring: GET /v1/config/link/status, POST /v1/config/link/run-now,
// POST /v1/config/link/test-ping, POST /v1/config/link/secrets. SSE
// `link:synced` triggers an immediate refresh so the Test-ping button +
// last-run row update without waiting for the 5-second poll.
//
// What this tab deliberately does NOT do:
//   • Edit `config.defaults.contextLink.*` (vaultRoot, syncDirs, policies,
//     syncIntervalMs, sensitivity) — those still go through the standard
//     `/v1/config` PATCH path, kept on disk under config-history. The tab
//     surfaces the current values read-only with a "edit in config.json"
//     hint. Reason: the audit trail for config changes is more important
//     than a fancy form — and the user only sets these once per machine.

import { useEffect, useState } from 'react';
import { api } from '../api.js';

interface LinkRunError {
  path:  string;
  error: string;
}

interface LinkRunStats {
  pushed?:       number;
  pulled?:       number;
  conflicts?:    number;
  errors?:       LinkRunError[];
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
  obsidianHost?:      string;
  syncIntervalMs?:    number;
  syncSensitivity?:   { public?: boolean; private?: boolean; system?: boolean };
}

const ADAPTER_KINDS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'mock',          label: 'mock (dry-run)',         hint: 'In-memory stub. Always reachable. No data leaves the bridge — useful for verifying the pipeline without real credentials.' },
  { value: 'obsidian-rest', label: 'obsidian-rest',          hint: 'Local REST API plugin in Obsidian. Requires the plugin running on your desktop, an API key, and a host the bridge can reach.' },
];

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

function _formatWhen(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000)            return `${Math.round(diffMs / 1_000)} s ago`;
  if (diffMs < 60 * 60_000)       return `${Math.round(diffMs / 60_000)} min ago`;
  if (diffMs < 24 * 60 * 60_000)  return `${Math.round(diffMs / (60 * 60_000))} h ago`;
  return new Date(ts).toLocaleString();
}

function _policyHint(p: string | undefined): string {
  switch (p) {
    case 'server-wins':   return 'Server overwrites desktop. Use for Sorter-output you never edit on the desktop.';
    case 'desktop-wins':  return 'Desktop overwrites server. Use for vault-only material you never edit on the server.';
    case 'newest-wins':   return 'Most-recent mtime wins. Convenient but can lose work if clocks drift.';
    case 'preserve-both': return 'Conflict creates `<name>.conflict-<host>.md`. Safest, never loses content.';
    default:              return '';
  }
}

// Match the bridge's PUSH_ONLY_DIRS Set so the table can label these rows
// explicitly. Keeping this list in two places is acceptable — the docs/generated
// folder is conceptually one-way (Sorter regen target) and won't grow.
const PUSH_ONLY_DIRS = new Set(['docs/generated']);

export function HubLinkTab() {
  const [link,    setLink]    = useState<LinkStatus>({});
  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // API-key form. We never read the live key back from the server — only the
  // masked fingerprint. The text field is empty on mount and stays empty
  // unless the user types; saving an empty string clears the secret.
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeyBusy,  setApiKeyBusy]  = useState(false);
  const [apiKeyMsg,   setApiKeyMsg]   = useState<string | null>(null);

  // Adapter / host / vault-root settings form (Phase 3.4c). Decoupled from
  // the live status so the user can edit fields without the 5-s poll
  // clobbering their input. We seed the drafts from `link` on first load
  // and re-sync only when the user explicitly resets — see `useEffect` below.
  const [draftEnabled,    setDraftEnabled]    = useState<boolean>(true);
  const [draftAdapter,    setDraftAdapter]    = useState<string>('mock');
  const [draftHost,       setDraftHost]       = useState<string>('');
  const [draftVaultRoot,  setDraftVaultRoot]  = useState<string>('');
  const [draftIntervalSec, setDraftIntervalSec] = useState<string>('300');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMsg,  setSettingsMsg]  = useState<string | null>(null);
  const [hydrated,     setHydrated]     = useState(false);

  // Vault-folder import (Phase 3.4d). One-shot scoop of an arbitrary vault
  // folder into a server-side category dir (typically docs/keep-notes/).
  // After a successful run the syncDirs override is persisted so the
  // watchdog keeps the folder in sync going forward.
  const [importVaultPath,  setImportVaultPath]  = useState<string>('Google Keep');
  const [importServerDir,  setImportServerDir]  = useState<string>('docs/keep-notes');
  const [importTier,       setImportTier]       = useState<'public' | 'private'>('public');
  const [importBusy,       setImportBusy]       = useState(false);
  const [importMsg,        setImportMsg]        = useState<string | null>(null);
  const [importPreview,    setImportPreview]    = useState<{ total: number; files: string[] } | null>(null);

  async function loadStatus() {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/link/status`);
      const j = await r.json();
      if (j?.ok) setLink(j as LinkStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void loadStatus();
    const t = setInterval(() => void loadStatus(), 5_000);
    const onLink = () => { void loadStatus(); };
    window.addEventListener('yha:link:synced', onLink as EventListener);
    return () => {
      clearInterval(t);
      window.removeEventListener('yha:link:synced', onLink as EventListener);
    };
  }, []);

  // One-shot hydration of the settings form from the first /status response.
  // We intentionally do NOT re-sync from `link` on subsequent polls — that
  // would clobber whatever the user just typed mid-edit.
  useEffect(() => {
    if (hydrated) return;
    if (link.adapterKind === undefined) return;          // still loading
    setDraftEnabled(link.enabled !== false);
    setDraftAdapter(link.adapterKind || 'mock');
    setDraftHost(link.obsidianHost || '');
    setDraftVaultRoot(link.vaultRoot || '');
    setDraftIntervalSec(String(Math.max(30, Math.round((link.syncIntervalMs ?? 300_000) / 1_000))));
    setHydrated(true);
  }, [link, hydrated]);

  // Did the user actually change anything? Drives the Save button's enabled
  // state and the "unsaved changes" hint.
  const settingsDirty =
    hydrated && (
      (link.enabled !== false) !== draftEnabled ||
      (link.adapterKind || 'mock') !== draftAdapter ||
      (link.obsidianHost || '') !== draftHost.trim() ||
      (link.vaultRoot || '') !== draftVaultRoot.trim() ||
      String(Math.max(30, Math.round((link.syncIntervalMs ?? 300_000) / 1_000))) !== draftIntervalSec.trim()
    );

  async function saveSettings() {
    const url = _baseUrl();
    if (!url) return;
    setSettingsBusy(true);
    setSettingsMsg(null);

    // Client-side guard rails — keep the server's 400s rare so the UX is
    // calm. The server still re-validates (defence in depth).
    const host = draftHost.trim();
    if (host && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(host)) {
      setSettingsMsg('Host must look like `http://host` or `http://host:27123` (no trailing slash, no path).');
      setSettingsBusy(false);
      return;
    }
    const vault = draftVaultRoot.trim().replace(/^\/+|\/+$/g, '');
    if (vault && (!/^[A-Za-z0-9._\-/]+$/.test(vault) || vault.split('/').some(seg => seg === '..' || seg === ''))) {
      setSettingsMsg('Vault root may only contain letters, digits, dot, underscore, dash, slash. No `..`.');
      setSettingsBusy(false);
      return;
    }
    const ivSec = parseInt(draftIntervalSec, 10);
    if (!Number.isFinite(ivSec) || ivSec < 30 || ivSec > 86_400) {
      setSettingsMsg('Sync interval must be between 30 seconds and 86400 (24 h).');
      setSettingsBusy(false);
      return;
    }

    const patch: Record<string, unknown> = {
      enabled:        draftEnabled,
      adapter:        draftAdapter,
      obsidianHost:   host,                       // empty string clears it (server falls back to default)
      vaultRoot:      vault,
      syncIntervalMs: ivSec * 1_000,
    };

    try {
      const r = await fetch(`${url}/v1/config/`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ defaults: { contextLink: patch } }),
      });
      const j = await r.json();
      if (!j?.success) {
        setSettingsMsg(`Save failed: ${j?.error || 'request failed'}`);
      } else {
        setSettingsMsg('Settings saved. Hit "Test ping" to verify the adapter.');
        // Re-hydrate from the freshly-persisted server view so any normalisation
        // (trailing slashes, host fallback) is reflected back into the form.
        setHydrated(false);
        await loadStatus();
      }
    } catch (e) {
      setSettingsMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSettingsBusy(false);
      setTimeout(() => setSettingsMsg(null), 8_000);
    }
  }

  function resetSettings() {
    setDraftEnabled(link.enabled !== false);
    setDraftAdapter(link.adapterKind || 'mock');
    setDraftHost(link.obsidianHost || '');
    setDraftVaultRoot(link.vaultRoot || '');
    setDraftIntervalSec(String(Math.max(30, Math.round((link.syncIntervalMs ?? 300_000) / 1_000))));
    setSettingsMsg(null);
  }

  async function syncNow() {
    const url = _baseUrl();
    if (!url) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const r = await fetch(`${url}/v1/config/link/run-now`, { method: 'POST' });
      const j = await r.json();
      if (!j?.ok) {
        setActionMsg(`Sync now: ${j?.error || 'request failed'}`);
      } else if (j.kicked) {
        setActionMsg('Sync started — watch the last-run row for results.');
      } else if (j.reason === 'already-running') {
        setActionMsg('Sync is already in progress.');
      } else if (j.reason === 'disabled') {
        setActionMsg('LINK is disabled. Enable it in config.json (`defaults.contextLink.enabled = true`) and restart the bridge.');
      } else {
        setActionMsg(`Sync now: ${j.reason || 'no-op'}.`);
      }
      await loadStatus();
    } catch (e) {
      setActionMsg(`Sync now: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 6_000);
    }
  }

  async function testPing() {
    const url = _baseUrl();
    if (!url) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const r = await fetch(`${url}/v1/config/link/test-ping`, { method: 'POST' });
      const j = await r.json();
      if (!j?.ok) {
        setActionMsg(`Test ping: ${j?.error || 'request failed'}`);
      } else if (j.reachable) {
        setActionMsg(`Test ping: ✅ reachable (${j.adapter}, checked ${_formatWhen(j.checkedAt)}).`);
      } else {
        setActionMsg(`Test ping: ⚠ not reachable — ${j.error || 'unknown error'}`);
      }
      await loadStatus();
    } catch (e) {
      setActionMsg(`Test ping: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setActionMsg(null), 6_000);
    }
  }

  // ── Vault-folder import handlers (Phase 3.4d) ───────────────────────────
  async function _postImport(dryRun: boolean) {
    const url = _baseUrl();
    if (!url) return;
    setImportBusy(true);
    setImportMsg(null);
    setImportPreview(null);

    // Cheap client-side guards — server still re-validates.
    const vaultPath = importVaultPath.trim().replace(/^\/+|\/+$/g, '');
    if (!vaultPath) {
      setImportMsg('Vault folder is required (e.g. "Google Keep").');
      setImportBusy(false);
      return;
    }
    const serverDir = importServerDir.trim().replace(/^\/+|\/+$/g, '');
    if (!/^docs\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(serverDir)) {
      setImportMsg('Server folder must look like `docs/<name>` — letters, digits, dot, underscore, dash, slash.');
      setImportBusy(false);
      return;
    }
    if (!link.adapterReachable) {
      setImportMsg('Adapter not reachable — Test ping first.');
      setImportBusy(false);
      return;
    }
    if ((link.adapterKind || 'mock') === 'mock') {
      setImportMsg('Switch the adapter to obsidian-rest before importing — mock cannot read your real vault.');
      setImportBusy(false);
      return;
    }

    try {
      const r = await fetch(`${url}/v1/config/link/import-vault-folder`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          vaultPath,
          serverDir,
          sensitivity: importTier,
          dryRun,
          startSync: true,
        }),
      });
      const j = await r.json();
      if (!j?.ok) {
        setImportMsg(`Import failed: ${j?.error || 'request failed'}`);
      } else if (dryRun) {
        setImportPreview({ total: j.total ?? 0, files: Array.isArray(j.files) ? j.files : [] });
        setImportMsg(`Found ${j.total} markdown file${j.total === 1 ? '' : 's'} under "${vaultPath}". Click "Import & start sync" to pull them.`);
      } else {
        const errCount = Array.isArray(j.errors) ? j.errors.length : 0;
        const parts: string[] = [];
        if (j.imported) parts.push(`imported ${j.imported}`);
        if (j.skipped)  parts.push(`skipped ${j.skipped} unchanged`);
        if (errCount)   parts.push(`${errCount} error${errCount === 1 ? '' : 's'}`);
        if (j.syncStarted) parts.push('sync started');
        setImportMsg(
          `Done. ${parts.length ? parts.join(', ') : 'nothing to import'}. ` +
          `The "${j.serverDir}" folder is now in your sync map; future edits flow both ways.`
        );
        setImportPreview(null);
      }
      await loadStatus();
    } catch (e) {
      setImportMsg(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportBusy(false);
      // Don't auto-clear — the user wants to see the result while they verify
      // the new tab in the picker. They can dismiss by triggering another
      // action or closing the modal.
    }
  }

  async function saveApiKey(clear = false) {
    const url = _baseUrl();
    if (!url) return;
    const value = clear ? '' : apiKeyDraft.trim();
    setApiKeyBusy(true);
    setApiKeyMsg(null);
    try {
      const r = await fetch(`${url}/v1/config/link/secrets`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ key: 'obsidianApiKey', value }),
      });
      const j = await r.json();
      if (!j?.ok) {
        setApiKeyMsg(`Save failed: ${j?.error || 'request failed'}`);
      } else {
        setApiKeyMsg(clear ? 'API key cleared.' : `API key saved — ${j.masked || 'masked'}.`);
        setApiKeyDraft('');
      }
      await loadStatus();
    } catch (e) {
      setApiKeyMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApiKeyBusy(false);
      setTimeout(() => setApiKeyMsg(null), 6_000);
    }
  }

  // ── Computed view-model ────────────────────────────────────────────────────
  const enabled    = link.enabled !== false;
  const reachable  = !!link.adapterReachable;
  const dirs       = link.syncDirs ?? {};
  const policies   = link.conflictPolicies ?? {};
  const lastErrors = link.lastRunStats?.errors ?? [];
  const sensitivity = link.syncSensitivity ?? {};
  const intervalSec = Math.round((link.syncIntervalMs ?? 300_000) / 1_000);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header>
        <h4 style={{ margin: 0 }}>🔗 LINK — Obsidian vault sync</h4>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
          Mirrors <code>docs/generated/</code> + your editable folders into an
          Obsidian vault on your desktop, every {intervalSec} s. Adapter pattern —
          point it at any of: <code>mock</code> (dry-run, default), <code>obsidian-rest</code>
          (Local REST API plugin), or <code>webdav</code> (planned).
        </p>
        <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
          Setup walkthrough: <code>docs/LINK-Setup.md</code> in this repo.
        </p>
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

      {/* ── Adapter settings (editable) ─────────────────────────────────────── */}
      <section style={_sectionStyle()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>Adapter settings</strong>
          <span style={{
            marginLeft: 'auto',
            fontSize:   12,
            color:      !enabled ? '#888' : reachable ? '#5c5' : '#e88',
          }}>
            ● {!enabled ? 'disabled' : reachable ? 'reachable' : 'not reachable'}
          </span>
        </div>
        <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
          Live-editable. Changes go through the standard <code>/v1/config/</code>
          {' '}PATCH path so they land in <em>config-history</em> alongside other
          settings. Adapter / host / vault root take effect at the next sync
          tick; <em>sync interval</em> requires a bridge restart.
        </p>

        <div style={_formGrid()}>
          <label style={_lbl()}>Enabled</label>
          <div style={_v()}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draftEnabled}
                onChange={(e) => setDraftEnabled(e.currentTarget.checked)}
                disabled={settingsBusy || !hydrated}
              />
              <span style={{ fontSize: 12 }}>
                {draftEnabled ? 'Watchdog active' : 'Watchdog paused (no syncs run)'}
              </span>
            </label>
          </div>

          <label style={_lbl()}>Adapter</label>
          <select
            value={draftAdapter}
            onChange={(e) => setDraftAdapter(e.currentTarget.value)}
            disabled={settingsBusy || !hydrated}
            style={_inputStyle()}
            title={ADAPTER_KINDS.find((a) => a.value === draftAdapter)?.hint || ''}
          >
            {ADAPTER_KINDS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>

          <label style={_lbl()}>Host</label>
          <input
            type="text"
            value={draftHost}
            placeholder="http://<windows-host>:27123  (or http://127.0.0.1:27123 over an SSH tunnel)"
            onChange={(e) => setDraftHost(e.currentTarget.value)}
            disabled={settingsBusy || !hydrated || draftAdapter === 'mock'}
            spellCheck={false}
            autoComplete="off"
            style={_inputStyle()}
            title="The base URL the bridge dials when adapter=obsidian-rest. Use the Windows hostname (e.g. `http://<windows-host>:27123`) when the bridge can reach the desktop directly, or `http://127.0.0.1:27123` when running through an SSH tunnel."
          />

          <label style={_lbl()}>Vault root</label>
          <input
            type="text"
            value={draftVaultRoot}
            placeholder="(empty = vault root) e.g. YHA"
            onChange={(e) => setDraftVaultRoot(e.currentTarget.value)}
            disabled={settingsBusy || !hydrated}
            spellCheck={false}
            autoComplete="off"
            style={_inputStyle()}
            title="Sub-folder INSIDE the Obsidian vault into which `notes/`, `generated/`, `calendar/`, `mail/` are mirrored. Leave empty to mount at the vault's top level."
          />

          <label style={_lbl()}>Sync interval</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="number"
              min={30}
              max={86_400}
              step={30}
              value={draftIntervalSec}
              onChange={(e) => setDraftIntervalSec(e.currentTarget.value)}
              disabled={settingsBusy || !hydrated}
              style={{ ..._inputStyle(), maxWidth: 120 }}
              title="Watchdog tick interval. Pull-side latency is gated by this; push-side is also gated by a 60-second floor. Restart the bridge for changes to apply."
            />
            <span style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>seconds (restart needed)</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="prefs-btn"
            disabled={settingsBusy || !hydrated || !settingsDirty}
            onClick={() => void saveSettings()}
            style={{ padding: '4px 12px', fontSize: 12 }}
            title="Persist these settings to config.json (under defaults.contextLink) and snapshot to config-history."
          >
            {settingsBusy ? 'Saving…' : 'Save settings'}
          </button>
          <button
            type="button"
            className="prefs-btn"
            disabled={settingsBusy || !hydrated || !settingsDirty}
            onClick={resetSettings}
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            Reset
          </button>
          {settingsDirty && (
            <span style={{ fontSize: 11.5, color: '#d90' }}>● unsaved changes</span>
          )}
          {settingsMsg && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-mute, #aaa)' }}>{settingsMsg}</span>
          )}
        </div>

        {/* Live status snapshot — what the engine is actually using right now. */}
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border, #2a2a2a)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #888)', marginBottom: 4 }}>
            Currently active (read-only):
          </div>
          <div style={_kvGrid()}>
            <span style={_k()}>Kind</span>
            <code style={_v()}>{link.adapterKind ?? 'mock'}</code>

            <span style={_k()}>Host</span>
            <code style={_v()}>{link.obsidianHost || '(default)'}</code>

            <span style={_k()}>Vault root</span>
            <code style={_v()}>{link.vaultRoot || '(vault root)'}</code>

            <span style={_k()}>API key</span>
            <code style={_v()}>{link.apiKeyMasked || '(none)'}</code>

            <span style={_k()}>Last ping</span>
            <span style={_v()}>{_formatWhen(link.adapterCheckedAt ?? null)}</span>

            {link.adapterError && (
              <>
                <span style={_k()}>Error</span>
                <span style={{ ..._v(), color: '#e88' }}>{link.adapterError}</span>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="prefs-btn"
            disabled={busy}
            onClick={() => void testPing()}
            style={{ padding: '4px 12px', fontSize: 12 }}
            title="Live probe against the currently-configured adapter. Use this right after saving settings or pasting a new API key to see whether the bridge can reach the desktop."
          >
            Test ping
          </button>
          <button
            type="button"
            className="prefs-btn"
            disabled={busy || !enabled || link.isRunning}
            onClick={() => void syncNow()}
            style={{ padding: '4px 12px', fontSize: 12 }}
            title={enabled
              ? 'Trigger an immediate push/pull. Bypasses the 60-second push rate-limit.'
              : 'Enable LINK first (toggle above, then Save settings).'}
          >
            {link.isRunning ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </section>

      {/* ── API key form ─────────────────────────────────────────────────────── */}
      <section style={_sectionStyle()}>
        <strong>Obsidian REST API key</strong>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
          Paste the key from the <em>Local REST API</em> plugin in Obsidian
          (Plugin settings → API key → Copy). Stored under
          {' '}<code>bridge/secrets/contextLink.json</code> (chmod 600);
          never echoed back over the wire — only the masked fingerprint
          (<code>{link.apiKeyMasked || '(none)'}</code>) is exposed.
        </p>
        <div style={{
          margin:       '8px 0 0',
          padding:      '7px 10px',
          fontSize:     11.5,
          lineHeight:   1.55,
          borderLeft:   '3px solid var(--accent, #f90)',
          background:   'var(--bg-elevated, #1a1a1a)',
          borderRadius: '0 4px 4px 0',
          color:        'var(--fg-mute, #aaa)',
        }}>
          <strong style={{ color: 'var(--fg, #ddd)', display: 'block', marginBottom: 3 }}>
            ⚠️ Plugin must listen on all interfaces
          </strong>
          By default the <em>Local REST API</em> plugin binds only to{' '}
          <code>127.0.0.1</code>, which makes it unreachable from the bridge
          server. Change it once in Obsidian:
          <ol style={{ margin: '5px 0 4px', paddingLeft: 18 }}>
            <li>Settings → Community Plugins → <em>Local REST API</em> → open plugin settings</li>
            <li>Set <strong>Bind address</strong> to <code>0.0.0.0</code></li>
            <li>Disable → re-enable the plugin (or restart Obsidian)</li>
          </ol>
          Confirm with PowerShell:{' '}
          <code>netstat -an | findstr 27123</code> — the line should show{' '}
          <code>0.0.0.0:27123</code> instead of <code>127.0.0.1:27123</code>.
          You may also need a Windows Firewall inbound rule:{' '}
          <code>New-NetFirewallRule -DisplayName "Obsidian REST API" -Direction Inbound -Protocol TCP -LocalPort 27123,27124 -Action Allow -Profile Private</code>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <input
            type="password"
            placeholder="sk-…"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.currentTarget.value)}
            disabled={apiKeyBusy}
            spellCheck={false}
            autoComplete="off"
            style={{
              flex:        '1 1 220px',
              minWidth:    180,
              padding:     '5px 8px',
              fontSize:    12,
              fontFamily:  'monospace',
              border:      '1px solid var(--border, #2a2a2a)',
              background:  'var(--bg, #111)',
              color:       'var(--fg, #ddd)',
              borderRadius: 4,
            }}
          />
          <button
            type="button"
            className="prefs-btn"
            disabled={apiKeyBusy || apiKeyDraft.trim().length === 0}
            onClick={() => void saveApiKey(false)}
            style={{ padding: '4px 12px', fontSize: 12 }}
          >
            Save key
          </button>
          {link.apiKeyMasked && (
            <button
              type="button"
              className="prefs-btn-danger"
              disabled={apiKeyBusy}
              onClick={() => {
                if (!confirm('Clear the stored Obsidian API key?')) return;
                void saveApiKey(true);
              }}
              style={{ padding: '4px 12px', fontSize: 12 }}
              title="Removes the secret from disk. The adapter will become unreachable until a new key is saved."
            >
              Clear
            </button>
          )}
        </div>
        {apiKeyMsg && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-mute, #aaa)', marginTop: 6 }}>
            {apiKeyMsg}
          </div>
        )}
      </section>

      {/* ── Vault-folder import (Phase 3.4d) ─────────────────────────────────── */}
      <section style={_sectionStyle()}>
        <strong>Import vault folder</strong>
        <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
          One-shot scoop of an arbitrary folder in your Obsidian vault into a
          server-side category directory. Typical use: the
          {' '}<em>Google-Keep-Importer</em> plugin dropped your Keep notes into
          {' '}<code>Google Keep/</code>; this pulls them into
          {' '}<code>docs/keep-notes/</code> so they show up in the
          {' '}<strong>🗒️ Keep Notes</strong> tab of the Picker, and registers
          the mapping so future edits sync <em>bidirectionally</em>.
        </p>
        <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--fg-mute, #888)' }}>
          Each imported note is rewritten with
          {' '}<code>sensitivity:</code> + <code>category:</code> frontmatter
          (skipped if you already set <code>sensitivity:</code> on the note in
          Obsidian). Already-up-to-date files are left alone — re-running this
          is safe.
        </p>

        <div style={_formGrid()}>
          <label style={_lbl()}>Vault folder</label>
          <input
            type="text"
            value={importVaultPath}
            placeholder="Google Keep"
            onChange={(e) => setImportVaultPath(e.currentTarget.value)}
            disabled={importBusy}
            spellCheck={false}
            autoComplete="off"
            style={_inputStyle()}
            title="Folder INSIDE your Obsidian vault to import. Spaces are fine. No leading/trailing slash. The Google-Keep-Importer plugin defaults to `Google Keep`."
          />

          <label style={_lbl()}>Server folder</label>
          <input
            type="text"
            value={importServerDir}
            placeholder="docs/keep-notes"
            onChange={(e) => setImportServerDir(e.currentTarget.value)}
            disabled={importBusy}
            spellCheck={false}
            autoComplete="off"
            style={_inputStyle()}
            title="Server-side directory the notes are written to. Must start with `docs/`. The matching category appears in the Picker tabs (e.g. `docs/keep-notes` → 🗒️ Keep Notes)."
          />

          <label style={_lbl()}>Sensitivity</label>
          <select
            value={importTier}
            onChange={(e) => setImportTier(e.currentTarget.value === 'private' ? 'private' : 'public')}
            disabled={importBusy}
            style={_inputStyle()}
            title="Which tier to stamp on every imported note that doesn't already declare one. `private` requires the LINK private-tier opt-in if you want these notes to keep syncing — otherwise they'll be blocked at the sensitivity filter."
          >
            <option value="public">public</option>
            <option value="private">private (requires private-tier opt-in)</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="prefs-btn"
            disabled={importBusy || !link.adapterReachable || (link.adapterKind || 'mock') === 'mock'}
            onClick={() => void _postImport(true)}
            style={{ padding: '4px 12px', fontSize: 12 }}
            title="List the markdown files under the vault folder without writing anything. Use this first to make sure you've got the right path."
          >
            {importBusy ? 'Working…' : 'Preview'}
          </button>
          <button
            type="button"
            className="prefs-btn"
            disabled={importBusy || !link.adapterReachable || (link.adapterKind || 'mock') === 'mock'}
            onClick={() => void _postImport(false)}
            style={{ padding: '4px 12px', fontSize: 12 }}
            title="Pull every markdown file under the vault folder into the server folder, persist the mapping into syncDirs, and trigger an immediate sync."
          >
            Import &amp; start sync
          </button>
          {(link.adapterKind || 'mock') === 'mock' && (
            <span style={{ fontSize: 11.5, color: '#d90' }}>
              ● Switch adapter to obsidian-rest first
            </span>
          )}
          {link.adapterKind === 'obsidian-rest' && !link.adapterReachable && (
            <span style={{ fontSize: 11.5, color: '#d90' }}>
              ● Adapter not reachable — Test ping first
            </span>
          )}
          {importMsg && (
            <span style={{ fontSize: 11.5, color: 'var(--fg-mute, #aaa)' }}>{importMsg}</span>
          )}
        </div>

        {importPreview && importPreview.total > 0 && (
          <details open style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12 }}>
              Preview — {importPreview.total} markdown file
              {importPreview.total === 1 ? '' : 's'}
              {importPreview.files.length < importPreview.total
                ? ` (showing first ${importPreview.files.length})`
                : ''}
            </summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, maxHeight: 200, overflowY: 'auto' }}>
              {importPreview.files.slice(0, 200).map((p, i) => (
                <li key={i} style={{ marginBottom: 1 }}>
                  <code style={{ color: 'var(--fg-mute, #bbb)' }}>{p}</code>
                </li>
              ))}
              {importPreview.files.length > 200 && (
                <li style={{ color: 'var(--fg-mute, #888)' }}>
                  …and {importPreview.files.length - 200} more
                </li>
              )}
            </ul>
          </details>
        )}
      </section>

      {/* ── Folders + conflict policy ────────────────────────────────────────── */}
      <section style={_sectionStyle()}>
        <strong>Folders &amp; conflict policy</strong>
        <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
          Per-folder mapping (server path → vault path) and how conflicts resolve.
          Edit in <code>config.json</code> under <code>defaults.contextLink.syncDirs</code>
          {' / '}<code>conflictPolicy</code>; bridge restart required for changes.
        </p>
        {Object.keys(dirs).length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>
            No folders configured.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-mute, #888)' }}>
                <th style={_th()}>Server</th>
                <th style={_th()}>Vault</th>
                <th style={_th()}>Policy</th>
                <th style={_th()}>Direction</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(dirs).map(([src, dst]) => {
                const pol = policies[src] || '—';
                const pushOnly = PUSH_ONLY_DIRS.has(src);
                return (
                  <tr key={src} style={{ borderTop: '1px solid var(--border, #2a2a2a)' }}>
                    <td style={_td()}><code>{src}/</code></td>
                    <td style={_td()}><code>{dst}</code></td>
                    <td style={_td()} title={_policyHint(pol)}>{pol}</td>
                    <td style={_td()}>
                      {pushOnly
                        ? <span title="Sorter regen target — pulling would corrupt rebuilds.">↑ push-only</span>
                        : '↕ bi-directional'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Sensitivity filter ───────────────────────────────────────────────── */}
      <section style={_sectionStyle()}>
        <strong>Sensitivity filter</strong>
        <p style={{ margin: '4px 0 8px', fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
          Items keep their tier when synced. <code>system</code> is hard-blocked
          on both directions and cannot be overridden. <code>private</code> is
          opt-in — flip in <code>config.json</code> and confirm the vault is
          encrypted at rest.
        </p>
        <div style={_kvGrid()}>
          <span style={_k()}>Public</span>
          <span style={{ ..._v(), color: sensitivity.public ? '#5c5' : '#888' }}>
            {sensitivity.public ? '● syncing' : '○ blocked'}
          </span>

          <span style={_k()}>Private</span>
          <span style={{ ..._v(), color: sensitivity.private ? '#d90' : '#888' }}>
            {sensitivity.private ? '● syncing (opt-in active)' : '○ blocked'}
          </span>

          <span style={_k()}>System</span>
          <span style={{ ..._v(), color: '#e88' }}>
            ✕ never synced (hard-coded)
          </span>
        </div>
      </section>

      {/* ── Last run + lifetime ──────────────────────────────────────────────── */}
      <section style={_sectionStyle()}>
        <strong>Last run</strong>
        <div style={_kvGrid()}>
          <span style={_k()}>When</span>
          <span style={_v()}>{_formatWhen(link.lastRunAt)}</span>

          <span style={_k()}>Files scanned</span>
          <span style={_v()}>{link.lastRunStats?.filesScanned ?? 0}</span>

          <span style={_k()}>Pushed</span>
          <span style={_v()}>↑ {link.lastRunStats?.pushed ?? 0}</span>

          <span style={_k()}>Pulled</span>
          <span style={_v()}>↓ {link.lastRunStats?.pulled ?? 0}</span>

          <span style={_k()}>Conflicts</span>
          <span style={{ ..._v(), color: (link.lastRunStats?.conflicts ?? 0) > 0 ? '#d90' : undefined }}>
            ⚠ {link.lastRunStats?.conflicts ?? 0}
          </span>
        </div>

        {lastErrors.length > 0 && (
          <details open style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#e88' }}>
              {lastErrors.length} error{lastErrors.length === 1 ? '' : 's'} during last run
            </summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5 }}>
              {lastErrors.slice(0, 20).map((err, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  <code style={{ color: 'var(--fg-mute, #aaa)' }}>{err.path}</code>{' '}
                  <span style={{ color: '#e88' }}>— {err.error}</span>
                </li>
              ))}
              {lastErrors.length > 20 && (
                <li style={{ color: 'var(--fg-mute, #888)' }}>
                  …and {lastErrors.length - 20} more (see bridge logs)
                </li>
              )}
            </ul>
          </details>
        )}
      </section>

      <section style={_sectionStyle()}>
        <strong>Lifetime</strong>
        <div style={_kvGrid()}>
          <span style={_k()}>Pushed</span>
          <span style={_v()}>↑ {link.lifetimePushed ?? 0}</span>

          <span style={_k()}>Pulled</span>
          <span style={_v()}>↓ {link.lifetimePulled ?? 0}</span>

          <span style={_k()}>Conflicts</span>
          <span style={_v()}>⚠ {link.lifetimeConflicts ?? 0}</span>

          <span style={_k()}>Watchdog</span>
          <span style={_v()}>
            {link.watchdogActive ? `● active (every ${intervalSec} s)` : '○ paused'}
          </span>
        </div>
      </section>
    </div>
  );
}

// ── Tiny presentation helpers (avoid bloating the JSX) ─────────────────────

function _sectionStyle(): React.CSSProperties {
  return {
    display:       'flex',
    flexDirection: 'column',
    gap:           4,
    padding:       '10px 12px',
    border:        '1px solid var(--border, #2a2a2a)',
    background:    'var(--bg-soft, #1f1f1f)',
    borderRadius:  6,
  };
}

function _kvGrid(): React.CSSProperties {
  return {
    display:             'grid',
    gridTemplateColumns: 'minmax(110px, max-content) 1fr',
    rowGap:              4,
    columnGap:           10,
    fontSize:            12,
    marginTop:           4,
  };
}

function _k(): React.CSSProperties {
  return { color: 'var(--fg-mute, #888)' };
}

function _v(): React.CSSProperties {
  return { color: 'var(--fg, #ddd)', wordBreak: 'break-word' };
}

function _th(): React.CSSProperties {
  return { padding: '4px 6px', fontWeight: 600, fontSize: 11.5 };
}

function _td(): React.CSSProperties {
  return { padding: '4px 6px', verticalAlign: 'top' };
}

function _formGrid(): React.CSSProperties {
  return {
    display:             'grid',
    gridTemplateColumns: 'minmax(110px, max-content) 1fr',
    rowGap:              8,
    columnGap:           10,
    fontSize:            12,
    marginTop:           4,
    alignItems:          'center',
  };
}

function _lbl(): React.CSSProperties {
  return { color: 'var(--fg-mute, #aaa)', fontSize: 12 };
}

function _inputStyle(): React.CSSProperties {
  return {
    padding:      '5px 8px',
    fontSize:     12,
    fontFamily:   'inherit',
    border:       '1px solid var(--border, #2a2a2a)',
    background:   'var(--bg, #111)',
    color:        'var(--fg, #ddd)',
    borderRadius: 4,
    width:        '100%',
    boxSizing:    'border-box',
  };
}
