// connectionStore — backend reachability state for the analog-TV shutdown overlay.
// Driven by ConnectionMonitor (heartbeat) and optionally by fetch error paths
// in api.ts. Read by ShutdownOverlay to drive the visual state.
//
// State machine:
//   booting      — initial state on page load; body collapsed (TV-off frozen),
//                  no overlay rendered. main.ts flips to 'booted' once boot completes
//   booted       — transient: TV-on (reverse) plays once on page entry,
//                  then auto-reverts to 'online'
//   online       — default after boot, server healthy
//   lost         — ≥2 consecutive failed heartbeats; TV-off animation runs
//   restored     — first successful heartbeat after 'lost'; TV-on (reverse) plays,
//                  then auto-reverts to 'online' once the overlay finishes
//   unauthorized — heartbeat returned 401; ShutdownOverlay redirects to login

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export type ConnectionStatus =
  | 'booting'
  | 'booted'
  | 'online'
  | 'lost'
  | 'restored'
  | 'unauthorized';

export interface ConnectionState {
  status: ConnectionStatus;
  lastFailureAt: number | null;
}

export interface ConnectionActions {
  setStatus: (next: ConnectionStatus) => void;
}

type ConnectionStore = ConnectionState & ConnectionActions;

export const useConnectionStore = create<ConnectionStore>()(
  devtools(
    (set, get) => ({
      status: 'booting',
      lastFailureAt: null,

      setStatus: (next) => {
        const prev = get().status;
        if (prev === next) return;
        set({
          status: next,
          lastFailureAt: next === 'lost' ? Date.now() : get().lastFailureAt,
        });
      },
    }),
    { name: 'ConnectionStore' }
  )
);

export function getConnectionState(): ConnectionState {
  return useConnectionStore.getState();
}

export function getConnectionActions(): ConnectionActions {
  return useConnectionStore.getState();
}
