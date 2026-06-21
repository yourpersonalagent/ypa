// ── Shared server state — imported by every module ────────────────────────────
// Single source of truth for all mutable Maps, config, paths, and caches.
// All exports are object/Map references so mutations are shared across modules.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { IS_WINDOWS } = require('./platform');

// ── Claude binary auto-detection ──────────────────────────────────────────────
// Prefer a *standalone* CLI install over the VSCode-bundled binary. The VSCode
// extension's binary lives inside the extension dir and breaks when invoked
// with a foreign HOME / CLAUDE_CONFIG_DIR (multi-account harness needs that).
// Windows-only: scan %APPDATA%\<root>\<version>\<bin>.exe and return the
// highest-version path. Mirrors findWindowsBinary in config/handler.ts —
// same logic, different layer (state.ts runs at module-load time before
// config is loaded, handler.ts runs at request-time). Used by both
// findClaudeBin() and findCodexBin() on Windows.
function findWindowsCliBinary(rootCandidates: string[], binBase: string): string | null {
  if (!IS_WINDOWS) return null;
  const PATHEXT = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const root of rootCandidates) {
    if (!root) continue;
    try {
      if (!fs.statSync(root).isDirectory()) continue;
      // Direct hit (no version subdir)
      for (const ext of PATHEXT) {
        const full = path.join(root, binBase + ext);
        try { if (fs.statSync(full).isFile()) return full; } catch (_) {}
      }
      // Versioned subdirs: newest-first by lex sort (works for x.y.z).
      const subdirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const sub of subdirs) {
        for (const ext of PATHEXT) {
          const full = path.join(root, sub, binBase + ext);
          try { if (fs.statSync(full).isFile()) return full; } catch (_) {}
        }
      }
    } catch (_) { /* root missing — try next */ }
  }
  return null;
}

// Windows-only: copy/sync a discovered binary out of an OneDrive-virtualised
// %APPDATA% path into the repo's bin/ folder so spawn doesn't trip over
// placeholder reparse points. Returns the local-bin path on success, or the
// original srcPath on any failure (best-effort, never throws upward).
//
// Why this exists: Claude Code installs to
//   %APPDATA%\Claude\claude-code\<version>\claude.exe
// which OneDrive's "Files On-Demand" can dehydrate at any time. When that
// happens, fork/exec fails with "The system cannot find the path specified"
// even though Test-Path / Explorer report the file as present. Copying to
// a non-OneDrive directory (the repo's own bin/) sidesteps the issue.
//
// mtime-compared: only copies when destination is missing OR source is newer.
// Idempotent across boots — the common case is a fast stat + skip.
function syncWindowsBinaryToRepoBin(srcPath: string, binBase: string): string {
  if (!IS_WINDOWS || !srcPath) return srcPath;
  // Heuristic: only relocate when the source sits under \AppData\ (the
  // OneDrive-virtualisation hazard). Anything else — %USERPROFILE%\.bun\bin,
  // a user-chosen path, etc. — is left alone.
  if (!/\\AppData\\/i.test(srcPath)) return srcPath;
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const binDir = path.join(repoRoot, 'bin');
    const destPath = path.join(binDir, binBase + '.exe');
    const srcStat = fs.statSync(srcPath);
    let needCopy = true;
    try {
      const destStat = fs.statSync(destPath);
      if (destStat.isFile() && destStat.mtimeMs >= srcStat.mtimeMs && destStat.size === srcStat.size) {
        needCopy = false;
      }
    } catch (_) { /* dest missing → copy */ }
    if (needCopy) {
      fs.mkdirSync(binDir, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
    return destPath;
  } catch (_) {
    return srcPath;
  }
}

function findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // Windows: Claude Code's installer drops the exe at a version-pinned
  // path under %APPDATA%\Claude\claude-code\<version>\claude.exe and does
  // NOT add it to PATH. Without this check the UI shows the bare string
  // "claude" in the binary input field, which is misleading and breaks
  // any caller that doesn't fall through to defaults.claudeBin.
  if (IS_WINDOWS) {
    // Prefer <repoRoot>/bin/claude.exe if it exists — that copy is what
    // syncWindowsBinaryToRepoBin populates and the only sane path to spawn
    // from on machines where OneDrive virtualises %APPDATA%. Returning it
    // early also covers the failure mode where the AppData scan can't see
    // the dehydrated placeholder as a file at all.
    try {
      const repoBin = path.resolve(__dirname, '..', '..', 'bin', 'claude.exe');
      if (fs.statSync(repoBin).isFile()) {
        // Best-effort refresh from AppData if a newer version is sitting
        // there — non-blocking, swallows errors. Keeps the repo-bin copy
        // current after Claude Code auto-updates.
        try {
          const appdataPath = findWindowsCliBinary(
            [path.join(process.env.APPDATA || '', 'Claude', 'claude-code')],
            'claude',
          );
          if (appdataPath) syncWindowsBinaryToRepoBin(appdataPath, 'claude');
        } catch (_) {}
        return repoBin;
      }
    } catch (_) { /* repo-bin missing — fall through to AppData scan */ }
    const winPath = findWindowsCliBinary(
      [
        path.join(process.env.APPDATA || '', 'Claude', 'claude-code'),
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(process.env.USERPROFILE || '', '.bun', 'bin'),
      ],
      'claude',
    );
    if (winPath) return syncWindowsBinaryToRepoBin(winPath, 'claude');
    return 'claude';
  }
  const HOME = process.env.HOME || os.homedir();
  const standalone = [
    path.join(HOME, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const bin of standalone) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch (_) {}
  }
  // Last resort: VSCode-bundled binary. Works for single-account use only.
  const extDir = path.join(HOME, '.vscode-server-insiders', 'extensions');
  try {
    const entries = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse(); // latest version first
    for (const d of entries) {
      const bin = path.join(extDir, d, 'resources/native-binary/claude');
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        return bin;
      } catch (_) {}
    }
  } catch (_) {}
  return 'claude'; // fallback: hope it's on PATH
}

function findCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  // Windows: standard Codex install paths under %APPDATA% / %LOCALAPPDATA%.
  // Mirrors findClaudeBin: prefer the repo-bin copy (syncWindowsBinaryToRepoBin
  // populates it), fall back to AppData scan, OneDrive-sync detected hits.
  if (IS_WINDOWS) {
    try {
      const repoBin = path.resolve(__dirname, '..', '..', 'bin', 'codex.exe');
      if (fs.statSync(repoBin).isFile()) {
        try {
          const appdataPath = findWindowsCliBinary(
            [
              // OpenAI installer drops codex.exe under a hashed subdir here.
              path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
              path.join(process.env.APPDATA || '', 'npm'),
              path.join(process.env.APPDATA || '', 'codex'),
              path.join(process.env.LOCALAPPDATA || '', 'codex'),
            ],
            'codex',
          );
          if (appdataPath) syncWindowsBinaryToRepoBin(appdataPath, 'codex');
        } catch (_) {}
        return repoBin;
      }
    } catch (_) { /* repo-bin missing — fall through */ }
    const winPath = findWindowsCliBinary(
      [
        // OpenAI installer drops codex.exe under a hashed subdir here;
        // findWindowsCliBinary scans one subdir level so this resolves.
        path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(process.env.USERPROFILE || '', '.bun', 'bin'),
        path.join(process.env.APPDATA || '', 'codex'),
        path.join(process.env.LOCALAPPDATA || '', 'codex'),
      ],
      'codex',
    );
    if (winPath) return syncWindowsBinaryToRepoBin(winPath, 'codex');
    return 'codex';
  }
  const HOME = process.env.HOME || os.homedir();
  const preferred = [
    // Official standalone installer (current macOS/Linux default).
    path.join(HOME, '.local', 'bin', 'codex'),
    // Older/local npm-style installation used by existing deployments.
    path.join(HOME, '.local', 'node_modules', '.bin', 'codex'),
    path.join(HOME, '.bun', 'bin', 'codex'),
    '/usr/local/bin/codex',
  ];
  for (const bin of preferred) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch (_) {}
  }
  const nvmDir = path.join(HOME, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const version of versions) {
      const bin = path.join(nvmDir, version, 'bin', 'codex');
      try {
        fs.accessSync(bin, fs.constants.X_OK);
        return bin;
      } catch (_) {}
    }
  } catch (_) {}
  return 'codex'; // fallback: hope it's on PATH
}

// Grok Build CLI (xAI). Official installer drops the binary at:
//   Windows: %USERPROFILE%\.grok\bin\grok.exe (and agent.exe alias)
//   Linux/macOS: ~/.grok/bin/grok
// Installer URL: https://x.ai/cli/install.sh — runs under Git Bash on Windows.
// Auth lives in ~/.grok/auth.json (per-user) regardless of platform.
function findGrokBin() {
  if (process.env.GROK_BIN) return process.env.GROK_BIN;
  if (IS_WINDOWS) {
    // Repo-bin copy first (OneDrive-stable), then standard install dir.
    try {
      const repoBin = path.resolve(__dirname, '..', '..', 'bin', 'grok.exe');
      if (fs.statSync(repoBin).isFile()) return repoBin;
    } catch (_) {}
    const winPath = findWindowsCliBinary(
      [
        path.join(process.env.USERPROFILE || '', '.grok', 'bin'),
        path.join(process.env.APPDATA || '', 'npm'),
        path.join(process.env.USERPROFILE || '', '.bun', 'bin'),
      ],
      'grok',
    );
    if (winPath) return syncWindowsBinaryToRepoBin(winPath, 'grok');
    return 'grok';
  }
  const HOME = process.env.HOME || os.homedir();
  const candidates = [
    path.join(HOME, '.grok', 'bin', 'grok'),
    path.join(HOME, '.local', 'bin', 'grok'),
    '/usr/local/bin/grok',
  ];
  for (const bin of candidates) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch (_) {}
  }
  return 'grok'; // fallback: hope it's on PATH
}

const PORT = parseInt(process.env.PORT || '8443', 10);
const CLAUDE_BIN = findClaudeBin();
const CODEX_BIN = findCodexBin();
const GROK_BIN = findGrokBin();

// ── Bridge-internal API key for subprocess → proxy auth ──────────────────────
// Shared with the Go core via the YHA_BRIDGE_KEY env var (yha.sh generates it
// once into bridge/.env and exports it for both child processes). Without a
// shared key, Go's nodecallback.Runner POSTs to /proxy/tool with the wrong
// x-bridge-key and Node rejects with 401. Subprocesses (Claude binary, Task
// agents) also use this to authenticate against /proxy/. The old hardcoded
// sentinel 'sk-ant-bridge-routed' is no longer accepted.
// True when the key is the SHARED secret from YHA_BRIDGE_KEY (yha.sh wrote it to
// bridge/.env and Go reads the same value), false when it's an ephemeral random
// fallback. Endpoints that out-of-process first-party callers reach — the
// MCP-Tools stub, the websearch MCP child's search providers, the yha CLI — can
// only present the key when it's shared, so /proxy/mcp-bridge/rpc enforces the
// key ONLY in shared mode (ephemeral/dev keeps its localhost + sharing gates and
// can't regress). /proxy/tool stays unconditional: its caller is a bridge-spawned
// child that always inherits the live key.
const BRIDGE_KEY_IS_SHARED = !!process.env.YHA_BRIDGE_KEY;
const BRIDGE_INTERNAL_KEY = process.env.YHA_BRIDGE_KEY
  ? process.env.YHA_BRIDGE_KEY
  : (() => {
      console.warn(
        '[state] YHA_BRIDGE_KEY not set in env — generated ephemeral key. ' +
          'Cross-process /proxy/tool callbacks from Go core will fail with 401 ' +
          'until both sides agree. Set YHA_BRIDGE_KEY in bridge/.env.',
      );
      return 'sk-bridge-' + crypto.randomBytes(32).toString('hex');
    })();
// NOTE: this key is deliberately NOT exported onto process.env. If it were,
// every spawned child — including third-party MCP servers the user configures
// in mcp-registry.json — would inherit it and gain full /internal/* + /proxy/*
// authority on the bridge. Instead, mcp-client/lib/protocol.ts injects
// BRIDGE_INTERNAL_KEY into the child env ONLY for first-party scripts shipped
// under bridge/mcp/. Other in-process callers import the exported const below.

// ── Provider migration defaults ───────────────────────────────────────────────
// Inferred at startup for any existing provider entry that doesn't yet carry
// the new dynamic-provider fields (api_style / env_key / fetch_live). Keeps
// existing config.json working with zero structural change — fields are added
// in-memory on load and persisted on the next saveConfig().
const PROVIDER_PRESET_DEFAULTS: Record<
  string,
  { api_style: 'anthropic' | 'openai' | 'google'; env_key: string; fetch_live: boolean }
> = {
  Anthropic:      { api_style: 'anthropic', env_key: 'ANTHROPIC_API_KEY',  fetch_live: true  },
  OpenAI:         { api_style: 'openai',    env_key: 'OPENAI_API_KEY',     fetch_live: true  },
  'OpenAI-Image': { api_style: 'openai',    env_key: 'OPENAI_API_KEY',     fetch_live: false },
  Google:         { api_style: 'google',    env_key: 'GOOGLE_API_KEY',     fetch_live: true  },
  Grok:           { api_style: 'openai',    env_key: 'GROK_API_KEY',       fetch_live: true  },
  OpenRouter:     { api_style: 'openai',    env_key: 'OPENROUTER_API_KEY', fetch_live: true  },
  DeepSeek:       { api_style: 'openai',    env_key: 'DEEPSEEK_API_KEY',   fetch_live: true  },
  NVIDIA:         { api_style: 'openai',    env_key: 'NVIDIA_API_KEY',     fetch_live: true  },
};

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (_) {
  config = { providers: [], defaults: {} };
}

// In-memory migration: fill api_style / env_key / fetch_live for any provider
// that doesn't yet carry them. New providers (added via UI) already supply
// these fields. Existing entries are matched against PROVIDER_PRESET_DEFAULTS
// by name; unknown names fall back to OpenAI-compat with no auth.
let _providerMigrationApplied = false;
for (const p of config.providers || []) {
  const defaults = PROVIDER_PRESET_DEFAULTS[p.name] || null;
  if (!p.api_style)         { p.api_style = defaults?.api_style ?? 'openai';     _providerMigrationApplied = true; }
  if (p.env_key === undefined)   { p.env_key = defaults?.env_key ?? '';          _providerMigrationApplied = true; }
  if (p.fetch_live === undefined){ p.fetch_live = defaults?.fetch_live ?? false; _providerMigrationApplied = true; }
  // api_key injection from env is per-boot — not a persisted migration.
  if (p.env_key && process.env[p.env_key]) p.api_key = process.env[p.env_key];
}
// Persist immediately if anything changed. Previously the migrated shape
// only landed on disk on the next `saveConfig()` call (a UI mutation, a
// fetch-models POST, etc.) — a crash in that window meant the next boot
// repeated the migration, masking version drift between disk and the live
// config map. One sync write at boot eliminates that window.
if (_providerMigrationApplied) {
  try {
    writeJsonSync(CONFIG_PATH, JSON.parse(configToJson()));
  } catch (e) {
    // Best-effort — a write failure here means the migration stays
    // in-memory until the next saveConfig call. Log so a permission /
    // disk-full issue surfaces; don't fail boot over a config write.
    console.warn('[state] provider-migration write failed:', e && (e as any).message ? (e as any).message : String(e));
  }
}

// ── .env write helper ─────────────────────────────────────────────────────────
const ENV_PATH = path.join(__dirname, '..', '.env');

function writeEnvKey(envVarName, value) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (_) {}
  const lines = content.split('\n');
  const prefix = envVarName + '=';
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const newLine = `${envVarName}=${value}`;
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  const joined = lines.join('\n');
  const finalContent = joined.endsWith('\n') ? joined : joined + '\n';
  // Atomic write: temp file + rename prevents corrupt .env on process crash
  const tmp = ENV_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, finalContent, 'utf8');
  fs.renameSync(tmp, ENV_PATH);
  process.env[envVarName] = value;
}

// Atomic JSON write: temp file + rename prevents corrupt files on process crash.
// 'data' must be JSON-serializable. Adds trailing newline for clean diffs.
function writeJsonSync(filePath, data) {
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

async function writeJsonAsync(filePath, data) {
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmp = filePath + '.tmp.' + process.pid;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

// ── saveConfig — strips api_keys from providers before writing JSON ───────────
function configToJson() {
  const stripped = {
    ...config,
    providers: (config.providers || []).map((p) => {
      const { api_key, ...rest } = p;
      // Never persist api_key to JSON — all keys go in .env only
      return rest;
    }),
  };
  return JSON.stringify(stripped, null, 2) + '\n';
}

async function saveConfig() {
  const content = configToJson();  // already adds trailing newline
  const tmp = CONFIG_PATH + '.tmp.' + process.pid;
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, CONFIG_PATH);
}

// ── System prompts file helpers ────────────────────────────────────────────────
let systemPromptsCache = null;
let systemPromptsFilePath = null;

function getSystemPromptsPath() {
  if (!systemPromptsFilePath) {
    const configDir = path.dirname(CONFIG_PATH);
    const systemPromptsFile = config.systemPromptsFile || './systemPrompts.json';
    systemPromptsFilePath = path.resolve(configDir, systemPromptsFile);
  }
  return systemPromptsFilePath;
}

function loadSystemPrompts() {
  try {
    const filePath = getSystemPromptsPath();
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content).presets || {};
  } catch (e) {
    // Fallback to config.presets if file doesn't exist or is invalid
    return config.presets || {};
  }
}

async function saveSystemPrompts(presets) {
  const filePath = getSystemPromptsPath();
  const data = { presets };
  const tmp = filePath + '.tmp.' + process.pid;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, filePath);
  systemPromptsCache = null;
}

function getSystemPromptsMap() {
  if (!systemPromptsCache) {
    systemPromptsCache = loadSystemPrompts();
  }
  return systemPromptsCache;
}

// ── Session state Maps ────────────────────────────────────────────────────────
// Claude models:  YHA-sessionId → Claude session_id (for --resume)
const claudeSessions = new Map();
// Other models:   YHA-sessionId → [{role, content}]
const chatHistory = new Map();
// Display sessions — user-visible chat history served to the frontend
// yhaSessionId → { id, name, messages:[{role,text,ts}|{role:'tool',...}], createdAt, lastUsed }
const displaySessions = new Map();

// ── Active streams — survives client disconnects, enables reconnect ──────────
// sessionId → { status:'streaming'|'done'|'error', chunks:[], blocks:[], text:'',
//               cost:0, error:null, listeners:Set<(chunk)=>void>, doneAt:null }
const activeStreams = new Map();

// ── Active processes — keyed by sessionId, killed on /v1/stop/:id ────────────
// sessionId → { killFn: () => void }
const activeProcesses = new Map();

// ── Persistent MCP process registry ──────────────────────────────────────────
// name → { proc, tools, ok, error, pending:Map, nextId, stdoutBuf, send }
const mcpConnections = new Map();

// ── Disk paths ────────────────────────────────────────────────────────────────
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
const SESSIONS_INDEX = path.join(SESSIONS_DIR, 'index.json');
// Per-user uploads (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/uploads/ pre-migration.
const _UPLOADS_DIR = require('./paths').uploadsDir;
if (!fs.existsSync(_UPLOADS_DIR)) fs.mkdirSync(_UPLOADS_DIR, { recursive: true });
const UPLOADS_DIR = fs.realpathSync(_UPLOADS_DIR);
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Active model selections (LLM + image + video + audio) ────────────────────
const activeModels = {
  llm: {
    model: config.defaults?.model || 'claude-sonnet-4-6',
    provider: config.defaults?.llm_provider || 'Anthropic',
  },
  image: config.defaults?.image_model
    ? { model: config.defaults.image_model, provider: config.defaults.image_provider || '' }
    : {},
  video: config.defaults?.video_model
    ? { model: config.defaults.video_model, provider: config.defaults.video_provider || '' }
    : {},
  audio: config.defaults?.audio_model
    ? { model: config.defaults.audio_model, provider: config.defaults.audio_provider || '' }
    : {},
};

// ── Model API fetch caches ────────────────────────────────────────────────────
// Wrapped in an object so modules can reassign array elements by reference.
// models/index.js owns these; other modules call buildModelList() or getDynamicModels().
const modelCaches = {
  list: null, // built model list cache
  anthropic: [], // live Anthropic API models
  claudeSubscription: [], // live Claude Code subscription models discovered from CLI
  openai: [], // live OpenAI API models
  openaiImage: [], // live OpenAI image models
  codexSubscription: [], // live Codex subscription models discovered from CLI
  grokSubscription: [], // live Grok Build subscription models discovered from CLI
  grokSubscriptionMedia: [] as Array<{ name: string; kind: 'image' | 'video' }>, // grok-imagine-* models routed via OAuth (auth.json token) per grokInstance
  google: [], // live Google API models
  grok: [], // live Grok API models
  openrouter: [], // live OpenRouter models
  nvidia: [], // live NVIDIA NIM API models
  deepseek: [], // live DeepSeek API models
  // Generic per-provider cache for user-added providers (Ollama, LM Studio,
  // custom OpenAI-compat servers, etc.). Keyed by provider name; values are
  // `[{id, name}]` arrays from the generic /models fetcher in fetch.ts.
  byProvider: {} as Record<string, Array<{ id: string; name: string }>>,
};

module.exports = {
  PORT,
  CLAUDE_BIN,
  CODEX_BIN,
  GROK_BIN,
  BRIDGE_INTERNAL_KEY,
  BRIDGE_KEY_IS_SHARED,
  CONFIG_PATH,
  config,
  PROVIDER_PRESET_DEFAULTS,
  ENV_PATH,
  writeEnvKey,
  writeJsonSync,
  writeJsonAsync,
  saveConfig,
  getSystemPromptsPath,
  loadSystemPrompts,
  saveSystemPrompts,
  getSystemPromptsMap,
  claudeSessions,
  chatHistory,
  displaySessions,
  activeStreams,
  activeProcesses,
  mcpConnections,
  SESSIONS_DIR,
  SESSIONS_INDEX,
  UPLOADS_DIR,
  activeModels,
  modelCaches,
};
