// Centralised filesystem paths for the bridge.
//
// Phase-0 stance (matches `YHA-modular-plan.md` §6 Phase 0): every runtime
// JSON path the bridge reads or writes goes through one of the constants
// below.
//
// Q16 layer (2026-05-23): per-user kinds now route through `users/resolver.ts`
// via `resolveRead`. Each per-user property is a **getter** — `PATHS.prefs`
// re-resolves at access time so that once the one-time migrator runs and
// `bridge/users/<email>/prefs.json` exists, subsequent reads pick up the
// per-user path automatically. Pre-migration, the resolver falls back to the
// legacy bridge-root path — behaviour identical to before.
//
// Single-user mode pin: the email is read from ALLOWED_EMAILS at module load
// (`resolver.defaultUserEmail()`). When multi-user lands (Q15), each per-user
// path becomes a function `PATHS.prefs(email)` and call sites update to pass
// the request-scoped email. See docs/grill-combined.md §Q15.
//
// Do **not** add new `path.join(__dirname, '<file>.json')` calls outside
// this file. Add a constant here and import it.
'use strict';

const path = require('path');
const resolver = require('../users/resolver');

// `__dirname` here is `bridge/core/`. Everything below is relative to the
// `bridge/` root.
const BRIDGE_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(BRIDGE_ROOT, 'data');

// Today: legacy = bridge root. Tomorrow (after a single follow-up move
// commit): legacy = data root. Callers don't change.
const LEGACY = BRIDGE_ROOT;

// Resolve the user email once at module load. If ALLOWED_EMAILS is unset,
// fall back to a sentinel that the resolver still accepts but which has no
// per-user directory — `resolveRead` then transparently returns the legacy
// path. This keeps the bridge bootable in environments without WorkOS.
function _resolveEmailOrNull(): string | null {
  try { return resolver.defaultUserEmail(); } catch { return null; }
}
const USER_EMAIL: string | null = _resolveEmailOrNull();

// Build a getter that uses the resolver if we have an email, else legacy path.
function userGet(kind: string, legacyAbsPath: string) {
  if (!USER_EMAIL) return legacyAbsPath;
  try { return resolver.resolveRead(kind, USER_EMAIL); } catch { return legacyAbsPath; }
}

// Like userGet, but always returns the per-user canonical path when an email
// is configured — never the legacy fallback. Use for kinds whose legacy
// location sits outside bridge/ and must not be recreated (e.g. repo-root
// docs/, which .gitignore deprecates in favour of bridge/users/<email>/docs/).
function userGetCanonical(kind: string, legacyAbsPath: string) {
  if (!USER_EMAIL) return legacyAbsPath;
  try { return resolver.userPath(kind, USER_EMAIL); } catch { return legacyAbsPath; }
}

const PATHS = {
  bridgeRoot: BRIDGE_ROOT,
  dataRoot: DATA_ROOT,

  // ── per-user JSON blobs (resolver-routed; pre-migration → legacy) ───────
  get importantMemory()  { return userGet('important-memory', path.join(LEGACY, 'important-memory.json')); },
  get inputHistory()     { return userGet('input-history',    path.join(LEGACY, 'input-history.json')); },
  get partners()         { return userGet('partners',         path.join(LEGACY, 'partners.json')); },
  get prefs()            { return userGet('prefs',            path.join(LEGACY, 'prefs.json')); },
  get tokens()           { return userGet('tokens',           path.join(LEGACY, 'tokens.json')); },
  get ftpConnections()   { return userGet('ftp-connections',  path.join(LEGACY, 'ftp-connections.json')); },
  get searchUsage()      { return userGet('search-usage',     path.join(LEGACY, 'search-usage.json')); },
  get contextGraph()     { return userGet('context-graph',    path.join(LEGACY, 'context-graph.json')); },
  get linkState()        { return userGet('link-state',       path.join(LEGACY, 'link-state.json')); },
  get harnessHistory()   { return userGet('harness-history',  path.join(LEGACY, 'harness-history.json')); },
  get openaiProxyPrefs() { return userGet('openai-proxy-prefs', path.join(LEGACY, 'openai-proxy-prefs.json')); },
  get apiKeys()          { return userGet('api-keys',         path.join(LEGACY, 'api-keys.json')); },
  get authLoginsLog()    { return userGet('auth-logins-log',  path.join(LEGACY, 'auth-logins.log')); },
  get auditLog()         { return userGet('audit-log',        path.join(LEGACY, 'meta', 'audit.log')); },
  get tuiTokens()        { return userGet('tui-tokens',       path.join(LEGACY, 'state', 'tui-tokens.json')); },
  get linkSecrets()      { return userGet('link-secrets',     path.join(LEGACY, 'secrets', 'contextLink.json')); },
  get linkConfig()       { return userGet('link-config',      path.join(LEGACY, 'config.json')); }, // partial extract — see migrator
  get knowledgeRoot()    { return userGet('knowledge-root',   path.join(LEGACY, 'knowledge')); },
  get knowledgeIndex()   { return userGet('knowledge-index',  path.join(LEGACY, 'knowledge', 'index.json')); },
  get contextRagEntitlements() {
    return userGet('context-rag-entitlements',
      path.join(LEGACY, 'modules', 'context-generator', 'context-rag', 'data', 'entitlements.json'));
  },
  // LINK vault sync target + context-generator sorter output root.
  // `bridge/users/<email>/docs/` when ALLOWED_EMAILS is set; repo-root
  // `docs/` only when running without auth (dev / CI). Never recreate the
  // legacy path once a user email is known — resolveRead would do that
  // pre-claim and the sorter would pollute the repo again.
  get userDocsDir()      { return userGetCanonical('user-docs-dir', path.resolve(LEGACY, '..', 'docs')); },

  // ── node-scoped JSON blobs (NOT per-user — explicit Q16 carve-outs) ─────
  // cwdContextMemory: per-user flat-file transitional path (Q16.9 split
  // exists in users/<e>/cwd-context-memory/ via the migrator, but the
  // runtime still reads/writes a single flat file). Routing to per-user
  // here means the bridge stops recreating bridge/cwd-context-memory.json.
  get cwdContextMemory() { return userGet('cwd-context-memory-flat', path.join(LEGACY, 'cwd-context-memory.json')); },
  costs: path.join(LEGACY, 'costs.json'),                          // Q11 node billing rollup
  searchConfig: path.join(LEGACY, 'search-config.json'),           // audit pending
  mcpRegistry: path.join(LEGACY, 'mcp-registry.json'),
  mcpState: path.join(LEGACY, 'mcp-state.json'),
  lastExit: path.join(LEGACY, 'last-exit.json'),

  // ── per-user directories (resolver-routed) ──────────────────────────────
  get apiInOutLogDir()   { return userGet('api-inout-log',  path.join(LEGACY, 'api-inout-log')); },
  get monitoringLogDir() { return userGet('monitoring-log', path.join(LEGACY, 'monitoring-log')); },
  get uploadsDir()       { return userGet('uploads',        path.join(LEGACY, 'uploads')); },
  get employeesDir()     { return userGet('employees',      path.join(LEGACY, 'employees')); },
  get workflowsDir()     { return userGet('workflows',      path.join(LEGACY, 'workflows')); },
  get triggersDir()      { return userGet('triggers',       path.join(LEGACY, 'triggers')); },
  get partnersDir()      { return userGet('partners-dir',   path.join(LEGACY, 'partners')); },
  // Per-user flat-file prompt storage for the legacy `/v1/config/skills/`
  // API (see bridge/config/handler.ts). Skill **definitions** live in
  // `sharedSkillsDir` below — not here.
  get skillsDir()        { return userGet('skills',         path.join(LEGACY, '_unused-skills-legacy')); },
  // Read-only shared skill definitions checked into the repo. Same for every
  // user; per-user data goes under `skillsDataDir`. Skill execution should
  // read code from here.
  sharedSkillsDir: path.join(BRIDGE_ROOT, 'skills'),
  // Per-user runtime data dir (one subdir per skill at `<dir>/<name>/`).
  get skillsDataDir()    { return userGet('skills-data',    path.join(LEGACY, 'skills-data')); },
  // Per-user scratch / tmp dir. Falls back to OS tmp pre-claim.
  get userTmpDir()       { return userGet('user-tmp',       require('os').tmpdir()); },
  get contextRagDataDir() {
    return userGet('context-rag-data',
      path.join(LEGACY, 'modules', 'context-generator', 'context-rag', 'data'));
  },
  get cwdContextMemoryDir() { return userGet('cwd-context-memory', path.join(LEGACY, 'cwd-context-memory')); },

  // ── node-scoped directories (carve-outs) ────────────────────────────────
  sessionsDir: path.join(LEGACY, 'sessions'),
  groupsDir: path.join(LEGACY, 'sessions', 'groups'),
  telemetryDir: path.join(LEGACY, 'telemetry'),
  configHistoryDir: path.join(LEGACY, 'config-history'), // Q16.4 typo fix + per-email subdir deferred to migrator
  backupsDir: path.join(LEGACY, 'backups'),
  browserConfigDir: path.join(LEGACY, 'browser-config'),
  browserInitDir: path.join(LEGACY, 'browser-init'),
};

// Publish per-user skill paths into the environment so skill subprocesses
// (bash, python, node sandboxes) inherit a stable, well-named location for
// their scratch + state without hardcoding bridge layout. Set once at module
// load; child processes spawned after this inherit the values.
//   YHA_USER_DIR          — the user's per-user root
//   YHA_USER_TMP          — per-user scratch (handoffs, intermediates)
//   YHA_USER_SKILLS_DATA  — per-user skill runtime data root (one sub per skill)
//   YHA_SHARED_SKILLS_DIR — read-only shared skill definitions (in-repo)
const fs = require('fs');
if (USER_EMAIL) {
  try { process.env.YHA_USER_DIR = resolver.userDir(USER_EMAIL); } catch { /* ignore */ }
  try { process.env.YHA_USER_TMP = PATHS.userTmpDir; } catch { /* ignore */ }
  try { process.env.YHA_USER_SKILLS_DATA = PATHS.skillsDataDir; } catch { /* ignore */ }
}
process.env.YHA_SHARED_SKILLS_DIR = PATHS.sharedSkillsDir;
// Create the dirs lazily so skills that just `cd $YHA_USER_TMP` work without
// every caller needing to `mkdir -p` first. Best-effort.
for (const d of [process.env.YHA_USER_TMP, process.env.YHA_USER_SKILLS_DATA, process.env.YHA_SHARED_SKILLS_DIR]) {
  if (d) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }
}

module.exports = PATHS;
