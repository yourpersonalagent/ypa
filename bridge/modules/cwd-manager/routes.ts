// cwd-manager — REST surface, mounted by the loader at /v1/cwd-manager.
//
// cwd is always passed in the body / query (never a path segment — absolute
// paths contain "/" and can't be a single Express :param). Status streaming
// is NOT here: it rides the shared triggers SSE bus (/v1/triggers/events,
// event `cwd-manager:status`), so the frontend subscribes there.
'use strict';

const { ACTIVE_INTERVALS } = require('./state');

type CwdManagerStore = import('./types').CwdManagerStore;
type Scheduler = import('./types').Scheduler;

function summarize(store: CwdManagerStore) {
  const entries = store.list();
  return {
    monitored: entries.filter((e) => e.enabled).length,
    total: entries.length,
    needingAgent: entries.filter((e) => e.enabled && e.needsAgent).length,
    agentEnabled: entries.filter((e) => e.enabled && e.agentEnabled).length,
    workerEnabled: entries.filter((e) => e.enabled && e.workerEnabled).length,
  };
}

function registerRoutes(args: {
  router: import('express').Router;
  store: CwdManagerStore;
  scheduler: Scheduler;
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}): void {
  const { router, store, scheduler } = args;

  // GET /v1/cwd-manager → all entries + summary
  router.get('/', (_req: any, res: any) => {
    res.json({ success: true, entries: store.list(), summary: summarize(store) });
  });

  // GET /v1/cwd-manager/entry?cwd=... → one entry (default snapshot if unknown)
  router.get('/entry', (req: any, res: any) => {
    const cwd = String(req.query?.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd query param required' });
    res.json({ success: true, entry: store.ensure(cwd) });
  });

  // POST /v1/cwd-manager/toggle { cwd, enabled }
  router.post('/toggle', async (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const enabled = Boolean(body.enabled);
    const entry = store.ensure(cwd);
    entry.enabled = enabled;
    if (!enabled) {
      entry.mode = 'off';
      entry.needsAgent = null;
      entry.needsAgentReason = '';
      entry.agentEnabled = false;
      entry.workerEnabled = false;
    } else if (entry.mode === 'off') {
      entry.mode = 'active';
    }
    store.upsert(entry);
    // Enabling kicks an immediate programmatic tick so the UI reflects state fast.
    const result = enabled ? await scheduler.tickNow(cwd) : entry;
    res.json({ success: true, entry: result || entry });
  });

  // POST /v1/cwd-manager/config { cwd, activeIntervalMs?, agentEnabled?, workerEnabled? }
  router.post('/config', (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const entry = store.ensure(cwd);

    if (body.activeIntervalMs !== undefined) {
      const ms = Number(body.activeIntervalMs);
      if (!ACTIVE_INTERVALS.includes(ms)) {
        return res.status(400).json({ success: false, error: `activeIntervalMs must be one of ${ACTIVE_INTERVALS.join(', ')}` });
      }
      entry.activeIntervalMs = ms;
    }
    if (body.agentEnabled !== undefined) {
      entry.agentEnabled = Boolean(body.agentEnabled) && entry.enabled;
    }
    if (body.workerEnabled !== undefined) {
      entry.workerEnabled = Boolean(body.workerEnabled) && entry.enabled;
    }
    res.json({ success: true, entry: store.upsert(entry) });
  });

  // POST /v1/cwd-manager/agent { cwd, enabled }
  // LLM-backed manager ticks are separate from monitoring and default off.
  router.post('/agent', async (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const entry = store.ensure(cwd);
    if (!entry.enabled && body.enabled) {
      return res.status(400).json({ success: false, error: 'enable CWD monitoring before enabling agent ticks' });
    }
    entry.agentEnabled = Boolean(body.enabled) && entry.enabled;
    const saved = store.upsert(entry);
    const result = saved.agentEnabled ? await scheduler.tickNow(cwd) : saved;
    res.json({ success: true, entry: result || saved });
  });


  // POST /v1/cwd-manager/worker { cwd, enabled }
  // Autonomous worker chats are separate from monitoring and manager checkups.
  router.post('/worker', async (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const entry = store.ensure(cwd);
    if (!entry.enabled && body.enabled) {
      return res.status(400).json({ success: false, error: 'enable CWD monitoring before enabling worker chats' });
    }
    entry.workerEnabled = Boolean(body.enabled) && entry.enabled;
    const saved = store.upsert(entry);
    const result = saved.workerEnabled ? await scheduler.tickNow(cwd) : saved;
    res.json({ success: true, entry: result || saved });
  });

  // POST /v1/cwd-manager/start-worker { cwd, todoId? }
  // Force-start one focused worker chat now (requires worker chats enabled).
  router.post('/start-worker', async (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const entry = store.get(cwd);
    if (!entry) return res.status(404).json({ success: false, error: 'cwd not tracked — enable it first' });
    if (!entry.workerEnabled) return res.status(400).json({ success: false, error: 'enable worker chats before starting a worker' });
    const { launchWorkerChat } = require('./worker-chat');
    const result = await launchWorkerChat(entry, typeof body.todoId === 'string' ? body.todoId : undefined);
    const saved = store.upsert(result.entry);
    res.json({ success: true, entry: saved, sessionId: result.sessionId, response: result.response });
  });

  // POST /v1/cwd-manager/tick { cwd } → force a programmatic tick now
  router.post('/tick', async (req: any, res: any) => {
    const body = req.body || {};
    const cwd = String(body.cwd || '');
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
    const entry = store.get(cwd);
    if (!entry) return res.status(404).json({ success: false, error: 'cwd not tracked — enable it first' });
    const result = await scheduler.tickNow(cwd);
    res.json({ success: true, entry: result });
  });
}

module.exports = { registerRoutes };
