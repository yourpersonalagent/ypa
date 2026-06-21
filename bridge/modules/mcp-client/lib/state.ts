// ── MCP state: upstream registry + run-state + externalSharing toggle ─────────
'use strict';

const fs = require('fs');
const path = require('path');

const { writeJsonSync } = require('../../../core/state');
const logger = require('../../../core/logger');

// JSONs live at bridge/ root alongside config.json/partners.json/prefs.json —
// not in the module dir where this file sits. User state stays put across
// the mcp-internal → modules/mcp-client/lib relocation.
const MCP_STATE_FILE = path.join(__dirname, '..', '..', '..', 'mcp-state.json');
const REGISTRY_PATH  = path.join(__dirname, '..', '..', '..', 'mcp-registry.json');
// External source definitions, owned/written by the mcp-external-sources module.
// We read it DIRECTLY (no cross-module require) so the merge stays self-sufficient
// even when that module is disabled — the file IS the seam. See that module's
// lib/store.ts for the on-disk shape.
const EXTERNAL_SOURCES_PATH = path.join(__dirname, '..', '..', '..', 'mcp-external-sources.json');

// ── External source overlay ────────────────────────────────────────────────────
// Convert the external-source definitions into runnable registry entries keyed
// by source id. Supports local stdio and remote Streamable-HTTP sources.
// External sources default OFF (enabledByDefault absent/false) — the inverse of
// the internal catalog — so a freshly-added third-party server never autostarts
// until the user enables it.
function readExternalRegistryEntries(): Record<string, any> {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(EXTERNAL_SOURCES_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
  const out: Record<string, any> = {};
  for (const s of Array.isArray(raw?.sources) ? raw.sources : []) {
    if (!s || typeof s !== 'object' || !s.id) continue;
    const t = s.transport || {};
    const common = {
      enabledByDefault: s.enabledByDefault === true,
      ...(s.audienceDefault ? { audience: s.audienceDefault } : {}),
      // Permission posture read by the gateway write-gate (modules/mcp-client/
      // lib/policy.ts). Carried through the merged registry so the gate stays a
      // pure registry reader. Absent ⇒ the safe default (trust 'ask', no write).
      ...(s.trust === 'trusted' || s.trust === 'ask' || s.trust === 'disabled' ? { trust: s.trust } : {}),
      ...(s.allowWrite === true ? { allowWrite: true } : {}),
      kind: 'external',
    };
    if (!t.type || t.type === 'stdio') {
      if (typeof t.command !== 'string' || !t.command) continue;
      out[s.id] = {
        ...common,
        transport: 'stdio',
        command: t.command,
        args: Array.isArray(t.args) ? t.args : [],
        ...(t.env && typeof t.env === 'object' ? { env: t.env } : {}),
        ...(t.cwd ? { cwd: t.cwd } : {}),
      };
    } else if (t.type === 'http') {
      if (typeof t.url !== 'string' || !t.url) continue;
      out[s.id] = {
        ...common,
        transport: 'http',
        url: t.url,
        auth: t.auth || 'none',
        ...(t.tokenEnv ? { tokenEnv: t.tokenEnv } : {}),
        ...(t.token ? { token: t.token } : {}),
        ...(t.headers && typeof t.headers === 'object' ? { headers: t.headers } : {}),
      };
    }
  }
  return out;
}

// ── Upstream registry ─────────────────────────────────────────────────────────
// Source of truth for the upstream MCP servers YHA spawns and holds persistent
// connections to. The single merged reader for the whole client: the shipped
// YHA-owned internal catalog (bridge/mcp-registry.json, kind 'internal') plus
// user-added external sources (bridge/mcp-external-sources.json, kind
// 'external'). Internal wins on a name collision — a YHA-owned server can never
// be shadowed by a same-named external one. Everything downstream
// (getDesiredOnServers, the supervisor, materialize, /v1/mcp/) reads through
// here, so external sources get lifecycle + aggregation for free once merged.
// The aggregator (bridge.ts) re-exposes whatever is LIVE as one MCP-Tools server.
function readUpstreamRegistry() {
  const internal: Record<string, any> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const src = raw.mcpServers || {};
    for (const [name, cfg] of Object.entries(src)) {
      internal[name] = { ...(cfg as any), kind: 'internal' };
    }
  } catch (_) { /* no registry file — internal stays empty */ }
  const external = readExternalRegistryEntries();
  // Spread external first so any internal name collision keeps the internal entry.
  return { mcpServers: { ...external, ...internal } };
}

// A server runs out of the box unless its registry entry opts out with
// "enabledByDefault": false. This flag is the public-repo / installer knob:
// absent ⇒ ON. It is committed in mcp-registry.json (unlike mcp-state.json,
// which is gitignored per-install), so a fresh clone boots with a known,
// all-on-by-default set minus the few servers that need external setup first.
function isEnabledByDefault(name: string, reg?: Record<string, any>): boolean {
  const servers = reg || readUpstreamRegistry().mcpServers || {};
  const cfg = servers[name];
  return !cfg || cfg.enabledByDefault !== false;
}

type Audience = 'all' | 'chat-only' | 'pet-only';

function isAudience(v: unknown): v is Audience {
  return v === 'all' || v === 'chat-only' || v === 'pet-only';
}

// Gateway tool-exposure mode. 'direct' (default) advertises every aggregated
// upstream tool through MCP-Tools. 'search' advertises only the search-first
// meta-tools (see ./gateway-tools) to keep a connected harness's context small
// when many sources are attached. Purely a runtime dispatch switch — it changes
// nothing about which servers run or what materialize writes.
type GatewayMode = 'direct' | 'search';

function isGatewayMode(v: unknown): v is GatewayMode {
  return v === 'direct' || v === 'search';
}

// ── Declared run-state ────────────────────────────────────────────────────────
// The authoritative run-state is the user's DECLARED intent, expressed as two
// override lists against the registry default — never a snapshot of which
// processes happen to be alive. That distinction is the whole point: a crash, a
// bridge restart, or a `bun --watch` reload must NOT silently drop a server
// from the desired set.
//
//   disabled[] — servers the user explicitly turned OFF (overrides a default-ON)
//   enabled[]  — servers the user explicitly turned ON  (overrides a default-OFF)
//
// effective desired-ON(name) =
//     name ∈ enabled  → true
//     name ∈ disabled → false
//     else            → registry enabledByDefault (default true)
interface McpStateShape {
  disabled: string[];
  enabled: string[];
  externalSharing: boolean;
  gatewayMode: GatewayMode;
  audienceOverrides: Record<string, Audience>;
}

function uniqStrings(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return Array.from(new Set(arr.filter((x): x is string => typeof x === 'string' && !!x)));
}

// Effective desired run-state for one server. Shared by the boot reconcile, the
// supervisor, and the derived `running` mirror so they can never disagree.
function isDesiredOn(name: string, st: McpStateShape, reg?: Record<string, any>): boolean {
  if (st.enabled.includes(name)) return true;
  if (st.disabled.includes(name)) return false;
  return isEnabledByDefault(name, reg);
}

// ── mcp-state.json load (+ one-time legacy migration) ─────────────────────────
function loadMcpState(): McpStateShape {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(MCP_STATE_FILE, 'utf8'));
  } catch (_) {
    // No file yet (fresh install — the file is gitignored, never shipped) or
    // unreadable: empty overrides ⇒ everything runs at its registry default.
    return { disabled: [], enabled: [], externalSharing: true, gatewayMode: 'direct', audienceOverrides: {} };
  }

  const overrides: Record<string, Audience> = {};
  const rawOv = data && typeof data === 'object' ? data.audienceOverrides || {} : {};
  for (const [name, value] of Object.entries(rawOv)) {
    if (isAudience(value)) overrides[name] = value as Audience;
  }
  const externalSharing = data.externalSharing !== false; // default ON
  const gatewayMode: GatewayMode = isGatewayMode(data.gatewayMode) ? data.gatewayMode : 'direct';

  // New shape: explicit disabled/enabled override lists are present.
  if (Array.isArray(data.disabled) || Array.isArray(data.enabled)) {
    return {
      disabled: uniqStrings(data.disabled),
      enabled: uniqStrings(data.enabled),
      externalSharing,
      gatewayMode,
      audienceOverrides: overrides,
    };
  }

  // Legacy shape: only `running` (a liveness snapshot at last save). Migrate to
  // override lists so the user's CURRENT on/off set is preserved exactly across
  // the model switch — anything default-ON but absent becomes an explicit
  // disable; anything default-OFF but present becomes an explicit enable. The
  // next write persists the new shape; until then this stays deterministic.
  const reg = readUpstreamRegistry().mcpServers || {};
  const legacyRunning = new Set(uniqStrings(data.running));
  const disabled: string[] = [];
  const enabled: string[] = [];
  for (const name of Object.keys(reg)) {
    const defOn = isEnabledByDefault(name, reg);
    const isOn = legacyRunning.has(name);
    if (defOn && !isOn) disabled.push(name);
    if (!defOn && isOn) enabled.push(name);
  }
  return { disabled, enabled, externalSharing, gatewayMode, audienceOverrides: overrides };
}

// The effective desired-ON set across the whole registry: what boot starts and
// what the supervisor keeps alive.
function getDesiredOnServers(): string[] {
  const st = loadMcpState();
  const reg = readUpstreamRegistry().mcpServers || {};
  return Object.keys(reg).filter((name) => isDesiredOn(name, st, reg));
}

// ── Persist ───────────────────────────────────────────────────────────────────
// `running` is written purely as a DERIVED mirror of the effective desired-ON
// set so the Go autostart path (go-core/internal/mcp/autostart.go reads
// state.Running) stays correct without a Go-side change. On the Node side it is
// never read back as authoritative — loadMcpState() ignores it.
function persistMcpState(st: McpStateShape): void {
  const reg = readUpstreamRegistry().mcpServers || {};
  const running = Object.keys(reg).filter((name) => isDesiredOn(name, st, reg));
  const next = {
    running,
    disabled: uniqStrings(st.disabled),
    enabled: uniqStrings(st.enabled),
    externalSharing: st.externalSharing,
    gatewayMode: st.gatewayMode,
    audienceOverrides: st.audienceOverrides,
  };
  try {
    writeJsonSync(MCP_STATE_FILE, next);
  } catch (e) {
    logger.warn('mcp.state-save-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Convert a legacy file to the new shape on disk (and refresh the `running`
// mirror) without changing the effective set. Called once at boot.
function reconcileMcpStateFile(): void {
  persistMcpState(loadMcpState());
}

// ── Declared intent mutators (called from the user-facing start/stop routes) ──
// Kept OUT of startMcpServer/stopMcpServer on purpose: those run for boot
// autostart, crash auto-respawn, and the search-surface ensure too, none of
// which are user intent. Only an explicit MCP-tab toggle should move the
// override lists.

// User asked to RUN a server. Clear any prior disable; for a default-OFF server
// add an explicit enable. Default-ON servers need no enable entry (the registry
// already says ON) so the lists stay minimal — only genuine deviations persist.
function setMcpEnabled(name: string): void {
  if (!name) return;
  const st = loadMcpState();
  st.disabled = st.disabled.filter((n) => n !== name);
  if (isEnabledByDefault(name)) {
    st.enabled = st.enabled.filter((n) => n !== name);
  } else if (!st.enabled.includes(name)) {
    st.enabled.push(name);
  }
  persistMcpState(st);
  logger.info('mcp.intent-enabled', { name });
}

// User asked to STOP a server. Clear any prior enable; for a default-ON server
// add an explicit disable.
function setMcpDisabled(name: string): void {
  if (!name) return;
  const st = loadMcpState();
  st.enabled = st.enabled.filter((n) => n !== name);
  if (isEnabledByDefault(name)) {
    if (!st.disabled.includes(name)) st.disabled.push(name);
  } else {
    st.disabled = st.disabled.filter((n) => n !== name);
  }
  persistMcpState(st);
  logger.info('mcp.intent-disabled', { name });
}

// ── External sharing toggle ───────────────────────────────────────────────────
// Controls whether the MCP-Tools aggregator is materialized into harness
// configs and whether its HTTP RPC route accepts requests.
function getExternalSharing(): boolean {
  return loadMcpState().externalSharing;
}

function setExternalSharing(enabled: boolean): void {
  const st = loadMcpState();
  st.externalSharing = !!enabled;
  persistMcpState(st);
  logger.info('mcp.external-sharing-set', { enabled: !!enabled });
}

// ── Gateway tool-exposure mode ────────────────────────────────────────────────
// 'direct' (full aggregated tool list) vs 'search' (search-first meta-tools).
// Read live by the aggregator's dispatch (bridge.ts) on every tools/list and
// tools/call, so a change takes effect on the next request with no respawn or
// re-materialize.
function getGatewayMode(): GatewayMode {
  return loadMcpState().gatewayMode;
}

function setGatewayMode(mode: GatewayMode): void {
  const st = loadMcpState();
  st.gatewayMode = isGatewayMode(mode) ? mode : 'direct';
  persistMcpState(st);
  logger.info('mcp.gateway-mode-set', { mode: st.gatewayMode });
}

// ── Per-server audience overrides ────────────────────────────────────────────
// The catalog (bridge/modules/mcp-servers/index.ts) ships a sensible default
// per server. The user can override any server here from the prefs MCP tab.
// Pass `value === null` to clear an override back to the catalog default.
function getAudienceOverrides(): Record<string, Audience> {
  return loadMcpState().audienceOverrides;
}

function setAudienceOverride(serverName: string, value: Audience | null): void {
  if (!serverName) return;
  const st = loadMcpState();
  if (value === null) {
    delete st.audienceOverrides[serverName];
  } else if (isAudience(value)) {
    st.audienceOverrides[serverName] = value;
  } else {
    return;
  }
  persistMcpState(st);
  logger.info('mcp.audience-override-set', { serverName, value });
}

module.exports = {
  readUpstreamRegistry,
  isEnabledByDefault,
  loadMcpState,
  isDesiredOn,
  getDesiredOnServers,
  reconcileMcpStateFile,
  persistMcpState,
  setMcpEnabled,
  setMcpDisabled,
  getExternalSharing,
  setExternalSharing,
  getGatewayMode,
  setGatewayMode,
  getAudienceOverrides,
  setAudienceOverride,
};
