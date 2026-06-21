// context/global.ts — Tiny global, cross-agent shared context.
// 5–7 short keyword-style lines, auto-injected into every model system prompt.
// Models read/write via the `important` MCP tool; users read/edit via the
// header "Global context" panel. State lives in bridge/important-memory.json
// (legacy filename — the file name kept stable to avoid a write-state rename).
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getModuleApi } = require('../core/modules');

const MEMORY_FILE = path.join(__dirname, '..', 'important-memory.json');
const TMP_FILE = MEMORY_FILE + '.tmp';

// Bookkeeping helper — silent-skip when observability-plus is disabled.
function _telemetry(payload: Record<string, unknown>): void {
  try {
    getModuleApi('observability-plus')?.telemetry?.record?.(payload);
  } catch (_) {}
}

const MAX_LINES = 7;
const MAX_LINE_CHARS = 200;

type ImportantState = {
  lines: string[];
  updatedAt: number;
  updatedBy: 'user' | 'model';
  modelChangeCounter: number;
  lastSeenByUser: number;
};

function emptyState(): ImportantState {
  return {
    lines: [],
    updatedAt: 0,
    updatedBy: 'user',
    modelChangeCounter: 0,
    lastSeenByUser: 0,
  };
}

function readFromDisk(): ImportantState {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lines: Array.isArray(parsed.lines) ? parsed.lines.filter((l: any) => typeof l === 'string') : [],
      updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
      updatedBy: parsed.updatedBy === 'model' ? 'model' : 'user',
      modelChangeCounter: Number.isFinite(parsed.modelChangeCounter) ? parsed.modelChangeCounter : 0,
      lastSeenByUser: Number.isFinite(parsed.lastSeenByUser) ? parsed.lastSeenByUser : 0,
    };
  } catch (_) {
    return emptyState();
  }
}

function writeToDisk(state: ImportantState): void {
  fs.writeFileSync(TMP_FILE, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(TMP_FILE, MEMORY_FILE);
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

const importantEvents = new EventEmitter();

let _state: ImportantState | null = null;
let _writeChain: Promise<unknown> = Promise.resolve();

function getState(): ImportantState {
  if (!_state) _state = readFromDisk();
  return _state;
}

function emitChanged(): void {
  try {
    importantEvents.emit('changed', getState());
  } catch (_) {}
}

// Serialize all writes through a single Promise chain so concurrent
// MCP calls + user edits never interleave a read-modify-write.
function withMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = _writeChain.then(() => fn());
  _writeChain = next.catch(() => {});
  return next;
}

async function readImportant(): Promise<ImportantState> {
  const s = getState();
  _telemetry({
    surface: 'memory',
    name: 'important/read',
    durationMs: 0,
    ok: true,
    resultSize: s.lines.reduce((n, l) => n + l.length, 0),
    meta: { op: 'read', lines: s.lines.length, source: 'important' },
  });
  return s;
}

async function writeImportant(opts: { lines: string[]; updatedBy: 'user' | 'model' }): Promise<ImportantState> {
  return withMutex(() => {
    const lines = sanitizeLines(opts.lines);
    const cur = getState();
    const next: ImportantState = {
      lines,
      updatedAt: Date.now(),
      updatedBy: opts.updatedBy,
      modelChangeCounter:
        opts.updatedBy === 'model' ? cur.modelChangeCounter + 1 : 0,
      lastSeenByUser: opts.updatedBy === 'user' ? Date.now() : cur.lastSeenByUser,
    };
    writeToDisk(next);
    _state = next;
    emitChanged();
    _telemetry({
      surface: 'memory',
      name: 'important/write',
      durationMs: 0,
      ok: true,
      argsSize: lines.reduce((n, l) => n + l.length, 0),
      meta: { op: 'write', updatedBy: opts.updatedBy, lines: lines.length, source: 'important' },
    });
    return next;
  });
}

async function addLine(text: string, updatedBy: 'user' | 'model'): Promise<ImportantState> {
  return withMutex(() => {
    const line = sanitizeLine(text);
    if (!line) return getState();
    const cur = getState();
    let lines = cur.lines.slice();
    lines.push(line);
    if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES); // evict oldest
    const next: ImportantState = {
      lines,
      updatedAt: Date.now(),
      updatedBy,
      modelChangeCounter:
        updatedBy === 'model' ? cur.modelChangeCounter + 1 : 0,
      lastSeenByUser: updatedBy === 'user' ? Date.now() : cur.lastSeenByUser,
    };
    writeToDisk(next);
    _state = next;
    emitChanged();
    return next;
  });
}

async function removeLine(
  ref: { index?: number; text?: string },
  updatedBy: 'user' | 'model'
): Promise<ImportantState> {
  return withMutex(() => {
    const cur = getState();
    let lines = cur.lines.slice();
    if (typeof ref.index === 'number' && ref.index >= 1 && ref.index <= lines.length) {
      lines.splice(ref.index - 1, 1);
    } else if (typeof ref.text === 'string') {
      const target = sanitizeLine(ref.text);
      const i = lines.findIndex((l) => l === target);
      if (i !== -1) lines.splice(i, 1);
    } else {
      return cur;
    }
    const next: ImportantState = {
      lines,
      updatedAt: Date.now(),
      updatedBy,
      modelChangeCounter:
        updatedBy === 'model' ? cur.modelChangeCounter + 1 : 0,
      lastSeenByUser: updatedBy === 'user' ? Date.now() : cur.lastSeenByUser,
    };
    writeToDisk(next);
    _state = next;
    emitChanged();
    return next;
  });
}

async function markSeen(): Promise<ImportantState> {
  return withMutex(() => {
    const cur = getState();
    if (cur.modelChangeCounter === 0 && cur.lastSeenByUser >= cur.updatedAt) return cur;
    const next: ImportantState = {
      ...cur,
      modelChangeCounter: 0,
      lastSeenByUser: Date.now(),
    };
    writeToDisk(next);
    _state = next;
    emitChanged();
    return next;
  });
}

// ── Footer block injected into every system prompt ───────────────────────────
// Returns '' when there are no lines, so empty state costs zero tokens.
function buildImportantFooter(): string {
  const cur = getState();
  if (!cur.lines.length) return '';
  const bullets = cur.lines.map((l) => `- ${l}`).join('\n');
  return [
    '---',
    '## Important — shared memory across agents',
    bullets,
    '',
    'This is a small shared notepad visible to every agent and the user. You can edit it via the MCP tool `important` (read / set / add / remove). Keep entries short, keyword-style. Max 7 lines.',
  ].join('\n');
}

module.exports = {
  readImportant,
  writeImportant,
  addLine,
  removeLine,
  markSeen,
  buildImportantFooter,
  importantEvents,
  MAX_LINES,
  MAX_LINE_CHARS,
};
