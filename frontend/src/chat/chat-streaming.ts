import chatUtils from './chat-utils.js';
import { iconSvg } from './icons.js';
import type { Block, ChatMessage } from './chat-utils.js';
import { getChatActions, useChatStore } from '../stores/chatStore.js';
import { getToastActions } from '../stores/toastStore.js';
import { getAppState, getAppActions } from '../stores/appStore.js';
import { getGraphState, getGraphActions } from '../stores/graphStore.js';
import { resolveAvatarColor } from '../color-themes-config.js';
import { api } from '../api.js';
import { save } from '../state.js';
import { chat } from '../chat.js';
import { session } from '../session.js';
import { graph } from '../workflows/graph.js';
import { recordReconnectStart, recordReconnectFinish, recordReconnectSkipped } from '../util/net-metrics.js';
import { chatRendering } from './chat-rendering.js';
import { selectReconnectPlaceholder } from './reconnect-placeholder.js';


async function persistChatErrorMessage(sessionId: string, text: string): Promise<void> {
  const msg = String(text || '').trim();
  if (!sessionId || !msg) return;
  try {
    await fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'error', text: msg }),
    });
  } catch (_) {
    // Best-effort only. The local chat store is still saved as a fallback.
  }
}

function markPlaceholderAsError(placeholder: HTMLElement, text: string): void {
  const mid = +(placeholder.dataset['mid'] || '0');
  if (!mid) return;
  const store = useChatStore.getState();
  const next = (store.messages as ChatMessage[]).map((m) => {
    if (m._mid !== mid) return m;
    const copy: ChatMessage = { ...m, role: 'error', text };
    delete copy.typing;
    delete copy.blocks;
    return copy;
  });
  store.setMessages(next);
  store.clearStreamingSegment(String(mid));
}

function _attachHermesPromptRow(msgEl: HTMLElement, prompt: Record<string, unknown>, sessionId: string): void {
  const type = prompt['type'] as string;
  const partnerId = String(prompt['partnerId'] || '');
  const bubble = msgEl.querySelector<HTMLElement>('.msg-bubble');
  if (!bubble) return;

  const row = document.createElement('div');
  row.className = 'hermes-prompt-row';
  row.dataset['persistent'] = '1';

  const esc = (s: unknown) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  async function respond(params: Record<string, unknown>): Promise<void> {
    row.classList.add('hpr-resolving');
    try {
      await fetch('/v1/partners/hermes/prompt-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, partnerId, type: type.replace('.request', ''), ...params }),
      });
      row.remove();
    } catch {
      row.classList.remove('hpr-resolving');
    }
  }

  function btn(label: string, cls: string, action: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'hpr-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', action);
    return b;
  }

  if (type === 'approval.request') {
    const command = esc(prompt['command']);
    const desc = esc(prompt['description'] || prompt['pattern_key']);
    row.innerHTML = `<div class="hpr-header"><span class="hpr-icon">${iconSvg('triangle-alert', 14)}</span><span class="hpr-title">Command approval</span></div>` +
      `<code class="hpr-command">${command}</code>` +
      (desc ? `<div class="hpr-desc">${desc}</div>` : '') +
      `<div class="hpr-btns"></div>`;
    const btns = row.querySelector('.hpr-btns')!;
    btns.appendChild(btn('Allow once', 'hpr-btn-allow', () => respond({ choice: 'once' })));
    btns.appendChild(btn('Allow session', 'hpr-btn-allow', () => respond({ choice: 'session' })));
    btns.appendChild(btn('Always allow', 'hpr-btn-allow hpr-btn-always', () => respond({ choice: 'always' })));
    btns.appendChild(btn('Deny', 'hpr-btn-deny', () => respond({ choice: 'deny' })));

  } else if (type === 'clarify.request') {
    const question = esc(prompt['question']);
    const choices = Array.isArray(prompt['choices']) ? prompt['choices'] as string[] : [];
    const reqId = String(prompt['request_id'] || '');
    row.innerHTML = `<div class="hpr-header"><span class="hpr-icon">${iconSvg('circle-help', 14)}</span><span class="hpr-title">${question}</span></div>` +
      `<div class="hpr-btns"></div>`;
    const btns = row.querySelector('.hpr-btns')!;
    if (choices.length) {
      for (const c of choices) {
        btns.appendChild(btn(c, 'hpr-btn-allow', () => respond({ request_id: reqId, answer: c })));
      }
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'hpr-input';
      inp.placeholder = 'Type your answer…';
      btns.appendChild(inp);
      btns.appendChild(btn('Send', 'hpr-btn-allow', () => respond({ request_id: reqId, answer: inp.value })));
    }

  } else if (type === 'sudo.request') {
    const reqId = String(prompt['request_id'] || '');
    // Wrap inputs in <form> so Chrome's autofill heuristics don't warn
    // "Password field is not contained in a form".
    row.innerHTML = `<div class="hpr-header"><span class="hpr-icon">${iconSvg('lock', 14)}</span><span class="hpr-title">Sudo password required</span></div>` +
      `<form class="hpr-btns" autocomplete="off" onsubmit="return false;"></form>`;
    const btns = row.querySelector('.hpr-btns')! as HTMLFormElement;
    const inp = document.createElement('input');
    inp.type = 'password';
    inp.className = 'hpr-input';
    inp.placeholder = 'Password…';
    inp.autocomplete = 'current-password';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') respond({ request_id: reqId, password: inp.value }); });
    btns.appendChild(inp);
    btns.appendChild(btn('Submit', 'hpr-btn-allow', () => respond({ request_id: reqId, password: inp.value })));

  } else if (type === 'secret.request') {
    const key = esc(prompt['key'] || prompt['name'] || 'API key');
    const reqId = String(prompt['request_id'] || '');
    row.innerHTML = `<div class="hpr-header"><span class="hpr-icon">${iconSvg('key', 14)}</span><span class="hpr-title">Secret required: <span class="hpr-key-name">${key}</span></span></div>` +
      `<form class="hpr-btns" autocomplete="off" onsubmit="return false;"></form>`;
    const btns = row.querySelector('.hpr-btns')! as HTMLFormElement;
    const inp = document.createElement('input');
    inp.type = 'password';
    inp.className = 'hpr-input';
    inp.placeholder = 'Value…';
    inp.autocomplete = 'off';
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') respond({ request_id: reqId, value: inp.value }); });
    btns.appendChild(inp);
    btns.appendChild(btn('Submit', 'hpr-btn-allow', () => respond({ request_id: reqId, value: inp.value })));

  } else {
    return; // Unknown type, skip
  }

  bubble.appendChild(row);
}

function _toastEventEnabled(key: string): boolean {
  try {
    const cfg = JSON.parse(localStorage.getItem('yha.toast') || '{}');
    if (cfg.enabled === false) return false;
    const events = cfg.events || {};
    return events[key] !== false;
  } catch {
    return true;
  }
}

interface StreamState {
  localLive: boolean;
  reconnecting: boolean;
  serverActive: boolean;
  status: string;
}

interface Segment {
  placeholder: HTMLElement;
  blocks: Block[];
  liveText: string;
  streamStart: number;
  totalChars: number;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  tokensPerSec: number | null;
  author: Record<string, unknown> | null;
  model: string | null;
  finalized: boolean;
  empId?: string | null;
  // Live counters fed by backend `_live` frames so the busy meta bar can
  // paint from the turn's start. Overwritten authoritatively each frame;
  // the terminal `_end` chunk supersedes them with final totals.
  toolCallCount: number;
  apiCallCount: number;
}

const sessionAbortControllers = new Map<string, { abort(): void }>();
const sessionStreamState = new Map<string, StreamState>();
const reconnectAttemptTokens = new Map<string, number>();
// Highest server-side chunk seq this client has seen for a given session.
// Used to drive `?fromSeq=N` on reconnect so the server can replay only
// the chunks we missed instead of the whole tail-buffer. Survives across
// reconnect attempts within the same page-load.
const sessionLastSeq = new Map<string, number>();

// Backend `_live` counters keyed by message id. CRITICAL: in the React
// renderer the segment placeholder is DETACHED (chat.ts::appendEl returns a
// detached node for streaming code to write into), so the throttled render
// path paints into the LIVE `[data-mid]` element it resolves from the
// document — NOT seg.placeholder. Stamping the busy-bar dataset onto the
// placeholder alone (the first cut) stranded `data-live` on an off-screen
// node, so the bar never appeared. Recording values by mid lets
// _flushPendingRenders re-stamp whichever element it actually renders.
interface LiveMetaVals { in: number; out: number; tools: number; api: number; start: number; model?: string; }
const _liveMetaByMid = new Map<number, LiveMetaVals>();

// Writes the `_live` counters onto an element's dataset so chat-rendering's
// syncLiveMetaBar folds in the busy bar. `start` is a client-local clock
// origin (elapsed time is never sent over the wire).
function _writeLiveDataset(el: HTMLElement, vals: LiveMetaVals): void {
  el.dataset['live'] = '1';
  el.dataset['liveIn'] = String(vals.in || 0);
  el.dataset['liveOut'] = String(vals.out || 0);
  el.dataset['liveTools'] = String(vals.tools || 0);
  el.dataset['liveApi'] = String(vals.api || 0);
  el.dataset['liveStart'] = String(vals.start || Date.now());
  el.dataset['liveModel'] = vals.model || '';
}

// Records backend `_live` counters for the turn (keyed by the placeholder's
// mid) so the render path can stamp the on-screen node, and stamps the handed
// element directly for the non-React direct-DOM path where they're the same.
function applyLiveMeta(
  el: HTMLElement | null | undefined,
  vals: LiveMetaVals,
): void {
  if (!el) return;
  const mid = _midOf(el);
  if (mid != null) _liveMetaByMid.set(mid, vals);
  _writeLiveDataset(el, vals);
  ensureLiveClock();
}

// Drops the live busy bar for an element's turn: clears the on-screen dataset
// AND the by-mid record so a late throttled render can't re-stamp the bar.
function clearLiveMeta(el: HTMLElement | null | undefined): void {
  if (el) delete el.dataset['live'];
  const mid = _midOf(el ?? null);
  if (mid != null) _liveMetaByMid.delete(mid);
}

// Shared elapsed-time clock for every on-screen live busy bar. Counters
// ride the throttled renderBlocks path; elapsed needs a steadier cadence
// than backend `_live` frames (and never crosses the wire), so one 250ms
// interval recomputes `.live-elapsed` textContent for all visible bars
// straight off each span's data-live-start. Self-stops when none remain.
let _liveClockInterval: number | null = null;
// Exported so the React MessageList can start the shared clock when it
// paints a live bar sourced from sessionActivityStore (switch-into / reload,
// before this session's reconnect stream has delivered a `_live` frame).
export function ensureLiveClock(): void {
  if (_liveClockInterval != null) return;
  _liveClockInterval = window.setInterval(() => {
    const els = document.querySelectorAll<HTMLElement>('.msg-meta.is-live .live-elapsed');
    if (!els.length) {
      if (_liveClockInterval != null) { window.clearInterval(_liveClockInterval); _liveClockInterval = null; }
      return;
    }
    const now = Date.now();
    els.forEach((el) => {
      const start = +(el.dataset['liveStart'] || '0');
      if (start) el.textContent = chatUtils.fmtLiveElapsed(now - start);
    });
  }, 250) as unknown as number;
}

// Per-session streaming accumulator, persisted across reconnect attempts.
// Without this the reconnectStream closure starts every attempt with an
// empty `blocks`/`liveText`, and after `?fromSeq=N` the server only sends
// the missed delta — so the first `chat.renderBlocks(placeholder, [], delta)`
// call wipes everything that was already on screen down to just the delta.
// Symptom: scroll (or any other reconnect trigger) "resets" the agent bubble
// to a tiny fragment while new tokens stream into the (now shrunken) state.
interface StreamAccumulator {
  blocks: Block[];
  liveText: string;
  toolIdToName: Map<string, string>;
  rcStreamStart: number | null;
  rcTotalChars: number;
  rcStopReason: string | null;
  rcInputTokens: number;
  rcOutputTokens: number;
  rcAuthor: Record<string, unknown> | null;
  rcModel: string | null;
}
const sessionStreamAccumulator = new Map<string, StreamAccumulator>();
// Counts consecutive silence-driven reconnect attempts where ZERO chunks
// (not even a heartbeat) arrived. After a few of these we conclude the
// bridge stream is wedged (e.g. zombie activeStream entry whose claude
// subprocess hangs) and bail out via the persisted-snapshot fallback
// instead of looping forever. Reset on every successful chunk.
const sessionSilentReconnectStreak = new Map<string, number>();
const SILENT_RECONNECT_GIVE_UP_AT = 3;
// Absolute cap on the reconnect retry chain, complementing the silent-streak
// guard above. If the bridge keeps emitting heartbeats (so `_liveChunkCount`
// stays at zero but the silent-streak gets reset on every replay or kept low),
// or the silent-streak is only hit intermittently, the previous logic could
// reconnect forever. We track per-session attempt count + first-attempt
// timestamp; either crossing its budget triggers the same persisted-snapshot
// fallback the silent-streak path uses, plus a toast so the user knows the
// FE has stopped trying.
const sessionReconnectChainCount = new Map<string, number>();
const sessionReconnectChainStartAt = new Map<string, number>();
const RECONNECT_CHAIN_MAX_ATTEMPTS = 10;
const RECONNECT_CHAIN_MAX_DURATION_MS = 5 * 60_000;
function _initAccumulator(): StreamAccumulator {
  return {
    blocks: [],
    liveText: '',
    toolIdToName: new Map<string, string>(),
    rcStreamStart: null,
    rcTotalChars: 0,
    rcStopReason: null,
    rcInputTokens: 0,
    rcOutputTokens: 0,
    rcAuthor: null,
    rcModel: null,
  };
}
const _detachedSessions = new Set<string>();
// Tracks auto-created recording nodes so reconnectStream can mark them done
// when the stream finishes via the detached/reconnect path.
const sessionRecordingNodes = new Map<string, { node: Record<string, unknown>; wasAutoCreated: boolean }>();
let sessionAllowedTools: string[] = [];
let _reconnectSeq = 0;

// rAF-coalesced renderBlocks for live streams: per-chunk renderBlocks calls
// were the dominant cost in tool-heavy streams (each call rebuilds a placeholder's
// inner DOM). Map keyed by `mid: number` ensures only the latest state per
// message is rendered each frame, AND that a layout switch (which detaches
// the previous bubble's DOM) doesn't pin a dead HTMLElement in the map
// forever. Without mid keying the Map kept stale placeholder refs after
// every layout change, blocking GC.
//
// Render-rate throttle: caps DOM rebuilds at ~10fps (100ms minimum between
// renders). dangerouslySetInnerHTML replaces the entire message DOM on every
// render: parse HTML → create nodes → layout → paint → GPU texture upload.
// At ~20 tokens/s without throttling that runs 20×/s; at 10fps it runs 10×/s,
// cutting the per-stream CPU+GPU overhead roughly in half. Text still appears
// in smooth 2–4 word steps — indistinguishable from per-token updates visually.
const _pendingRenders = new Map<number, { blocks: Block[]; liveText: string }>();
let _renderRafId = 0;
let _renderThrottleId = 0;
let _lastRenderAt = 0;
const RENDER_THROTTLE_MS = 100;
function _midOf(placeholder: HTMLElement | null): number | null {
  if (!placeholder) return null;
  const raw = placeholder.dataset?.['mid'];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function _resolveLive(mid: number): HTMLElement | null {
  // Detached placeholders no longer match (querySelector walks the live tree).
  // We escape `mid` defensively even though it's a number we just produced.
  return document.querySelector<HTMLElement>(`[data-mid="${CSS.escape(String(mid))}"]`);
}
function _flushPendingRenders(): void {
  _renderRafId = 0;
  _renderThrottleId = 0;
  _lastRenderAt = performance.now();
  if (!_pendingRenders.size) return;
  const entries = [..._pendingRenders.entries()];
  _pendingRenders.clear();
  for (const [mid, { blocks, liveText }] of entries) {
    const el = _resolveLive(mid);
    if (!el) {
      // The bubble was detached (layout switch, stream wiped from store,
      // session deleted) between scheduling and flush — silently drop. We
      // warn at most once per process so a busy layout-toggle session
      // doesn't flood the console.
      if (!_pendingRendersWarned) {
        _pendingRendersWarned = true;
        console.warn(`[chat-streaming] dropped render for detached mid=${mid} (likely layout switch / session delete)`);
      }
      continue;
    }
    // (Re)stamp the live busy-bar dataset onto the element we're ACTUALLY
    // painting. applyLiveMeta wrote it to seg.placeholder, which is detached
    // in the React path — so without this the resolved on-screen node never
    // carries `data-live` and syncLiveMetaBar can't fold in the bar.
    const lm = _liveMetaByMid.get(mid);
    if (lm) _writeLiveDataset(el, lm);
    else delete el.dataset['live'];
    try { chat.renderBlocks(el, blocks, liveText); } catch (_) {}
  }
}
let _pendingRendersWarned = false;
function scheduleRender(placeholder: HTMLElement | null, blocks: Block[], liveText = ''): void {
  const mid = _midOf(placeholder);
  if (mid == null) return;
  _pendingRenders.set(mid, { blocks, liveText });
  if (_renderRafId || _renderThrottleId) return; // already scheduled
  const delay = _lastRenderAt + RENDER_THROTTLE_MS - performance.now();
  if (delay <= 0) {
    _renderRafId = requestAnimationFrame(_flushPendingRenders);
  } else {
    _renderThrottleId = window.setTimeout(() => {
      _renderThrottleId = 0;
      if (_pendingRenders.size && !_renderRafId) {
        _renderRafId = requestAnimationFrame(_flushPendingRenders);
      }
    }, delay) as unknown as number;
  }
}
function flushRenderNow(placeholder: HTMLElement | null): void {
  // Cancel any pending throttle so the final state renders immediately.
  if (_renderThrottleId) { window.clearTimeout(_renderThrottleId); _renderThrottleId = 0; }
  const mid = _midOf(placeholder);
  if (mid != null && _pendingRenders.has(mid)) {
    const data = _pendingRenders.get(mid)!;
    _pendingRenders.delete(mid);
    // Use the placeholder we were handed directly — it's the live one the
    // caller already has a reference to.
    try { chat.renderBlocks(placeholder!, data.blocks, data.liveText); } catch (_) {}
  }
}

// Layout swaps remount every chat bubble against a new DOM tree. Any
// pending render targeting the old tree's mid would resolve to nothing on
// next flush; clearing here is cheap insurance that prevents the
// `_pendingRenders` Map from temporarily holding entries until the next
// dropped-mid warn cycle.
//
// addEventListener does NOT dedupe distinct closures — a hot-reload that
// re-evaluates this module would stack a fresh listener each time. Stash the
// handler on window and remove any prior one first so exactly one stays
// registered across HMR reloads.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const w = window as unknown as { __yhaLayoutClear?: () => void };
  if (w.__yhaLayoutClear) window.removeEventListener('yha:layout', w.__yhaLayoutClear);
  const onLayout = (): void => { _pendingRenders.clear(); };
  w.__yhaLayoutClear = onLayout;
  window.addEventListener('yha:layout', onLayout);
}

// Sum of text/thinking content across blocks — proxy for "how complete is
// this assistant turn?". Tool-call/result detail is intentionally excluded
// because both sides (local vs persisted) record the same tool detail JSON;
// only the trailing prose can diverge during a debounce race.
function _blockTextLen(blocks: Block[] | undefined): number {
  if (!Array.isArray(blocks)) return 0;
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'thinking') n += (b.content || '').length;
  }
  return n;
}

// Pre-finalize snapshot reconcile. After a clean finish('done'), refetch the
// persisted session from the bridge — if the on-disk version has strictly
// more text content than the blocks we just sealed in chatStore (i.e. the
// SSE stream lost the last few deltas to a TCP race, but the bridge's
// flushSessionToDisk path captured them), splice the persisted version in.
// Conservative: only replaces when the persisted blocks contain MORE text.
async function _reconcilePersistedSnapshot(sid: string, localBlocks: Block[]): Promise<void> {
  let persistedBlocks: Block[] | null = null;
  try {
    const resp = await fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}`, {
      credentials: 'include',
    });
    if (!resp.ok) return;
    const json = await resp.json();
    const msgs = json?.session?.messages;
    if (!Array.isArray(msgs)) return;
    // Walk back to the most recent assistant entry — the one we just
    // finalized client-side. Skip entries that are still flagged streaming
    // (means our finalize hasn't been written to disk yet; the local copy
    // is the source of truth).
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.streaming) return;
      if (m?.role === 'assistant') {
        if (Array.isArray(m.blocks) && m.blocks.length) persistedBlocks = m.blocks as Block[];
        else if (typeof m.text === 'string' && m.text.length) persistedBlocks = [{ type: 'text', content: m.text }];
        break;
      }
    }
  } catch (_) { return; }
  if (!persistedBlocks) return;
  const localLen = _blockTextLen(localBlocks);
  const persistedLen = _blockTextLen(persistedBlocks);
  if (persistedLen <= localLen) return;
  // Only swap if this session is still the focused one — otherwise switchTo
  // will refetch fresh data on its own and our mutation would be stale.
  if (String(getAppState().currentSession || 'default') !== sid) return;
  const msgs = useChatStore.getState().messages as ChatMessage[];
  const lastAgentIdx = [...msgs].reverse().findIndex((m) => m.role === 'agent');
  if (lastAgentIdx < 0) return;
  const idx = msgs.length - 1 - lastAgentIdx;
  const agentEntry = msgs[idx];
  if (!agentEntry) return;
  agentEntry.blocks = persistedBlocks;
  delete agentEntry.text;
  delete agentEntry.typing;
  useChatStore.setState((s) => ({ messages: [...s.messages] as ChatMessage[] }));
  try { save.chat(); } catch (_) {}
}

// Recover a wedged local stream when the server has nothing live for this
// session. Two ways we get here:
//   (a) aliveCheck found no active stream on the bridge but our local state
//       is still localLive=true (lost _end chunk, post-grace GC, etc.);
//   (b) reconnectStream's EventSource onerror branch saw no live stream.
// We fetch the persisted snapshot and finalize the local bubble from it —
// but only when the persisted assistant message is NOT itself streaming.
// If disk still says streaming, the bridge hasn't given up yet (the
// _liveDeadline sweep will eventually finalize it on the server side);
// staying in localLive=true and re-checking later is the right move.
// Returns true if we finalized locally (caller should stop further checks).
async function _finalizeFromPersistedIfDone(sid: string): Promise<boolean> {
  type PersistedMsg = { role?: string; blocks?: Block[]; text?: string; streaming?: boolean; meta?: Record<string, unknown> };
  let persistedMsg: PersistedMsg | null = null;
  try {
    const resp = await fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}`, {
      credentials: 'include',
    });
    if (!resp.ok) return false;
    const json = await resp.json();
    const msgs = json?.session?.messages as PersistedMsg[] | undefined;
    if (!Array.isArray(msgs)) return false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role === 'assistant') { persistedMsg = m; break; }
    }
  } catch (_) { return false; }
  if (!persistedMsg || persistedMsg.streaming) return false;
  const blocks: Block[] = Array.isArray(persistedMsg.blocks) && persistedMsg.blocks.length
    ? persistedMsg.blocks as Block[]
    : (typeof persistedMsg.text === 'string' && persistedMsg.text.length
        ? [{ type: 'text', content: persistedMsg.text }]
        : []);
  if (!blocks.length) return false;
  if (String(getAppState().currentSession || 'default') === sid) {
    const storeMsgs = useChatStore.getState().messages as ChatMessage[];
    const lastAgentIdx = [...storeMsgs].reverse().findIndex((m) => m.role === 'agent');
    if (lastAgentIdx >= 0) {
      const idx = storeMsgs.length - 1 - lastAgentIdx;
      const agentEntry = storeMsgs[idx];
      if (agentEntry) {
        agentEntry.blocks = blocks;
        delete agentEntry.text;
        delete agentEntry.typing;
        useChatStore.setState((s) => ({ messages: [...s.messages] as ChatMessage[] }));
        try { save.chat(); } catch (_) {}
      }
    }
  }
  sessionLastSeq.delete(sid);
  sessionStreamAccumulator.delete(sid);
  return true;
}

// Probe the bridge/Go front door to decide whether a dropped or errored SSE
// connection should reattach (the turn is still alive or has buffered chunks
// to replay) or be surfaced as a terminal error (the turn genuinely failed).
// Go fronts the stream and keeps the harness subprocess running across a
// transient FE↔Go drop or a bridge hot-reload, so an `active` (or finalized-
// with-buffered-chunks) status means tokens are still recoverable via
// GET /v1/sessions/:id/stream — we must reconnect, not error out. A genuine
// failure (auth, 5xx, no stream entry) reports neither and falls through to
// the terminal path. Mirrors the inline litmus used after a clean SSE close.
async function _bridgeHasReplayableStream(sid: string): Promise<boolean> {
  try {
    const st = await session.streamStatus(sid);
    return !!st?.active || (st?.status === 'done' && (st?.chunksCount ?? 0) > 0);
  } catch (_) {
    // Probe itself failed (the FE↔Go hop is down right now). We can't prove
    // the turn is dead, and the bridge is the authority — assume replayable
    // so reconnectStream retries under its own capped backoff rather than
    // burning the turn on a momentary probe failure.
    return true;
  }
}

export const chatStreaming = {
  getSessionStreamState(sessionId: string | number | null): StreamState {
    const sid = String(sessionId || 'default');
    return sessionStreamState.get(sid) || { localLive: false, reconnecting: false, serverActive: false, status: 'idle' };
  },

  isSessionRunning(sessionId: string | number | null): boolean {
    const state = chatStreaming.getSessionStreamState(sessionId);
    return !!(state.localLive || state.reconnecting || state.serverActive);
  },

  setSessionStreamState(sessionId: string | number | null, patch: Partial<StreamState> = {}): void {
    const sid = String(sessionId || 'default');
    const next = { ...chatStreaming.getSessionStreamState(sid), ...patch };
    if (!next.localLive && !next.reconnecting && !next.serverActive) {
      sessionStreamState.delete(sid);
    } else {
      sessionStreamState.set(sid, next);
    }
    getChatActions().setSessionStreamState(sid, next);
    if (String(getAppState().currentSession || 'default') === sid) chat.updateStreamingUI();
  },

  invalidateReconnect(sessionId: string | number | null): number {
    const sid = String(sessionId || 'default');
    reconnectAttemptTokens.set(sid, ++_reconnectSeq);
    return reconnectAttemptTokens.get(sid)!;
  },

  isReconnectCurrent(sessionId: string | number | null, token: number): boolean {
    return reconnectAttemptTokens.get(String(sessionId || 'default')) === token;
  },

  clearAllowedTools(): void {
    sessionAllowedTools = [];
  },

  getAllowedTools(): string[] { return [...sessionAllowedTools]; },

  addAllowedTools(tools: string[]): void {
    sessionAllowedTools = [...new Set([...sessionAllowedTools, ...tools])];
  },

  async executeChatSend({ text = '', displayText, attachments = [], graphNode = null, recordInGraph = true }: {
    text?: string;
    displayText?: string;
    attachments?: Record<string, unknown>[];
    graphNode?: Record<string, unknown> | null;
    recordInGraph?: boolean;
  } = {}): Promise<{ output: string; blocks?: Block[]; nodeId?: string | null; placeholder?: HTMLElement; skipped?: boolean; stopped?: boolean; commandHandled?: boolean; error?: boolean }> {
    const trimmedText = String(text || '').trim();
    const currentAttachments = Array.isArray(attachments) ? attachments.slice() : [];
    const fullInput = chat.buildDisplayInput ? chat.buildDisplayInput(trimmedText, currentAttachments) : trimmedText;
    if (!fullInput) return { skipped: true, output: '' };
    // Caller may supply a distinct displayText (e.g. `#skill-foo`) when the
    // text actually sent to the model is an expansion. We only use it as a
    // short label for the graph node — the chat bubble itself always shows
    // the actually-sent text so the live render matches the persisted form
    // shown after reload (otherwise `#skill-foo` swaps to the expanded body
    // on refresh, surprising the user).
    const userDisplay = (typeof displayText === 'string' && displayText.trim()) ? displayText.trim() : fullInput;
    const currentSid = String(getAppState().currentSession || 'default');
    const currentStreamState = chatStreaming.getSessionStreamState(currentSid);
    const streamingHere = !!(currentStreamState && (currentStreamState.localLive || currentStreamState.serverActive));

    // Convenience shorthand for operator annotations after a dropped stream.
    // Users often type "server restarted" / "server restartet" as a human note
    // after a disconnect; keep it inline with the interrupted assistant turn.
    if (streamingHere && /^server\s+restart(?:ed|et)?\b/i.test(trimmedText)) {
      fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(currentSid)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'note', text: trimmedText })
      }).catch(() => {});
      return { output: trimmedText, commandHandled: true, skipped: true };
    }

    if (trimmedText.startsWith('#ns')) {
      await chat.startNewSession();
      return { output: '', commandHandled: true };
    }

    if (trimmedText.startsWith('#session')) {
      const rawArg = trimmedText.slice('#session'.length).trim();
      if (!rawArg || rawArg === '0') return { skipped: true, output: '' };
      const sessions = (await session.fetchList()) as unknown as Record<string, unknown>[];
      const currentId = String(session.getCurrentId());
      const normalizedArg = rawArg.replace(/^(['"])(.*)\1$/, '$2').trim();
      const idx = /^-?\d+$/.test(normalizedArg) ? parseInt(normalizedArg, 10) : NaN;
      let target: Record<string, unknown> | undefined;
      if (!isNaN(idx)) {
        if (idx === 0) return { skipped: true, output: '' };
        const relativeSessions = sessions.filter((s) => String(s['id']) !== currentId);
        target = relativeSessions[idx - 1];
      } else {
        target = sessions.find((s) => s['name'] === normalizedArg)
          || sessions.find((s) => String(s['id']) === normalizedArg)
          || sessions.find((s) => String(s['name'] || '').toLowerCase() === normalizedArg.toLowerCase());
      }
      if (target) {
        await session.switchTo(target['id'] as string | number);
        chat.pushMessage({ role: 'system', text: `Switched to "${target['name']}"` });
        await chat.refreshSessionList();
        return { output: `Switched to "${target['name']}"`, commandHandled: true };
      } else {
        chat.pushMessage({ role: 'error', text: `Session ${rawArg} not found` });
        return { output: `Session ${rawArg} not found`, commandHandled: true, error: true };
      }
    }

    if (trimmedText.startsWith('#note')) {
      const noteText = trimmedText.slice(5).trim();
      if (!noteText) return { skipped: true, output: '' };
      const sid = String(getAppState().currentSession || 'default');
      const streamState = chatStreaming.getSessionStreamState(sid);
      const isStreaming = !!(streamState && (streamState.localLive || streamState.serverActive));
      fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'note', text: noteText })
      }).catch(() => {});
      if (isStreaming) return { output: noteText, commandHandled: true };
      chat.pushMessage({ role: 'note', text: noteText });
      // Drop a graph node so the record visualizes the note alongside chats/tools.
      const _rec = getAppState().recordChat || 'all';
      if (_rec !== 'off') {
        const _gnodes = getGraphState().nodes;
        const lastNode = _gnodes[_gnodes.length - 1] as { id: string } | undefined;
        const pos = chat.gridPos ? chat.gridPos(_gnodes.length) : { x: 80, y: 80 };
        const noteNode = getGraphActions().addNode({ title: '#note', type: 'note', command: '#note ' + noteText, input: noteText, output: noteText, x: pos.x, y: pos.y, status: 'done' }) as unknown as Record<string, unknown>;
        if (lastNode && noteNode) getGraphActions().addLink(String(lastNode.id), String(noteNode['id']));
      }
      save.chat();
      return { output: noteText, commandHandled: true };
    }

    // #btw — mid-response injection. If a stream is active in this session,
    // POST to /v1/sessions/:id/btw so the bridge enqueues it for the next
    // tool-result roundtrip. Falls through to a regular #note when no stream
    // is live (so the user can also type #btw outside a stream).
    if (trimmedText.startsWith('#btw')) {
      const btwText = trimmedText.slice(4).trim();
      if (!btwText) return { skipped: true, output: '' };
      const sid = String(getAppState().currentSession || 'default');
      const streamState = chatStreaming.getSessionStreamState(sid);
      const isStreaming = !!(streamState && (streamState.localLive || streamState.serverActive));
      if (isStreaming) {
        // POST to /btw — the server inline-splices a `btw` block into the
        // active stream's blocks AND broadcasts a `btwBlock` chunk that we
        // pick up in the chunk handler above. We don't push anything here
        // ourselves, so the position is identical on live + reload.
        fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/btw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: btwText })
        }).catch(() => {});
      } else {
        // No active stream — persist as a top-level note message
        chat.pushMessage({ role: 'note', text: `#btw ${btwText}` });
        save.chat();
        fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'note', text: `#btw ${btwText}` })
        }).catch(() => {});
        // Record as graph node so the user sees it on the canvas like any other event.
        const _rec = getAppState().recordChat || 'all';
        if (_rec !== 'off') {
          const _gnodes = getGraphState().nodes;
          const lastNode = _gnodes[_gnodes.length - 1] as { id: string } | undefined;
          const pos = chat.gridPos ? chat.gridPos(_gnodes.length) : { x: 80, y: 80 };
          const btwNode = getGraphActions().addNode({ title: '#btw', type: 'note', command: `#btw ${btwText}`, input: btwText, output: btwText, x: pos.x, y: pos.y, status: 'done' }) as unknown as Record<string, unknown>;
          if (lastNode && btwNode) getGraphActions().addLink(String(lastNode.id), String(btwNode['id']));
        }
      }
      return { output: btwText, commandHandled: true };
    }

    // #debug / /debug — silent diagnostic. Don't push to chat or graph; fetch
    // the debug payload and open the modal directly. Bare `#debug` / `/debug`
    // opens the overview grid. Unknown subcommands fall back to a toast
    // listing valid options (the backend's 404 payload includes the list).
    // The `/debug` form mirrors `#debug` so users who think in slash-commands
    // (from the picker's `/` group) get the same behaviour as `#debug`.
    if (trimmedText.startsWith('#debug') || /^\/debug(\s|$)/.test(trimmedText)) {
      const subcmd = (trimmedText.split(/\s+/)[1] || 'overview').toLowerCase();
      const sid = String(getAppState().currentSession || 'default');
      try {
        const r = await fetch(`${api.config.baseUrl}/v1/debug/${encodeURIComponent(subcmd)}/${encodeURIComponent(sid)}`);
        const j = await r.json() as { success?: boolean; data?: Record<string, unknown>; error?: string; available?: string[] };
        if (j.success && j.data) {
          chat.showDebugModal(subcmd, j.data);
        } else if (j.available?.length) {
          getToastActions().show(`#debug subcommands: ${j.available.join(', ')}`, 'info', { duration: 4000 });
        } else {
          getToastActions().show(`#debug failed: ${j.error || 'unknown error'}`, 'error', { duration: 4000 });
        }
      } catch (e) {
        getToastActions().show(`#debug fetch failed: ${(e as Error).message}`, 'error', { duration: 4000 });
      }
      return { output: '', commandHandled: true, skipped: true };
    }

    const sentImages = currentAttachments
      .filter((a) => a['type'] === 'image')
      .map((a) => ({ name: String(a['name'] || ''), url: String(a['url'] || '') }));
    chat.pushMessage({ role: 'user', text: fullInput, ...(sentImages.length ? { images: sentImages } : {}) });
    const placeholder: HTMLElement = chat.pushMessage({ role: 'agent', text: '', typing: true });

    const sendSessionId = String(getAppState().currentSession || 'default');
    const abortCtrl = new AbortController();
    sessionAbortControllers.set(sendSessionId, abortCtrl);
    chatStreaming.invalidateReconnect(sendSessionId);
    // Each new send starts a fresh server-side stream whose _seq counter
    // restarts at 1. Drop any stale lastSeq + accumulator from the previous
    // stream so the dedup guard in onmessage doesn't drop chunks 1..N as
    // "already seen", and so the new stream renders to a clean bubble
    // instead of layering on top of the previous response's blocks.
    sessionLastSeq.delete(sendSessionId);
    sessionStreamAccumulator.delete(sendSessionId);
    chatStreaming.setSessionStreamState(sendSessionId, { localLive: true, reconnecting: false, serverActive: true, status: 'streaming' });

    let node = graphNode;
    const rec: string = getAppState().recordChat || 'all';
    if (!node && recordInGraph && rec !== 'off') {
      const _gnodes = getGraphState().nodes;
      const lastNode = _gnodes[_gnodes.length - 1] as { id: string; output?: string } | undefined;
      const pos = chat.gridPos ? chat.gridPos(_gnodes.length) : { x: 80, y: 80 };
      node = getGraphActions().addNode({ title: userDisplay.startsWith('#') ? userDisplay.split(' ')[0] : 'chat', type: userDisplay.startsWith('#') ? 'command' : 'chat', command: userDisplay, input: lastNode ? lastNode.output || '' : '', x: pos.x, y: pos.y, status: 'running' }) as unknown as Record<string, unknown>;
      if (lastNode && node) getGraphActions().addLink(String(lastNode.id), String(node['id']));
      if (node) sessionRecordingNodes.set(sendSessionId, { node, wasAutoCreated: true });
    }

    // Extract per-node agent config from chat nodes
    const nodeModel = node?.['nodeModel'] as string | undefined;
    const nodeModelProvider = node?.['nodeModelProvider'] as string | undefined;
    const nodePreset = node?.['nodePreset'] as string | undefined;
    const nodeSystemMode = node?.['nodeSystemMode'] as string | undefined;
    const nodeSkillSet = node?.['nodeSkillSet'] as string | undefined;
    const nodeToolSetPreset = node?.['nodeToolSetPreset'] as string | undefined;
    const nodeCapVision = node?.['nodeCapVision'] as boolean | undefined;
    const nodeCapReasoning = node?.['nodeCapReasoning'] as 'enabled' | 'disabled' | null | undefined;
    const nodeCapTools = node?.['nodeCapTools'] as 'on' | 'filter' | false | undefined;
    const hasNodeConfig = !!(nodeModel || nodeModelProvider || nodePreset || nodeSkillSet || nodeToolSetPreset || nodeCapVision !== undefined || nodeCapReasoning !== undefined || nodeCapTools !== undefined);
    const nodeCaps = hasNodeConfig && (nodeCapVision !== undefined || nodeCapReasoning !== undefined || nodeCapTools !== undefined)
      ? { vision: nodeCapVision ?? false, reasoning: nodeCapReasoning ?? null, tools: nodeCapTools ?? false }
      : undefined;
    // Freeze the picker model at send time. Picker changes made while this
    // response is already streaming apply only to the next prompt and must not
    // rewrite this turn's live/final meta. Backend chunks can later replace
    // this with a more precise model reported by the harness/provider.
    const turnModel = nodeModel || getAppState().currentModel?.name || null;

    const toolNodes = new Map<string, string>();
    const toolNames = new Map<string, string>();
    // BUGFIX 2026-04-30: removed `lastToolNodeId` / `lastCallName`. They used
    // to act as a fallback when toolResult.id failed to match — but that
    // fallback caused parallel tool results to be attributed to the wrong
    // call. Strict id matching only now; see toolResult handler below.
    let aggregateText = '';
    // Counts every child node attached to this stream's chat node — tool calls
    // AND #btw splices alike — so the spiral keeps growing without overlapping
    // entries from different chunk types.
    let childIdx = 0;
    let _permModalShownThisStream = false;
    const segments: Segment[] = [];
    let detachedInThisSend = false;
    // Tracks whether the SSE stream ever delivered an `_end` chunk. The bridge
    // emits one before res.end() on every regular chat path; if the reader
    // resolves without it, the connection was closed silently mid-stream
    // (proxy idle drop, Tailscale tunnel blip, mobile network reshuffle).
    // Used post-await to decide whether to finalize the bubble or treat as
    // a silent disconnect that reconnectStream should pick back up.
    let _endChunkSeen = false;
    let streamHadError = false;

    function createSegment(existingPlaceholder: HTMLElement | null = null): Segment {
      const el: HTMLElement = existingPlaceholder || chat.pushMessage({ role: 'agent', text: '', typing: true });
      const seg: Segment = { placeholder: el, blocks: [], liveText: '', streamStart: Date.now(), totalChars: 0, stopReason: null, inputTokens: 0, outputTokens: 0, durationMs: null, tokensPerSec: null, author: null, model: turnModel, finalized: false, toolCallCount: 0, apiCallCount: 0 };
      segments.push(seg);
      return seg;
    }

    let currentSeg = createSegment(placeholder);
    // Per-employee segment registry — used in "versus" multichat mode where
    // chunks from multiple authors interleave in parallel. Each chunk carries
    // an `_empId` that we route to its own bubble.
    const segByEmp = new Map<string, Segment>();
    function segForChunk(chunk: Record<string, unknown>): Segment {
      const empId = chunk['_empId'] as string | undefined;
      if (!empId) return currentSeg;
      const found = segByEmp.get(empId);
      if (found) return found;
      // First chunk for this emp. If currentSeg is still empty + unowned, claim it.
      if (!currentSeg.empId && !currentSeg.author && !segmentHasContent(currentSeg)) {
        currentSeg.empId = empId;
        segByEmp.set(empId, currentSeg);
        return currentSeg;
      }
      const fresh = createSegment();
      fresh.empId = empId;
      segByEmp.set(empId, fresh);
      return fresh;
    }
    let result: { output: string; blocks?: Block[]; nodeId?: string | null; placeholder?: HTMLElement; stopped?: boolean; error?: boolean } = { output: '', blocks: currentSeg.blocks, nodeId: (node?.['id'] as string | undefined) || null, placeholder: currentSeg.placeholder };

    function flushLiveText(seg: Segment = currentSeg): void {
      if (seg.liveText) { seg.blocks.push({ type: 'text', content: seg.liveText }); seg.liveText = ''; }
    }

    function segmentHasContent(seg: Segment = currentSeg): boolean {
      return !!(seg.liveText || seg.blocks.length);
    }

    function findToolCallBlock(seg: Segment | null, toolId: string | null | undefined, toolName: string): Block | null {
      if (!seg) return null;
      for (let i = seg.blocks.length - 1; i >= 0; i--) {
        const b = seg.blocks[i];
        if (b?.type !== 'tool-call') continue;
        if (toolId && b.toolId === toolId) return b;
        if (!toolId && toolName && b.name === toolName) return b;
      }
      return null;
    }

    function setSegmentAuthor(seg: Segment, author: Record<string, unknown>, model: string | null): void {
      seg.author = author || null;
      if (model) seg.model = model;
      const bubble = seg.placeholder.querySelector('.msg-bubble');
      const label = bubble?.querySelector('.msg-role-label') as HTMLElement | null;
      if (!label || !author) return;
      label.textContent = (String(author['name'] || author['id'] || '?'))[0].toUpperCase();
      label.classList.add('is-emp');
      label.title = `${author['name'] || author['id']}${author['role'] ? ' · ' + author['role'] : ''}`;
      if (author['symbolColor']) label.style.background = resolveAvatarColor(String(author['symbolColor']));
    }

    function finalizeSegment(seg: Segment = currentSeg, { stopReason = null, inputTokens = null, outputTokens = null, emptyText = null }: { stopReason?: string | null; inputTokens?: number | null; outputTokens?: number | null; emptyText?: string | null } = {}): void {
      if (!seg || seg.finalized) return;
      // Drop the live busy bar before the finalize render so syncLiveMetaBar
      // removes it; the canonical `.msg-meta` (set below) takes over.
      clearLiveMeta(seg.placeholder);
      flushLiveText(seg);
      if (!seg.blocks.length && emptyText) seg.blocks = [{ type: 'text', content: emptyText }];
      // Drop any pending throttled render for this placeholder so we don't
      // overwrite the about-to-be-final blocks with a stale frame.
      flushRenderNow(seg.placeholder);
      if (seg.blocks.length) chat.renderBlocks(seg.placeholder, seg.blocks);
      else chat.updateMessage(seg.placeholder, emptyText || '*(no response)*', 'agent');
      const durationMs = seg.durationMs != null ? seg.durationMs : (seg.streamStart ? Date.now() - seg.streamStart : 0);
      const tokenCount = Math.round(seg.totalChars / 4);
      const tokensPerSec = seg.tokensPerSec != null ? seg.tokensPerSec : (durationMs > 500 ? Math.round(tokenCount / (durationMs / 1000)) : 0);
      const _msgs = useChatStore.getState().messages as unknown as { _mid?: number; blocks?: Block[]; typing?: boolean; text?: string }[];
      const agentMsg = _msgs.find((m) => m._mid === +seg.placeholder.dataset['mid']!);
      if (agentMsg) {
        agentMsg.blocks = seg.blocks;
        delete agentMsg.typing;
        delete agentMsg.text;
        chat.setMsgMeta(seg.placeholder, agentMsg as unknown as ChatMessage, {
          model: seg.model || turnModel,
          ...(seg.author ? { author: seg.author } : {}),
          tokensPerSec,
          tokenCount,
          durationMs,
          stopReason: stopReason || seg.stopReason || 'end_turn',
          inputTokens: inputTokens ?? seg.inputTokens ?? 0,
          outputTokens: outputTokens ?? seg.outputTokens ?? 0
        });
      }
      seg.finalized = true;
      const _mid = +(seg.placeholder.dataset['mid'] || '0');
      if (_mid) {
        const finalText = seg.blocks.filter((b) => b.type === 'text').map((b) => b.content).join('\n');
        const _author = seg.author ? { name: String(seg.author['name'] || seg.author['id'] || ''), color: String(seg.author['symbolColor'] || '') } : null;
        window.dispatchEvent(new CustomEvent('yha-stream-text', { detail: { mid: _mid, text: finalText, done: true, author: _author } }));
      }
      // Sync in-place mutations (agentMsg.blocks, delete agentMsg.typing) to chatStore.
      _syncChatMessagesAfterMutation();
    }

    function _syncChatMessagesAfterMutation(): void {
      const store = useChatStore.getState();
      const messages = [...store.messages] as ChatMessage[];
      store.setMessages(messages);
      // Clear streaming segments whose messages have been finalized (typing removed).
      const typingMids = new Set(messages.filter((m) => m.typing).map((m) => String(m._mid)));
      const segments = store.streamingSegments;
      for (const mid of Object.keys(segments)) {
        if (!typingMids.has(mid)) store.clearStreamingSegment(mid);
      }
    }

    // Outer-layer stall watchdog. Belt-and-braces above api.ts's own
    // silence detector: if no SSE chunk has reached this onChunk for ~30s,
    // ask the backend whether it still considers the stream active. If yes,
    // the connection is wedged FE-side (e.g. heavy renderBlocks loop, proxy
    // buffer) — force-detach and let reconnectStream replay missing chunks,
    // matching what a manual page refresh does. 30s is roughly 3 missed
    // heartbeats (server emits one every 10 s); tick every 5 s so we react
    // promptly once the threshold trips.
    let lastChunkAt = Date.now();
    let aliveWatchdogFired = false;
    // 40 s > BE sseWriteDeadline (30 s, go-core sse_write.go) so the BE
    // concedes a stuck write first. Heartbeat cadence is 10 s, so 40 s
    // is ~4 missed heartbeats — well clear of normal jitter, but still
    // tight enough to recover within a minute on a real silent drop.
    const ALIVE_MS = 40000;
    async function aliveCheck(reason: string): Promise<void> {
      if (aliveWatchdogFired) return;
      if (Date.now() - lastChunkAt < ALIVE_MS) return;
      try {
        const status = await session.streamStatus(sendSessionId);
        if (Date.now() - lastChunkAt < ALIVE_MS) return;
        if (status?.active) {
          aliveWatchdogFired = true;
          _detachedSessions.add(sendSessionId);
          abortCtrl.abort();
          Promise.resolve().then(() => chatStreaming.reconnectStream(sendSessionId, status));
          return;
        }
        // Server says no active stream but we've been silent for >30 s with a
        // localLive placeholder waiting. Either the bridge finalized and we
        // missed `_end` to a TCP race, or the activeStream entry already
        // expired its 60 s grace. Try to recover from the persisted snapshot;
        // if disk also still has streaming=true, give it more time (the
        // bridge-side _liveDeadline sweep will finalize on its own).
        const finalized = await _finalizeFromPersistedIfDone(sendSessionId);
        if (finalized) {
          aliveWatchdogFired = true;
          _detachedSessions.add(sendSessionId);
          abortCtrl.abort();
        }
      } catch (_) { void reason; }
    }
    const aliveWatchdog = setInterval(() => { aliveCheck('interval'); }, 5000);
    // Visibility wakeup: setInterval is throttled to ~1Hz in background tabs
    // and may be paused entirely after several minutes. Without this hook a
    // tab backgrounded across a silent disconnect would only react after the
    // next throttled tick when the user returns; instead, fast-path a check
    // synchronously on visibilitychange→visible.
    const onVisibleSend = () => { if (document.visibilityState === 'visible') aliveCheck('visibility'); };
    document.addEventListener('visibilitychange', onVisibleSend);

    try {
      const streamOpts: Record<string, unknown> = { signal: abortCtrl.signal };
      if (currentAttachments.length) streamOpts['attachments'] = currentAttachments;
      if (sessionAllowedTools.length && getAppState().caps?.tools !== 'filter') streamOpts['allowedTools'] = [...sessionAllowedTools];
      if (nodeModel) streamOpts['model'] = nodeModel;
      if (nodeModelProvider) streamOpts['provider'] = nodeModelProvider;
      if (nodePreset && nodeSystemMode && nodeSystemMode !== 'off') { streamOpts['preset'] = nodePreset; streamOpts['systemMode'] = nodeSystemMode; }
      else if (nodePreset && !nodeSystemMode) { streamOpts['preset'] = nodePreset; streamOpts['systemMode'] = 'replace'; }
      if (nodeSkillSet !== undefined) streamOpts['skillSet'] = nodeSkillSet;
      if (nodeToolSetPreset) streamOpts['toolSetPreset'] = nodeToolSetPreset;
      if (nodeCaps) streamOpts['caps'] = nodeCaps;
      await api.stream(fullInput, (chunk: Record<string, unknown>) => {
        lastChunkAt = Date.now();
        // Track highest seq even on the initial POST path so a mid-POST
        // silent disconnect → reconnect via /v1/sessions/:id/stream can
        // resume from where the connection broke instead of replaying the
        // tail buffer (or worse, missing chunks).
        if (typeof chunk['_seq'] === 'number') {
          const prev = sessionLastSeq.get(sendSessionId) || 0;
          if ((chunk['_seq'] as number) > prev) sessionLastSeq.set(sendSessionId, chunk['_seq'] as number);
        }
        const seg = segForChunk(chunk);
        if (chunk['error']) {
          if (chunk['_end']) _endChunkSeen = true;
          streamHadError = true;
          const msg = String(chunk['error'] || 'Chat error');
          markPlaceholderAsError(seg.placeholder, msg);
          chat.updateMessage(seg.placeholder, '**Error:** ' + msg, 'error');
          void persistChatErrorMessage(sendSessionId, msg);
          save.chat();
          if (node) graph.updateNode(String(node.id), { output: msg, status: 'error' });
          result = { output: msg, blocks: seg.blocks, nodeId: (node?.['id'] as string | undefined) || null, placeholder: seg.placeholder, error: true };
          finalizeSegment(seg, { stopReason: 'error' });
          return;
        }
        if (chunk['author']) {
          if (chunk['_empId']) {
            // Versus mode: the per-emp seg is already chosen via segForChunk.
            // Just stamp the author/model onto it.
            setSegmentAuthor(seg, chunk['author'] as Record<string, unknown>, chunk['model'] as string | null);
            if (seg === currentSeg) { result.placeholder = seg.placeholder; result.blocks = seg.blocks; }
            return;
          }
          // Sequential mode: on author change, finalize current and start a new bubble.
          const currentAuthorKey = currentSeg.author ? String(currentSeg.author['id'] || currentSeg.author['name'] || '') : '';
          const nextAuthorKey = String((chunk['author'] as Record<string, unknown>)['id'] || (chunk['author'] as Record<string, unknown>)['name'] || '');
          if (segmentHasContent(currentSeg) && currentAuthorKey && currentAuthorKey !== nextAuthorKey) {
            finalizeSegment(currentSeg);
            currentSeg = createSegment();
          }
          setSegmentAuthor(currentSeg, chunk['author'] as Record<string, unknown>, chunk['model'] as string | null);
          result.placeholder = currentSeg.placeholder;
          result.blocks = currentSeg.blocks;
          return;
        }
        if ((chunk['skillsActive'] as unknown[] | undefined)?.length) {
          const bar = document.createElement('div');
          bar.className = 'skills-active-bar';
          bar.innerHTML = `<span class="skills-bar-icon">${iconSvg('hexagon', 13)}</span><span class="skills-bar-label">Skills:</span>` + (chunk['skillsActive'] as string[]).map((n) => `<span class="skills-bar-tag">${chatUtils.escHtml(n)}</span>`).join('');
          seg.placeholder.insertAdjacentElement('beforebegin', bar);
          return;
        }
        if (chunk['_end']) {
          _endChunkSeen = true;
          if (chunk['model']) seg.model = String(chunk['model']);
          seg.stopReason = chunk['stopReason'] as string || (seg.blocks.some((b) => b.type === 'tool-call') ? 'tool_use' : 'end_turn');
          // Show the true prompt size: Anthropic (native API + claude-binary)
          // reports inputTokens as the uncached delta only (often ~2 under
          // prompt caching) and puts the bulk in cacheRead/cacheCreation —
          // disjoint counts, so summing is the real "tokens in". Without this
          // the bar reads "2" and looks broken.
          const _inTok = ((chunk['inputTokens'] as number) || 0) + ((chunk['cacheReadTokens'] as number) || 0) + ((chunk['cacheCreationTokens'] as number) || 0);
          if (_inTok) seg.inputTokens = _inTok;
          if (chunk['outputTokens']) seg.outputTokens = chunk['outputTokens'] as number;
          if (chunk['durationMs'] != null) seg.durationMs = chunk['durationMs'] as number;
          if (chunk['tokensPerSec'] != null) seg.tokensPerSec = chunk['tokensPerSec'] as number;
          if (chunk['cost'] !== undefined) {
            if (!chunk['mediaCost']) {
              getAppActions().setTokens({ ...getAppState().tokens, cost: chunk['cost'] as number });
            }
          }
          clearLiveMeta(seg.placeholder);
          return;
        }
        if (chunk['_live']) {
          // Authoritative live counters from the backend's per-turn ticker.
          // Paint the busy meta bar from the turn's start; the terminal
          // `_end` chunk later supersedes these with final totals.
          // Fold cache tokens into the displayed input (see _end above).
          // Only bump when >0 so an early tick that arrives before the first
          // usage block doesn't flicker the readout back to 0.
          const _inTokLive = ((chunk['inputTokens'] as number) || 0) + ((chunk['cacheReadTokens'] as number) || 0) + ((chunk['cacheCreationTokens'] as number) || 0);
          if (_inTokLive > 0) seg.inputTokens = _inTokLive;
          if (chunk['model']) seg.model = String(chunk['model']);
          // Live output readout: the backend reports claude-binary's per-MESSAGE
          // output, which resets to single digits on every tool round-trip — a
          // useless running total (it's what made the live bar read "5" for a
          // multi-part turn). Estimate from streamed chars instead (text +
          // thinking; see the reasoning handler that feeds totalChars) so the
          // counter climbs monotonically. The terminal `_end` chunk supersedes
          // this with the authoritative per-turn total.
          const _outEstLive = Math.round(seg.totalChars / 4);
          seg.outputTokens = Math.max(_outEstLive, (chunk['outputTokens'] as number) || 0);
          if (chunk['toolCallCount'] != null) seg.toolCallCount = chunk['toolCallCount'] as number;
          if (chunk['apiCallCount'] != null) seg.apiCallCount = chunk['apiCallCount'] as number;
          applyLiveMeta(seg.placeholder, { in: seg.inputTokens, out: seg.outputTokens, tools: seg.toolCallCount, api: seg.apiCallCount, start: seg.streamStart, model: seg.model || turnModel || undefined });
          // Lightweight bar-only update: counters changed, content (blocks/liveText)
          // did not. A full scheduleRender → renderBlocks call rebuilds the entire
          // bubble HTML (potentially 100 KB+ for long tool-heavy turns) and fires
          // setStreamingSegment → React re-render on every 1 s tick — progressive
          // main-thread degradation proportional to accumulated tool results.
          // Instead, stamp the dataset on the live on-screen element and update
          // only the small .msg-meta.is-live bar. Content renders happen via
          // scheduleRender only when blocks/liveText actually change (below).
          { const _lm2 = _midOf(seg.placeholder); if (_lm2 != null) { const _le = _resolveLive(_lm2); if (_le) { const _lv = _liveMetaByMid.get(_lm2); if (_lv) { _writeLiveDataset(_le, _lv); chatRendering.syncLiveMetaBar(_le); } } } }
          return;
        }
        if (chunk['reasoning']) {
          const r = String(chunk['reasoning']);
          // Thinking tokens count toward output. Fold reasoning length into the
          // char tally so the live output estimate (totalChars/4) reflects the
          // model's reasoning, which is often the bulk of a turn's output.
          seg.totalChars += r.length;
          const last = seg.blocks[seg.blocks.length - 1];
          if (last && last.type === 'thinking') last.content = (last.content || '') + r;
          else { flushLiveText(seg); seg.blocks.push({ type: 'thinking', content: r }); }
          scheduleRender(seg.placeholder, seg.blocks, seg.liveText);
        }
        if (chunk['text'] || chunk['delta']) {
          const t = String(chunk['text'] || chunk['delta'] || '');
          aggregateText += t;
          seg.totalChars += t.length;
          seg.liveText += t;
          scheduleRender(seg.placeholder, seg.blocks, seg.liveText);
          const _mid = +(seg.placeholder.dataset['mid'] || '0');
          if (_mid) {
            const _author = seg.author ? { name: String(seg.author['name'] || seg.author['id'] || ''), color: String(seg.author['symbolColor'] || '') } : null;
            window.dispatchEvent(new CustomEvent('yha-stream-text', { detail: { mid: _mid, text: aggregateText, done: false, author: _author } }));
          }
        }
        if (chunk['liveTextSet'] != null) {
          const newText = String(chunk['liveTextSet']);
          aggregateText = aggregateText.slice(0, aggregateText.length - seg.liveText.length) + newText;
          seg.liveText = newText;
          scheduleRender(seg.placeholder, seg.blocks, seg.liveText);
        }
        if (chunk['hermesPrompt']) {
          _attachHermesPromptRow(seg.placeholder, chunk['hermesPrompt'] as Record<string, unknown>, sendSessionId);
        }
        if (chunk['toolUse']) {
          const tu = chunk['toolUse'] as Record<string, unknown>;
          const tuId = tu['id'] as string | undefined;
          const name = tu['name'] as string;
          const input = tu['input'];
          // Always register id → name so the matching toolResult chunk can be
          // labeled correctly. Previously this lived inside the graph branch
          // below, so when recordChat === 'no-tools' the map stayed empty and
          // every result rendered as `orphan:toolu_…` until a reload replayed
          // the stream through reconnectStream (which populates unconditionally).
          if (tuId) toolNames.set(tuId, name);
          // Pet fight signal — fired regardless of recordChat mode so the pet
          // still battles tool-calls even when the user is on no-tools/off
          // (the older path keyed off graphStore.nodes[type=tool, status=running]
          // which was empty in those modes, hence the regression where the pet
          // stopped fighting). One event per toolUse chunk; the pet store
          // applies its own probability gating inside the listener.
          try {
            window.dispatchEvent(new CustomEvent('yha:tool-call-started', {
              detail: { id: tuId || null, name },
            }));
          } catch { /* no-op */ }
          if (node && (graphNode || rec === 'all')) {
            // Dedup ONLY by toolId — the same tool name (e.g. Read) called many
            // times with different args must each get its own node.
            const existingToolNodeId = tuId ? toolNodes.get(tuId) : null;
            if (existingToolNodeId) {
              graph.updateNode(existingToolNodeId as string, { title: name, command: JSON.stringify(input || {}), input: JSON.stringify(input || {}), status: 'running' });
            } else {
              const toolPos = chat.spiralPos
                ? chat.spiralPos(node, childIdx++)
                : (chat.gridPos ? chat.gridPos(getGraphState().nodes.length) : { x: 80, y: 80 });
              const toolNode = graph.addNode({ title: name, type: 'tool', command: JSON.stringify(input || {}), input: JSON.stringify(input || {}), x: toolPos.x, y: toolPos.y, status: 'running' }) as { id: string };
              graph.addLink(String(node.id), String(toolNode.id));
              if (tuId) toolNodes.set(tuId, toolNode.id);
            }
          }
          // Boundary signal for VoiceMode: speak any unspoken pending text
          // before the tool call interrupts the text stream. Without this,
          // mid-sentence fragments without trailing punctuation would only
          // be read at the final done:true (after all tool calls).
          {
            const _mid = +(seg.placeholder.dataset['mid'] || '0');
            if (_mid) {
              const _author = seg.author ? { name: String(seg.author['name'] || seg.author['id'] || ''), color: String(seg.author['symbolColor'] || '') } : null;
              window.dispatchEvent(new CustomEvent('yha-stream-text', { detail: { mid: _mid, text: aggregateText, done: false, flush: true, author: _author } }));
            }
          }
          flushLiveText(seg);
          // Suppress the regular tool-call pill for AskUser — the
          // askUserQuestion chunk that follows renders an interactive form
          // which is the better representation. Same for the answered-summary
          // chunk that lands later. The pet/graph signals above still fire so
          // tool counts and pet behavior stay consistent.
          const isAskUser = name === 'mcp__MCP-Tools__bridge__AskUser';
          if (!isAskUser) {
            const existingBlock = findToolCallBlock(seg, tuId, name);
            if (existingBlock) { existingBlock.name = name; existingBlock.detail = input || {}; }
            else seg.blocks.push({ type: 'tool-call', name, detail: input || {}, toolId: tuId || null });
          }
          scheduleRender(seg.placeholder, seg.blocks, '');
        }
        if (chunk['toolResult']) {
          // BUGFIX 2026-04-30: Strict id matching for tool-result → tool-call.
          // Previously we fell back to `lastToolNodeId` / `lastCallName` when the
          // id lookup missed, which scrambled results across parallel tool calls
          // (e.g. WebSearch result rendered under a Bash call). Now: only attach
          // by id; if no match, render as an orphan result with the raw id, so
          // the bug becomes visible instead of silently mis-attributing.
          // Also persist `toolId` on the result block so reload/replay can pair
          // them by id (lookup logic in the replay branch below relies on it).
          const tr = chunk['toolResult'] as Record<string, unknown>;
          const trId = tr['id'] as string | undefined;
          const nid = trId ? toolNodes.get(trId) : null;
          if (nid) graph.updateNode(nid, { output: tr['content'], status: 'done' });
          const matchedName = trId ? toolNames.get(trId) : undefined;
          const resultName = matchedName || (trId ? `orphan:${trId}` : 'orphan');
          // See AskUser tool-call branch above — suppress the redundant
          // tool-result pill since the askUserQuestion form already shows
          // the resolved answer in its answered state.
          if (matchedName !== 'mcp__MCP-Tools__bridge__AskUser') {
            seg.blocks.push({ type: 'tool-result', name: resultName, detail: tr['content'] || '', toolId: trId || null });
          }
          scheduleRender(seg.placeholder, seg.blocks, '');
        }
        if (chunk['btwBlock']) {
          // Server signals a #btw user injection at this chronological position
          // in the stream. Treat exactly like a tool block — flush pending text
          // first, then push as its own block so it lives inside the assistant
          // message's blocks array (preserves position on reload).
          const bb = chunk['btwBlock'] as Record<string, unknown>;
          flushLiveText(seg);
          const lp = bb['livePath'];
          const livePath = (lp === 'direct' || lp === 'harness' || lp === 'unknown') ? lp : 'unknown';
          seg.blocks.push({ type: 'btw', text: String(bb['text'] || ''), livePath });
          scheduleRender(seg.placeholder, seg.blocks, '');
          // Also drop a graph node so the record reflects the user-side mid-stream insertion.
          if (node && rec !== 'off') {
            const bbPos = chat.spiralPos
              ? chat.spiralPos(node, childIdx++)
              : (chat.gridPos ? chat.gridPos(getGraphState().nodes.length) : { x: 80, y: 80 });
            const btwNode = graph.addNode({ title: '#btw', type: 'note', command: '#btw ' + String(bb['text'] || ''), input: String(bb['text'] || ''), x: bbPos.x, y: bbPos.y, status: 'done' }) as { id: string };
            graph.addLink(String(node.id), String(btwNode.id));
          }
        }
        if (chunk['askUserQuestion']) {
          // Bridge AskUser tool emitted a pending question. Render as an
          // inline form block; the user submit will POST to
          // /v1/sessions/:id/answer-question, and chat.ts handles the click.
          const aq = chunk['askUserQuestion'] as Record<string, unknown>;
          flushLiveText(seg);
          seg.blocks.push({
            type: 'ask-user-question',
            questionId: String(aq['id'] || ''),
            questions: (aq['questions'] as Block['questions']) || [],
            answered: false,
          });
          scheduleRender(seg.placeholder, seg.blocks, '');
        }
        if (chunk['askUserQuestionAnswered']) {
          // Bridge confirmed the answer was accepted. Find the matching
          // ask-user-question block and flip it to the answered state so the
          // form is replaced by the resolved summary. Done across all
          // segments + the persisted message — answer arrives after the
          // turn that emitted it has already been finalized in many flows.
          const aa = chunk['askUserQuestionAnswered'] as Record<string, unknown>;
          const targetId = String(aa['id'] || '');
          const summary = String(aa['summary'] || '');
          const markAnswered = (blocks: Block[] | undefined) => {
            if (!blocks) return false;
            for (const blk of blocks) {
              if (blk.type === 'ask-user-question' && blk.questionId === targetId) {
                blk.answered = true;
                blk.answerSummary = summary;
                return true;
              }
            }
            return false;
          };
          let updated = false;
          for (const s of segments) {
            if (markAnswered(s.blocks)) {
              scheduleRender(s.placeholder, s.blocks, s.liveText);
              updated = true;
            }
          }
          // Also sweep the persisted message store — older messages that
          // were finalized before the answer arrived live there, not in any
          // active segment.
          if (!updated) {
            try {
              const msgs = useChatStore.getState().messages as ChatMessage[];
              const next = msgs.map((m) => {
                if (!m.blocks) return m;
                let touched = false;
                const nb = m.blocks.map((blk) => {
                  if (blk.type === 'ask-user-question' && blk.questionId === targetId) {
                    touched = true;
                    return { ...blk, answered: true, answerSummary: summary };
                  }
                  return blk;
                });
                return touched ? { ...m, blocks: nb } : m;
              });
              useChatStore.getState().setMessages(next);
              // Re-render any DOM message currently showing this question id
              // so the open form swaps to the answered summary without waiting
              // for an incidental rerender.
              try {
                document.querySelectorAll<HTMLElement>(`.ask-user-block[data-question-id="${CSS.escape(targetId)}"]`).forEach((el) => {
                  const msgEl = el.closest('.msg') as HTMLElement | null;
                  if (!msgEl) return;
                  const mid = +(msgEl.dataset['mid'] || '0');
                  const msg = next.find((m) => m._mid === mid);
                  if (!msg) return;
                  try { chat.renderBlocks(msgEl, msg.blocks || [], ''); } catch (_) { /* swallow */ }
                });
              } catch (_) { /* DOM may be unavailable */ }
            } catch (_) { /* tolerate missing store hook */ }
          }
        }
        if (chunk['interruptBlock']) {
          flushLiveText(seg);
          seg.blocks.push({
            type: 'interrupt',
            kind: String((chunk['interruptBlock'] as Record<string, unknown>)['kind'] || 'note'),
            text: String((chunk['interruptBlock'] as Record<string, unknown>)['text'] || ''),
            ts: Number((chunk['interruptBlock'] as Record<string, unknown>)['ts'] || Date.now()),
            bufferedChunks: Number((chunk['interruptBlock'] as Record<string, unknown>)['bufferedChunks'] || 0) || undefined,
            chunkCap: Number((chunk['interruptBlock'] as Record<string, unknown>)['chunkCap'] || 0) || undefined,
            approxTailMs: Number((chunk['interruptBlock'] as Record<string, unknown>)['approxTailMs'] || 0) || undefined,
            postFinishGraceMs: Number((chunk['interruptBlock'] as Record<string, unknown>)['postFinishGraceMs'] || 0) || undefined,
            replayedCount: Number((chunk['interruptBlock'] as Record<string, unknown>)['replayedCount'] || 0) || undefined,
            fromSeq: Number((chunk['interruptBlock'] as Record<string, unknown>)['fromSeq'] || 0) || undefined,
            gapMs: Number((chunk['interruptBlock'] as Record<string, unknown>)['gapMs'] || 0) || undefined,
            elapsedMs: Number((chunk['interruptBlock'] as Record<string, unknown>)['elapsedMs'] || 0) || undefined,
            partialLen: Number((chunk['interruptBlock'] as Record<string, unknown>)['partialLen'] || 0) || undefined,
            model: String((chunk['interruptBlock'] as Record<string, unknown>)['model'] || '') || undefined,
            provider: String((chunk['interruptBlock'] as Record<string, unknown>)['provider'] || '') || undefined,
          });
          scheduleRender(seg.placeholder, seg.blocks, '');
        }
        if ((chunk['permissionDenials'] as unknown[] | undefined)?.length && !_permModalShownThisStream) {
          _permModalShownThisStream = true;
          chat.showPermissionModal(chunk['permissionDenials'] as Array<{ tool_name: string; tool_input?: Record<string, string> }>);
        }
        if (chunk['debugModal']) chat.showDebugModal(chunk['debugModal'] as string, chunk['debugData'] as Record<string, unknown>);
        if (chunk['cost'] !== undefined) {
          if (!chunk['mediaCost']) {
            getAppActions().setTokens({ ...getAppState().tokens, cost: chunk['cost'] as number });
          }
        }
        // Mirror the active segment's accumulated state into the per-session
        // accumulator so a mid-POST silent disconnect → reconnectStream can
        // resume on top of what's already rendered (instead of wiping the
        // bubble back to whatever delta the server sent for fromSeq=N).
        // Versus mode with multiple parallel segments: only the active one
        // (matching the placeholder we'd reattach to) is mirrored — multi-
        // segment reconnect is a separate concern out of scope here.
        {
          const aSeg = segForChunk(chunk);
          let aAcc = sessionStreamAccumulator.get(sendSessionId);
          if (!aAcc) { aAcc = _initAccumulator(); sessionStreamAccumulator.set(sendSessionId, aAcc); }
          aAcc.blocks = aSeg.blocks;
          aAcc.liveText = aSeg.liveText;
          aAcc.rcStreamStart = aSeg.streamStart || null;
          aAcc.rcTotalChars = aSeg.totalChars;
          aAcc.rcStopReason = aSeg.stopReason;
          aAcc.rcInputTokens = aSeg.inputTokens;
          aAcc.rcOutputTokens = aSeg.outputTokens;
          aAcc.rcAuthor = aSeg.author;
          aAcc.rcModel = aSeg.model;
        }
      }, streamOpts);

      // SSE reader returned `done` — but did we ever see the bridge's `_end`?
      // Every regular chat path emits one before res.end(); if it's missing,
      // the connection was closed silently mid-stream (proxy idle drop,
      // tunnel blip, mobile network). The aliveCheck watchdog only catches
      // a 30 s silence, not a clean TCP close after recent chunks. Probe
      // the bridge — if it has more buffered chunks (either still streaming
      // OR finalized but with chunks we never received), throw the same
      // synthetic StreamTimeoutError the silence-watchdog uses so the catch
      // path queues a reconnect. The GET /v1/sessions/:id/stream endpoint
      // replays the tail (and synthesizes `_end` for `status:'done'` if the
      // buffered chunk was pruned), so a bridge that finalized between the
      // silent close and this probe still delivers its final tokens instead
      // of leaving the bubble cut off until the user reloads. Skip when
      // there is no stream entry at all — `#`-commands and hash tools end
      // without `_end` by design and `streamStatus` returns `{active:false}`
      // with no `status` field for those.
      if (!_endChunkSeen) {
        let needsReconnect = false;
        try {
          const st = await session.streamStatus(sendSessionId);
          needsReconnect = !!st?.active || (st?.status === 'done' && (st?.chunksCount ?? 0) > 0);
        } catch (_) { /* network probe failed — assume legitimate end */ }
        if (needsReconnect) {
          const e = new Error('SSE closed without _end — bridge has buffered chunks to replay');
          e.name = 'StreamTimeoutError';
          throw e;
        }
      }

      // Finalize every segment — `versus` mode produces several parallel ones
      // and we must finalize all, not just the most recent.
      for (const _s of segments) {
        if (_s.finalized) continue;
        finalizeSegment(_s, { stopReason: _s.stopReason, inputTokens: _s.inputTokens, outputTokens: _s.outputTokens, emptyText: '*(no response)*' });
      }
      // Same belt-and-suspenders reconcile as the reconnect-stream finish path
      // (see finish('done') in reconnectStream). Covers the rare initial-POST
      // race where the visible blocks differ from what the bridge persisted —
      // e.g. a render that lost trailing tokens to an interaction-induced
      // batching gap. Versus mode picks the last segment's blocks; multi-
      // segment reconcile is out of scope.
      if (currentSeg?.blocks?.length) {
        _reconcilePersistedSnapshot(sendSessionId, currentSeg.blocks).catch(() => {});
      }
      if (node && !streamHadError) {
        const nodePatch: Record<string, unknown> = { output: aggregateText, status: 'done' };
        // Record mode: stamp actual model/provider/skillSet used onto the node
        // (only for auto-created record nodes, not for nodes that already have explicit config)
        if (!graphNode && node['type'] === 'chat') {
          const _s = getAppState();
          if (!node['nodeModel']) nodePatch['nodeModel'] = currentSeg.model || _s.currentModel?.name || '';
          if (!node['nodeModelProvider']) nodePatch['nodeModelProvider'] = (_s.currentModel as { provider?: string })?.provider || '';
          if (!node['nodeSkillSet']) nodePatch['nodeSkillSet'] = _s.skillSet || '';
          const _sysPrompt = _s.sysPrompt?.selection;
          if (!node['nodePreset'] && _sysPrompt?.mode && _sysPrompt.mode !== 'off' && _sysPrompt.preset) {
            nodePatch['nodePreset'] = _sysPrompt.preset;
            nodePatch['nodeSystemMode'] = _sysPrompt.mode;
          }
          if (node['nodeCapVision'] === undefined) nodePatch['nodeCapVision'] = _s.caps?.vision ?? false;
          if (node['nodeCapReasoning'] === undefined) nodePatch['nodeCapReasoning'] = _s.caps?.reasoning ?? null;
          if (node['nodeCapTools'] === undefined) nodePatch['nodeCapTools'] = _s.caps?.tools ?? false;
        }
        sessionRecordingNodes.delete(sendSessionId);
        graph.updateNode(String(node.id), nodePatch);
      }
      if (!streamHadError && _toastEventEnabled('chat:done')) {
        const _model = currentSeg.model || getAppState().currentModel?.name;
        const _preview = String(aggregateText || '').replace(/\s+/g, ' ').slice(0, 80);
        getToastActions().show(_preview || 'Response received', 'success', {
          title: _model ? `${_model}` : undefined,
          duration: 2500,
        });
      }
      if (!streamHadError) {
        result = { output: aggregateText, blocks: currentSeg.blocks, nodeId: (node?.['id'] as string | undefined) || null, placeholder: currentSeg.placeholder };
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        const wasDetached = _detachedSessions.has(sendSessionId);
        _detachedSessions.delete(sendSessionId);
        detachedInThisSend = wasDetached;
        if (wasDetached) {
          const _placeholderMid = +currentSeg.placeholder.dataset['mid']!;
          useChatStore.getState().removeMessage(_placeholderMid);
          currentSeg.placeholder.remove();
          if (node) graph.updateNode(String(node.id), { status: 'running' });
        } else {
          finalizeSegment(currentSeg, { stopReason: 'stopped', inputTokens: currentSeg.inputTokens, outputTokens: currentSeg.outputTokens, emptyText: '*(stopped)*' });
          if (node) graph.updateNode(String(node.id), { output: aggregateText || '(stopped)', status: 'done' });
          result = { output: aggregateText || '(stopped)', blocks: currentSeg.blocks, nodeId: (node?.['id'] as string | undefined) || null, stopped: true, placeholder: currentSeg.placeholder };
        }
      } else if (err.name === 'StreamTimeoutError') {
        sessionAbortControllers.delete(sendSessionId);
        detachedInThisSend = true;
        // Don't remove the placeholder. Previously we removed it + relied on
        // reconnectStream to push a fresh one, which left the bubble visibly
        // empty for the round-trip — and after `?fromSeq=N` the new placeholder
        // only got the missed delta, making it look like the response had
        // been "reset to nothing". Leave the existing message in place so
        // reconnectStream's reuse path picks it up and the persisted
        // accumulator continues rendering on top of it.
        Promise.resolve().then(() => chatStreaming.reconnectStream(sendSessionId, { active: true, status: 'streaming' }));
      } else if (await _bridgeHasReplayableStream(sendSessionId)) {
        // A thrown error here is almost always a transport drop — the fetch
        // reader rejects with a TypeError ("network error" / "Failed to
        // fetch" / "terminated") on a tunnel blip, a bridge hot-reload, or a
        // mobile-network reshuffle. The harness turn itself runs detached in
        // Go and keeps streaming; Go just confirmed it's still active or has
        // buffered chunks to replay. Surfacing a terminal "**Error: network
        // error**" here (the old behaviour) killed the bubble even though the
        // response was still coming. Instead reattach exactly like the
        // StreamTimeoutError path: keep the placeholder, let reconnectStream
        // replay from sessionLastSeq under its own capped backoff (which
        // falls back to the persisted snapshot / a toast if Go is truly gone).
        sessionAbortControllers.delete(sendSessionId);
        detachedInThisSend = true;
        Promise.resolve().then(() => chatStreaming.reconnectStream(sendSessionId, { active: true, status: 'streaming' }));
      } else {
        const msg = String(err.message || 'Chat error');
        if (node) graph.updateNode(String(node.id), { output: msg, status: 'error' });
        markPlaceholderAsError(currentSeg.placeholder, msg);
        chat.updateMessage(currentSeg.placeholder, '**Error:** ' + msg, 'error');
        await persistChatErrorMessage(sendSessionId, msg);
        save.chat();
        result = { output: msg, blocks: currentSeg.blocks, nodeId: (node?.['id'] as string | undefined) || null, placeholder: currentSeg.placeholder, error: true };
      }
    } finally {
      clearInterval(aliveWatchdog);
      try { document.removeEventListener('visibilitychange', onVisibleSend); } catch (_) {}
      if (aliveWatchdogFired) detachedInThisSend = true;
      _detachedSessions.delete(sendSessionId);
      sessionAbortControllers.delete(sendSessionId);
      if (detachedInThisSend) chatStreaming.setSessionStreamState(sendSessionId, { localLive: false, reconnecting: false, serverActive: true, status: 'streaming' });
      else {
        chatStreaming.setSessionStreamState(sendSessionId, { localLive: false, reconnecting: false, serverActive: false, status: 'idle' });
        // If the stream finished while this session is the focused one, bump
        // viewedAt so the just-arrived agent message doesn't briefly show as
        // unread when the user switches away.
        if (String(getAppState().currentSession || 'default') === String(sendSessionId)) {
          try { session?.markViewed?.(sendSessionId); } catch (_) {}
        }
      }
    }
    save.graph();
    save.chat();
    return result;
  },

  async reconnectStream(sessionId: string | null, knownStatus: { active?: boolean; status?: string; chunksCount?: number } | null = null): Promise<void> {
    if (!sessionId) return;
    const sid = String(sessionId);
    // Bookkeep the reconnect chain BEFORE the bail-out guards so heartbeat-only
    // streams still hit the cap. The chain resets on real chunk arrival (see
    // `_liveChunkCount += 1` below) and on the silent-streak give-up branch.
    const chainCount = (sessionReconnectChainCount.get(sid) || 0) + 1;
    sessionReconnectChainCount.set(sid, chainCount);
    const chainStartedAt = sessionReconnectChainStartAt.get(sid) ?? Date.now();
    sessionReconnectChainStartAt.set(sid, chainStartedAt);
    const chainElapsed = Date.now() - chainStartedAt;
    if (chainCount > RECONNECT_CHAIN_MAX_ATTEMPTS || chainElapsed > RECONNECT_CHAIN_MAX_DURATION_MS) {
      sessionReconnectChainCount.delete(sid);
      sessionReconnectChainStartAt.delete(sid);
      recordReconnectSkipped(sid, `chain-give-up attempts=${chainCount} elapsedMs=${chainElapsed}`);
      // Same recovery as the silent-streak path: prefer the persisted snapshot
      // if the bridge says done; otherwise let the in-process _liveDeadline
      // sweep finalize and just drop our local "live" flag.
      const recovered = await _finalizeFromPersistedIfDone(sid).catch(() => false);
      chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: false, status: 'idle' });
      try {
        getToastActions().show(
          recovered
            ? 'Stream lost — restored from last saved state.'
            : 'Stream lost — server still says streaming; reload the session if needed.',
          'warning',
          { duration: 6000 },
        );
      } catch (_) {}
      return;
    }
    const attemptToken = chatStreaming.invalidateReconnect(sid);
    if (sessionAbortControllers.has(sid)) { recordReconnectSkipped(sid, 'abort-controller-present'); return; }
    const status = knownStatus || (await session.streamStatus(sid));
    if (!chatStreaming.isReconnectCurrent(sid, attemptToken)) { recordReconnectSkipped(sid, 'token-invalidated'); return; }
    // Note: do NOT set `reconnecting: true` here. This used to be set to
    // `!!status.active` *before* the early-return guards below, so any guard
    // that bailed (e.g. "user is on a different session") left the session
    // wedged with reconnecting=true forever — AppEffects then refused to
    // re-trigger reconnect on the next switch back, and the stream never
    // re-attached. We only flip into `localLive: true` when we actually open
    // the EventSource further down; until then `reconnecting` stays false.
    chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: !!status.active, status: status.status || (status.active ? 'streaming' : 'idle') });
    if (!status.active && status.status !== 'done') { recordReconnectSkipped(sid, `status=${status.status || 'inactive'}`); return; }
    if (status.status === 'done' && !status.chunksCount) { recordReconnectSkipped(sid, 'done-no-chunks'); return; }
    const isPassive = String(getAppState().currentSession || 'default') !== sid;
    // Do NOT keep full passive/background EventSource listeners open for every
    // live session. On HTTP/1.1 the browser has a small per-origin connection
    // budget; a few background SSEs + activity/dirty feeds can occupy all
    // sockets and starve ordinary fetches such as /v1/modules, /v1/mcp,
    // /v1/files and prefs tabs. Treat the persisted live snapshot + activity
    // feed as the source of truth while the session is hidden, and only attach
    // the heavy /stream-direct SSE when the user switches back to that session.
    if (isPassive) {
      if (status.active) {
        chatStreaming.setSessionStreamState(sid, {
          localLive: false,
          reconnecting: false,
          serverActive: true,
          status: status.status || 'streaming',
        });
        recordReconnectSkipped(sid, 'passive-no-sse');
        return;
      }
      if (status.status === 'done') {
        const recovered = await _finalizeFromPersistedIfDone(sid).catch(() => false);
        chatStreaming.setSessionStreamState(sid, {
          localLive: false,
          reconnecting: false,
          serverActive: false,
          status: recovered ? 'idle' : 'done',
        });
        recordReconnectSkipped(sid, recovered ? 'passive-done-recovered' : 'passive-done-no-sse');
        return;
      }
      recordReconnectSkipped(sid, `passive-status=${status.status || 'inactive'}`);
      return;
    }
    if (status.status === 'done') {
      const last = [...useChatStore.getState().messages].reverse().find((m: { role: string; typing?: boolean }) => m.role === 'agent' || m.role === 'user');
      if (last && last.role === 'agent' && !last.typing) { recordReconnectSkipped(sid, 'agent-already-finalized'); return; }
    }
    const _reconnectAttempt = recordReconnectStart(sid);
    let _replayChunkCount = 0;
    let _liveChunkCount = 0;
    let _bytesIn = 0;
    let _firstChunkAt: number | null = null;
    // Previously we returned early when status was inactive AND the last
    // visible message was `user` — meant to dodge duplicate placeholders when
    // the agent reply was already cached. But if the user just switched back
    // to a session whose stream finished while detached, fetchList may have
    // raced with finalize and our cache still ends in `user`. In that window
    // returning here left a stuck "running" UI that only un-stuck after
    // multiple manual refreshes. Replay the buffered chunks instead — the
    // resulting placeholder turns into the proper agent message via
    // `_end` → finish('done').
    //
    // Idempotent placeholder: if a typing-agent message is already at the
    // bottom of the chat (left over from a previous attach we just lost via
    // silent close), reuse its DOM element instead of pushing a duplicate.
    // Otherwise the chat ends up with N agent messages stacked, all empty
    // except the very last one — exactly what the user described as
    // "interface zeigt stream läuft, keine neuen ergebnisse".
    let placeholder: HTMLElement;
    let persistedBlocksReused: Block[] | null = null;
    if (isPassive) {
      // Dead branch: the early return for isPassive above means we never reach
      // here for background sessions. The original passive listener path was
      // removed (see 6acb552) to stop exhausting the browser's per-origin
      // SSE connection budget. Keep the shape so the rest of the (large)
      // active-session closure continues to parse/indent as before.
      placeholder = document.createElement('div');
    } else {
      const msgs = useChatStore.getState().messages as Array<{ role: string; typing?: boolean; streaming?: boolean; blocks?: Block[]; _mid?: number }>;
      // Latch onto either a typing placeholder pushed earlier in this tab OR
      // the on-disk `streaming: true` partial reply now flagged typing via
      // session.ts's mapping. The helper is unit-tested because this branch is
      // the race that used to duplicate agent bubbles when React had not
      // committed the restored [data-mid] yet.
      const choice = selectReconnectPlaceholder(
        msgs,
        (mid) => document.querySelector<HTMLElement>(`[data-mid="${mid}"]`),
        () => chat.pushMessage({ role: 'agent', text: '', typing: true }),
      );
      placeholder = choice.placeholder;
      persistedBlocksReused = choice.persistedBlocksReused;
    }
    // <StatusIndicator /> renders itself off chatStore.sessionStreams, no
    // DOM poke from here.
    // Restore the streaming accumulator from any prior attach for this
    // session (initial POST or earlier reconnect). Without this, a reconnect
    // that uses `?fromSeq=N` only replays the missed delta — and the first
    // renderBlocks(placeholder, blocks=[], delta) wipes the bubble back to
    // just that delta, losing everything that was already rendered on top.
    const accum = sessionStreamAccumulator.get(sid) || _initAccumulator();
    sessionStreamAccumulator.set(sid, accum);
    // A persisted live placeholder already carries the model captured when the
    // turn started. Seed reconnect state from it so older/alternate stream
    // paths that have not emitted a model-bearing `_live` frame yet still do
    // not fall back to the mutable picker selection.
    const persistedTurnModel = !isPassive
      ? String((useChatStore.getState().messages.find(
          (m: { _mid?: number }) => m._mid === +placeholder.dataset['mid']!,
        ) as ChatMessage | undefined)?.meta?.model || '') || null
      : null;
    // We intentionally do NOT seed accum.blocks from persistedBlocksReused
    // here: the reattach EventSource's replay will fully reconstruct blocks
    // from the buffer ring (fromSeq starts at 0 after a reload, so the full
    // ring is re-streamed), and double-seeding would stack duplicates of
    // every chunk that's BOTH in the persisted snapshot and the ring.
    // MessageList renders persistedBlocksReused in the meantime via its
    // typing+no-streamingHtml fallback, so the bubble isn't empty during
    // the replay; once _replay_end fires renderBlocks() pushes the full
    // reconstructed HTML into streamingSegments and the view swaps in
    // place. The edge case where the ring has aged out chunks the persisted
    // snapshot still holds (very long turns >200 chunks after reload) keeps
    // the persisted state visible until live content arrives — acceptable
    // since the bridge's finalize POST re-persists the canonical blocks.
    void persistedBlocksReused;
    const blocks: Block[] = accum.blocks;
    const toolIdToName: Map<string, string> = accum.toolIdToName;
    let liveText = accum.liveText;
    let inReplay = true;
    let rcStreamStart: number | null = accum.rcStreamStart;
    let rcTotalChars = accum.rcTotalChars;
    let rcStopReason: string | null = accum.rcStopReason;
    let rcInputTokens = accum.rcInputTokens;
    let rcOutputTokens = accum.rcOutputTokens;
    let rcAuthor: Record<string, unknown> | null = accum.rcAuthor;
    let rcModel: string | null = accum.rcModel || persistedTurnModel;
    function persistAccum(): void {
      accum.liveText = liveText;
      accum.rcStreamStart = rcStreamStart;
      accum.rcTotalChars = rcTotalChars;
      accum.rcStopReason = rcStopReason;
      accum.rcInputTokens = rcInputTokens;
      accum.rcOutputTokens = rcOutputTokens;
      accum.rcAuthor = rcAuthor;
      accum.rcModel = rcModel;
      // blocks/toolIdToName are reused references — push() / set() already
      // mutate the persisted copy, no reassignment needed.
    }

    function flushLiveText(): void {
      if (liveText) { blocks.push({ type: 'text', content: liveText }); liveText = ''; }
    }

    function processChunk(chunk: Record<string, unknown>): void {
      if (chunk['author']) {
        rcAuthor = chunk['author'] as Record<string, unknown>;
        if (chunk['model']) rcModel = chunk['model'] as string;
        const bubble = placeholder.querySelector('.msg-bubble');
        const label = bubble?.querySelector('.msg-role-label') as HTMLElement | null;
        if (label) {
          label.textContent = (String(rcAuthor['name'] || rcAuthor['id'] || '?'))[0].toUpperCase();
          label.classList.add('is-emp');
          label.title = `${rcAuthor['name'] || rcAuthor['id']}${rcAuthor['role'] ? ' · ' + rcAuthor['role'] : ''}`;
          if (rcAuthor['symbolColor']) label.style.background = resolveAvatarColor(String(rcAuthor['symbolColor']));
        }
        return;
      }
      if (chunk['reasoning']) {
        const r = String(chunk['reasoning']);
        // Mirror the live path: thinking counts toward the output char tally so
        // the reconnect output estimate reflects reasoning, not just text.
        // Counted alongside text (same replay semantics as the line below).
        rcTotalChars += r.length;
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'thinking') last.content = (last.content || '') + r;
        else { flushLiveText(); blocks.push({ type: 'thinking', content: r }); }
      }
      if (chunk['text'] || chunk['delta']) {
        const t = String(chunk['text'] || chunk['delta'] || '');
        if (!inReplay && !rcStreamStart) rcStreamStart = Date.now();
        rcTotalChars += t.length;
        liveText += t;
      }
      if (chunk['toolUse']) {
        const tu = chunk['toolUse'] as Record<string, unknown>;
        flushLiveText();
        const tuId = tu['id'] as string | undefined;
        const tuName = tu['name'] as string;
        if (tuId) toolIdToName.set(tuId, tuName);
        // Mirrors the live-stream branch — AskUser is rendered as the inline
        // form via `askUserQuestion`, so suppress the redundant tool-call pill.
        if (tuName !== 'mcp__MCP-Tools__bridge__AskUser') {
          blocks.push({ type: 'tool-call', name: tuName, detail: tu['input'] || {}, toolId: tuId || null });
        }
      }
      if (chunk['toolResult']) {
        const tr = chunk['toolResult'] as Record<string, unknown>;
        const trId = tr['id'] as string | undefined;
        const matched = trId ? toolIdToName.get(trId) : undefined;
        const name = matched || (trId ? `orphan:${trId}` : 'orphan');
        if (matched !== 'mcp__MCP-Tools__bridge__AskUser') {
          blocks.push({ type: 'tool-result', name, detail: tr['content'] || '', toolId: trId || null });
        }
      }
      if (chunk['interruptBlock']) {
        const ib = chunk['interruptBlock'] as Record<string, unknown>;
        flushLiveText();
        blocks.push({
          type: 'interrupt',
          kind: String(ib['kind'] || 'note'),
          text: String(ib['text'] || ''),
          ts: Number(ib['ts'] || Date.now()),
          bufferedChunks: Number(ib['bufferedChunks'] || 0) || undefined,
          chunkCap: Number(ib['chunkCap'] || 0) || undefined,
          approxTailMs: Number(ib['approxTailMs'] || 0) || undefined,
          postFinishGraceMs: Number(ib['postFinishGraceMs'] || 0) || undefined,
          replayedCount: Number(ib['replayedCount'] || 0) || undefined,
          fromSeq: Number(ib['fromSeq'] || 0) || undefined,
          gapMs: Number(ib['gapMs'] || 0) || undefined,
          elapsedMs: Number(ib['elapsedMs'] || 0) || undefined,
          partialLen: Number(ib['partialLen'] || 0) || undefined,
          model: String(ib['model'] || '') || undefined,
          provider: String(ib['provider'] || '') || undefined,
        });
      }
      if (chunk['btwBlock']) {
        // Replay-side mirror of the live-stream `btwBlock` handler at
        // ~line 979. Without this branch a reconnect/replay silently
        // drops the user's mid-stream injection — the chunk is in the
        // buffer ring but the FE rebuild ignores it. Skip the graph
        // node (rec context not in scope here); the live path that
        // originally emitted this btw chunk already drew it.
        const bb = chunk['btwBlock'] as Record<string, unknown>;
        flushLiveText();
        const lp = bb['livePath'];
        const livePath = (lp === 'direct' || lp === 'harness' || lp === 'unknown') ? lp : 'unknown';
        blocks.push({ type: 'btw', text: String(bb['text'] || ''), livePath });
      }
      if (chunk['askUserQuestion']) {
        const aq = chunk['askUserQuestion'] as Record<string, unknown>;
        flushLiveText();
        blocks.push({
          type: 'ask-user-question',
          questionId: String(aq['id'] || ''),
          questions: (aq['questions'] as Block['questions']) || [],
          answered: false,
        });
      }
      if (chunk['askUserQuestionAnswered']) {
        const aa = chunk['askUserQuestionAnswered'] as Record<string, unknown>;
        const targetId = String(aa['id'] || '');
        const summary = String(aa['summary'] || '');
        // The reconnect path's `blocks` is the new-stream accumulator, NOT
        // the persisted message that holds the rendered form. After a
        // session-switch-and-back, the form lives in the message that
        // switchTo() loaded from fetchSession — a different DOM element
        // from `placeholder`. So we sweep the chat store too, mirroring the
        // live-stream handler in stream()'s onChunk above. Without this,
        // the user sees the Submit button stuck on "Sending answer" until
        // they switch sessions again and the next switchTo reloads the
        // now-answered persisted message.
        let touchedAccum = false;
        for (const blk of blocks) {
          if (blk.type === 'ask-user-question' && blk.questionId === targetId) {
            blk.answered = true;
            blk.answerSummary = summary;
            touchedAccum = true;
            break;
          }
        }
        try {
          const msgs = useChatStore.getState().messages as ChatMessage[];
          const next = msgs.map((m) => {
            if (!m.blocks) return m;
            let touched = false;
            const nb = m.blocks.map((blk) => {
              if (blk.type === 'ask-user-question' && blk.questionId === targetId) {
                touched = true;
                return { ...blk, answered: true, answerSummary: summary };
              }
              return blk;
            });
            return touched ? { ...m, blocks: nb } : m;
          });
          useChatStore.getState().setMessages(next);
          try {
            document.querySelectorAll<HTMLElement>(`.ask-user-block[data-question-id="${CSS.escape(targetId)}"]`).forEach((el) => {
              const msgEl = el.closest('.msg') as HTMLElement | null;
              if (!msgEl) return;
              const mid = +(msgEl.dataset['mid'] || '0');
              const msg = next.find((m) => m._mid === mid);
              if (!msg) return;
              try { chat.renderBlocks(msgEl, msg.blocks || [], ''); } catch (_) { /* swallow */ }
            });
          } catch (_) { /* DOM may be unavailable */ }
        } catch (_) { /* tolerate missing store hook */ }
        void touchedAccum;
      }
    }

    function finish(reason: string): void {
      stopReconnectWakeup();
      clearReplayEndFallback();
      evtSource.close();
      sessionAbortControllers.delete(sid);
      // Successful end of stream — drop the resume-seq AND the streaming
      // accumulator so the next stream started for this session starts from
      // a clean slate. Errors keep both so the retry can pick up from where
      // we stalled.
      if (reason === 'done') {
        sessionLastSeq.delete(sid);
        sessionStreamAccumulator.delete(sid);
        sessionSilentReconnectStreak.delete(sid);
        const recordingEntry = sessionRecordingNodes.get(sid);
        if (recordingEntry) {
          sessionRecordingNodes.delete(sid);
          graph.updateNode(String(recordingEntry.node['id']), { status: 'done', output: liveText });
        }
      }
      const endedWithLiveServerStream = reason === 'detached';
      chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: endedWithLiveServerStream, status: endedWithLiveServerStream ? 'streaming' : reason === 'error' ? 'error' : 'idle' });
      flushLiveText();
      // Refresh the session list on every clean finalize — picker dots
      // and isRunning flags must update for passive background sessions too,
      // not just the focused one (the per-current-session block below does
      // the visible-bubble mutation; this is the bookkeeping side).
      if (reason === 'done') {
        try { session?.fetchList?.(); } catch (_) {}
      }
      if (String(getAppState().currentSession || 'default') === sid) {
        const agentEntry = [...useChatStore.getState().messages].reverse().find((m: { role: string }) => m.role === 'agent') as Record<string, unknown> | undefined;
        if (agentEntry) { agentEntry['blocks'] = blocks; delete agentEntry['typing']; delete agentEntry['text']; }
        // Sync mutated message back to chatStore so React MessageList re-renders,
        // and simultaneously clear the streaming segment (now that typing=false the
        // segment is invisible, but clearing it prevents memory leaks and avoids
        // any secondary render that might re-expose stale streaming HTML).
        const _midStr = placeholder.dataset['mid'];
        useChatStore.setState((s) => {
          const nextSegs = _midStr ? { ...s.streamingSegments } : s.streamingSegments;
          if (_midStr) delete nextSegs[_midStr];
          return { messages: [...s.messages] as ChatMessage[], streamingSegments: nextSegs };
        });
        save.chat();
        if (reason === 'done') {
          try { session?.markViewed?.(sid); } catch (_) {}
          // Belt-and-suspenders: fetch the persisted state from the bridge
          // and reconcile if it has more block content than the live blocks
          // we just finalized. Covers the rare race where the bridge's
          // debounced snapshot beat our last text chunk to disk but the
          // SSE _end won the race to the FE — without this we'd lose the
          // trailing tokens on the next session-switch.
          _reconcilePersistedSnapshot(sid, blocks).catch(() => {});
        }
      }
      const outcome: 'done' | 'error' | 'detached' | 'noop' =
        reason === 'done' ? 'done'
        : reason === 'error' ? 'error'
        : reason === 'detached' ? 'detached'
        : 'noop';
      try {
        recordReconnectFinish(_reconnectAttempt, outcome, {
          replayChunkCount: _replayChunkCount,
          liveChunkCount: _liveChunkCount,
          latencyToFirstChunkMs: _firstChunkAt ? _firstChunkAt - _reconnectAttempt.at : undefined,
          bytesIn: _bytesIn,
          reason,
        });
      } catch (_) {}
    }

    const base = window.API_CONFIG?.baseUrl || 'http://localhost:8443';
    // Resume from the last seq we saw for this session — if the previous
    // attempt got chunks 1..157 and silently died, the server only re-sends
    // 158+ instead of dumping the tail-buffer (and we avoid re-rendering
    // chunks that were already applied). Browser-native auto-reconnect uses
    // Last-Event-ID for the same purpose, so both paths are covered.
    const resumeSeq = sessionLastSeq.get(sid) || 0;
    // Reattach hits Go's `/stream-direct`, which honours both `?fromSeq=N` and
    // `Last-Event-ID` with the same resume semantics.
    const url = resumeSeq > 0
      ? `${base}/v1/sessions/${encodeURIComponent(sid)}/stream-direct?fromSeq=${resumeSeq}`
      : `${base}/v1/sessions/${encodeURIComponent(sid)}/stream-direct`;
    const evtSource = new EventSource(url);
    sessionAbortControllers.set(sid, { abort: () => { stopReconnectWakeup(); stopWatchdog(); evtSource.close(); finish('detached'); } });
    chatStreaming.setSessionStreamState(sid, { localLive: true, reconnecting: false, serverActive: true, status: 'streaming' });

    // Silence watchdog: server now sends a `data: {_hb:ts}` chunk every 10 s.
    // If we go >40 s without ANY message (heartbeat or content), the
    // connection is dead in a way EventSource didn't surface (idle proxy
    // drop, OS-level RST without protocol error). Force-close + retry —
    // do NOT call finish('error'), that would tear down streamState and
    // stop AppEffects from re-triggering us.
    //
    // 40 s is intentionally LARGER than the BE's 30 s sseWriteDeadline
    // (go-core/internal/stream/sse_write.go) so a slow-but-eventually-
    // succeeding BE write doesn't get interrupted by an FE reconnect
    // mid-flight. Previously SILENCE_MS=25s fired BEFORE BE conceded,
    // producing a split-brain: FE closed the EventSource and reopened a
    // new one while the BE was still mid-write into the first; the new
    // listener replayed from fromSeq=N but the BE's first write either
    // succeeded (chunk dupe) or failed (chunk lost) racing the new pump.
    let lastMessageAt = Date.now();
    const SILENCE_MS = 40_000;

    // Replay-end fallback. The BE emits a `{_replay_end:true}` marker
    // between buffered-tail replay and live chunks; the FE renders
    // accumulated state eagerly when it sees that marker. If the marker
    // is lost mid-flight (proxy buffer drop, transient TCP blip during
    // replay), `inReplay` stays true forever, rendering is gated off,
    // and the bubble looks empty even though `accum.blocks` has the
    // text. Fix: if no chunk arrives for REPLAY_END_FALLBACK_MS while
    // we're still in replay, assume the marker was lost and force-flip
    // inReplay=false so subsequent live chunks paint (and we render
    // whatever we accumulated). Architecture: live channel best-effort,
    // correctness comes from the snapshot endpoint (which the next
    // finalize / aliveCheck / give-up branch reconciles against).
    const REPLAY_END_FALLBACK_MS = 2500;
    let replayEndFallbackTimer: number | null = null;
    function armReplayEndFallback(): void {
      if (!inReplay) return;
      if (replayEndFallbackTimer != null) {
        try { clearTimeout(replayEndFallbackTimer); } catch (_) {}
      }
      replayEndFallbackTimer = window.setTimeout(() => {
        replayEndFallbackTimer = null;
        if (!inReplay) return;
        inReplay = false;
        if (!isPassive) {
          flushRenderNow(placeholder);
          chat.renderBlocks(placeholder, blocks, liveText);
        }
      }, REPLAY_END_FALLBACK_MS);
    }
    function clearReplayEndFallback(): void {
      if (replayEndFallbackTimer != null) {
        try { clearTimeout(replayEndFallbackTimer); } catch (_) {}
        replayEndFallbackTimer = null;
      }
    }

    function forceReconnect(reason: string): void {
      stopReconnectWakeup();
      stopWatchdog();
      clearReplayEndFallback();
      try { evtSource.close(); } catch (_) {}
      sessionAbortControllers.delete(sid);
      // Track consecutive silence-driven reconnects. If the bridge keeps
      // reporting "active" but never delivers a chunk, we'd loop forever
      // (the _liveDeadline sweep takes up to 30 min). After a few empty
      // rounds we fall back to finalize-from-persisted instead.
      const gotChunksThisAttempt = _liveChunkCount > 0;
      const nextStreak = gotChunksThisAttempt ? 0 : (sessionSilentReconnectStreak.get(sid) || 0) + 1;
      sessionSilentReconnectStreak.set(sid, nextStreak);
      if (nextStreak >= SILENT_RECONNECT_GIVE_UP_AT) {
        sessionSilentReconnectStreak.delete(sid);
        sessionReconnectChainCount.delete(sid);
        sessionReconnectChainStartAt.delete(sid);
        try { recordReconnectFinish(_reconnectAttempt, 'error', { reason: `${reason}+give-up`, replayChunkCount: _replayChunkCount, liveChunkCount: _liveChunkCount, bytesIn: _bytesIn }); } catch (_) {}
        Promise.resolve().then(async () => {
          const recovered = await _finalizeFromPersistedIfDone(sid);
          if (recovered) {
            chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: false, status: 'idle' });
          } else {
            // Disk also says streaming — let the bridge-side _liveDeadline
            // sweep finalize. Drop the local "live" flag so the FE stops
            // showing the stop button + animation; reload picks up state.
            chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: false, status: 'idle' });
          }
        });
        return;
      }
      chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: true, serverActive: true, status: 'streaming' });
      try { recordReconnectFinish(_reconnectAttempt, 'error', { reason, replayChunkCount: _replayChunkCount, liveChunkCount: _liveChunkCount, bytesIn: _bytesIn }); } catch (_) {}
      setTimeout(() => {
        chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: true, status: 'streaming' });
        chatStreaming.reconnectStream(sid).catch(() => {});
      }, 800);
    }

    const watchdogTimer = setInterval(() => {
      if (!chatStreaming.isReconnectCurrent(sid, attemptToken)) { stopWatchdog(); return; }
      if (Date.now() - lastMessageAt > SILENCE_MS) forceReconnect('silence-watchdog');
    }, 5000);
    function stopWatchdog() { try { clearInterval(watchdogTimer); } catch (_) {} }

    // Visibility wakeup: browsers throttle setInterval in background tabs to
    // 1 Hz and may pause it entirely after several minutes. A tab backgrounded
    // for 10 min while the connection silently died wouldn't have its
    // watchdog tick at all — when the user comes back, the tab still thinks
    // the stream is live. On every visibilitychange→visible we synchronously
    // check the silence predicate and fast-path a reconnect if stale, instead
    // of waiting for the next throttled interval tick.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!chatStreaming.isReconnectCurrent(sid, attemptToken)) { stopReconnectWakeup(); return; }
      if (Date.now() - lastMessageAt > SILENCE_MS) forceReconnect('visibility-wakeup');
    };
    document.addEventListener('visibilitychange', onVisible);
    function stopReconnectWakeup(): void {
      try { document.removeEventListener('visibilitychange', onVisible); } catch (_) {}
    }

    evtSource.onmessage = (event) => {
      if (!chatStreaming.isReconnectCurrent(sid, attemptToken)) {
        stopReconnectWakeup();
        stopWatchdog();
        evtSource.close();
        return;
      }
      lastMessageAt = Date.now();
      if (_firstChunkAt == null) _firstChunkAt = Date.now();
      const _evSize = typeof event.data === 'string' ? event.data.length : 0;
      _bytesIn += _evSize;
      let chunk: Record<string, unknown>;
      try { chunk = JSON.parse(event.data); } catch (_) { return; }
      // Heartbeat-only chunks: silence-watchdog is reset by lastMessageAt
      // above; nothing else to do.
      if (chunk['_hb'] !== undefined && Object.keys(chunk).length === 1) return;
      // Track highest seq we've seen so reconnects can resume from here.
      // Seq is monotonic per session; if a future replay would re-deliver
      // chunks we already applied (e.g. browser auto-reconnect without
      // honoring our `?fromSeq=`), we silently skip them.
      if (typeof chunk['_seq'] === 'number') {
        const prev = sessionLastSeq.get(sid) || 0;
        if ((chunk['_seq'] as number) <= prev && !chunk['_replay_end'] && !chunk['_end']) return;
        if ((chunk['_seq'] as number) > prev) sessionLastSeq.set(sid, chunk['_seq'] as number);
      }
      if (inReplay) {
        _replayChunkCount += 1;
        // Reset the replay-end fallback timer on every replay chunk. The
        // timer only fires when no chunk has arrived for a while AND we
        // are still in replay — that's the signal that `_replay_end`
        // never reached us.
        armReplayEndFallback();
      } else {
        _liveChunkCount += 1;
        // Real progress — reset the silent-reconnect streak AND the absolute
        // reconnect-chain bookkeeping so a later intermittent stall doesn't
        // inherit a poisoned counter or a stale start-at timestamp.
        if (sessionSilentReconnectStreak.get(sid)) sessionSilentReconnectStreak.delete(sid);
        if (sessionReconnectChainCount.get(sid)) sessionReconnectChainCount.delete(sid);
        if (sessionReconnectChainStartAt.get(sid)) sessionReconnectChainStartAt.delete(sid);
      }
      if (chunk['_replay_end']) {
        inReplay = false;
        clearReplayEndFallback();
        // Architectural: live channel best-effort, snapshot is the source
        // of truth. The MessageList typing-fallback is already painting
        // `persistedBlocksReused` (the snapshot at session load). Only
        // overwrite it on `_replay_end` if we have content to show AND
        // doing so doesn't visually regress. Without this guard a cold
        // reconnect on a long turn (ring buffer rolled past the early
        // chunks the snapshot still holds) wipes the bubble back to the
        // partial replay tail — exactly the "data is there but the
        // frontend doesn't show it" symptom. If we'd regress, leave the
        // persisted render in place; live chunks paint additively from
        // here, and on `_end` the reconcile-from-persisted path swaps in
        // the canonical blocks.
        const persistedLen = (persistedBlocksReused?.length ?? 0);
        const haveContent = blocks.length > 0 || liveText.length > 0;
        const wouldRegress = persistedLen > blocks.length;
        if (!isPassive && haveContent && !wouldRegress) {
          flushRenderNow(placeholder);
          chat.renderBlocks(placeholder, blocks, liveText);
        }
        return;
      }
      if (chunk['_end']) {
        inReplay = false;
        clearReplayEndFallback();
        // Drop the live busy bar before the finalize render below.
        clearLiveMeta(placeholder);
        flushLiveText();
        if (chunk['error'] && !blocks.length && !liveText) {
          blocks.push({ type: 'text', content: '**Error:** ' + String(chunk['error']) });
        }
        rcStopReason = chunk['stopReason'] as string || (blocks.some((b) => b.type === 'tool-call') ? 'tool_use' : 'end_turn');
        if (chunk['model']) rcModel = String(chunk['model']);
        // Fold cached prompt tokens into input, matching the live `_end` handler
        // (chat-streaming `_end` above). Without this the reconnect/switch-into
        // finalize stamped the bare uncached delta (~2) as "tokens in".
        const _inEndRc = ((chunk['inputTokens'] as number) || 0) + ((chunk['cacheReadTokens'] as number) || 0) + ((chunk['cacheCreationTokens'] as number) || 0);
        if (_inEndRc) rcInputTokens = _inEndRc;
        if (chunk['outputTokens']) rcOutputTokens = chunk['outputTokens'] as number;
        // Flush any pending throttled render before finalizing meta so the
        // final blocks are already in the DOM. Passive mode skips this — the
        // placeholder isn't in the document and there's no agentMsg to find.
        if (!isPassive) {
          flushRenderNow(placeholder);
          chat.renderBlocks(placeholder, blocks, liveText);
        }
        const agentMsg = !isPassive
          ? useChatStore.getState().messages.find((m: { _mid?: number }) => m._mid === +placeholder.dataset['mid']!)
          : undefined;
        if (agentMsg) {
          // BUG FIX: set blocks on the store message BEFORE setMsgMeta deletes
          // agentMsg.typing. React renders are deferred (Zustand batching) — a
          // render that fires between renderBlocks() and setMsgMeta() sees
          // typing=false but blocks=undefined → renders an empty bubble, height
          // collapses, and the chat scrolls back up to the last user prompt.
          agentMsg.blocks = blocks;
          chat.setMsgMeta(placeholder, agentMsg, {
            model: rcModel || undefined,
            ...(rcAuthor ? { author: rcAuthor } : {}),
            tokensPerSec: chunk['tokensPerSec'],
            tokenCount: Math.round(rcTotalChars / 4),
            durationMs: chunk['durationMs'],
            stopReason: rcStopReason,
            inputTokens: rcInputTokens,
            outputTokens: rcOutputTokens
          });
        }
        stopWatchdog();
        finish('done');
        return;
      }
      if (chunk['_live']) {
        // Live counters during a reattached turn — paint the busy bar on
        // the resumed connection. Counters are authoritative from the
        // backend ticker; clock origin is the persisted stream start so
        // elapsed survives the reconnect.
        // Fold cached prompt tokens into input (matches the live `_live`
        // handler). Estimate output from streamed chars rather than the
        // backend's per-message partial, which resets each tool round-trip —
        // same reasoning as the live path, applied here so a session switched
        // into mid-turn shows a believable, climbing output count.
        const _inLiveRc = ((chunk['inputTokens'] as number) || 0) + ((chunk['cacheReadTokens'] as number) || 0) + ((chunk['cacheCreationTokens'] as number) || 0);
        if (_inLiveRc > 0) rcInputTokens = _inLiveRc;
        if (chunk['model']) rcModel = String(chunk['model']);
        rcOutputTokens = Math.max(Math.round(rcTotalChars / 4), (chunk['outputTokens'] as number) || 0);
        if (!isPassive) {
          applyLiveMeta(placeholder, {
            in: rcInputTokens,
            out: rcOutputTokens,
            tools: (chunk['toolCallCount'] as number) || 0,
            api: (chunk['apiCallCount'] as number) || 0,
            start: rcStreamStart || Date.now(),
            model: rcModel || undefined,
          });
          // Lightweight bar-only update — same rationale as the live stream
          // path above. No full renderBlocks on counter ticks.
          { const _lm2 = _midOf(placeholder); if (_lm2 != null) { const _le = _resolveLive(_lm2); if (_le) { const _lv = _liveMetaByMid.get(_lm2); if (_lv) { _writeLiveDataset(_le, _lv); chatRendering.syncLiveMetaBar(_le); } } } }
        }
        persistAccum();
        return;
      }
      processChunk(chunk);
      // Persist accumulator after every applied chunk so a subsequent
      // reconnect (silence-watchdog, visibility-wakeup, eventsource error)
      // can resume on top of what's already been rendered instead of wiping
      // the bubble back to the post-resume delta.
      persistAccum();
      if (!inReplay && !isPassive) {
        scheduleRender(placeholder, blocks, liveText);
      }
    };

    evtSource.onerror = async () => {
      if (!chatStreaming.isReconnectCurrent(sid, attemptToken)) {
        stopReconnectWakeup();
        stopWatchdog();
        evtSource.close();
        return;
      }
      // Don't immediately tear down — server may still have an active stream
      // and our connection just blipped (proxy idle drop, transient
      // network). Check the server's status:
      //   - active: open a fresh EventSource (preserve placeholder + blocks)
      //   - done:   finalize cleanly with whatever we have
      //   - else:   surface the error so the user isn't left hanging
      stopReconnectWakeup();
      stopWatchdog();
      evtSource.close();
      sessionAbortControllers.delete(sid);
      let live = false;
      let serverStreamDone = false;
      try {
        const st = await session.streamStatus(sid);
        live = !!st?.active;
        serverStreamDone = st?.status === 'done';
      } catch (_) {}
      if (!chatStreaming.isReconnectCurrent(sid, attemptToken)) return;
      if (live) {
        // Keep placeholder/blocks intact via idempotent reuse on next attempt.
        chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: true, serverActive: true, status: 'streaming' });
        try { recordReconnectFinish(_reconnectAttempt, 'error', { reason: 'eventsource-error-retry', replayChunkCount: _replayChunkCount, liveChunkCount: _liveChunkCount, bytesIn: _bytesIn }); } catch (_) {}
        setTimeout(() => {
          chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: true, status: 'streaming' });
          chatStreaming.reconnectStream(sid).catch(() => {});
        }, 800);
        return;
      }
      flushLiveText();
      // BUG FIX: ensure the fallback text lands in blocks (not just the DOM),
      // so finish()'s `agentEntry.blocks = blocks` produces non-empty content
      // when React transitions from the streaming segment to the static render.
      // Previously updateMessage() wrote only to the DOM/streaming-segment;
      // finish() then set agentEntry.blocks=[] + deleted agentEntry.text →
      // the React static render showed a completely blank message bubble.
      if (!blocks.length) blocks.push({ type: 'text', content: serverStreamDone ? '*(no response)*' : '*(connection lost)*' });
      if (!isPassive) chat.renderBlocks(placeholder, blocks);
      // BUG FIX: set blocks on the store message and (when the server stream
      // completed cleanly) stamp meta so the static render path always shows
      // model/token stats. Previously the onerror path never called setMsgMeta,
      // so the résumé stats were always blank when a TCP close beat the _end.
      if (!isPassive) {
        const agentMsgErr = useChatStore.getState().messages.find((m: { _mid?: number }) => m._mid === +placeholder.dataset['mid']!);
        if (agentMsgErr) {
          agentMsgErr.blocks = blocks;
          if (serverStreamDone) {
            chat.setMsgMeta(placeholder, agentMsgErr, {
              model: rcModel || undefined,
              ...(rcAuthor ? { author: rcAuthor } : {}),
              stopReason: rcStopReason || 'end_turn',
              tokenCount: Math.round(rcTotalChars / 4),
              inputTokens: rcInputTokens,
              outputTokens: rcOutputTokens,
            });
          }
        }
      }
      // If the server stream finished cleanly, treat as done (not error) so the
      // UI shows "Response finished" even when the TCP close beat the _end event.
      finish(serverStreamDone ? 'done' : 'error');
    };
  },

  stopStream(sessionId: string | null = null): void {
    const sid = String(sessionId || getAppState().currentSession || 'default');
    chatStreaming.invalidateReconnect(sid);
    fetch(`${api.config.baseUrl}/v1/stop/${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => {});
    // Remove the controller from the map BEFORE aborting so finish('detached')
    // (called from the reconnect EventSource's abort closure) can't see it and
    // re-register the session as serverActive=true. Without this two-step,
    // pressing Stop on a session backed by a reconnect EventSource would:
    //   1. setSessionStreamState({stopped, all-false}) → entry deleted
    //   2. ctrl.abort() → finish('detached') → state recreated as streaming
    // So the first press only "refreshed" the chat and the second press had
    // to be hit to actually clear local state — the user-reported double-press.
    const ctrl = sessionAbortControllers.get(sid);
    if (ctrl) {
      sessionAbortControllers.delete(sid);
      try { ctrl.abort(); } catch (_) { /* abort callbacks are best-effort */ }
    }
    // Apply the stopped state AFTER the abort so finish('detached')'s
    // streaming-state revival is overwritten. Order matters here.
    chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: false, status: 'stopped' });
    // If the bridge had nothing to stop (wedge already cleared server-side),
    // the persisted message may already hold the final answer. Pull it in so
    // the bubble shows the result instead of staying stuck on "*(stopped)*".
    // Fire-and-forget; conservative no-op when disk still has streaming=true.
    sessionSilentReconnectStreak.delete(sid);
    Promise.resolve().then(() => _finalizeFromPersistedIfDone(sid).catch(() => {}));
  },

  updateStreamingUI(): void {
    const sid = String(getAppState().currentSession || 'default');
    const isStreaming = chatStreaming.isSessionRunning(sid);
    const sendBtn = document.getElementById('chat-send');
    const stopBtn = document.getElementById('chat-stop');
    if (sendBtn) sendBtn.style.display = isStreaming ? 'none' : '';
    if (stopBtn) stopBtn.style.display = isStreaming ? '' : 'none';
    // The streaming status line is rendered by <StatusIndicator /> inside the
    // chat scroll — it subscribes to chatStore.sessionStreams, no DOM poking here.
  },

  detachStream(sessionId: string): void {
    const sid = String(sessionId);
    chatStreaming.invalidateReconnect(sid);
    const ctrl = sessionAbortControllers.get(sid);
    if (ctrl) {
      // Tell the server this close is on purpose (session switcher / delete)
      // so it suppresses the "Connection lost" + "Stream resumed" interrupt
      // blocks that would otherwise be persisted and pollute the chat log.
      // Fire-and-forget with keepalive so it still goes out if the page is
      // also being torn down. Sent BEFORE the abort so the flag is set
      // before req.on('close') fires server-side. Failures are silent —
      // worst case the user sees the old behavior (one stray interrupt
      // block), which is what they had before this fix.
      try {
        fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/stream/detach`, {
          method: 'POST',
          keepalive: true,
        }).catch(() => {});
      } catch (_) {}
      _detachedSessions.add(sid);
      ctrl.abort();
      sessionAbortControllers.delete(sid);
      // Stream WAS active — keep it marked as still running on server side
      // so the picker reflects that and reconnectStream() can pick it back up.
      chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: true, status: 'streaming' });
    }
    // No active controller — session wasn't streaming locally, leave its
    // stream state alone (do NOT fabricate serverActive=true, the picker
    // would then show a completed session as "running" until next refresh).
  },

  setKnownStreamStatus(sessionId: string | null, status: { active?: boolean; status?: string } = {}): void {
    const sid = String(sessionId || 'default');
    // If there is an in-flight local send for this session and the server
    // says "not active", the server simply hasn't seen the POST yet —
    // bail out so we don't clobber the send's status:'streaming' with 'idle'.
    if (sessionAbortControllers.has(sid) && !status.active) return;
    chatStreaming.setSessionStreamState(sid, {
      localLive: sessionAbortControllers.has(sid),
      reconnecting: false,
      serverActive: !!status.active,
      status: status.status || (status.active ? 'streaming' : 'idle')
    });
  },

  // Public wrapper around _finalizeFromPersistedIfDone for callers outside
  // the streaming module (SessionPoller, AppEffects visibility hook). Fetches
  // the persisted session snapshot — if the last assistant message has
  // `streaming=0`, finalizes the in-memory bubble from disk AND clears the
  // local stream state. No-op while a local POST is in flight (abortController
  // present) to avoid clobbering an active send.
  async reconcileFromPersisted(sessionId: string | number | null): Promise<boolean> {
    const sid = String(sessionId || 'default');
    if (sessionAbortControllers.has(sid)) return false;
    const recovered = await _finalizeFromPersistedIfDone(sid).catch(() => false);
    if (recovered) {
      chatStreaming.setSessionStreamState(sid, { localLive: false, reconnecting: false, serverActive: false, status: 'idle' });
    }
    return recovered;
  }
};

export default chatStreaming;
