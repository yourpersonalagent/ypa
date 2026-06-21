// ── MCP gateway audit log: append-only JSONL of tools/call decisions ──────────
// Every tool call that flows through the MCP-Tools aggregator (bridge.ts) is
// recorded here with the deciding policy outcome — ok / denied / error — so the
// prefs MCP → External "Recent activity" view (and any later forensics) can show
// what each harness/session actually invoked, especially across untrusted
// external sources. Stored as line-delimited JSON in bridge/mcp-audit.jsonl
// (gitignored, per-install user state, next to mcp-state.json). Kept self-bounded
// by a cheap amortized ring trim so it can't grow without limit.
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../../core/logger');

const AUDIT_FILE = path.join(__dirname, '..', '..', '..', 'mcp-audit.jsonl');
const MAX_LINES = 2000; // hard cap before a trim kicks in
const TRIM_TO = 1500;   // how many most-recent lines we keep when trimming

function summarizeArgs(args: any): string {
  try {
    const json = JSON.stringify(args ?? {});
    return json.length > 240 ? json.slice(0, 240) + '…' : json;
  } catch { return '[unserializable]'; }
}

interface AuditInput {
  server: string;
  tool: string;
  kind?: 'internal' | 'external';
  status?: 'ok' | 'denied' | 'error';
  reason?: string;
  session?: string;
  caller?: string;
  args?: any;
}

let _appendsSinceTrim = 0;

function recordAudit(entry: AuditInput): void {
  const line: Record<string, any> = {
    t: new Date().toISOString(),
    server: entry.server || '',
    tool: entry.tool || '',
    kind: entry.kind || 'internal',
    status: entry.status || 'ok',
    caller: entry.caller || 'gateway',
    args: summarizeArgs(entry.args),
  };
  if (entry.reason) line.reason = entry.reason;
  if (entry.session) line.session = entry.session;
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(line) + '\n');
    maybeTrim();
  } catch (e) {
    logger.warn('mcp-audit.append-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Amortized ring trim: only re-read + rewrite the file once every 200 appends,
// so the hot path is a single appendFileSync. Best-effort — a failed trim just
// lets the file run a little long until the next attempt.
function maybeTrim(): void {
  if (++_appendsSinceTrim < 200) return;
  _appendsSinceTrim = 0;
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(AUDIT_FILE, lines.slice(lines.length - TRIM_TO).join('\n') + '\n');
    }
  } catch (_) { /* ignore — trimmed on a later append */ }
}

// Most-recent-first tail of the log, parsed back into objects.
function readAudit(limit = 100): any[] {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    return tail
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (_) {
    return [];
  }
}

module.exports = { recordAudit, readAudit, AUDIT_FILE };
