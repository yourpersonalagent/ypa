// ── Auto-title worker ─────────────────────────────────────────────────────────
// Generates AI session titles in the background using a fast/cheap model.
//
// Architecture
// ─────────────
//   • A 3-minute watchdog checks every tick whether a process is already active.
//   • If the process is idle and there is work to do → it starts the process.
//   • If the process is still running when the watchdog fires → it waits another
//     3 minutes (no duplicate runs, ever).
//   • The process loops through untitled sessions in batches of 5 (sorted by
//     most-recently-updated first), restarting immediately after each batch until
//     no eligible sessions remain — then exits cleanly.
//   • Transient failures (network, model error, invalid title) are skipped for
//     the rest of the current run and retried at the next watchdog cycle.
//   • Sessions explicitly renamed by the user (_nameSource === 'user') are
//     never touched. Sessions already AI-titled (_nameSource === 'ai') are
//     skipped as well.
'use strict';

const logger = require('../../core/logger');

// ── Local types ───────────────────────────────────────────────────────────────
type Msg = { role: string; text?: string; content?: unknown; blocks?: Array<{ type: string; content?: string; name?: string; detail?: string }> };

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE        = 5;
const POLL_INTERVAL_MS  = 3 * 60 * 1_000; // watchdog cadence: 3 minutes
const TITLE_TIMEOUT_MS  = 8_000;           // per-request abort threshold

// ── Stuck-session escape hatch (added 2026-05-06 per user report) ─────────────
// Some sessions (e.g. ones whose first user turn is itself a request to
// "read these files" or whose only assistant message is an `API Error: …`
// stub from a failed import) cause the model to keep returning content that
// the validator rejects ("error", < 3 chars, etc.). Without escape, these
// sessions stay in `pendingCount` forever and *block the rest of the
// pipeline* — the categorizer + sorter both gate on `isClear()`.
//
// After `MAX_TITLE_ATTEMPTS` consecutive failures we promote the session to
// a `fallback` source: keep whatever name it currently has (usually the
// first user-message excerpt) and mark `_nameSource = 'fallback'`. This is
// recognised by `_getNextBatch` as "do not retry" so the session stops
// blocking the gate. The user can still rename it manually any time. A
// `Force-retry stuck` action (route below) resets the counter for the user
// to ask the model again.
const MAX_TITLE_ATTEMPTS = 3;

// ── Content extraction ────────────────────────────────────────────────────────
// Strategy: start (400 chars) + middle (200 chars) + end (300 chars).
// Below the combined threshold the full text is used verbatim.

// Strip Claude Code IDE / system metadata wrappers that dominate the start
// of a session and starve the title generator of real signal. Bucket
// analysis 2026-05-10 found these wrappers caused multichat sessions to
// time out because the model couldn't find a topic in the meta-text.
const _META_TAGS_TITLER = [
  'ide_selection', 'ide_opened_file', 'system-reminder',
  'command-name', 'command-message', 'task-notification', 'persisted-output',
  'environment_details', 'user-prompt-submit-hook',
];
const _STRIP_RX_TITLER = new RegExp(
  `<(?:${_META_TAGS_TITLER.join('|')})\\b[^>]*>[\\s\\S]*?</(?:${_META_TAGS_TITLER.join('|')})>`,
  'gi',
);
const _STRIP_OPEN_RX_TITLER = new RegExp(
  `<(?:${_META_TAGS_TITLER.join('|')})\\b[^>]*/?>`,
  'gi',
);
function _stripWrappers(t: string): string {
  return t.replace(_STRIP_RX_TITLER, ' ').replace(_STRIP_OPEN_RX_TITLER, ' ').replace(/\s+/g, ' ').trim();
}

// Multi-agent orchestrator scaffolding. The mc-multichat sessions interleave
// `PLAN:`/`CRITIQUE:`/`VOTE:`/`CHANGE:`/`RESEARCH:` self-coordination
// messages with the real reply. Without filtering, the LLM sees only the
// scaffold (which has no topic) and times out — so we drop scaffold
// messages from the titling/categorizing input. The actual user-visible
// reply is whatever isn't scaffolded. Bucket analysis 2026-05-10.
const _SCAFFOLD_RX = /^\s*(?:plan|critique|vote|change|research|review|consensus|verdict)\s*[:.\-]/i;
function _isScaffoldText(t: string): boolean {
  return _SCAFFOLD_RX.test(t);
}

function _extractContent(s: any): string {
  const START  = 400;
  const MIDDLE = 200;
  const END    = 300;

  const parts: string[] = [];
  for (const msg of s.messages || []) {
    if (msg.role === 'note') continue;
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    let text: string = msg.text || '';
    if (!text && Array.isArray(msg.blocks)) {
      text = msg.blocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.content || '')
        .join(' ');
    }
    const trimmed = _stripWrappers(text);
    if (!trimmed) continue;
    // Drop orchestrator scaffolding from multi-agent sessions so the LLM
    // sees the real reply, not the PLAN:/CRITIQUE: meta-coordination that
    // dominates the first 1–2 assistant turns.
    if (msg.role === 'assistant' && _isScaffoldText(trimmed)) continue;
    parts.push(`${role}: ${trimmed}`);
  }

  const full  = parts.join('\n');
  const TOTAL = START + MIDDLE + END;
  if (full.length <= TOTAL) return full;

  const start  = full.slice(0, START);
  const midAt  = Math.floor((full.length - MIDDLE) / 2);
  const middle = full.slice(midAt, midAt + MIDDLE);
  const end    = full.slice(-END);
  return `${start}\n[...]\n${middle}\n[...]\n${end}`;
}

// ── Title validation ──────────────────────────────────────────────────────────
// Strips surrounding quotes, enforces length bounds, rejects known error phrases.
// Returns the cleaned title or null if it should be rejected.

// ── Title cleanup + validation ────────────────────────────────────────────────
// Rebuilt 2026-05-06 after diagnosing why four sessions stayed pending forever:
//   • The model frequently truncates at max_tokens mid-second-line (e.g. the
//     full output was "github / git source-control panel\nDetects git repos…",
//     and the OLD validator rejected the whole 116-char blob as too-long even
//     though the first line was a perfectly fine 33-char title).
//   • The OLD `'error'` / `'failed'` BAD-prefix bans rejected genuinely
//     descriptive titles for failed-import sessions (e.g. the model legitimately
//     answered "Failed API Connection Prevents File Retrieval" — a useful
//     description of a session whose only assistant turn was an ECONNRESET stub).
// New behaviour:
//   • Take the first non-empty line — most "explanation after title" cases die.
//   • Strip "Title:" / "Here is the title:" / quotes / trailing punctuation.
//   • Restrict the BAD list to *unambiguous* model-refusals (apologies, "I cannot",
//     literal "undefined" / "null"). `'error'` and `'failed'` are NOT refusals
//     when they describe the conversation faithfully.
//   • Return both the title AND a reason string when rejected, so the debug
//     endpoint can show the user exactly *why* a session is stuck.
function _validateTitleEx(raw: string): { title: string | null; reason?: string } {
  if (!raw || typeof raw !== 'string') return { title: null, reason: 'empty-response' };
  // Take the first non-empty line — handles the max_tokens-mid-line case and
  // any "Here is your title:\n<title>" templating in one shot.
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  // Strip "Title:" / "Here's the title:" / "Here is a title:" prefixes.
  let cleaned = firstLine.replace(
    /^(?:title|name|here(?:'s| is)?\s+(?:the|a|your)?\s*(?:title|name)?)\s*[:\-—]\s*/i,
    '',
  );
  // Strip surrounding quotes (multiple kinds, possibly nested).
  cleaned = cleaned.replace(/^["'`«»“”‚‘]+|["'`«»“”‚‘]+$/g, '').trim();
  // Strip trailing sentence punctuation that some models add ("Title.", "Title!").
  cleaned = cleaned.replace(/[.!?,;:]+$/, '').trim();

  if (cleaned.length < 3)  return { title: null, reason: 'too-short' };
  if (cleaned.length > 70) return { title: null, reason: 'too-long' };

  const lower = cleaned.toLowerCase();
  // ONLY unambiguous model refusals — phrases that mean "I will not / cannot
  // generate a title". `'error'` and `'failed'` are legitimate descriptors and
  // were removed from this list.
  const BAD = ['sorry i', 'i cannot', "i can't", 'i am sorry', 'i apologize',
               'undefined', 'null', 'please provide', 'no content'];
  for (const p of BAD) {
    if (lower.startsWith(p)) return { title: null, reason: `model-refused:${p.replace(/\s+/g, '-')}` };
  }
  return { title: cleaned };
}

// Back-compat thin wrapper for any external caller.
function _validateTitle(raw: string): string | null {
  return _validateTitleEx(raw).title;
}

// ── Junk pre-detection ────────────────────────────────────────────────────────
// Some sessions can never be meaningfully titled by the model — no point
// burning three API calls before promoting them to fallback. Cases:
//   • Failed imports whose only assistant message is `API Error: …`
//   • Aborted runs where the assistant never replied
//   • Sessions where the combined user+assistant content is shorter than a tweet
// Returns `{ reason }` if the session should be skipped immediately, else `null`.
function _classifyJunk(s: any): { reason: string } | null {
  const all = (s.messages || []) as Msg[];
  const userMsgs      = all.filter((m) => m.role === 'user');
  const assistantMsgs = all.filter((m) => m.role === 'assistant');

  // _getNextBatch already filters out sessions with no assistant message, but
  // be defensive — the call is cheap and the alternative is a wasted API hit.
  if (assistantMsgs.length === 0) return { reason: 'no-assistant-reply' };

  const _msgText = (m: any): string => {
    let t: string = m.text || '';
    if (!t && Array.isArray(m.blocks)) {
      t = m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
    }
    return _stripWrappers(t);
  };
  // Tool-call presence (any block of type tool-call/tool_use). Tool-only
  // sessions like "generate cute cat" — where the assistant's text is a
  // 30-char ack and the real action is in tool blocks — were previously
  // misclassified as `content-too-short` and abandoned. Bucket analysis
  // 2026-05-10.
  let toolCallCount = 0;
  for (const m of all) {
    if (!Array.isArray(m.blocks)) continue;
    for (const b of m.blocks) {
      if (b.type === 'tool-call' || (b as any).type === 'tool_use') toolCallCount++;
    }
  }
  const aText = assistantMsgs.map(_msgText).join('\n').trim();
  const uText = userMsgs.map(_msgText).join('\n').trim();
  const aLower = aText.toLowerCase();

  // Failed-import stub — extremely common pattern in this codebase.
  if (
    aLower.startsWith('api error:') ||
    aLower.startsWith('error:') ||
    aLower.includes('econnreset') ||
    aLower.includes('unable to connect to api')
  ) {
    return { reason: 'api-error-only' };
  }
  // Multi-agent meta-only — fires only when *every* assistant turn is
  // orchestrator scaffolding (PLAN:/VOTE:/CRITIQUE:…). The common case
  // is "scaffold + scaffold + real reply"; for those, `_extractContent`
  // strips the scaffold turns and we send the real reply to the LLM.
  // Falling through to this guard means there is no real reply at all —
  // the user's question alone is the best title we can offer.
  const realAssistant = assistantMsgs
    .map(_msgText)
    .filter((t) => t && !_isScaffoldText(t));
  if (realAssistant.length === 0 && assistantMsgs.length > 0) {
    return { reason: 'multi-agent-meta' };
  }
  // Tiny-content guard. Floor lowered from 60 → 30 chars (audit
  // 2026-05-10) — "who are you" + "I am a large language model trained
  // by Google." is 58 chars, well titleable. The 30-char floor still
  // catches ack-only sessions ("hi" + "Hello!" = 22 chars) where the
  // user message itself is the only meaningful title material.
  // Tool-only sessions (e.g. image generation) get an even softer floor
  // because the action is in tool blocks, not text.
  const floor = toolCallCount > 0 ? 15 : 30;
  if ((aText.length + uText.length) < floor) {
    return { reason: 'content-too-short' };
  }
  return null;
}

// Synthesizes a sensible name from the user's first message — used when we
// give up on the model. 60 chars cap, ellipsis if truncated, "(empty session)"
// fallback if there is genuinely nothing to work with.
function _synthesizeFallbackName(s: any): string {
  const first = (s.messages || []).find((m: any) => m.role === 'user');
  if (!first) return s.name || '(empty session)';
  let t: string = first.text || '';
  if (!t && Array.isArray(first.blocks)) {
    t = first.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
  }
  t = t.trim().replace(/\s+/g, ' ');
  if (!t) return s.name || '(empty session)';
  if (t.length <= 60) return t;
  return t.slice(0, 60).trimEnd() + '…';
}

// ── Title generation ──────────────────────────────────────────────────────────
// Single non-streaming completion request to the configured provider.
// Returns a validated title string or null on any failure.

async function _generateTitle(
  s:        any,
  model:    string,
  provider: { api_key?: string; endpoint: string },
): Promise<string | null> {
  const content = _extractContent(s);
  if (!content.trim()) return null;

  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('auto-title timeout')), TITLE_TIMEOUT_MS);

  try {
    const url  = provider.endpoint.replace(/\/$/, '') + '/chat/completions';
    // ── Rate limiter (Phase 1.10) ──────────────────────────────────────────
    // Acquire a token from the per-provider bucket and let the limiter handle
    // 429-retry. The (provider as any).name lookup falls back to the inferred
    // name kept on the provider record by server-state.
    const rateLimiter = require('../../core/rate-limiter');
    const providerName: string = (provider as any).name || 'NVIDIA';
    const { response: resp, retries } = await rateLimiter.withRateLimit(
      providerName,
      () => fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role:    'system',
              content: 'You are a title generator. Generate a concise, descriptive title (3 to 8 words) for the given conversation. ' +
                       'Respond with ONLY the title text — no quotes, no punctuation at the end, no explanation.',
            },
            {
              role:    'user',
              content: `Generate a title for this conversation:\n\n${content}`,
            },
          ],
          stream:     false,
          max_tokens: 25,
          temperature: 0.4,
        }),
        signal: ac.signal,
      }),
      { signal: ac.signal },
    );
    clearTimeout(timer);
    if (retries > 0) {
      logger.info('auto-title.rate-limited-retry', { sid: s?.id, retries });
    }
    if (!resp.ok) {
      // Distinguish 429 from other failures so the debug endpoint can show
      // the user a meaningful reason (rate-limited, not "model refused").
      (s as any)._titleSkipReason = resp.status === 429 ? 'rate-limited' : `http-${resp.status}`;
      return null;
    }
    const json: any = await resp.json();
    try {
      const usage = json?.usage;
      if (usage) {
        const inTok  = usage.prompt_tokens    || 0;
        const outTok = usage.completion_tokens || 0;
        if (inTok || outTok) {
          const { recordTokens }    = require('../observability-plus/tokens');
          const { recordCost }      = require('../observability-plus/costs');
          const { getModelPricing } = require('../../models/config');
          recordTokens({ inputTokens: inTok, outputTokens: outTok, model, provider: providerName });
          const pricing = getModelPricing(model);
          if (pricing) {
            const cost = (inTok / 1_000_000) * (pricing.price_input || 0) +
                         (outTok / 1_000_000) * (pricing.price_output || 0);
            if (cost > 0) recordCost(cost, model, providerName);
          }
        }
      }
    } catch (_) {}
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    const v = _validateTitleEx(text);
    if (v.title) return v.title;
    // Stash the validation reason on the request scope so the caller can
    // record it for the debug endpoint. (The function still returns null on
    // failure to keep the existing call sites simple.)
    (s as any)._titleSkipReason = v.reason || 'invalid-title';
    return null;
  } catch (e) {
    clearTimeout(timer);
    (s as any)._titleSkipReason = e instanceof Error && e.message.includes('timeout')
      ? 'request-timeout'
      : 'request-error';
    return null;
  }
}

// ── Candidate scanning ────────────────────────────────────────────────────────
// Returns the next batch of sessions eligible for AI titling, sorted by
// most-recently-updated first ("newest sessions get their titles first").
// The `skip` set contains IDs that failed during the current run and should
// not be retried until the next watchdog cycle.

function _getNextBatch(
  size: number,
  skip: ReadonlySet<string> = new Set(),
): Array<{ sid: string; s: any }> {
  const { displaySessions } = require('../../core/state');

  const candidates: Array<{ sid: string; s: any; ts: number }> = [];

  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly)                        continue;
    if (s._nameSource === 'user' || s._nameSource === 'ai') continue;
    // `fallback` = we tried MAX_TITLE_ATTEMPTS times and the model never
    // returned a valid title. Treat as titled so it stops blocking the gate.
    if (s._nameSource === 'fallback')                 continue;
    if (skip.has(sid))                                continue;
    // Require at least one assistant reply so there is real content to title.
    if (!(s.messages || []).some((m: any) => m.role === 'assistant')) continue;
    candidates.push({ sid, s, ts: s.updatedAt ?? s.createdAt ?? 0 });
  }

  // Most-recently-updated sessions first.
  candidates.sort((a, b) => b.ts - a.ts);
  return candidates.slice(0, size).map(({ sid, s }) => ({ sid, s }));
}

// ── Process loop ──────────────────────────────────────────────────────────────
// Runs continuously until no untitled sessions remain or the feature is
// disabled. Transient failures are recorded in `skipThisRun` and retried on
// the next watchdog cycle, preventing infinite loops.

async function _runLoop(): Promise<void> {
  const { config }          = require('../../core/state');
  const { saveSessionToDisk } = require('../../sessions-internal/persistence');

  const skipThisRun   = new Set<string>();
  let totalProcessed  = 0;
  let batchesRun      = 0;

  while (true) {
    // Re-read config each iteration — settings may change at runtime.
    const atCfg = config.defaults?.autoTitle;
    if (!atCfg?.enabled) {
      logger.info('auto-title.loop-stopped', { reason: 'disabled', totalProcessed });
      break;
    }

    const model: string       = atCfg.model    || 'meta/llama-3.1-8b-instruct';
    const providerName: string = atCfg.provider || 'NVIDIA';
    const provider             = (config.providers || []).find((p: any) => p.name === providerName);

    if (!provider) {
      logger.warn('auto-title.loop-stopped', { reason: 'provider-not-found', providerName });
      break;
    }
    if (!provider.api_key) {
      logger.warn('auto-title.loop-stopped', { reason: 'provider-no-key', providerName });
      break;
    }

    const batch = _getNextBatch(BATCH_SIZE, skipThisRun);
    if (batch.length === 0) {
      // Nothing left to do — exit cleanly.
      _lastRunAt          = Date.now();
      _lastRunTitledCount = totalProcessed;
      logger.info('auto-title.run-complete', { totalProcessed, batchesRun });
      // ── Per-batch summary SSE ────────────────────────────────────────────
      // The per-session `auto-title:titled` event is still emitted (the
      // SessionPicker uses it to live-patch session names). But surface a
      // SINGLE summary event for the toast layer so the user sees one
      // "Auto-titled: 17 sessions" instead of seventeen separate toasts.
      // Per user request 2026-05-06.
      if (totalProcessed > 0) {
        try {
          const { broadcastEvent } = require('../workflows-and-triggers/triggers');
          broadcastEvent('auto-title:batch-summary', { count: totalProcessed });
        } catch (_) { /* triggers not initialised yet */ }
      }
      break;
    }

    batchesRun++;
    logger.info('auto-title.batch-start', { batch: batchesRun, count: batch.length });

    for (const { sid, s } of batch) {
      try {
        // ── Junk pre-check ──────────────────────────────────────────────────
        // If the session is structurally untitlable (failed import / no
        // assistant reply / tweet-sized content), skip the model call entirely
        // and go straight to fallback. Saves three watchdog cycles + three API
        // hits per junk session, and crucially stops them from showing up as
        // "pending" in the UI.
        const junk = _classifyJunk(s);
        if (junk) {
          s.name             = _synthesizeFallbackName(s);
          s._titleSkipReason = `junk:${junk.reason}`;
          s._titleSkippedAt  = Date.now();
          delete s._titleAttempts; // wasn't a model failure — no counter
          // The user-message-as-title IS a valid title for short and
          // multi-agent-meta-only sessions ("who are you", "list mcp tools
          // u see", "hi"). Mark these as 'ai' so they exit the abandoned
          // list and proceed to categorization. Reserve 'fallback' for
          // genuinely-broken sessions where the user might want to retry
          // once the upstream is fixed (api-error-only, no-assistant-reply).
          // User feedback 2026-05-10.
          const ABANDONED = new Set(['api-error-only', 'no-assistant-reply']);
          s._nameSource = ABANDONED.has(junk.reason) ? 'fallback' : 'ai';
          saveSessionToDisk(sid);
          logger.info('auto-title.junk-skipped', {
            sid,
            reason:          junk.reason,
            synthesizedName: s.name,
            nameSource:      s._nameSource,
          });
          // Junk-but-titleable sessions (short/multi-agent-meta) still have
          // real user content worth indexing. Truly-abandoned ones (api-
          // error-only) get enqueued too — the runner's content-empty guard
          // will produce zero chunks and gracefully no-op.
          if (s._nameSource === 'ai') {
            try {
              const cr = require('./context-rag');
              if (typeof cr.enqueueForRag === 'function') cr.enqueueForRag(sid, 'finalize');
            } catch (_) { /* context-rag not yet loaded — startup scan picks it up */ }
          }
          continue;
        }
        const title = await _generateTitle(s, model, provider);
        if (!title) {
          // Invalid/empty response — skip for this run, retry next cycle.
          skipThisRun.add(sid);
          // Don't burn the attempt budget on transient upstream failures
          // (rate-limit, HTTP 5xx, request timeout, network error). Those
          // say nothing about the *content* — they're provider noise. A
          // burst of 429s during a NIM rate-storm previously sidelined 60+
          // perfectly normal sessions because three watchdog ticks landed
          // inside the same outage window. See bucket analysis 2026-05-10.
          const transient = new Set([
            'rate-limited', 'request-timeout', 'request-error',
            'http-500', 'http-502', 'http-503', 'http-504',
          ]);
          if (transient.has((s as any)._titleSkipReason)) {
            logger.info('auto-title.transient-skip', {
              sid,
              reason: (s as any)._titleSkipReason,
            });
            continue;
          }
          // Track lifetime attempts so we can promote chronically-failing
          // sessions to `_nameSource = 'fallback'` and unblock the pipeline
          // gate. See MAX_TITLE_ATTEMPTS comment at top of file.
          s._titleAttempts = (typeof s._titleAttempts === 'number' ? s._titleAttempts : 0) + 1;
          if (s._titleAttempts >= MAX_TITLE_ATTEMPTS) {
            s._nameSource     = 'fallback';
            s._titleSkippedAt = Date.now();
            // Persist the fallback marker so the next watchdog tick + a
            // server restart both honour the abandonment decision.
            saveSessionToDisk(sid);
            logger.info('auto-title.abandoned', {
              sid,
              attempts: s._titleAttempts,
              reason:   'max-attempts-reached',
            });
          } else {
            // Persist the attempt counter even when we'll retry, so the
            // failure budget survives a restart.
            saveSessionToDisk(sid);
            logger.info('auto-title.generate-skipped', {
              sid,
              attempts: s._titleAttempts,
              reason:   'no-valid-title',
            });
          }
          continue;
        }
        s.name        = title;
        s._nameSource = 'ai';
        // Successful title clears the failure counter — if the user later
        // re-renames the session and asks for a fresh AI title, the budget
        // restarts at zero.
        delete s._titleAttempts;
        delete s._titleSkippedAt;
        delete s._titleSkipReason;
        saveSessionToDisk(sid);
        totalProcessed++;
        _lifetimeTitled++;
        logger.info('auto-title.generated', { sid, title });
        // Broadcast to all SSE clients so the frontend can show a toast.
        try {
          const { broadcastEvent } = require('../workflows-and-triggers/triggers');
          broadcastEvent('auto-title:titled', { sid, title });
        } catch (_) { /* non-fatal if triggers not yet initialised */ }
        // Chain into context-rag — the freshly-titled session is a new
        // candidate for vector-DB ingest (matched DBs decide whether they
        // care). Per-session enqueue is cheap; the runner dedupes and the
        // batched embed call happens at end-of-loop, not per-session.
        try {
          const cr = require('./context-rag');
          if (typeof cr.enqueueForRag === 'function') cr.enqueueForRag(sid, 'finalize');
        } catch (_) { /* context-rag not yet loaded — startup scan picks it up */ }
        // NOTE — chain into categorizer DEFERRED to end-of-loop (see
        // post-loop block in _startProcess). Per user request 2026-05-06
        // the pipeline must be strictly serial: the categorizer is not
        // allowed to start while ANY untitled session remains, otherwise
        // it races with batch N+1 of the title worker. See `isClear()`.
      } catch (e) {
        skipThisRun.add(sid);
        logger.warn('auto-title.error', {
          sid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Immediately continue to the next batch — self-restart without delay.
  }
}

// ── Runtime stats ─────────────────────────────────────────────────────────────
// Exposed via getAutoTitleStatus() → GET /v1/config/auto-title/status

let _lastRunAt:           number | null = null;  // epoch ms of last completed run
let _lastRunTitledCount:  number        = 0;     // titles generated in last run
let _lifetimeTitled:      number        = 0;     // total since server start

// ── Process guard ─────────────────────────────────────────────────────────────

let _isRunning = false;

async function _startProcess(): Promise<void> {
  if (_isRunning) return; // already active — watchdog will check again in 3 min
  _isRunning = true;
  logger.info('auto-title.process-started');
  try {
    await _runLoop();
  } catch (e) {
    // _runLoop should never throw, but guard the outer edge just in case.
    logger.warn('auto-title.process-crashed', {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    _isRunning = false;
    logger.info('auto-title.process-ended');
    // ── Chain into context-rag, then categorizer (end-of-loop) ──────────────
    // The titler stays serial w.r.t. the categorizer (it gates on
    // `autoTitle.isClear()`); context-rag is a parallel ingest leg that
    // happens to share the LLM rate-budget. We kick context-rag first
    // because it owns the chain-bubble to the categorizer: `kickContextRag`
    // ALWAYS forwards a no-op kick to `kickCategorizer`, even when its own
    // queue is empty or no DBs are configured. That keeps the cascade
    // exactly one call deep at every join point.
    try {
      if (isClear()) {
        const { kickContextRag } = require('./context-rag');
        if (typeof kickContextRag === 'function') {
          kickContextRag();
        } else {
          // Defensive: if context-rag isn't loaded (older builds, hot-reload
          // edge case) fall through to the direct categorizer kick.
          const { kickCategorizer } = require('./categorizer');
          kickCategorizer();
        }
      }
    } catch (_) {
      try {
        const { kickCategorizer } = require('./categorizer');
        kickCategorizer();
      } catch (__) { /* categorizer not yet loaded — picked up by its own watchdog */ }
    }
  }
}

// ── Watchdog ──────────────────────────────────────────────────────────────────

let _watchdogTimer: ReturnType<typeof setInterval> | null = null;

// One-shot promotion: when the meaning of `_nameSource = 'fallback'`
// changes (audit 2026-05-10 reserved it for genuinely-broken sessions
// only; titleable short / multi-agent-meta sessions are now `'ai'`),
// previously-fallback sessions whose synthesized name is a perfectly
// good title are stranded in the abandoned list. Promote them on
// worker startup so the user doesn't need to click force-retry.
function _promoteStrandedFallbacks(): void {
  let promoted = 0;
  try {
    const { displaySessions } = require('../../core/state');
    const { saveSessionToDisk } = require('../../sessions-internal/persistence');
    const TITLEABLE_REASONS = new Set([
      'junk:content-too-short',
      'junk:multi-agent-meta',
    ]);
    for (const [sid, s] of displaySessions as Map<string, any>) {
      if (!s || s._inMemoryOnly) continue;
      if (s._nameSource !== 'fallback') continue;
      if (!TITLEABLE_REASONS.has(s._titleSkipReason || '')) continue;
      s._nameSource = 'ai';
      saveSessionToDisk(sid);
      promoted++;
    }
  } catch (_) { /* state not initialised yet */ }
  if (promoted > 0) logger.info('auto-title.stranded-fallbacks-promoted', { promoted });
}

function startAutoTitleWorker(): void {
  if (_watchdogTimer) return;
  _promoteStrandedFallbacks();

  _watchdogTimer = setInterval(() => {
    if (_isRunning) {
      logger.info('auto-title.watchdog-skip', { reason: 'process-still-running' });
      return;
    }
    const { config } = require('../../core/state');
    if (!config.defaults?.autoTitle?.enabled) return;
    // Only start if there is actual work — avoids spurious log noise.
    if (_getNextBatch(1).length > 0) {
      logger.info('auto-title.watchdog-trigger');
      void _startProcess();
    }
  }, POLL_INTERVAL_MS);

  logger.info('auto-title.worker-started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize:      BATCH_SIZE,
  });
}

// ── Lifecycle stop ────────────────────────────────────────────────────────────
// Phase-2 batch F (context-generator module). Called by the module loader's
// ctx.workers.add() teardown when the module is disabled or hot-reloaded.
// The 3-min watchdog clears immediately; an in-flight `_runLoop` (mid-batch)
// observes the next iteration's `config.defaults.autoTitle.enabled` re-read
// and exits naturally — we don't AbortController the in-flight HTTP call to
// avoid leaving a half-titled session in an inconsistent state.
function stopAutoTitleWorker(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info('auto-title.worker-stopped');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Called after every successful assistant turn (from routes/chat.ts).
// Immediately starts the process if the session needs a title and no process is
// already running — so freshly finished chats get titled without waiting up to
// 3 minutes for the next watchdog tick.
function enqueueForAutoTitle(sid: string): void {
  const { config, displaySessions } = require('../../core/state');
  if (!config.defaults?.autoTitle?.enabled) return;
  const s = displaySessions.get(sid);
  if (!s) return;
  if (s._nameSource === 'user' || s._nameSource === 'ai') return;
  if (!_isRunning) void _startProcess();
}

// Called once on startup (after loadSessionsFromDisk) to process existing
// untitled sessions that pre-date the current feature or were missed previously.
function scanAndEnqueueOnStartup(): void {
  const { config } = require('../../core/state');
  if (!config.defaults?.autoTitle?.enabled) return;
  if (_getNextBatch(1).length === 0) return;
  logger.info('auto-title.startup-trigger');
  void _startProcess();
}

// Returns live state for the status endpoint and UI polling.
function getAutoTitleStatus(): {
  isRunning:          boolean;
  watchdogActive:     boolean;
  pendingCount:       number;
  abandonedCount:     number;
  lastRunAt:          number | null;
  lastRunTitledCount: number;
  lifetimeTitled:     number;
  enabled:            boolean;
} {
  const { config, displaySessions } = require('../../core/state');
  const enabled = !!config.defaults?.autoTitle?.enabled;
  // Count sessions we gave up on (after MAX_TITLE_ATTEMPTS) so the UI can
  // surface a "5 stuck — Force retry" affordance instead of letting them
  // disappear silently.
  let abandonedCount = 0;
  for (const [, s] of displaySessions as Map<string, any>) {
    if (s && !s._inMemoryOnly && s._nameSource === 'fallback') abandonedCount++;
  }
  return {
    isRunning:          _isRunning,
    watchdogActive:     _watchdogTimer !== null,
    pendingCount:       enabled ? _getNextBatch(9999).length : 0,
    abandonedCount,
    lastRunAt:          _lastRunAt,
    lastRunTitledCount: _lastRunTitledCount,
    lifetimeTitled:     _lifetimeTitled,
    enabled,
  };
}

// ── Manual triggers (Run-now / Force-retry abandoned) ─────────────────────────
// User-facing escape hatches surfaced by /v1/config/auto-title/run-now and
// /v1/config/auto-title/force-retry. They short-circuit the 3-min watchdog
// without affecting any other gating.

function runNow(): { kicked: boolean; reason?: string } {
  const { config } = require('../../core/state');
  if (!config.defaults?.autoTitle?.enabled) return { kicked: false, reason: 'disabled' };
  if (_isRunning) return { kicked: false, reason: 'already-running' };
  if (_getNextBatch(1).length === 0) return { kicked: false, reason: 'nothing-to-do' };
  void _startProcess();
  return { kicked: true };
}

// Resets the `_nameSource = 'fallback'` flag and the failure counter on
// every previously-abandoned session, then kicks the worker. This is the
// "I fixed the model — try again" button.
function forceRetryAbandoned(): { reset: number; kicked: boolean } {
  const { displaySessions } = require('../../core/state');
  const { saveSessionToDisk } = require('../../sessions-internal/persistence');
  let reset = 0;
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (s._nameSource !== 'fallback') continue;
    s._nameSource = null;
    delete s._titleAttempts;
    delete s._titleSkippedAt;
    delete s._titleSkipReason;
    saveSessionToDisk(sid);
    reset++;
  }
  logger.info('auto-title.force-retry-abandoned', { reset });
  let kicked = false;
  if (reset > 0 && !_isRunning) {
    void _startProcess();
    kicked = true;
  }
  return { reset, kicked };
}

// ── Skip stuck sessions (manual override) ─────────────────────────────────────
// Per-user-request emergency hatch: if a session keeps failing in ways the
// junk-detector cannot recognise (e.g. a niche model bug), the user can mark
// every currently-pending session as fallback in one click. Each gets a
// synthesized name from its first user message + `_titleSkipReason='user-skipped'`
// so the debug endpoint can show *why*. Optional `sids` arg targets specific
// sessions only — without it, every pending session is skipped.
function skipStuck(sids?: ReadonlyArray<string>): { skipped: number; details: Array<{ sid: string; name: string }> } {
  const { displaySessions } = require('../../core/state');
  const { saveSessionToDisk } = require('../../sessions-internal/persistence');
  const targetSet = sids && sids.length > 0 ? new Set(sids) : null;
  const details: Array<{ sid: string; name: string }> = [];

  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (targetSet && !targetSet.has(sid)) continue;
    // Skip only sessions that are NOT already user/ai/fallback. This includes
    // pending and abandoned sessions when no `sids` filter is given. With a
    // filter, the user can also re-skip a previously-abandoned session that
    // was force-retried back into pending.
    if (s._nameSource === 'user' || s._nameSource === 'ai') continue;
    // Synthesize a name from first user message; if we synthesize, also
    // preserve the original (model-rejected) name as a debug breadcrumb.
    const synthName = _synthesizeFallbackName(s);
    s.name             = synthName;
    s._nameSource      = 'fallback';
    s._titleSkipReason = (s._titleSkipReason && s._titleSkipReason.startsWith('junk:'))
      ? s._titleSkipReason  // keep the more-specific junk reason
      : 'user-skipped';
    s._titleSkippedAt  = Date.now();
    saveSessionToDisk(sid);
    details.push({ sid, name: synthName });
  }
  logger.info('auto-title.skip-stuck', { skipped: details.length, targeted: !!targetSet });
  return { skipped: details.length, details };
}

// ── Debug snapshot ────────────────────────────────────────────────────────────
// Returns per-session info for every session in pending OR fallback state, so
// the UI can show users *which* sessions are stuck and *why*. Capped at 50
// entries — the user only needs the worst offenders, not the entire history.
interface DebugRow {
  sid:               string;
  name:              string;
  nameSource:        string | null;
  attempts:          number;
  skipReason:        string | null;
  skippedAt:         number | null;
  messageCount:      number;
  userPreview:       string;
  assistantPreview:  string;
  state:             'pending' | 'abandoned';
}
function getDebugInfo(): { rows: DebugRow[]; pending: number; abandoned: number } {
  const { displaySessions } = require('../../core/state');
  const rows: DebugRow[] = [];
  let pending = 0, abandoned = 0;

  const _msgText = (m: any): string => {
    let t: string = m.text || '';
    if (!t && Array.isArray(m.blocks)) {
      t = m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
    }
    return t.trim();
  };

  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (s._nameSource === 'user' || s._nameSource === 'ai') continue;
    const isFallback = s._nameSource === 'fallback';
    const isPending  = !isFallback;
    if (isPending) {
      // Same gate as _getNextBatch — only show sessions the worker would actually
      // attempt to title (i.e. those with at least one assistant message).
      if (!(s.messages || []).some((m: any) => m.role === 'assistant')) continue;
    }
    const userMsg = (s.messages || []).find((m: any) => m.role === 'user');
    const lastAss = [...(s.messages || [])].reverse().find((m: any) => m.role === 'assistant');
    rows.push({
      sid,
      name:             s.name || '',
      nameSource:       s._nameSource ?? null,
      attempts:         typeof s._titleAttempts === 'number' ? s._titleAttempts : 0,
      skipReason:       s._titleSkipReason || null,
      skippedAt:        s._titleSkippedAt || null,
      messageCount:     (s.messages || []).length,
      userPreview:      userMsg ? _msgText(userMsg).slice(0, 160) : '',
      assistantPreview: lastAss ? _msgText(lastAss).slice(0, 160) : '',
      state:            isFallback ? 'abandoned' : 'pending',
    });
    if (isFallback) abandoned++; else pending++;
  }
  // Most-stuck first: abandoned, then highest-attempts, then most-recent.
  rows.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'abandoned' ? -1 : 1;
    if (a.attempts !== b.attempts) return b.attempts - a.attempts;
    return (b.skippedAt || 0) - (a.skippedAt || 0);
  });
  return { rows: rows.slice(0, 50), pending, abandoned };
}

// ── Serial-pipeline gate ──────────────────────────────────────────────────────
// Used by context-categorizer (and indirectly by context-sorter via the
// categorizer's own gate) to determine whether the upstream stage has fully
// drained. The pipeline is strictly serial per user request 2026-05-06:
// no downstream stage may start while any upstream stage is still running
// or has pending work.
//
// "Clear" means BOTH:
//   • _isRunning === false           (no in-flight title generation)
//   • _getNextBatch(1).length === 0  (no titleable session left)
//
// When the feature is disabled (config.autoTitle.enabled === false) we
// report clear so the downstream pipeline isn't permanently blocked.
function isClear(): boolean {
  const { config } = require('../../core/state');
  if (!config.defaults?.autoTitle?.enabled) return true;
  if (_isRunning) return false;
  return _getNextBatch(1).length === 0;
}

module.exports = {
  startAutoTitleWorker,
  stopAutoTitleWorker,
  scanAndEnqueueOnStartup,
  enqueueForAutoTitle,
  getAutoTitleStatus,
  isClear,
  runNow,
  forceRetryAbandoned,
  skipStuck,
  getDebugInfo,
};
