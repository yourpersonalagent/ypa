// hermes.ts — Hermes partner agent adapter
// Manages a persistent tui_gateway subprocess (JSON-RPC over stdio).
// YHA sessions map 1-to-1 to Hermes sessions for conversation continuity.
'use strict';

const { spawn } = require('child_process');
const { createInterface } = require('readline');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const os = require('os');
const logger = require('../../core/logger');

const HOME = process.env.HOME || os.homedir();
const HERMES_HOME = process.env.HERMES_HOME || path.join(HOME, '.hermes');
const HERMES_AGENT_DIR = path.join(HERMES_HOME, 'hermes-agent');
const HERMES_PYTHON = path.join(HERMES_AGENT_DIR, 'venv', 'bin', 'python');
const TUI_GATEWAY_MODULE = path.join(HERMES_AGENT_DIR, 'tui_gateway');

// ── Outgoing image post-processor ─────────────────────────────────────────────
// Replaces local file paths in Hermes markdown image references with base64
// data URIs so they display correctly in the browser.
const _IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

function _processHermesImages(text: string): string {
  if (!text) return text;
  return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
    if (/^https?:\/\/|^data:/.test(src)) return match;
    const filePath = src.startsWith('~') ? path.join(HOME, src.slice(1)) : src;
    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase() || 'png';
      const mime = _IMAGE_MIME[ext] || 'image/png';
      return `![${alt}](data:${mime};base64,${data.toString('base64')})`;
    } catch {
      return match;
    }
  });
}

// ── Installation check ─────────────────────────────────────────────────────────
function isHermesInstalled(): boolean {
  try {
    fs.accessSync(HERMES_PYTHON, fs.constants.X_OK);
    fs.accessSync(path.join(TUI_GATEWAY_MODULE, 'entry.py'));
    return true;
  } catch {
    return false;
  }
}

// Virtual employee record exposed to the employees API and @-mention picker.
function getHermesVirtualEmployee() {
  return {
    id: 'hermes',
    name: 'Hermes',
    role: 'Partner Agent',
    fullName: 'Hermes by Nous Research',
    defaultModel: '',
    fallbackModel: '',
    toolSetPreset: '',
    systemPromptPreset: '',
    symbolColor: '#ff9a3d',
    standard: false,
    partnerType: 'hermes',
    virtual: true,
    createdAt: new Date(0).toISOString(),
  };
}

// ── Gateway adapter ────────────────────────────────────────────────────────────
class HermesGateway extends EventEmitter {
  private proc: any = null;
  private rl: any = null;
  private reqId = 0;
  private pending: Map<string, { resolve: Function; reject: Function; timer: any }> = new Map();
  // Map from "<yhaSessionId>::<partnerId>" → Hermes session ID. The composite
  // key lets multiple Hermes partner records (each its own virtual employee)
  // hold independent Hermes sessions inside a single chat.
  private sessionMap: Map<string, string> = new Map();
  private _running = false;
  private _restarting = false;
  private _stopRequested = false;

  private _key(yhaSessionId: string, partnerId: string): string {
    return `${yhaSessionId}::${partnerId || 'default'}`;
  }

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  isInstalled(): boolean {
    return isHermesInstalled();
  }

  isRunning(): boolean {
    return this._running && this.proc != null && this.proc.exitCode === null;
  }

  start(): void {
    if (this._running) return;
    if (!isHermesInstalled()) {
      logger.warn('hermes.not-installed', { pythonPath: HERMES_PYTHON });
      return;
    }

    this._stopRequested = false;
    this._running = true;

    const env = {
      ...process.env,
      HERMES_HOME,
      PYTHONPATH: HERMES_AGENT_DIR,
      VIRTUAL_ENV: path.join(HERMES_AGENT_DIR, 'venv'),
      PATH: `${path.join(HERMES_AGENT_DIR, 'venv', 'bin')}:${process.env.PATH || ''}`,
      // Sync YHA's working directory so @filename references resolve correctly
      TERMINAL_CWD: process.env.TERMINAL_CWD || process.cwd(),
    };

    this.proc = spawn(HERMES_PYTHON, ['-m', 'tui_gateway.entry'], {
      cwd: HERMES_AGENT_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = createInterface({ input: this.proc.stdout, terminal: false });
    this.rl.on('line', (line: string) => this._handleLine(line));

    this.proc.stderr.on('data', (d: Buffer) => {
      const msg = String(d).trim();
      if (msg) logger.debug('hermes.stderr', { msg: msg.slice(0, 300) });
    });

    this.proc.on('exit', (code: number | null) => {
      this._running = false;
      this._rejectAllPending(new Error(`Hermes gateway exited (code=${code})`));
      this.rl?.close();
      this.rl = null;
      this.proc = null;
      logger.info('hermes.gateway-exited', { code });

      if (!this._stopRequested) {
        logger.info('hermes.gateway-auto-restart', { delayMs: 5000 });
        setTimeout(() => {
          if (!this._stopRequested && !this._running) this.start();
        }, 5000);
      }
    });

    logger.info('hermes.gateway-started', { python: HERMES_PYTHON, cwd: HERMES_AGENT_DIR });
  }

  stop(): void {
    this._stopRequested = true;
    this._running = false;
    this._rejectAllPending(new Error('Hermes gateway stopped'));
    this.sessionMap.clear();
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null;
    this.rl?.close();
    this.rl = null;
  }

  // ── Incoming message dispatch ──────────────────────────────────────────────
  private _handleLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line.trim()); } catch { return; }

    // JSON-RPC response (has id, result or error)
    if (msg.id != null) {
      const key = String(msg.id);
      const p = this.pending.get(key);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(key);
        if (msg.error) p.reject(new Error(msg.error?.message || 'RPC error'));
        else p.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notification (no id, method = "event")
    if (msg.method === 'event' && msg.params) {
      const { type, session_id, payload } = msg.params;
      this.emit('hermes-event', { type, session_id: session_id || '', payload: payload || {} });
    }
  }

  private _rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ── JSON-RPC request ───────────────────────────────────────────────────────
  private _send(method: string, params: object, timeoutMs = 60_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isRunning()) {
        reject(new Error('Hermes gateway is not running'));
        return;
      }
      const id = String(++this.reqId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this.proc.stdin.write(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  // ── Session management ─────────────────────────────────────────────────────
  // Wait for the gateway subprocess to come up. Used implicitly by callers that
  // arrive while the gateway is still booting (or restarting after a crash) so
  // a prompt isn't rejected with a transient "not running" race.
  async ensureRunning(timeoutMs = 15_000): Promise<void> {
    if (this.isRunning()) return;
    if (!isHermesInstalled()) throw new Error('Hermes is not installed');
    if (!this._stopRequested) this.start();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.isRunning()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Hermes gateway did not become ready in time');
  }

  // Per-session pending system-prompt injection. We can't mutate Hermes'
  // global config or its registered personalities from here, so the partner's
  // .md system prompt is prepended to the *first* user prompt after a
  // session is created. Subsequent turns reuse the same Hermes session and
  // don't re-inject — the model already has the persona in context.
  private pendingSysPrompt: Map<string, string> = new Map();

  async getOrCreateSession(
    yhaSessionId: string,
    partnerId: string = '',
    presets: { model?: string; systemPrompt?: string } = {},
  ): Promise<string> {
    const key = this._key(yhaSessionId, partnerId);
    const existing = this.sessionMap.get(key);
    if (existing) return existing;

    await this.ensureRunning();

    // session.create is fast (returns before agent init; prompt.submit waits internally)
    const result = await this._send('session.create', {}, 30_000);
    const hermesId: string = result?.session_id;
    if (!hermesId) throw new Error('session.create returned no session_id');
    this.sessionMap.set(key, hermesId);
    logger.info('hermes.session-created', { yhaSessionId, partnerId, hermesId });

    if (presets.systemPrompt && presets.systemPrompt.trim()) {
      this.pendingSysPrompt.set(hermesId, presets.systemPrompt.trim());
    }

    // Apply model via /model. Best-effort: invalid value just falls back to
    // Hermes' configured default; the user can fix it in the UI.
    if (presets.model && presets.model.trim()) {
      try {
        await this._send('slash.exec', { session_id: hermesId, command: `/model ${presets.model.trim()}` }, 30_000);
      } catch (e) {
        logger.warn('hermes.model-apply-failed', { model: presets.model, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return hermesId;
  }

  // Push updated presets to every live session for a given partner id. Called
  // by the PUT /v1/partners/:id route so an in-flight chat picks up the
  // change on the next turn instead of needing a fresh session. Note: the
  // system prompt change for already-running sessions only takes effect on
  // the next session creation — there's no clean way to retroactively change
  // the model's instructions mid-context.
  async refreshAllForPartner(
    partnerId: string,
    presets: { model?: string; systemPrompt?: string },
  ): Promise<void> {
    if (!this.isRunning()) return;
    const suffix = `::${partnerId || 'default'}`;
    const targets: string[] = [];
    for (const [k, hid] of this.sessionMap.entries()) {
      if (k.endsWith(suffix)) targets.push(hid);
    }
    for (const hermesId of targets) {
      if (presets.model && presets.model.trim()) {
        try {
          await this._send('slash.exec', { session_id: hermesId, command: `/model ${presets.model.trim()}` }, 30_000);
        } catch {}
      }
    }
  }

  dropSession(yhaSessionId: string, partnerId: string = ''): void {
    const key = this._key(yhaSessionId, partnerId);
    const hermesId = this.sessionMap.get(key);
    this.sessionMap.delete(key);
    if (hermesId && this.isRunning()) {
      this._send('session.close', { session_id: hermesId }).catch(() => {});
    }
  }

  // Sweep every sessionMap entry whose key ends in `::<partnerId>` and tell
  // the Hermes gateway to close each one. Called from the partner DELETE
  // route — without this, bridge `sessionMap` entries persisted across
  // restarts and the gateway-side sessions stayed alive until next gateway
  // restart, leaking memory and credentials per partner record.
  dropAllSessionsForPartner(partnerId: string): number {
    const suffix = `::${partnerId || 'default'}`;
    const removed: string[] = [];
    for (const [k, hid] of this.sessionMap.entries()) {
      if (k.endsWith(suffix)) {
        this.sessionMap.delete(k);
        removed.push(hid);
      }
    }
    if (removed.length && this.isRunning()) {
      for (const hermesId of removed) {
        this._send('session.close', { session_id: hermesId }).catch(() => {});
      }
    }
    return removed.length;
  }

  // ── Chat streaming ─────────────────────────────────────────────────────────
  // Submits a prompt to Hermes and streams message.delta events via onDelta.
  // Returns when message.complete arrives. The returned text has local image
  // paths replaced with base64 data URIs so the browser can display them.
  //
  // Timing model: Hermes turns can run for many minutes (long tool chains,
  // browser automation, model thinking). A single absolute timeout is too
  // blunt — it either fires while the agent is still legitimately working,
  // or it has to be set so high that a truly stuck session never recovers.
  // Instead we use two independent watchdogs:
  //   - idleMs: max gap between any inbound event for this session.
  //   - totalMs: hard ceiling regardless of activity.
  // Either one tripping aborts the prompt.
  async submitPrompt(
    yhaSessionId: string,
    partnerId: string,
    text: string,
    onDelta: (deltaText: string) => void,
    opts: { imageBlocks?: any[]; cwd?: string; presets?: { model?: string; systemPrompt?: string }; idleMs?: number; totalMs?: number } = {},
    timeoutMs?: number,
    onPromptRequest?: (type: string, payload: Record<string, any>) => void,
  ): Promise<{ text: string; status: string; rawText: string }> {
    await this.ensureRunning();

    const idleMs = opts.idleMs ?? 300_000;            // 5 min of silence
    const totalMs = opts.totalMs ?? timeoutMs ?? 1_800_000; // 30 min absolute

    const hermesId = await this.getOrCreateSession(yhaSessionId, partnerId, opts.presets || {});

    // If this is the first turn after session creation and a system prompt
    // was queued, prepend it to the user message. Hermes treats the prefix
    // as instructions in-context — without mutating its global config.
    // The shared "Important" footer is re-prepended on every turn (Hermes
    // doesn't see the bridge's other system-prompt paths, so this is the
    // only way it sees fresh notes left by other agents).
    const { buildImportantFooter } = require('../../providers');
    const { buildCwdContextFooterForSession } = require('../../context/cwd');
    const importantFooter = buildImportantFooter();
    const cwdFooter = buildCwdContextFooterForSession(yhaSessionId);
    const queued = this.pendingSysPrompt.get(hermesId);
    if (queued) this.pendingSysPrompt.delete(hermesId);
    let effectiveText = text;
    if (queued || importantFooter || cwdFooter) {
      const parts: string[] = [];
      if (queued) parts.push(`[Persona Instructions]\n${queued}`);
      if (importantFooter) parts.push(importantFooter);
      if (cwdFooter) parts.push(cwdFooter);
      parts.push(`[User]\n${text}`);
      effectiveText = parts.join('\n\n---\n\n');
    }

    // ── Send incoming images as attached files ─────────────────────────────
    const tempFiles: string[] = [];
    if (Array.isArray(opts.imageBlocks) && opts.imageBlocks.length) {
      const tmpDir = os.tmpdir();
      for (const block of opts.imageBlocks) {
        if (block?.source?.type !== 'base64' || !block.source.data) continue;
        const rawMime: string = block.source.media_type || 'image/jpeg';
        const ext = rawMime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        const tmpPath = path.join(tmpDir, `yha-hermes-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        try {
          fs.writeFileSync(tmpPath, Buffer.from(block.source.data, 'base64'));
          await this._send('image.attach', { session_id: hermesId, path: tmpPath }, 15_000);
          tempFiles.push(tmpPath);
        } catch (e) {
          logger.warn('hermes.image-attach-failed', { error: e instanceof Error ? e.message : String(e) });
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      }
    }

    return new Promise((resolve, reject) => {
      let idleTimer: any = null;
      const totalTimer = setTimeout(() => {
        if (idleTimer) clearTimeout(idleTimer);
        unsub();
        cleanupTemp();
        reject(new Error(`Hermes prompt total-timeout after ${Math.round(totalMs / 1000)}s`));
      }, totalMs);

      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          clearTimeout(totalTimer);
          unsub();
          cleanupTemp();
          reject(new Error(`Hermes prompt idle-timeout after ${Math.round(idleMs / 1000)}s of silence`));
        }, idleMs);
      };
      armIdle();

      const cleanupTemp = () => {
        for (const f of tempFiles) try { fs.unlinkSync(f); } catch {}
      };

      const handler = (ev: { type: string; session_id: string; payload: any }) => {
        if (ev.session_id !== hermesId) return;
        // Any event for this session counts as activity → reset idle watchdog.
        armIdle();

        if (ev.type === 'message.delta') {
          const delta = ev.payload?.text || '';
          if (delta) onDelta(delta);
        } else if (ev.type === 'message.complete') {
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
          unsub();
          cleanupTemp();
          const rawText: string = ev.payload?.text || '';
          resolve({
            text: _processHermesImages(rawText),
            rawText,
            status: ev.payload?.status || 'complete',
          });
        } else if (ev.type === 'approval.request' || ev.type === 'clarify.request' ||
                   ev.type === 'sudo.request' || ev.type === 'secret.request') {
          onPromptRequest?.(ev.type, ev.payload);
        } else if (ev.type === 'error') {
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
          unsub();
          cleanupTemp();
          this.sessionMap.delete(this._key(yhaSessionId, partnerId));
          reject(new Error(ev.payload?.message || 'Hermes agent error'));
        }
      };

      const unsub = () => this.removeListener('hermes-event', handler);
      this.on('hermes-event', handler);

      // RPC ack timeout is independent and short — it only confirms Hermes
      // accepted the prompt.submit call, not that the turn is done.
      this._send('prompt.submit', { session_id: hermesId, text: effectiveText }, 30_000)
        .catch((err) => {
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
          unsub();
          cleanupTemp();
          reject(err);
        });
    });
  }

  async respondToPrompt(yhaSessionId: string, partnerId: string, type: string, params: Record<string, any>): Promise<any> {
    const hermesId = this.sessionMap.get(this._key(yhaSessionId, partnerId));
    const rpcParams: Record<string, any> = { ...params };
    if (type === 'approval') {
      if (!hermesId) throw new Error('No hermes session for YHA session ' + yhaSessionId + ' / partner ' + partnerId);
      rpcParams.session_id = hermesId;
      return this._send('approval.respond', rpcParams, 10_000);
    } else if (type === 'clarify') {
      return this._send('clarify.respond', rpcParams, 10_000);
    } else if (type === 'sudo') {
      return this._send('sudo.respond', rpcParams, 10_000);
    } else if (type === 'secret') {
      return this._send('secret.respond', rpcParams, 10_000);
    }
    throw new Error('Unknown prompt type: ' + type);
  }

  getSessionCount(): number {
    return this.sessionMap.size;
  }

  status(): object {
    return {
      installed: isHermesInstalled(),
      running: this.isRunning(),
      activeSessions: this.sessionMap.size,
      hermesHome: HERMES_HOME,
    };
  }
}

// Singleton gateway instance
const gateway = new HermesGateway();

module.exports = { gateway, isHermesInstalled, getHermesVirtualEmployee };
