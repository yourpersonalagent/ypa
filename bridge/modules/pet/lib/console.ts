// ── Pet-Console — quick-chat backend ─────────────────────────────────────────
// Phase 1.5a of the ContextGenerator pipeline.
//
// What this is
// ────────────
// A "manual console" the user pops by clicking the floating pet. The pet talks
// to the SAME cheap NVIDIA `llama-3.1-8b-instruct` model that powers the
// auto-titler — so every Q&A doubles as a live health-check for the model
// path used by auto-title + categorizer. If the pet stays silent under load
// the user knows the cheap-model lane is broken before the next title slips.
//
// Constraints (from .ContextGenerator.MD §6a — Pet-Quickchat-Console)
// ───────────────────────────────────────────────────────────────────
//   • 1-line user input → 3–5 line answer (we cap at ~80 tokens / ~5 lines).
//   • Independent from chat sessions — keeps no server-side history.
//     Memory of the last few Q&As is the FRONTEND's responsibility (in-memory,
//     5 turns); we just forward the user-supplied transcript on each call.
//   • No streaming — it's a tiny popover, latency is fine and SSE plumbing
//     isn't worth the surface area for a 5-line bubble.
//   • Single-user, no auth carve-outs — sits behind the same authMiddleware
//     as the rest of /v1/.
'use strict';

const crypto = require('crypto');
const logger = require('../../../core/logger');
const {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  resolveSubscriptionProvider,
} = require('../../../providers/core');
const { bridgeRegisters } = require('../../../core/registers/keys');

function _getHarness(id: string) {
  const entry = bridgeRegisters.harnesses.list().find((h: any) => h.id === id);
  if (!entry) throw new Error(`No harness "${id}" available — check bridge/modules.json`);
  return entry as any;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Bumped from 8 s → 30 s on 2026-05-06, then 30 s → 90 s on 2026-05-07:
 *  the cheap NVIDIA lane is FREE but regularly spends 30–60 s in queue under
 *  load (especially on llama-3.1-8b-instruct and the reasoning models).
 *  An aborted pet-console request surfaces as "⚠ NVIDIA took >30 s — try
 *  again", which became the dominant failure mode after we let the user pick
 *  reasoning models from the popover. 90 s gives the cheap lane one full
 *  retry cycle before the user has to re-submit, while still being short
 *  enough that a truly broken provider trips the failure path within the
 *  user's attention span.
 *
 *  The auto-title worker still uses 8 s because it's batch + retried; the pet
 *  is foreground UI where the user EXPECTS to wait when they pick a slow
 *  model. They've already seen the "🤖 model — provider" line in the popover
 *  before submitting, so a long wait isn't surprising. */
const REQUEST_TIMEOUT_MS = 90_000;
/** Hard cap on the number of completion tokens we ask the model for. ~5
 *  lines of natural language sit comfortably under 80 tokens; the bubble
 *  scrolls past that anyway, but capping here saves cents and keeps the
 *  cheap-model lane snappy.
 *
 *  Bumped 90 → 256 on 2026-05-07: when the user picks a reasoning model
 *  (DeepSeek-R1, NVIDIA reasoning lane, Qwen-thinking, etc.) via the 🐾 Pet
 *  Chat popover, the model burns 50–150 tokens on a `<think>` block BEFORE
 *  emitting visible content. With the old 90-token cap the response often
 *  came back empty (`content === ""`), surfacing as the cryptic
 *  "⚠ empty response" string in the bubble. 256 gives reasoning models room
 *  while still keeping the cheap-lane non-reasoning latency under ~1 s. */
const MAX_TOKENS         = 256;
/** History turns we honour from the client. Anything over this is sliced
 *  away — the pet is meant to feel ephemeral, not to grow a context tail. */
const MAX_HISTORY_TURNS  = 5;
/** Hard cap on a single user line so a copy-pasted essay can't stuff the
 *  prompt and blow the latency budget. */
const MAX_INPUT_CHARS    = 600;
/** Hard cap on a remembered assistant line — same reasoning as input. */
const MAX_ANSWER_CHARS   = 800;

/** Hard cap on tool-loop iterations when `caps.tools` is enabled. The pet is
 *  a quick-chat surface — we want it to be able to do a quick "Bash + Read"
 *  combo or a single "WebSearch + summarise", not full agentic flows. The
 *  main chat (tools/agent.ts) uses ~25 iterations; the pet caps at 4 so a
 *  runaway loop can't burn 90 s of NVIDIA timeout × 25 turns. */
const MAX_TOOL_ITER      = 4;
/** When tools are enabled we ALSO bump max_tokens — the model needs room for
 *  the tool_call JSON args AND the eventual visible answer. 256 is enough for
 *  pure-text answers but cramps a tool call that needs to pass a long path or
 *  a multiline command argument. */
const MAX_TOKENS_WITH_TOOLS = 1024;

const SYSTEM_PROMPT =
  'You are YHA Pet — a tiny mascot living next to a chat input box. ' +
  'Speak in 3–5 short lines, friendly and concise, no emoji unless the user uses one first. ' +
  'No markdown headings, no bullet lists longer than 3 items, no code fences unless asked. ' +
  'You can answer factual questions, summarise the user\'s last messages, or just chat. ' +
  'If you do not know, say so in one short line.';

// ── Types ────────────────────────────────────────────────────────────────────

interface HistoryTurn {
  role:   'user' | 'assistant';
  text:   string;
}

/** Per-request override forwarded by the frontend's PetQuickChatSection — the
 *  little 🐾 Pet Chat block in the pet popover lets the user pick a model
 *  separate from the auto-title default. When `model` AND `provider` are both
 *  present and the named provider is configured on the bridge, this overrides
 *  `_resolveProvider()`'s autoTitle/petConsole config lookup for THIS call
 *  only (no persistence on the bridge — the frontend re-sends every turn).
 *
 *  Caps are forwarded for forward-compat (so flipping the pet to an o-series
 *  or Sonnet model can pick up reasoning_effort / thinking later) but the
 *  current cheap-lane chat-completions call ignores them. */
interface AskOverride {
  model?:    string;
  provider?: string;
  caps?: {
    vision?:    boolean;
    reasoning?: 'enabled' | 'disabled' | null;
    tools?:     'on' | 'filter' | false;
  };
}

interface AskRequest {
  input:     string;
  history?:  HistoryTurn[];
  override?: AskOverride;
  /** Optional chat-session id forwarded by the frontend's PetQuickChatSection.
   *  When present, both the user input and the assistant answer are appended
   *  to that session via `pushDisplayMsg()` so the pet conversation actually
   *  persists in the background — the same session shows up in the picker and
   *  can be opened in the main chat for a full transcript view. When absent
   *  the pet remains stateless on the bridge (legacy ephemeral behaviour). */
  sessionId?: string;
}

interface AskResult {
  ok:        boolean;
  answer?:   string;
  error?:    string;
  model?:    string;
  provider?: string;
  tookMs?:   number;
  /** Names of bridge/MCP tools the model executed during this turn (when
   *  `caps.tools` was on). Empty when no tools fired. The frontend renders
   *  this as a small "🔧 Read, Bash" line under the assistant text so the
   *  user can see WHY an answer took longer than usual / which tools the pet
   *  decided to invoke. */
  toolsUsed?: string[];
  /** How many tool-loop iterations we burned. Surfaces in the bubble only
   *  when we hit the `MAX_TOOL_ITER` ceiling so the user knows the answer is
   *  truncated by the safety cap, not by the model giving up. */
  toolIters?: number;
}

// ── Provider lookup ──────────────────────────────────────────────────────────
// Per user request (2026-05-06): the pet uses the SAME provider/model as the
// "Auto Title" preference in System Preferences. Always. There is no
// independent petConsole config — if the auto-title model is misconfigured
// the pet won't work either, which is exactly the live health-check we want
// (the pet doubles as a smoke-test for the cheap-model lane that powers
// titles + categorizer). An optional `defaults.petConsole.model` /
// `defaults.petConsole.provider` is still honoured as an escape hatch for
// power-users who want to point the pet at a different model — but the
// DEFAULT and DOCUMENTED behaviour is "same as Auto Title".

type ResolvedApiProvider = {
  kind:         'api';
  model:        string;
  providerName: string;
  endpoint:     string;
  apiKey?:      string;
};
type ResolvedSubProvider = {
  kind:         'subscription';
  subKind:      'claude' | 'codex';
  model:        string;
  providerName: string;
  instance:     any;
};
type ResolveResult = ResolvedApiProvider | ResolvedSubProvider | { error: string };

function _resolveProvider(reqOverride?: { model?: string; provider?: string }): ResolveResult {
  const { config } = require('../../../core/state');
  const autoTitleCfg = config.defaults?.autoTitle || {};
  const petCfgOverride = config.defaults?.petConsole || {};
  // Resolution priority (highest → lowest):
  //   1. Per-request override from the frontend's PetQuickChatSection
  //      (yha.pet.chat.model in localStorage). This is what makes the pet
  //      use a DIFFERENT model than auto-title without touching server config.
  //   2. config.defaults.petConsole.{model,provider} — admin-side override.
  //   3. config.defaults.autoTitle.{model,provider} — the documented default
  //      ("pet uses the same lane as auto-title, doubling as a smoke-test").
  //   4. Hard-coded NVIDIA llama-3.1-8b-instruct fallback.
  const useReqOverride =
    !!reqOverride &&
    typeof reqOverride.model === 'string' &&
    typeof reqOverride.provider === 'string' &&
    reqOverride.model.length > 0 &&
    reqOverride.provider.length > 0;
  const useCfgOverride =
    typeof petCfgOverride.model === 'string' &&
    typeof petCfgOverride.provider === 'string' &&
    petCfgOverride.model.length > 0 &&
    petCfgOverride.provider.length > 0;

  let model: string;
  let providerName: string;
  if (useReqOverride) {
    model        = reqOverride!.model!;
    providerName = reqOverride!.provider!;
  } else if (useCfgOverride) {
    model        = petCfgOverride.model;
    providerName = petCfgOverride.provider;
  } else {
    model        = autoTitleCfg.model    || 'meta/llama-3.1-8b-instruct';
    providerName = autoTitleCfg.provider || 'NVIDIA';
  }

  // Subscription providers (Anthropic-SUB*, OpenAI-SUB*) are synthetic per-
  // instance names minted by bridge/providers/core.ts:_claudeInstanceProviderName.
  // They never appear in config.providers[] — instead they map to entries in
  // config.defaults.claudeInstances[] / codexInstances[]. Resolve via
  // resolveSubscriptionProvider() and return a subscription-shaped result so
  // ask() can route through the harness (claude-binary / codex) instead of the
  // chat-completions REST path.
  if (isClaudeSubscriptionProvider(providerName) || isCodexSubscriptionProvider(providerName)) {
    const sub = resolveSubscriptionProvider(providerName);
    if (!sub) {
      return { error: `pet model provider "${providerName}" not configured — set the matching instance under System Preferences › Subscriptions or pick a different model in the 🐾 Pet Chat popover` };
    }
    return { kind: 'subscription', subKind: sub.kind, model, providerName: sub.providerName, instance: sub.instance };
  }

  const provider = (config.providers || []).find((p: any) => p.name === providerName);
  if (!provider) {
    // Slightly different error copy when the failing name came from the
    // request override — points the user at the pet popover rather than
    // System Preferences.
    if (useReqOverride) {
      return { error: `pet model provider "${providerName}" not configured — pick a different model in the 🐾 Pet Chat popover or remove the override` };
    }
    return { error: `provider "${providerName}" not configured (set under System Preferences › Auto Title)` };
  }
  if (!provider.endpoint) return { error: `provider "${providerName}" has no endpoint configured` };
  return {
    kind:     'api',
    model,
    providerName,
    endpoint: provider.endpoint,
    apiKey:   provider.api_key,
  };
}

// ── Response extraction ──────────────────────────────────────────────────────
// The cheap-lane pet endpoint accepts whatever model the user picks in the
// 🐾 Pet Chat popover, which means we sometimes hit reasoning models or
// inline-thinking models whose response shape differs from a plain
// chat-completions reply:
//
//   • OpenAI/NVIDIA non-reasoning: choices[0].message.content = "Hi!"
//   • DeepSeek-R1, NVIDIA reasoning, Qwen-thinking:
//        content = "" or null,
//        reasoning_content = "…long chain-of-thought… Final: Hi!"
//   • Models with inline thinking (some OSS llamas):
//        content = "<think>\n …thoughts… \n</think>\nHi!"
//   • Tool-capable models when asked "what tools do you have":
//        content = null, tool_calls = [{function: {name: "list_tools", …}}]
//
// We try each fallback in order and only return "empty response" when ALL
// of them are blank. The error path also includes a short snippet of the
// raw response so the user (and logs) see WHY it was empty.

function _stripThinkBlocks(s: string): string {
  // Strip <think>…</think> AND <thinking>…</thinking> blocks (multiline,
  // greedy match across the block but minimal across blocks). Models that
  // didn't fully close the tag (truncated by max_tokens) get the trailing
  // "<think>… [no closer]" snipped too — better an empty content than
  // surfacing raw chain-of-thought to the user.
  return s
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
}

function _extractAnswer(json: any): { text: string; kind: 'content' | 'reasoning' | 'tools' } | null {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return null;

  // 1. Normal content path — strip <think> blocks first so a model that
  //    inline-thinks doesn't leak the chain-of-thought into the bubble.
  const rawContent = typeof msg.content === 'string' ? msg.content : '';
  const cleanContent = _stripThinkBlocks(rawContent);
  if (cleanContent) return { text: cleanContent, kind: 'content' };

  // 2. Reasoning-model fallback — surface the chain-of-thought tail since
  //    that's all we got. Better something than "empty response", and the
  //    user can see whether to switch to a non-reasoning model.
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (reasoning.trim()) {
    // Take just the last ~3 sentences so the bubble doesn't get a wall of CoT.
    const tail = reasoning.trim().split(/(?<=[.!?])\s+/).slice(-4).join(' ').trim();
    return { text: `(reasoning) ${tail || reasoning.trim().slice(-400)}`, kind: 'reasoning' };
  }

  // 3. Tool-call fallback — the cheap-lane call doesn't pass `tools` to the
  //    upstream endpoint, but some models will still emit a tool_call for
  //    questions like "what tools do you have". Render it as a readable line
  //    instead of dropping it on the floor.
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  if (toolCalls.length) {
    const names = toolCalls
      .map((tc: any) => tc?.function?.name || tc?.name)
      .filter(Boolean)
      .slice(0, 3);
    if (names.length) {
      return {
        text: `The model wanted to call tools (${names.join(', ')}) — the pet quick-chat lane doesn't forward tools; use the main chat for that.`,
        kind: 'tools',
      };
    }
  }

  return null;
}

// ── Session persistence ──────────────────────────────────────────────────────
// When the user picks a session in the 🐾 Pet Chat popover, the pet's chat
// runs as a real background session: every Q&A is appended via the same
// pushDisplayMsg() that the main chat uses. Failures here are non-fatal —
// the bubble still shows the live answer; we just log and move on.

function _persistTurn(sessionId: string, role: 'user' | 'assistant', text: string, meta?: Record<string, unknown>): void {
  try {
    const sessions = require('../../../sessions-internal');
    if (typeof sessions.pushDisplayMsg !== 'function') return;
    sessions.pushDisplayMsg(sessionId, role, text, undefined, meta);
  } catch (e) {
    logger.warn('pet-console.persist-failed', {
      sessionId,
      role,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Core ask ─────────────────────────────────────────────────────────────────

async function ask(req: AskRequest): Promise<AskResult> {
  const t0 = Date.now();
  const input = String(req?.input || '').trim().slice(0, MAX_INPUT_CHARS);
  if (!input) return { ok: false, error: 'empty input' };

  // Pull through the per-request override (set by PetQuickChatSection in the
  // frontend). When absent, _resolveProvider() falls back to the configured
  // petConsole / autoTitle pair as before.
  const reqOverride = req?.override
    ? { model: req.override.model, provider: req.override.provider }
    : undefined;
  const resolved = _resolveProvider(reqOverride);
  if ('error' in resolved) {
    logger.warn('pet-console.no-provider', { error: resolved.error });
    return { ok: false, error: resolved.error };
  }

  // Sanitise + clamp history. Drop empty turns; trim each. The newest turns
  // are the most useful — keep the tail.
  const rawHist = Array.isArray(req?.history) ? req.history : [];
  const cleanHist: HistoryTurn[] = [];
  for (const t of rawHist.slice(-MAX_HISTORY_TURNS * 2)) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
    const text = String(t.text || '').trim();
    if (!text) continue;
    cleanHist.push({
      role: t.role,
      text: text.slice(0, t.role === 'user' ? MAX_INPUT_CHARS : MAX_ANSWER_CHARS),
    });
  }

  // Subscription routing branch — Claude/Codex SUB providers can't use the
  // chat-completions REST path (no API endpoint, OAuth-only). Route through
  // the same binary harness the main chat uses, pinned to the picked instance
  // via configDir / claudeBin / codexBin. Tool dispatch is owned by the
  // binary (via the materialized mcp-bridge.json), so the pet's caps.tools
  // toggle is a no-op here — the binary either has MCP tools (when external
  // sharing is on) or it doesn't.
  if (resolved.kind === 'subscription') {
    return _askSubscription(req, resolved, input, cleanHist, t0);
  }

  // ── Tool support gating ────────────────────────────────────────────────
  // The pet's caps.tools toggle (in the 🐾 Pet Chat popover) decides whether
  // we forward bridge + MCP tool defs to the upstream call:
  //
  //   • 'on'     → full bridge + MCP tool list + system-prompt augmentation
  //   • 'filter' → same as 'on' for now; later we'll honour the user's
  //                per-tool filter from the main-chat tools tab
  //   • false / absent → no tools (legacy cheap-lane behaviour)
  //
  // When tools are off we keep the SHORT system prompt + 256-token cap that
  // make the cheap-lane pet feel snappy. When tools are on we relax both —
  // the model needs room to emit tool_call JSON and the prompt needs to know
  // it CAN call tools (otherwise it answers "I don't have tools" even when
  // we hand it the tool list).
  const capsTools = req?.override?.caps?.tools;
  const toolsEnabled = capsTools === 'on' || capsTools === 'filter';
  const maxTokens   = toolsEnabled ? MAX_TOKENS_WITH_TOOLS : MAX_TOKENS;
  const systemPrompt = toolsEnabled
    ? SYSTEM_PROMPT +
      '\n\nYou have access to the YHA bridge tools (Read, Write, Edit, Bash, Glob, Grep, ' +
      'WebFetch, WebSearch, RunCode, TodoWrite, TodoRead) and any running MCP-server tools. ' +
      'Use them when they would actually help — e.g. read a file, run a quick shell command, ' +
      'search the web — and keep the final answer to 3–5 short lines as usual. Do NOT call ' +
      'long-running or destructive operations without an obvious reason.'
    : SYSTEM_PROMPT;

  const messages: Array<any> = [
    { role: 'system', content: systemPrompt },
  ];
  for (const t of cleanHist) messages.push({ role: t.role, content: t.text });
  messages.push({ role: 'user', content: input });

  // Lazy-required only when needed (heavy module — pulls in the MCP registry).
  // Hoisted out of the loop body so we only resolve it once.
  let toolDefs: any[] | undefined;
  if (toolsEnabled) {
    try {
      const { getBridgeToolDefs } = require('../../../tools/defs');
      // audience: 'pet' — the pet IS the audience that can see pet-only
      // MCPs (currently pet-vision). The main chat / harnesses default to
      // 'main' and never see them. See bridge/modules/pet/lib/mcp-audience.ts.
      toolDefs = getBridgeToolDefs({ audience: 'pet' });
    } catch (e) {
      logger.warn('pet-console.tool-defs-load-failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      toolDefs = undefined;
    }
  }

  // Resolve the session cwd ONCE — `executeBridgeTool` needs it for Bash,
  // Glob, Grep, RunCode etc. so they actually run in the user's chosen
  // session directory. If no pet session is set we fall back to the bridge's
  // process.cwd() (executor handles that internally).
  const sessionId = typeof req?.sessionId === 'string' ? req.sessionId.trim() : '';
  let toolCwd: string | undefined;
  if (toolsEnabled && sessionId) {
    try {
      const sessions = require('../../../sessions-internal');
      if (typeof sessions.getSessionCwd === 'function') {
        toolCwd = sessions.getSessionCwd(sessionId);
      }
    } catch { /* non-fatal — falls back to process.cwd() in executor */ }
  }

  // Lazy-import the executor too — avoids loading MCP/exec machinery for
  // tools-disabled cheap-lane requests.
  let executeBridgeTool: ((name: string, input: any, cwd?: string, modelId?: string) => Promise<any>) | undefined;
  if (toolsEnabled) {
    try {
      const exec = require('../../../tools/exec');
      executeBridgeTool = exec.executeBridgeTool;
    } catch (e) {
      logger.warn('pet-console.executor-load-failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const ac    = new AbortController();
  let   timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new Error(`upstream slow (>${REQUEST_TIMEOUT_MS / 1000} s)`));
  }, REQUEST_TIMEOUT_MS);
  const url = resolved.endpoint.replace(/\/$/, '') + '/chat/completions';
  // ── Rate limiter (Phase 1.10) ──────────────────────────────────────────
  // The pet shares the bucket with auto-title + categorizer, so a busy
  // pipeline doesn't get jumped by a chatty user (and vice versa).
  const rateLimiter = require('../../../core/rate-limiter');

  // Track tools the model actually called across the loop iterations so
  // we can surface them to the bubble.
  const toolsUsed: string[] = [];

  try {
    // ── Tool-loop: 1 iteration when tools are off (legacy path), up to
    // ── MAX_TOOL_ITER iterations when caps.tools is on. The loop ALWAYS
    // ── exits after a non-tool-call message — we never time-loop without
    // ── progress.
    const maxIter = toolsEnabled && toolDefs && toolDefs.length ? MAX_TOOL_ITER : 1;
    let iter = 0;
    let lastJson: any = null;
    let lastExtract: { text: string; kind: 'content' | 'reasoning' | 'tools' } | null = null;
    while (iter < maxIter) {
      iter++;
      const requestBody: any = {
        model:       resolved.model,
        messages,
        stream:      false,
        max_tokens:  maxTokens,
        temperature: 0.5,
      };
      if (toolsEnabled && toolDefs && toolDefs.length) {
        requestBody.tools       = toolDefs;
        requestBody.tool_choice = 'auto';
      }
      const { response: resp } = await rateLimiter.withRateLimit(
        resolved.providerName,
        () => fetch(url, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}),
          },
          body:   JSON.stringify(requestBody),
          signal: ac.signal,
        }),
        { signal: ac.signal },
      );
      if (!resp.ok) {
        clearTimeout(timer);
        const bodyText = await resp.text().catch(() => '');
        logger.warn('pet-console.upstream-error', {
          status: resp.status,
          body:   bodyText.slice(0, 200),
          iter,
        });
        return { ok: false, error: `upstream ${resp.status}` };
      }
      const json: any = await resp.json();
      lastJson = json;
      const msg = json?.choices?.[0]?.message;

      // If the model emitted tool_calls AND tools are enabled, execute them
      // and feed the results back. This is the inner agent loop — same shape
      // as tools/agent.ts but with the pet's tighter caps.
      const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      if (toolsEnabled && executeBridgeTool && toolCalls.length > 0) {
        // Append the assistant turn (with tool_calls) verbatim — required by
        // OpenAI tool-loop protocol for the next round to be valid.
        messages.push(msg);
        const results = await Promise.all(
          toolCalls.map(async (tc: any) => {
            const name = tc?.function?.name || tc?.name || 'unknown';
            toolsUsed.push(name);
            let toolInput: any = {};
            try { toolInput = JSON.parse(tc?.function?.arguments || '{}'); }
            catch { /* malformed args — pass empty so the executor returns its own error */ }
            try {
              const result = await executeBridgeTool!(name, toolInput, toolCwd, resolved.model);
              const text = typeof result === 'string'
                ? result
                : Array.isArray(result)
                  ? result.map((b: any) => b?.text || '').join('\n')
                  : JSON.stringify(result);
              return {
                role:         'tool',
                tool_call_id: tc.id,
                content:      String(text).slice(0, 4000), // bound the per-tool result so a 1MB Bash output doesn't blow the next prompt
              };
            } catch (e) {
              return {
                role:         'tool',
                tool_call_id: tc.id,
                content:      `Tool error: ${e instanceof Error ? e.message : String(e)}`,
              };
            }
          }),
        );
        messages.push(...results);
        // Loop continues — the model gets the tool results and (usually)
        // produces a final natural-language answer next round.
        continue;
      }

      // No tool calls (or tools disabled) — try to extract a real answer.
      lastExtract = _extractAnswer(json);
      break;
    }
    clearTimeout(timer);

    if (!lastExtract) {
      // Same diagnostic + friendly-error path as before — log message shape
      // and surface a reason the user can act on.
      const msg = lastJson?.choices?.[0]?.message;
      const finishReason = lastJson?.choices?.[0]?.finish_reason;
      logger.warn('pet-console.empty-response', {
        model:         resolved.model,
        provider:      resolved.providerName,
        finishReason,
        contentLen:    typeof msg?.content === 'string' ? msg.content.length : -1,
        reasoningLen:  typeof msg?.reasoning_content === 'string' ? msg.reasoning_content.length : -1,
        toolCallCount: Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0,
        keys:          msg ? Object.keys(msg) : null,
        toolsUsed,
        iters:         iter,
      });
      // Special-case: tools enabled, max iters reached, last turn STILL
      // wanted to call a tool — the model is stuck looping. Tell the user.
      if (toolsEnabled && iter >= MAX_TOOL_ITER) {
        return {
          ok:    false,
          error: `${resolved.model} hit the ${MAX_TOOL_ITER}-tool-call cap without a final answer (used: ${toolsUsed.join(', ') || 'none'}) — pick a more decisive model or disable ⚙ tools in 🐾 Pet Chat`,
          toolsUsed,
          toolIters: iter,
        };
      }
      const reason =
        finishReason === 'length'
          ? `${resolved.model} ran out of tokens before producing visible text — try a non-reasoning model in 🐾 Pet Chat`
          : finishReason === 'tool_calls'
            ? `${resolved.model} tried to call a tool but tools are disabled — enable ⚙ in 🐾 Pet Chat`
            : `${resolved.model} returned no content (finish=${finishReason || 'unknown'}) — try a different model in 🐾 Pet Chat`;
      return { ok: false, error: reason, toolsUsed };
    }

    const answer = lastExtract.text.slice(0, MAX_ANSWER_CHARS);
    const tookMs = Date.now() - t0;
    logger.info('pet-console.answered', {
      model:     resolved.model,
      provider:  resolved.providerName,
      kind:      lastExtract.kind,
      inLen:     input.length,
      outLen:    answer.length,
      histTurns: cleanHist.length,
      toolsUsed: toolsUsed.length ? toolsUsed : undefined,
      iters:     iter,
      tookMs,
    });
    // ── Persist to the user-selected pet session (when one was provided)
    // ── so the conversation actually survives a page reload and shows up in
    // ── the session picker. Non-fatal on failure — the bubble already has
    // ── the live answer; persistence is a side-effect.
    if (sessionId) {
      _persistTurn(sessionId, 'user', input, { source: 'pet-console' });
      _persistTurn(sessionId, 'assistant', answer, {
        source:    'pet-console',
        model:     resolved.model,
        provider:  resolved.providerName,
        kind:      lastExtract.kind,
        toolsUsed: toolsUsed.length ? toolsUsed : undefined,
      });
    }
    return {
      ok:        true,
      answer,
      model:     resolved.model,
      provider:  resolved.providerName,
      tookMs,
      toolsUsed: toolsUsed.length ? toolsUsed : undefined,
      toolIters: iter,
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    // Re-label aborts so the bubble shows something the user can act on
    // ("upstream slow" → user knows it's a network/queue issue, not a bug
    // in the pet code itself).
    const friendly = timedOut
      ? `${resolved.providerName} took >${REQUEST_TIMEOUT_MS / 1000} s — try again`
      : msg;
    logger.warn('pet-console.error', { error: msg, timedOut, toolsUsed });
    return { ok: false, error: friendly, toolsUsed };
  }
}

// ── Subscription routing — Claude / Codex binary via harness register ───────
// The chat-completions REST path can't reach a subscription model (no API
// endpoint, OAuth lives in the binary's CLAUDE_CONFIG_DIR). Mirror what the
// main-chat OpenAI-internal proxy + multichat runner do: flatten the pet's
// in-memory history into a single prompt and hand it to the harness with
// configDir / claudeBin / modelProvider pinned to the picked instance.
//
// Why not pass the real pet sessionId positionally to streamClaude:
//   1. streamClaude does `activeProcesses.set(sessionId, killFn)` which would
//      kill any main-chat process running on the same session.
//   2. It writes `claudeSessions.set(historySessionId, ev.session_id)` — the
//      next main-chat turn would --resume the pet's mini-conversation.
//   3. pushHistory(historySessionId, ...) would leak pet turns into the
//      session's history that main chat re-injects on the next turn.
// So we use a per-call synthetic sessionId for the spawn. The pet's own
// session-level persistence (pushDisplayMsg via _persistTurn) still uses the
// real sessionId so the conversation shows up in the picker.

function _flattenHistoryForBinary(history: HistoryTurn[], input: string): string {
  if (!history.length) return input;
  const ctx = history
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
  return `[Previous conversation:\n${ctx}\n]\n\n${input}`;
}

function _askSubscription(
  req:      AskRequest,
  resolved: ResolvedSubProvider,
  input:    string,
  cleanHist: HistoryTurn[],
  t0:       number,
): Promise<AskResult> {
  const sessionId = typeof req?.sessionId === 'string' ? req.sessionId.trim() : '';
  const prompt = _flattenHistoryForBinary(cleanHist, input);
  const synthSessionId = `pet-sub-${crypto.randomBytes(6).toString('hex')}`;
  const inst = resolved.instance || {};

  return new Promise<AskResult>((resolve) => {
    const { activeProcesses } = require('../../../core/state');
    let buffered = '';
    let resolved2 = false;
    const finalize = (result: AskResult) => {
      if (resolved2) return;
      resolved2 = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { activeProcesses.get(synthSessionId)?.killFn?.(); } catch { /* ignore */ }
      logger.warn('pet-console.sub.timeout', {
        provider: resolved.providerName, model: resolved.model, timeoutMs: REQUEST_TIMEOUT_MS,
      });
      finalize({
        ok: false,
        error: `${resolved.providerName} took >${REQUEST_TIMEOUT_MS / 1000} s — try again`,
      });
    }, REQUEST_TIMEOUT_MS);

    const onChunk = (c: any) => {
      // streamClaude emits {text, delta} for text blocks; streamCodex emits
      // {delta} only. Both forms accumulate into buffered.
      if (typeof c?.delta === 'string') buffered += c.delta;
      else if (typeof c?.text === 'string') buffered += c.text;
      // reasoning / toolUse / toolResult are dropped — pet bubble is text only.
    };
    const onDone = (d: any) => {
      const raw = (d?.text && typeof d.text === 'string' && d.text.trim()) ? d.text : buffered;
      const cleaned = _stripThinkBlocks(String(raw || ''));
      const answer = cleaned.slice(0, MAX_ANSWER_CHARS);
      const tookMs = Date.now() - t0;
      logger.info('pet-console.sub.answered', {
        model: resolved.model, provider: resolved.providerName,
        subKind: resolved.subKind, inLen: input.length, outLen: answer.length,
        histTurns: cleanHist.length, tookMs,
      });
      if (!answer) {
        finalize({
          ok: false,
          error: `${resolved.model} returned no content via ${resolved.providerName} — try a different model in 🐾 Pet Chat`,
        });
        return;
      }
      if (sessionId) {
        _persistTurn(sessionId, 'user', input, { source: 'pet-console' });
        _persistTurn(sessionId, 'assistant', answer, {
          source: 'pet-console', model: resolved.model, provider: resolved.providerName, kind: 'content',
        });
      }
      finalize({
        ok: true,
        answer,
        model: resolved.model,
        provider: resolved.providerName,
        tookMs,
      });
    };
    const onError = (err: Error) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('pet-console.sub.error', {
        provider: resolved.providerName, model: resolved.model, error: msg,
      });
      finalize({ ok: false, error: msg });
    };

    try {
      if (resolved.subKind === 'claude') {
        // modelProvider drives streamClaude's env-key clearing: when it
        // matches a SUB label the spawned binary's ANTHROPIC_API_KEY is
        // deleted so OAuth is used instead of the (possibly empty) API key.
        const claudeOpts = {
          sysMode:        'append',
          modelProvider:  resolved.providerName,
          configDir:      inst.configDir,
          claudeBin:      inst.claudeBin,
          yoloPermBypass: true,
          historySessionId: synthSessionId,
        };
        _getHarness('claude-binary').stream(
          prompt, resolved.model, SYSTEM_PROMPT, synthSessionId,
          onChunk, onDone, onError, [], claudeOpts,
        );
      } else {
        // Codex SUB: streamCodex uses codexConfigDir to set CODEX_HOME, and
        // codexBin to override the binary path. No env-clearing equivalent
        // is needed — Codex auth is keyed off CODEX_HOME alone.
        const codexOpts = {
          sysMode:          'append',
          codexConfigDir:   inst.configDir,
          codexBin:         inst.codexBin,
          historySessionId: synthSessionId,
        };
        // Codex models in the picker carry the "codex/" prefix; the harness
        // strips it internally. Pass through whatever the picker gave us.
        _getHarness('codex').stream(
          prompt, resolved.model, '', synthSessionId,
          onChunk, onDone, onError, codexOpts,
        );
      }
    } catch (e) {
      onError(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ── Health snapshot — surfaced on the GET status endpoint ────────────────────

function getStatus(): {
  configured: boolean;
  model:      string | null;
  provider:   string | null;
  reason?:    string;
} {
  const r = _resolveProvider();
  if ('error' in r) return { configured: false, model: null, provider: null, reason: r.error };
  if (r.kind === 'subscription') {
    return { configured: !!(r.instance?.configDir), model: r.model, provider: r.providerName };
  }
  return { configured: !!r.apiKey, model: r.model, provider: r.providerName };
}

module.exports = { ask, getStatus };
