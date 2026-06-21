// usePendingConfirms — client-side mirror of the bridge's whitelist (Phase 1a).
//
// The bridge holds the canonical 30-min TTL whitelist in server memory; the
// frontend mirrors it so the SensitivityGate doesn't keep re-prompting after
// the user clicked "Confirm Access — Remember for 30 min".
//
// Why mirror at all?
//   • The SensitivityGate is rendered before the read endpoint is called,
//     so it needs to know whether to skip itself for already-confirmed items.
//   • Storing only on the server would force us to round-trip a HEAD-style
//     check for every click — wasteful in a popover UX.
//
// Persistence: in-memory only (matches the server). Tab reload = fresh slate,
// matching the explicit doc decision in §8 (Sensitivity Whitelist-Persistenz).

import { useSyncExternalStore } from 'react';
import { api } from '../api.js';

const TTL_MS = 30 * 60 * 1_000;

interface Entry {
  itemId:    string;
  expiresAt: number;   // 0 = single-use; otherwise epoch-ms
}

const _entries = new Map<string, Entry>();
const _listeners = new Set<() => void>();

function _emit(): void {
  for (const l of _listeners) l();
}

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

function _now(): number { return Date.now(); }

// ── Public surface ────────────────────────────────────────────────────────────

export function isConfirmed(itemId: string): boolean {
  const e = _entries.get(itemId);
  if (!e) return false;
  if (e.expiresAt !== 0 && e.expiresAt < _now()) {
    _entries.delete(itemId);
    _emit();
    return false;
  }
  return true;
}

// Single-use confirm. The matching server entry is consumed on first read.
export async function confirmOnce(itemId: string): Promise<boolean> {
  return _persistConfirm(itemId, 'once');
}

// Session-scoped confirm. Matches the server's 30-min TTL exactly.
export async function confirmForSession(itemId: string): Promise<boolean> {
  return _persistConfirm(itemId, 'session');
}

async function _persistConfirm(itemId: string, scope: 'once' | 'session'): Promise<boolean> {
  const url = _baseUrl();
  if (!url) return false;
  try {
    const r = await fetch(`${url}/v1/context/sensitivity/confirm`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ itemId, scope }),
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { success?: boolean; expiresAt?: number };
    if (!j?.success) return false;
    _entries.set(itemId, {
      itemId,
      expiresAt: scope === 'session' ? (Number(j.expiresAt) || _now() + TTL_MS) : 0,
    });
    _emit();
    return true;
  } catch (_) {
    return false;
  }
}

export function consume(itemId: string): void {
  // Single-use entries flip to "consumed" when the read endpoint succeeds.
  // The server already drops its entry; we mirror that here so the badge
  // reflects re-locked state on next render.
  const e = _entries.get(itemId);
  if (!e) return;
  if (e.expiresAt === 0) {
    _entries.delete(itemId);
    _emit();
  }
}

export function clearAll(): void {
  _entries.clear();
  _emit();
  // Best-effort server reset.
  const url = _baseUrl();
  if (!url) return;
  fetch(`${url}/v1/context/sensitivity/confirm`, { method: 'DELETE' }).catch(() => {});
}

// React hook — re-renders when any entry changes.
export function usePendingConfirms(): {
  isConfirmed:        (id: string) => boolean;
  confirmOnce:        (id: string) => Promise<boolean>;
  confirmForSession:  (id: string) => Promise<boolean>;
  size:               number;
} {
  const subscribe = (cb: () => void) => {
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  };
  // useSyncExternalStore returns a snapshot — entries.size is stable as a
  // dep marker here; consumers call isConfirmed() on demand for per-item state.
  const size = useSyncExternalStore(subscribe, () => _entries.size, () => _entries.size);
  return {
    isConfirmed,
    confirmOnce,
    confirmForSession,
    size,
  };
}
