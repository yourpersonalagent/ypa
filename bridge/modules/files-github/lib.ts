// ── Git integration routes ────────────────────────────────────────────────────
// Provides endpoints to detect repos, show status, stage/unstage, commit, push.
// Uses local git CLI only. HTTPS auth via stored GitHub PAT; SSH works natively.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config, writeEnvKey } = require('../../core/state');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Always disable interactive credential prompts — the server has no TTY.
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo', // returns empty string to any credential prompt → immediate fail
  GCM_INTERACTIVE: 'never', // Git Credential Manager: never prompt
};

function runGit(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...GIT_NO_PROMPT_ENV, ...extraEnv },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(sanitizeGitOutput((stderr || '').trim() || err.message)));
        else resolve((stdout || '').trim());
      },
    );
  });
}

// Like runGit but preserves leading whitespace — required for porcelain status output
// where the first character of each line is a meaningful status column.
function runGitRaw(args: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...GIT_NO_PROMPT_ENV, ...extraEnv },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(sanitizeGitOutput((stderr || '').trim() || err.message)));
        else resolve((stdout || '').replace(/\r?\n$/, '')); // trim only trailing newline
      },
    );
  });
}

const HOME = process.env.HOME || process.env.USERPROFILE || require('os').homedir();

function isAllowed(p: string): boolean {
  // Case-insensitive on Windows so a sessionWorkingDir or extra root that
  // differs only in case (or arrives via long \\?\ prefix from realpath)
  // still grants git access. Mirrors the spirit of samePath() used for depth.
  const pr = path.resolve(p);
  const hr = path.resolve(HOME);
  const prL = process.platform === 'win32' ? pr.toLowerCase() : pr;
  const hrL = process.platform === 'win32' ? hr.toLowerCase() : hr;
  let rel = path.relative(hrL, prL);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  // Also honor config.defaults.workingDir + workingDirs (the "extra roots")
  // so git integration works when a session cwd is deliberately set outside
  // the process HOME (common for multi-project or portable setups).
  try {
    const roots: string[] = [];
    const dw = config && config.defaults && config.defaults.workingDir;
    if (typeof dw === 'string' && dw) roots.push(dw);
    const dws = config && config.defaults && config.defaults.workingDirs;
    if (Array.isArray(dws)) {
      for (const r of dws) if (typeof r === 'string' && r) roots.push(r);
    }
    for (const r of roots) {
      const rr = path.resolve(r);
      const rrL = process.platform === 'win32' ? rr.toLowerCase() : rr;
      rel = path.relative(rrL, prL);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
  } catch (_) {}
  return false;
}

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile(); // .git can be a file in worktrees
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

const SKIP_REPO_SCAN_DIRS = new Set([
  '.cache',
  '.codex',
  '.config',
  '.npm',
  '.vscode',
  'AppData',
  'node_modules',
  'dist',
  'build',
  'target',
  'vendor',
]);

async function discoverChildGitRepos(
  scanDir: string,
  repoSet: Set<string>,
  opts: { maxDepth: number; maxDirs: number },
): Promise<void> {
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (visited >= opts.maxDirs || depth <= 0) return;
    let entries: any[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const e of entries) {
      if (visited >= opts.maxDirs) return;
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_REPO_SCAN_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      if (!isAllowed(sub)) continue;
      visited += 1;
      if (await hasGitDir(sub)) {
        repoSet.add(path.resolve(sub));
        // A git worktree can contain arbitrary dependency folders; don't
        // recurse under detected repo roots while scanning the parent cwd.
        continue;
      }
      await walk(sub, depth - 1);
    }
  }

  await walk(scanDir, opts.maxDepth);
}

async function isDirEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.length === 0;
  } catch {
    return true; // dir doesn't exist yet → treat as empty
  }
}

// Inject a PAT into an HTTPS remote URL.
// Produces: https://oauth2:TOKEN@github.com/user/repo.git
// Works with GitHub, GitLab, Gitea, Bitbucket.
function buildAuthUrl(remoteUrl: string, token: string): string {
  try {
    const u = new URL(remoteUrl);
    u.username = 'oauth2';
    u.password = token;
    return u.toString();
  } catch {
    return remoteUrl; // not a valid URL — leave untouched
  }
}

function isHttpsRemote(remoteUrl: string | null): boolean {
  return !!remoteUrl && (remoteUrl.startsWith('https://') || remoteUrl.startsWith('http://'));
}

function sanitizeGitOutput(msg: string): string {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token || !msg) return msg;
  return msg
    .split(token).join('[redacted]')
    .split(encodeURIComponent(token)).join('[redacted]');
}

function githubSshRemoteToHttps(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;

  // Common SSH/scp forms:
  //   git@github.com:owner/repo.git
  //   git@github-ypa:owner/repo.git  (ssh config alias for github.com)
  let m = remoteUrl.match(/^git@([^:]+):([^/:\s]+\/[^/:\s]+?)(?:\.git)?$/);
  if (m && m[1] && m[2] && isLikelyGithubHost(m[1])) {
    return `https://github.com/${m[2]}.git`;
  }

  // URL-style SSH form:
  //   ssh://git@github.com/owner/repo.git
  m = remoteUrl.match(/^ssh:\/\/git@([^/]+)\/([^/:\s]+\/[^/:\s]+?)(?:\.git)?$/);
  if (m && m[1] && m[2] && isLikelyGithubHost(m[1])) {
    return `https://github.com/${m[2]}.git`;
  }

  return null;
}

function isLikelyGithubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h === 'github' || h.startsWith('github-');
}

function authRemoteTarget(remoteUrl: string | null, token: string): string | null {
  if (!remoteUrl || !token) return null;
  if (isHttpsRemote(remoteUrl)) return buildAuthUrl(remoteUrl, token);
  const httpsUrl = githubSshRemoteToHttps(remoteUrl);
  return httpsUrl ? buildAuthUrl(httpsUrl, token) : null;
}

function isAuthError(msg: string): boolean {
  return (
    msg.includes('could not read Username') ||
    msg.includes('Authentication failed') ||
    msg.includes('invalid credentials') ||
    msg.includes('403') ||
    msg.includes('401')
  );
}

function isReadOnlySshKeyError(msg: string): boolean {
  return /key you are authenticating with has been marked as read only/i.test(msg);
}

interface RepoInfo {
  path: string;
  name: string;
  branch: string;
  remoteUrl: string | null;
  ahead: number;
  behind: number;
}

interface FileStatus {
  file: string;
  staged: boolean;
  untracked: boolean;
  x: string;
  y: string;
}

interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  time: string;
  subject: string;
  remoteOnly?: boolean;
}

function parsePortcelain(output: string): FileStatus[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const x = line[0] ?? ' ';
      const y = line[1] ?? ' ';
      const filePart = line.slice(3);
      const file = filePart.includes(' -> ') ? filePart.split(' -> ')[1] : filePart;
      const untracked = x === '?' && y === '?';
      const staged = !untracked && x !== ' ';
      return { file, staged, untracked, x, y };
    });
}

async function getRepoInfo(repoPath: string): Promise<RepoInfo> {
  let branch = 'HEAD';
  let remoteUrl: string | null = null;
  let ahead = 0;
  let behind = 0;

  try { branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath); } catch (_) {}
  try { remoteUrl = await runGit(['remote', 'get-url', 'origin'], repoPath); } catch (_) {}

  if (remoteUrl && branch && branch !== 'HEAD') {
    // Use local ref state only — same as /v1/git/status. No network fetch here:
    // getRepoInfo is called for every modal open and a git fetch per repo would
    // add 10-30 s on Windows when the remote is slow or auth stalls.
    try {
      const raw = await runGit(
        ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`],
        repoPath,
      );
      const parts = raw.split(/\s+/);
      behind = parseInt(parts[0] ?? '0', 10) || 0;
      ahead  = parseInt(parts[1] ?? '0', 10) || 0;
    } catch (_) {}
  }

  return { path: repoPath, name: path.basename(repoPath), branch, remoteUrl, ahead, behind };
}

// Best-effort guess of the branch to return to after a detached-HEAD jump.
// Order: origin's published default → main → master → first local branch.
async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath);
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1];
  } catch (_) {}
  for (const cand of ['main', 'master']) {
    try {
      await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${cand}`], repoPath);
      return cand;
    } catch (_) {}
  }
  try {
    const first = await runGit(
      ['for-each-ref', '--count=1', '--format=%(refname:short)', 'refs/heads'],
      repoPath,
    );
    if (first) return first;
  } catch (_) {}
  return 'main';
}

// Is HEAD detached (pointing straight at a commit, not a branch)?
async function isDetached(repoPath: string): Promise<boolean> {
  try {
    await runGit(['symbolic-ref', '--quiet', 'HEAD'], repoPath);
    return false; // resolved to a branch ref → attached
  } catch (_) {
    return true; // no symbolic ref → detached (or unborn, treated as attached below)
  }
}

async function fetchOrigin(repoPath: string): Promise<void> {
  let remoteUrl: string | null = null;
  try { remoteUrl = await runGit(['remote', 'get-url', 'origin'], repoPath); } catch (_) {}
  if (!remoteUrl) return;

  const token = (process.env.GITHUB_TOKEN || '').trim();
  const fetchTarget = authRemoteTarget(remoteUrl, token) || 'origin';
  await runGit(['fetch', '--prune', fetchTarget, '+refs/heads/*:refs/remotes/origin/*'], repoPath);
}

function parseCommitLog(raw: string, opts: { remoteOnly?: boolean } = {}): CommitInfo[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, time, ...rest] = line.split('\x1f');
      return { hash, shortHash, author, time, subject: rest.join('\x1f'), remoteOnly: !!opts.remoteOnly };
    });
}

async function getUpstreamRef(repoPath: string): Promise<string | null> {
  try {
    const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoPath);
    if (upstream) return upstream;
  } catch (_) {}

  let branch = 'HEAD';
  try { branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath); } catch (_) {}
  if (!branch || branch === 'HEAD') return null;

  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], repoPath);
    return `origin/${branch}`;
  } catch (_) {
    return null;
  }
}

// Find the containing git worktree root for a (possibly deep) dir via the
// git CLI itself. This lets /v1/git/* and the GitHub panel/button work when
// sessionWorkingDir points at a subfolder inside a repo instead of the root.
// Returns the absolute repo root (if allowed) or null.
async function findGitRoot(startDir: string): Promise<string | null> {
  try {
    const out = await runGit(['rev-parse', '--show-toplevel'], startDir);
    if (out) {
      const abs = path.resolve(out.trim());
      if (isAllowed(abs)) return abs;
    }
  } catch (_) {}
  return null;
}

// ── Route registration ────────────────────────────────────────────────────────

function registerGithubRoutes(app: any) {

  // ── GET /v1/git/token — check whether a PAT is stored ────────────────────
  app.get('/v1/git/token', (_req: any, res: any) => {
    const token = process.env.GITHUB_TOKEN || '';
    res.json({ success: true, hasToken: token.length > 0 });
  });

  // ── POST /v1/git/token — save or clear a GitHub PAT ──────────────────────
  app.post('/v1/git/token', async (req: any, res: any) => {
    const { token } = req.body ?? {};
    const value = String(token ?? '').trim();
    try {
      writeEnvKey('GITHUB_TOKEN', value);
      res.json({ success: true, hasToken: value.length > 0 });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/git/repos — containing repo (for subdir cwds) + direct dir
  // + child repos. This ensures the GitHub button/panel work even when
  // sessionWorkingDir is a subfolder inside a git repo (not just the root), or
  // when the cwd is a workspace directory containing one/more repo folders.
  app.get('/v1/git/repos', async (req: any, res: any) => {
    let scanDir: string = String(req.query.dir || config.defaults?.workingDir || HOME);
    if (scanDir === '~' || scanDir.startsWith('~/')) scanDir = HOME + scanDir.slice(1);
    scanDir = path.resolve(scanDir);

    if (!isAllowed(scanDir)) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const repoSet: Set<string> = new Set();
    const gitRoot = await findGitRoot(scanDir);
    if (gitRoot) repoSet.add(gitRoot);
    if (await hasGitDir(scanDir)) repoSet.add(path.resolve(scanDir));

    // For HOME we intentionally keep the scan shallow. For an explicitly
    // selected project/workspace folder, look a little deeper so monorepo-ish
    // "folder containing repos" layouts are discovered without requiring the
    // user to cd exactly to each repo root.
    await discoverChildGitRepos(scanDir, repoSet, {
      maxDepth: samePath(scanDir, HOME) ? 1 : 2,
      maxDirs: samePath(scanDir, HOME) ? 200 : 500,
    });

    const repoPaths = Array.from(repoSet);
    const hasToken = !!(process.env.GITHUB_TOKEN || '').trim();
    const dirEmpty = await isDirEmpty(scanDir);

    try {
      const repos = await Promise.all(repoPaths.map(getRepoInfo));
      res.json({ success: true, repos, scanDir, hasToken, dirEmpty });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/git/status — changed files for a repo ─────────────────────────
  app.get('/v1/git/status', async (req: any, res: any) => {
    const repoPath = String(req.query.repoPath || '');
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    const abs = path.resolve(repoPath);
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });
    const shouldFetch = String(req.query.fetch || '') === '1';

    try {
      if (shouldFetch) await fetchOrigin(abs);

      const output = await runGitRaw(['status', '--porcelain=v1'], abs);
      const files = parsePortcelain(output);

      let branch = 'HEAD', ahead = 0, behind = 0;
      let remoteUrl: string | null = null;
      try { branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], abs); } catch (_) {}
      try { remoteUrl = await runGit(['remote', 'get-url', 'origin'], abs); } catch (_) {}

      if (remoteUrl && branch && branch !== 'HEAD') {
        try {
          const raw = await runGit(
            ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], abs,
          );
          const parts = raw.split(/\s+/);
          behind = parseInt(parts[0] ?? '0', 10) || 0;
          ahead  = parseInt(parts[1] ?? '0', 10) || 0;
        } catch (_) {}
      }

      // Extras for the commit-history / jump-back UI: which commit we're on,
      // whether HEAD is detached, and the branch a "Return" should target.
      let head = '';
      try { head = await runGit(['rev-parse', 'HEAD'], abs); } catch (_) {}
      const detached = await isDetached(abs);
      const defaultBranch = await getDefaultBranch(abs);

      res.json({ success: true, files, branch, ahead, behind, head, detached, defaultBranch });
    } catch (e: any) {
      if (isAuthError(e.message || '')) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required. Set a GitHub Personal Access Token in the git panel.',
          needsToken: true,
        });
      }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/stage ────────────────────────────────────────────────────
  app.post('/v1/git/stage', async (req: any, res: any) => {
    const { repoPath, files } = req.body ?? {};
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    const abs = path.resolve(String(repoPath));
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    try {
      const args = Array.isArray(files) && files.length > 0
        ? ['add', '--', ...files.map(String)]
        : ['add', '-A'];
      await runGit(args, abs);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/unstage ──────────────────────────────────────────────────
  app.post('/v1/git/unstage', async (req: any, res: any) => {
    const { repoPath, files } = req.body ?? {};
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    const abs = path.resolve(String(repoPath));
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    try {
      const args = Array.isArray(files) && files.length > 0
        ? ['restore', '--staged', '--', ...files.map(String)]
        : ['restore', '--staged', '.'];
      await runGit(args, abs);
      res.json({ success: true });
    } catch (e: any) {
      // Fallback for repos with no commits yet
      try {
        const fb = Array.isArray(files) && files.length > 0
          ? ['rm', '--cached', '--', ...files.map(String)]
          : ['rm', '-r', '--cached', '.'];
        await runGit(fb, abs);
        res.json({ success: true });
      } catch {
        res.status(500).json({ success: false, error: e.message });
      }
    }
  });

  // ── POST /v1/git/commit ───────────────────────────────────────────────────
  app.post('/v1/git/commit', async (req: any, res: any) => {
    const { repoPath, message, stageAll } = req.body ?? {};
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    if (!String(message ?? '').trim()) {
      return res.status(400).json({ success: false, error: 'commit message required' });
    }
    const abs = path.resolve(String(repoPath));
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    try {
      if (stageAll) await runGit(['add', '-A'], abs);
      const out = await runGit(['commit', '-m', String(message).trim()], abs);
      res.json({ success: true, output: out });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/push — with PAT injection for HTTPS remotes ─────────────
  app.post('/v1/git/push', async (req: any, res: any) => {
    const { repoPath } = req.body ?? {};
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    const abs = path.resolve(String(repoPath));
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    try {
      let branch = 'HEAD';
      let remoteUrl: string | null = null;
      try { branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], abs); } catch (_) {}
      try { remoteUrl = await runGit(['remote', 'get-url', 'origin'], abs); } catch (_) {}

      const token = (process.env.GITHUB_TOKEN || '').trim();

      // Build the push target: inject token into HTTPS URLs, and also use the
      // token for GitHub SSH remotes/aliases so the panel's saved token is the
      // credential source for UI pushes.
      const pushTarget = authRemoteTarget(remoteUrl, token) || 'origin';

      let out: string;
      try {
        out = await runGit(['push', pushTarget, branch], abs);
      } catch (firstErr: any) {
        // Retry with --set-upstream if the branch has no upstream yet
        if (firstErr.message.includes('no upstream') || firstErr.message.includes('set-upstream')) {
          out = await runGit(['push', '--set-upstream', pushTarget, branch], abs);
        } else if (isReadOnlySshKeyError(firstErr.message) && !token) {
          return res.status(401).json({
            success: false,
            error:
              'This repository is using an SSH key that GitHub marked read-only. ' +
              'Save a GitHub token in the git panel or switch the remote to a write-capable key.',
            needsToken: true,
          });
        } else if (isHttpsRemote(remoteUrl) && isAuthError(firstErr.message) && !token) {
          // Give a clear, actionable error instead of the raw git message
          return res.status(401).json({
            success: false,
            error: 'Authentication required. Set a GitHub Personal Access Token in the git panel.',
            needsToken: true,
          });
        } else {
          throw firstErr;
        }
      }
      res.json({ success: true, output: out });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/pull ─────────────────────────────────────────────────────
  app.post('/v1/git/pull', async (req: any, res: any) => {
    const { repoPath } = req.body ?? {};
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    const abs = path.resolve(String(repoPath));
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    try {
      let branch = 'HEAD';
      let remoteUrl: string | null = null;
      try { branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], abs); } catch (_) {}
      try { remoteUrl = await runGit(['remote', 'get-url', 'origin'], abs); } catch (_) {}

      const token = (process.env.GITHUB_TOKEN || '').trim();
      const fetchTarget = authRemoteTarget(remoteUrl, token);
      let out: string;
      if (fetchTarget && branch && branch !== 'HEAD') {
        await runGit(['fetch', '--prune', fetchTarget, '+refs/heads/*:refs/remotes/origin/*'], abs);
        out = await runGit(['merge', '--ff-only', `origin/${branch}`], abs);
      } else {
        out = await runGit(['pull', '--ff-only'], abs);
      }
      res.json({ success: true, output: out });
    } catch (e: any) {
      if (isReadOnlySshKeyError(e.message || '') && !(process.env.GITHUB_TOKEN || '').trim()) {
        return res.status(401).json({
          success: false,
          error:
            'This repository is using an SSH key that GitHub marked read-only. ' +
            'Save a GitHub token in the git panel or switch the remote to a write-capable key.',
          needsToken: true,
        });
      }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/clone — clone a remote URL into an empty dir ────────────
  app.post('/v1/git/clone', async (req: any, res: any) => {
    const { dir, url } = req.body ?? {};
    if (!dir || !url) {
      return res.status(400).json({ success: false, error: 'dir and url required' });
    }
    let abs: string = String(dir);
    if (abs === '~' || abs.startsWith('~/')) abs = HOME + abs.slice(1);
    abs = path.resolve(abs);
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    const cloneUrlRaw = String(url).trim();
    if (!cloneUrlRaw) return res.status(400).json({ success: false, error: 'url required' });

    try {
      // Refuse to overwrite a non-empty directory
      try {
        const entries = await fs.promises.readdir(abs);
        if (entries.length > 0) {
          return res.status(400).json({ success: false, error: 'Directory is not empty' });
        }
      } catch {
        // dir doesn't exist yet — that's fine, git clone will create it
      }

      // Inject token into HTTPS URLs so private repos work
      const token = (process.env.GITHUB_TOKEN || '').trim();
      const cloneUrl = (token && (cloneUrlRaw.startsWith('https://') || cloneUrlRaw.startsWith('http://')))
        ? buildAuthUrl(cloneUrlRaw, token)
        : cloneUrlRaw;

      // Run from parent dir; git creates / fills the target itself
      const parent = path.dirname(abs);
      try { await fs.promises.mkdir(parent, { recursive: true }); } catch {}

      try {
        await runGit(['clone', cloneUrl, abs], parent);
      } catch (err: any) {
        if (isHttpsRemote(cloneUrlRaw) && isAuthError(err.message) && !token) {
          return res.status(401).json({
            success: false,
            error: 'Authentication required. Set a GitHub Personal Access Token in the git panel.',
            needsToken: true,
          });
        }
        throw err;
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/init — git init + create a GitHub repo + add remote ──────
  app.post('/v1/git/init', async (req: any, res: any) => {
    const { dir, name, isPrivate, description } = req.body ?? {};
    if (!dir || !name) {
      return res.status(400).json({ success: false, error: 'dir and name required' });
    }
    let abs: string = String(dir);
    if (abs === '~' || abs.startsWith('~/')) abs = HOME + abs.slice(1);
    abs = path.resolve(abs);
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    const repoName = String(name).trim();
    if (!repoName) return res.status(400).json({ success: false, error: 'name required' });

    const token = (process.env.GITHUB_TOKEN || '').trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'GitHub token required to create a remote repository.',
        needsToken: true,
      });
    }

    try {
      try { await fs.promises.mkdir(abs, { recursive: true }); } catch {}

      // 1. Create the GitHub repo first — if this fails, no local state changed
      const ghResp = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'yha-bridge',
        },
        body: JSON.stringify({
          name: repoName,
          private: !!isPrivate,
          description: String(description || '').trim() || undefined,
          auto_init: false,
        }),
      });
      if (!ghResp.ok) {
        const errBody: any = await ghResp.json().catch(() => ({}));
        const msg = (errBody && (errBody.message || errBody.errors?.[0]?.message)) || `GitHub API error ${ghResp.status}`;
        return res.status(ghResp.status).json({ success: false, error: msg });
      }
      const ghRepo = await ghResp.json() as any;
      const remoteUrl: string = ghRepo.clone_url || ghRepo.html_url;

      // 2. git init (idempotent — skip if already a repo)
      if (!(await hasGitDir(abs))) {
        try {
          await runGit(['init', '--initial-branch=main'], abs);
        } catch {
          // Older git versions don't support --initial-branch
          await runGit(['init'], abs);
          try { await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], abs); } catch {}
        }
      }

      // 3. Replace any existing origin
      try { await runGit(['remote', 'remove', 'origin'], abs); } catch {}
      await runGit(['remote', 'add', 'origin', remoteUrl], abs);

      res.json({ success: true, remoteUrl, htmlUrl: ghRepo.html_url });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/git/log ───────────────────────────────────────────────────────
  app.get('/v1/git/log', async (req: any, res: any) => {
    const repoPath = String(req.query.repoPath || '');
    if (!repoPath) return res.status(400).json({ success: false, error: 'repoPath required' });
    const abs = path.resolve(repoPath);
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    const limit = Math.min(parseInt(String(req.query.limit || '10'), 10), 50);
    const shouldFetch = String(req.query.fetch || '') === '1';
    try {
      if (shouldFetch) await fetchOrigin(abs);

      const upstream = await getUpstreamRef(abs);
      let remoteOnly: CommitInfo[] = [];
      if (upstream) {
        try {
          const remoteRaw = await runGit(
            ['log', `--max-count=${limit}`, '--pretty=format:%H\x1f%h\x1f%an\x1f%ar\x1f%s', `HEAD..${upstream}`],
            abs,
          );
          remoteOnly = parseCommitLog(remoteRaw, { remoteOnly: true });
        } catch (_) {}
      }

      const localRaw = await runGit(
        ['log', `--max-count=${limit}`, '--pretty=format:%H\x1f%h\x1f%an\x1f%ar\x1f%s'],
        abs,
      );
      const commits = [...remoteOnly, ...parseCommitLog(localRaw)].slice(0, limit);
      res.json({ success: true, commits });
    } catch (e: any) {
      if (isAuthError(e.message || '')) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required. Set a GitHub Personal Access Token in the git panel.',
          needsToken: true,
        });
      }
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/git/checkout — jump the working tree to a commit/branch ───────
  // SAFE BY DESIGN: this only ever runs a plain `git checkout <ref>`. Git:
  //   • NEVER deletes untracked or ignored files — your databases, .env / API
  //     keys and chat history stay exactly where they are.
  //   • ABORTS instead of clobbering uncommitted *tracked* changes (we surface
  //     that as hasLocalChanges so the UI can tell you to commit first).
  // We deliberately never use `-f`/`--force`, `reset --hard`, or `clean`.
  app.post('/v1/git/checkout', async (req: any, res: any) => {
    const { repoPath, ref } = req.body ?? {};
    if (!repoPath || !ref) {
      return res.status(400).json({ success: false, error: 'repoPath and ref required' });
    }
    const abs = path.resolve(String(repoPath));
    if (!isAllowed(abs)) return res.status(403).json({ success: false, error: 'Access denied' });

    const target = String(ref).trim();
    // Whitelist ref characters and forbid a leading dash so a ref can never be
    // smuggled in as a git option (e.g. "--orphan"). execFile already avoids a
    // shell, this is defence in depth.
    if (!target || target.startsWith('-') || !/^[0-9A-Za-z._/-]+$/.test(target)) {
      return res.status(400).json({ success: false, error: 'Invalid ref' });
    }

    try {
      let out: string;
      try {
        out = await runGit(['checkout', target], abs);
      } catch (err: any) {
        const msg = err.message || '';
        if (/local changes|would be overwritten|Please commit|Aborting|stash them/i.test(msg)) {
          return res.status(409).json({
            success: false,
            hasLocalChanges: true,
            error:
              'Uncommitted changes would be overwritten. Commit or discard your tracked ' +
              'changes first — your ignored files (databases, keys, chat history) are never touched.',
          });
        }
        throw err;
      }

      let head = '';
      try { head = await runGit(['rev-parse', 'HEAD'], abs); } catch (_) {}
      let branch = 'HEAD';
      try { branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], abs); } catch (_) {}
      const detached = await isDetached(abs);

      res.json({ success: true, output: out, head, branch, detached });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerGithubRoutes };
