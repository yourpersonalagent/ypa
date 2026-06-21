// Shared git/version helpers for system routes and YHA Net peer manifests.
// @ts-nocheck
'use strict';

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(REPO_ROOT, 'VERSION');
const STANDARD_UPDATE_REPO = 'https://github.com/yourpersonalagent/ypa.git';
const UPDATE_REF_PREFIX = 'refs/ypa-updates';

const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
};
const GIT_DEFAULT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;

function resolveGitExecutable() {
  const candidates = process.platform === 'win32'
    ? ['git', 'git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
    : ['git', '/usr/bin/git', '/usr/local/bin/git'];
  for (const cand of candidates) {
    try {
      execFileSync(cand, ['--version'], { timeout: 5000, stdio: 'ignore' });
      return cand;
    } catch { /* try next */ }
  }
  return 'git';
}

const GIT_EXECUTABLE = resolveGitExecutable();

function redactText(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

function runGit(args, opts = {}) {
  const redact = Array.isArray(opts.redact) ? opts.redact.filter(Boolean) : [];
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : GIT_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      GIT_EXECUTABLE,
      args,
      { cwd: REPO_ROOT, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...GIT_NO_PROMPT_ENV } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(redactText((stderr || '').trim() || err.message, redact)));
        else resolve(redactText((stdout || '').trim(), redact));
      },
    );
  });
}

async function gitSafe(args) {
  try { return await runGit(args); } catch { return null; }
}

async function gitSafeRedacted(args, redact) {
  try { return await runGit(args, { redact }); } catch { return null; }
}

function readVersionFile() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() || 'dev'; } catch { return 'dev'; }
}

async function getOriginUpdateHint(branch) {
  const raw = await gitSafe(['remote', 'get-url', 'origin']);
  if (!raw) return null;
  try {
    const parsed = normalizeGithubRepoUrl(raw);
    const activeBranch = branch && branch !== 'HEAD' ? branch : null;
    const customUrl = activeBranch
      ? `https://github.com/${parsed.owner}/${parsed.repo}/tree/${activeBranch}`
      : `https://github.com/${parsed.owner}/${parsed.repo}`;
    return { owner: parsed.owner, repo: parsed.repo, branch: activeBranch, customUrl };
  } catch { return null; }
}

async function getVersionInfo() {
  const version = readVersionFile();
  const [commit, branch, describe, status] = await Promise.all([
    gitSafe(['rev-parse', '--short', 'HEAD']),
    gitSafe(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitSafe(['describe', '--tags', '--always', '--dirty']),
    gitSafe(['status', '--porcelain']),
  ]);
  const originUpdate = await getOriginUpdateHint(branch);
  return {
    version,
    commit: commit || null,
    branch: branch || null,
    describe: describe || null,
    dirty: status !== null && status.length > 0,
    isRepo: commit !== null,
    originUpdate,
  };
}

function isSafeBranchName(branch) {
  if (!branch || typeof branch !== 'string') return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return false;
  if (branch.includes('..') || branch.includes('@{') || branch.endsWith('.lock')) return false;
  return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(branch);
}

function normalizeGithubRepoUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Update repository URL is required.');
  let match = input.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (match) return { owner: match[1], repo: match[2], branch: null };
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('Use a GitHub repository URL.'); }
  if (parsed.hostname.toLowerCase() !== 'github.com') throw new Error('Only github.com update sources are supported.');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub URL must include owner and repository.');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  let branch = null;
  if (parts[2] === 'tree' && parts.length > 3) branch = decodeURIComponent(parts.slice(3).join('/'));
  return { owner, repo, branch };
}

function buildUpdateSource(body = {}) {
  const mode = body.mode === 'custom' ? 'custom' : 'standard';
  const parsed = normalizeGithubRepoUrl(mode === 'standard' ? STANDARD_UPDATE_REPO : body.url);
  let branch = body.branch ? String(body.branch).trim() : parsed.branch;
  if (branch && !isSafeBranchName(branch)) throw new Error('Update branch contains unsupported characters.');
  const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  return {
    mode,
    owner: parsed.owner,
    repo: parsed.repo,
    repoUrl,
    branch: branch || null,
    displayUrl: branch
      ? `https://github.com/${parsed.owner}/${parsed.repo}/tree/${branch}`
      : `https://github.com/${parsed.owner}/${parsed.repo}`,
  };
}

function withGithubToken(repoUrl, token) {
  const cleanToken = typeof token === 'string' ? token.trim() : '';
  if (!cleanToken) return { url: repoUrl, redact: [] };
  const parsed = new URL(repoUrl);
  if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.protocol !== 'https:') {
    return { url: repoUrl, redact: [] };
  }
  parsed.username = 'x-access-token';
  parsed.password = cleanToken;
  return { url: parsed.toString(), redact: [cleanToken, encodeURIComponent(cleanToken)] };
}

function normalizeGitLines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function parseSymrefHeadLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('ref: refs/heads/')) return null;
  const rest = trimmed.slice('ref: refs/heads/'.length);
  const match = rest.match(/^(.+?)(?:\t| )HEAD$/);
  if (!match) return null;
  const branch = match[1].trim();
  return isSafeBranchName(branch) ? branch : null;
}

async function resolveRemoteDefaultBranch(remoteUrl, redact) {
  const out = await gitSafeRedacted(['ls-remote', '--symref', remoteUrl, 'HEAD'], redact);
  if (!out) return null;
  for (const line of normalizeGitLines(out).split('\n')) {
    const branch = parseSymrefHeadLine(line);
    if (branch) return branch;
  }
  return null;
}

async function remoteHasBranch(remoteUrl, branch, redact) {
  if (!isSafeBranchName(branch)) return false;
  const out = await gitSafeRedacted(['ls-remote', '--heads', remoteUrl, branch], redact);
  return !!(out && out.split('\n').some((line) => line.endsWith(`refs/heads/${branch}`)));
}

async function resolveUpdateBranch(source, tokenized, localBranch) {
  if (source.branch) return source.branch;
  const fromDefault = await resolveRemoteDefaultBranch(tokenized.url, tokenized.redact);
  if (fromDefault) return fromDefault;
  if (localBranch && isSafeBranchName(localBranch) && localBranch !== 'HEAD') {
    if (await remoteHasBranch(tokenized.url, localBranch, tokenized.redact)) return localBranch;
  }
  return null;
}

async function prepareUpdateTarget(body, localBranch = null) {
  const source = buildUpdateSource(body);
  const tokenized = withGithubToken(source.repoUrl, body?.token);
  const branch = await resolveUpdateBranch(source, tokenized, localBranch);
  if (!branch) throw new Error('Could not resolve the update branch.');
  const remoteRef = `${UPDATE_REF_PREFIX}/${branch}`;
  return {
    source: { ...source, branch, displayUrl: `https://github.com/${source.owner}/${source.repo}/tree/${branch}` },
    remoteUrl: tokenized.url,
    remoteRef,
    redact: tokenized.redact,
  };
}

async function fetchUpdateTarget(target) {
  try {
    await runGit(
      ['fetch', '--quiet', target.remoteUrl, `+refs/heads/${target.source.branch}:${target.remoteRef}`],
      { redact: target.redact, timeout: GIT_FETCH_TIMEOUT_MS },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkForUpdates(body = {}) {
  const localBranch = await gitSafe(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!localBranch) return { success: false, error: 'Not a git repository.' };

  const target = await prepareUpdateTarget(body, localBranch);
  const fetchResult = await fetchUpdateTarget(target);
  const fetchOk = fetchResult.ok;
  const remoteExists = await gitSafe(['rev-parse', '--verify', '--quiet', target.remoteRef]);
  if (!remoteExists) {
    return {
      success: true,
      branch: localBranch,
      upstream: target.remoteRef,
      source: target.source,
      fetchOk,
      ahead: 0,
      behind: 0,
      upToDate: true,
      dirty: false,
      localVersion: readVersionFile(),
      remoteVersion: null,
      commits: [],
      note: fetchResult.error
        ? `Could not fetch the configured update source (${fetchResult.error}).`
        : 'Could not fetch the configured update source.',
    };
  }

  let ahead = 0;
  let behind = 0;
  const counts = await gitSafe(['rev-list', '--left-right', '--count', `HEAD...${target.remoteRef}`]);
  if (counts) {
    const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
    ahead = Number.isFinite(a) ? a : 0;
    behind = Number.isFinite(b) ? b : 0;
  }

  let commits = [];
  if (behind > 0) {
    const log = await gitSafe(['log', '--pretty=format:%h\x1f%s\x1f%an\x1f%cr', `HEAD..${target.remoteRef}`]);
    if (log) {
      commits = log.split('\n').filter(Boolean).map((line) => {
        const [hash, subject, author, when] = line.split('\x1f');
        return { hash, subject, author, when };
      });
    }
  }

  const remoteVersion = await gitSafe(['show', `${target.remoteRef}:VERSION`]);
  const status = await gitSafe(['status', '--porcelain']);

  return {
    success: true,
    branch: localBranch,
    upstream: target.remoteRef,
    source: target.source,
    fetchOk,
    fetchError: fetchOk ? null : (fetchResult.error || 'git fetch failed'),
    ahead,
    behind,
    upToDate: behind === 0,
    dirty: status !== null && status.length > 0,
    localVersion: readVersionFile(),
    remoteVersion: remoteVersion ? remoteVersion.trim() : null,
    commits,
  };
}

module.exports = {
  REPO_ROOT,
  readVersionFile,
  getVersionInfo,
  checkForUpdates,
};