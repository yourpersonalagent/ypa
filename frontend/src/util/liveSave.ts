// liveSave — vanilla TS counterpart of useLiveForm for non-React prefs tabs.
//
// Pattern: each row creates a group; field listeners call group.patch({...}).
// Multiple patches inside the debounce window collapse into a single PATCH
// containing the merged body. A status element (small inline span) shows
// "saving…" / "✓ saved" / "⚠ error".
//
//   const group = liveSave({
//     endpoint: `${base}/v1/config/`,
//     statusEl: row.querySelector('.row-status'),
//     buildBody: (patch) => ({ provider: 'OpenAI', ...patch }),
//   });
//   keyInput.addEventListener('blur', () => {
//     const v = keyInput.value.trim();
//     if (v) group.patch({ api_key: v });
//   });
//
// `buildBody` (optional) wraps the accumulated patch — useful for endpoints
// that need an identifier alongside the changed fields. `flush()` forces
// the pending PATCH out (call before navigating away or before a follow-up
// action that depends on the save being persisted).

import { toast } from '../toast.js';

interface LiveSaveOpts {
  endpoint: string;
  method?: 'PATCH' | 'PUT';
  debounceMs?: number;
  errorLabel?: string;
  statusEl?: HTMLElement | null;
  buildBody?: (patch: Record<string, unknown>) => Record<string, unknown>;
  onSaved?: (data: unknown) => void;
}

export interface LiveSaveHandle {
  patch: (partial: Record<string, unknown>) => void;
  flush: () => Promise<void>;
}

const SAVED_FADE_MS = 1400;

function setStatus(el: HTMLElement | null | undefined, kind: 'idle' | 'saving' | 'saved' | 'error'): void {
  if (!el) return;
  if (kind === 'idle')  { el.textContent = ''; el.style.color = ''; return; }
  if (kind === 'saving') { el.textContent = '…'; el.style.color = 'var(--fg-dim)'; return; }
  if (kind === 'saved')  { el.textContent = '✓ saved'; el.style.color = 'var(--accent)'; return; }
  if (kind === 'error')  { el.textContent = '⚠ error'; el.style.color = 'var(--danger, #ff5060)'; return; }
}

export function liveSave(opts: LiveSaveOpts): LiveSaveHandle {
  const {
    endpoint,
    method = 'PATCH',
    debounceMs = 400,
    errorLabel = 'Save failed',
    statusEl = null,
    buildBody,
    onSaved,
  } = opts;

  let pending: Record<string, unknown> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let savedFadeTimer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (Object.keys(pending).length === 0) return;
    const body = buildBody ? buildBody(pending) : pending;
    pending = {};
    setStatus(statusEl, 'saving');
    try {
      const r = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data: unknown = null;
      try { data = await r.json(); } catch { /* non-json */ }
      if (!r.ok || (data && typeof data === 'object' && (data as { success?: boolean }).success === false)) {
        const dataErr = data && typeof data === 'object' ? (data as { error?: string }).error : undefined;
        throw new Error(dataErr || `HTTP ${r.status}`);
      }
      setStatus(statusEl, 'saved');
      if (savedFadeTimer) clearTimeout(savedFadeTimer);
      savedFadeTimer = setTimeout(() => setStatus(statusEl, 'idle'), SAVED_FADE_MS);
      onSaved?.(data);
    } catch (err) {
      setStatus(statusEl, 'error');
      toast.show(`${errorLabel}: ${(err as Error).message}`, 'error');
    }
  }

  function patch(partial: Record<string, unknown>): void {
    pending = { ...pending, ...partial };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, debounceMs);
  }

  return { patch, flush };
}

// Attach a small inline status span at the end of an action area.
// Returns the created element so the caller can pass it to liveSave(...).
export function attachStatusEl(host: HTMLElement): HTMLElement {
  const el = document.createElement('span');
  el.className = 'prefs-live-status';
  el.style.fontSize = '11px';
  el.style.color = 'var(--fg-dim)';
  el.style.minWidth = '60px';
  host.appendChild(el);
  return el;
}
