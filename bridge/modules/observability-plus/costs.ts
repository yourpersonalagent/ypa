// ── Cost persistence — server-side cost tracking stored in costs.json ──────────
//
// In-memory mirror with debounced disk flush. recordCost() and clearCosts() get
// hit on every successful stream finalize plus the GET /v1/costs poll, so the
// previous "read+write the whole file every call" pattern was wasting fs ops
// on the streaming hot path. Now: load once at first touch, mutate the cache,
// schedule a coalesced atomic write. Sync flush from gracefulShutdown ensures
// no in-flight increment is lost on SIGTERM.
'use strict';

const fs   = require('fs');
const path = require('path');
const { writeJsonSync } = require('../../core/state');

// User-state file kept at bridge/costs.json across the modular migration.
// __dirname is bridge/modules/observability-plus; two `..` reach bridge/.
const COSTS_FILE = path.join(__dirname, '..', '..', 'costs.json');
const FLUSH_DEBOUNCE_MS = 500;

function emptyCosts() {
  return { allTime: { total: 0, byModel: {}, byProvider: {} }, daily: {} };
}

let _cache: any = null;
let _flushTimer: any = null;

function _readDisk() {
  try {
    if (fs.existsSync(COSTS_FILE))
      return JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8')) || emptyCosts();
  } catch (_) {}
  return emptyCosts();
}

function loadCosts() {
  if (!_cache) _cache = _readDisk();
  return _cache;
}

function _flushNow() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_cache) return;
  try { writeJsonSync(COSTS_FILE, _cache); } catch (_) {}
}

function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => { _flushTimer = null; _flushNow(); }, FLUSH_DEBOUNCE_MS);
  if (typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

function recordCost(cost, model, provider) {
  if (!cost || cost <= 0) return;
  const d   = loadCosts();
  const inc = (obj, key, val) => { obj[key] = (obj[key] || 0) + val; };
  inc(d.allTime, 'total', cost);
  inc(d.allTime.byModel,    model    || 'unknown', cost);
  inc(d.allTime.byProvider, provider || 'unknown', cost);
  const day = new Date().toISOString().slice(0, 10);
  if (!d.daily[day]) d.daily[day] = { total: 0, byModel: {}, byProvider: {} };
  inc(d.daily[day], 'total', cost);
  inc(d.daily[day].byModel,    model    || 'unknown', cost);
  inc(d.daily[day].byProvider, provider || 'unknown', cost);
  _scheduleFlush();
}

function clearCosts() {
  _cache = emptyCosts();
  _flushNow();
}

function flushPending() {
  _flushNow();
}

function registerCostRoutes(app) {
  app.get('/v1/costs', (_req, res) => {
    res.json(loadCosts());
  });
  app.delete('/v1/costs', (_req, res) => {
    clearCosts();
    res.json({ success: true });
  });
}

module.exports = { recordCost, loadCosts, clearCosts, flushPending, registerCostRoutes };
