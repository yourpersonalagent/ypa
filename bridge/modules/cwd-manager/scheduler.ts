// cwd-manager — adaptive heartbeat scheduler.
//
// One master tick (ctx.setInterval, so it's tracked + auto-cleared on
// deactivate/hot-reload) fires every BASE_GRANULARITY_MS. On each fire it
// scans enabled entries and runs a programmatic tick for any that are "due"
// per their current mode's cadence (active vs idle). No per-CWD timers to
// leak. Status changes are pushed over the existing triggers SSE bus via
// broadcastEvent — no custom SSE server.
'use strict';

const { runProgrammaticTick } = require('./programmatic');
const { runAgentTick } = require('./agent-tick');
const { launchWorkerChat, isSessionLive } = require('./worker-chat');

type CwdManagerStore = import('./types').CwdManagerStore;
type CwdManagerEntry = import('./types').CwdManagerEntry;
type Scheduler = import('./types').Scheduler;
type AgentRunner = import('./types').AgentRunner;

// How often the master loop wakes. Must be <= the smallest active cadence
// (30s) so a 0.5-min CWD isn't starved. 15s gives sub-cadence granularity.
const BASE_GRANULARITY_MS = 15_000;
const MIN_AGENT_INTERVAL_MS = 120_000; // cost/rate guard: max one LLM tick per CWD per 2 min
const MIN_WORKER_INTERVAL_MS = 300_000; // worker chats can modify files; keep them much less chatty

function broadcast(event: string, data: unknown): void {
  try {
    const { broadcastEvent } = require('../workflows-and-triggers/triggers');
    broadcastEvent?.(event, data);
  } catch (_) {
    /* triggers module disabled — status push is best-effort */
  }
}

function statusPayload(entry: CwdManagerEntry): Record<string, unknown> {
  return {
    cwd: entry.cwd,
    mode: entry.mode,
    enabled: entry.enabled,
    agentEnabled: entry.agentEnabled,
    workerEnabled: entry.workerEnabled,
    openTodoCount: entry.openTodoCount,
    inProgressCount: entry.inProgressCount,
    needsAgent: entry.needsAgent,
    needsAgentReason: entry.needsAgentReason,
    managerSessionId: entry.managerSessionId,
    lastAction: entry.lastAction,
    lastProgrammaticAt: entry.lastProgrammaticAt,
    lastAgentAt: entry.lastAgentAt,
    lastWorkerAt: entry.lastWorkerAt,
    activeCheckupSessionId: entry.activeCheckupSessionId,
    lastError: entry.lastError,
  };
}

function dueIntervalMs(entry: CwdManagerEntry): number {
  return entry.mode === 'idle' ? entry.idleIntervalMs : entry.activeIntervalMs;
}

function createScheduler(args: {
  store: CwdManagerStore;
  ctx: {
    setInterval: (fn: (...a: unknown[]) => void, ms?: number) => ReturnType<typeof setInterval>;
    clearInterval: (h: ReturnType<typeof setInterval> | undefined) => void;
    logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  };
}): Scheduler {
  const { store, ctx } = args;
  const agentRunner: AgentRunner = { run: runAgentTick };
  const agentInFlight = new Set<string>();
  const workerInFlight = new Set<string>();
  let handle: ReturnType<typeof setInterval> | undefined;
  let running = false; // re-entrancy guard for the async master tick

  async function tickEntry(entry: CwdManagerEntry): Promise<CwdManagerEntry> {
    try {
      const { entry: next, changed } = await runProgrammaticTick(entry);
      const saved = store.upsert(next);
      if (changed) broadcast('cwd-manager:status', statusPayload(saved));
      maybeStartWorkerChat(saved);
      maybeStartAgentTick(saved);
      return store.get(saved.cwd) || saved;
    } catch (e) {
      const next = { ...entry, lastError: e instanceof Error ? e.message : String(e), lastProgrammaticAt: Date.now() };
      ctx.logger.warn(`programmatic tick failed for ${entry.cwd}:`, next.lastError);
      return store.upsert(next);
    }
  }


  function maybeStartWorkerChat(entry: CwdManagerEntry): void {
    if (!entry.enabled || !entry.workerEnabled || entry.needsAgent !== 'progress') return;
    if (workerInFlight.has(entry.cwd)) return;
    if (isSessionLive(entry.activeCheckupSessionId)) return;
    const now = Date.now();
    if (entry.lastWorkerAt && now - entry.lastWorkerAt < MIN_WORKER_INTERVAL_MS) return;

    const alertEntry = store.upsert({ ...entry, mode: 'alert', lastError: undefined });
    broadcast('cwd-manager:status', statusPayload(alertEntry));
    workerInFlight.add(entry.cwd);
    launchWorkerChat(alertEntry)
      .then((workerResult) => {
        const workerEntry = workerResult.entry || alertEntry;
        const latest = store.get(workerEntry.cwd) || workerEntry;
        const saved = store.upsert({
          ...latest,
          activeCheckupSessionId: workerEntry.activeCheckupSessionId || latest.activeCheckupSessionId,
          lastWorkerAt: workerEntry.lastWorkerAt || latest.lastWorkerAt,
          lastAction: workerEntry.lastAction,
          lastError: workerEntry.lastError,
        });
        broadcast('cwd-manager:status', statusPayload(saved));
      })
      .catch((e) => {
        const latest = store.get(entry.cwd) || entry;
        const saved = store.upsert({
          ...latest,
          lastWorkerAt: Date.now(),
          lastError: e instanceof Error ? e.message : String(e),
        });
        ctx.logger.warn(`worker chat failed for ${entry.cwd}:`, saved.lastError);
        broadcast('cwd-manager:status', statusPayload(saved));
      })
      .finally(() => workerInFlight.delete(entry.cwd));
  }

  function maybeStartAgentTick(entry: CwdManagerEntry): void {
    if (!entry.enabled || !entry.agentEnabled || !entry.needsAgent) return;
    // If autonomous worker chats are enabled, let them handle plain progress
    // work; keep the manager session for checkups/resume/human triage.
    if (entry.workerEnabled && entry.needsAgent === 'progress') return;
    if (agentInFlight.has(entry.cwd)) return;
    const now = Date.now();
    if (entry.lastAgentAt && now - entry.lastAgentAt < MIN_AGENT_INTERVAL_MS) return;

    const alertEntry = store.upsert({ ...entry, mode: 'alert', lastError: undefined });
    broadcast('cwd-manager:status', statusPayload(alertEntry));
    agentInFlight.add(entry.cwd);
    agentRunner
      .run(alertEntry)
      .then((agentEntry) => {
        const latest = store.get(agentEntry.cwd) || agentEntry;
        // Preserve any programmatic fields that changed while the model was running,
        // but keep the manager session + agent timestamp/action from the agent tick.
        const saved = store.upsert({
          ...latest,
          managerSessionId: agentEntry.managerSessionId || latest.managerSessionId,
          lastAgentAt: agentEntry.lastAgentAt,
          lastAction: agentEntry.lastAction,
          lastError: agentEntry.lastError,
        });
        broadcast('cwd-manager:status', statusPayload(saved));
      })
      .catch((e) => {
        const latest = store.get(entry.cwd) || entry;
        const saved = store.upsert({
          ...latest,
          lastAgentAt: Date.now(),
          lastError: e instanceof Error ? e.message : String(e),
        });
        ctx.logger.warn(`agent tick failed for ${entry.cwd}:`, saved.lastError);
        broadcast('cwd-manager:status', statusPayload(saved));
      })
      .finally(() => agentInFlight.delete(entry.cwd));
  }

  async function masterTick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const entry of store.list()) {
        if (!entry.enabled) continue;
        if (now - entry.lastProgrammaticAt >= dueIntervalMs(entry)) {
          await tickEntry(entry);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (handle) return;
      handle = ctx.setInterval(() => {
        masterTick().catch((e) => ctx.logger.error('masterTick threw:', e));
      }, BASE_GRANULARITY_MS);
      ctx.logger.info(`scheduler started (granularity ${BASE_GRANULARITY_MS}ms)`);
    },
    stop() {
      if (handle) {
        ctx.clearInterval(handle);
        handle = undefined;
      }
      ctx.logger.info('scheduler stopped');
    },
    async tickNow(cwd: string) {
      const entry = store.get(cwd);
      if (!entry) return undefined;
      return tickEntry(entry);
    },
  };
}

module.exports = { createScheduler };
