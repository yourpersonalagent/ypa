// scrollIntent — coordination channel between callers that switch sessions
// with a specific scroll target (e.g. NotePanel jumping to a note) and
// MessageList's auto-stick-to-bottom watcher.
//
// Keyed by sessionId so rapid successive clicks (each starting an async
// switchTo) don't overwrite each other's intent — the previous design
// stored a single global pending and lost intents when two switchTo calls
// were in flight at the same time.

export interface ScrollIntent {
  sessionId: string;
  // msgIdx is the position in the source session's messages array. We use
  // it (not _mid) as the source of truth because session.messages from the
  // server don't carry _mid — that's a client-side counter assigned at
  // load time, so a stale snapshot in the picker can't be trusted.
  msgIdx: number;
  // Cosmetic flash class to add briefly when the target lands in view.
  flashClass?: string | undefined;
}

const _pending = new Map<string, ScrollIntent>();

export const SCROLL_INTENT_EVENT = 'yha:scroll-intent';

export function setScrollIntent(intent: ScrollIntent): void {
  _pending.set(intent.sessionId, intent);
  // Event fan-out so MessageList can react WITHOUT a `currentId` change.
  // The picker's switchTo(sameSid) is a no-op on the React state, so the
  // [container, currentId] effect never re-runs — we'd lose the scroll on
  // any "note in the current session" click. The event listener catches
  // that case; cross-session clicks still hit the effect path via the
  // currentId flip after switchTo lands.
  try {
    window.dispatchEvent(new CustomEvent(SCROLL_INTENT_EVENT, {
      detail: { sessionId: intent.sessionId },
    }));
  } catch { /* SSR / non-window contexts */ }
}

export function consumeScrollIntent(sessionId: string): ScrollIntent | null {
  const out = _pending.get(sessionId);
  if (!out) return null;
  _pending.delete(sessionId);
  return out;
}

export function clearScrollIntent(): void {
  _pending.clear();
}
