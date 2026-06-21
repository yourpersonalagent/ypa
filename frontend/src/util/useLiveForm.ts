// useLiveForm — drop-in auto-save form state for "no Save button" panels.
//
// Pattern (mirrors store.ts): setField updates local state immediately
// (optimistic), accumulates a per-form patch, and PUTs/PATCHes it after
// a short debounce window. Multiple field edits inside the window collapse
// into one network call.
//
//   const form = useLiveForm({
//     endpoint: `${api.config.baseUrl}/v1/partners/${id}`,
//     initial: { name: partner.name, symbolColor: partner.symbolColor, ... },
//     onSaved: () => parentReload(),
//   });
//   <input value={form.values.name} onChange={(e) => form.setField('name', e.target.value)} />
//   <SaveStatusBadge status={form.status} />
//
// `endpoint` should be the full URL incl. base. Default method is PUT (the
// backend route already merges partial bodies, so per-field PUTs are safe).

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../toast.js';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface UseLiveFormOpts<T extends object> {
  endpoint: string;
  initial: T;
  method?: 'PUT' | 'PATCH';
  debounceMs?: number;
  onSaved?: (response: unknown) => void;
  errorLabel?: string;
}

interface LiveForm<T> {
  values: T;
  setField: <K extends keyof T>(key: K, val: T[K]) => void;
  setMany: (patch: Partial<T>) => void;
  status: SaveStatus;
  flush: () => Promise<void>;
}

export function useLiveForm<T extends object>(opts: UseLiveFormOpts<T>): LiveForm<T> {
  const { endpoint, initial, method = 'PUT', debounceMs = 400, onSaved, errorLabel = 'Save failed' } = opts;

  const [values, setValues] = useState<T>(initial);
  const [status, setStatus] = useState<SaveStatus>('idle');

  const pendingRef = useRef<Partial<T>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endpointRef = useRef(endpoint);
  const methodRef = useRef(method);
  const onSavedRef = useRef(onSaved);
  const errorLabelRef = useRef(errorLabel);
  endpointRef.current = endpoint;
  methodRef.current = method;
  onSavedRef.current = onSaved;
  errorLabelRef.current = errorLabel;

  // If `initial` identity changes (different record selected), reset state.
  // Use a stable ref so we only reset when the endpoint actually changes.
  const lastEndpointRef = useRef(endpoint);
  if (lastEndpointRef.current !== endpoint) {
    lastEndpointRef.current = endpoint;
    pendingRef.current = {};
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (savedTimerRef.current) { clearTimeout(savedTimerRef.current); savedTimerRef.current = null; }
    // setValues + setStatus inside render — React allows this when guarded.
    setValues(initial);
    setStatus('idle');
  }

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingRef.current = {};
    setStatus('saving');
    try {
      const r = await fetch(endpointRef.current, {
        method: methodRef.current,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      let data: unknown = null;
      try { data = await r.json(); } catch { /* non-json response */ }
      if (!r.ok || (data && typeof data === 'object' && (data as { success?: boolean }).success === false)) {
        const dataErr = data && typeof data === 'object' ? (data as { error?: string }).error : undefined;
        throw new Error(dataErr || `HTTP ${r.status}`);
      }
      setStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setStatus('idle'), 1400);
      onSavedRef.current?.(data);
    } catch (err) {
      setStatus('error');
      toast.show(`${errorLabelRef.current}: ${(err as Error).message}`, 'error');
    }
  }, []);

  const setField = useCallback(<K extends keyof T>(key: K, val: T[K]): void => {
    setValues((prev) => ({ ...prev, [key]: val }));
    pendingRef.current = { ...pendingRef.current, [key]: val };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, debounceMs);
  }, [debounceMs, flush]);

  const setMany = useCallback((patch: Partial<T>): void => {
    setValues((prev) => ({ ...prev, ...patch }));
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void flush(); }, debounceMs);
  }, [debounceMs, flush]);

  // Flush pending on unmount so trailing edits don't get lost.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        void flush();
      }
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [flush]);

  // Flush on tab close. `keepalive: true` lets the browser finish the request
  // after the page has gone away (works for any method, unlike sendBeacon
  // which is POST-only).
  useEffect(() => {
    const onBeforeUnload = (): void => {
      if (Object.keys(pendingRef.current).length === 0) return;
      const patch = pendingRef.current;
      pendingRef.current = {};
      try {
        void fetch(endpointRef.current, {
          method: methodRef.current,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
          keepalive: true,
        });
      } catch { /* best effort */ }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  return { values, setField, setMany, status, flush };
}
