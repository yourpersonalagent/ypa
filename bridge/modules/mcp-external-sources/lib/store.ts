// ── External MCP source definitions: read/write + CRUD + import parsing ───────
// User-added third-party / external MCP servers, the external counterpart to
// the shipped YHA-owned catalog in modules/mcp-servers. Definitions live in the
// gitignored bridge/mcp-external-sources.json (user state, never shipped),
// alongside mcp-registry.json / mcp-state.json at the bridge root.
//
// IMPORTANT seam: this module is the WRITER + richer-metadata API. The merge
// into the runnable registry happens in modules/mcp-client/lib/state.ts, which
// reads this same JSON file directly (no cross-module require) so mcp-client
// stays self-sufficient even when mcp-external-sources is disabled. Keep the
// on-disk shape stable; state.ts depends on { sources: [{ id, transport, … }] }.
'use strict';

const fs = require('fs');
const path = require('path');

const { writeJsonSync } = require('../../../core/state');
const logger = require('../../../core/logger');

// bridge/ root — two levels up from modules/mcp-external-sources/lib, then up
// once more to clear the module dir. Matches mcp-client/lib/state.ts.
const SOURCES_FILE = path.join(__dirname, '..', '..', '..', 'mcp-external-sources.json');

type AudienceDefault = 'all' | 'chat-only' | 'pet-only';
type TrustLevel = 'trusted' | 'ask' | 'disabled';

// `http` transport is a remote MCP endpoint (Streamable HTTP / JSON-RPC POST).
// OAuth is persisted as an auth posture; a full OAuth browser/device flow is
// handled separately from this store.
interface StdioTransport {
  type: 'stdio';
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
interface HttpTransport {
  type: 'http';
  url: string;
  auth?: 'none' | 'bearer' | 'oauth';
  tokenEnv?: string;
  // Stored only when the user explicitly pastes one. Prefer tokenEnv so secrets
  // stay outside gitignored-but-readable JSON state.
  token?: string;
  headers?: Record<string, string>;
}

type Transport = StdioTransport | HttpTransport;

interface ExternalSource {
  id: string;
  label: string;
  transport: Transport;
  // External sources default OFF — absent/false means the user must explicitly
  // enable. This is the inverse of the internal catalog (absent ⇒ ON) and is
  // the safety rule for third-party servers.
  enabledByDefault?: boolean;
  audienceDefault?: AudienceDefault;
  // Permission posture for the deferred Phase 4 trust/write gate. Stored now so
  // the shape is stable; the gate in bridge.ts dispatch() is not wired yet.
  trust?: TrustLevel;
  allowWrite?: boolean;
  origin?: 'manual' | 'import' | 'registry';
  addedAt?: string;
}

interface SourcesFile {
  sources: ExternalSource[];
}

function readSourcesFile(): SourcesFile {
  try {
    const raw = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8'));
    const sources = Array.isArray(raw?.sources) ? raw.sources.filter(isValidSource) : [];
    return { sources };
  } catch (_) {
    // No file yet (fresh install — gitignored, never shipped) or unreadable.
    return { sources: [] };
  }
}

function writeSourcesFile(data: SourcesFile): void {
  try {
    writeJsonSync(SOURCES_FILE, {
      _comment:
        'User-added external MCP sources. Gitignored (per-install user state). ' +
        'Merged into the runnable registry by modules/mcp-client/lib/state.ts. ' +
        'External sources default OFF (enabledByDefault absent/false); per-install ' +
        'on/off intent lives in mcp-state.json disabled[]/enabled[] like internal servers.',
      sources: data.sources,
    });
  } catch (e) {
    logger.warn('mcp-external.save-failed', { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

function isValidTransport(t: any): t is Transport {
  if (!t || typeof t !== 'object') return false;
  if (t.type === 'stdio') return typeof t.command === 'string' && !!t.command;
  if (t.type === 'http') {
    if (typeof t.url !== 'string' || !/^https?:\/\//i.test(t.url)) return false;
    if (t.auth !== undefined && t.auth !== 'none' && t.auth !== 'bearer' && t.auth !== 'oauth') return false;
    return true;
  }
  return false;
}

function isValidSource(s: any): s is ExternalSource {
  return !!s && typeof s === 'object'
    && typeof s.id === 'string' && !!s.id
    && isValidTransport(s.transport);
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// IDs become MCP-Tools namespaces (`<id>__<tool>`) and harness-config keys, so
// they must be filename/identifier-safe and unique across BOTH external and the
// YHA-owned internal catalog — a collision would let an external source shadow
// (or be shadowed by) an internal one in the merged registry.
function normalizeId(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// bridge/mcp-registry.json — the shipped YHA-owned internal catalog. Read
// directly (not via getModuleApi) so the collision guard holds even if
// mcp-client isn't activated yet — the file is authoritative and always present.
const INTERNAL_REGISTRY_PATH = path.join(__dirname, '..', '..', '..', 'mcp-registry.json');

// Names reserved by the YHA-owned internal catalog. Prevents an external source
// from shadowing (or being shadowed by) a same-named internal server in the
// merged registry, where internal always wins.
function internalIds(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(INTERNAL_REGISTRY_PATH, 'utf8'));
    return new Set(Object.keys(raw?.mcpServers || {}));
  } catch (_) {
    return new Set();
  }
}

function listSources(): ExternalSource[] {
  return readSourcesFile().sources;
}

function getSource(id: string): ExternalSource | undefined {
  return readSourcesFile().sources.find((s) => s.id === id);
}

function normalizeSourceInput(input: any): { ok: true; source: ExternalSource } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'source body required' };
  const id = normalizeId(input.id || input.label || '');
  if (!id || !ID_RE.test(id)) return { ok: false, error: 'a valid id (or label) is required' };
  if (!isValidTransport(input.transport)) {
    return { ok: false, error: 'transport must be { type: "stdio", command } or { type: "http", url }' };
  }
  const source: ExternalSource = {
    id,
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : id,
    transport: input.transport,
    enabledByDefault: input.enabledByDefault === true,
    origin: input.origin === 'import' || input.origin === 'registry' ? input.origin : 'manual',
    addedAt: new Date().toISOString(),
  };
  if (input.audienceDefault === 'all' || input.audienceDefault === 'chat-only' || input.audienceDefault === 'pet-only') {
    source.audienceDefault = input.audienceDefault;
  }
  if (input.trust === 'trusted' || input.trust === 'ask' || input.trust === 'disabled') source.trust = input.trust;
  if (typeof input.allowWrite === 'boolean') source.allowWrite = input.allowWrite;
  return { ok: true, source };
}

function addSource(input: any): { ok: true; source: ExternalSource } | { ok: false; error: string } {
  const norm = normalizeSourceInput(input);
  if (!norm.ok) return norm;
  const file = readSourcesFile();
  if (file.sources.some((s) => s.id === norm.source.id)) {
    return { ok: false, error: `an external source with id "${norm.source.id}" already exists` };
  }
  if (internalIds().has(norm.source.id)) {
    return { ok: false, error: `"${norm.source.id}" collides with an internal YHA MCP — pick another id` };
  }
  file.sources.push(norm.source);
  writeSourcesFile(file);
  logger.info('mcp-external.added', { id: norm.source.id, transport: norm.source.transport.type });
  return { ok: true, source: norm.source };
}

// Partial update. Transport is replaced wholesale when provided. The id is
// immutable (it's the registry/namespace key) — a rename = delete + add.
function updateSource(id: string, patch: any): { ok: true; source: ExternalSource } | { ok: false; error: string } {
  const file = readSourcesFile();
  const idx = file.sources.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false, error: `unknown external source: ${id}` };
  const current = file.sources[idx];
  const next: ExternalSource = { ...current };
  if (typeof patch.label === 'string' && patch.label.trim()) next.label = patch.label.trim();
  if (patch.transport !== undefined) {
    if (!isValidTransport(patch.transport)) return { ok: false, error: 'invalid transport' };
    next.transport = patch.transport;
  }
  if (typeof patch.enabledByDefault === 'boolean') next.enabledByDefault = patch.enabledByDefault;
  if (patch.audienceDefault === null) delete next.audienceDefault;
  else if (patch.audienceDefault === 'all' || patch.audienceDefault === 'chat-only' || patch.audienceDefault === 'pet-only') {
    next.audienceDefault = patch.audienceDefault;
  }
  if (patch.trust === 'trusted' || patch.trust === 'ask' || patch.trust === 'disabled') next.trust = patch.trust;
  if (typeof patch.allowWrite === 'boolean') next.allowWrite = patch.allowWrite;
  file.sources[idx] = next;
  writeSourcesFile(file);
  logger.info('mcp-external.updated', { id });
  return { ok: true, source: next };
}

function deleteSource(id: string): boolean {
  const file = readSourcesFile();
  const before = file.sources.length;
  file.sources = file.sources.filter((s) => s.id !== id);
  if (file.sources.length === before) return false;
  writeSourcesFile(file);
  logger.info('mcp-external.deleted', { id });
  return true;
}

// ── Import: parse Claude/Cursor/Codex-style `mcpServers` JSON into sources ─────
// Accepts the common `{ "mcpServers": { name: { command, args, env } } }` shape
// (Claude Desktop / Claude Code / Cursor) and the bare map form. Returns
// candidate source definitions — they are NOT persisted here; the route adds
// them disabled-by-default so the user reviews before anything can run.
function parseImport(raw: any): { ok: true; candidates: ExternalSource[] } | { ok: false; error: string } {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); }
    catch (e) { return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const map = data && typeof data === 'object'
    ? (data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data)
    : null;
  if (!map || typeof map !== 'object') return { ok: false, error: 'expected an object with an mcpServers map' };

  const candidates: ExternalSource[] = [];
  for (const [name, cfgRaw] of Object.entries(map)) {
    const cfg = cfgRaw as any;
    if (!cfg || typeof cfg !== 'object') continue;
    const id = normalizeId(name);
    if (!id) continue;
    let transport: Transport | null = null;
    if (typeof cfg.command === 'string' && cfg.command) {
      transport = {
        type: 'stdio',
        command: cfg.command,
        ...(Array.isArray(cfg.args) ? { args: cfg.args.map(String) } : {}),
        ...(cfg.env && typeof cfg.env === 'object' ? { env: cfg.env } : {}),
      };
    } else if (typeof cfg.url === 'string' && cfg.url) {
      transport = {
        type: 'http',
        url: cfg.url,
        auth: cfg.auth === 'bearer' || cfg.auth === 'oauth' ? cfg.auth : 'none',
        ...(typeof cfg.tokenEnv === 'string' && cfg.tokenEnv ? { tokenEnv: cfg.tokenEnv } : {}),
      };
    }
    if (!transport) continue;
    candidates.push({
      id,
      label: typeof cfg.label === 'string' && cfg.label ? cfg.label : id,
      transport,
      enabledByDefault: false,
      origin: 'import',
      addedAt: new Date().toISOString(),
    });
  }
  if (!candidates.length) return { ok: false, error: 'no importable MCP servers found in the config' };
  return { ok: true, candidates };
}

module.exports = {
  SOURCES_FILE,
  listSources,
  getSource,
  addSource,
  updateSource,
  deleteSource,
  parseImport,
  normalizeId,
};
