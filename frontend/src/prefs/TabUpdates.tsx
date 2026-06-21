import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

// Baked in at build time by Vite's `define` (see frontend/vite.config.js).
// Reading it through a typeof-guard keeps non-Vite contexts (e.g. unit tests)
// from throwing a ReferenceError when the literal wasn't substituted.
declare const __APP_VERSION__: string;
const BUILD_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const STANDARD_UPDATE_URL = 'https://github.com/yourpersonalagent/ypa';
const UPDATE_SOURCE_KEY = 'ypa.updateSource.v1';

type OriginUpdateHint = {
  owner: string;
  repo: string;
  branch: string | null;
  customUrl: string;
};

type VersionInfo = {
  version: string;
  commit: string | null;
  branch: string | null;
  describe: string | null;
  dirty: boolean;
  isRepo: boolean;
  originUpdate?: OriginUpdateHint | null;
};

const VERSION_FETCH_OPTS: RequestInit = { credentials: 'same-origin' };

type CommitEntry = { hash: string; subject: string; author: string; when: string };

type UpdateMode = 'standard' | 'custom';
type UpdateSource = {
  mode: UpdateMode;
  owner: string;
  repo: string;
  repoUrl: string;
  branch: string;
  displayUrl: string;
};

type CheckResult = {
  branch: string | null;
  upstream: string | null;
  source?: UpdateSource;
  fetchOk: boolean;
  fetchError?: string | null;
  ahead: number;
  behind: number;
  upToDate: boolean;
  dirty: boolean;
  localVersion: string;
  remoteVersion: string | null;
  commits: CommitEntry[];
  note?: string;
};

type SavedUpdateSource = {
  mode?: UpdateMode;
  customUrl?: string;
  privateToken?: string;
};

export function TabUpdates() {
  const apiBase = api.config.baseUrl;
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [infoErr, setInfoErr] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const [savedSource] = useState<SavedUpdateSource>(() => {
    try {
      return JSON.parse(localStorage.getItem(UPDATE_SOURCE_KEY) || '{}') as SavedUpdateSource;
    } catch {
      return {};
    }
  });
  const [updateMode, setUpdateMode] = useState<UpdateMode>(
    savedSource.mode === 'custom' ? 'custom' : 'standard',
  );
  const [customUrl, setCustomUrl] = useState(
    typeof savedSource.customUrl === 'string' ? savedSource.customUrl : '',
  );
  const [privateToken, setPrivateToken] = useState(
    typeof savedSource.privateToken === 'string' ? savedSource.privateToken : '',
  );

  function showStatus(text: string, isError = false) {
    setStatus(text);
    setStatusErr(isError);
    if (text && !isError) {
      setTimeout(() => setStatus((cur) => (cur === text ? '' : cur)), 6000);
    }
  }

  const loadInfo = useCallback(async () => {
    try {
      const r = await fetch(apiBase + '/v1/version', VERSION_FETCH_OPTS);
      const d = await readJsonResponse(r) as VersionInfo;
      setInfo(d);
      setInfoErr('');
    } catch (e) {
      setInfoErr((e as Error).message);
    }
  }, [apiBase]);

  useEffect(() => { void loadInfo(); }, [loadInfo]);

  const persistUpdateSource = useCallback(async () => {
    try {
      await fetch(apiBase + '/v1/version/source', {
        ...VERSION_FETCH_OPTS,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: updateMode,
          url: updateMode === 'custom' ? customUrl.trim() : STANDARD_UPDATE_URL,
          token: privateToken.trim() || undefined,
        }),
      });
    } catch { /* best effort — YHA Net background sync reads server copy */ }
  }, [apiBase, updateMode, customUrl, privateToken]);

  useEffect(() => {
    localStorage.setItem(UPDATE_SOURCE_KEY, JSON.stringify({
      mode: updateMode,
      customUrl,
      privateToken,
    }));
    void persistUpdateSource();
  }, [updateMode, customUrl, privateToken, persistUpdateSource]);

  function updateRequestBody() {
    return {
      mode: updateMode,
      url: updateMode === 'custom' ? customUrl.trim() : STANDARD_UPDATE_URL,
      token: privateToken.trim() || undefined,
    };
  }

  async function readJsonResponse(r: Response) {
    if (r.status === 401) {
      throw new Error('Session expired — refresh the page and sign in again.');
    }
    const d = (await r.json()) as { success?: boolean; error?: string };
    if (!r.ok || d.success === false) {
      throw new Error(d.error || `Request failed (${r.status})`);
    }
    return d;
  }

  function parseGithubUrlPreview(raw: string) {
    const text = raw.trim();
    if (!text) return null;
    const ssh = text.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (ssh) return { repo: `${ssh[1]}/${ssh[2]}`, branch: '' };
    try {
      const u = new URL(text);
      if (u.hostname.toLowerCase() !== 'github.com') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return null;
      const repo = `${parts[0]}/${parts[1].replace(/\.git$/i, '')}`;
      const branch = parts[2] === 'tree' && parts.length > 3 ? decodeURIComponent(parts.slice(3).join('/')) : '';
      return { repo, branch };
    } catch {
      return null;
    }
  }

  async function handleCheck() {
    setChecking(true);
    setStatus('');
    try {
      const r = await fetch(apiBase + '/v1/version/check', {
        ...VERSION_FETCH_OPTS,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateRequestBody()),
      });
      const d = await readJsonResponse(r) as CheckResult;
      setCheck(d);
      if (!d.fetchOk) {
        const detail = d.fetchError || d.note || 'comparing against the last fetched state';
        showStatus(`⚠ Could not refresh from remote — ${detail}`, true);
      } else if (d.upToDate) {
        showStatus('✓ You are on the latest version.');
      } else {
        showStatus(`${d.behind} new commit${d.behind === 1 ? '' : 's'} available.`);
      }
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    } finally {
      setChecking(false);
    }
  }

  async function handleApply() {
    if (!confirm(
      'Fast-forward this checkout to the latest upstream commit?\n\n' +
      'This only updates the source. Services are NOT restarted automatically — ' +
      'you must rebuild and restart (yha.ps1 build) afterward for changes to take effect.',
    )) return;
    setApplying(true);
    setStatus('');
    try {
      const r = await fetch(apiBase + '/v1/version/apply', {
        ...VERSION_FETCH_OPTS,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateRequestBody()),
      });
      const d = await readJsonResponse(r) as {
        previousVersion?: string; version?: string;
      };
      showStatus(`✓ Updated ${d.previousVersion} → ${d.version}. Rebuild & restart required.`);
      await loadInfo();
      await handleCheck();
    } catch (e) {
      showStatus('✗ ' + (e as Error).message, true);
    } finally {
      setApplying(false);
    }
  }

  const updateAvailable = !!check && !check.upToDate && check.behind > 0;
  // Reason the guarded apply is blocked, or '' when it's allowed.
  const applyBlockedReason = (() => {
    if (!updateAvailable) return '';
    if (info?.dirty || check?.dirty) return 'Uncommitted changes in the working tree — commit or stash them first.';
    if (check && check.ahead > 0) return `Local branch is ${check.ahead} commit(s) ahead — a clean fast-forward isn't possible.`;
    return '';
  })();
  const canApply = updateAvailable && !applyBlockedReason && !applying;
  const versionMismatch = !!info && BUILD_VERSION !== 'dev' && info.version !== BUILD_VERSION;
  const customPreview = updateMode === 'custom' ? parseGithubUrlPreview(customUrl) : null;
  const sourceLabel = check?.source?.displayUrl || (updateMode === 'standard' ? STANDARD_UPDATE_URL : customUrl.trim());
  const originHint = info?.originUpdate ?? null;
  const showOriginHint = !!originHint
    && updateMode === 'standard'
    && info?.branch
    && info.branch !== 'main'
    && `${originHint.owner}/${originHint.repo}` !== 'yourpersonalagent/ypa';

  return (
    <>
      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Installed version</h4>
        {infoErr ? (
          <div className="prefs-hint" style={{ color: 'var(--err, #f66)' }}>✗ {infoErr}</div>
        ) : !info ? (
          <div className="prefs-hint">Loading…</div>
        ) : (
          <>
            <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Version</label>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg)' }}>{info.version}</span>
              {info.dirty && (
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'var(--bg-2)', color: 'var(--warn, #e6b450)' }}>● uncommitted changes</span>
              )}
            </div>
            <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Build</label>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)' }}>
                {info.describe || info.commit || '(no git metadata)'}{info.branch ? `  ·  ${info.branch}` : ''}
              </span>
            </div>
            <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Frontend bundle</label>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)' }}>{BUILD_VERSION}</span>
            </div>
            {versionMismatch && (
              <div className="prefs-hint" style={{ color: 'var(--warn, #e6b450)' }}>
                The loaded frontend bundle ({BUILD_VERSION}) differs from the source VERSION ({info.version}).
                Rebuild the frontend (or hard-reload) to pick up the latest build.
              </div>
            )}
          </>
        )}
      </section>

      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Updates</h4>
        <div className="prefs-hint" style={{ marginBottom: 8 }}>
          Checks the selected GitHub source for newer YPA commits. Applying an update fast-forwards
          the source only; it never pushes, uploads, restarts services, or changes your git remote.
        </div>
        {showOriginHint && originHint && (
          <div className="prefs-hint" style={{ marginBottom: 8, color: 'var(--warn, #e6b450)' }}>
            This checkout tracks <code>{originHint.owner}/{originHint.repo}</code>
            {originHint.branch ? <> on <code>{originHint.branch}</code></> : null}.
            For staging installs, switch to Custom and use{' '}
            <code>{originHint.customUrl}</code> (add a private-repo token if needed).
          </div>
        )}
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Source</label>
          <div style={{ display: 'inline-flex', gap: 4, padding: 3, border: '1px solid var(--stroke)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-2)' }}>
            <button
              type="button"
              className="prefs-btn"
              aria-pressed={updateMode === 'standard'}
              onClick={() => { setUpdateMode('standard'); setCheck(null); }}
              style={{ background: updateMode === 'standard' ? 'var(--accent)' : 'transparent', color: updateMode === 'standard' ? 'var(--accent-ink, #fff)' : 'var(--fg)' }}
            >
              Standard
            </button>
            <button
              type="button"
              className="prefs-btn"
              aria-pressed={updateMode === 'custom'}
              onClick={() => { setUpdateMode('custom'); setCheck(null); }}
              style={{ background: updateMode === 'custom' ? 'var(--accent)' : 'transparent', color: updateMode === 'custom' ? 'var(--accent-ink, #fff)' : 'var(--fg)' }}
            >
              Custom
            </button>
          </div>
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Repository</label>
          {updateMode === 'standard' ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)' }}>{STANDARD_UPDATE_URL}</span>
          ) : (
            <input
              className="prefs-input"
              value={customUrl}
              onChange={(e) => { setCustomUrl(e.target.value); setCheck(null); }}
              placeholder="https://github.com/owner/repo/tree/branch"
              style={{ flex: '1 1 360px', minWidth: 220 }}
            />
          )}
        </div>
        {updateMode === 'custom' && customPreview && (
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Parsed</label>
            <span className="prefs-hint" style={{ margin: 0 }}>
              Repo <code>{customPreview.repo}</code>{customPreview.branch ? <> · branch <code>{customPreview.branch}</code></> : ' · default branch'}
            </span>
          </div>
        )}
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Private repo</label>
          <input
            className="prefs-input"
            type="password"
            value={privateToken}
            onChange={(e) => setPrivateToken(e.target.value)}
            placeholder="GitHub read token (saved in this browser)"
            style={{ flex: '1 1 260px', minWidth: 220 }}
          />
          <span className="prefs-hint" style={{ margin: 0 }}>
            Stored locally for private repos — not sent to YHA servers.
          </span>
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="prefs-btn" disabled={checking || (updateMode === 'custom' && !customUrl.trim())} onClick={() => { void handleCheck(); }}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          <button
            className="prefs-btn"
            disabled={!canApply}
            title={applyBlockedReason || (updateAvailable ? 'Fast-forward to the latest commit' : 'Run a check first')}
            onClick={() => { void handleApply(); }}
          >
            {applying ? 'Updating…' : 'Update now'}
          </button>
          <span className="prefs-hint" style={{ margin: 0, flex: 1, minWidth: 160, color: statusErr ? 'var(--err, #f66)' : 'var(--fg-dim)' }}>{status}</span>
        </div>

        {check && (
          <div style={{ marginTop: 10 }}>
            <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Update source</label>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)', overflowWrap: 'anywhere' }}>
                {sourceLabel || '(not configured)'}
              </span>
            </div>
            <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Fetched ref</label>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-dim)' }}>
                {check.upstream || '(none)'}
              </span>
            </div>
            <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label className="prefs-field-lbl" style={{ minWidth: 110 }}>Status</label>
              <span style={{ fontSize: 12, color: check.upToDate ? 'var(--ok, #6c6)' : 'var(--fg)' }}>
                {check.upToDate
                  ? 'Up to date'
                  : `${check.behind} behind${check.ahead ? `, ${check.ahead} ahead` : ''}`}
                {check.remoteVersion && check.remoteVersion !== check.localVersion && (
                  <> · remote VERSION <code>{check.remoteVersion}</code></>
                )}
              </span>
            </div>
            {check.note && <div className="prefs-hint">{check.note}</div>}
            {applyBlockedReason && (
              <div className="prefs-hint" style={{ color: 'var(--warn, #e6b450)' }}>{applyBlockedReason}</div>
            )}

            {check.commits.length > 0 && (
              <>
                <div className="prefs-hint" style={{ marginTop: 10, textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 10, color: 'var(--fg-mute)' }}>
                  Incoming commits
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, maxHeight: 280, overflowY: 'auto', border: '1px solid var(--stroke)', borderRadius: 'var(--radius-sm)', padding: 6, background: 'var(--bg-2)' }}>
                  {check.commits.map((c) => (
                    <div key={c.hash} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 8px', borderRadius: 'var(--radius-xs)', background: 'var(--bg)', border: '1px solid var(--stroke)' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent)' }}>{c.hash}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</div>
                        <div style={{ fontSize: 10, color: 'var(--fg-mute)' }}>{c.author} · {c.when}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {updateAvailable && !applyBlockedReason && (
              <div className="prefs-hint" style={{ marginTop: 8 }}>
                After updating, rebuild and restart with <code>yha.ps1 build</code> (or your usual launcher) so the
                new source is compiled and served.
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
