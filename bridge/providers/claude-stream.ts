// ── Streaming (--output-format stream-json) Claude binary execution ───────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const logger = require('../core/logger');

const {
  config,
  CLAUDE_BIN,
  PORT,
  BRIDGE_INTERNAL_KEY,
  activeModels,
  claudeSessions,
  activeProcesses,
} = require('../core/state');
const { saveIndexToDisk, getSessionCwd, getHistory, pushHistory, getHistoryForEmployee, getMaxHistoryTurns, getMaxHistoryChars } = require('../sessions-internal');
const { logRaw } = require('../observability/raw-logs');
const {
  isClaudeModel,
  isSubscriptionModel,
  EFFORT_LEVELS,
  historyModeNotice,
  getInstalledPluginDirs,
  loadAgentsJson,
  PERM_DENIED_PATTERNS,
} = require('./core');
const { getNiceness } = require('./claude-run');

// ── Watchdog-kill diagnostics ──────────────────────────────────────────────────
// When the finalize-kill watchdog fires we previously logged only
// "child did not exit within FINALIZE_KILL_TIMEOUT_MS". That made the recurring
// hang modes (TLS teardown, OAuth refresh, plugin shutdown) un-diagnosable from
// logs. The helper below captures: PID, /proc/<pid>/status (Linux), last 20
// lines of stderr, spawn-to-kill duration, and a cause hint inferred from
// stderr — then appends one NDJSON line to
// bridge/monitoring-log/<YYYY-MM-DD>-watchdog-kills.ndjson.
// Per-user (Q16) — routed via bridge/core/paths.ts.
const _watchdogLogBase = require('../core/paths').monitoringLogDir;
let _watchdogLogWarned = false;

function _inferKillCause(stderrTail: string): string {
  const s = stderrTail.toLowerCase();
  if (s.includes('tls') || s.includes('certificate')) return 'tls-teardown';
  if (s.includes('oauth') || s.includes('refresh token')) return 'oauth-refresh';
  if (s.includes('plugin') || s.includes('shutdown')) return 'plugin-shutdown';
  if (s.includes('mcp') && (s.includes('connect') || s.includes('handshake'))) return 'mcp-handshake';
  return 'unknown';
}

function _readProcStatus(pid: number): string | null {
  try {
    const buf = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return buf.split('\n').slice(0, 12).join('\n');
  } catch (_) {
    return null;
  }
}

function _writeWatchdogKillRecord(entry: Record<string, any>): void {
  try {
    fs.mkdirSync(_watchdogLogBase, { recursive: true });
    const d = new Date();
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    fs.appendFileSync(
      path.join(_watchdogLogBase, `${key}-watchdog-kills.ndjson`),
      JSON.stringify({ ts: d.toISOString(), ...entry }) + '\n',
    );
  } catch (err: any) {
    if (!_watchdogLogWarned) {
      _watchdogLogWarned = true;
      logger.warn('claude.watchdog-log.write-failed', {
        dir: _watchdogLogBase,
        error: err?.message || String(err),
      });
    }
  }
}

function streamClaude(
  prompt,
  modelId,
  preset,
  sessionId,
  onChunk,
  onDone,
  onError,
  imageBlocks = [],
  opts: any = {},
  _retryCount = 0
) {
  const { getModelPricing } = require('../models');
  const historySessionId = String(opts.historySessionId || sessionId);

  // --input-format stream-json: always on. Lets us keep stdin open for the
  // lifetime of the spawn so /btw can splice mid-turn JSONL user messages
  // into the running process. The binary applies them at the next turn
  // boundary (after the current tool call settles or text reply finishes).
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json'];
  const hasImages = imageBlocks.length > 0;

  const { resolveClaudeSubscriptionModel } = require('../models');
  const effectiveModel = resolveClaudeSubscriptionModel(modelId || activeModels.llm.model);
  const isExternal = !isClaudeModel(effectiveModel);

  if (!isExternal && effectiveModel && effectiveModel !== activeModels.llm.model) {
    args.push('--model', effectiveModel);
  }

  if (opts.effort && EFFORT_LEVELS.has(opts.effort)) args.push('--effort', opts.effort);
  // --thinking-display summarized: required to surface plaintext thinking on
  // subscription/OAuth tier. Without it the binary emits redacted thinking
  // (empty content + signature only). Allowed values are summarized|omitted;
  // visible/expanded/collapsed are NOT accepted by the CLI. Verified by
  // comparing args against an empty-vs-populated `block.thinking` on
  // claude-opus-4-7 with --effort xhigh on 2026-05-08.
  if (opts.reasoning === 'enabled' || (opts.effort && EFFORT_LEVELS.has(opts.effort))) {
    args.push('--thinking-display', 'summarized');
  }

  if (preset && opts.sysMode === 'replace') {
    args.push('--system-prompt', preset);
  } else if (preset && opts.sysMode === 'append') {
    args.push('--append-system-prompt', preset);
  }

  if (opts.skills?.length) {
    const block = opts.skills.map((s) => `## Skill: ${s.name}\n\n${s.content}`).join('\n\n---\n\n');
    args.push('--append-system-prompt', block);
  }

  const cSid = claudeSessions.get(historySessionId);
  if (cSid) args.push('--resume', cSid);

  const originalPrompt = prompt;
  if (!cSid) {
    const priorHistory = opts.selfEmpId
      ? getHistoryForEmployee(sessionId, opts.selfEmpId)
      : getHistory(historySessionId);
    if (priorHistory.length > 0) {
      const maxTurns = getMaxHistoryTurns();
      const maxChars = getMaxHistoryChars();
      const recentTurns = priorHistory.slice(-maxTurns);
      let ctx = recentTurns
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
      if (ctx.length > maxChars) ctx = ctx.slice(-maxChars);
      prompt = `[Previous conversation context:\n${historyModeNotice()}\n${ctx}\n]\n\n${prompt}`;
    }
  }

  try {
    const { drainBtw, formatBtwInjection } = require('../chat/btw-queue');
    const btwItems = drainBtw(historySessionId);
    if (btwItems.length) prompt = `${prompt}\n\n${formatBtwInjection(btwItems)}`;
  } catch (_) {}

  const env = { ...process.env };
  if (!env.HOME || env.HOME === '/root') env.HOME = os.homedir();
  if (opts.configDir) {
    env.CLAUDE_CONFIG_DIR = opts.configDir;
    const { deriveIsolatedHome } = require('../chat/helpers');
    const home = deriveIsolatedHome(opts.configDir, '.claude');
    if (home) env.HOME = home;
    // Dedicated MCP-only file written by mcp-internal/materialize.ts on bridge
    // start. The binary's --mcp-config rejects/ignores MCPs in files that
    // contain other top-level keys (permissions, theme, etc.), so we point it
    // at this minimal { "mcpServers": {...} } file.
    //
    // Per-spawn override: clone the base file with YHA_SESSION_ID injected
    // into the MCP-Tools env block, so the bridge stub can forward an
    // X-Yha-Session-Id header and bridge tools like AskUser route to the
    // right SSE stream. Falls back to the shared base file when sessionId
    // is missing or the base doesn't exist (e.g. external-sharing off).
    const mcpConfigBase = path.join(opts.configDir, 'mcp-bridge.json');
    let mcpConfigPath = mcpConfigBase;
    if (sessionId && fs.existsSync(mcpConfigBase)) {
      try {
        const base = JSON.parse(fs.readFileSync(mcpConfigBase, 'utf8'));
        const tools = base?.mcpServers?.['MCP-Tools'];
        if (tools) {
          tools.env = { ...(tools.env || {}), YHA_SESSION_ID: String(sessionId) };
        }
        const perSession = path.join(opts.configDir, `mcp-bridge.${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
        fs.writeFileSync(perSession, JSON.stringify(base, null, 2));
        mcpConfigPath = perSession;
      } catch (_) {
        // Fall back to shared base — AskUser won't have session context
        // but other MCP tools still work.
      }
    }
    if (fs.existsSync(mcpConfigPath)) args.push('--mcp-config', mcpConfigPath);
    // In --print mode the binary defaults to MCP_CONNECTION_NONBLOCKING=1, so
    // MCP child processes connect async and tools/list is empty when the model
    // assembles its catalog → MCPs invisible to subscription Claude in
    // streaming mode. Force blocking so the handshake completes first.
    env.MCP_CONNECTION_NONBLOCKING = '0';
  }
  const anthropicProvider = config.providers.find((p) => p.name === 'Anthropic');
  const activeProvider =
    opts.modelProvider ||
    (effectiveModel === activeModels.llm.model ? activeModels.llm.provider : undefined);
  if (anthropicProvider?.api_key && !isSubscriptionModel(effectiveModel, activeProvider)) {
    env.ANTHROPIC_API_KEY = anthropicProvider.api_key;
  } else {
    // Prevent any leaked ANTHROPIC_API_KEY in process.env from overriding OAuth for subscription
    delete env.ANTHROPIC_API_KEY;
  }

  const yoloPermBypass = opts.yoloPermBypass !== false;
  if (yoloPermBypass) {
    args.push('--dangerously-skip-permissions');
  } else if (opts.allowedTools?.length) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }
  // The built-in AskUserQuestion has no IPC path back from --print mode, so
  // the model emits it and the turn dead-ends. Replaced with the bridge
  // virtual tool mcp__MCP-Tools__bridge__AskUser (same schema), which
  // routes through SSE to the chat UI and returns a real tool_result.
  args.push('--disallowedTools', 'AskUserQuestion');

  if (isExternal) {
    env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}/proxy/${encodeURIComponent(effectiveModel)}`;
    if (!env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = BRIDGE_INTERNAL_KEY;
    if (opts.sysMode === 'replace') args.push('--bare');
    for (const dir of getInstalledPluginDirs()) args.push('--plugin-dir', dir);
    if (config.defaults?.useAgents !== false) {
      const agentsJson = loadAgentsJson();
      if (Object.keys(agentsJson).length > 0) args.push('--agents', JSON.stringify(agentsJson));
    }
  }

  const sessionCwd = getSessionCwd(sessionId);
  logRaw(
    'model',
    'in',
    {
      prompt,
      modelId: effectiveModel,
      preset,
      imageBlocks,
      opts,
      cwd: sessionCwd,
      args,
    },
    { provider: 'claude-binary', sessionId, stream: true }
  );

  args.push(
    '--append-system-prompt',
    `WORKING DIRECTORY CONSTRAINT: Your current working directory for this session is "${sessionCwd}". ` +
      `You MUST only read, write, create, or delete files inside "${sessionCwd}". ` +
      `Finding a matching file outside this directory via grep, find, or any search tool does NOT give you permission to touch it. ` +
      `If you believe you need to modify a file outside "${sessionCwd}", you MUST stop and ask the user for explicit permission BEFORE taking any action. ` +
      `Never modify files outside "${sessionCwd}" on your own initiative, even if they appear related or similar. ` +
      `When referencing files without absolute paths, always resolve them relative to "${sessionCwd}". ` +
      `OTHER USERS' DATA: This machine may be shared (e.g. family members on a household PC, separate user accounts on the same OS). ` +
      `You MUST NOT read, list, browse, display, summarize, copy, or otherwise expose the contents of directories belonging to other users — ` +
      `this includes sibling home folders, other accounts' working trees, their photos, videos, documents, downloads, mail, browser data, or any personal files — ` +
      `even if the operating system's file permissions would technically allow access. ` +
      `Treat anything outside this working directory as private to someone else unless the user explicitly references that exact path in their request. ` +
      `If a tool result accidentally surfaces such content, do not relay or summarize it; tell the user and stop.`
  );

  const niceArgs = getNiceness(opts.isInteractive);
  const bin = opts.claudeBin || CLAUDE_BIN;
  logger.info('claude.spawn', { bin, args, configDir: opts.configDir, cwd: sessionCwd });
  const proc = spawn(niceArgs[0], [...niceArgs.slice(1), bin, ...args], {
    env,
    cwd: sessionCwd,
  });
  const spawnedAt = Date.now();

  // Initial-output watchdog. Distinct from the finalize-kill timer below:
  // this fires if the binary spawns but never emits a single chunk on stdout
  // OR stderr (MCP config parse stall, TLS handshake hang, OAuth refresh
  // deadlock). Without it the user sees an indefinite spinner. Cleared on
  // first byte from either stream.
  const STARTUP_TIMEOUT_MS = 60_000;
  let startupTimedOut = false;
  let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    startupTimer = null;
    startupTimedOut = true;
    logger.warn('claude.startup-timeout', { sessionId, timeoutMs: STARTUP_TIMEOUT_MS });
    try { proc.kill('SIGKILL'); } catch (_) {}
  }, STARTUP_TIMEOUT_MS);
  const clearStartupTimer = () => {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
  };

  // Kill any existing process for this session before overwriting
  const existing = activeProcesses.get(sessionId);
  if (existing?.killFn) {
    try { existing.killFn(); } catch (_) {}
  }
  activeProcesses.set(sessionId, {
    killFn: () => {
      try {
        proc.kill('SIGTERM');
      } catch (_) {}
    },
  });
  // Stdin stays OPEN until the first `result` event (or close/error). While
  // open, /btw POSTs route through the liveStdin sink below and become real
  // mid-turn injections instead of next-turn fold-ins.
  let stdinClosed = false;
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    try { proc.stdin.end(); } catch (_) {}
  };
  const { registerLiveStdin, unregisterLiveStdin } = require('../chat/btw-queue');
  const cleanupProc = () => {
    if (activeProcesses.get(sessionId)?.killFn) activeProcesses.delete(sessionId);
    try { unregisterLiveStdin(historySessionId); } catch (_) {}
    clearStartupTimer();
    closeStdin();
  };

  // ── Multi-turn-in-one-spawn state ─────────────────────────────────────
  // Each /btw write to stdin causes the binary to run another turn before
  // exiting. We must accumulate cost/tokens across all turns and only call
  // onDone once (on proc close) — otherwise turn 2's output is "lost" by
  // the consumer that already saw onDone for turn 1.
  //
  // pendingTurns starts at 1 (initial prompt). Each successful sink write
  // increments it, each `result` event decrements. closeStdin fires when
  // it hits 0, at which point the binary processes any tail and exits.
  // pendingUserMsgs queues the user-text for each pending turn so we can
  // pushHistory the right (user, assistant) pair per result.
  let pendingTurns = 1;
  const pendingUserMsgs: string[] = [originalPrompt];
  let accumCost = 0;          // last result's total_cost_usd (cumulative semantic)
  let accumInTokens = 0;       // sum of per-turn input_tokens
  let accumOutTokens = 0;      // sum of per-turn output_tokens
  let accumCacheCreate = 0;    // sum
  let accumCacheRead = 0;      // sum
  let lastResultText = '';
  let lastStopReason = 'end_turn';
  const accumPermDenials = new Map<string, any>();
  let doneCalled = false;
  let errorCalled = false;
  // True once we've seen at least one non-error `result` event. The CLI can
  // succeed on iteration N then exit non-zero on plugin/teardown failure;
  // discarding the work would lose model output the user already paid for.
  let hadResultEvent = false;
  // After the last result we expect, the child should print its final
  // metadata and exit promptly. Some failure modes (TLS teardown hang,
  // OAuth refresh stuck, plugin shutdown deadlock) leave it alive even
  // though we have everything we need to finalize. We finalize early
  // on the result event (see ev.type === 'result' below) and arm this
  // watchdog to force-kill the child if proc.close still hasn't fired
  // ~30 s later, so the stream record + activeProcesses entry don't leak.
  const FINALIZE_KILL_TIMEOUT_MS = 30_000;
  let finalizeKillTimer: ReturnType<typeof setTimeout> | null = null;

  // Initial user message — always JSONL because --input-format=stream-json.
  const initialContent: any[] = [];
  if (prompt.trim()) initialContent.push({ type: 'text', text: prompt });
  for (const img of imageBlocks) initialContent.push(img);
  proc.stdin.write(
    JSON.stringify({ type: 'user', message: { role: 'user', content: initialContent } }) + '\n',
    'utf8'
  );
  // Suppress EPIPE on the stdin pipe — child may close before /btw fires.
  proc.stdin.on('error', () => {});
  registerLiveStdin(historySessionId, (text: string): boolean => {
    if (stdinClosed || !proc.stdin.writable) return false;
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    const formatted = `[User added mid-response: ${trimmed}]`;
    try {
      proc.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: formatted }] },
        }) + '\n',
        'utf8'
      );
    } catch (_) {
      return false;
    }
    // Bookkeeping AFTER the successful write so a thrown write doesn't
    // leave state out of sync. The binary will emit a `result` for this.
    pendingTurns++;
    pendingUserMsgs.push(formatted);
    return true;
  });

  let buf = '';
  let fullText = '';
  const toolNames = new Map();

  proc.stdout.on('data', (d) => {
    clearStartupTimer();
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        continue;
      }
      logRaw('model', 'out', ev, { provider: 'claude-binary', sessionId, stream: true });

      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text') {
            fullText += block.text;
            onChunk({ text: block.text, delta: block.text });
          } else if (block.type === 'thinking') {
            onChunk({ reasoning: block.thinking || '' });
          } else if (block.type === 'tool_use') {
            toolNames.set(block.id, block.name);
            onChunk({ toolUse: { id: block.id, name: block.name, input: block.input } });
          }
        }
      } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type !== 'tool_result') continue;
          const toolResultContent = String(block.content ?? '');
          onChunk({
            toolResult: { id: block.tool_use_id, content: toolResultContent.slice(0, 500) },
          });
          if (
            !yoloPermBypass &&
            PERM_DENIED_PATTERNS.some((pattern) => toolResultContent.includes(pattern))
          ) {
            const deniedName = toolNames.get(block.tool_use_id) || block.tool_use_id || 'unknown';
            if (!accumPermDenials.has(deniedName)) {
              accumPermDenials.set(deniedName, { tool_name: deniedName, tool_input: {} });
              onChunk({ permissionDenials: [...accumPermDenials.values()] });
            }
          }
          const toolName = toolNames.get(block.tool_use_id);
          if (toolName === 'generate_image') {
            try {
              const result = JSON.parse(String(block.content ?? '{}'));
              const pricing = result.model ? getModelPricing(result.model) : null;
              const count = result.images?.length || 1;
              let mediaCost = 0;
              if (pricing?.price_per_image) mediaCost = pricing.price_per_image * count;
              if (mediaCost > 0) onChunk({ cost: mediaCost, mediaCost: true, model: result.model });
            } catch (_) {}
          }
        }
      } else if (ev.type === 'result') {
        // Per-turn result. There may be multiple within one spawn if /btw
        // wrote additional user messages to stdin. Accumulate and only
        // close stdin when we've received as many results as we expect.
        if (ev.session_id) {
          claudeSessions.set(historySessionId, ev.session_id);
          saveIndexToDisk();
        }
        if (ev.is_error) {
          // Errors abort the whole spawn — no more turns will run.
          try { unregisterLiveStdin(historySessionId); } catch (_) {}
          closeStdin();
          if (!errorCalled) {
            errorCalled = true;
            const msg = (typeof ev.result === 'string' && ev.result.trim()) ? ev.result.trim()
              : (typeof ev.error === 'string' && ev.error.trim()) ? ev.error.trim()
              : 'claude returned an error';
            onError(new Error(msg));
          }
          return;
        }
        if (Array.isArray(ev.permission_denials) && ev.permission_denials.length) {
          for (const d of ev.permission_denials) {
            const k = d.tool_name || d.tool_use_id || JSON.stringify(d);
            if (!accumPermDenials.has(k)) accumPermDenials.set(k, d);
          }
          onChunk({ permissionDenials: [...accumPermDenials.values()] });
        }
        // total_cost_usd is cumulative across the conversation in claude
        // code's stream-json output, so the latest result has the running
        // total. Tokens (usage.*) are per-API-call, so we sum them.
        if (typeof ev.total_cost_usd === 'number') accumCost = ev.total_cost_usd;
        accumInTokens += ev.input_tokens || ev.usage?.input_tokens || 0;
        accumOutTokens += ev.output_tokens || ev.usage?.output_tokens || 0;
        accumCacheCreate += ev.usage?.cache_creation_input_tokens || 0;
        accumCacheRead += ev.usage?.cache_read_input_tokens || 0;
        if (ev.stop_reason) lastStopReason = ev.stop_reason;
        lastResultText = ev.result || fullText;
        hadResultEvent = true;
        // Pop the user message that triggered this turn and persist the
        // (user, assistant) pair to history.
        const turnUserMsg = pendingUserMsgs.shift();
        if (turnUserMsg !== undefined) {
          pushHistory(historySessionId, 'user', turnUserMsg);
          pushHistory(historySessionId, 'assistant', ev.result || fullText);
        }
        // Reset fullText so the next turn's text accumulates fresh for
        // any history-fallback inside that turn.
        fullText = '';
        pendingTurns--;
        if (pendingTurns <= 0) {
          try { unregisterLiveStdin(historySessionId); } catch (_) {}
          closeStdin();
          // Finalize as soon as the last expected result is in. Previously
          // we waited for proc.close — if the child hung after the result
          // (TLS teardown / plugin shutdown / OAuth refresh deadlock), the
          // SSE stream stayed open forever and the persisted message kept
          // streaming:true. doneCalled gates the proc.close path so this
          // never double-fires. Arm a watchdog to SIGKILL the child if it
          // also fails to exit so we don't leak the OS process.
          if (!doneCalled && !errorCalled) {
            doneCalled = true;
            logger.info('claude.finalize.on-result', {
              sessionId, historySessionId, stopReason: lastStopReason,
            });
            try {
              onDone({
                text: lastResultText,
                cost: accumCost,
                stopReason: lastStopReason,
                inputTokens: accumInTokens,
                outputTokens: accumOutTokens,
                cacheCreationTokens: accumCacheCreate,
                cacheReadTokens: accumCacheRead,
              });
            } catch (e) {
              logger.warn('claude.finalize.on-result.error', {
                sessionId, error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          if (!finalizeKillTimer) {
            finalizeKillTimer = setTimeout(() => {
              finalizeKillTimer = null;
              const pid = proc.pid;
              const stderrTail = stderrBuf.split('\n').slice(-20).join('\n');
              const cause = _inferKillCause(stderrTail);
              const procStatus = pid ? _readProcStatus(pid) : null;
              const durationMs = Date.now() - spawnedAt;
              _writeWatchdogKillRecord({
                source: 'claude-stream',
                sessionId, historySessionId, modelId,
                pid, durationMs,
                timeoutMs: FINALIZE_KILL_TIMEOUT_MS,
                cause,
                stderrTail,
                procStatus,
              });
              try {
                logger.warn('claude.finalize.kill-watchdog', {
                  sessionId, historySessionId, modelId, pid, durationMs, cause,
                  reason: 'child did not exit within FINALIZE_KILL_TIMEOUT_MS after final result',
                });
                proc.kill('SIGKILL');
              } catch (_) {}
            }, FINALIZE_KILL_TIMEOUT_MS);
            // Don't keep the event loop alive just for this watchdog.
            if (typeof finalizeKillTimer.unref === 'function') finalizeKillTimer.unref();
          }
        }
      }
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => {
    clearStartupTimer();
    const text = d.toString();
    stderrBuf += text;
    logger.error('claude.stderr', { text: text.trim() });
  });
  proc.on('error', (err) => {
    cleanupProc();
    if (!errorCalled) {
      errorCalled = true;
      onError(err);
    }
  });
  proc.on('close', (code) => {
    cleanupProc();
    if (finalizeKillTimer) {
      clearTimeout(finalizeKillTimer);
      finalizeKillTimer = null;
    }
    // Retry on stale resume session — only if no turn produced any output.
    const hadAnyOutput = lastResultText.length > 0 || fullText.length > 0;
    // Forensic log on every close so a stuck session (close fires but onDone
    // never reached) can be diagnosed from logs alone. Records the branch
    // taken plus the state vars that gate it.
    logger.info('claude.proc-close', {
      sessionId,
      historySessionId,
      code,
      hadAnyOutput,
      doneCalled,
      errorCalled,
      pendingTurns,
      lastStopReason,
      lastResultLen: lastResultText.length,
      fullTextLen: fullText.length,
      stderrTail: stderrBuf.slice(-200),
      retryCount: _retryCount,
    });
    if (
      !hadAnyOutput &&
      stderrBuf.includes('No conversation found with session ID') &&
      _retryCount < 1
    ) {
      logger.info('claude.proc-close.branch', { sessionId, branch: 'retry-stale-resume' });
      claudeSessions.delete(historySessionId);
      saveIndexToDisk();
      streamClaude(
        originalPrompt,
        modelId,
        preset,
        sessionId,
        onChunk,
        onDone,
        onError,
        imageBlocks,
        opts,
        _retryCount + 1
      );
      return;
    }
    if (errorCalled) {
      logger.info('claude.proc-close.branch', { sessionId, branch: 'skip-already-errored' });
      return;
    }
    if (!hadAnyOutput) {
      logger.warn('claude.proc-close.branch', { sessionId, branch: 'no-output', code, startupTimedOut });
      const msg = stderrBuf.trim();
      const reason = startupTimedOut
        ? `claude did not produce any output within ${STARTUP_TIMEOUT_MS / 1000}s (startup stalled)`
        : msg || (code !== 0 ? `claude exited ${code}` : 'claude produced no output');
      onError(new Error(reason));
      return;
    }
    // Non-zero exit but we already received a `result` event — model output
    // succeeded, only post-completion cleanup failed (plugin shutdown, TLS
    // teardown, etc.). Log loudly but finalize with the work we have.
    if (code !== 0 && hadResultEvent) {
      logger.warn('claude.proc-close.branch', {
        sessionId,
        branch: 'soft-fail-after-result',
        code,
        stderrTail: stderrBuf.slice(-512),
      });
    }
    if (!doneCalled) {
      logger.info('claude.proc-close.branch', { sessionId, branch: 'done', stopReason: lastStopReason });
      doneCalled = true;
      onDone({
        text: lastResultText,
        cost: accumCost,
        stopReason: lastStopReason,
        inputTokens: accumInTokens,
        outputTokens: accumOutTokens,
        cacheCreationTokens: accumCacheCreate,
        cacheReadTokens: accumCacheRead,
      });
    } else {
      logger.info('claude.proc-close.branch', { sessionId, branch: 'skip-already-done' });
    }
  });
}

module.exports = {
  streamClaude,
};
