// ── MCP gateway policy: trust + write/destructive gating ──────────────────────
// The permission layer in front of the MCP-Tools aggregator (bridge.ts). It
// answers one question per tools/call: "is this upstream source allowed to run
// this tool right now?" Internal YHA-owned servers are implicitly fully trusted
// (they ship with YHA). External (user-added) sources carry their own posture —
// trust level + an allow-write flag — persisted by the mcp-external-sources
// module and surfaced here through the merged registry (state.ts).
//
// Read vs. write is decided from the MCP tool's own annotations when present
// (readOnlyHint / destructiveHint, captured in protocol.ts), falling back to a
// conservative name heuristic so a server that ships no annotations still can't
// silently run a `delete_*` tool under a read-only posture.
'use strict';

const { mcpConnections } = require('../../../core/state');

// Conservative write/destructive verbs. Matched as a whole word-ish segment so
// `read_repository` doesn't trip on "read" and `create_file` does trip on
// "create". Only consulted when the server provides no annotation hint.
const WRITE_NAME_RE = /(?:^|[_\-./])(create|update|delete|remove|destroy|drop|write|put|post|patch|set|add|insert|append|send|push|publish|upload|move|rename|exec|execute|run|kill|merge|modify|edit|revoke|grant|deploy|install|uninstall|reset|clear|purge|truncate|overwrite|approve|pay|transfer|checkout|commit)(?:$|[_\-./])/i;

// Is the named tool a write/destructive operation? Prefers the server's own
// MCP annotations; falls back to the verb heuristic on the tool name.
function isWriteTool(serverName: string, toolName: string): boolean {
  const conn = mcpConnections.get(serverName);
  const meta = (conn?.tools || []).find((t: any) => t.name === toolName);
  const ann = meta?.annotations;
  if (ann && typeof ann === 'object') {
    if (ann.readOnlyHint === true) return false;     // server: read-only
    if (ann.destructiveHint === true) return true;    // server: destructive
    if (ann.readOnlyHint === false) return true;      // server: mutates
  }
  return WRITE_NAME_RE.test(String(toolName || ''));
}

type Trust = 'trusted' | 'ask' | 'disabled';
interface SourcePolicy { kind: 'internal' | 'external'; trust: Trust; allowWrite: boolean }

// Resolve a source's posture from the merged registry. Internal YHA-owned
// servers are always fully trusted. External sources default to the SAFE
// posture (trust 'ask', allowWrite false) when they carry no explicit fields —
// matching the product rule that third-party servers grant nothing by default.
function resolveSourcePolicy(serverName: string): SourcePolicy {
  let reg: Record<string, any> = {};
  try { reg = require('./state').readUpstreamRegistry().mcpServers || {}; } catch (_) { /* registry unreadable */ }
  const cfg = reg[serverName];
  const kind = cfg?.kind === 'external' ? 'external' : 'internal';
  if (kind === 'internal') return { kind: 'internal', trust: 'trusted', allowWrite: true };
  const trust: Trust = cfg?.trust === 'trusted' || cfg?.trust === 'disabled' ? cfg.trust : 'ask';
  return { kind: 'external', trust, allowWrite: cfg?.allowWrite === true };
}

interface Decision { allow: boolean; reason?: string }

// The gateway-time decision for one tools/call. The MCP-Tools surface is a
// NON-interactive boundary (spawned harnesses / external clients can't be
// prompted mid-call), so trust 'ask' collapses to "reads allowed, writes denied
// until the user grants allowWrite". True per-call interactive consent is a
// deferred follow-up; this gate is the hard safety floor in the meantime.
function evaluateToolCall(serverName: string, toolName: string): Decision {
  const pol = resolveSourcePolicy(serverName);
  if (pol.kind === 'internal') return { allow: true };
  if (pol.trust === 'disabled') {
    return { allow: false, reason: `External MCP source "${serverName}" is disabled by policy and cannot run tools.` };
  }
  if (isWriteTool(serverName, toolName) && pol.allowWrite !== true) {
    return {
      allow: false,
      reason:
        `Write/destructive tool "${serverName}__${toolName}" is blocked: external source ` +
        `"${serverName}" does not have write tools enabled. Turn on "Allow write tools" for ` +
        `this source in YHA → MCP → External to permit it.`,
    };
  }
  return { allow: true };
}

module.exports = { isWriteTool, resolveSourcePolicy, evaluateToolCall };
