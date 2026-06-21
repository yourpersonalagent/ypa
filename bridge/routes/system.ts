// ── Models, health, fetch-proxy, and logging routes ───────────────────────────
'use strict';

const { config, activeModels } = require('../core/state');
const { persistActiveModels } = require('../sessions-internal');
const {
  buildModelList,
  fetchClaudeSubscriptionModels,
  fetchCodexSubscriptionModels,
  fetchGrokSubscriptionModels,
  fetchGrokSubscriptionMedia,
  fetchAnthropicModels,
  fetchOpenAIModels,
  fetchOpenAIImageModels,
  fetchGoogleModels,
  fetchGrokModels,
  fetchOpenRouterModels,
  fetchNVIDIAModels,
  fetchDeepSeekModels,
  fetchExtraProvidersModels,
} = require('../models');
const { setLoggingEnabled, isLoggingEnabled } = require('../observability/raw-logs');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Decompress a response body by its Content-Encoding. We request
// `identity`, but some servers compress regardless; decode here and fall
// back to the raw bytes if decompression fails (malformed/unknown encoding).
function decodeBody(buf, encoding) {
  const enc = String(encoding || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch {
    // fall through to raw bytes
  }
  return buf;
}

// Issue a single GET to `urlStr` but connect to the pre-validated `ip`
// (DNS-rebind defense — see resolvePinnedAddress). The original hostname is
// preserved as both the Host header (virtual-host routing) and the TLS SNI /
// cert-verification name (servername), so pinning to the IP doesn't break
// name-based vhosts or HTTPS validation. Does NOT follow redirects — the
// caller re-validates and re-pins each hop. Resolves { statusCode, headers, body }.
function pinnedRequest(urlStr, ip, family) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch {
      reject(new Error('invalid url'));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80;
    const options = {
      host: ip, // connect to the pinned, already-validated IP (no re-resolution)
      family,
      port,
      method: 'GET',
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'User-Agent': 'YHA-Trigger/1.0',
        Host: parsed.host, // preserve original host (incl. port) for vhost routing
        'Accept-Encoding': 'identity',
      },
      timeout: 10000,
    };
    if (isHttps) options.servername = parsed.hostname; // verify cert against the name, not the IP
    const reqOut = mod.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        resolve({ statusCode: resp.statusCode || 0, headers: resp.headers || {}, body: Buffer.concat(chunks) });
      });
      resp.on('error', reject);
    });
    reqOut.on('error', reject);
    reqOut.on('timeout', () => reqOut.destroy(new Error('fetch-proxy timeout')));
    reqOut.end();
  });
}

async function refreshAllModels() {
  await Promise.all([
    fetchClaudeSubscriptionModels(),
    fetchCodexSubscriptionModels(),
    fetchGrokSubscriptionModels(),
    fetchGrokSubscriptionMedia(),
    fetchAnthropicModels(),
    fetchOpenAIModels(),
    fetchOpenAIImageModels(),
    fetchGoogleModels(),
    fetchGrokModels(),
    fetchOpenRouterModels(),
    fetchNVIDIAModels(),
    fetchDeepSeekModels(),
    fetchExtraProvidersModels(),
  ]);
}

// ── Project version + self-update ─────────────────────────────────────────────
// Canonical version lives in the repo-root VERSION file (single source of
// truth — see AGENTS.md). Git supplies automatic build metadata (commit,
// branch, describe, dirty) so the running build is always precisely
// identifiable even between tagged releases. This file sits at
// bridge/routes/system.ts, so the repo root is two levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VERSION_FILE = path.join(REPO_ROOT, 'VERSION');
const STANDARD_UPDATE_REPO = 'https://github.com/yourpersonalagent/ypa.git';
// Plain refs/ (not refs/remotes/) — git rejects refs/remotes/* as anonymous
// fetch destinations in some configurations; refs/ypa-updates/* is stable.
const UPDATE_REF_PREFIX = 'refs/ypa-updates';

// Never let git block on a credential prompt — the bridge has no TTY.
const GIT_NO_PROMPT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
};
const GIT_DEFAULT_TIMEOUT_MS = 30_000;
const GIT_FETCH_TIMEOUT_MS = 60_000;

// Resolve git once at load — minimal PATH under process managers (pm2, launchd)
// sometimes omits /usr/bin on Linux/macOS; Windows may only have the full path.
function resolveGitExecutable() {
  const candidates = process.platform === 'win32'
    ? ['git', 'git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
    : ['git', '/usr/bin/git', '/usr/local/bin/git'];
  for (const cand of candidates) {
    try {
      execFileSync(cand, ['--version'], { timeout: 5000, stdio: 'ignore' });
      return cand;
    } catch {
      // try next candidate
    }
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

// Best-effort git: resolves to the trimmed stdout, or null on ANY failure
// (git missing, not a repo, no network, no upstream). Callers branch on null
// rather than try/catch so a degraded environment never throws.
async function gitSafe(args) {
  try {
    return await runGit(args);
  } catch {
    return null;
  }
}

async function gitSafeRedacted(args, redact) {
  try {
    return await runGit(args, { redact });
  } catch {
    return null;
  }
}

function readVersionFile() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || 'dev';
  } catch {
    return 'dev';
  }
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
    return {
      owner: parsed.owner,
      repo: parsed.repo,
      branch: activeBranch,
      customUrl,
    };
  } catch {
    return null;
  }
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
  if (match) {
    return { owner: match[1], repo: match[2], branch: null };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('Use a GitHub repository URL, for example https://github.com/owner/repo/tree/branch.');
  }
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Only github.com update sources are supported.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub URL must include owner and repository.');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  let branch = null;
  if (parts[2] === 'tree' && parts.length > 3) {
    branch = decodeURIComponent(parts.slice(3).join('/'));
  }
  return { owner, repo, branch };
}

function buildUpdateSource(body = {}) {
  const mode = body.mode === 'custom' ? 'custom' : 'standard';
  const parsed = normalizeGithubRepoUrl(mode === 'standard' ? STANDARD_UPDATE_REPO : body.url);
  let branch = body.branch ? String(body.branch).trim() : parsed.branch;
  if (branch && !isSafeBranchName(branch)) {
    throw new Error('Update branch contains unsupported characters.');
  }
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
  if (!branch) {
    throw new Error('Could not resolve the update branch. Use a /tree/<branch> GitHub URL or check credentials.');
  }
  const remoteRef = `${UPDATE_REF_PREFIX}/${branch}`;
  return { source: { ...source, branch, displayUrl: `https://github.com/${source.owner}/${source.repo}/tree/${branch}` }, remoteUrl: tokenized.url, remoteRef, redact: tokenized.redact };
}

async function fetchUpdateTarget(target) {
  try {
    await runGit(
      ['fetch', '--quiet', target.remoteUrl, `+refs/heads/${target.source.branch}:${target.remoteRef}`],
      { redact: target.redact, timeout: GIT_FETCH_TIMEOUT_MS },
    );
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}

function registerSystemRoutes(app) {
  setLoggingEnabled(config.defaults?.apiLoggingEnabled !== false);

  app.get('/v1/models/', (req, res) => {
    const models = buildModelList();
    const text = models.map((m) => `${m.id}: ${m.name} - ${m.provider}`).join('\n');
    res.json({ success: true, models, text });
  });

  app.get('/v1/active-models/', (req, res) => {
    res.json({ success: true, ...activeModels });
  });

  app.patch('/v1/active-models/', (req, res) => {
    const { llm, image, video, audio } = req.body || {};
    if (llm) activeModels.llm = { ...activeModels.llm, ...llm };
    if (image) activeModels.image = { ...activeModels.image, ...image };
    if (video) activeModels.video = { ...activeModels.video, ...video };
    if (audio) activeModels.audio = { ...activeModels.audio, ...audio };
    persistActiveModels();
    res.json({ success: true, ...activeModels });
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, version: readVersionFile(), activeModel: activeModels.llm.model });
  });

  const updateSourceStore = require('../core/update-source');

  // ── GET /v1/version — current build identity ──────────────────────────────
  // Canonical semver from the VERSION file + git-derived build metadata.
  app.get('/v1/version', async (_req, res) => {
    try {
      res.json({ success: true, ...(await getVersionInfo()), updateSource: updateSourceStore.publicUpdateSource() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET/PUT /v1/version/source — persisted Updates-tab public/custom choice
  app.get('/v1/version/source', (_req, res) => {
    res.json({ success: true, ...updateSourceStore.publicUpdateSource() });
  });

  app.put('/v1/version/source', async (req, res) => {
    try {
      const body = req.body || {};
      const saved = updateSourceStore.writeUpdateSource({
        mode: body.mode,
        url: body.url,
        token: body.token,
      });
      try {
        const netSync = require('../core/net-sync');
        await netSync.refreshBuildSnapshot({});
      } catch { /* manifest refresh is best effort */ }
      res.json({ success: true, ...updateSourceStore.publicUpdateSource(saved) });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/version/check — is a newer build available? ──────────────────
  // Fetches the configured update source (best-effort) and reports how far HEAD
  // is behind that exact branch. Read-only: never touches the working tree and
  // never depends on local branch tracking/upstream config.
  app.post('/v1/version/check', async (req, res) => {
    try {
      const localBranch = await gitSafe(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!localBranch) return res.status(400).json({ success: false, error: 'Not a git repository.' });

      const target = await prepareUpdateTarget(req.body || {}, localBranch);
      const fetchResult = await fetchUpdateTarget(target);
      const fetchOk = fetchResult.ok;
      const remoteExists = await gitSafe(['rev-parse', '--verify', '--quiet', target.remoteRef]);
      if (!remoteExists) {
        return res.json({
          success: true, branch: localBranch, upstream: target.remoteRef, source: target.source, fetchOk, ahead: 0, behind: 0,
          upToDate: true, dirty: false, localVersion: readVersionFile(), remoteVersion: null, commits: [],
          note: fetchResult.error
            ? `Could not fetch the configured update source (${fetchResult.error}), and no previous fetched state is available.`
            : 'Could not fetch the configured update source, and no previous fetched state is available.',
        });
      }

      let ahead = 0, behind = 0;
      const counts = await gitSafe(['rev-list', '--left-right', '--count', `HEAD...${target.remoteRef}`]);
      if (counts) {
        const [a, b] = counts.split(/\s+/).map((n) => parseInt(n, 10));
        ahead = Number.isFinite(a) ? a : 0;
        behind = Number.isFinite(b) ? b : 0;
      }

      let commits = [];
      if (behind > 0) {
        // \x1f (unit separator) is field-safe inside commit subjects.
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

      res.json({
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
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/version/apply — fast-forward to the latest build ─────────────
  // Guarded: refuses on a dirty tree (would clobber concurrent uncommitted
  // work — this is a live working tree) or when HEAD is ahead (no clean
  // fast-forward). Does NOT rebuild or restart services; returns
  // rebuildRequired so the operator can rebuild deliberately.
  app.post('/v1/version/apply', async (req, res) => {
    try {
      const branch = await gitSafe(['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!branch) return res.status(400).json({ success: false, error: 'Not a git repository.' });

      const target = await prepareUpdateTarget(req.body || {}, branch);
      const fetchResult = await fetchUpdateTarget(target);
      if (!fetchResult.ok) {
        return res.status(502).json({
          success: false,
          source: target.source,
          error: fetchResult.error
            ? `Could not fetch the configured update source: ${fetchResult.error}`
            : 'Could not fetch the configured update source. Check the repo URL, branch, network, or private-repo credentials.',
        });
      }

      const status = await gitSafe(['status', '--porcelain']);
      if (status && status.length > 0) {
        return res.status(409).json({
          success: false, dirty: true,
          error: 'Working tree has uncommitted changes. Commit or stash them before updating.',
        });
      }

      const counts = await gitSafe(['rev-list', '--left-right', '--count', `HEAD...${target.remoteRef}`]);
      if (counts) {
        const ahead = parseInt(counts.split(/\s+/)[0], 10);
        if (Number.isFinite(ahead) && ahead > 0) {
          return res.status(409).json({
            success: false, ahead, source: target.source,
            error: `Local branch is ${ahead} commit(s) ahead of ${target.source.displayUrl}; a fast-forward update isn't possible. Reconcile first.`,
          });
        }
      }

      const previousVersion = readVersionFile();
      const output = await runGit(['merge', '--ff-only', target.remoteRef]);
      res.json({ success: true, source: target.source, output, previousVersion, version: readVersionFile(), rebuildRequired: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/system/deps — live external-dependency status ─────────────────
  // Scans the repo-root dependencies.json manifest against THIS box (binary on
  // PATH/config, API key in env/.env, venv/dir present, port open) and returns
  // present|missing|na|unknown per dep + a summary. Same detection path the
  // MCP/core `assertDep()` guard uses, so the UI and the runtime never diverge.
  // Result is cached ~30s; pass ?refresh=1 to force a fresh probe.
  app.get('/v1/system/deps', async (req, res) => {
    try {
      const force = req.query.refresh === '1' || req.query.force === '1';
      const data = await require('../lib/deps').scan({ force });
      res.json({ success: true, ...data });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── /v1/media/schema/* — declarative param schemas for the composer ─────────
  // Returns the field list (size, quality, voice, etc.) the UI should render
  // for a given (provider, model). Frontend caches per-pageload.
  const _schemaModPath = require.resolve('../modules/media-schemas/schemas');
  const getMediaSchemas = () => {
    // Re-require on each call so /v1/media/schemas/reload can bust the cache.
    return require('../modules/media-schemas/schemas');
  };

  app.get('/v1/media/schemas/', (req, res) => {
    res.json({ success: true, schemas: getMediaSchemas().listSchemas() });
  });

  app.post('/v1/media/schemas/reload', (req, res) => {
    delete (require as any).cache[_schemaModPath];
    res.json({ success: true, message: 'Media schema cache cleared.' });
  });

  app.get('/v1/media/schema/:provider/:model', (req, res) => {
    const { provider, model } = req.params;
    if (!provider || !model) {
      return res.status(400).json({ success: false, error: 'provider and model required' });
    }
    const schema = getMediaSchemas().resolveSchema(provider, model);
    if (!schema) {
      return res.json({ success: true, schema: null, fallback: true });
    }
    res.json({ success: true, schema });
  });

  app.get('/v1/models/refresh', async (req, res) => {
    await refreshAllModels();
    res.json({ success: true, models: buildModelList() });
  });

  app.get('/v1/fetch-proxy', async (req, res) => {
    const rawUrl = req.query.url;
    if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).send('invalid url');
    }
    const { validateFetchUrl, resolvePinnedAddress } = require('../tools/security');
    const { BridgeError } = require('../core/errors');
    try {
      // Follow redirects manually so each hop is re-validated against the SSRF
      // guard — otherwise a public URL could 302 to http://169.254.169.254/.
      // Each hop: literal checks (validateFetchUrl) → resolve to ONE validated
      // public IP → connect pinned to that IP (resolvePinnedAddress + pinnedRequest)
      // so a rebinding resolver can't swap in a private IP between check and connect.
      let current = rawUrl;
      let result;
      for (let hop = 0; hop < 5; hop++) {
        const href = validateFetchUrl(current);
        const { hostname } = new URL(href);
        const pin = await resolvePinnedAddress(hostname);
        result = await pinnedRequest(href, pin.address, pin.family);
        const loc = result.headers['location'];
        if (result.statusCode >= 300 && result.statusCode < 400 && loc) {
          const next = new URL(loc, href).href;
          if (!/^https?:\/\//i.test(next)) return res.status(400).send('blocked redirect scheme');
          current = next;
          continue;
        }
        break;
      }
      const decoded = decodeBody(result.body, result.headers['content-encoding']);
      res
        .status(result.statusCode)
        .set('Content-Type', result.headers['content-type'] || 'text/plain')
        .send(decoded.toString('utf8'));
    } catch (e) {
      if (e instanceof BridgeError) return res.status(e.statusCode || 400).send(e.message);
      res.status(502).send(e.message);
    }
  });

  app.get('/v1/logging', (req, res) => {
    res.json({ enabled: isLoggingEnabled() });
  });

  app.post('/v1/logging', async (req, res) => {
    const enabled = req.body?.enabled !== false;
    setLoggingEnabled(enabled);
    config.defaults = config.defaults || {};
    config.defaults.apiLoggingEnabled = enabled;
    try {
      const { saveConfig } = require('../core/state');
      await saveConfig();
    } catch (_) {}
    res.json({ enabled });
  });
}

module.exports = {
  registerSystemRoutes,
  refreshAllModels,
};
