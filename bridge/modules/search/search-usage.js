// Per-provider search-query counters: daily + monthly buckets.
// Plain JS — required from both the bridge parent and the MCP child process.
'use strict';

const fs = require('fs');
const path = require('path');

// Path stays at `bridge/search-usage.json` (user state file kept outside
// the module dir during the modular migration). __dirname is
// bridge/modules/search; two `..` reach bridge/.
const USAGE_PATH = path.join(__dirname, '..', '..', 'search-usage.json');

// Names that have a usage bucket. The two _mcp entries don't have an external
// quota — counts are informational only — but we still record them so the
// prefs UI can show "X queries this month" next to the provider.
const PROVIDER_NAMES = ['tavily', 'exa', 'google_cse', 'bing', 'brave', 'playwright_mcp', 'web_mcp'];

function todayStr()     { return new Date().toISOString().slice(0, 10); }
function thisMonthStr() { return new Date().toISOString().slice(0, 7);  }

function emptyUsage() {
  const providers = {};
  for (const n of PROVIDER_NAMES) providers[n] = { daily: {}, monthly: {}, total: 0 };
  return { providers, lastUpdated: null };
}

function load() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
  } catch (_) {
    return emptyUsage();
  }
  if (!raw || typeof raw !== 'object' || !raw.providers) return emptyUsage();
  for (const n of PROVIDER_NAMES) {
    if (!raw.providers[n]) raw.providers[n] = { daily: {}, monthly: {}, total: 0 };
    if (!raw.providers[n].daily)   raw.providers[n].daily   = {};
    if (!raw.providers[n].monthly) raw.providers[n].monthly = {};
    // Backfill `total` for existing usage files written before the lifetime
    // counter existed. Sum of retained monthly buckets is a lower bound (older
    // months may already have been pruned) but better than starting from 0.
    if (typeof raw.providers[n].total !== 'number') {
      let sum = 0;
      for (const v of Object.values(raw.providers[n].monthly)) sum += Number(v) || 0;
      raw.providers[n].total = sum;
    }
  }
  return raw;
}

function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function prune(usage) {
  // Keep last 7 daily entries and last 6 monthly entries per provider.
  const today = new Date(todayStr() + 'T00:00:00Z').getTime();
  const cutoffDaily = today - 7 * 86400 * 1000;
  for (const n of PROVIDER_NAMES) {
    const daily = usage.providers[n].daily;
    for (const d of Object.keys(daily)) {
      const t = new Date(d + 'T00:00:00Z').getTime();
      if (!isFinite(t) || t < cutoffDaily) delete daily[d];
    }
    const monthly = usage.providers[n].monthly;
    const months = Object.keys(monthly).sort();
    if (months.length > 6) {
      for (const m of months.slice(0, months.length - 6)) delete monthly[m];
    }
  }
}

function increment(name) {
  if (!PROVIDER_NAMES.includes(name)) return;
  const usage = load();
  const day = todayStr();
  const month = thisMonthStr();
  usage.providers[name].daily[day]      = (usage.providers[name].daily[day]      || 0) + 1;
  usage.providers[name].monthly[month]  = (usage.providers[name].monthly[month]  || 0) + 1;
  usage.providers[name].total           = (usage.providers[name].total           || 0) + 1;
  usage.lastUpdated = new Date().toISOString();
  prune(usage);
  try { writeAtomic(USAGE_PATH, usage); } catch (_) { /* best-effort */ }
}

function reset(providerName) {
  if (providerName && PROVIDER_NAMES.includes(providerName)) {
    const usage = load();
    usage.providers[providerName] = { daily: {}, monthly: {}, total: 0 };
    usage.lastUpdated = new Date().toISOString();
    writeAtomic(USAGE_PATH, usage);
    return;
  }
  writeAtomic(USAGE_PATH, emptyUsage());
}

function getCount(name, window) {
  const usage = load();
  const p = usage.providers[name];
  if (!p) return 0;
  return window === 'day'
    ? (p.daily[todayStr()]       || 0)
    : (p.monthly[thisMonthStr()] || 0);
}

module.exports = {
  load, increment, reset, getCount,
  todayStr, thisMonthStr,
  PROVIDER_NAMES, USAGE_PATH,
};
