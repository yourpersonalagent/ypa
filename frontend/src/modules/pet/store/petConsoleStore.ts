// petConsoleStore — Phase 1.5 of the ContextGenerator pipeline.
//
// Two responsibilities, both feeding the SAME bubble next to the floating
// pet:
//
//   1. Quick-chat console
//      ─ One-line user input → 3–5 line answer from the cheap NVIDIA
//        llama-3.1-8b-instruct lane (POST /v1/pet-console/ask).
//      ─ Last 5 turns kept in-memory ONLY, not persisted, not server-saved.
//
//   2. Toaster routing
//      ─ When `petStore.isVisible === true` the toast wire-up in
//        petBubbleRouter.ts diverts every `useToastStore.show(...)` into
//        `pushToastBubble(...)` instead of the global `<ToastStack />`.
//      ─ When the pet is hidden, toasts go through the classic stack.
//
// User input always opens the bubble; toast bubbles also open it but auto-
// dismiss themselves after a short window. User Q&A has visual priority —
// toast bubbles render below the conversation so they never push the user's
// own messages off the visible 3–5-line window.
//
// State lives in Zustand for the same reasons as contextStore: cross-
// component access without prop drilling, easy `useSyncExternalStore`-style
// subscription from non-React code (the patched `show` action). No
// localStorage — by design the pet feels ephemeral; reload = blank slate.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { api } from '../../../api.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Override the pet's chat uses instead of the auto-title model on the bridge.
 *  Hydrated from localStorage (`yha.pet.chat.model`) on store init and kept in
 *  sync via `setPetModelOverride()` from PetQuickChatSection (the in-popover
 *  pet chat config UI). When set, every /v1/pet-console/ask call forwards
 *  `{ override: { model, provider } }` so the bridge picks this model instead
 *  of the auto-title default.
 *
 *  null  = no override → bridge falls back to autoTitle / petConsole config. */
export interface PetModelOverride {
  /** Internal id from the model picker — surfaced for parity but not required
   *  by the bridge (the bridge keys off provider name + model name). */
  id?:      number;
  /** Model name as the upstream API expects it (e.g. "meta/llama-3.1-8b-instruct"). */
  name:     string;
  /** Provider entry name as it appears in `config.providers[*].name`. */
  provider: string;
}

/** Pet capability prefs (vision/reasoning/tools). Mirror of the chat-input
 *  CapabilityBadges semantics, kept SEPARATE so the pet can run with different
 *  caps from the main chat. Forwarded to the bridge for future use; the cheap
 *  llama-3.1-8b lane currently ignores them, but routing them through means
 *  switching the pet to an o-series or Sonnet model immediately picks them up
 *  once the bridge wires them into the upstream call. */
export interface PetCapsOverride {
  vision?:    boolean;
  reasoning?: 'enabled' | 'disabled' | null;
  tools?:     'on' | 'filter' | false;
}

export type PetConsoleRole = 'user' | 'assistant';

export interface PetConsoleTurn {
  id:        number;          // monotonically increasing counter
  role:      PetConsoleRole;
  text:      string;
  at:        number;          // Date.now() when the turn was added
  /** Set when the assistant turn came back as an upstream error (not a
   *  silent failure) — bubble UI shows it differently from a normal answer. */
  isError?:  boolean;
  /** Names of bridge/MCP tools the assistant called while producing this
   *  answer (only populated when `caps.tools` was on for the request). The
   *  bubble renders these as a small "🔧 Read, Bash" annotation under the
   *  text so the user can see WHY a quick-chat answer took longer than
   *  usual. */
  toolsUsed?: string[];
}

export type PetToastBubbleType = 'info' | 'success' | 'warning' | 'error' | 'running';

export interface PetToastBubble {
  id:       string;
  message:  string;
  title?:   string;
  type:     PetToastBubbleType;
  /** ms to live in the bubble. 0 = persistent until dismissed. */
  duration: number;
  /** epoch-ms when it was added (used for FIFO + stale-cleanup). */
  at:       number;
}

interface PetConsoleState {
  /** FULL console open / closed (history + input + status footer).
   *
   *  Set to `true` ONLY by an explicit user gesture:
   *    • click on the floating pet (FloatingPet's gated handler)
   *    • the user submitting a quick-chat (typing pulls focus into the bubble)
   *    • a programmatic `setOpen(true)` from a header shortcut (future).
   *
   *  Crucially: a routed toast does NOT flip this. Toasts render in a small
   *  "minimal toast popover" next to the pet (see PetConsoleBubble) without
   *  stealing focus from whatever the user is typing into. The full console
   *  only appears when the user actively asks for it.
   *
   *  Renamed from `open` on 2026-05-06 to make the semantics explicit — the
   *  old `open` flag conflated "minimal toast visible" with "full console
   *  visible" and caused focus-steal regressions when a toast arrived while
   *  the user was typing in the chat input. */
  consoleOpen:    boolean;
  /** Last 5 user/assistant turns. Newest at the END so render order is
   *  natural (top→bottom = oldest→newest). */
  history:        PetConsoleTurn[];
  /** True while a /v1/pet-console/ask is in flight. The UI shows a small
   *  "thinking…" placeholder + disables the input. */
  pending:        boolean;
  /** Sticky last-error so the user can see "model offline" without us
   *  appending a fake assistant turn. Cleared on next successful ask. */
  error:          string | null;
  /** Cheapness-of-the-cheap-model snapshot from /v1/pet-console/status. The
   *  bubble surfaces this as a tiny line under the input. */
  modelLabel:     string | null;
  /** Toast bubbles queued for inline display. Newest LAST. Auto-pruned when
   *  duration elapses (handled by the component's setTimeouts, mirrored
   *  here for component-mount-safety). */
  toastBubbles:   PetToastBubble[];
  /** Pet-specific model selection (set via the pet popover's quick-chat
   *  section). When non-null this OVERRIDES the bridge default (auto-title
   *  model). null = use the auto-title model. Hydrated from localStorage on
   *  store init so a page reload preserves the user's pet model pick. */
  petModelOverride: PetModelOverride | null;
  /** Pet-specific capability prefs (vision/reasoning/tools). Currently
   *  forwarded but not used by the cheap-lane upstream call — see comment on
   *  PetCapsOverride. Hydrated from localStorage on store init. */
  petCapsOverride:  PetCapsOverride | null;
}

interface PetConsoleActions {
  /** Toggle the FULL console. Used by the click-gate in FloatingPet.
   *  Closing the console does NOT clear toast bubbles — they keep auto-
   *  dismissing in the minimal popover. */
  setOpen:           (v: boolean) => void;
  toggleOpen:        () => void;
  ask:               (input: string) => Promise<{ answer: string; toolsUsed?: string[] } | null>;
  /** Abort the in-flight /v1/pet-console/ask request. The aborted request
   *  resolves with a null result (no error turn appended); callers (Send
   *  button → Stop button, voice-mode interrupt) use this to short-circuit
   *  when the user wants to take their turn back. */
  abortPending:      () => void;
  clearHistory:      () => void;
  refreshStatus:     () => Promise<void>;
  pushToastBubble:   (bubble: Omit<PetToastBubble, 'id' | 'at'> & { id?: string }) => string;
  dismissToastBubble:(id: string) => void;
  clearToastBubbles: () => void;
  /** Set/clear the pet model override. Called by PetQuickChatSection whenever
   *  the user picks a model in the pet popover. Pass `null` to clear and fall
   *  back to the auto-title default. */
  setPetModelOverride: (m: PetModelOverride | null) => void;
  /** Set/clear the pet capability override. Called by PetQuickChatSection
   *  whenever the user toggles a 👁/◈/⚙ badge in the pet popover. */
  setPetCapsOverride:  (c: PetCapsOverride | null) => void;
}

type PetConsoleStore = PetConsoleState & PetConsoleActions;

// ── Constants ────────────────────────────────────────────────────────────────

/** Total turns retained = MAX_HISTORY_TURNS × 2 (each turn = user + assistant). */
const MAX_HISTORY_TURNS = 5;
const MAX_INPUT_CHARS   = 600;

// LocalStorage keys — must match PetQuickChat.tsx so both the popover UI and
// the store stay in lock-step. Single source of truth lives in PetQuickChat.tsx
// (the user-facing setting); the store mirrors here for hydration on init.
const LS_PET_MODEL      = 'yha.pet.chat.model';
const LS_PET_CAPS       = 'yha.pet.chat.caps';
/** Session id the user picked in the 🐾 Pet Chat popover. We read this at
 *  ask-time (not via Zustand state) so a session-pick made AFTER the store
 *  was created still flows through. PetQuickChat.tsx is the writer. */
const LS_PET_SESSION_ID = 'yha.pet.chat.sessionId';

let _turnCounter   = 0;
let _bubbleCounter = 0;
/** AbortController for the currently in-flight /v1/pet-console/ask request.
 *  Kept at module-scope (not in Zustand state) because it isn't part of any
 *  render and React's strict-mode double-invoke would otherwise nuke it. */
let _askAbort: AbortController | null = null;

// ── LocalStorage hydration helpers ──────────────────────────────────────────

function _hydratePetModelOverride(): PetModelOverride | null {
  try {
    const raw = localStorage.getItem(LS_PET_MODEL);
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<PetModelOverride> | null;
    if (!m || typeof m.name !== 'string' || typeof m.provider !== 'string') return null;
    if (!m.name || !m.provider) return null;
    return { id: m.id, name: m.name, provider: m.provider };
  } catch { return null; }
}

function _hydratePetCapsOverride(): PetCapsOverride | null {
  try {
    const raw = localStorage.getItem(LS_PET_CAPS);
    if (!raw) return null;
    const c = JSON.parse(raw) as PetCapsOverride | null;
    if (!c || typeof c !== 'object') return null;
    return c;
  } catch { return null; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

function _trimmedHistory(history: PetConsoleTurn[]): { role: PetConsoleRole; text: string }[] {
  // Forward the last MAX_HISTORY_TURNS PAIRS — that's roughly the last 10
  // entries. We keep the bridge stateless; it just sees what we send.
  const tail = history.slice(-MAX_HISTORY_TURNS * 2);
  return tail
    .filter((t) => !t.isError)
    .map((t) => ({ role: t.role, text: t.text }));
}

// ── Store ────────────────────────────────────────────────────────────────────

export const usePetConsoleStore = create<PetConsoleStore>()(
  devtools(
    (set, get) => ({
      consoleOpen:      false,
      history:          [],
      pending:          false,
      error:            null,
      // Seed modelLabel from any pet override so the bubble's status footer
      // shows the user's chosen model immediately on first paint, before
      // refreshStatus() fires. If no override is set, falls back to the
      // status endpoint (which reports the auto-title model) on bubble open.
      modelLabel:       (() => {
        const m = _hydratePetModelOverride();
        return m ? `${m.name} · ${m.provider}` : null;
      })(),
      toastBubbles:     [],
      petModelOverride: _hydratePetModelOverride(),
      petCapsOverride:  _hydratePetCapsOverride(),

      setOpen: (v) => set({ consoleOpen: v }),
      toggleOpen: () => set((s) => ({ consoleOpen: !s.consoleOpen })),

      ask: async (rawInput) => {
        const input = String(rawInput || '').trim().slice(0, MAX_INPUT_CHARS);
        if (!input || get().pending) return null;

        // Append the user turn IMMEDIATELY so the bubble shows it before the
        // network round-trip lands. Mirrors the optimistic-render pattern in
        // the main chat path.
        const userTurn: PetConsoleTurn = {
          id:   ++_turnCounter,
          role: 'user',
          text: input,
          at:   Date.now(),
        };
        // Submitting a question implies the user wants the full console
        // visible (they typed into it) — that is the ONE programmatic path
        // that flips `consoleOpen` to true. Toast routing does not.
        set((s) => ({
          history:     [...s.history, userTurn].slice(-MAX_HISTORY_TURNS * 2),
          pending:     true,
          error:       null,
          consoleOpen: true,
        }));

        const url = _baseUrl();
        if (!url) {
          set({ pending: false, error: 'no bridge URL' });
          return null;
        }
        // Set up the abort handle BEFORE the network call so a near-instant
        // abortPending() (e.g. user clicks Stop the same tick we kick off)
        // still cancels in flight. Previous controller, if any, was already
        // resolved when `pending` flipped false; replacing it here is safe.
        _askAbort = new AbortController();
        const myAbort = _askAbort;
        try {
          // Read overrides at request-time (rather than from the closure) so
          // the freshest values are sent — the user may have switched models
          // or toggled caps mid-conversation between turns.
          const petModel = get().petModelOverride;
          const petCaps  = get().petCapsOverride;
          // Read the pet session id directly from localStorage (single source
          // of truth — PetQuickChat.tsx writes it). When non-empty, the
          // bridge appends both the user input and the assistant answer to
          // that session via pushDisplayMsg() so the pet's conversation
          // actually persists in the background — the session shows up in
          // the picker and can be opened in the main chat for a full view.
          const petSessionId = (() => {
            try { return localStorage.getItem(LS_PET_SESSION_ID) || ''; }
            catch { return ''; }
          })();
          const r = await fetch(`${url}/v1/pet-console/ask`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  myAbort.signal,
            body:    JSON.stringify({
              input,
              // Send history WITHOUT the just-pushed user turn — the bridge
              // appends `input` itself as the latest user message.
              history: _trimmedHistory(get().history.slice(0, -1)),
              // Forward the pet's chat config (set in the pet popover via
              // PetQuickChatSection). Bridge falls back to the auto-title
              // model when override is absent. Caps are forwarded for future
              // use; the cheap NVIDIA lane currently ignores them.
              ...(petModel
                ? { override: { model: petModel.name, provider: petModel.provider, caps: petCaps || undefined } }
                : {}),
              // Persist into the user-picked pet session (if any). When
              // empty/absent the bridge keeps the legacy ephemeral path.
              ...(petSessionId ? { sessionId: petSessionId } : {}),
            }),
          });
          const j = (await r.json().catch(() => ({}))) as {
            ok?:        boolean;
            answer?:    string;
            error?:     string;
            model?:     string;
            provider?:  string;
            toolsUsed?: string[];
          };
          if (!r.ok || !j?.ok || !j.answer) {
            const errMsg = String(j?.error || `HTTP ${r.status}`);
            const errTurn: PetConsoleTurn = {
              id:      ++_turnCounter,
              role:    'assistant',
              text:    `(${errMsg})`,
              at:      Date.now(),
              isError: true,
            };
            set((s) => ({
              history: [...s.history, errTurn].slice(-MAX_HISTORY_TURNS * 2),
              pending: false,
              error:   errMsg,
            }));
            if (_askAbort === myAbort) _askAbort = null;
            return null;
          }
          const aiTurn: PetConsoleTurn = {
            id:        ++_turnCounter,
            role:      'assistant',
            text:      j.answer,
            at:        Date.now(),
            toolsUsed: Array.isArray(j.toolsUsed) && j.toolsUsed.length ? j.toolsUsed : undefined,
          };
          // Build a "{model} · {provider}" label so the bubble's status
          // footer matches the format used by refreshStatus(); falls back to
          // model alone when the bridge omits provider for some reason.
          const newLabel = j.model
            ? (j.provider ? `${j.model} · ${j.provider}` : j.model)
            : null;
          set((s) => ({
            history:    [...s.history, aiTurn].slice(-MAX_HISTORY_TURNS * 2),
            pending:    false,
            error:      null,
            modelLabel: newLabel || s.modelLabel,
          }));
          if (_askAbort === myAbort) _askAbort = null;
          return { answer: j.answer, toolsUsed: aiTurn.toolsUsed };
        } catch (e) {
          // User-triggered abort: leave the optimistic user turn in place
          // (so they can see what they asked) and silently drop. No error
          // banner, no synthetic assistant turn.
          if (myAbort.signal.aborted) {
            set({ pending: false, error: null });
            if (_askAbort === myAbort) _askAbort = null;
            return null;
          }
          const msg = e instanceof Error ? e.message : String(e);
          const errTurn: PetConsoleTurn = {
            id:      ++_turnCounter,
            role:    'assistant',
            text:    `(${msg})`,
            at:      Date.now(),
            isError: true,
          };
          set((s) => ({
            history: [...s.history, errTurn].slice(-MAX_HISTORY_TURNS * 2),
            pending: false,
            error:   msg,
          }));
          if (_askAbort === myAbort) _askAbort = null;
          return null;
        }
      },

      abortPending: () => {
        if (!_askAbort) return;
        try { _askAbort.abort(); } catch { /* already aborted — non-fatal */ }
        _askAbort = null;
      },

      clearHistory: () => set({ history: [], error: null }),

      refreshStatus: async () => {
        const url = _baseUrl();
        if (!url) return;
        try {
          const r = await fetch(`${url}/v1/pet-console/status`);
          if (!r.ok) return;
          const j = (await r.json()) as {
            ok?:        boolean;
            configured?: boolean;
            model?:     string | null;
            provider?:  string | null;
          };
          // If the user has set a pet override, the bubble should keep showing
          // their pick — the /status endpoint always returns the auto-title
          // model, so blindly overwriting would erase the override label.
          const override = get().petModelOverride;
          if (override) {
            set({ modelLabel: `${override.name} · ${override.provider}` });
            return;
          }
          set({
            modelLabel: j?.configured && j.model ? `${j.model} · ${j.provider || 'cheap-lane'}` : null,
          });
        } catch {
          /* non-fatal — status is informational only */
        }
      },

      pushToastBubble: (bubble) => {
        const id = bubble.id || `petbub-${Date.now()}-${++_bubbleCounter}`;
        const entry: PetToastBubble = {
          id,
          message:  bubble.message,
          title:    bubble.title,
          type:     bubble.type,
          duration: bubble.duration,
          at:       Date.now(),
        };
        set((s) => {
          // Replace if same id already queued (running → done update flow).
          const existing = s.toastBubbles.findIndex((t) => t.id === id);
          let next: PetToastBubble[];
          if (existing !== -1) {
            next = [...s.toastBubbles];
            next[existing] = entry;
          } else {
            next = [...s.toastBubbles, entry].slice(-6);
          }
          // CRITICAL — do NOT touch `consoleOpen` here. Per user feedback
          // 2026-05-06: a routed toast must never steal focus from the chat
          // input. The bubble component renders a *minimal toast popover*
          // when toasts are queued and `consoleOpen === false`, and the FULL
          // console only when `consoleOpen === true` (i.e. the user clicked
          // the pet or submitted a question themselves).
          return { toastBubbles: next };
        });
        return id;
      },

      dismissToastBubble: (id) =>
        set((s) => ({ toastBubbles: s.toastBubbles.filter((t) => t.id !== id) })),

      clearToastBubbles: () => set({ toastBubbles: [] }),

      setPetModelOverride: (m) => {
        // Persist alongside the in-store value so a fresh tab boots with the
        // same pick. PetQuickChatSection ALSO writes to the same key when the
        // user picks a model — that's intentional double-write so either path
        // (popover toggle vs. direct API call) keeps both representations in
        // sync.
        try {
          if (m) localStorage.setItem(LS_PET_MODEL, JSON.stringify(m));
          else   localStorage.removeItem(LS_PET_MODEL);
        } catch { /* quota / private-mode — non-fatal */ }
        // Also refresh the displayed modelLabel so the bubble's status line
        // updates the moment the user picks a new model in the popover, even
        // before they fire off another /ask.
        set({
          petModelOverride: m,
          modelLabel: m ? `${m.name} · ${m.provider}` : null,
        });
      },

      setPetCapsOverride: (c) => {
        try {
          if (c) localStorage.setItem(LS_PET_CAPS, JSON.stringify(c));
          else   localStorage.removeItem(LS_PET_CAPS);
        } catch { /* quota / private-mode — non-fatal */ }
        set({ petCapsOverride: c });
      },
    }),
    { name: 'PetConsoleStore' }
  )
);

// ── Convenience getters for non-React code ──────────────────────────────────

export function getPetConsoleState(): PetConsoleState {
  return usePetConsoleStore.getState();
}
export function getPetConsoleActions(): PetConsoleActions {
  return usePetConsoleStore.getState();
}
