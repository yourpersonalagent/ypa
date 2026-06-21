// sessionsDirtyFeed — the "server tells" half of session-list freshness.
//
// Subscribes to the bridge's GET /v1/sessions/events SSE channel. Each frame is
// a content-free "the session list changed" nudge — a message persisted, a
// rename/delete, or a viewed/unread PATCH, possibly from another device, the
// TUI, cron, or a background agent. We respond by pulling a fresh
// session.fetchList(), debounced so a burst of frames collapses to one refetch.
//
// Complements the activity feed (sessionActivityStore): that one pushes live
// BUSY presence; this one pushes list METADATA changes. Together with
// SessionPoller's interval they make the list eventually-consistent under any
// single failure — a dropped frame is caught by the next poll, a missed poll is
// caught by the next frame.
//
// One shared EventSource per page, refcounted exactly like sessionActivityStore.
// Reconnects on drop so it survives a bridge restart (and refetches on recovery
// since changes may have happened while we were disconnected).

import { api } from '../api.js';
import { session } from '../session.js';

let es: EventSource | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefetch(): void {
  // Trailing debounce: many dirty frames in quick succession (a multi-session
  // burst) collapse into a single list pull.
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    void session?.fetchList?.();
  }, 250);
}

function open(): void {
  if (es) return;
  let src: EventSource;
  try {
    src = new EventSource(api.config.baseUrl + '/v1/sessions/events');
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
    if ((data as Record<string, unknown>)['type'] !== 'dirty') return;
    scheduleRefetch();
  };

  src.onerror = () => {
    // EventSource auto-reconnects while OPEN/CONNECTING, but once it lands in
    // CLOSED (e.g. a bridge restart) it stays dead. Tear down and re-open on a
    // short backoff so the feed self-heals — and pull a fresh list on recovery
    // since we may have missed changes while disconnected.
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
          if (refCount > 0) {
            open();
            scheduleRefetch();
          }
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
  if (refetchTimer) {
    clearTimeout(refetchTimer);
    refetchTimer = null;
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

export function connectSessionsDirtyFeed(): void {
  refCount += 1;
  if (refCount === 1) open();
}

export function disconnectSessionsDirtyFeed(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) close();
}
