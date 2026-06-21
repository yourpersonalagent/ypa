// chatStore — chat messages, streaming state, send/stop/reconnect logic
// Will be the single source of truth for all chat state.
// Phase 1: skeleton + state. Phase 2: migrate streaming logic from chat-streaming.ts.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ChatMessage, Block } from '../chat/chat-utils.js';
import { useAppStore } from './appStore.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StreamState {
  localLive: boolean;
  reconnecting: boolean;
  serverActive: boolean;
  status: string;
}

export interface ChatSegment {
  placeholder: HTMLElement | null;
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
}

export interface ChatState {
  messages: ChatMessage[];
  sessionStreams: Record<string, StreamState>;
  pendingAttachments: Record<string, unknown>[];
  inputHistory: string[];
  segments: Record<string, ChatSegment[]>; // keyed by session id
  lastSessionId: string;
  msgCounter: number;
  // Live streaming HTML per message id — updated on every chunk while typing: true
  streamingSegments: Record<string, string>;
  // Session id that owns the currently-loaded `messages`. Snapshotted from
  // appStore.currentSession every time setMessages() runs, so the live-meta
  // bar can key off the session actually on screen rather than the global
  // currentSession. currentSession flips EARLY in switchTo (setCurrentId)
  // while messages load LATER (after awaited fetchList/fetchSession); keying
  // the bar on currentSession during that window painted the on-screen
  // session's bar with the switched-INTO session's live counters — the
  // "values jump between streams / wrong after switching" bug across
  // concurrent busy sessions. displayedSid advances in lockstep with the
  // messages, so it always matches what's rendered.
  displayedSid: string;
}

export interface ChatActions {
  pushMessage: (msg: ChatMessage) => number;
  updateMessage: (mid: number, patch: Partial<ChatMessage>) => void;
  removeMessage: (mid: number) => void;
  setMessages: (msgs: ChatMessage[]) => void;
  clearMessages: () => void;
  setSessionStreamState: (sessionId: string, patch: Partial<StreamState>) => void;
  getSessionStreamState: (sessionId: string) => StreamState;
  nextMid: () => number;
  setLastSessionId: (id: string) => void;
  addToHistory: (text: string) => void;
  addAttachment: (att: Record<string, unknown>) => void;
  clearAttachments: () => void;
  removeAttachment: (idx: number) => void;
  setStreamingSegment: (mid: string | number, html: string) => void;
  clearStreamingSegment: (mid: string | number) => void;
}

export type ChatStore = ChatState & ChatActions;

// ── Store ──────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatStore>()(devtools((set, get) => ({
  messages: [],
  sessionStreams: {},
  pendingAttachments: [],
  inputHistory: [],
  segments: {},
  lastSessionId: '',
  msgCounter: 0,
  streamingSegments: {},
  displayedSid: '',

  // ── Actions ──
  nextMid: () => {
    const mid = get().msgCounter + 1;
    set({ msgCounter: mid });
    return mid;
  },

  pushMessage: (msg) => {
    const mid = get().nextMid();
    const entry: ChatMessage = { _mid: mid, ts: Date.now(), ...msg };
    set((s) => ({ messages: [...s.messages, entry] }));
    return mid;
  },

  updateMessage: (mid, patch) => {
    set((s) => ({
      messages: s.messages.map((m) => (m._mid === mid ? { ...m, ...patch } : m)),
    }));
  },

  removeMessage: (mid) => {
    set((s) => ({
      messages: s.messages.filter((m) => m._mid !== mid),
    }));
  },

  setMessages: (messages) => {
    const maxMid = messages.reduce((max, m) => Math.max(max, m._mid ?? 0), 0);
    const typingMids = new Set(messages.filter((m) => m.typing).map((m) => String(m._mid)));
    // Snapshot the session these messages belong to. At every setMessages call
    // site — switchTo (after its awaits), create/createWithDir, boot restore,
    // and in-place mutations — currentSession is ALREADY the owning session, so
    // capturing it here keeps displayedSid locked to what's on screen.
    const cur = useAppStore.getState().currentSession;
    set((s) => ({
      messages,
      msgCounter: Math.max(s.msgCounter, maxMid),
      displayedSid: String(cur ?? ''),
      // streamingSegments is a global mid->html map, but only the currently
      // displayed session's typing placeholders can ever consume it. If we
      // keep entries from previously-viewed sessions, every chunk/update pays
      // an ever-growing object spread cost and subscribers that watch the map
      // identity keep waking up long after those sessions are off-screen.
      // Prune aggressively to the typing mids that still exist in `messages`.
      streamingSegments: Object.keys(s.streamingSegments).length === 0
        ? s.streamingSegments
        : Object.fromEntries(
            Object.entries(s.streamingSegments).filter(([mid]) => typingMids.has(mid))
          ),
    }));
  },
  clearMessages: () => set({ messages: [], msgCounter: 0, displayedSid: '', streamingSegments: {} }),

  setSessionStreamState: (sessionId, patch) => {
    set((s) => {
      const current = s.sessionStreams[sessionId] || {
        localLive: false,
        reconnecting: false,
        serverActive: false,
        status: 'idle',
      };
      const next = { ...current, ...patch };
      const sessionStreams = { ...s.sessionStreams };
      if (!next.localLive && !next.reconnecting && !next.serverActive) {
        delete sessionStreams[sessionId];
      } else {
        sessionStreams[sessionId] = next;
      }
      return { sessionStreams };
    });
  },

  getSessionStreamState: (sessionId) => {
    return (
      get().sessionStreams[sessionId] || {
        localLive: false,
        reconnecting: false,
        serverActive: false,
        status: 'idle',
      }
    );
  },

  setLastSessionId: (lastSessionId) => set({ lastSessionId }),

  addToHistory: (text) => {
    set((s) => {
      const history = [text, ...s.inputHistory].slice(0, 100);
      return { inputHistory: history };
    });
  },

  addAttachment: (att) => {
    set((s) => ({ pendingAttachments: [...s.pendingAttachments, att] }));
  },

  clearAttachments: () => set({ pendingAttachments: [] }),

  removeAttachment: (idx) => {
    set((s) => ({
      pendingAttachments: s.pendingAttachments.filter((_, i) => i !== idx),
    }));
  },

  setStreamingSegment: (mid, html) => {
    const key = String(mid);
    set((s) => {
      if (s.streamingSegments[key] === html) return s;
      return { streamingSegments: { ...s.streamingSegments, [key]: html } };
    });
  },

  clearStreamingSegment: (mid) => {
    const key = String(mid);
    set((s) => {
      if (!(key in s.streamingSegments)) return s;
      const next = { ...s.streamingSegments };
      delete next[key];
      return { streamingSegments: next };
    });
  },
}), { name: 'ChatStore' }));

// ── Convenience getters for non-React code ─────────────────────────────────
export function getChatState(): ChatState {
  return useChatStore.getState();
}

export function getChatActions(): ChatActions {
  return useChatStore.getState();
}
