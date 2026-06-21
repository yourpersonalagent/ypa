// useDraftAutosave — Phase 0 of the ContextGenerator pipeline.
// Dual-layer autosave for the chat input draft.
//
// Two layers, two cadences:
//   • Local  (~750 ms debounce, no streaming gate): writes to localStorage.
//     Synchronous, near-free, restored synchronously on mount → no flash of
//     empty input after reload. This is the layer that fixes the original
//     complaint that "I never see the draft restored after a reload" — the
//     5 s server debounce was longer than most reload moments.
//   • Server (5 s debounce, idle-gated): PUT /v1/drafts/current. Stays the
//     cross-device sync layer (follows you to another browser/tab).
//
// Restore precedence:
//   1. localStorage (sync) — used as the initial textarea value via
//      loadLocalDraft() in ChatInput's useState initializer.
//   2. Server GET — if newer than localStorage's updatedAt, replaces the
//      local value (you typed on another device since this browser last saw
//      the draft).
//
// Both layers are wiped by clearDraft() so a send-then-reload doesn't
// resurrect the just-sent message from either source.
//
// Note: localStorage is keyed `yha.chatDraft` per the existing `yha.X`
// convention in store.ts / app.ts / TabModels.tsx.

import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import { useChatStore } from '../stores/chatStore.js';
import { isBridgeModuleEnabledStrict } from '../host/bridge-modules.js';

const LOCAL_DEBOUNCE_MS  = 750;
const SERVER_DEBOUNCE_MS = 5000;
const LS_KEY = 'yha.chatDraft';

export interface DraftPayload {
  text: string;
  updatedAt: number;
}

function baseUrl(): string {
  return api.config?.baseUrl || '';
}

// Module-scoped mirrors of "what each store currently holds". Module-scoped
// (not hook-scoped via useRef) because the restore / clear paths live outside
// the hook and must agree with the tick callbacks. See the older single-layer
// comment for the resurrect bug this prevents.
let lastSavedLocal  = '';
let lastSavedServer = '';

function readLocal(): DraftPayload | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<DraftPayload>;
    const text = typeof j?.text === 'string' ? j.text : '';
    if (!text) return null;
    return { text, updatedAt: Number(j.updatedAt) || 0 };
  } catch (_) {
    return null;
  }
}

function writeLocal(text: string): void {
  try {
    if (!text) {
      localStorage.removeItem(LS_KEY);
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify({ text, updatedAt: Date.now() }));
    }
    lastSavedLocal = text;
  } catch (_) {
    // Quota / disabled storage — swallow; the server layer still gets a shot.
  }
}

/**
 * Synchronous read of the localStorage draft layer. Call from a useState
 * initializer so the textarea hydrates with the saved value on the very
 * first render — no flash-of-empty-input, no async wait.
 *
 * Also seeds the module-scoped `lastSavedLocal` mirror so the autosave
 * loop's de-dupe stays honest after a restore (the cleared-after-restore
 * resurrect bug applies to the local layer too).
 */
export function loadLocalDraft(): DraftPayload | null {
  const got = readLocal();
  lastSavedLocal = got?.text ?? '';
  return got;
}

export async function loadDraft(): Promise<DraftPayload | null> {
  // Drafts are owned by the chat-extras bridge module — skip when off.
  if (!isBridgeModuleEnabledStrict('chat-extras')) return null;
  const url = baseUrl();
  if (!url) return null;
  try {
    const r = await fetch(url + '/v1/drafts/current');
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<DraftPayload>;
    const text = typeof j?.text === 'string' ? j.text : '';
    // Seed ground truth with whatever the server actually has (incl. '' for
    // "no draft on file"). Without this seed a clear-after-restore looks
    // like a no-op because the de-dupe still saw the initial ''.
    lastSavedServer = text;
    if (!text) return null;
    return { text, updatedAt: Number(j.updatedAt) || 0 };
  } catch (_) {
    return null;
  }
}

export function clearDraft(): void {
  // Wipe both layers so a send-then-reload doesn't resurrect the just-sent
  // message from either source. Keep the local mirrors in sync so the
  // autosave loop's de-dupe still works even when the bridge module is off.
  writeLocal('');
  lastSavedServer = '';
  if (!isBridgeModuleEnabledStrict('chat-extras')) return;
  const url = baseUrl();
  if (!url) return;
  // Fire-and-forget — we just sent the message, the user doesn't care if the
  // delete races. A failed clear self-heals on the next keystroke.
  fetch(url + '/v1/drafts/current', { method: 'DELETE' }).catch(() => {});
}

function isAnyStreaming(): boolean {
  // "nichts los is" gate — don't write to the server while a model is mid-
  // response. The stream finalizer flips both flags off, so as soon as the
  // answer lands the next debounce tick will save. Local layer ignores this
  // gate: localStorage writes are free and we want the freshest value there.
  const streams = useChatStore.getState().sessionStreams || {};
  return Object.values(streams).some((s) => s?.localLive || s?.serverActive);
}

/**
 * Watches `value` and lazily persists it to both layers:
 *   - localStorage after LOCAL_DEBOUNCE_MS  (~750 ms, no gate)
 *   - server        after SERVER_DEBOUNCE_MS (5 s, streaming-gated)
 *
 * Pass a stable `enabled` flag to suspend during e.g. submit-in-progress.
 */
export function useDraftAutosave(value: string, enabled: boolean = true): void {
  const localTimerRef  = useRef<number | null>(null);
  const serverTimerRef = useRef<number | null>(null);
  // Track the latest value so timer callbacks always see fresh input — the
  // closure would otherwise capture a stale `value` from the render that
  // armed the timer.
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    if (!enabled) return;

    function clearLocalTimer() {
      if (localTimerRef.current !== null) {
        window.clearTimeout(localTimerRef.current);
        localTimerRef.current = null;
      }
    }
    function clearServerTimer() {
      if (serverTimerRef.current !== null) {
        window.clearTimeout(serverTimerRef.current);
        serverTimerRef.current = null;
      }
    }

    function scheduleLocal() {
      clearLocalTimer();
      localTimerRef.current = window.setTimeout(tickLocal, LOCAL_DEBOUNCE_MS);
    }
    function scheduleServer() {
      clearServerTimer();
      serverTimerRef.current = window.setTimeout(tickServer, SERVER_DEBOUNCE_MS);
    }

    function tickLocal() {
      localTimerRef.current = null;
      const current = valueRef.current;
      if (current === lastSavedLocal) return;
      writeLocal(current);
    }

    async function tickServer() {
      serverTimerRef.current = null;
      const current = valueRef.current;
      if (current === lastSavedServer) return;
      // Idle gate: re-arm without saving while a stream is in flight.
      if (isAnyStreaming()) {
        scheduleServer();
        return;
      }
      if (!isBridgeModuleEnabledStrict('chat-extras')) return;
      const url = baseUrl();
      if (!url) return;
      try {
        const r = await fetch(url + '/v1/drafts/current', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: current }),
        });
        if (r.ok) lastSavedServer = current;
      } catch (_) {
        // Silent — the next keystroke re-arms the timer and we'll retry.
      }
    }

    scheduleLocal();
    scheduleServer();
    return () => {
      clearLocalTimer();
      clearServerTimer();
    };
  }, [value, enabled]);
}

/**
 * Imperative shortcut — record what the caller has just persisted (e.g. after
 * a successful send-then-clear) so the autosave loop won't redundantly write
 * the cleared empty value. Updates both layer mirrors.
 */
export function markDraftSaved(text: string): void {
  lastSavedLocal  = text;
  lastSavedServer = text;
}
