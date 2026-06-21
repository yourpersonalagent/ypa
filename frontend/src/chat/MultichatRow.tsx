// MultichatRow — inline row of mini-bubbles, one per agent slot.
//
// Rendered by MessageList whenever a host-session message has role
// 'multichat-turn'. Each mini-bubble shows the matching agent's response
// for THIS turn (not the agent's full transcript) — clicking the bubble's
// header opens that agent's session as a normal standalone chat.
//
// Layout: CSS grid, N columns (one per slot). Each cell has
// max-height: 1/N of the chat scroll viewport with internal vertical
// scroll, so 5 invitees on a small screen still fit on one row and
// long answers scroll inside the cell rather than stretching the page.
//
// Streaming: while `isLatestTurn` is true and a slot session is actively
// streaming, the row subscribes to that slot's SSE and shows live tokens.
// Older turns just display the static answer fetched from each slot
// session's message log (each turn writes one assistant message per slot).

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { session } from '../session.js';
import { useChatStore } from '../stores/index.js';
import { useSessionActivityStore } from '../stores/sessionActivityStore.js';

interface SlotInfo {
  sessionId: string;
  label: string;
  id: string;
}

interface MultichatRowProps {
  groupId: string;
  turnIndex: number;
  slots: SlotInfo[];
  isLatestTurn: boolean;
}

interface SlotMsg {
  role: string;
  text?: string;
  blocks?: Array<{ type: string; content?: string }>;
  ts?: number;
  meta?: { model?: string; durationMs?: number; inputTokens?: number; outputTokens?: number };
}

// Walk a slot session's message log and pick the assistant message that
// belongs to `turnIndex`. The slot session writes [user, assistant] per
// turn (plan-mode adds extra assistants for plan/vote phases — those are
// also assistant role; we keep the LAST one before the next user message,
// which is the executed answer).
function _pickTurnText(messages: SlotMsg[], turnIndex: number): string {
  let userCount = 0;
  let lastAssistantInTurn = '';
  let inTargetTurn = false;
  for (const m of messages) {
    if (m.role === 'user') {
      if (inTargetTurn) break;
      if (userCount === turnIndex) inTargetTurn = true;
      userCount += 1;
      continue;
    }
    if (!inTargetTurn) continue;
    if (m.role === 'assistant' || m.role === 'agent') {
      const text = m.text || (Array.isArray(m.blocks)
        ? (m.blocks.find((b) => b.type === 'text')?.content || '')
        : '');
      if (text) lastAssistantInTurn = text;
    }
  }
  return lastAssistantInTurn;
}

function _pickTurnMeta(messages: SlotMsg[], turnIndex: number): SlotMsg['meta'] | undefined {
  let userCount = 0;
  let lastMeta: SlotMsg['meta'] | undefined;
  let inTargetTurn = false;
  for (const m of messages) {
    if (m.role === 'user') {
      if (inTargetTurn) break;
      if (userCount === turnIndex) inTargetTurn = true;
      userCount += 1;
      continue;
    }
    if (!inTargetTurn) continue;
    if ((m.role === 'assistant' || m.role === 'agent') && m.meta) lastMeta = m.meta;
  }
  return lastMeta;
}

interface SlotState {
  text: string;
  liveText: string;
  isStreaming: boolean;
  model: string;
  meta: SlotMsg['meta'] | undefined;
}

function MiniBubble({
  slot,
  groupId: _groupId,
  turnIndex,
  isLatestTurn,
}: {
  slot: SlotInfo;
  groupId: string;
  turnIndex: number;
  isLatestTurn: boolean;
}) {
  const [state, setState] = useState<SlotState>({
    text: '',
    liveText: '',
    isStreaming: false,
    model: '',
    meta: undefined,
  });
  const lastSeqRef = useRef(0);
  // Cross-session live counters from the global activity feed. Populated
  // for slots whose turns stream through go-core; empty otherwise, so the
  // live-meta line below is fully guarded and degrades to nothing.
  const liveMeta = useSessionActivityStore((s) => s.sessions[slot.sessionId]);
  useEffect(() => {
    if (!isLatestTurn) return;
    useSessionActivityStore.getState().connect();
    return () => { useSessionActivityStore.getState().disconnect(); };
  }, [isLatestTurn]);

  // Initial fetch: pull the slot session's messages and pick this turn's
  // assistant answer. Re-runs on turnIndex change (we render one row per
  // turn so this typically only fires on mount).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${api.config.baseUrl}/v1/sessions/${encodeURIComponent(slot.sessionId)}`);
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        const messages: SlotMsg[] = d.messages || d.session?.messages || [];
        const text = _pickTurnText(messages, turnIndex);
        const meta = _pickTurnMeta(messages, turnIndex);
        setState((s) => ({ ...s, text, meta, model: meta?.model || s.model }));
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, [slot.sessionId, turnIndex]);

  // Live streaming for the latest turn: subscribe to the slot session's
  // SSE and accumulate text into liveText. Older turns are static —
  // their final text is already in `state.text` from the initial fetch.
  useEffect(() => {
    if (!isLatestTurn) return;
    const url = `${api.config.baseUrl}/v1/sessions/${encodeURIComponent(slot.sessionId)}/stream`;
    const es = new EventSource(url);
    const onMessage = (ev: MessageEvent) => {
      let chunk: Record<string, unknown>;
      try { chunk = JSON.parse(ev.data); } catch (_) { return; }
      if (chunk['_hb'] !== undefined && Object.keys(chunk).length === 1) return;
      if (typeof chunk['_seq'] === 'number') {
        const seq = chunk['_seq'] as number;
        if (seq <= lastSeqRef.current && !chunk['_replay_end'] && !chunk['_end']) return;
        if (seq > lastSeqRef.current) lastSeqRef.current = seq;
      }
      if (typeof chunk['model'] === 'string' && chunk['model']) {
        setState((s) => ({ ...s, model: String(chunk['model']), isStreaming: true }));
      }
      if (chunk['_replay_end']) {
        setState((s) => ({ ...s, isStreaming: false }));
        return;
      }
      if (chunk['_end']) {
        setState((s) => ({
          ...s,
          isStreaming: false,
          // Promote whatever streamed in this turn to the static text so
          // the bubble survives a re-mount (e.g. reload).
          text: s.liveText || s.text,
          liveText: '',
          meta: {
            ...(s.meta || {}),
            model: s.model || s.meta?.model,
            durationMs: chunk['durationMs'] as number | undefined,
            inputTokens: chunk['inputTokens'] as number | undefined,
            outputTokens: chunk['outputTokens'] as number | undefined,
          },
        }));
        return;
      }
      const text = String(chunk['text'] || chunk['delta'] || '');
      if (text) {
        setState((s) => ({ ...s, liveText: s.liveText + text, isStreaming: true }));
      }
    };
    es.onmessage = onMessage;
    es.onerror = () => {
      setState((s) => ({ ...s, isStreaming: false }));
    };
    return () => { try { es.close(); } catch (_) {} };
  }, [slot.sessionId, isLatestTurn]);

  const display = state.liveText || state.text || '';
  const showLive = isLatestTurn && state.isStreaming;

  function openSession(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    session.switchTo(slot.sessionId).catch(() => {});
  }

  return (
    <div className={`mc-mini${showLive ? ' mc-mini-live' : ''}`}>
      <button type="button" className="mc-mini-header" onClick={openSession} title={`Open ${slot.label} as a standalone chat`}>
        <span className="mc-mini-dot" />
        <span className="mc-mini-label">{slot.label}</span>
        {state.model ? <span className="mc-mini-model">{state.model}</span> : null}
        <span className="mc-mini-open">↗</span>
      </button>
      <div className="mc-mini-body">
        {display ? (
          <div className="mc-mini-text">{display}{showLive ? <span className="mc-mini-cursor">▌</span> : null}</div>
        ) : showLive ? (
          <span className="mc-mini-typing"><span /><span /><span /></span>
        ) : (
          <span className="mc-mini-empty">(no response)</span>
        )}
      </div>
      {showLive && liveMeta && (liveMeta.inputTokens || liveMeta.outputTokens || liveMeta.toolCallCount) ? (
        <div className="mc-mini-meta mc-mini-meta-live">
          {liveMeta.inputTokens ? <span>↑{liveMeta.inputTokens}</span> : null}
          {liveMeta.outputTokens ? <span>↓{liveMeta.outputTokens}</span> : null}
          {liveMeta.toolCallCount > 0 ? <span title="Tool calls">⚙{liveMeta.toolCallCount}</span> : null}
        </div>
      ) : (state.meta?.inputTokens || state.meta?.outputTokens || state.meta?.durationMs) ? (
        <div className="mc-mini-meta">
          {state.meta.inputTokens ? <span>↑{state.meta.inputTokens}</span> : null}
          {state.meta.outputTokens ? <span>↓{state.meta.outputTokens}</span> : null}
          {state.meta.durationMs ? <span>{Math.max(1, Math.round(state.meta.durationMs / 100) / 10)}s</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function MultichatRow({ groupId, turnIndex, slots, isLatestTurn }: MultichatRowProps) {
  // Subscribe so the row re-renders when the chat store's messages array
  // changes (used to detect "this is no longer the latest turn" once the
  // user submits the next prompt).
  const messagesLength = useChatStore((s) => s.messages.length);
  void messagesLength;
  const n = Math.max(1, slots.length);
  const style = useMemo(
    () => ({ '--mc-n': String(n) } as React.CSSProperties),
    [n]
  );
  return (
    <div className="mc-row" data-cols={n} style={style}>
      {slots.map((slot) => (
        <MiniBubble
          key={slot.sessionId}
          slot={slot}
          groupId={groupId}
          turnIndex={turnIndex}
          isLatestTurn={isLatestTurn}
        />
      ))}
    </div>
  );
}

export default MultichatRow;
