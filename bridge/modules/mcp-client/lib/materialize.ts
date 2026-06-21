// Promote the MCP-Tools aggregator entry into every spawned-harness config dir.
// The entry points at the yha-bridge-stub, which proxies every JSON-RPC frame
// over HTTP back to this YHA process. That way every spawned harness (Claude
// CLI session, Claude Agent SDK, Codex, …) reuses YHA's already-running
// upstream MCP connections instead of double-spawning its own copies.
//
// Honors the externalSharing toggle (mcp-state.json): when off, writes
// mcpServers: {} so spawned harnesses see no MCPs at all. When on, writes the
// single MCP-Tools entry. YHA's own upstream MCP list (mcp-registry.json) is
// read separately via readUpstreamRegistry() and is unaffected by this toggle.
//
// Targets:
//   • Claude instances: <configDir>/settings.json (mcpServers field)
//                       <configDir>/.claude.json  (mcpServers field for `claude mcp list`)
//                       <configDir>/mcp-bridge.json  (minimal — for --mcp-config flag)
//   • Codex instances:  <configDir>/config.toml   ([mcp_servers.MCP-Tools] section)
//   • Grok instances:   <configDir>/config.toml   ([mcp_servers.MCP-Tools] + .env subtable, enabled=true)
//                       (grok CLI stores MCPs registered via `grok mcp add` in its config.toml)
//
// Idempotent: safe to call repeatedly. Non-mcp keys in target files are preserved.
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const logger = require('../../../core/logger');
const { writeJsonSync } = require('../../../core/state');

interface McpServer { command: string; args?: string[]; env?: Record<string, string> }

interface HarnessInstance { label: string; configDir: string }

// Build the single yha-bridge stub entry that gets materialized into every
// spawned-harness config. Uses YHA's own node binary + listening port.
// When YHA_BRIDGE_KEY is present in the bridge env (shared-key deployments),
// it is also injected so the stub can send x-bridge-key without relying on
// the .env file fallback.
function buildBridgeEntry(extraEnv?: Record<string, string>): Record<string, McpServer> {
  const { PORT } = require('../../../core/state');
  const stubPath = path.join(__dirname, '..', '..', '..', 'mcp', 'yha-bridge-stub.js');
  const env: Record<string, string> = { YHA_BRIDGE_URL: `http://127.0.0.1:${PORT}`, ...(extraEnv || {}) };
  if (process.env.YHA_BRIDGE_KEY) {
    env.YHA_BRIDGE_KEY = process.env.YHA_BRIDGE_KEY;
  }
  return {
    'MCP-Tools': {
      command: process.execPath,
      args: [stubPath],
      env,
    },
  };
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(process.env.HOME || os.homedir(), p.slice(2));
  if (p === '~')           return process.env.HOME || os.homedir();
  return p;
}

// ── Claude instance: write into settings.json + .claude.json ────────────────
function materializeClaude(instance: HarnessInstance, mcpServers: Record<string, McpServer>): void {
  const dir = expandHome(instance.configDir);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
      logger.warn('mcp-materialize.claude.mkdir-failed', { instance: instance.label, dir, error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
  for (const file of ['settings.json', '.claude.json']) {
    const target = path.join(dir, file);
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(target)) {
      try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (e) {
        logger.warn('mcp-materialize.claude.parse-failed', { target, error: e instanceof Error ? e.message : String(e) });
        // Don't overwrite a file we can't parse — bail for this target only.
        continue;
      }
    }
    const before = JSON.stringify(existing.mcpServers || {});
    existing.mcpServers = mcpServers;
    if (JSON.stringify(existing.mcpServers) === before) continue; // no-op
    writeJsonSync(target, existing);
    logger.info('mcp-materialize.claude.wrote', { instance: instance.label, target, count: Object.keys(mcpServers).length });
  }

  // Also write a dedicated MCP-only file for `--mcp-config` to point at. The
  // claude binary's --mcp-config flag rejects (or ignores MCPs in) files that
  // contain non-mcp top-level keys like `permissions`, `theme`, `enabledPlugins`.
  // Keep this file minimal: just { mcpServers: {...} }.
  const mcpOnly = path.join(dir, 'mcp-bridge.json');
  const payload = JSON.stringify({ mcpServers }, null, 2) + '\n';
  if (!fs.existsSync(mcpOnly) || fs.readFileSync(mcpOnly, 'utf8') !== payload) {
    writeJsonSync(mcpOnly, { mcpServers });
    logger.info('mcp-materialize.claude.wrote', { instance: instance.label, target: mcpOnly, count: Object.keys(mcpServers).length });
  }
}

// ── Codex instance: rewrite [mcp_servers.*] sections in config.toml ─────────
// Minimal TOML emit: only the mcp_servers table. We replace any existing
// [mcp_servers.<name>] sections wholesale; everything else in the file is
// preserved verbatim.
function emitTomlString(s: string): string {
  return JSON.stringify(s); // TOML basic strings use the same JSON-style escaping for our purposes
}

function emitMcpServersToml(mcpServers: Record<string, McpServer>): string {
  const lines: string[] = [];
  for (const [name, srv] of Object.entries(mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${emitTomlString(srv.command)}`);
    if (srv.args?.length) {
      lines.push(`args = [${srv.args.map(emitTomlString).join(', ')}]`);
    }
    if (srv.env && Object.keys(srv.env).length) {
      const envEntries = Object.entries(srv.env)
        .map(([k, v]) => `${emitTomlString(k)} = ${emitTomlString(v)}`)
        .join(', ');
      lines.push(`env = { ${envEntries} }`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function stripExistingMcpSections(toml: string): string {
  // Remove any [mcp_servers.<name>] section block (header + lines until the next
  // top-level header or end-of-file). Preserves all other content.
  const lines = toml.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[mcp_servers\./.test(trimmed)) { skipping = true; continue; }
    if (skipping && /^\[/.test(trimmed))   { skipping = false; }
    if (!skipping) out.push(line);
  }
  // Drop trailing blank lines we may have left behind.
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

function materializeCodex(instance: HarnessInstance, mcpServers: Record<string, McpServer>): void {
  const dir = expandHome(instance.configDir);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
      logger.warn('mcp-materialize.codex.mkdir-failed', { instance: instance.label, dir, error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
  const target = path.join(dir, 'config.toml');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const stripped = stripExistingMcpSections(existing);
  const fresh    = emitMcpServersToml(mcpServers);
  const next     = (stripped ? stripped.trimEnd() + '\n\n' : '') + fresh;
  if (next === existing) return; // no-op
  const tmpT = target + '.tmp.' + process.pid;
  fs.writeFileSync(tmpT, next);
  fs.renameSync(tmpT, target);
  logger.info('mcp-materialize.codex.wrote', { instance: instance.label, target, count: Object.keys(mcpServers).length });
}

// ── Grok instance: rewrite [mcp_servers.*] sections in config.toml ──────────
// Matches the shape written by `grok mcp add` (separate [mcp_servers.Name.env]
// table + explicit enabled = true). We always (re)write under the instance's
// configDir/config.toml so that adding a grok harness instance automatically
// gives it the YHA MCP-Tools bridge stub, exactly like claude + codex.
function emitGrokMcpServersToml(mcpServers: Record<string, McpServer>): string {
  const lines: string[] = [];
  for (const [name, srv] of Object.entries(mcpServers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${emitTomlString(srv.command)}`);
    if (srv.args?.length) {
      lines.push(`args = [${srv.args.map(emitTomlString).join(', ')}]`);
    }
    lines.push(`enabled = true`);
    if (srv.env && Object.keys(srv.env).length) {
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(srv.env)) {
        // bare keys for simple env var names (matches `grok mcp add` output style)
        const keyStr = /^[A-Za-z0-9_]+$/.test(k) ? k : emitTomlString(k);
        lines.push(`${keyStr} = ${emitTomlString(v)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function materializeGrok(instance: HarnessInstance, mcpServers: Record<string, McpServer>): void {
  const dir = expandHome(instance.configDir);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
      logger.warn('mcp-materialize.grok.mkdir-failed', { instance: instance.label, dir, error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
  const target = path.join(dir, 'config.toml');
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const stripped = stripExistingMcpSections(existing);
  const fresh    = emitGrokMcpServersToml(mcpServers);
  const next     = (stripped ? stripped.trimEnd() + '\n\n' : '') + fresh;
  if (next === existing) return; // no-op
  const tmpT = target + '.tmp.' + process.pid;
  fs.writeFileSync(tmpT, next);
  fs.renameSync(tmpT, target);
  logger.info('mcp-materialize.grok.wrote', { instance: instance.label, target, count: Object.keys(mcpServers).length });
}

// ── Public entry point ─────────────────────────────────────────────────────
export function promoteMcpTools(config: any): void {
  const { getExternalSharing } = require('./state');
  const enabled = getExternalSharing();
  const servers = enabled ? buildBridgeEntry() : {};
  // Grok Build currently rejects qualified MCP names with more than one "__".
  // YHA's aggregator exposes names like "web__search"; ask the stdio stub to
  // flatten tools/list for Grok and translate tools/call back to the real name.
  const grokServers = enabled ? buildBridgeEntry({ YHA_MCP_TOOL_ALIAS_MODE: 'grok' }) : {};

  const claudeInstances: HarnessInstance[] = config?.defaults?.claudeInstances || [];
  const codexInstances:  HarnessInstance[] = config?.defaults?.codexInstances  || [];
  const grokInstances:   HarnessInstance[] = config?.defaults?.grokInstances   || [];

  for (const inst of claudeInstances) materializeClaude(inst, servers);
  for (const inst of codexInstances)  materializeCodex(inst, servers);
  for (const inst of grokInstances)   materializeGrok(inst, grokServers);

  console.log(`[mcp-materialize] sharing=${enabled} → ${claudeInstances.length} Claude + ${codexInstances.length} Codex + ${grokInstances.length} Grok instances`);
  logger.info('mcp-materialize.done', {
    enabled,
    entry:  enabled ? 'MCP-Tools' : '(none)',
    claude: claudeInstances.length,
    codex:  codexInstances.length,
    grok:   grokInstances.length,
  });
}
