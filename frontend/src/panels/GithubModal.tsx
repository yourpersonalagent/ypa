// GithubModal — git source-control panel.
// Detects git repos in the configured working dir + first-level subdirs.
// VSCode-style staging, commit, push UI + GitHub PAT management.
// Owns both the open/close UX (trigger button, backdrop, Escape key) AND
// the panel content rendering. Replaces panels/github.ts (deleted).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, getToastActions } from '../stores/index.js';
import { getSessionState, useSessionStore } from '../stores/sessionStore.js';
import { confirm } from '../stores/confirmStore.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface GitRepo {
  path: string;
  name: string;
  branch: string;
  remoteUrl?: string;
  ahead: number;
  behind: number;
}

interface GitFile {
  file: string;
  x: string;
  y: string;
  untracked: boolean;
  staged: boolean;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  time: string;
  subject: string;
  remoteOnly?: boolean;
}

interface RepoState {
  files: GitFile[] | null;
  loading: boolean;
  commitMsg: string;
  busy: boolean;
  statusMsg: string;
  statusErr: boolean;
  expanded: boolean;
  // Commit history / jump-back
  commits: GitCommit[] | null;
  logLoading: boolean;
  logExpanded: boolean;
  head: string;          // full hash of the current checkout (for "you are here")
  detached: boolean;     // HEAD points at a commit, not a branch
  defaultBranch: string; // server's best guess for "Return to latest"
  priorBranch: string;   // branch we left when jumping — preferred Return target
  checkoutBusy: boolean;
}

interface GitApiResult {
  success: boolean;
  error?: string;
  repos?: GitRepo[];
  hasToken?: boolean;
  files?: GitFile[];
  branch?: string;
  ahead?: number;
  behind?: number;
  needsToken?: boolean;
  dirEmpty?: boolean;
  scanDir?: string;
  remoteUrl?: string;
  htmlUrl?: string;
  commits?: GitCommit[];
  head?: string;
  detached?: boolean;
  defaultBranch?: string;
  hasLocalChanges?: boolean;
}

function effectiveWorkingDir(): string | null {
  const appState = useAppStore.getState();
  if (appState.sessionWorkingDir) return appState.sessionWorkingDir;

  // sessionWorkingDir is mirrored asynchronously from the session subsystem.
  // During stream reconnects, fast session switches, or an early module mount
  // it can briefly be null/stale even though the session store already knows
  // the active session's cwd. Use the session store as the authoritative
  // fallback so the GitHub panel scans the same cwd the header shows.
  const sessionState = getSessionState();
  const currentId = String(
    sessionState.currentId || appState.currentSession || localStorage.getItem('yha.currentSession') || '',
  );
  const current = sessionState.sessions.find((s) => String(s.id) === currentId)
    || sessionState._cache.find((s) => String(s.id) === currentId);
  return current?.workingDir || sessionState.defaultWorkingDir || null;
}

// ── API helper ───────────────────────────────────────────────────────────

async function apiFetch(method: string, url: string, body?: unknown): Promise<GitApiResult> {
  const opts: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json() as Promise<GitApiResult>;
}

// ── Git status label ─────────────────────────────────────────────────────

function statusLabel(x: string, y: string, untracked: boolean): { char: string; cls: string; title: string } {
  if (untracked) return { char: '?', cls: 'gh-s-untracked', title: 'Untracked' };
  const code = x !== ' ' ? x : y;
  switch (code) {
    case 'M': return { char: 'M', cls: 'gh-s-modified', title: 'Modified' };
    case 'A': return { char: 'A', cls: 'gh-s-added',    title: 'Added' };
    case 'D': return { char: 'D', cls: 'gh-s-deleted',  title: 'Deleted' };
    case 'R': return { char: 'R', cls: 'gh-s-renamed',  title: 'Renamed' };
    case 'C': return { char: 'C', cls: 'gh-s-copied',   title: 'Copied' };
    case 'U': return { char: 'U', cls: 'gh-s-conflict', title: 'Conflict' };
    default:  return { char: code || '?', cls: 'gh-s-modified', title: 'Changed' };
  }
}

function shortPath(file: string): string {
  const parts = file.split('/');
  return parts.length <= 2 ? file : '…/' + parts.slice(-2).join('/');
}

// ── Sync badge ───────────────────────────────────────────────────────────

function SyncBadge({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead > 0 && behind > 0) {
    return <span className="gh-sync-badge gh-sync-diverged" title={`${ahead} ahead, ${behind} behind`}>↑{ahead} ↓{behind}</span>;
  }
  if (ahead > 0) return <span className="gh-sync-badge gh-sync-ahead" title={`${ahead} ahead`}>↑{ahead}</span>;
  if (behind > 0) return <span className="gh-sync-badge gh-sync-behind" title={`${behind} behind`}>↓{behind}</span>;
  return null;
}

// ── File row ─────────────────────────────────────────────────────────────

function FileRow({
  file,
  onClick,
}: {
  file: GitFile;
  onClick: () => void;
}) {
  const lbl = statusLabel(file.x, file.y, file.untracked);
  return (
    <div
      className="gh-file-row"
      title={file.staged ? `Click to unstage: ${file.file}` : `Click to stage: ${file.file}`}
      onClick={onClick}
    >
      <span className={`gh-file-status ${lbl.cls}`} title={lbl.title}>{lbl.char}</span>
      <span className="gh-file-name">{shortPath(file.file)}</span>
      <span className="gh-file-toggle">{file.staged ? '−' : '+'}</span>
    </div>
  );
}

// ── Commits / jump-back ────────────────────────────────────────────────────

function CommitsSection({
  state,
  onToggle,
  onJump,
  onReturn,
}: {
  state: RepoState;
  onToggle: () => void;
  onJump: (c: GitCommit) => void;
  onReturn: () => void;
}) {
  const commits = state.commits ?? [];
  const hasTrackedChanges = (state.files ?? []).some((f) => !f.untracked);
  const returnTo = state.priorBranch || state.defaultBranch || 'latest';

  return (
    <div className="gh-history">
      <div className="gh-history-header" onClick={onToggle}>
        <span className="gh-repo-chevron">{state.logExpanded ? '▾' : '▸'}</span>
        <span className="gh-history-title">Commits</span>
        {state.detached && (
          <span className="gh-detached-tag" title="Detached HEAD — viewing an old commit">detached</span>
        )}
      </div>

      {state.logExpanded && (
        <div className="gh-history-body">
          {state.detached && (
            <div className="gh-detached-banner">
              <span>Viewing old code (detached HEAD). New edits here aren't on a branch.</span>
              <button
                className="gh-btn gh-btn-return"
                disabled={state.checkoutBusy}
                onClick={onReturn}
                title={`Re-attach HEAD to ${returnTo}`}
              >
                ↩ Return to {returnTo}
              </button>
            </div>
          )}

          {hasTrackedChanges && !state.detached && (
            <div className="gh-history-warn" title="Commit or discard tracked changes before jumping">
              ⚠ Uncommitted changes — a jump is blocked until you commit or discard them. (Ignored
              files like databases &amp; keys are always safe.)
            </div>
          )}

          {state.logLoading && <div className="gh-loading">Loading commits…</div>}
          {!state.logLoading && commits.length === 0 && <div className="gh-empty">No commits yet</div>}

          {!state.logLoading &&
            commits.map((c) => {
              const isHead = !!state.head && c.hash === state.head;
              return (
                <div
                  key={c.hash}
                  className={`gh-commit-row${isHead ? ' gh-commit-current' : ''}${c.remoteOnly ? ' gh-commit-remote' : ''}`}
                >
                  <span className="gh-commit-hash" title={c.hash}>{c.shortHash}</span>
                  <span className="gh-commit-info">
                    <span className="gh-commit-subject" title={c.subject}>{c.subject}</span>
                    <span className="gh-commit-meta">
                      {c.author} · {c.time}
                      {c.remoteOnly && <span className="gh-commit-remote-tag"> · on GitHub</span>}
                    </span>
                  </span>
                  {isHead ? (
                    <span className="gh-commit-here" title="You are here">● here</span>
                  ) : (
                    <button
                      className="gh-commit-jump"
                      disabled={state.checkoutBusy}
                      title={`Jump to ${c.shortHash} — safe checkout, keeps ignored files`}
                      onClick={() => onJump(c)}
                    >
                      jump
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ── Repo card ────────────────────────────────────────────────────────────

function RepoCard({
  repo,
  state,
  hasToken,
  onToggle,
  onRefresh,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onUnstageAll,
  onCommitMsgChange,
  onCommit,
  onSync,
  onUpdate,
  onToggleHistory,
  onJump,
  onReturn,
}: {
  repo: GitRepo;
  state: RepoState;
  hasToken: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onStageFile: (file: string) => void;
  onUnstageFile: (file: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommitMsgChange: (msg: string) => void;
  onCommit: () => void;
  onSync: () => void;
  onUpdate: () => void;
  onToggleHistory: () => void;
  onJump: (c: GitCommit) => void;
  onReturn: () => void;
}) {
  const files = state.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);
  const hasStagedFiles = staged.length > 0;

  const isHttps = repo.remoteUrl && repo.remoteUrl.startsWith('http');
  const syncTitle = !repo.remoteUrl
    ? 'No remote configured'
    : isHttps && !hasToken
      ? 'Set a GitHub token to push over HTTPS'
      : 'Push to origin';

  const remoteRepoName = repo.remoteUrl
    ? (repo.remoteUrl.match(/[\/:]([^\/:]+?)(?:\.git)?$/)?.[1] ?? null)
    : null;
  const showRemoteName = remoteRepoName && remoteRepoName !== repo.name;

  return (
    <div className="gh-repo-card">
      <div
        className="gh-repo-header"
        onClick={(e) => {
          if ((e.target as Element).closest('.gh-refresh-btn')) return;
          onToggle();
        }}
      >
        <span className="gh-repo-chevron">{state.expanded ? '▾' : '▸'}</span>
        <span className="gh-repo-name">
          {repo.name}
          {showRemoteName && (
            <span className="gh-repo-remote-name" title={repo.remoteUrl}> (repo:{remoteRepoName})</span>
          )}
        </span>
        <span className="gh-repo-branch" title="Branch">{repo.branch || 'HEAD'}</span>
        <SyncBadge ahead={repo.ahead} behind={repo.behind} />
        {files.length > 0 && <span className="gh-count-badge">{files.length}</span>}
        <button
          className="gh-refresh-btn"
          title="Refresh"
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
        >↻</button>
      </div>
      {state.expanded && (
        <div className="gh-repo-body">
          {state.loading && <div className="gh-loading">Loading…</div>}
          {!state.loading && files.length === 0 && <div className="gh-empty">Working tree clean</div>}
          {!state.loading && staged.length > 0 && (
            <>
              <div className="gh-section-label">
                Staged <span className="gh-section-count">{staged.length}</span>
                <button className="gh-link-btn" onClick={onUnstageAll}>Unstage All</button>
              </div>
              {staged.map((f) => (
                <FileRow key={`s-${f.file}`} file={f} onClick={() => onUnstageFile(f.file)} />
              ))}
            </>
          )}
          {!state.loading && unstaged.length > 0 && (
            <>
              <div className="gh-section-label">
                Changes <span className="gh-section-count">{unstaged.length}</span>
                <button className="gh-link-btn" onClick={onStageAll}>Stage All</button>
              </div>
              {unstaged.map((f) => (
                <FileRow key={`u-${f.file}`} file={f} onClick={() => onStageFile(f.file)} />
              ))}
            </>
          )}
          {!state.loading && (
            <div className="gh-commit-area">
              <textarea
                className="gh-commit-msg"
                placeholder="Message (⌘↵ to commit)"
                value={state.commitMsg}
                onChange={(e) => onCommitMsgChange(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (hasStagedFiles && !state.busy && state.commitMsg.trim()) onCommit();
                  }
                }}
              />
              <div className="gh-commit-actions">
                <button
                  className="gh-btn gh-btn-commit"
                  disabled={!hasStagedFiles || state.busy}
                  title={hasStagedFiles ? 'Commit staged changes' : 'Stage files first'}
                  onClick={onCommit}
                >
                  Commit
                </button>
                <button
                  className="gh-btn gh-btn-sync"
                  disabled={!repo.remoteUrl || state.busy}
                  title={syncTitle}
                  onClick={onSync}
                >
                  ↑ Sync
                </button>
                {repo.behind > 0 && (
                  <button
                    className="gh-btn gh-btn-update"
                    disabled={!repo.remoteUrl || state.busy}
                    title={`Fast-forward from origin (${repo.behind} commit${repo.behind === 1 ? '' : 's'})`}
                    onClick={onUpdate}
                  >
                    ↓ Update
                  </button>
                )}
              </div>
              {state.statusMsg && (
                <div className={`gh-status-msg ${state.statusErr ? 'gh-status-err' : 'gh-status-ok'}`}>
                  {state.statusMsg}
                </div>
              )}
            </div>
          )}
          {!state.loading && (
            <CommitsSection
              state={state}
              onToggle={onToggleHistory}
              onJump={onJump}
              onReturn={onReturn}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Token form ───────────────────────────────────────────────────────────

function TokenForm({
  hasToken,
  onSave,
  onClear,
  inputRef,
}: {
  hasToken: boolean;
  onSave: (token: string) => void;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [val, setVal] = useState('');
  return (
    <form className="gh-token-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSave(val); }}>
      <input
        ref={inputRef}
        className="gh-token-input"
        type="password"
        placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
        autoComplete="off"
        spellCheck={false}
        title="GitHub Personal Access Token with repo scope"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSave(val); }
        }}
      />
      <div className="gh-token-row">
        <button type="button" className="gh-btn gh-btn-token-save" onClick={() => onSave(val)}>Save token</button>
        {hasToken && <button type="button" className="gh-btn gh-btn-token-clear" onClick={onClear}>Clear</button>}
      </div>
      <div className="gh-token-hint">
        Needs <code>repo</code> scope. SSH remotes work without a token.
      </div>
    </form>
  );
}

// ── Init form (non-empty dir, no git → create new GitHub repo) ──────────

function InitForm({
  scanDir,
  hasToken,
  busy,
  onCreate,
  onAskToken,
}: {
  scanDir: string;
  hasToken: boolean;
  busy: boolean;
  onCreate: (name: string, isPrivate: boolean) => void;
  onAskToken: () => void;
}) {
  const dirName = scanDir.split('/').filter(Boolean).pop() || '';
  const [name, setName] = useState(dirName);
  const [isPrivate, setIsPrivate] = useState(true);

  return (
    <div className="gh-token-form">
      <div className="gh-token-hint">
        No git repository in <code>{scanDir || 'this folder'}</code>. Create a new GitHub repo and link it here.
      </div>
      <input
        className="gh-token-input"
        type="text"
        placeholder="repository name"
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hasToken && !busy && name.trim()) {
            e.preventDefault();
            onCreate(name.trim(), isPrivate);
          }
        }}
      />
      <div className="gh-token-row" style={{ alignItems: 'center', gap: 10 }}>
        <label style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="radio"
            name="gh-init-vis"
            checked={isPrivate}
            onChange={() => setIsPrivate(true)}
          />
          Private
        </label>
        <label style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="radio"
            name="gh-init-vis"
            checked={!isPrivate}
            onChange={() => setIsPrivate(false)}
          />
          Public
        </label>
      </div>
      <div className="gh-token-row">
        {hasToken ? (
          <button
            className="gh-btn gh-btn-token-save"
            disabled={busy || !name.trim()}
            onClick={() => onCreate(name.trim(), isPrivate)}
          >
            {busy ? 'Creating…' : 'Create repository'}
          </button>
        ) : (
          <button
            className="gh-btn gh-btn-token-save"
            onClick={onAskToken}
          >
            Set GitHub token first
          </button>
        )}
      </div>
    </div>
  );
}

// ── Clone form (empty dir, no git → clone a remote URL into it) ─────────

function CloneForm({
  scanDir,
  busy,
  onClone,
}: {
  scanDir: string;
  busy: boolean;
  onClone: (url: string) => void;
}) {
  const [url, setUrl] = useState('');
  return (
    <div className="gh-token-form">
      <div className="gh-token-hint">
        <code>{scanDir || 'this folder'}</code> is empty. Clone a repository into it.
      </div>
      <input
        className="gh-token-input"
        type="text"
        placeholder="https://github.com/user/repo.git"
        value={url}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy && url.trim()) {
            e.preventDefault();
            onClone(url.trim());
          }
        }}
      />
      <div className="gh-token-row">
        <button
          className="gh-btn gh-btn-token-save"
          disabled={busy || !url.trim()}
          onClick={() => onClone(url.trim())}
        >
          {busy ? 'Cloning…' : 'Clone repository'}
        </button>
      </div>
    </div>
  );
}

// ── Panel content (rendered into #github-panel when open) ───────────────

function PanelContent({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [repoStates, setRepoStates] = useState<Record<string, RepoState>>({});
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [dirEmpty, setDirEmpty] = useState(false);
  const [scanDir, setScanDir] = useState<string>('');
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyMsg, setEmptyMsg] = useState<{ text: string; err: boolean } | null>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const sessionCurrentId = useSessionStore((s) => s.currentId);
  const sessionDefaultWorkingDir = useSessionStore((s) => s.defaultWorkingDir);
  const sessionCwdForCurrent = useSessionStore((s) => {
    const cur = s.sessions.find((entry) => String(entry.id) === String(s.currentId))
      || s._cache.find((entry) => String(entry.id) === String(s.currentId));
    return cur?.workingDir || null;
  });

  const loadRepos = useCallback(async (): Promise<{
    repos: GitRepo[]; hasToken: boolean; dirEmpty: boolean; scanDir: string;
  }> => {
    const dir = effectiveWorkingDir();
    const url = dir ? `/v1/git/repos?dir=${encodeURIComponent(dir)}` : '/v1/git/repos';
    const data = await apiFetch('GET', url);
    if (!data.success) throw new Error(data.error || 'Failed to load repos');
    return {
      repos: data.repos ?? [],
      hasToken: !!data.hasToken,
      dirEmpty: !!data.dirEmpty,
      scanDir: data.scanDir ?? '',
    };
  }, []);

  const refreshRepoStatus = useCallback(async (repoPath: string, fetchRemote = false) => {
    setRepoStates((prev) => {
      const cur = prev[repoPath];
      if (!cur) return prev;
      return { ...prev, [repoPath]: { ...cur, loading: true } };
    });
    try {
      const data = await apiFetch(
        'GET',
        `/v1/git/status?repoPath=${encodeURIComponent(repoPath)}${fetchRemote ? '&fetch=1' : ''}`,
      );
      if (!data.success) throw new Error(data.error || 'status failed');
      setRepoStates((prev) => {
        const cur = prev[repoPath];
        if (!cur) return prev;
        return {
          ...prev,
          [repoPath]: {
            ...cur,
            loading: false,
            files: data.files ?? [],
            head: data.head ?? '',
            detached: !!data.detached,
            defaultBranch: data.defaultBranch ?? cur.defaultBranch,
          },
        };
      });
      setRepos((prev) =>
        prev.map((r) =>
          r.path === repoPath
            ? { ...r, branch: data.branch ?? r.branch, ahead: data.ahead ?? r.ahead, behind: data.behind ?? r.behind }
            : r,
        ),
      );
    } catch (err) {
      setRepoStates((prev) => {
        const cur = prev[repoPath];
        if (!cur) return prev;
        return { ...prev, [repoPath]: { ...cur, loading: false, statusMsg: (err as Error).message, statusErr: true } };
      });
    }
  }, []);

  const loadLog = useCallback(async (repoPath: string, fetchRemote = false) => {
    setRepoStates((prev) => {
      const cur = prev[repoPath];
      if (!cur) return prev;
      return { ...prev, [repoPath]: { ...cur, logLoading: true } };
    });
    try {
      const data = await apiFetch(
        'GET',
        `/v1/git/log?repoPath=${encodeURIComponent(repoPath)}&limit=10${fetchRemote ? '&fetch=1' : ''}`,
      );
      if (!data.success) throw new Error(data.error || 'log failed');
      setRepoStates((prev) => {
        const cur = prev[repoPath];
        if (!cur) return prev;
        return { ...prev, [repoPath]: { ...cur, logLoading: false, commits: data.commits ?? [] } };
      });
    } catch (err) {
      setRepoStates((prev) => {
        const cur = prev[repoPath];
        if (!cur) return prev;
        return { ...prev, [repoPath]: { ...cur, logLoading: false, statusMsg: (err as Error).message, statusErr: true } };
      });
    }
  }, []);

  const refreshOneRepo = useCallback(async (repoPath: string, fetchRemoteLog = false) => {
    await refreshRepoStatus(repoPath, fetchRemoteLog);
    const st = repoStates[repoPath];
    if (st?.logExpanded) await loadLog(repoPath, fetchRemoteLog);
  }, [loadLog, refreshRepoStatus, repoStates]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { repos: newRepos, hasToken: newHasToken, dirEmpty: newDirEmpty, scanDir: newScanDir } = await loadRepos();
      setRepos(newRepos);
      setHasToken(newHasToken);
      setDirEmpty(newDirEmpty);
      setScanDir(newScanDir);
      const norm = (s: string) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');
      const sd = norm(newScanDir || '');
      const next: Record<string, RepoState> = {};
      for (const repo of newRepos) {
        const r = norm(repo.path);
        const matchesCwd = sd === r || sd.startsWith(r + '/');
        next[repo.path] = repoStates[repo.path] ?? {
          files: null,
          loading: false,
          commitMsg: '',
          busy: false,
          statusMsg: '',
          statusErr: false,
          expanded: newRepos.length === 1 || matchesCwd,
          commits: null,
          logLoading: false,
          logExpanded: false,
          head: '',
          detached: false,
          defaultBranch: '',
          priorBranch: '',
          checkoutBusy: false,
        };
      }
      setRepoStates(next);
      // Ensure the repo containing the current scanDir (i.e. "my repo for this cwd")
      // is expanded even on hard refresh (fresh mount, no prior repoStates) or
      // after a cwd change. The ?? init above covers the fresh case; this
      // forces it if a prev collapsed state existed for that repo.
      if (newScanDir) {
        const norm2 = (s: string) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const sd2 = norm2(newScanDir);
        let best: string | null = null;
        let bestLen = -1;
        for (const r of newRepos) {
          const rn = norm2(r.path);
          if (sd2 === rn || sd2.startsWith(rn + '/')) {
            if (rn.length > bestLen) { best = r.path; bestLen = rn.length; }
          }
        }
        if (best) {
          setRepoStates((prev) => {
            const cur = prev[best!];
            if (!cur || cur.expanded) return prev;
            return { ...prev, [best!]: { ...cur, expanded: true } };
          });
        }
      }
      await Promise.all(newRepos.map(async (r) => {
        await refreshRepoStatus(r.path, true);
        if (repoStates[r.path]?.logExpanded) await loadLog(r.path, true);
      }));
    } catch (err) {
      console.error('[github] refresh error:', err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLog, loadRepos, refreshRepoStatus]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh when working dir changes
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionWorkingDir, sessionCurrentId, sessionCwdForCurrent, sessionDefaultWorkingDir]);

  // Update repo state helper
  function updateRepoState(repoPath: string, patch: Partial<RepoState>) {
    setRepoStates((prev) => {
      const cur = prev[repoPath];
      if (!cur) return prev;
      return { ...prev, [repoPath]: { ...cur, ...patch } };
    });
  }

  async function stageFiles(repoPath: string, files: string[], unstage: boolean) {
    const st = repoStates[repoPath];
    if (!st || st.busy) return;
    updateRepoState(repoPath, { busy: true });
    try {
      const url = unstage ? '/v1/git/unstage' : '/v1/git/stage';
      const r = await apiFetch('POST', url, { repoPath, files });
      if (!r.success) throw new Error(r.error || (unstage ? 'unstage failed' : 'stage failed'));
      await refreshRepoStatus(repoPath);
    } catch (err) {
      updateRepoState(repoPath, { statusMsg: (err as Error).message, statusErr: true });
    } finally {
      updateRepoState(repoPath, { busy: false });
    }
  }

  async function commitRepo(repoPath: string) {
    const st = repoStates[repoPath];
    if (!st || st.busy) return;
    const msg = st.commitMsg.trim();
    if (!msg) {
      updateRepoState(repoPath, { statusMsg: 'Enter a commit message first.', statusErr: true });
      return;
    }
    updateRepoState(repoPath, { busy: true, statusMsg: '' });
    try {
      const r = await apiFetch('POST', '/v1/git/commit', { repoPath, message: msg });
      if (!r.success) throw new Error(r.error || 'Commit failed');
      updateRepoState(repoPath, { commitMsg: '', statusMsg: 'Committed successfully.', statusErr: false });
      await refreshRepoStatus(repoPath);
      if (repoStates[repoPath]?.logExpanded) await loadLog(repoPath);
    } catch (err) {
      updateRepoState(repoPath, { statusMsg: (err as Error).message, statusErr: true });
    } finally {
      updateRepoState(repoPath, { busy: false });
    }
  }

  async function syncRepo(repoPath: string) {
    const st = repoStates[repoPath];
    if (!st || st.busy) return;
    updateRepoState(repoPath, { busy: true, statusMsg: 'Pushing…', statusErr: false });
    try {
      const r = await apiFetch('POST', '/v1/git/push', { repoPath });
      if (!r.success) {
        if (r.needsToken) {
          setShowTokenInput(true);
          updateRepoState(repoPath, { busy: false, statusMsg: 'Auth required — set a GitHub token ↑ above.', statusErr: true });
          setTimeout(() => tokenInputRef.current?.focus(), 50);
          return;
        }
        throw new Error(r.error || 'Push failed');
      }
      updateRepoState(repoPath, { statusMsg: 'Pushed to origin.', statusErr: false });
      await refreshRepoStatus(repoPath);
      if (repoStates[repoPath]?.logExpanded) await loadLog(repoPath, true);
    } catch (err) {
      updateRepoState(repoPath, { statusMsg: (err as Error).message, statusErr: true });
    } finally {
      updateRepoState(repoPath, { busy: false });
    }
  }

  async function updateRepo(repoPath: string) {
    const st = repoStates[repoPath];
    if (!st || st.busy) return;
    updateRepoState(repoPath, { busy: true, statusMsg: 'Updating…', statusErr: false });
    try {
      const r = await apiFetch('POST', '/v1/git/pull', { repoPath });
      if (!r.success) throw new Error(r.error || 'Update failed');
      updateRepoState(repoPath, { statusMsg: 'Updated from origin.', statusErr: false });
      await refreshRepoStatus(repoPath);
      if (repoStates[repoPath]?.logExpanded) await loadLog(repoPath, true);
    } catch (err) {
      updateRepoState(repoPath, { statusMsg: (err as Error).message, statusErr: true });
    } finally {
      updateRepoState(repoPath, { busy: false });
    }
  }

  // Jump the working tree to a commit (detached) or back to a branch (isReturn).
  // Routes through the safe /v1/git/checkout — never force, reset, or clean.
  async function jumpTo(repoPath: string, ref: string, opts?: { isReturn?: boolean; label?: string }) {
    const st = repoStates[repoPath];
    if (!st || st.checkoutBusy) return;
    const repo = repos.find((r) => r.path === repoPath);
    const hasTrackedChanges = (st.files ?? []).some((f) => !f.untracked);

    if (!opts?.isReturn) {
      const ok = await confirm({
        scope: 'git-checkout',
        title: 'Jump to commit',
        message:
          `Switch the working tree to:\n${opts?.label ?? ref}\n\n` +
          `Safe checkout (detached HEAD). Your ignored & untracked files — databases, ` +
          `API keys, chat history — are NOT touched.\n\n` +
          (hasTrackedChanges
            ? `⚠ You have uncommitted tracked changes. Git will refuse the jump unless you commit or discard them first.`
            : `Working tree is clean, so this is fully reversible — use "Return" to come back.`),
        confirmLabel: 'Jump',
        cancelLabel: 'Cancel',
        danger: true,
        trustMs: 0,
      });
      if (!ok) return;
    }

    // Remember the branch to come back to — only when leaving an attached branch.
    const priorBranch =
      !st.detached && repo && repo.branch && repo.branch !== 'HEAD' ? repo.branch : st.priorBranch;

    updateRepoState(repoPath, {
      checkoutBusy: true,
      statusMsg: opts?.isReturn ? 'Returning…' : 'Jumping…',
      statusErr: false,
      priorBranch,
    });
    try {
      const r = await apiFetch('POST', '/v1/git/checkout', { repoPath, ref });
      if (!r.success) {
        if (r.hasLocalChanges) {
          updateRepoState(repoPath, { statusMsg: r.error || 'Uncommitted changes block this jump.', statusErr: true });
          return;
        }
        throw new Error(r.error || 'Checkout failed');
      }
      updateRepoState(repoPath, {
        statusMsg: opts?.isReturn
          ? `Back on ${r.branch || priorBranch || 'latest'}.`
          : `Now at ${ref.slice(0, 7)} (detached) — use Return to come back.`,
        statusErr: false,
      });
      await refreshRepoStatus(repoPath);
      await loadLog(repoPath);
    } catch (err) {
      updateRepoState(repoPath, { statusMsg: (err as Error).message, statusErr: true });
    } finally {
      updateRepoState(repoPath, { checkoutBusy: false });
    }
  }

  async function saveToken(token: string) {
    try {
      const result = await apiFetch('POST', '/v1/git/token', { token: token.trim() });
      if (!result.success) throw new Error(result.error || 'Save failed');
      setHasToken(result.hasToken ?? false);
      setShowTokenInput(false);
      getToastActions().show(token.trim() ? 'GitHub token saved.' : 'GitHub token cleared.', 'ok');
    } catch (err) {
      getToastActions().show((err as Error).message, 'err');
    }
  }

  async function clearToken() {
    try {
      await apiFetch('POST', '/v1/git/token', { token: '' });
      setHasToken(false);
      setShowTokenInput(false);
      getToastActions().show('GitHub token cleared.', 'ok');
    } catch (err) {
      getToastActions().show((err as Error).message, 'err');
    }
  }

  function toggleTokenForm() {
    setShowTokenInput((v) => !v);
    setTimeout(() => { if (tokenInputRef.current) tokenInputRef.current.focus(); }, 30);
  }

  async function createRepo(name: string, isPrivate: boolean) {
    const dir = scanDir || effectiveWorkingDir();
    if (!dir) {
      setEmptyMsg({ text: 'No working directory selected.', err: true });
      return;
    }
    setEmptyBusy(true);
    setEmptyMsg(null);
    try {
      const r = await apiFetch('POST', '/v1/git/init', { dir, name, isPrivate });
      if (!r.success) {
        if (r.needsToken) {
          setShowTokenInput(true);
          setTimeout(() => tokenInputRef.current?.focus(), 50);
        }
        throw new Error(r.error || 'Init failed');
      }
      setEmptyMsg({ text: `Created ${r.htmlUrl ?? 'repository'}.`, err: false });
      await refresh();
    } catch (err) {
      setEmptyMsg({ text: (err as Error).message, err: true });
    } finally {
      setEmptyBusy(false);
    }
  }

  async function cloneRepo(url: string) {
    const dir = scanDir || effectiveWorkingDir();
    if (!dir) {
      setEmptyMsg({ text: 'No working directory selected.', err: true });
      return;
    }
    setEmptyBusy(true);
    setEmptyMsg(null);
    try {
      const r = await apiFetch('POST', '/v1/git/clone', { dir, url });
      if (!r.success) {
        if (r.needsToken) {
          setShowTokenInput(true);
          setTimeout(() => tokenInputRef.current?.focus(), 50);
        }
        throw new Error(r.error || 'Clone failed');
      }
      setEmptyMsg({ text: 'Cloned successfully.', err: false });
      await refresh();
    } catch (err) {
      setEmptyMsg({ text: (err as Error).message, err: true });
    } finally {
      setEmptyBusy(false);
    }
  }

  if (loading) {
    return <div className="gh-loading">Scanning for repositories…</div>;
  }

  if (repos.length === 0) {
    return (
      <>
        <div className="gh-panel-header">
          <span className="gh-panel-title">Source Control</span>
          <span className="gh-header-actions">
            <button
              className={`gh-token-btn ${hasToken ? 'gh-token-ok' : 'gh-token-missing'}`}
              title={hasToken ? 'GitHub token configured — click to update' : 'No GitHub token — required to create repositories'}
              onClick={toggleTokenForm}
            >🔑</button>
            <button className="gh-refresh-all-btn" title="Scan again" onClick={refresh}>↻</button>
            {!embedded && <button className="gh-close-btn" title="Close" onClick={onClose}>✕</button>}
          </span>
        </div>
        {showTokenInput && (
          <TokenForm
            hasToken={hasToken}
            onSave={saveToken}
            onClear={clearToken}
            inputRef={tokenInputRef}
          />
        )}
        {dirEmpty ? (
          <CloneForm scanDir={scanDir} busy={emptyBusy} onClone={cloneRepo} />
        ) : (
          <InitForm
            scanDir={scanDir}
            hasToken={hasToken}
            busy={emptyBusy}
            onCreate={createRepo}
            onAskToken={() => {
              setShowTokenInput(true);
              setTimeout(() => tokenInputRef.current?.focus(), 50);
            }}
          />
        )}
        {emptyMsg && (
          <div className={`gh-status-msg ${emptyMsg.err ? 'gh-status-err' : 'gh-status-ok'}`} style={{ margin: '0 10px 10px' }}>
            {emptyMsg.text}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="gh-panel-header">
        <span className="gh-panel-title">Source Control</span>
        <span className="gh-header-actions">
          <button
            className={`gh-token-btn ${hasToken ? 'gh-token-ok' : 'gh-token-missing'}`}
            title={hasToken ? 'GitHub token configured — click to update' : 'No GitHub token — HTTPS push requires one'}
            onClick={toggleTokenForm}
          >🔑</button>
          <button className="gh-refresh-all-btn" title="Refresh" onClick={refresh}>↻</button>
          {!embedded && <button className="gh-close-btn" title="Close" onClick={onClose}>✕</button>}
        </span>
      </div>
      {showTokenInput && (
        <TokenForm
          hasToken={hasToken}
          onSave={saveToken}
          onClear={clearToken}
          inputRef={tokenInputRef}
        />
      )}
      {repos.map((repo) => {
        const state = repoStates[repo.path];
        if (!state) return null;
        return (
          <RepoCard
            key={repo.path}
            repo={repo}
            state={state}
            hasToken={hasToken}
            onToggle={async () => {
              const willExpand = !state.expanded;
              updateRepoState(repo.path, { expanded: willExpand });
              if (willExpand && !state.files) await refreshRepoStatus(repo.path);
            }}
            onRefresh={() => refreshOneRepo(repo.path, true)}
            onStageFile={(f) => stageFiles(repo.path, [f], false)}
            onUnstageFile={(f) => stageFiles(repo.path, [f], true)}
            onStageAll={() => stageFiles(repo.path, [], false)}
            onUnstageAll={() => stageFiles(repo.path, [], true)}
            onCommitMsgChange={(msg) => updateRepoState(repo.path, { commitMsg: msg })}
            onCommit={() => commitRepo(repo.path)}
            onSync={() => syncRepo(repo.path)}
            onUpdate={() => updateRepo(repo.path)}
            onToggleHistory={async () => {
              const willExpand = !state.logExpanded;
              updateRepoState(repo.path, { logExpanded: willExpand });
              if (willExpand && !state.commits) await loadLog(repo.path, true);
            }}
            onJump={(c) => jumpTo(repo.path, c.hash, { label: `${c.shortHash} — ${c.subject}` })}
            onReturn={() =>
              jumpTo(repo.path, state.priorBranch || state.defaultBranch || 'main', { isReturn: true })
            }
          />
        );
      })}
    </>
  );
}

// ── GitHub-button visibility detector ─────────────────────────────────────

function useGithubButtonVisibility() {
  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  useEffect(() => {
    // This button is the entry point for repairing Git/GitHub state (init,
    // clone, add/link a remote, set token). Do not hide it based on a repo
    // scan: a slow/unauthorized/stale API response makes the repair path
    // disappear, which is worse than showing a harmless action for any cwd.
    const btn = document.getElementById('btn-cwd-github') as HTMLButtonElement | null;
    if (btn) btn.hidden = false;
  }, [sessionWorkingDir]);
}

// ── Root component (open/close + content) ─────────────────────────────────

interface GithubModalProps {
  // Embedded mode: render PanelContent inline without backdrop, button-
  // visibility hook, or trigger-button wiring. Used by the Code view's
  // GitHub tab — the singleton modal still owns the global trigger.
  embedded?: boolean;
}

export function GithubModal({ embedded = false }: GithubModalProps = {}) {
  const [isOpen, setIsOpen] = useState(embedded);

  // Idempotent — keeps #btn-cwd-github available even when repo detection
  // fails; the panel itself is where users repair/create/link git state.
  useGithubButtonVisibility();

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // Open/close via document-level events, not a listener bound to the
  // #btn-cwd-github node. This singleton lives above the layout router and
  // never remounts, but the button (rendered by CwdActionsSlot inside
  // FullLayout) is destroyed and recreated on every layout switch. Binding
  // straight to the node would attach the listener once to the original
  // node and silently orphan it after the first layout change. The button's
  // React onClick dispatches `github:open` instead — see files-github/index.
  useEffect(() => {
    if (embedded) return;
    document.addEventListener('github:open', open);
    document.addEventListener('github:close', close);
    return () => {
      document.removeEventListener('github:open', open);
      document.removeEventListener('github:close', close);
    };
  }, [open, close, embedded]);

  // Escape key
  useEffect(() => {
    if (embedded || !isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close, embedded]);

  if (embedded) {
    // Bare panel — caller wraps it in a height-bounded scroll container.
    return (
      <div id="github-panel-embedded" className="github-panel-embedded">
        <PanelContent onClose={close} embedded />
      </div>
    );
  }

  // CSS in frontend/css/layout/core.css keys visibility on #github-panel
  // + .github-panel-open. We render the host div ourselves now (formerly a
  // top-level <div> in Shell.tsx) so toggling the class is just inline JSX.
  return (
    <>
      {isOpen && createPortal(
        <div
          className="github-modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
        />,
        document.body,
      )}
      <div
        id="github-panel"
        className={isOpen ? 'github-panel-open' : ''}
      >
        {isOpen && <PanelContent onClose={close} />}
      </div>
    </>
  );
}
