// useApiBusy — single hook that tells the header "is any module currently
// hitting the Anthropic API / model right now?" so the user knows not to
// restart the bridge/server while work is in flight.
//
// Two signals are aggregated:
//
//   1. CHAT STREAMING (synchronous, zero network)
//      `useChatStore.sessionStreams[*]` carries per-session StreamState
//      with `serverActive` / `localLive` / `reconnecting` flags. This is the
//      most common case — a chat is mid-stream from Claude.
//
//   2. CONTEXT-GENERATOR WORKERS (lightweight poll, every 5 s)
//      The bridge exposes status endpoints for the three background
//      pipelines that themselves call the model:
//        • /v1/config/auto-title/status   (TitleGenerator)
//        • /v1/config/context/status      (Categorizer + Sorter substage)
//        • /v1/config/link/status         (LINK sync — non-model but counts)
//      Each replies with an `isRunning` boolean (the Sorter is nested under
//      `categorizer.sorter.isRunning`). When any of those is true, a worker
//      is mid-call and a restart would interrupt it.
//
// Returned shape lets the button show a tooltip listing *what* is busy:
//   { busy: true, reasons: ['chat', 'categorizer'] }
//
// Polling cadence: 5 s while idle is plenty — the worker statuses update
// over a multi-second loop on the backend anyway. No backoff: cheap GETs.

import { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { api } from '../api.js';

interface WorkerStatus {
  isRunning?: boolean;
}
interface CategorizerStatusShape extends WorkerStatus {
  sorter?: WorkerStatus;
}

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

export interface ApiBusyState {
  busy:    boolean;
  reasons: string[];
}

export function useApiBusy(): ApiBusyState {
  // ── Chat streaming (sync) ────────────────────────────────────────────────
  const chatBusy = useChatStore((s) =>
    Object.values(s.sessionStreams).some(
      (st) => st.serverActive || st.localLive || st.reconnecting,
    ),
  );

  // ── Worker statuses (polled) ─────────────────────────────────────────────
  const [workers, setWorkers] = useState<{
    autoTitle:  boolean;
    categorizer:boolean;
    sorter:     boolean;
    link:       boolean;
  }>({ autoTitle: false, categorizer: false, sorter: false, link: false });

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      // Tab backgrounded: skip the three status GETs. setInterval is
      // throttled while hidden anyway, and a busy indicator nobody can see
      // doesn't need refreshing — onVisible below fast-paths a fetch the
      // instant the tab is foregrounded so it's never stale when it
      // matters. Mirrors the gate in net-metrics.ts / AppEffects.tsx.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const url = _baseUrl();
      if (!url) return;
      try {
        const [a, c, l] = await Promise.all([
          fetch(`${url}/v1/config/auto-title/status`).then((r) => r.json()).catch(() => null),
          fetch(`${url}/v1/config/context/status`).then((r) => r.json()).catch(() => null),
          fetch(`${url}/v1/config/link/status`).then((r) => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        const cat = c as CategorizerStatusShape | null;
        setWorkers({
          autoTitle:   !!(a as WorkerStatus | null)?.isRunning,
          categorizer: !!cat?.isRunning,
          sorter:      !!cat?.sorter?.isRunning,
          link:        !!(l as WorkerStatus | null)?.isRunning,
        });
      } catch {
        // Network blip — keep the previous state, don't flip the indicator
        // to "busy" on a transient failure.
      }
    }

    // Refresh the moment the tab returns to the foreground so the indicator
    // reflects current worker state without waiting up to 5 s for the next
    // interval tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };

    tick(); // first fetch immediately so the indicator isn't stale on mount
    const id = window.setInterval(tick, 5000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const reasons: string[] = [];
  if (chatBusy)            reasons.push('chat');
  if (workers.autoTitle)   reasons.push('auto-title');
  if (workers.categorizer) reasons.push('categorizer');
  if (workers.sorter)      reasons.push('sorter');
  if (workers.link)        reasons.push('link sync');

  return { busy: reasons.length > 0, reasons };
}
