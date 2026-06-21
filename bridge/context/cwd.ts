// context/cwd.ts — Tiny working-directory scoped shared context.
// 5–7 short keyword-style lines per working directory, auto-injected only into
// prompts for sessions whose workingDir matches that directory.
//
// Frontend surface: the "CWD context" subsection inside CwdPanel.tsx.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// Per-user (Q16.9 transitional) — routed via bridge/core/paths.ts.
// Falls back to bridge/cwd-context-memory.json pre-migration.
// TODO: full Q16.9 = per-cwd files in PATHS.cwdContextMemoryDir.
const MEMORY_FILE = require('../core/paths').cwdContextMemory;
const TMP_FILE = MEMORY_FILE + '.tmp';

const MAX_LINES = 7;
const MAX_LINE_CHARS = 200;
// Stop accumulating entries forever — every cwd ever pointed at by a session
// otherwise persists indefinitely. Prune untouched entries at load time.
const MAX_ENTRY_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const MAX_ENTRIES = 500;

// Q16.10 federation groundwork: stamp the node that wrote each entry. Read
// path stays node-local; field exists so the data shape survives the Q4
// federation wire. Computed once at module load — zero per-write cost.
const NODE_ID: string = (() => {
  try { return String(os.hostname() || '').trim() || 'unknown'; } catch { return 'unknown'; }
})();

type CwdContextState = {
  lines: string[];
  updatedAt: number;
  updatedBy: 'user' | 'model';
  nodeId?: string;
};

type CwdContextMap = Record<string, CwdContextState>;

function emptyState(): CwdContextState {
  return {
    lines: [],
    updatedAt: 0,
    updatedBy: 'user',
  };
}

function sanitizeLine(text: any): string {
  let s = String(text == null ? '' : text);
  s = s.replace(/[\r\n\t]+/g, ' ').trim();
  if (s.length > MAX_LINE_CHARS) s = s.slice(0, MAX_LINE_CHARS - 1).trimEnd() + '…';
  return s;
}

function sanitizeLines(input: any): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    const line = sanitizeLine(raw);
    if (line) out.push(line);
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

function normalizeCwd(cwd: any): string {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch (_) {
    return raw;
  }
}

function readFromDisk(): CwdContextMap {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const all: Array<[string, CwdContextState]> = [];
    for (const [cwd, value] of Object.entries(parsed || {})) {
      const norm = normalizeCwd(cwd);
      if (!norm) continue;
      const v: any = value || {};
      const state: CwdContextState = {
        lines: Array.isArray(v.lines) ? v.lines.filter((l: any) => typeof l === 'string') : [],
        updatedAt: Number.isFinite(v.updatedAt) ? v.updatedAt : 0,
        updatedBy: v.updatedBy === 'model' ? 'model' : 'user',
        ...(typeof v.nodeId === 'string' && v.nodeId ? { nodeId: v.nodeId } : {}),
      };
      // Drop entries with no content or older than the age cap.
      if (!state.lines.length) continue;
      if (state.updatedAt > 0 && now - state.updatedAt > MAX_ENTRY_AGE_MS) continue;
      all.push([norm, state]);
    }
    // If still over the soft cap, keep the most-recently-updated entries.
    if (all.length > MAX_ENTRIES) {
      all.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      all.length = MAX_ENTRIES;
    }
    const out: CwdContextMap = {};
    for (const [k, v] of all) out[k] = v;
    return out;
  } catch (_) {
    return {};
  }
}

function writeToDisk(state: CwdContextMap): void {
  fs.writeFileSync(TMP_FILE, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(TMP_FILE, MEMORY_FILE);
}

const cwdContextEvents = new EventEmitter();

let _state: CwdContextMap | null = null;
let _writeChain: Promise<unknown> = Promise.resolve();

function getMap(): CwdContextMap {
  if (!_state) _state = readFromDisk();
  return _state;
}

function getState(cwd: any): CwdContextState {
  const norm = normalizeCwd(cwd);
  if (!norm) return emptyState();
  const cur = getMap()[norm];
  return cur ? { ...cur, lines: [...cur.lines] } : emptyState();
}

function emitChanged(cwd: string): void {
  try {
    cwdContextEvents.emit('changed', { cwd, ...getState(cwd) });
  } catch (_) {}
}

function withMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = _writeChain.then(() => fn());
  _writeChain = next.catch(() => {});
  return next;
}

async function readCwdContext(cwd: string): Promise<CwdContextState & { cwd: string }> {
  const norm = normalizeCwd(cwd);
  const s = getState(norm);
  return { cwd: norm, ...s };
}

async function writeCwdContext(opts: { cwd: string; lines: string[]; updatedBy: 'user' | 'model' }): Promise<CwdContextState & { cwd: string }> {
  return withMutex(() => {
    const cwd = normalizeCwd(opts.cwd);
    if (!cwd) return { cwd: '', ...emptyState() };
    const lines = sanitizeLines(opts.lines);
    const next: CwdContextState = {
      lines,
      updatedAt: Date.now(),
      updatedBy: opts.updatedBy,
      nodeId: NODE_ID,
    };
    const map = { ...getMap() };
    if (lines.length) map[cwd] = next;
    else delete map[cwd];
    writeToDisk(map);
    _state = map;
    emitChanged(cwd);
    return { cwd, ...next };
  });
}

function buildCwdContextFooter(cwd: string): string {
  const norm = normalizeCwd(cwd);
  if (!norm) return '';
  const cur = getState(norm);
  if (!cur.lines.length) return '';
  const bullets = cur.lines.map((l) => `- ${l}`).join('\n');
  return [
    '---',
    `## CWD context — only for working directory ${norm}`,
    bullets,
    '',
    'This note applies only to chats whose session working directory exactly matches this path. Keep entries short, keyword-style. Max 7 lines.',
  ].join('\n');
}

function buildCwdContextFooterForSession(sessionId: string): string {
  try {
    const { getSessionCwd } = require('../sessions-internal');
    return buildCwdContextFooter(getSessionCwd(sessionId));
  } catch (_) {
    return '';
  }
}

module.exports = {
  readCwdContext,
  writeCwdContext,
  buildCwdContextFooter,
  buildCwdContextFooterForSession,
  cwdContextEvents,
  MAX_LINES,
  MAX_LINE_CHARS,
  normalizeCwd,
};
