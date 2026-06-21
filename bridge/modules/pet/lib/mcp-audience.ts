// ── Pet MCP audience policy ─────────────────────────────────────────────────
// The pet module owns the policy of which MCP servers are exposed to which
// consumer. Two consumers exist today:
//   • 'main' — the main chat tool-list (bridge/tools/defs.ts) and the
//              MCP-Tools aggregator (bridge/modules/mcp-client/lib/bridge.ts,
//              which is what spawned harnesses see). Sees servers whose
//              resolved audience is 'all' or 'chat-only'.
//   • 'pet'  — the pet console (bridge/modules/pet/lib/console.ts). Sees
//              servers whose resolved audience is 'all' or 'pet-only'.
//
// Resolution order at lookup time:
//   1. User override from bridge/mcp-state.json (`audienceOverrides`).
//   2. Catalog default from bridge/modules/mcp-servers/index.ts
//      (`audienceDefault`).
//   3. Legacy `audience` tag on the entry in bridge/mcp-registry.json
//      ('pet-only' is the only value the legacy tag ever carried, kept for
//      backward compat with user-edited registries).
//   4. Fallback: 'all'.
//
// Why this lives in the pet module:
//   • The default split (which servers are useful to the pet vs. noise)
//     is a pet concern — it codifies what kind of agent the pet is.
//   • Other modules can later adopt the same pattern with a similarly
//     small policy file of their own; the only shared surface is the
//     `audienceDefault` field on a catalog entry / `audience` field on a
//     registry entry.
'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH    = path.join(__dirname, '..', '..', '..', 'mcp-registry.json');
const MCP_STATE_PATH   = path.join(__dirname, '..', '..', '..', 'mcp-state.json');

type Audience = 'all' | 'chat-only' | 'pet-only';

interface RegistryCache {
  registryAudience: Map<string, Audience>;
  mtimeMs: number;
}
interface StateCache {
  overrides: Map<string, Audience>;
  mtimeMs: number;
}

let _registryCache: RegistryCache | null = null;
let _stateCache: StateCache | null = null;

function isAudience(v: unknown): v is Audience {
  return v === 'all' || v === 'chat-only' || v === 'pet-only';
}

// Read-through, mtime-keyed: editing mcp-registry.json (e.g. tagging a new
// server) takes effect without a bridge restart.
function readRegistryAudience(): Map<string, Audience> {
  try {
    const stat = fs.statSync(REGISTRY_PATH);
    if (_registryCache && stat.mtimeMs === _registryCache.mtimeMs) return _registryCache.registryAudience;
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    const out = new Map<string, Audience>();
    const servers = raw && typeof raw === 'object' ? raw.mcpServers || {} : {};
    for (const [name, srv] of Object.entries(servers)) {
      if (srv && typeof srv === 'object' && isAudience((srv as any).audience)) {
        out.set(name, (srv as any).audience as Audience);
      }
    }
    _registryCache = { registryAudience: out, mtimeMs: stat.mtimeMs };
    return out;
  } catch (_e) {
    return new Map<string, Audience>();
  }
}

// Read-through, mtime-keyed override map.
function readOverrides(): Map<string, Audience> {
  try {
    const stat = fs.statSync(MCP_STATE_PATH);
    if (_stateCache && stat.mtimeMs === _stateCache.mtimeMs) return _stateCache.overrides;
    const raw = JSON.parse(fs.readFileSync(MCP_STATE_PATH, 'utf8'));
    const out = new Map<string, Audience>();
    const ov = raw && typeof raw === 'object' ? raw.audienceOverrides || {} : {};
    for (const [name, value] of Object.entries(ov)) {
      if (isAudience(value)) out.set(name, value as Audience);
    }
    _stateCache = { overrides: out, mtimeMs: stat.mtimeMs };
    return out;
  } catch (_e) {
    return new Map<string, Audience>();
  }
}

function getCatalogDefault(serverName: string): Audience | undefined {
  try {
    const mod = require('../../mcp-servers');
    const lookup = (mod && typeof mod.getAudienceDefault === 'function') ? mod.getAudienceDefault : null;
    if (!lookup) return undefined;
    const v = lookup(serverName);
    return isAudience(v) ? v : undefined;
  } catch (_e) {
    return undefined;
  }
}

function resolveAudience(serverName: string): Audience {
  if (!serverName) return 'all';
  const ov = readOverrides().get(serverName);
  if (ov) return ov;
  const cat = getCatalogDefault(serverName);
  if (cat) return cat;
  const reg = readRegistryAudience().get(serverName);
  if (reg) return reg;
  // Last-resort fallback. Also keeps pet-vision pet-only when the catalog
  // require fails for some reason and the registry is unreadable.
  if (serverName === 'pet-vision') return 'pet-only';
  return 'all';
}

function isPetOnlyMcp(serverName: string): boolean {
  return resolveAudience(serverName) === 'pet-only';
}

// True iff the consumer named by `audience` should NOT see this server.
//   • 'main' (chat + harnesses) hides 'pet-only'.
//   • 'pet'  (pet console)      hides 'chat-only'.
// 'all' is always visible.
function skipForAudience(serverName: string, audience: 'main' | 'pet'): boolean {
  const scope = resolveAudience(serverName);
  if (scope === 'all') return false;
  if (audience === 'main') return scope === 'pet-only';
  return scope === 'chat-only';
}

// Pet-active detector — used by the FE prefs page to decide whether to
// surface the per-server audience dropdown. Returns false when the pet
// bridge module isn't loaded (modules.json or runtime disabled), in which
// case the audience system stays in place but the UI hides the toggle
// since 'all' / 'chat-only' / 'pet-only' have no distinction without a
// pet consumer.
function isPetActive(): boolean {
  try {
    const { isModuleActive } = require('../../../core/modules');
    return !!isModuleActive('pet');
  } catch (_e) {
    return false;
  }
}

module.exports = {
  isPetOnlyMcp,
  skipForAudience,
  resolveAudience,
  isPetActive,
};
