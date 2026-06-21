// Debounced inline-suggestion hook.
//
// Contract:
//   - Caller passes the live textarea value, whether the cursor is at the
//     end, and whether any picker (command / mention) is open.
//   - Hook returns { suggestion, accept, dismiss }.
//   - On each value change: cancel any in-flight request + clear suggestion,
//     then schedule a new fetch after `debounceMs` ms of idle.
//   - Sequence numbers + AbortController drop stale responses.
//   - Tiny LRU cache keyed on the input text — retyping the same prefix
//     reuses the previous suggestion for free.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { useChatStore } from '../../stores/chatStore.js';
import { useAutocompleteConfig } from './configStore.js';

const CACHE_MAX = 64;

// Read tail of the most recent chat message (assistant or user) from
// chatStore at fetch time. No subscription — we only need a snapshot per
// request, and subscribing would re-render the input on every streaming chunk.
function readHistoryTail(maxChars: number): string {
  if (maxChars <= 0) return '';
  const msgs = useChatStore.getState().messages;
  if (!msgs || msgs.length === 0) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user' || m.role === 'assistant') {
      let text = (m.text || '').trim();
      if (!text && Array.isArray(m.blocks)) {
        text = m.blocks
          .filter((b) => b && b.type === 'text' && typeof (b as { content?: unknown }).content === 'string')
          .map((b) => (b as { content: string }).content)
          .join('\n')
          .trim();
      }
      if (text) return text.slice(-maxChars);
    }
  }
  return '';
}

// Normalize the join boundary so `value + suggestion` always concatenates
// cleanly — exactly one whitespace at the seam. Handles both "test"+"the"
// (insert space) and "test "+" the" (drop the duplicate).
function normalizeSuggestion(value: string, raw: string): string {
  if (!raw) return '';
  const valueEndsSpace = /\s$/.test(value);
  const sugStartsSpace = /^\s/.test(raw);
  if (valueEndsSpace && sugStartsSpace) return raw.replace(/^\s+/, '');
  if (!valueEndsSpace && !sugStartsSpace) return ' ' + raw;
  return raw;
}

interface Args {
  value:       string;
  caretAtEnd:  boolean;
  pickerOpen:  boolean;
  composing?:  boolean;
}

export function useInlineSuggestion({ value, caretAtEnd, pickerOpen, composing }: Args) {
  const cfg = useAutocompleteConfig((s) => s.cfg);
  const fetchCfg = useAutocompleteConfig((s) => s.fetch);
  const cfgLoaded = useAutocompleteConfig((s) => s.loaded);

  const [suggestion, setSuggestion] = useState<string | null>(null);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cacheRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!cfgLoaded) void fetchCfg();
  }, [cfgLoaded, fetchCfg]);

  const dismiss = useCallback(() => {
    setSuggestion(null);
    abortRef.current?.abort();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const accept = useCallback((): string | null => {
    if (!suggestion) return null;
    const next = value + suggestion;
    setSuggestion(null);
    return next;
  }, [suggestion, value]);

  useEffect(() => {
    abortRef.current?.abort();
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSuggestion(null);

    if (!cfg.enabled)        return;
    if (!caretAtEnd)         return;
    if (pickerOpen)          return;
    if (composing)           return;
    if (value.length < cfg.minChars) return;

    // Pick the debounce based on where the user paused. Boundary
    // (whitespace / sentence punctuation) → fire sooner. Mid-word → wait
    // much longer so we don't pelt the API while they're still typing
    // the word.
    const atBoundary = /[\s.,;:!?\-)\]}'"]$/.test(value);
    const debounceMs = atBoundary ? cfg.debounceBoundaryMs : cfg.debounceMidwordMs;

    // Cache key combines value + a short hash of historyTail so the same
    // typed text under different conversation contexts caches separately.
    const tail = readHistoryTail(cfg.historyChars);
    const tailKey = tail ? tail.length + ':' + (tail.charCodeAt(0) | 0) + ':' + (tail.charCodeAt(tail.length - 1) | 0) : '';
    const cacheKey = value + '\x00' + tailKey;

    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setSuggestion(cached);
      return;
    }

    const seq = ++seqRef.current;
    const ac = new AbortController();
    abortRef.current = ac;

    timerRef.current = setTimeout(async () => {
      const base = api.config.baseUrl || '';
      if (!base) return;
      try {
        const r = await fetch(base + '/v1/input-autocomplete/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: value, historyTail: tail }),
          signal: ac.signal,
        });
        if (!r.ok) return;
        const d = await r.json() as { suggestion?: string };
        if (seq !== seqRef.current) return;
        const normalized = normalizeSuggestion(value, d.suggestion || '');
        if (!normalized.trim()) return;
        if (cacheRef.current.size >= CACHE_MAX) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey !== undefined) cacheRef.current.delete(firstKey);
        }
        cacheRef.current.set(cacheKey, normalized);
        setSuggestion(normalized);
      } catch {
        // AbortError on every keystroke is expected; other failures we
        // silently drop — autocomplete is best-effort.
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, caretAtEnd, pickerOpen, composing, cfg.enabled, cfg.minChars, cfg.debounceBoundaryMs, cfg.debounceMidwordMs, cfg.historyChars]);

  return { suggestion, accept, dismiss };
}
