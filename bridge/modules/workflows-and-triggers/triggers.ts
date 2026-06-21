// server-triggers.js — Trigger persistence, heartbeats, SSE, file-backed state
// Each trigger is stored as ./bridge/triggers/{id}.md (YAML frontmatter + user notes)
// Timer triggers run as server-side setInterval — survive browser close.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// triggers/ data dir lives under the per-user folder (Q16: per-user content).
// Routed via bridge/core/paths.ts so the same call site works in single- and
// multi-user mode. Falls back to bridge/triggers/ pre-migration.
const TRIGGERS_DIR = require('../../core/paths').triggersDir;
if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
const logger = require('../../core/logger');
const { BridgeInputError } = require('../../core/errors');
const workflowRunner = require('./workflow-runner');

// ── In-memory runtime ─────────────────────────────────────────────────────────
// id → { id, type, config, workflowId, enabled, execCount, lastFired, nextFire,
//         createdAt, _handle }
const triggers = new Map();

// In-memory heartbeat timestamps — updated every 60s per active timer trigger.
// Avoids writing to disk just to keep file mtime fresh. Keyed by trigger id.
const heartbeatTimestamps = new Map();

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set<any>();

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(payload);
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

// ── MD I/O ────────────────────────────────────────────────────────────────────

function triggerFilePath(id) {
  return path.join(TRIGGERS_DIR, `${id}.md`);
}

/** Parse YAML-ish frontmatter between first ---…--- block. */
function parseFrontmatter(content): any {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const front = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (val === 'true') front[key] = true;
    else if (val === 'false') front[key] = false;
    else if (val === 'null' || val === '') front[key] = null;
    else if (/^\d+$/.test(val)) front[key] = parseInt(val, 10);
    else if (val.startsWith('{')) {
      try {
        front[key] = JSON.parse(val);
      } catch (_) {
        front[key] = val;
      }
    } else front[key] = val;
  }
  return front;
}

/** Extract body text (everything after the closing ---). */
function extractBody(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

/** Generate a sensible default body for a new trigger file. */
function defaultBody(t) {
  const labels = {
    timer: 'Timer',
    daily: 'Daily',
    website: 'Website Monitor',
    newdata: 'New Data',
  };
  const cfg = t.config || {};
  let cfgDesc = '';
  if (t.type === 'timer') cfgDesc = `- **interval**: ${cfg.duration || 5} minutes`;
  if (t.type === 'daily') cfgDesc = `- **time**: ${cfg.time || '08:00'}`;
  if (t.type === 'website')
    cfgDesc = `- **url**: ${cfg.url || ''}\n- **check every**: ${cfg.interval || 5} minutes`;
  if (t.type === 'newdata')
    cfgDesc = `- **path**: ${cfg.path || ''}\n- **poll every**: ${cfg.interval || 2} minutes`;
  return [
    `# ${labels[t.type] || t.type} Trigger`,
    ``,
    `**Workflow**: \`${t.workflowId || '—'}\``,
    ``,
    `## Config`,
    cfgDesc,
    ``,
    `## Notes`,
    `_Edit this section freely — the server only rewrites the frontmatter above._`,
  ].join('\n');
}

/**
 * Write (or update) a trigger's .md file.
 * Preserves existing body text; only rewrites the frontmatter block.
 */
function writeTriggerMd(t) {
  let body = '';
  try {
    const existing = fs.readFileSync(triggerFilePath(t.id), 'utf8');
    body = extractBody(existing);
  } catch (_) {}
  if (!body) body = defaultBody(t);

  const front = [
    `---`,
    `id: ${t.id}`,
    `type: ${t.type}`,
    `enabled: ${t.enabled}`,
    `standard: ${t.standard === true}`,
    `workflowId: ${t.workflowId || ''}`,
    `execCount: ${t.execCount || 0}`,
    `lastFired: ${t.lastFired || ''}`,
    `nextFire: ${t.nextFire || ''}`,
    `createdAt: ${t.createdAt || new Date().toISOString()}`,
    `config: ${JSON.stringify(t.config || {})}`,
    `---`,
  ].join('\n');

  try {
    fs.writeFileSync(triggerFilePath(t.id), front + '\n\n' + body + '\n', 'utf8');
  } catch (err) {
    logger.warn('triggers.save-failed', { id: t.id, error: err instanceof Error ? err.message : String(err) });
  }
}

function readTriggerMd(id) {
  try {
    return parseFrontmatter(fs.readFileSync(triggerFilePath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function deleteTriggerMd(id) {
  try {
    fs.unlinkSync(triggerFilePath(id));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('triggers.delete-failed', { id, error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Handles ───────────────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fireTrigger(t) {
  t.execCount = (t.execCount || 0) + 1;
  t.lastFired = new Date().toISOString();
  writeTriggerMd(t);
  const payload = serializeTrigger(t);
  broadcastEvent('trigger:fire', payload);
  logger.info('triggers.fire', { id: t.id, type: t.type, workflowId: t.workflowId, execCount: t.execCount });

  if (t.workflowId) {
    workflowRunner.runWorkflow(t.workflowId, broadcastEvent).catch((err) =>
      logger.error('triggers.workflow-error', { id: t.id, workflowId: t.workflowId, error: err.message })
    );
  }
}

/**
 * Timer trigger — pure setTimeout tick on the server.
 * Writes nextFire to the .md file so users can see when it will next run.
 * Heartbeats are kept in memory (heartbeatTimestamps Map) — file writes only
 * happen on actual state changes (fire, start, stop).
 */
function makeTimerHandle(t) {
  const ms = (t.config?.duration || 5) * 60 * 1000;
  let tmr: NodeJS.Timeout | null = null;
  let hb: NodeJS.Timeout | null = null;

  const tick = () => {
    if (!t.enabled) return;
    fireTrigger(t);
    t.nextFire = new Date(Date.now() + ms).toISOString();
    writeTriggerMd(t);
    tmr = setTimeout(tick, ms);
  };

  return {
    start() {
      if (tmr) clearTimeout(tmr);
      if (hb) clearInterval(hb);
      t.nextFire = new Date(Date.now() + ms).toISOString();
      writeTriggerMd(t);
      tmr = setTimeout(tick, ms);
      // Heartbeat: update in-memory timestamp every 60s (no disk write)
      heartbeatTimestamps.set(t.id, Date.now());
      hb = setInterval(() => {
        if (t.enabled) heartbeatTimestamps.set(t.id, Date.now());
      }, 60_000);
      logger.info('triggers.timer-armed', { id: t.id, durationMin: t.config?.duration || 5 });
    },
    stop() {
      if (tmr) {
        clearTimeout(tmr);
        tmr = null;
      }
      if (hb) {
        clearInterval(hb);
        hb = null;
      }
      heartbeatTimestamps.delete(t.id);
      t.nextFire = null;
      writeTriggerMd(t);
    },
  };
}

/** Daily trigger — schedules next occurrence, reschedules after each fire. */
function makeDailyHandle(t) {
  let tmr: NodeJS.Timeout | null = null;

  const schedule = () => {
    const [h, m] = (t.config?.time || '08:00').split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    t.nextFire = next.toISOString();
    writeTriggerMd(t);
    tmr = setTimeout(() => {
      if (t.enabled) {
        fireTrigger(t);
        schedule();
      }
    }, next.getTime() - Date.now());
    logger.info('triggers.daily-scheduled', { id: t.id, nextFire: next.toISOString() });
  };

  return {
    start() {
      if (tmr) clearTimeout(tmr);
      schedule();
    },
    stop() {
      if (tmr) {
        clearTimeout(tmr);
        tmr = null;
      }
      t.nextFire = null;
      writeTriggerMd(t);
    },
  };
}

/** Website monitor — polls URL on the server, fires on content change. */
function makeWebsiteHandle(t) {
  let lastHash: string | null = null;
  let tmr: NodeJS.Timeout | null = null;
  const ms = (t.config?.interval || 5) * 60 * 1000;

  const check = async () => {
    if (!t.enabled || !t.config?.url) return;
    try {
      const res = await fetch(t.config.url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'YHA-Trigger/1.0' },
      });
      const text = await res.text();
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      if (lastHash !== null && hash !== lastHash) fireTrigger(t);
      lastHash = hash;
    } catch (e) {
      logger.warn('triggers.website-check-failed', { id: t.id, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    start() {
      if (tmr) clearInterval(tmr);
      check();
      tmr = setInterval(check, ms);
    },
    stop() {
      if (tmr) {
        clearInterval(tmr);
        tmr = null;
      }
    },
  };
}

/**
 * New-data trigger — watches a file/dir for changes using fs.watch.
 * Falls back to stat-polling if watch fails or path doesn't exist yet.
 */
function makeNewdataHandle(t) {
  let watcher: import("fs").FSWatcher | null = null;
  let pollTmr: NodeJS.Timeout | null = null;
  let prevKey: string | null = null;

  const statCheck = async () => {
    if (!t.enabled || !t.config?.path) return;
    try {
      const st = await fs.promises.stat(t.config.path);
      const key = `${st.size}:${st.mtimeMs}`;
      if (prevKey !== null && key !== prevKey) fireTrigger(t);
      prevKey = key;
    } catch (_) {}
  };

  return {
    start() {
      statCheck();
      try {
        const dir = path.dirname(t.config?.path || '/tmp');
        watcher = fs.watch(dir, { persistent: false }, (ev, fn) => {
          if (fn && t.config?.path?.endsWith(fn)) statCheck();
        });
      } catch (_) {
        // fallback polling
        const ms = (t.config?.interval || 2) * 60 * 1000;
        pollTmr = setInterval(statCheck, ms);
      }
    },
    stop() {
      if (watcher) {
        try {
          watcher.close();
        } catch (_) {}
        watcher = null;
      }
      if (pollTmr) {
        clearInterval(pollTmr);
        pollTmr = null;
      }
    },
  };
}

/** Heartbeat trigger — like timer but also POSTs a prompt to a linked session. */
function makeHeartbeatHandle(t) {
  const ms = (t.config?.intervalMinutes || 30) * 60 * 1000;
  let tmr: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (!t.enabled) return;
    fireTrigger(t);
    t.nextFire = new Date(Date.now() + ms).toISOString();
    writeTriggerMd(t);
    tmr = setTimeout(tick, ms);

    // POST prompt to the linked session
    const sessionId = t.config?.sessionId;
    const prompt = t.config?.prompt || 'Heartbeat check-in.';
    const model = t.config?.model || '';
    const preset = t.config?.preset || '';
    if (sessionId) {
      try {
        const PORT = process.env.YHA_PORT || 8443;
        const http = require('http');
        const body = JSON.stringify({
          Input: prompt,
          SessionId: sessionId,
          Model: model,
          Preset: preset,
        });
        const req = http.request({
          hostname: 'localhost',
          port: PORT,
          path: '/v1/command/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        });
        req.on('error', () => {});
        req.write(body);
        req.end();
      } catch (_) {}
    }
  };

  return {
    start() {
      if (tmr) clearTimeout(tmr);
      t.nextFire = new Date(Date.now() + ms).toISOString();
      writeTriggerMd(t);
      tmr = setTimeout(tick, ms);
      logger.info('triggers.heartbeat-armed', { id: t.id, intervalMin: t.config?.intervalMinutes || 30 });
    },
    stop() {
      if (tmr) {
        clearTimeout(tmr);
        tmr = null;
      }
      t.nextFire = null;
      writeTriggerMd(t);
    },
  };
}

function buildHandle(t) {
  switch (t.type) {
    case 'timer':
      return makeTimerHandle(t);
    case 'daily':
      return makeDailyHandle(t);
    case 'website':
      return makeWebsiteHandle(t);
    case 'newdata':
      return makeNewdataHandle(t);
    case 'heartbeat':
      return makeHeartbeatHandle(t);
    default:
      return { start() {}, stop() {} };
  }
}

function startHandle(t) {
  if (t._handle)
    try {
      t._handle.stop();
    } catch (_) {}
  t._handle = buildHandle(t);
  t._handle.start();
}

function stopHandle(t) {
  if (t._handle) {
    try {
      t._handle.stop();
    } catch (_) {}
    t._handle = null;
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function createTrigger({
  id: rawId = undefined,
  type,
  config,
  workflowId,
  enabled = true,
  standard = false,
}) {
  const t = {
    id: rawId
      ? String(rawId)
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 48) || genId()
      : genId(),
    type: type || 'timer',
    config: config || {},
    workflowId: workflowId || '',
    enabled: enabled !== false,
    standard: standard === true,
    execCount: 0,
    lastFired: null,
    nextFire: null,
    createdAt: new Date().toISOString(),
    _handle: null,
  };
  triggers.set(t.id, t);
  writeTriggerMd(t);
  if (t.enabled) startHandle(t);
  broadcastEvent('trigger:created', serializeTrigger(t));
  return t;
}

function updateTrigger(id, patch) {
  const t = triggers.get(id);
  if (!t) return null;
  stopHandle(t);
  if (patch.type !== undefined) t.type = patch.type;
  if (patch.config !== undefined) t.config = patch.config;
  if (patch.workflowId !== undefined) t.workflowId = patch.workflowId;
  if (patch.enabled !== undefined) t.enabled = patch.enabled;
  writeTriggerMd(t);
  if (t.enabled) startHandle(t);
  broadcastEvent('trigger:updated', serializeTrigger(t));
  return t;
}

function deleteTrigger(id) {
  const t = triggers.get(id);
  if (!t) return false;
  if (t.standard) throw new BridgeInputError('Cannot delete standard trigger', { id });
  stopHandle(t);
  // Cancel any pending file-watcher debounce so it doesn't race with the deletion
  if (_debounceTimers.has(id)) {
    clearTimeout(_debounceTimers.get(id));
    _debounceTimers.delete(id);
  }
  triggers.delete(id);
  deleteTriggerMd(id);
  broadcastEvent('trigger:deleted', { id });
  return true;
}

function toggleTrigger(id) {
  const t = triggers.get(id);
  if (!t) return null;
  return updateTrigger(id, { enabled: !t.enabled });
}

function serializeTrigger(t) {
  // Strip _handle (non-serializable) from the returned object
  const { _handle, ...rest } = t;
  return rest;
}

function getAllTriggers() {
  return [...triggers.values()].map(serializeTrigger);
}

// ── Load from disk on startup ─────────────────────────────────────────────────

function loadFromDisk() {
  try {
    const files = fs.readdirSync(TRIGGERS_DIR).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const id = path.basename(f, '.md');
      const data = readTriggerMd(id);
      if (!data?.id) continue;
      const t = {
        id: data.id,
        type: data.type || 'timer',
        config: typeof data.config === 'object' ? data.config : {},
        workflowId: data.workflowId || '',
        enabled: data.enabled !== false,
        standard: data.standard === true,
        execCount: data.execCount || 0,
        lastFired: data.lastFired || null,
        nextFire: data.nextFire || null,
        createdAt: data.createdAt || new Date().toISOString(),
        _handle: null,
      };
      triggers.set(t.id, t);
      if (t.enabled) startHandle(t);
    }
    logger.info('triggers.loaded', { count: triggers.size });
  } catch (e) {
    logger.error('triggers.load-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Watch the triggers directory for direct file edits ────────────────────────
// User edits a .md file → server picks up the change and hot-reloads the trigger.

const _debounceTimers = new Map();
let _dirWatcher: import("fs").FSWatcher | null = null;
let _stopped = false;

function watchTriggersDir() {
  try {
    _dirWatcher = fs.watch(TRIGGERS_DIR, { persistent: false }, (event, filename) => {
      if (!filename?.endsWith('.md')) return;
      const id = path.basename(filename, '.md');

      // Debounce 500ms — editors write in multiple rapid events
      if (_debounceTimers.has(id)) clearTimeout(_debounceTimers.get(id));
      _debounceTimers.set(
        id,
        setTimeout(() => {
          _debounceTimers.delete(id);
          const fp = path.join(TRIGGERS_DIR, filename);

          if (!fs.existsSync(fp)) {
            // Deleted from disk externally
            if (triggers.has(id)) {
              stopHandle(triggers.get(id));
              triggers.delete(id);
              broadcastEvent('trigger:deleted', { id });
              logger.info('triggers.external-delete', { id });
            }
            return;
          }

          const data = readTriggerMd(id);
          if (!data?.id) return;
          const existing = triggers.get(id);
          if (!existing) return; // brand-new file created externally — skip (use POST API)

          const changed =
            existing.enabled !== data.enabled ||
            existing.type !== data.type ||
            existing.workflowId !== data.workflowId ||
            JSON.stringify(existing.config) !==
              JSON.stringify(typeof data.config === 'object' ? data.config : {});

          if (changed) {
            logger.info('triggers.external-edit', { id });
            updateTrigger(id, {
              type: data.type,
              config: typeof data.config === 'object' ? data.config : {},
              workflowId: data.workflowId || '',
              enabled: data.enabled !== false,
            });
          }
        }, 500)
      );
    });
    logger.info('triggers.watching', { dir: TRIGGERS_DIR });
  } catch (e) {
    logger.warn('triggers.watch-unavailable', { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Express routes ────────────────────────────────────────────────────────────

function registerTriggerRoutes(app) {
  // SSE must be registered BEFORE /:id routes — Express would match "events" as an id otherwise
  // GET /v1/triggers/events — real-time SSE stream
  app.get('/v1/triggers/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const flushSse = () => {
      if (typeof (res as any).flush === 'function') {
        try { (res as any).flush(); } catch (_) {}
      }
    };

    // Snapshot on connect so new clients get current state immediately
    res.write(
      `event: trigger:snapshot\ndata: ${JSON.stringify({ triggers: getAllTriggers() })}\n\n`
    );
    flushSse();

    sseClients.add(res);

    // Keep-alive ping every 25s (under the 60s request timeout)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
        flushSse();
      } catch (_) {
        clearInterval(ping);
        sseClients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  // GET /v1/triggers/
  app.get('/v1/triggers/', (req, res) => {
    res.json({ success: true, triggers: getAllTriggers() });
  });

  // POST /v1/triggers/
  app.post('/v1/triggers/', (req, res) => {
    const { type, config, workflowId, enabled } = req.body;
    if (!type) return res.status(400).json({ success: false, error: 'type required' });
    const t = createTrigger({ type, config, workflowId, enabled });
    res.json({ success: true, trigger: serializeTrigger(t) });
  });

  // GET /v1/triggers/:id
  app.get('/v1/triggers/:id', (req, res) => {
    const t = triggers.get(req.params.id);
    if (!t) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, trigger: serializeTrigger(t) });
  });

  // PATCH /v1/triggers/:id
  app.patch('/v1/triggers/:id', (req, res) => {
    const t = updateTrigger(req.params.id, req.body);
    if (!t) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, trigger: serializeTrigger(t) });
  });

  // DELETE /v1/triggers/:id
  app.delete('/v1/triggers/:id', (req, res) => {
    try {
      if (!deleteTrigger(req.params.id))
        return res.status(404).json({ success: false, error: 'not found' });
      res.json({ success: true });
    } catch (err) {
      res.status(403).json({ success: false, error: err.message });
    }
  });

  // POST /v1/triggers/:id/toggle
  app.post('/v1/triggers/:id/toggle', (req, res) => {
    const t = toggleTrigger(req.params.id);
    if (!t) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, trigger: serializeTrigger(t) });
  });

  // POST /v1/triggers/:id/fire — manual fire from UI
  app.post('/v1/triggers/:id/fire', (req, res) => {
    const t = triggers.get(req.params.id);
    if (!t) return res.status(404).json({ success: false, error: 'not found' });
    fireTrigger(t);
    res.json({ success: true, trigger: serializeTrigger(t) });
  });

  // GET /v1/triggers/:id/md — raw .md file (for inline editor in UI)
  app.get('/v1/triggers/:id/md', async (req, res) => {
    const fp = triggerFilePath(req.params.id);
    try {
      await fs.promises.access(fp);
      const content = await fs.promises.readFile(fp, 'utf8');
      res.type('text/plain').send(content);
    } catch (_) {
      res.status(404).json({ success: false, error: 'not found' });
    }
  });

  // PUT /v1/triggers/:id/md — save raw .md content from inline editor
  app.put('/v1/triggers/:id/md', async (req, res) => {
    const { content } = req.body;
    if (typeof content !== 'string')
      return res.status(400).json({ success: false, error: 'content required' });
    const fp = triggerFilePath(req.params.id);
    try {
      await fs.promises.writeFile(fp, content, 'utf8');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

// ── Init / Stop ───────────────────────────────────────────────────────────────

function init() {
  _stopped = false;
  loadFromDisk();
  watchTriggersDir();
}

function stopTriggers() {
  if (_stopped) return;
  _stopped = true;

  // Stop all running trigger handles
  for (const t of triggers.values()) {
    stopHandle(t);
  }

  // Close the directory watcher
  if (_dirWatcher) {
    try { _dirWatcher.close(); } catch (_) {}
    _dirWatcher = null;
  }

  // Clear any pending debounce timers
  for (const tmr of _debounceTimers.values()) {
    clearTimeout(tmr);
  }
  _debounceTimers.clear();
}

module.exports = {
  init,
  stopTriggers,
  broadcastEvent,
  registerTriggerRoutes,
  getAllTriggers,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  toggleTrigger,
  TRIGGERS_DIR,
};
