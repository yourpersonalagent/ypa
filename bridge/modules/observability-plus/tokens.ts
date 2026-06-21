// ── Token usage persistence — daily counts per provider/model + perf stats ────
// Companion to costs.ts. costs.json is the source of truth for $; this file
// records the *raw token breakdown* (input / cache-write / cache-read /
// output) plus per-call perf metrics (calls, tool calls, duration, text
// length) so the #debug tokens view can render stacked bars by cost share AND
// by raw count, plus throughput / tools-per-call signals that costs.json can't
// answer.
//
// In-memory mirror with debounced disk flush — see costs.ts for the rationale.
'use strict';

const fs   = require('fs');
const path = require('path');
const { writeJsonSync } = require('../../core/state');

// Per-user (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/tokens.json pre-migration.
const TOKENS_FILE = require('../../core/paths').tokens;
const FLUSH_DEBOUNCE_MS = 500;

function emptyTokens() {
  return { daily: {} };
}

let _cache: any = null;
let _flushTimer: any = null;

function _readDisk() {
  try {
    if (fs.existsSync(TOKENS_FILE))
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) || emptyTokens();
  } catch (_) {}
  return emptyTokens();
}

function loadTokens() {
  if (!_cache) _cache = _readDisk();
  return _cache;
}

function _flushNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_cache) return;
  try { writeJsonSync(TOKENS_FILE, _cache); } catch (_) {}
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; _flushNow(); }, FLUSH_DEBOUNCE_MS);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

function recordTokens(args: {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model?: string;
  provider?: string;
  durationMs?: number;
  toolCallCount?: number;
  textLength?: number;
}) {
  const it = Math.max(0, args.inputTokens || 0);
  const ot = Math.max(0, args.outputTokens || 0);
  const cw = Math.max(0, args.cacheCreationTokens || 0);
  const cr = Math.max(0, args.cacheReadTokens || 0);
  // Skip empty calls — costs.json already gates on cost > 0; tokens.json only
  // records turns that actually consumed something. Otherwise zero-token error
  // turns would inflate `calls` and skew avg-tokens-per-call.
  if (!it && !ot && !cw && !cr) return;

  const d = loadTokens();
  const day = new Date().toISOString().slice(0, 10);
  if (!d.daily[day]) d.daily[day] = { byKey: {} };
  const key = `${args.provider || 'unknown'}/${args.model || 'unknown'}`;
  if (!d.daily[day].byKey[key]) {
    d.daily[day].byKey[key] = {
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      calls: 0,
      durationMs: 0,
      toolCalls: 0,
      textLength: 0,
    };
  }
  const e = d.daily[day].byKey[key];
  e.input      += it;
  e.cacheWrite += cw;
  e.cacheRead  += cr;
  e.output     += ot;
  e.calls      += 1;
  e.durationMs += Math.max(0, args.durationMs || 0);
  e.toolCalls  += Math.max(0, args.toolCallCount || 0);
  e.textLength += Math.max(0, args.textLength || 0);
  _scheduleFlush();
}

function clearTokens() {
  _cache = emptyTokens();
  _flushNow();
}

function flushPending() {
  _flushNow();
}

function registerTokenRoutes(app) {
  app.get('/v1/tokens', (_req, res) => res.json(loadTokens()));
  app.delete('/v1/tokens', (_req, res) => { clearTokens(); res.json({ success: true }); });
}

module.exports = { recordTokens, loadTokens, clearTokens, flushPending, registerTokenRoutes };
