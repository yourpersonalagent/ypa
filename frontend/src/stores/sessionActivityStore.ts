// sessionActivityStore — process-global view of which chat sessions are
// streaming RIGHT NOW, with live counters, sourced from the go-core
// GET /v1/activity/stream SSE feed.
//
// Backs UI surfaces that need cross-session busy state without attaching
// to each session's own stream: the multichat grid (per-tile busy bar)
// and the header (global busy pill). The active tab paints its own bar
// from the per-turn `_live` frames on its stream; this store is for
// EVERY OTHER in-flight session.
//
// One EventSource per page is shared across all subscribers via a simple
// refcount: the first connect() opens it, the last disconnect() closes
// it. The feed is presence-based (see go-core/internal/stream/livemeta.go)
// — each `activity` frame is the complete set of streaming sessions, so a
// session's ABSENCE from a frame means "not streaming". Every frame fully
// replaces the map.

import { create } from 'zustand';
import { api } from '../api.js';

export interface SessionLiveMeta {
  sessionId: string;
  status: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  apiCallCount: number;
  turnStartMs: number;
}

interface ActivityState {
  sessions: Record<string, SessionLiveMeta>;
  connected: boolean;
}

interface ActivityActions {
  connect: () => void;
  disconnect: () => void;
}

type Store = ActivityState & ActivityActions;

let es: EventSource | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Throttle: only push to React when session membership changes (instant) OR
// after this many ms of suppression for pure counter-tick frames. Callers
// that need sub-second token precision read getState() directly; components
// that subscribe via the hook only need "is this session busy?" membership.
let lastSetAt = 0;
const COUNTER_TICK_THROTTLE_MS = 2000;

type SetFn = (patch: Partial<ActivityState>) => void;

function open(set: SetFn): void {
  if (es) return;
  let src: EventSource;
  try {
    src = new EventSource(api.config.baseUrl + '/v1/activity/stream');
  } catch {
    return;
  }
  es = src;

  src.onmessage = (ev: MessageEvent) => {
    let data: unknown;
    try {
      data = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const obj = data as Record<string, unknown>;
    // Only `activity` frames carry session state; this also skips the
    // single-key `_hb` heartbeat the feed sends on an idle box.
    if (obj['type'] !== 'activity') return;
    const list = Array.isArray(obj['sessions']) ? (obj['sessions'] as SessionLiveMeta[]) : [];
    const next: Record<string, SessionLiveMeta> = {};
    for (const s of list) {
      if (s && s.sessionId) next[s.sessionId] = s;
    }
    // Push immediately when membership changes (session starts/stops) so busy
    // indicators flip without delay. Suppress pure counter-tick frames
    // (same sessions, just incremented tokens) — no subscriber needs <2s precision.
    const prev = useSessionActivityStore.getState().sessions;
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    const membershipSame =
      prevKeys.length === nextKeys.length && nextKeys.every((k) => k in prev);
    const now = Date.now();
    if (membershipSame && now - lastSetAt < COUNTER_TICK_THROTTLE_MS) return;
    lastSetAt = now;
    set({ sessions: next, connected: true });
  };

  src.onerror = () => {
    set({ connected: false });
    // EventSource auto-reconnects while OPEN/CONNECTING, but once it lands
    // in CLOSED (e.g. a go-core restart) it stays dead. Tear down and
    // re-open on a short backoff so the feed self-heals.
    if (src.readyState === EventSource.CLOSED && es === src) {
      es = null;
      try {
        src.close();
      } catch {
        /* noop */
      }
      if (refCount > 0 && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (refCount > 0) open(set);
        }, 2000);
      }
    }
  };
}

function close(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (es) {
    try {
      es.close();
    } catch {
      /* noop */
    }
    es = null;
  }
}

export const useSessionActivityStore = create<Store>((set) => ({
  sessions: {},
  connected: false,
  connect: () => {
    refCount += 1;
    if (refCount === 1) open((patch) => set(patch));
  },
  disconnect: () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      close();
      set({ connected: false, sessions: {} });
    }
  },
}));

export function getSessionActivity(sessionId: string): SessionLiveMeta | null {
  return useSessionActivityStore.getState().sessions[sessionId] ?? null;
}
