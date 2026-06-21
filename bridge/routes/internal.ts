// ── Internal endpoints for Go-core stream loop (Phase 2 of GO-Ownership-Plan) ──
// These routes are the Node-side support surface Go calls into while it owns
// /v1/stream-direct/. All are gated by the bridge-internal key the same way
// /proxy/tool is — bypassing WorkOS auth because the bridge-key is the only
// auth gate (registered BEFORE authMiddleware in server.ts).
//
//   POST /internal/tool-catalog             — composite catalog (MCP + module tools)
//   POST /internal/cost-event               — finalize-time cost + token telemetry
//   POST /internal/auto-title               — trigger context-generator auto-title for a sid
//   POST /internal/persist-broadcast-message — Phase 6g/7: persist a single
//      employee's assistant reply so bridge/sessions/<sid>.json stays the
//      source of truth even when the Go-side broadcast runner owned the turn.
//
// /proxy/tool itself (extended to forward `sessionId`) lives in the
// mcp-client module — see bridge/modules/mcp-client/lib/bridge.ts.
'use strict';

const crypto = require('crypto');
const { timingSafeEqualStr } = require('../core/secure-compare');
const { BRIDGE_INTERNAL_KEY, displaySessions, activeStreams } = require('../core/state');
const { fetchGoActiveSet, wasActiveRecently } = require('../core/go-active-streams');
const { aggregatedTools } = require('../modules/mcp-client/lib/bridge');
const { BRIDGE_TOOL_DEFS_STATIC } = require('../tools/defs');
const { bridgeRegisters } = require('../core/registers/keys');
const { getModuleApi } = require('../core/modules');
const sessionsInternal = require('../sessions-internal');
const { getModelPricing } = require('../models');
const logger = require('../core/logger');
const rewind = require('../core/rewind');

function requireBridgeKey(req, res): boolean {
  const key = String(req.headers['x-bridge-key'] || '');
  if (!key || !timingSafeEqualStr(key, BRIDGE_INTERNAL_KEY)) {
    res.status(401).json({ success: false, error: 'bad bridge key' });
    return false;
  }
  return true;
}

// Built-in tool ids — what Go's embedded MCP serves natively. Excluded from
// the default catalog so Go doesn't get them twice; opt back in via
// ?include_builtins=1 for debugging.
const BUILTIN_TOOL_IDS = new Set(BRIDGE_TOOL_DEFS_STATIC.map((d: any) => d.function.name));

interface CatalogTool {
  name: string;
  description: string;
  parameters: any;
  source: string; // 'builtin' | 'mcp:<server>' | 'module:<name>'
}

function buildToolCatalog(includeBuiltins: boolean): CatalogTool[] {
  const out: CatalogTool[] = [];

  // Module-contributed tools — non-core entries from the `tools` register.
  // Built-ins also live here (with core: true) so we filter by core flag and
  // re-include them under the `builtin` source only when requested.
  for (const entry of bridgeRegisters.tools.list() as any[]) {
    const fn = entry?.function;
    if (!fn?.name) continue;
    const isBuiltin = entry.core === true && BUILTIN_TOOL_IDS.has(fn.name);
    if (isBuiltin && !includeBuiltins) continue;
    out.push({
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
      source: isBuiltin ? 'builtin' : `module:${entry.module || '<core>'}`,
    });
  }

  // MCP-server tools — already namespaced as `<server>__<tool>` by
  // aggregatedTools(); preserve that name so Go can dispatch directly.
  // aggregatedTools() also appends virtual `bridge__*` entries (the
  // MCP-Tools surface for TodoWrite/TodoRead/AskUser) which are already
  // present under their canonical names in the tools register — skip
  // those here to avoid duplicates.
  for (const t of aggregatedTools()) {
    const name = String(t.name);
    if (name.startsWith('bridge__')) continue;
    const idx = name.indexOf('__');
    const server = idx > 0 ? name.slice(0, idx) : '?';
    out.push({
      name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
      source: `mcp:${server}`,
    });
  }

  return out;
}

function registerInternalRoutes(app): void {
  app.post('/internal/finalize-abandoned-live', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const sessionId = String(req.body?.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    const reason = req.body?.reason === 'stopped' ? 'stopped' : 'aborted';
    const changed = sessionsInternal.finalizeAbandonedLiveMsgs(sessionId, reason, true);
    return res.json({ success: true, ok: true, changed });
  });

  // POST /internal/tool-catalog ───────────────────────────────────────────
  // Returns the composite tool list Go uses to fill its dispatch table.
  // `version` is a sha256 of the JSON-stringified tools list so Go can
  // cache and detect changes cheaply.
  app.post('/internal/tool-catalog', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const includeBuiltins = String(req.query?.include_builtins || '') === '1';
    const tools = buildToolCatalog(includeBuiltins);
    const version = crypto
      .createHash('sha256')
      .update(JSON.stringify(tools))
      .digest('hex');
    res.json({ success: true, tools, version });
  });

  // POST /internal/cost-event ─────────────────────────────────────────────
  // Sink for stream-finalize cost + token events from Go. Forwards into
  // observability-plus so dashboards stay accurate even when the stream
  // never touched Node's /v1/stream/ path.
  app.post('/internal/cost-event', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const body = (req.body as any) || {};
    const {
      sessionId,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cost,
      toolCallCount,
      durationMs,
      provider,
      tools,
    } = body;
    if (!sessionId || !model) {
      return res.status(400).json({ success: false, error: 'sessionId and model required' });
    }
    const obs = getModuleApi<any>('observability-plus');
    if (!obs) {
      return res.status(503).json({ success: false, error: 'observability-plus module disabled' });
    }
    try {
      obs.telemetry.record({
        surface: 'stream-finalize',
        name: String(model),
        durationMs: Number(durationMs) || 0,
        ok: true,
        meta: {
          sessionId: String(sessionId),
          inputTokens: Number(inputTokens) || 0,
          outputTokens: Number(outputTokens) || 0,
          cacheReadTokens: Number(cacheReadTokens) || 0,
          cacheCreationTokens: Number(cacheCreationTokens) || 0,
          cost: Number(cost) || 0,
          toolCallCount: Number(toolCallCount) || 0,
        },
      });
      // Keep costs.json + tokens.json totals in sync with the new traffic
      // path. Go sends cost=0 (it doesn't duplicate the rate table), so
      // compute from tokens when the wire value is absent/zero.
      let resolvedCost = (typeof cost === 'number' && cost > 0) ? cost : 0;
      if (resolvedCost === 0) {
        const pricing = getModelPricing(model);
        if (pricing) {
          const pIn = pricing.price_input || 0;
          resolvedCost =
            (Number(inputTokens) || 0) / 1_000_000 * pIn +
            (Number(outputTokens) || 0) / 1_000_000 * (pricing.price_output || 0) +
            (Number(cacheReadTokens) || 0) / 1_000_000 * (pricing.price_cache_read ?? pIn * 0.1) +
            (Number(cacheCreationTokens) || 0) / 1_000_000 * (pricing.price_cache_write ?? pIn * 1.25);
        }
      }
      if (resolvedCost > 0) {
        obs.recordCost(resolvedCost, model, provider || 'unknown');
      }
      obs.recordTokens({
        inputTokens: Number(inputTokens) || 0,
        outputTokens: Number(outputTokens) || 0,
        cacheCreationTokens: Number(cacheCreationTokens) || 0,
        cacheReadTokens: Number(cacheReadTokens) || 0,
        model,
        provider: provider || 'unknown',
        durationMs: Number(durationMs) || 0,
        toolCallCount: Number(toolCallCount) || 0,
      });
      // Fan model-native tool_use observations from go-core into the
      // `surface:'tool'` telemetry stream so #debug toolsmon byTool
      // captures Read/Write/Bash/Edit/Grep/… calls that happen inside
      // the claude-binary subprocess and never hit executeBridgeTool.
      // One event per record; meta.source flags the origin so it can be
      // distinguished from bridge-local tool exec.
      if (Array.isArray(tools)) {
        for (const t of tools) {
          if (!t || typeof t.name !== 'string' || !t.name) continue;
          obs.telemetry.record({
            surface: 'tool',
            name: String(t.name),
            durationMs: 0,
            ok: t.ok !== false,
            meta: { source: 'claudebinary', sessionId: String(sessionId), modelId: String(model) },
          });
        }
      }
      res.json({ success: true });
    } catch (e) {
      logger.warn('internal.cost-event-error', {
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /internal/persist-broadcast-message ──────────────────────────────
  // Sink for the Go-side broadcast runner. Each employee's finalized
  // assistant reply lands here so bridge/sessions/<sid>.json stays the FE's
  // source of truth on reload — the equivalent of the saveEmp(...) call at
  // bridge/modules/multichat-broadcast/runner.ts:155-198 for the simple
  // text case. Rich-block parity (tool-call / thinking blocks) is tracked
  // as a follow-up.
  app.post('/internal/persist-broadcast-message', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const body = (req.body as any) || {};
    const sessionId = String(body.sessionId || '');
    const text = typeof body.text === 'string' ? body.text : '';
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    const pushDisplayMsg = sessionsInternal?.pushDisplayMsg;
    const rebuildSessionChatHistory = sessionsInternal?.rebuildSessionChatHistory;
    if (typeof pushDisplayMsg !== 'function' || typeof rebuildSessionChatHistory !== 'function') {
      return res.status(503).json({ success: false, error: 'sessions persistence unavailable' });
    }
    const role = String(body.role || 'assistant');
    const meta: Record<string, any> = {};
    if (body.model) meta.model = String(body.model);
    if (body.author && typeof body.author === 'object') {
      // Match the saveEmp shape: { author: { id, name, role, symbolColor } }.
      meta.author = {
        id: String(body.author.id || body.employeeId || ''),
        name: body.author.name ? String(body.author.name) : '',
        role: body.author.role ? String(body.author.role) : '',
        symbolColor: body.author.symbolColor ? String(body.author.symbolColor) : '',
      };
    } else if (body.employeeId) {
      meta.author = { id: String(body.employeeId), name: '', role: '', symbolColor: '' };
    }
    meta.inputTokens = Number(body.inputTokens) || 0;
    meta.outputTokens = Number(body.outputTokens) || 0;
    // Wall-clock turn length the FE renders as the "counted time" in the
    // final meta bar. go-core sends it alongside the token totals; persist
    // it so a reloaded/switched-into turn shows the elapsed instead of only
    // the wall-clock timestamp. Omitted (0) for non-final/legacy callers.
    if (Number(body.durationMs) > 0) meta.durationMs = Number(body.durationMs);
    if (body.stopReason) meta.stopReason = String(body.stopReason);
    // Rich-block array. When the caller ships per-segment blocks
    // (text / thinking / tool-call / tool-result), persist them so
    // reload renders the full conversation trace, not just the final
    // text. Falls back to the legacy text-only path when blocks is
    // missing / empty. Mirrors the FE's Block shape
    // (frontend/src/chat/chat-utils.ts:4).
    const blocks = Array.isArray(body.blocks) && body.blocks.length > 0
      ? (body.blocks as unknown[]).filter((b) => b && typeof b === 'object')
      : undefined;
    // Mid-stream live-message lifecycle. Pre-Phase-7 Node wrote a
    // `streaming:true` placeholder on first chunk + checkpointed every
    // 2s + finalized at end so a crash mid-stream left the partial
    // reply on disk. After the Go cutover the same flow re-emerges via
    // three optional `phase` values that map to
    // sessions-internal.startLiveMsg / updateLiveMsg / finalizeLiveMsg.
    //
    //   phase=start  → push a streaming:true placeholder, return token
    //   phase=update → update the placeholder identified by liveToken
    //   phase=final  → strip streaming flag + write final content
    //   phase=""/missing → legacy push-and-go (used for user prompt,
    //                       fallback when liveToken is missing)
    const phase = String(body.phase || '').toLowerCase();
    const liveToken = Number(body.liveToken) || 0;
    const startLiveMsg = sessionsInternal?.startLiveMsg;
    const updateLiveMsg = sessionsInternal?.updateLiveMsg;
    const finalizeLiveMsg = sessionsInternal?.finalizeLiveMsg;
    const insertBeforeLive = sessionsInternal?.insertBeforeLive;
    try {
      if (phase === 'start' && typeof startLiveMsg === 'function') {
        const token = startLiveMsg(sessionId, role, meta);
        return res.json({ success: true, ok: true, liveToken: token });
      }
      if (phase === 'update' && typeof updateLiveMsg === 'function' && liveToken > 0) {
        // Carry live counters (sourced from Go core's live ticker at the
        // time of the ~2s checkpoint) so the persisted streaming placeholder
        // has a durable snapshot of the meta bar values. This makes the bar
        // on session picker / direct URL switch or after bridge restart have
        // real (last-known) numbers that can grow further from the activity
        // feed / core while the turn is still live in Go.
        const liveMetaPatch: any = {};
        if (typeof body.inputTokens === 'number') liveMetaPatch.inputTokens = body.inputTokens;
        if (typeof body.outputTokens === 'number') liveMetaPatch.outputTokens = body.outputTokens;
        if (typeof body.toolCallCount === 'number') liveMetaPatch.toolCallCount = body.toolCallCount;
        if (typeof body.apiCallCount === 'number') liveMetaPatch.apiCallCount = body.apiCallCount;
        if (typeof body.turnStartMs === 'number') liveMetaPatch.turnStartMs = body.turnStartMs;
        if (body.model) liveMetaPatch.model = body.model;
        updateLiveMsg(sessionId, liveToken, text || '', blocks as any, liveMetaPatch);
        return res.json({ success: true, ok: true });
      }
      if (phase === 'final' && typeof finalizeLiveMsg === 'function' && liveToken > 0) {
        finalizeLiveMsg(sessionId, liveToken, text || '', blocks as any, meta);
        rebuildSessionChatHistory(sessionId);
        return res.json({ success: true, ok: true });
      }
      // phase=before-live: insert a non-streaming entry chronologically
      // before the active streaming message (mirrors the sessions.ts:419
      // fallback for /btw when injectBtwBlock fails). Used by the Go-side
      // /v1/sessions/:id/btw handler when TryEmitInject can't reach the
      // live stream (emit sink already unregistered or never existed) —
      // without this hop, the #btw would only survive in the in-memory
      // replay buffer and would be lost on reload.
      if (phase === 'before-live' && typeof insertBeforeLive === 'function') {
        insertBeforeLive(sessionId, role, text || '');
        rebuildSessionChatHistory(sessionId);
        return res.json({ success: true, ok: true });
      }
      pushDisplayMsg(sessionId, role, text || '', blocks as any, meta);
      rebuildSessionChatHistory(sessionId);
      res.json({ success: true, ok: true });
    } catch (e) {
      logger.warn('internal.persist-broadcast-message-error', {
        sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({
        success: false,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // POST /internal/session-history ────────────────────────────────────────
  // Returns the LLM-context message list for a session, formatted the way
  // Go's stream-direct route wants to fold into req.Messages. Pre-Phase-7
  // Node owned /v1/stream/ and read this in-process via getHistory(sid);
  // after the Go cutover the new front-door owner needs a thin HTTP
  // surface so prior-turn context still threads through subsequent
  // requests. Without this, every chat turn looks like turn #1 to the
  // model — "what did I say first?" gets the model claiming there was no
  // earlier message.
  app.post('/internal/session-history', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const body = (req.body as any) || {};
    const sessionId = String(body.sessionId || '');
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    const getHistory = sessionsInternal?.getHistory;
    const getHistoryForEmployee = sessionsInternal?.getHistoryForEmployee;
    const rebuildSessionChatHistory = sessionsInternal?.rebuildSessionChatHistory;
    if (typeof getHistory !== 'function') {
      return res.status(503).json({ success: false, error: 'sessions history unavailable' });
    }
    try {
      // Optional `selfEmpId` scopes the history to one employee's
      // perspective: other employees' assistant turns become
      // `[Name]: ...` user messages so each fork in versus/broadcast
      // mode sees a coherent monolog where only its own past turns
      // are role:"assistant". Mirrors Node history.ts:getHistoryForEmployee.
      const selfEmpId = typeof body.selfEmpId === 'string' ? body.selfEmpId.trim() : '';
      // When using getHistory (no selfEmpId), force a rebuild from
      // displaySessions so Go-side harness turns (persisted via
      // pushDisplayMsg rather than pushHistory) are never missed.
      // getHistoryForEmployee already reads displaySessions directly and
      // needs no rebuild.
      if (!selfEmpId && typeof rebuildSessionChatHistory === 'function') {
        rebuildSessionChatHistory(sessionId);
      }
      const history = selfEmpId && typeof getHistoryForEmployee === 'function'
        ? (getHistoryForEmployee(sessionId, selfEmpId) || [])
        : (getHistory(sessionId) || []);
      // Normalise to the shape Go's stream.Message expects.
      const messages = (Array.isArray(history) ? history : []).map((m: any) => ({
        role: String(m.role || 'user'),
        content: String(m.content || ''),
      }));
      res.json({ success: true, messages });
    } catch (e) {
      logger.warn('internal.session-history-error', {
        sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // POST /internal/auto-title ─────────────────────────────────────────────
  // Triggers the context-generator's auto-title worker for a session. The
  // worker itself is a 3-minute watchdog; enqueueForAutoTitle short-circuits
  // it so the session gets a title within seconds of stream finalize.
  app.post('/internal/auto-title', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const body = (req.body as any) || {};
    const sessionId = String(body.sessionId || '');
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    const cg = getModuleApi<any>('context-generator');
    if (!cg) {
      return res.status(503).json({ success: false, error: 'context-generator module disabled' });
    }
    try {
      cg.enqueueForAutoTitle(sessionId);
      res.json({ success: true });
    } catch (e) {
      logger.warn('internal.auto-title-error', {
        sessionId,
        error: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /internal/agent-turn ─────────────────────────────────────────────
  // Tag every rewind record written after this call with `turn_id` until
  // the next call. Body: { turn_id?: string }. If turn_id is omitted or
  // empty, the bridge mints a fresh uuid (useful for "end-of-turn" reset
  // so records written between turns don't bleed into the previous one).
  // Returns the active id so callers can confirm what got applied.
  //
  // Today the bridge seeds a per-process id at module load — this route
  // is the planned hook for Go's stream loop to refine that to true
  // per-chat-turn granularity. Until Go calls this, the bridge-session
  // id is still better than the previous always-null behaviour.
  app.post('/internal/agent-turn', (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    const body = (req.body as any) || {};
    const turnId = typeof body.turn_id === 'string' ? body.turn_id.trim() : '';
    rewind.setCurrentAgentTurnId(turnId || null);
    res.json({ success: true, turn_id: rewind.getCurrentAgentTurnId() });
  });

  // GET /internal/sessions-summary ────────────────────────────────────────
  // Slim listing for the yha-rewind recovery page. The /v1/sessions/ route
  // is WorkOS-gated; the recovery page lives on a loopback-only Go service
  // that has the bridge key in its env but no user session, so it can't
  // reach /v1/sessions/. This route returns metadata only (no message
  // bodies, no working dirs, no participants) so a compromised key never
  // leaks chat contents.
  app.get('/internal/sessions-summary', async (req, res) => {
    if (!requireBridgeKey(req, res)) return;
    let goActive: Set<string>;
    try {
      goActive = await fetchGoActiveSet();
    } catch {
      goActive = new Set();
    }
    const now = Date.now();
    const out: any[] = [];
    for (const [, data] of displaySessions) {
      if (data._inMemoryOnly) continue;
      const stream = activeStreams.get(data.id);
      const isRunning =
        stream?.status === 'streaming' ||
        goActive.has(data.id) ||
        wasActiveRecently(data.id);
      out.push({
        id: data.id,
        name: data.name,
        messageCount: data.messages?.length ?? 0,
        lastUsed: data.lastUsed ?? 0,
        isRunning,
        runningSince: isRunning ? (stream?._startedAt ?? null) : null,
        runningForMs: isRunning && stream?._startedAt ? now - stream._startedAt : null,
      });
    }
    out.sort((a, b) => {
      if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
      return b.lastUsed - a.lastUsed;
    });
    res.json({ success: true, sessions: out, count: out.length, runningCount: out.filter((s) => s.isRunning).length });
  });
}

module.exports = { registerInternalRoutes };
