// Bridge-side rendezvous for controlling the currently visible YPA app tab.
//
// The Frontend bridge tool broadcasts a request into the active session's SSE
// stream and waits here. The browser-local frontend-agent runtime executes the
// request against the live command/surface registers, then POSTs the result to
// the matching session route. This deliberately controls the user's existing
// app tab; it does not launch or automate a second browser.
'use strict';

const crypto = require('node:crypto');

interface PendingFrontendRequest {
  resolve: (result: any) => void;
  sessionId: string;
  timer: NodeJS.Timeout;
}

type FrontendRequestListener = (request: Record<string, unknown>) => void;

const pending: Map<string, PendingFrontendRequest> = new Map();
const listenersBySession: Map<string, Set<FrontendRequestListener>> = new Map();
const DEFAULT_TIMEOUT_MS = 20_000;

function newRequestId(): string {
  return 'fa_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

function registerFrontendRequest(
  sessionId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): { id: string; promise: Promise<any> } {
  const id = newRequestId();
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve({
        ok: false,
        error: 'No visible YPA app tab responded. Keep the session open in the foreground and retry.',
      });
    }, timeoutMs);
    pending.set(id, { resolve, sessionId, timer });
  });
  return { id, promise };
}

function resolveFrontendRequest(id: string, sessionId: string, result: any): boolean {
  const entry = pending.get(id);
  if (!entry || entry.sessionId !== sessionId) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(result);
  return true;
}

function peekFrontendRequest(id: string): { sessionId: string } | null {
  const entry = pending.get(id);
  return entry ? { sessionId: entry.sessionId } : null;
}

function subscribeFrontendRequests(
  sessionId: string,
  listener: FrontendRequestListener,
): () => void {
  let listeners = listenersBySession.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    listenersBySession.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersBySession.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersBySession.delete(sessionId);
  };
}

function publishFrontendRequest(sessionId: string, request: Record<string, unknown>): number {
  const listeners = listenersBySession.get(sessionId);
  if (!listeners?.size) return 0;
  let delivered = 0;
  for (const listener of [...listeners]) {
    try {
      listener(request);
      delivered++;
    } catch (_) {
      // The owning SSE route removes dead listeners on socket close.
    }
  }
  return delivered;
}

function listFrontendSessions(): Array<{ sessionId: string; listeners: number }> {
  return [...listenersBySession.entries()].map(([sessionId, listeners]) => ({
    sessionId,
    listeners: listeners.size,
  }));
}

module.exports = {
  registerFrontendRequest,
  resolveFrontendRequest,
  peekFrontendRequest,
  subscribeFrontendRequests,
  publishFrontendRequest,
  listFrontendSessions,
};
