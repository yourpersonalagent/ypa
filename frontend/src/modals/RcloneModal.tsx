// RcloneModal — full FTP / Sync / Remotes panel.
// Owns both the open/close UX (trigger button, backdrop, Escape key) AND the
// panel content rendering. Replaces modals/rclone.ts (deleted).
//
// Top-level tabs: FTP (linked/unlinked + browse view), Sync (cwd → ftp/rclone),
// Remotes (list, add, browse). Backed by /v1/ftp/* and /v1/rclone/* endpoints.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/index.js';
import { pushEscapeHandler } from '../host/modal-stack.js';

// ── Types ─────────────────────────────────────────────────────────────────

type TopTab = 'ftp' | 'sync' | 'remotes';
type FtpSubTab = 'new' | 'existing' | 'import' | 'credentials';
type SyncDest = 'ftp' | 'rclone';
type TlsMode = 'none' | 'explicit' | 'implicit';

interface FtpConnection {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  ftps: boolean;
  ftpsMode: string;
  useEpsv: boolean;
  createdAt: string;
}

interface FtpMapping {
  cwd: string;
  connectionId: string;
  remotePath: string;
  connectionName: string;
  host: string;
  user: string;
  port: number;
  ftps: boolean;
}

interface BrowseItem {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  modified?: string;
}

interface RcloneRemote { name: string; type: string }

// ── Helpers ───────────────────────────────────────────────────────────────

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' K';
  return (bytes / (1024 * 1024)).toFixed(1) + ' M';
}

async function apiFetch(url: string, opts?: RequestInit): Promise<any> {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || j.message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function buildBreadcrumbs(path: string): { label: string; path: string }[] {
  const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  if (!path || path === '/') return crumbs;
  const parts = path.replace(/^\//, '').split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) { acc += '/' + part; crumbs.push({ label: part, path: acc }); }
  return crumbs;
}

function joinPath(base: string, name: string): string {
  if (!base || base === '/') return '/' + name;
  return base.replace(/\/$/, '') + '/' + name;
}

// ── Browse view ───────────────────────────────────────────────────────────

interface BrowseState {
  active: boolean;
  source: 'linked' | 'new' | 'existing';
  path: string;
  items: BrowseItem[];
  loading: boolean;
  error: string;
  log: string;
  logVisible: boolean;
  connectionId: string;
  host: string;
  user: string;
  pass: string;
  port: number;
  ftpsMode: string;
  useEpsv: boolean;
}

function BrowseView({
  state,
  onNavigate,
  onClose,
  onUse,
  onTlsRetry,
  onToggleLog,
}: {
  state: BrowseState;
  onNavigate: (path: string) => void;
  onClose: () => void;
  onUse: () => void;
  onTlsRetry: (mode: TlsMode) => void;
  onToggleLog: () => void;
}) {
  const crumbs = buildBreadcrumbs(state.path);
  return (
    <>
      <div className="ftp-browse-toolbar">
        <button className="ftp-btn" onClick={onClose}>← Back</button>
        <div className="ftp-breadcrumbs">
          {crumbs.map((c, i) => i === crumbs.length - 1
            ? <span key={i} className="ftp-crumb ftp-crumb-active">{c.label}</span>
            : <span key={i}>
                <button className="ftp-crumb" onClick={() => onNavigate(c.path)}>{c.label}</button>
                {i < crumbs.length - 1 && <span style={{ margin: '0 2px' }}>/</span>}
              </span>
          )}
        </div>
      </div>
      {state.loading && <div className="ftp-browse-loading">Loading…</div>}
      {!state.loading && state.error && (
        <>
          <div className="ftp-browse-error">{state.error}</div>
          <div className="ftp-browse-retry-panel">
            <div style={{ marginBottom: 6, fontSize: '0.85em' }}>Try a different TLS mode:</div>
            <button className="ftp-btn" onClick={() => onTlsRetry('none')}>Plain FTP</button>
            <button className="ftp-btn" onClick={() => onTlsRetry('explicit')}>Explicit TLS</button>
            <button className="ftp-btn" onClick={() => onTlsRetry('implicit')}>Implicit TLS</button>
          </div>
          {state.log && (
            <>
              <button className="ftp-browse-log-toggle" onClick={onToggleLog}>
                {state.logVisible ? 'Hide' : 'Show'} log
              </button>
              {state.logVisible && <pre className="ftp-browse-log">{state.log}</pre>}
            </>
          )}
        </>
      )}
      {!state.loading && !state.error && state.items.length === 0 && (
        <div className="ftp-browse-empty">Empty directory</div>
      )}
      {!state.loading && !state.error && state.items.length > 0 && (
        <div className="ftp-browse-list">
          {state.items.map((item, i) => item.type === 'dir' ? (
            <div key={i} className="ftp-browse-row ftp-browse-dir" onClick={() => onNavigate(joinPath(state.path, item.name))}>
              <span className="ftp-browse-icon">📁</span>
              <span className="ftp-browse-name">{item.name}</span>
              <span className="ftp-browse-chevron">›</span>
            </div>
          ) : (
            <div key={i} className="ftp-browse-row ftp-browse-file">
              <span className="ftp-browse-icon">📄</span>
              <span className="ftp-browse-name">{item.name}</span>
              <span className="ftp-browse-size">{formatSize(item.size)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="ftp-browse-footer">
        <span>{state.path || '/'}</span>
        <button className="ftp-btn ftp-btn-accent" onClick={onUse}>✓ Use this folder</button>
      </div>
    </>
  );
}

// ── FTP linked view ───────────────────────────────────────────────────────

function FtpLinkedView({
  mapping,
  onUnlink,
  onBrowse,
  onDeploy,
  syncRunning,
  syncOutput,
  syncOk,
  ftpRemotePath,
  setFtpRemotePath,
  onSaveRemote,
  remoteSaveStatus,
}: {
  mapping: FtpMapping;
  onUnlink: () => void;
  onBrowse: () => void;
  onDeploy: (mode: string, dryRun: boolean) => void;
  syncRunning: boolean;
  syncOutput: string;
  syncOk: boolean;
  ftpRemotePath: string;
  setFtpRemotePath: (p: string) => void;
  onSaveRemote: () => void;
  remoteSaveStatus: { msg: string; err: boolean };
}) {
  const [mode, setMode] = useState('sync');
  const [dryRun, setDryRun] = useState(false);

  return (
    <>
      <div className="ftp-linked-card">
        <div className="ftp-linked-host">{mapping.connectionName} — {mapping.host}:{mapping.port}{mapping.ftps ? ' (FTPS)' : ''}</div>
        <div className="ftp-linked-meta">User: {mapping.user}</div>
        <div className="ftp-linked-path">
          <span className="ftp-linked-meta">{mapping.cwd}</span>
          <span style={{ margin: '0 6px' }}>↕</span>
          <span className="ftp-linked-meta">{mapping.remotePath}</span>
        </div>
        <div className="ftp-linked-actions">
          <button className="ftp-btn ftp-btn-danger" onClick={onUnlink}>Unlink</button>
          <button className="ftp-btn" onClick={onBrowse}>Browse FTP</button>
        </div>
      </div>
      <div className="ftp-divider" />
      <div className="ftp-section-label">Deploy / Sync (rclone)</div>
      <div className="ftp-field">
        <label className="ftp-label">Mode</label>
        <select className="ftp-select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="sync">sync</option>
          <option value="copy">copy</option>
          <option value="check">check</option>
        </select>
      </div>
      <div className="ftp-checkbox-row">
        <input type="checkbox" id="rclone-ftp-sync-dryrun" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        <label htmlFor="rclone-ftp-sync-dryrun">Dry run</label>
      </div>
      <div className="ftp-form-actions">
        <button
          className="ftp-btn ftp-btn-accent"
          disabled={syncRunning}
          onClick={() => onDeploy(mode, dryRun)}
        >
          {syncRunning ? '⏳ Running…' : '▶ Deploy'}
        </button>
      </div>
      {syncOutput && (
        <pre className={`ftp-sync-output ${syncOk ? 'ftp-sync-output-ok' : 'ftp-sync-output-err'}`}>
          {syncOutput}
        </pre>
      )}
      <div className="ftp-divider" />
      <div className="ftp-section-label">Remote path</div>
      <div className="ftp-field" style={{ display: 'flex', gap: 6 }}>
        <input
          className="ftp-input"
          value={ftpRemotePath}
          onChange={(e) => setFtpRemotePath(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="ftp-btn" onClick={onSaveRemote}>Save</button>
      </div>
      {remoteSaveStatus.msg && (
        <div className={`ftp-status ${remoteSaveStatus.err ? 'err' : 'ok'}`}>{remoteSaveStatus.msg}</div>
      )}
    </>
  );
}

// ── FTP New form ──────────────────────────────────────────────────────────

interface NewFormState {
  name: string; host: string; port: string; user: string; pass: string;
  ftpsMode: TlsMode; useEpsv: boolean; remotePath: string;
}

function FtpNewForm({
  state,
  setState,
  onCreate,
  onBrowse,
  status,
}: {
  state: NewFormState;
  setState: (s: NewFormState) => void;
  onCreate: () => void;
  onBrowse: () => void;
  status: { msg: string; err: boolean };
}) {
  const set = <K extends keyof NewFormState>(k: K, v: NewFormState[K]) => setState({ ...state, [k]: v });
  return (
    <>
      <form className="ftp-form-grid" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <div className="ftp-field ftp-span2">
          <label className="ftp-label">Name</label>
          <input className="ftp-input" value={state.name} onChange={(e) => set('name', e.target.value)} placeholder="My Server" />
        </div>
        <div className="ftp-field">
          <label className="ftp-label">Host</label>
          <input className="ftp-input" value={state.host} onChange={(e) => set('host', e.target.value)} placeholder="ftp.example.com" />
        </div>
        <div className="ftp-field">
          <label className="ftp-label">Port</label>
          <input className="ftp-input" type="number" value={state.port} onChange={(e) => set('port', e.target.value)} />
        </div>
        <div className="ftp-field">
          <label className="ftp-label">User</label>
          <input className="ftp-input" value={state.user} onChange={(e) => set('user', e.target.value)} placeholder="username" />
        </div>
        <div className="ftp-field">
          <label className="ftp-label">Password</label>
          <input className="ftp-input" type="password" autoComplete="new-password" value={state.pass} onChange={(e) => set('pass', e.target.value)} />
        </div>
        <div className="ftp-field ftp-span2">
          <label className="ftp-label">Encryption</label>
          <select className="ftp-select" value={state.ftpsMode} onChange={(e) => set('ftpsMode', e.target.value as TlsMode)}>
            <option value="none">None (plain FTP)</option>
            <option value="explicit">Explicit TLS (FTPS)</option>
            <option value="implicit">Implicit TLS (FTPS)</option>
          </select>
        </div>
        <div className="ftp-checkbox-row ftp-span2">
          <input type="checkbox" id="rclone-new-epsv" checked={state.useEpsv} onChange={(e) => set('useEpsv', e.target.checked)} />
          <label htmlFor="rclone-new-epsv">Use EPSV</label>
        </div>
        <div className="ftp-field ftp-span2" style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1 }}>
            <label className="ftp-label">Remote path</label>
            <input className="ftp-input" value={state.remotePath} onChange={(e) => set('remotePath', e.target.value)} placeholder="/" />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button type="button" className="ftp-btn" onClick={onBrowse}>Browse ▸</button>
          </div>
        </div>
      </form>
      <div className="ftp-form-actions">
        <button className="ftp-btn ftp-btn-accent" onClick={onCreate}>Create &amp; link</button>
      </div>
      {status.msg && <div className={`ftp-status ${status.err ? 'err' : 'ok'}`}>{status.msg}</div>}
    </>
  );
}

// ── FTP Existing form ─────────────────────────────────────────────────────

function FtpExistingForm({
  connections,
  selectedConnId,
  setSelectedConnId,
  remotePath,
  setRemotePath,
  onLink,
  onBrowse,
  status,
}: {
  connections: FtpConnection[];
  selectedConnId: string;
  setSelectedConnId: (id: string) => void;
  remotePath: string;
  setRemotePath: (p: string) => void;
  onLink: () => void;
  onBrowse: () => void;
  status: { msg: string; err: boolean };
}) {
  if (connections.length === 0) {
    return <div className="ftp-empty">No saved connections. Create one in the New tab.</div>;
  }
  return (
    <>
      <div className="ftp-field">
        <label className="ftp-label">Connection</label>
        <select className="ftp-select" value={selectedConnId} onChange={(e) => setSelectedConnId(e.target.value)}>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.host})</option>
          ))}
        </select>
      </div>
      <div className="ftp-field" style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <label className="ftp-label">Remote path</label>
          <input className="ftp-input" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/" />
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <button className="ftp-btn" onClick={onBrowse}>Browse ▸</button>
        </div>
      </div>
      <div className="ftp-form-actions">
        <button className="ftp-btn ftp-btn-accent" onClick={onLink}>Link</button>
      </div>
      {status.msg && <div className={`ftp-status ${status.err ? 'err' : 'ok'}`}>{status.msg}</div>}
    </>
  );
}

// ── FTP Import (.ini) form ────────────────────────────────────────────────

function FtpImportForm({
  iniContent,
  setIniContent,
  onImport,
  status,
}: {
  iniContent: string;
  setIniContent: (s: string) => void;
  onImport: () => void;
  status: { msg: string; err: boolean };
}) {
  return (
    <>
      <div className="ftp-section-label">Paste .ini content or upload a file</div>
      <textarea
        className="ftp-ini-textarea"
        value={iniContent}
        onChange={(e) => setIniContent(e.target.value)}
        placeholder="[MyServer]\nhost = ftp.example.com\nuser = me\npass = secret"
      />
      <div className="ftp-form-actions" style={{ gap: 8 }}>
        <label className="ftp-btn" style={{ cursor: 'pointer' }}>
          Upload file
          <input
            type="file"
            accept=".ini,.conf,.txt"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (ev) => setIniContent(String(ev.target?.result ?? ''));
              reader.readAsText(file);
            }}
          />
        </label>
        <button className="ftp-btn ftp-btn-accent" onClick={onImport}>Import</button>
      </div>
      {status.msg && <div className={`ftp-status ${status.err ? 'err' : 'ok'}`}>{status.msg}</div>}
    </>
  );
}

// ── FTP Credentials ───────────────────────────────────────────────────────

function FtpCredentials({
  connections,
  onDelete,
}: {
  connections: FtpConnection[];
  onDelete: (id: string, name: string) => void;
}) {
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  async function reveal(id: string) {
    setRevealed((p) => ({ ...p, [id]: '…' }));
    try {
      const data = await apiFetch(`/v1/ftp/connections/${id}/credentials`);
      setRevealed((p) => ({ ...p, [id]: data.credentials?.pass || '(empty)' }));
    } catch { setRevealed((p) => ({ ...p, [id]: 'Error' })); }
  }
  function hide(id: string) { setRevealed((p) => { const n = { ...p }; delete n[id]; return n; }); }

  if (connections.length === 0) return <div className="ftp-empty">No saved connections.</div>;

  return (
    <>
      <div className="ftp-cred-notice">Passwords are stored encrypted. Click Show to reveal.</div>
      <div className="ftp-cred-table-wrap">
        <table className="ftp-cred-table">
          <thead><tr><th>Name</th><th>Host</th><th>User</th><th>Password</th><th /></tr></thead>
          <tbody>
            {connections.map((c) => (
              <tr key={c.id}>
                <td className="ftp-cred-name">{c.name}</td>
                <td className="ftp-cred-host">{c.host}:{c.port}</td>
                <td className="ftp-cred-user">{c.user}</td>
                <td className="ftp-cred-pass">
                  <span className={revealed[c.id] != null ? '' : 'ftp-cred-loading'}>{revealed[c.id] ?? '••••'}</span>
                  {revealed[c.id] != null
                    ? <button className="ftp-cred-hide" onClick={() => hide(c.id)}>Hide</button>
                    : <button className="ftp-cred-show" onClick={() => reveal(c.id)}>Show</button>}
                </td>
                <td className="ftp-cred-del">
                  <button className="ftp-cred-delbtn" onClick={() => onDelete(c.id, c.name)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Sync tab ──────────────────────────────────────────────────────────────

function SyncView({
  cwd,
  ftpMapping,
  remotes,
  onRun,
  output,
  ok,
  running,
}: {
  cwd: string | null;
  ftpMapping: FtpMapping | null;
  remotes: RcloneRemote[];
  onRun: (params: { dest: SyncDest; mode: string; dryRun: boolean; remote: string; remotePath: string }) => void;
  output: string;
  ok: boolean;
  running: boolean;
}) {
  const [dest, setDest] = useState<SyncDest>(ftpMapping ? 'ftp' : 'rclone');
  const [mode, setMode] = useState('sync');
  const [dryRun, setDryRun] = useState(false);
  const [remote, setRemote] = useState(remotes[0]?.name ?? '');
  const [remotePath, setRemotePath] = useState('');
  const hasMapping = !!ftpMapping;

  return (
    <>
      <div className="ftp-form-section">
        <div className="ftp-section-label">Source</div>
        <div className="rclone-sync-src">{cwd || '(no directory selected)'}</div>
      </div>
      <div className="ftp-divider" />
      <div className="ftp-form-section">
        <div className="ftp-section-label">Destination</div>
        <div className="rclone-sync-dest">
          <div className="ftp-checkbox-row">
            <input
              type="radio"
              id="rclone-sync-dest-ftp"
              name="rclone-sync-dest"
              checked={dest === 'ftp'}
              disabled={!hasMapping}
              onChange={() => setDest('ftp')}
            />
            <label htmlFor="rclone-sync-dest-ftp">
              Use linked FTP mapping
              {hasMapping
                ? <span style={{ opacity: 0.6, marginLeft: 6 }}>({ftpMapping!.connectionName} → {ftpMapping!.remotePath})</span>
                : <span style={{ opacity: 0.5 }}> — no mapping for this directory</span>}
            </label>
          </div>
          <div className="ftp-checkbox-row" style={{ marginTop: 6 }}>
            <input
              type="radio"
              id="rclone-sync-dest-rclone"
              name="rclone-sync-dest"
              checked={dest === 'rclone'}
              onChange={() => setDest('rclone')}
            />
            <label htmlFor="rclone-sync-dest-rclone">rclone remote</label>
          </div>
          {dest === 'rclone' && (
            <>
              <div className="ftp-field" style={{ marginTop: 8 }}>
                <label className="ftp-label">Remote</label>
                <select className="ftp-select" value={remote} onChange={(e) => setRemote(e.target.value)}>
                  {remotes.length === 0 && <option value="">No remotes configured</option>}
                  {remotes.map((r) => <option key={r.name} value={r.name}>{r.name} ({r.type})</option>)}
                </select>
              </div>
              <div className="ftp-field">
                <label className="ftp-label">Remote path</label>
                <input className="ftp-input" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/" />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="ftp-divider" />
      <div className="ftp-field">
        <label className="ftp-label">Mode</label>
        <select className="ftp-select" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="sync">sync</option>
          <option value="copy">copy</option>
          <option value="check">check</option>
        </select>
      </div>
      <div className="ftp-checkbox-row">
        <input type="checkbox" id="rclone-sync-dryrun" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
        <label htmlFor="rclone-sync-dryrun">Dry run</label>
      </div>
      <div className="ftp-form-actions">
        <button
          className="ftp-btn ftp-btn-accent"
          disabled={running}
          onClick={() => onRun({ dest, mode, dryRun, remote, remotePath })}
        >
          {running ? '⏳ Running…' : '▶ Run Sync'}
        </button>
      </div>
      {output && (
        <pre className={`ftp-sync-output ${ok ? 'ftp-sync-output-ok' : 'ftp-sync-output-err'}`}>{output}</pre>
      )}
    </>
  );
}

// ── Remotes tab ──────────────────────────────────────────────────────────

function RemotesBrowse({
  name,
  path,
  items,
  loading,
  error,
  onNavigate,
  onClose,
}: {
  name: string;
  path: string;
  items: BrowseItem[];
  loading: boolean;
  error: string;
  onNavigate: (path: string) => void;
  onClose: () => void;
}) {
  const crumbs = buildBreadcrumbs(path);
  return (
    <>
      <div className="ftp-divider" />
      <div className="ftp-section-label">Browsing: {name}</div>
      <div className="ftp-browse-toolbar">
        <button className="ftp-btn" onClick={onClose}>← Close</button>
        <div className="ftp-breadcrumbs">
          {crumbs.map((c, i) => i === crumbs.length - 1
            ? <span key={i} className="ftp-crumb ftp-crumb-active">{c.label}</span>
            : <span key={i}>
                <button className="ftp-crumb" onClick={() => onNavigate(c.path)}>{c.label}</button>
                {i < crumbs.length - 1 && <span style={{ margin: '0 2px' }}>/</span>}
              </span>)}
        </div>
      </div>
      {loading && <div className="ftp-browse-loading">Loading…</div>}
      {!loading && error && <div className="ftp-browse-error">{error}</div>}
      {!loading && !error && items.length === 0 && <div className="ftp-browse-empty">Empty directory</div>}
      {!loading && !error && items.length > 0 && (
        <div className="ftp-browse-list">
          {items.map((it, i) => it.type === 'dir' ? (
            <div key={i} className="ftp-browse-row ftp-browse-dir" onClick={() => onNavigate(joinPath(path, it.name))}>
              <span className="ftp-browse-icon">📁</span><span className="ftp-browse-name">{it.name}</span><span className="ftp-browse-chevron">›</span>
            </div>
          ) : (
            <div key={i} className="ftp-browse-row ftp-browse-file">
              <span className="ftp-browse-icon">📄</span><span className="ftp-browse-name">{it.name}</span><span className="ftp-browse-size">{formatSize(it.size)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RemotesView({
  remotes,
  loading,
  error,
  onRefresh,
  onAdd,
  onDelete,
  onBrowse,
  browseState,
  onBrowseNavigate,
  onBrowseClose,
}: {
  remotes: RcloneRemote[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onAdd: (params: { name: string; host: string; port: number; user: string; pass: string; tls: TlsMode }) => Promise<{ ok: boolean; msg: string }>;
  onDelete: (name: string) => void;
  onBrowse: (name: string) => void;
  browseState: { active: boolean; name: string; path: string; items: BrowseItem[]; loading: boolean; error: string };
  onBrowseNavigate: (path: string) => void;
  onBrowseClose: () => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('21');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [tls, setTls] = useState<TlsMode>('none');
  const [addStatus, setAddStatus] = useState<{ msg: string; err: boolean }>({ msg: '', err: false });

  async function add() {
    const res = await onAdd({
      name, host, port: parseInt(port || '21', 10), user, pass, tls,
    });
    setAddStatus({ msg: res.msg, err: !res.ok });
  }

  return (
    <>
      <div className="ftp-form-actions">
        <button className="ftp-btn" onClick={onRefresh}>↻ Refresh</button>
      </div>
      {loading && <div className="ftp-browse-loading">Loading…</div>}
      {!loading && error && <div className="ftp-browse-error">{error}</div>}
      {!loading && !error && remotes.length === 0 && <div className="ftp-empty">No remotes configured.</div>}
      {!loading && remotes.map((r) => (
        <div key={r.name} className="rclone-remote-row">
          <span className="rclone-remote-type">{r.type}</span>
          <span className="rclone-remote-name">{r.name}</span>
          <span className="rclone-remote-actions">
            <button className="ftp-btn" onClick={() => onBrowse(r.name)}>Browse ▸</button>
            <button className="ftp-btn ftp-btn-danger" onClick={() => onDelete(r.name)}>Delete</button>
          </span>
        </div>
      ))}
      {browseState.active && (
        <RemotesBrowse
          name={browseState.name}
          path={browseState.path}
          items={browseState.items}
          loading={browseState.loading}
          error={browseState.error}
          onNavigate={onBrowseNavigate}
          onClose={onBrowseClose}
        />
      )}
      <div className="ftp-divider" />
      <div className="rclone-add-section">
        <div className="ftp-section-label">Add FTP Remote</div>
        <form className="ftp-form-grid" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
          <div className="ftp-field ftp-span2">
            <label className="ftp-label">Name</label>
            <input className="ftp-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="MyFTP" />
          </div>
          <div className="ftp-field">
            <label className="ftp-label">Host</label>
            <input className="ftp-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="ftp.example.com" />
          </div>
          <div className="ftp-field">
            <label className="ftp-label">Port</label>
            <input className="ftp-input" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <div className="ftp-field">
            <label className="ftp-label">User</label>
            <input className="ftp-input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" />
          </div>
          <div className="ftp-field">
            <label className="ftp-label">Pass</label>
            <input className="ftp-input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
          <div className="ftp-field ftp-span2">
            <label className="ftp-label">TLS</label>
            <select className="ftp-select" value={tls} onChange={(e) => setTls(e.target.value as TlsMode)}>
              <option value="none">None</option>
              <option value="explicit">Explicit TLS</option>
              <option value="implicit">Implicit TLS</option>
            </select>
          </div>
        </form>
        <div className="ftp-form-actions">
          <button className="ftp-btn ftp-btn-accent" onClick={add}>+ Add</button>
        </div>
        {addStatus.msg && (
          <div className="ftp-status">
            <span className={addStatus.err ? 'err' : 'ok'}>{addStatus.msg}</span>
          </div>
        )}
      </div>
    </>
  );
}

// ── Panel content (FTP / Sync / Remotes orchestration) ───────────────────

function PanelContent({ onClose }: { onClose: () => void }) {
  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const cwd = sessionWorkingDir ?? null;

  // Top tab + nested state
  const [topTab, setTopTab] = useState<TopTab>('ftp');

  // FTP linked/unlinked
  const [ftpLinked, setFtpLinked] = useState(false);
  const [ftpMapping, setFtpMapping] = useState<FtpMapping | null>(null);
  const [ftpConnections, setFtpConnections] = useState<FtpConnection[]>([]);
  const [ftpSubTab, setFtpSubTab] = useState<FtpSubTab>('new');
  const [ftpRemotePath, setFtpRemotePath] = useState('');
  const [ftpSyncOutput, setFtpSyncOutput] = useState('');
  const [ftpSyncOk, setFtpSyncOk] = useState(false);
  const [ftpSyncRunning, setFtpSyncRunning] = useState(false);
  const [remoteSaveStatus, setRemoteSaveStatus] = useState<{ msg: string; err: boolean }>({ msg: '', err: false });
  const [newForm, setNewForm] = useState<NewFormState>({
    name: '', host: '', port: '21', user: '', pass: '',
    ftpsMode: 'none', useEpsv: false, remotePath: '/',
  });
  const [newStatus, setNewStatus] = useState<{ msg: string; err: boolean }>({ msg: '', err: false });
  const [existingConnId, setExistingConnId] = useState('');
  const [existingRemotePath, setExistingRemotePath] = useState('/');
  const [existingStatus, setExistingStatus] = useState<{ msg: string; err: boolean }>({ msg: '', err: false });
  const [iniContent, setIniContent] = useState('');
  const [importStatus, setImportStatus] = useState<{ msg: string; err: boolean }>({ msg: '', err: false });

  // FTP browse view
  const [browse, setBrowse] = useState<BrowseState>({
    active: false, source: 'linked', path: '', items: [], loading: false, error: '', log: '',
    logVisible: false, connectionId: '', host: '', user: '', pass: '', port: 21, ftpsMode: 'none', useEpsv: false,
  });

  // Sync tab
  const [syncRemotes, setSyncRemotes] = useState<RcloneRemote[]>([]);
  const [syncOutput, setSyncOutput] = useState('');
  const [syncOk, setSyncOk] = useState(false);
  const [syncRunning, setSyncRunning] = useState(false);

  // Remotes tab
  const [remotes, setRemotes] = useState<RcloneRemote[]>([]);
  const [remotesLoading, setRemotesLoading] = useState(false);
  const [remotesError, setRemotesError] = useState('');
  const [remoteBrowse, setRemoteBrowse] = useState({
    active: false, name: '', path: '', items: [] as BrowseItem[], loading: false, error: '',
  });

  // ── FTP detection + connection loading ─────────────────────────────────
  const refresh = useCallback(async () => {
    if (!cwd) {
      setFtpLinked(false);
      setFtpMapping(null);
      setFtpConnections([]);
      return;
    }
    try {
      const data = await apiFetch(`/v1/ftp/dirs/check?cwd=${encodeURIComponent(cwd)}`);
      setFtpLinked(!!data.linked);
      setFtpMapping(data.linked ? data.mapping : null);
      if (data.linked && data.mapping) setFtpRemotePath(data.mapping.remotePath || '');
    } catch {
      setFtpLinked(false);
      setFtpMapping(null);
    }
    try {
      const data = await apiFetch('/v1/ftp/connections');
      setFtpConnections(data.connections || []);
    } catch { setFtpConnections([]); }
  }, [cwd]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── FTP actions ────────────────────────────────────────────────────────
  async function ftpUnlink() {
    if (!cwd) return;
    try {
      await apiFetch('/v1/ftp/dirs', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      setFtpLinked(false);
      setFtpMapping(null);
      setFtpSyncOutput('');
      await refresh();
    } catch (e) { alert('Unlink failed: ' + (e as Error).message); }
  }

  async function ftpDeploy(mode: string, dryRun: boolean) {
    if (!cwd || ftpSyncRunning) return;
    setFtpSyncRunning(true);
    setFtpSyncOutput('');
    try {
      const data = await apiFetch('/v1/ftp/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, mode, dryRun }),
      });
      setFtpSyncOutput(data.output || '(no output)');
      setFtpSyncOk(!!data.success);
    } catch (e) {
      setFtpSyncOutput((e as Error).message || 'Sync failed');
      setFtpSyncOk(false);
    } finally { setFtpSyncRunning(false); }
  }

  async function ftpSaveRemote() {
    if (!ftpMapping) return;
    try {
      await apiFetch(`/v1/ftp/connections/${ftpMapping.connectionId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remotePath: ftpRemotePath }),
      });
      await apiFetch('/v1/ftp/dirs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: ftpMapping.cwd, connectionId: ftpMapping.connectionId, remotePath: ftpRemotePath }),
      });
      setFtpMapping({ ...ftpMapping, remotePath: ftpRemotePath });
      setRemoteSaveStatus({ msg: 'Saved', err: false });
    } catch (e) {
      setRemoteSaveStatus({ msg: (e as Error).message || 'Save failed', err: true });
    }
  }

  async function ftpCreateAndLink() {
    if (!cwd) { setNewStatus({ msg: 'No working directory', err: true }); return; }
    if (!newForm.host) { setNewStatus({ msg: 'Host is required', err: true }); return; }
    try {
      const data = await apiFetch('/v1/ftp/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newForm.name || newForm.host, host: newForm.host, user: newForm.user, pass: newForm.pass,
          port: parseInt(newForm.port || '21', 10), ftps: newForm.ftpsMode !== 'none',
          ftpsMode: newForm.ftpsMode, useEpsv: newForm.useEpsv,
        }),
      });
      const conn = data.connection;
      await apiFetch('/v1/ftp/dirs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, connectionId: conn.id, remotePath: newForm.remotePath || '/' }),
      });
      await refresh();
    } catch (e) { setNewStatus({ msg: (e as Error).message, err: true }); }
  }

  async function ftpLinkExisting() {
    if (!cwd) { setExistingStatus({ msg: 'No working directory', err: true }); return; }
    if (!existingConnId) { setExistingStatus({ msg: 'Select a connection', err: true }); return; }
    try {
      await apiFetch('/v1/ftp/dirs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, connectionId: existingConnId, remotePath: existingRemotePath || '/' }),
      });
      await refresh();
    } catch (e) { setExistingStatus({ msg: (e as Error).message, err: true }); }
  }

  async function ftpImport() {
    if (!iniContent.trim()) { setImportStatus({ msg: 'Paste or upload .ini content first', err: true }); return; }
    try {
      const data = await apiFetch('/v1/ftp/import-ini', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iniContent }),
      });
      const msg = `Imported: ${data.imported}, skipped: ${data.skipped}${data.names?.length ? ' — ' + data.names.join(', ') : ''}`;
      setImportStatus({ msg, err: false });
      await refresh();
    } catch (e) { setImportStatus({ msg: (e as Error).message, err: true }); }
  }

  async function ftpDeleteConn(connId: string, connName: string) {
    if (!confirm(`Delete connection "${connName}"?`)) return;
    try {
      await apiFetch(`/v1/ftp/connections/${connId}`, { method: 'DELETE' });
      await refresh();
    } catch (e) { alert('Delete failed: ' + (e as Error).message); }
  }

  // ── FTP Browse ─────────────────────────────────────────────────────────
  async function loadBrowse(path: string, override?: Partial<BrowseState>) {
    setBrowse((p) => ({ ...p, ...override, active: true, path, loading: true, error: '', items: [] }));
    const cur = { ...browse, ...override };
    try {
      const body: any = { path };
      if (cur.connectionId) body.connectionId = cur.connectionId;
      else { body.host = cur.host; body.user = cur.user; body.pass = cur.pass; body.port = cur.port; body.ftpsMode = cur.ftpsMode; body.useEpsv = cur.useEpsv; }
      const data = await apiFetch('/v1/ftp/browse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setBrowse((p) => ({ ...p, items: data.items || [], path: data.path || path, loading: false, error: '' }));
    } catch (e) {
      const msg = (e as Error).message || 'Browse failed';
      setBrowse((p) => ({ ...p, loading: false, error: msg, log: msg }));
    }
  }

  function startBrowseLinked() {
    if (!ftpMapping) return;
    loadBrowse(ftpMapping.remotePath || '/', {
      source: 'linked', connectionId: ftpMapping.connectionId,
      host: ftpMapping.host, user: ftpMapping.user, pass: '', port: ftpMapping.port,
      ftpsMode: ftpMapping.ftps ? 'explicit' : 'none', useEpsv: false,
    });
  }
  function startBrowseNew() {
    if (!newForm.host || !newForm.user) {
      setNewStatus({ msg: 'Fill in Host and User first', err: true });
      return;
    }
    loadBrowse('/', {
      source: 'new', connectionId: '', host: newForm.host, user: newForm.user,
      pass: newForm.pass, port: parseInt(newForm.port || '21', 10),
      ftpsMode: newForm.ftpsMode, useEpsv: newForm.useEpsv,
    });
  }
  function startBrowseExisting() {
    const conn = ftpConnections.find((c) => c.id === existingConnId);
    if (!conn) return;
    loadBrowse('/', {
      source: 'existing', connectionId: existingConnId,
      host: conn.host, user: conn.user, pass: '', port: conn.port,
      ftpsMode: conn.ftpsMode || 'none', useEpsv: conn.useEpsv,
    });
  }

  function browseUseFolder() {
    const path = browse.path;
    setBrowse((p) => ({ ...p, active: false }));
    if (browse.source === 'linked') {
      setFtpRemotePath(path);
      if (ftpMapping) setFtpMapping({ ...ftpMapping, remotePath: path });
      ftpSaveRemote();
    } else if (browse.source === 'new') {
      setNewForm((f) => ({ ...f, remotePath: path }));
    } else {
      setExistingRemotePath(path);
    }
  }

  // ── Sync Tab ───────────────────────────────────────────────────────────
  const loadSyncRemotes = useCallback(async () => {
    try {
      const data = await apiFetch('/v1/rclone/remotes');
      setSyncRemotes(data.remotes || []);
    } catch { setSyncRemotes([]); }
  }, []);

  useEffect(() => { if (topTab === 'sync') loadSyncRemotes(); }, [topTab, loadSyncRemotes]);

  async function runSync(params: { dest: SyncDest; mode: string; dryRun: boolean; remote: string; remotePath: string }) {
    if (!cwd || syncRunning) return;
    setSyncRunning(true);
    setSyncOutput('');
    try {
      if (params.dest === 'ftp') {
        if (!ftpMapping) throw new Error('No FTP mapping for this directory');
        const data = await apiFetch('/v1/ftp/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, mode: params.mode, dryRun: params.dryRun }),
        });
        setSyncOutput(data.output || '(no output)');
        setSyncOk(!!data.success);
      } else {
        if (!params.remote) throw new Error('Select a remote');
        const data = await apiFetch('/v1/rclone/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localPath: cwd, remote: params.remote, remotePath: params.remotePath, mode: params.mode, dryRun: params.dryRun }),
        });
        setSyncOutput(data.output || '(no output)');
        setSyncOk(!!data.success);
      }
    } catch (e) {
      setSyncOutput((e as Error).message || 'Sync failed');
      setSyncOk(false);
    } finally { setSyncRunning(false); }
  }

  // ── Remotes Tab ────────────────────────────────────────────────────────
  const loadRemotes = useCallback(async () => {
    setRemotesLoading(true);
    setRemotesError('');
    try {
      const data = await apiFetch('/v1/rclone/remotes');
      setRemotes(data.remotes || []);
    } catch (e) { setRemotesError((e as Error).message || 'Failed to load remotes'); }
    finally { setRemotesLoading(false); }
  }, []);

  useEffect(() => { if (topTab === 'remotes') loadRemotes(); }, [topTab, loadRemotes]);

  async function deleteRemote(name: string) {
    if (!confirm(`Delete remote "${name}"?`)) return;
    try {
      await apiFetch(`/v1/rclone/remotes/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await loadRemotes();
    } catch (e) { alert('Delete failed: ' + (e as Error).message); }
  }

  async function addRemote(p: { name: string; host: string; port: number; user: string; pass: string; tls: TlsMode }) {
    if (!p.name || !p.host) return { ok: false, msg: 'Name and host are required' };
    const config: Record<string, any> = { host: p.host, user: p.user, pass: p.pass, port: p.port };
    if (p.tls !== 'none') config.tls = p.tls;
    try {
      await apiFetch('/v1/rclone/remotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: p.name, type: 'ftp', config }),
      });
      await loadRemotes();
      return { ok: true, msg: `Remote "${p.name}" added` };
    } catch (e) { return { ok: false, msg: (e as Error).message || 'Add failed' }; }
  }

  async function loadRemoteBrowse(name: string, path: string) {
    setRemoteBrowse({ active: true, name, path, items: [], loading: true, error: '' });
    try {
      const data = await apiFetch('/v1/rclone/browse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: name, path }),
      });
      setRemoteBrowse({ active: true, name, path: data.path || path, items: data.items || [], loading: false, error: '' });
    } catch (e) {
      setRemoteBrowse((s) => ({ ...s, loading: false, error: (e as Error).message || 'Browse failed' }));
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const dotColor = ftpLinked ? '#4caf50' : '#888';

  let tabContent: React.ReactNode = null;
  if (topTab === 'ftp') {
    if (browse.active) {
      tabContent = (
        <BrowseView
          state={browse}
          onNavigate={(p) => loadBrowse(p)}
          onClose={() => setBrowse((s) => ({ ...s, active: false, items: [], error: '' }))}
          onUse={browseUseFolder}
          onTlsRetry={(mode) => {
            // Pull `path` from the setBrowse callback rather than the outer
            // `browse` closure — a rapid second retry would otherwise see
            // the pre-update value and hit the wrong directory.
            setBrowse((s) => {
              loadBrowse(s.path || '/', { ftpsMode: mode });
              return { ...s, ftpsMode: mode };
            });
          }}
          onToggleLog={() => setBrowse((s) => ({ ...s, logVisible: !s.logVisible }))}
        />
      );
    } else if (ftpLinked && ftpMapping) {
      tabContent = (
        <FtpLinkedView
          mapping={ftpMapping}
          onUnlink={ftpUnlink}
          onBrowse={startBrowseLinked}
          onDeploy={ftpDeploy}
          syncRunning={ftpSyncRunning}
          syncOutput={ftpSyncOutput}
          syncOk={ftpSyncOk}
          ftpRemotePath={ftpRemotePath}
          setFtpRemotePath={setFtpRemotePath}
          onSaveRemote={ftpSaveRemote}
          remoteSaveStatus={remoteSaveStatus}
        />
      );
    } else {
      const subTabs: { id: FtpSubTab; label: string }[] = [
        { id: 'new', label: 'New' },
        { id: 'existing', label: `Existing (${ftpConnections.length})` },
        { id: 'import', label: 'Import .ini' },
        { id: 'credentials', label: '🔑 Credentials' },
      ];
      tabContent = (
        <>
          <div className="ftp-tabs" style={{ marginBottom: 12 }}>
            {subTabs.map((t) => (
              <button
                key={t.id}
                className={`ftp-tab${ftpSubTab === t.id ? ' active' : ''}`}
                onClick={() => setFtpSubTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {ftpSubTab === 'new' && (
            <FtpNewForm
              state={newForm}
              setState={setNewForm}
              onCreate={ftpCreateAndLink}
              onBrowse={startBrowseNew}
              status={newStatus}
            />
          )}
          {ftpSubTab === 'existing' && (
            <FtpExistingForm
              connections={ftpConnections}
              selectedConnId={existingConnId || ftpConnections[0]?.id || ''}
              setSelectedConnId={setExistingConnId}
              remotePath={existingRemotePath}
              setRemotePath={setExistingRemotePath}
              onLink={ftpLinkExisting}
              onBrowse={startBrowseExisting}
              status={existingStatus}
            />
          )}
          {ftpSubTab === 'import' && (
            <FtpImportForm
              iniContent={iniContent}
              setIniContent={setIniContent}
              onImport={ftpImport}
              status={importStatus}
            />
          )}
          {ftpSubTab === 'credentials' && (
            <FtpCredentials connections={ftpConnections} onDelete={ftpDeleteConn} />
          )}
        </>
      );
    }
  } else if (topTab === 'sync') {
    tabContent = (
      <SyncView
        cwd={cwd}
        ftpMapping={ftpMapping}
        remotes={syncRemotes}
        onRun={runSync}
        output={syncOutput}
        ok={syncOk}
        running={syncRunning}
      />
    );
  } else if (topTab === 'remotes') {
    tabContent = (
      <RemotesView
        remotes={remotes}
        loading={remotesLoading}
        error={remotesError}
        onRefresh={loadRemotes}
        onAdd={addRemote}
        onDelete={deleteRemote}
        onBrowse={(name) => loadRemoteBrowse(name, '/')}
        browseState={remoteBrowse}
        onBrowseNavigate={(p) => loadRemoteBrowse(remoteBrowse.name, p)}
        onBrowseClose={() => setRemoteBrowse({ active: false, name: '', path: '', items: [], loading: false, error: '' })}
      />
    );
  }

  return (
    <>
      <div className="ftp-panel-header">
        <span className="ftp-panel-title">
          <span className="ftp-panel-title-dot" style={{ background: dotColor }} />
          rclone
        </span>
        <div className="rclone-top-tabs">
          <button className={`rclone-top-tab${topTab === 'ftp' ? ' active' : ''}`} onClick={() => setTopTab('ftp')}>FTP</button>
          <button className={`rclone-top-tab${topTab === 'sync' ? ' active' : ''}`} onClick={() => setTopTab('sync')}>Sync</button>
          <button className={`rclone-top-tab${topTab === 'remotes' ? ' active' : ''}`} onClick={() => setTopTab('remotes')}>Remotes</button>
        </div>
        <button className="ftp-close-btn" onClick={onClose}>✕</button>
      </div>
      <div className="ftp-form-section" style={{ overflowY: 'auto', flex: 1, padding: 12 }}>
        {tabContent}
      </div>
    </>
  );
}

// ── Root component (open/close + content) ────────────────────────────────

export function RcloneModal() {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Wire #btn-cwd-rclone click + rclone:close legacy event
  useEffect(() => {
    const btn = document.getElementById('btn-cwd-rclone');
    btn?.addEventListener('click', open);
    document.addEventListener('rclone:close', close);
    return () => {
      btn?.removeEventListener('click', open);
      document.removeEventListener('rclone:close', close);
    };
  }, [open, close]);

  // Escape key — routed through the shared modal stack so only the top-most
  // open modal closes per press.
  useEffect(() => {
    if (!isOpen) return;
    return pushEscapeHandler(() => close());
  }, [isOpen, close]);

  // CSS in frontend/css/rclone.css keys visibility on #rclone-panel
  // + .rclone-panel-open. We render the host div ourselves now (formerly a
  // top-level <div> in Shell.tsx) so toggling the class is just inline JSX.
  return (
    <>
      {isOpen && createPortal(
        <div
          className="ftp-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
        />,
        document.body,
      )}
      <div
        id="rclone-panel"
        className={isOpen ? 'rclone-panel-open' : ''}
      >
        {isOpen && <PanelContent onClose={close} />}
      </div>
    </>
  );
}
