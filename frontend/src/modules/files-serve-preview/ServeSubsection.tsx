// ServeSubsection — profile picker + start/stop + status row, plugged into
// the CWD/Projects dropdown via the `cwdDropdownEntries` register. Owns its
// own store subscription (`useServeStore`) and persists the per-cwd picked
// profile via the global `store` bridge under key `serveProfiles`.
//
// Originally lived inline in `panels/CwdPanel.tsx`; relocated here so
// that disabling the `files-serve-preview` module removes the row entirely.

import { useEffect, useState } from 'react';
import { useServeStore, type ServeProfile, type ServeEntryPublic, type ServeSharePublic } from '../../stores/serveStore.js';
import { store } from '../../store.js';

interface ProfileMeta {
  id: ServeProfile;
  icon: string;
  label: string;
  hint: string;
  needsRuntime?: 'python' | 'node' | 'php';
}
const PROFILES: ProfileMeta[] = [
  { id: 'static', icon: '📄', label: 'static', hint: 'serve files (no runtime)' },
  { id: 'python', icon: '🐍', label: 'python', hint: 'flask / fastapi / http.server', needsRuntime: 'python' },
  { id: 'node',   icon: '🟢', label: 'node',   hint: 'npm run dev / start',           needsRuntime: 'node'   },
  { id: 'php',    icon: '🐘', label: 'php',    hint: 'php -S built-in',               needsRuntime: 'php'    },
  { id: 'custom', icon: '⚙',  label: 'custom', hint: '$PORT injected' },
];

const TTL_OPTIONS: Array<{ value: number | null; label: string; hint: string }> = [
  { value: 15 * 60_000, label: '15 min', hint: 'quick check' },
  { value: 60 * 60_000, label: '1 hour', hint: 'default' },
  { value: 6 * 60 * 60_000, label: '6 hours', hint: 'work session' },
  { value: 24 * 60 * 60_000, label: '1 day', hint: 'today' },
  { value: 7 * 24 * 60 * 60_000, label: '7 days', hint: 'week' },
  { value: null, label: 'manual', hint: 'until stopped' },
];
function ttlValue(v: number | null): string {
  return v === null ? 'manual' : String(v);
}
function parseTtl(v: string): number | null {
  return v === 'manual' ? null : Number(v);
}
function ttlLabel(v: number | null | undefined): string {
  return TTL_OPTIONS.find((o) => o.value === (v ?? null))?.label || (v ? `${Math.round(v / 60000)} min` : 'manual');
}
function shareExpiryLabel(sh: ServeSharePublic): string {
  if (!sh.expiresAt) return 'manual share';
  return `${ttlLabel(sh.expiresAt - sh.createdAt)} share`;
}
function formatStopTime(expiresAt?: number | null): string {
  if (!expiresAt) return 'manual stop';
  const ms = Math.max(0, expiresAt - Date.now());
  const mins = Math.round(ms / 60000);
  if (mins < 90) return `stops in ${mins} min`;
  const hours = Math.round(ms / 3600000);
  if (hours < 36) return `stops in ${hours} h`;
  return `stops ${new Date(expiresAt).toLocaleDateString()}`;
}

type LocalProfileState = {
  profile: ServeProfile;
  cmdLine?: string;
  keepAlive?: boolean;
};
function readStoredProfile(cwd: string | null): LocalProfileState | null {
  if (!cwd) return null;
  const all = (store.get('serveProfiles') as Record<string, LocalProfileState>) || {};
  return all[cwd] || null;
}
function writeStoredProfile(cwd: string | null, value: LocalProfileState): void {
  if (!cwd) return;
  const all = ({ ...((store.get('serveProfiles') as Record<string, LocalProfileState>) || {}) });
  all[cwd] = value;
  store.set('serveProfiles', all);
}

export function ServeSubsection({ cwd }: { cwd: string | null }) {
  const entry         = useServeStore((s) => s.entry);
  const runtimes      = useServeStore((s) => s.runtimes);
  const status        = useServeStore((s) => s.status);
  const errorMsg      = useServeStore((s) => s.errorMsg);
  const refresh       = useServeStore((s) => s.refresh);
  const startServe    = useServeStore((s) => s.start);
  const stopServe     = useServeStore((s) => s.stop);
  const setKeepAlive  = useServeStore((s) => s.setKeepAlive);

  const [picked, setPicked]       = useState<ServeProfile>('static');
  const [customCmd, setCustomCmd] = useState('');
  const [keepAlive, setKeepAlLocal] = useState(false);
  const [ttlMs, setTtlMs] = useState<number | null>(60 * 60_000);

  // Load stored profile each time the cwd changes.
  useEffect(() => {
    refresh(cwd);
    const stored = readStoredProfile(cwd);
    if (stored) {
      setPicked(stored.profile);
      setCustomCmd(stored.cmdLine || '');
      setKeepAlLocal(!!stored.keepAlive);
    }
  }, [cwd, refresh]);

  const isRunning = !!entry && entry.status !== 'stopped';

  async function onStart() {
    if (!cwd) return;
    writeStoredProfile(cwd, {
      profile: picked,
      cmdLine: picked === 'custom' ? customCmd : undefined,
      keepAlive,
    });
    const created = await startServe(
      cwd,
      picked,
      picked === 'custom' ? customCmd : undefined,
      keepAlive,
      ttlMs,
    );
    if (created) {
      window.dispatchEvent(new CustomEvent('yha:open-serve-preview'));
    }
  }
  async function onStop() {
    if (!entry) return;
    await stopServe(entry.id);
  }

  return (
    <details className="cwd-sub cwd-sub-collapsible">
      <summary className="cwd-sub-head">
        <span className="cwd-sub-title">Serve</span>
        <span className={`serve-status-dot ${status}`} title={status} />
      </summary>

      {!cwd ? (
        <div className="cwd-empty">no working directory bound</div>
      ) : isRunning ? (
        <RunningServeRow
          entry={entry!}
          onStop={onStop}
          onOpen={() => window.dispatchEvent(new CustomEvent('yha:open-serve-preview'))}
          onToggleKeepAlive={(v) => setKeepAlive(entry!.id, v)}
          onRefresh={() => refresh(cwd)}
        />
      ) : (
        <>
          <div className="cwd-profile-row">
            {PROFILES.map((p) => {
              const disabled = p.needsRuntime ? !runtimes[p.needsRuntime] : false;
              const selected = p.id === picked;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`cwd-profile-card${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}`}
                  title={disabled ? `${p.label} not installed` : p.hint}
                  onClick={() => !disabled && setPicked(p.id)}
                  disabled={disabled}
                >
                  <span className="cwd-profile-icon">{p.icon}</span>
                  <span className="cwd-profile-label">{p.label}</span>
                </button>
              );
            })}
          </div>
          {picked === 'custom' && (
            <input
              type="text"
              className="cwd-custom-cmd"
              placeholder="npx serve -p $PORT"
              value={customCmd}
              onChange={(e) => setCustomCmd(e.target.value)}
              spellCheck={false}
            />
          )}
          <div className="cwd-serve-settings" aria-label="Serve settings">
            <label className="cwd-serve-field">
              <span>
                <span className="cwd-serve-field-label">Lifetime</span>
                <span className="cwd-serve-field-help">auto-stop timer</span>
              </span>
              <span className="cwd-select-wrap">
                <select
                  className="cwd-select"
                  value={ttlValue(ttlMs)}
                  onChange={(e) => setTtlMs(parseTtl(e.target.value))}
                >
                  {TTL_OPTIONS.map((o) => (
                    <option key={ttlValue(o.value)} value={ttlValue(o.value)}>{o.label}</option>
                  ))}
                </select>
              </span>
            </label>
            <label className="cwd-serve-toggle" title="Keep this server running when you switch sessions or it would otherwise be cleaned up.">
              <input
                type="checkbox"
                checked={keepAlive}
                onChange={(e) => setKeepAlLocal(e.target.checked)}
              />
              <span className="cwd-switch" aria-hidden="true" />
              <span>
                <span className="cwd-serve-field-label">Keep alive</span>
                <span className="cwd-serve-field-help">survive session switch</span>
              </span>
            </label>
          </div>
          <div className="cwd-actions cwd-serve-actions-main">
            <button
              type="button"
              className="cwd-btn cwd-btn-primary"
              onClick={onStart}
              disabled={status === 'starting' || (picked === 'custom' && !customCmd.trim())}
              title={PROFILES.find((p) => p.id === picked)?.hint}
            >
              {status === 'starting' ? 'starting…' : '▶ start preview'}
            </button>
          </div>
          {errorMsg && <div className="cwd-error">{errorMsg}</div>}
        </>
      )}
    </details>
  );
}

interface RunningProps {
  entry: ServeEntryPublic;
  onStop: () => void;
  onOpen: () => void;
  onToggleKeepAlive: (v: boolean) => void;
  onRefresh: () => void;
}
function RunningServeRow(p: RunningProps) {
  const [shareTtlMs, setShareTtlMs] = useState<number | null>(60 * 60_000);
  async function createShare() {
    await fetch('/v1/serve/share/' + encodeURIComponent(p.entry.id), {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlMs: shareTtlMs }),
    });
    p.onRefresh();
  }
  async function revoke(token: string) {
    await fetch('/v1/serve/shares/' + encodeURIComponent(token) + '/revoke', { method: 'POST', credentials: 'same-origin' });
    p.onRefresh();
  }
  const activeShares = (p.entry.shares || []).filter((s) => s.active && !s.revokedAt);
  const byIp = Object.entries(p.entry.stats?.byIp || {}).sort((a, b) => b[1].hits - a[1].hits).slice(0, 3);
  return (
    <div className="cwd-serve-running">
      <div className="cwd-serve-card-head">
        <div className="cwd-serve-titleblock">
          <span className="cwd-serve-profile">{p.entry.profile}</span>
          {p.entry.port > 0 ? <span className="cwd-serve-port">:{p.entry.port}</span> : null}
        </div>
        <span className={`cwd-serve-state ${p.entry.status}`}>{p.entry.status}</span>
      </div>
      <div className="cwd-serve-meta" title="Local view log is stored in bridge/serve-activity/views.ndjson">
        <span>👁 {p.entry.stats?.pageViews || 0} views</span>
        <span>{p.entry.stats?.hits || 0} hits</span>
        <span>{formatStopTime(p.entry.expiresAt)}</span>
      </div>
      <div className="cwd-actions cwd-serve-actions-main">
        <button type="button" className="cwd-btn cwd-btn-primary" onClick={p.onOpen}>
          🖼 open preview
        </button>
        <button type="button" className="cwd-btn cwd-btn-danger" onClick={p.onStop}>⏹ stop</button>
        <label className="cwd-serve-toggle cwd-serve-toggle-compact" title="Keep alive on session switch / idle">
          <input
            type="checkbox"
            checked={p.entry.keepAlive}
            onChange={(e) => p.onToggleKeepAlive(e.target.checked)}
          />
          <span className="cwd-switch" aria-hidden="true" />
          <span>keep</span>
        </label>
      </div>
      <div className="cwd-serve-sharebar">
        <span className="cwd-serve-share-label">Public share</span>
        <span className="cwd-select-wrap cwd-select-wrap-small">
          <select className="cwd-select" value={ttlValue(shareTtlMs)} onChange={(e) => setShareTtlMs(parseTtl(e.target.value))}>
            {TTL_OPTIONS.map((o) => (
              <option key={ttlValue(o.value)} value={ttlValue(o.value)}>{o.label}</option>
            ))}
          </select>
        </span>
        <button type="button" className="cwd-btn" onClick={createShare}>🔗 create</button>
      </div>
      {byIp.length > 0 && (
        <div className="cwd-serve-line cwd-serve-ips">
          IPs: {byIp.map(([ip, v]) => `${ip}×${v.hits}`).join(', ')}
        </div>
      )}
      {activeShares.map((sh) => {
        const url = window.location.origin + (sh.publicPath || `/share/${sh.token}/`);
        return (
          <div className="cwd-serve-share" key={sh.token}>
            <span className="cwd-serve-share-token" title={url}>{sh.token.slice(0, 8)}…</span>
            <span className="cwd-serve-share-expiry">{shareExpiryLabel(sh)}</span>
            <button type="button" className="cwd-btn cwd-btn-mini" onClick={() => navigator.clipboard?.writeText(url)}>copy</button>
            <button type="button" className="cwd-btn cwd-btn-mini" onClick={() => revoke(sh.token)}>revoke</button>
          </div>
        );
      })}
    </div>
  );
}
