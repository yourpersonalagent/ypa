// openclaw.ts — OpenClaw partner agent adapter
// Manages per-partner WebSocket connections to remote OpenClaw gateways.
// Each partner record gets its own OpenClawClient keyed by partnerId.
// Protocol: OpenClaw Gateway WS-RPC v3 (connect.challenge → connect → sessions.create → chat.send)
'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const logger = require('../../core/logger');

// ── One WS client per partner record ──────────────────────────────────────────
class OpenClawClient extends EventEmitter {
  private ws: any = null;
  private reqId = 0;
  private pending = new Map<string, { resolve: Function; reject: Function; timer: any }>();
  // composite key yhaSessionId::partnerId → OpenClaw sessionKey
  private sessionMap = new Map<string, string>();
  // system-prompt pending injection: hermesId → prompt text (injected on first turn only)
  private pendingSysPrompt = new Map<string, string>();
  private _authOk = false;
  private _stopRequested = false;
  private _reconnectTimer: any = null;
  // Queue of callers waiting for auth to complete
  private _connectWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(
    readonly host: string,
    readonly port: number,
    readonly token: string,
    readonly agentId: string,
  ) {
    super();
    this.setMaxListeners(0);
  }

  private get _wsUrl(): string {
    return `ws://${this.host}:${this.port}`;
  }

  isConnected(): boolean {
    return this._authOk && this.ws?.readyState === 1 /* WebSocket.OPEN */;
  }

  async isReachable(): Promise<boolean> {
    return new Promise((resolve) => {
      const http = require('http');
      const req = http.get(
        `http://${this.host}:${this.port}/health`,
        { timeout: 3000 },
        (res: any) => resolve(res.statusCode === 200),
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  connect(): void {
    if (this.isConnected() || this.ws) return;
    this._stopRequested = false;
    this._authOk = false;

    this.ws = new WebSocket(this._wsUrl, {
      headers: { Authorization: `Bearer ${this.token}` },
      handshakeTimeout: 10_000,
    });

    this.ws.on('open', () => {
      logger.info('openclaw.ws-open', { host: this.host, port: this.port, agentId: this.agentId });
    });

    this.ws.on('message', (raw: Buffer | string) => {
      this._handleMessage(String(raw));
    });

    this.ws.on('error', (err: Error) => {
      logger.warn('openclaw.ws-error', { host: this.host, error: err.message });
      this._flushWaiters(err);
    });

    this.ws.on('close', (code: number) => {
      const wasAuthed = this._authOk;
      this._authOk = false;
      this._rejectAllPending(new Error(`OpenClaw WS closed (code=${code})`));
      this._flushWaiters(new Error(`OpenClaw WS closed before auth (code=${code})`));
      this.ws = null;
      logger.info('openclaw.ws-closed', { host: this.host, code, wasAuthed });

      if (!this._stopRequested) {
        this._reconnectTimer = setTimeout(() => {
          if (!this._stopRequested) this.connect();
        }, 5000);
      }
    });
  }

  disconnect(): void {
    this._stopRequested = true;
    this._authOk = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._rejectAllPending(new Error('OpenClaw client disconnected'));
    this._flushWaiters(new Error('OpenClaw client disconnected'));
    this.sessionMap.clear();
    try { this.ws?.terminate(); } catch {}
    this.ws = null;
  }

  private _flushWaiters(err?: Error): void {
    const waiters = this._connectWaiters.splice(0);
    for (const w of waiters) {
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  private _handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw.trim()); } catch { return; }

    // Server challenge → respond with our token
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      try {
        this.ws?.send(JSON.stringify({
          type: 'req', id: '0', method: 'connect',
          params: { role: 'operator', token: this.token },
        }));
      } catch {}
      return;
    }

    // Response to our connect/auth request
    if (msg.type === 'res' && msg.id === '0') {
      if (msg.ok) {
        this._authOk = true;
        logger.info('openclaw.ws-authed', { host: this.host, proto: msg.payload?.proto });
        this._flushWaiters();
      } else {
        const err = new Error(`OpenClaw auth failed: ${msg.error?.message || 'rejected'}`);
        logger.warn('openclaw.ws-auth-failed', { host: this.host });
        this._flushWaiters(err);
      }
      return;
    }

    // Response to a pending RPC call
    if (msg.type === 'res' && msg.id != null) {
      const p = this.pending.get(String(msg.id));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(String(msg.id));
        if (msg.ok === false) p.reject(new Error(msg.error?.message || 'RPC error'));
        else p.resolve(msg.payload);
      }
      return;
    }

    // Server-push events (session.message, session.error, etc.)
    if (msg.type === 'event') {
      this.emit('oc-event', msg);
    }
  }

  private _rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private _send(method: string, params: object, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) { reject(new Error('OpenClaw client not connected')); return; }
      const id = String(++this.reqId);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async ensureConnected(timeoutMs = 15_000): Promise<void> {
    if (this.isConnected()) return;
    if (!this.ws) this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._connectWaiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this._connectWaiters.splice(idx, 1);
        reject(new Error(`OpenClaw gateway ${this.host}:${this.port} did not become ready in time`));
      }, timeoutMs);
      const wrappedResolve = () => { clearTimeout(timer); resolve(); };
      const wrappedReject = (e: Error) => { clearTimeout(timer); reject(e); };
      this._connectWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  async listAgents(): Promise<string[]> {
    await this.ensureConnected();
    const result = await this._send('agents.list', {});
    if (!Array.isArray(result?.agents)) return [];
    return result.agents.map((a: any) => a.id || a.name || String(a));
  }

  private _key(yhaSessionId: string, partnerId: string): string {
    return `${yhaSessionId}::${partnerId || 'default'}`;
  }

  async getOrCreateSession(
    yhaSessionId: string,
    partnerId: string,
    presets: { systemPrompt?: string } = {},
  ): Promise<string> {
    const key = this._key(yhaSessionId, partnerId);
    const existing = this.sessionMap.get(key);
    if (existing) return existing;

    await this.ensureConnected();
    const result = await this._send('sessions.create', { agentId: this.agentId }, 20_000);
    const sessionKey: string = result?.sessionKey;
    if (!sessionKey) throw new Error('sessions.create returned no sessionKey');

    this.sessionMap.set(key, sessionKey);
    logger.info('openclaw.session-created', { yhaSessionId, partnerId, sessionKey, agentId: this.agentId });

    if (presets.systemPrompt?.trim()) {
      this.pendingSysPrompt.set(sessionKey, presets.systemPrompt.trim());
    }
    return sessionKey;
  }

  dropSession(yhaSessionId: string, partnerId: string): void {
    const key = this._key(yhaSessionId, partnerId);
    const sessionKey = this.sessionMap.get(key);
    this.sessionMap.delete(key);
    if (sessionKey && this.isConnected()) {
      this._send('sessions.delete', { sessionKey }).catch(() => {});
    }
  }

  async submitPrompt(
    yhaSessionId: string,
    partnerId: string,
    text: string,
    onDelta: (delta: string) => void,
    opts: {
      cwd?: string;
      presets?: { model?: string; systemPrompt?: string };
      idleMs?: number;
      totalMs?: number;
    } = {},
  ): Promise<{ text: string; status: string }> {
    await this.ensureConnected();

    const idleMs = opts.idleMs ?? 300_000;
    const totalMs = opts.totalMs ?? 1_800_000;

    const presets = opts.presets || {};
    const sessionKey = await this.getOrCreateSession(yhaSessionId, partnerId, { systemPrompt: presets.systemPrompt });

    // Inject system prompt (first turn only), plus importantFooter + cwd on every turn
    const { buildImportantFooter } = require('../../providers');
    const { buildCwdContextFooterForSession } = require('../../context/cwd');
    const importantFooter = buildImportantFooter();
    const cwdFooter = buildCwdContextFooterForSession(yhaSessionId);
    const queued = this.pendingSysPrompt.get(sessionKey);
    if (queued) this.pendingSysPrompt.delete(sessionKey);

    let effectiveText = text;
    if (queued || importantFooter || cwdFooter) {
      const parts: string[] = [];
      if (queued) parts.push(`[Instructions]\n${queued}`);
      if (importantFooter) parts.push(importantFooter);
      if (cwdFooter) parts.push(cwdFooter);
      parts.push(`[User]\n${text}`);
      effectiveText = parts.join('\n\n---\n\n');
    }

    return new Promise((resolve, reject) => {
      let accumulated = '';
      let idleTimer: any = null;

      const totalTimer = setTimeout(() => {
        clearTimeout(idleTimer);
        unsub();
        reject(new Error(`OpenClaw prompt total-timeout after ${Math.round(totalMs / 1000)}s`));
      }, totalMs);

      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          clearTimeout(totalTimer);
          unsub();
          reject(new Error(`OpenClaw prompt idle-timeout after ${Math.round(idleMs / 1000)}s of silence`));
        }, idleMs);
      };
      armIdle();

      const handler = (msg: any) => {
        const payload = msg.payload || {};
        // Filter by sessionKey when present in payload
        if (payload.sessionKey && payload.sessionKey !== sessionKey) return;

        armIdle();

        if (msg.event === 'session.message') {
          if (payload.delta) {
            accumulated += payload.delta;
            onDelta(payload.delta);
          }
          if (payload.final) {
            clearTimeout(totalTimer);
            clearTimeout(idleTimer);
            unsub();
            resolve({ text: accumulated || payload.text || '', status: 'complete' });
          }
        } else if (msg.event === 'session.error') {
          clearTimeout(totalTimer);
          clearTimeout(idleTimer);
          unsub();
          this.sessionMap.delete(this._key(yhaSessionId, partnerId));
          reject(new Error(payload.message || payload.error || 'OpenClaw session error'));
        }
      };

      const unsub = () => this.removeListener('oc-event', handler);
      this.on('oc-event', handler);

      this._send('chat.send', { sessionKey, text: effectiveText }, 30_000).catch((err) => {
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
        unsub();
        reject(err);
      });
    });
  }

  getSessionCount(): number { return this.sessionMap.size; }

  status(): object {
    return {
      host: this.host,
      port: this.port,
      agentId: this.agentId,
      connected: this.isConnected(),
      activeSessions: this.sessionMap.size,
    };
  }
}

// ── Per-partner-record singleton pool ─────────────────────────────────────────
const _clients = new Map<string, OpenClawClient>();

function getClient(
  partnerId: string,
  host: string,
  port: number,
  token: string,
  agentId: string,
): OpenClawClient {
  const existing = _clients.get(partnerId);
  // Reuse if config unchanged
  if (existing && existing.host === host && existing.port === port && existing.agentId === agentId) {
    return existing;
  }
  // Config changed — replace
  if (existing) existing.disconnect();
  const client = new OpenClawClient(host, port, token, agentId);
  _clients.set(partnerId, client);
  return client;
}

function getExistingClient(partnerId: string): OpenClawClient | undefined {
  return _clients.get(partnerId);
}

function dropClient(partnerId: string): void {
  const client = _clients.get(partnerId);
  if (client) { client.disconnect(); _clients.delete(partnerId); }
}

function dropAllClients(): void {
  for (const id of [..._clients.keys()]) dropClient(id);
}

module.exports = { getClient, getExistingClient, dropClient, dropAllClients, OpenClawClient };
