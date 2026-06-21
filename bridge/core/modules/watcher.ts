// Module file-watcher — recursively watches bridge/modules/<name>/** and
// auto-reloads the owning module after a debounce.
//
// Why a watcher and not just rely on POST /v1/modules/:name/reload? The
// modular refactor's whole point is that core (auth, streaming, MCP fan-out)
// keeps running while everything around it can swap. The model edits a file,
// the next request hits the new code — same UX as Vite's frontend HMR but
// for the bridge half. Without this, a model edit means either "do nothing
// until you remember to curl the reload endpoint" or "restart the bridge,
// killing whatever LLM stream is in flight."
//
// Safety posture is read from each module's manifest (lifecycle.reload). See
// loader.ts:getReloadPosture for the resolution rules.
//
// Disabled by default in prod (YHA_USE_DIST=true) or when YHA_NO_WATCH=1.
'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const { reload, getActiveRequests, getReloadPosture, MODULES_DIR } = require('./loader');

const DEBOUNCE_MS = 250;
// File extensions whose changes warrant a reload. Lock-files, editor swap
// files, and irrelevant assets are filtered out.
const RELOAD_EXTS = new Set(['.ts', '.js', '.cjs', '.mjs', '.json']);

interface PendingChange {
  timer: NodeJS.Timeout;
  reason: string;
}

const pending = new Map<string, PendingChange>();
// Bounded retry queue for idle-only modules that were busy at trigger time.
const idleRetryTimers = new Map<string, NodeJS.Timeout>();
// Tracks when the *first* idle-retry attempt for a module was scheduled so
// `runReload` can give up after IDLE_RETRY_BUDGET_MS instead of looping
// forever against a long-lived SSE / module that never drains.
const idleRetryFirstAttemptAt = new Map<string, number>();
const IDLE_RETRY_BUDGET_MS = 30_000;

function moduleNameFromPath(absPath: string): string | null {
  if (!absPath.startsWith(MODULES_DIR + path.sep)) return null;
  const rel = absPath.slice(MODULES_DIR.length + 1);
  const seg = rel.split(path.sep)[0];
  if (!seg || seg.startsWith('.')) return null;
  return seg;
}

function shouldReloadFile(absPath: string): boolean {
  const ext = path.extname(absPath);
  if (!RELOAD_EXTS.has(ext)) return false;
  // Skip editor temp files (vim swap, JetBrains, etc.) and dotfiles.
  const base = path.basename(absPath);
  if (base.startsWith('.') || base.endsWith('~') || base.endsWith('.swp')) return false;
  return true;
}

function scheduleReload(app: any, name: string, reason: string): void {
  const existing = pending.get(name);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pending.delete(name);
    runReload(app, name, reason).catch((e) => {
      console.warn(`[watcher] reload "${name}" threw: ${e instanceof Error ? e.message : String(e)}`);
    });
  }, DEBOUNCE_MS);
  pending.set(name, { timer, reason });
}

async function runReload(app: any, name: string, reason: string): Promise<void> {
  const handle = registry.get(name);
  if (!handle) {
    // Module is in modules.json but failed to load OR isn't in modules.json
    // at all. A first-time enable still requires restart (loader runs at
    // boot); a previously-failed module can sometimes be revived with
    // POST /v1/modules/:name/reload but only if it was registered with a
    // dispose handle. Leave that to the explicit endpoint.
    console.log(`[watcher] "${name}" changed (${reason}) but not loaded — skipping`);
    return;
  }
  if (handle.manifest?.kind === 'frontend') {
    // Frontend modules have no bridge half. Their files are picked up by
    // Vite's HMR; no action here.
    return;
  }
  const posture = getReloadPosture(handle.manifest);
  if (posture === 'never') {
    console.log(`[watcher] "${name}" changed (${reason}) — lifecycle.reload="never", restart required`);
    return;
  }
  if (posture === 'idle-only') {
    const active = getActiveRequests(name);
    if (active > 0) {
      // Retry every 2s while requests are draining — but only within the
      // IDLE_RETRY_BUDGET_MS window. The original "up to ~30s" comment was
      // never enforced; a long-lived SSE stream (or a leaking activeRequests
      // counter, see bridge-modules-system/F-001) would loop the watcher
      // forever with no operator-facing signal.
      const startedAt = idleRetryFirstAttemptAt.get(name) ?? Date.now();
      idleRetryFirstAttemptAt.set(name, startedAt);
      if (Date.now() - startedAt > IDLE_RETRY_BUDGET_MS) {
        const prev = idleRetryTimers.get(name);
        if (prev) clearTimeout(prev);
        idleRetryTimers.delete(name);
        idleRetryFirstAttemptAt.delete(name);
        console.warn(`[watcher] "${name}" still busy after ${IDLE_RETRY_BUDGET_MS}ms (${active} in-flight) — giving up; manual reload required`);
        return;
      }
      const prev = idleRetryTimers.get(name);
      if (prev) clearTimeout(prev);
      console.log(`[watcher] "${name}" idle-only with ${active} in-flight — will retry`);
      idleRetryTimers.set(name, setTimeout(() => {
        idleRetryTimers.delete(name);
        scheduleReload(app, name, `${reason} (retry)`);
      }, 2000));
      return;
    }
    // Drained to zero — clear the chain so a future busy-window starts a
    // fresh budget instead of inheriting the previous one.
    idleRetryFirstAttemptAt.delete(name);
  }
  const t0 = Date.now();
  const result = await reload(name, app);
  const dt = Date.now() - t0;
  if (result.ok) {
    console.log(`[watcher] reloaded "${name}" in ${dt}ms (${reason})`);
  } else {
    console.warn(`[watcher] reload "${name}" failed in ${dt}ms: ${result.error}`);
  }
}

let active = false;
let watcher: ReturnType<typeof fs.watch> | null = null;

function start(app: any): void {
  if (active) return;
  if (process.env.YHA_NO_WATCH === '1' || process.env.YHA_NO_WATCH === 'true') {
    console.log('[watcher] disabled (YHA_NO_WATCH=1)');
    return;
  }
  if (process.env.YHA_USE_DIST === 'true') {
    // Production build: live-edit watcher isn't useful and the recursive
    // walk would add work for no gain. Skip silently.
    return;
  }
  if (!fs.existsSync(MODULES_DIR)) {
    console.warn(`[watcher] MODULES_DIR does not exist: ${MODULES_DIR}`);
    return;
  }
  try {
    // Node 20+ supports recursive:true on Linux. The watch handle returns
    // (eventType, filename) where filename is relative to MODULES_DIR.
    watcher = fs.watch(MODULES_DIR, { recursive: true, persistent: false }, (eventType: string, filename: string | null) => {
      if (!filename) return;
      const abs = path.join(MODULES_DIR, filename);
      if (!shouldReloadFile(abs)) return;
      const name = moduleNameFromPath(abs);
      if (!name) return;
      scheduleReload(app, name, `${eventType} ${filename}`);
    });
    watcher.on('error', (e: Error) => {
      console.warn(`[watcher] error: ${e.message}`);
    });
    active = true;
    console.log(`[watcher] watching ${MODULES_DIR} (debounce ${DEBOUNCE_MS}ms; YHA_NO_WATCH=1 to disable)`);
  } catch (e) {
    console.warn(`[watcher] failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function stop(): void {
  if (!active) return;
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  for (const t of idleRetryTimers.values()) clearTimeout(t);
  idleRetryTimers.clear();
  try { watcher?.close(); } catch (_) { /* ignore */ }
  watcher = null;
  active = false;
}

module.exports = { start, stop };
