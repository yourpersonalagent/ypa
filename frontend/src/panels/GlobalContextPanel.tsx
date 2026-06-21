// GlobalContextPanel — small "Important" header section showing 5–7 short
// keyword lines that are auto-injected into every model system prompt.
// Models edit via the `important` MCP tool; this panel is the human end of
// the same shared memory. Glows when the model has changed lines since the
// user last saw / focused it.
//
// Uses the standard hs-section / hs-toggle / hs-body pattern so the body
// collapses inline in vertical header mode and floats as a popup in
// horizontal header mode (handled by main.ts and layout.css).

import { useEffect, useRef, useState } from 'react';

import { useAppStore } from '../stores/appStore';

type ImportantState = {
  lines: string[];
  updatedAt: number;
  updatedBy: 'user' | 'model';
  modelChangeCounter: number;
  lastSeenByUser: number;
  maxLines: number;
};

const DEFAULT_MAX = 7;

function linesToText(lines: string[]): string {
  return (lines || []).join('\n');
}

function textToLines(text: string, maxLines: number): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.replace(/[\r\t]+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

export function GlobalContextPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [text, setText] = useState('');
  const [counter, setCounter] = useState(0);
  const [focused, setFocused] = useState(false);
  const [maxLines, setMaxLines] = useState(DEFAULT_MAX);
  const dirtyRef = useRef(false);
  const focusedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyServerState(state: Partial<ImportantState>): void {
    if (typeof state.maxLines === 'number') setMaxLines(state.maxLines);
    if (typeof state.modelChangeCounter === 'number') setCounter(state.modelChangeCounter);
    if (Array.isArray(state.lines) && !dirtyRef.current && !focusedRef.current) {
      setText(linesToText(state.lines));
    }
  }

  useEffect(() => {
    let aborted = false;
    fetch('/v1/important?seen=1', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (aborted || !data) return;
        applyServerState(data);
      })
      .catch(() => {});

    const es = new EventSource('/v1/important/events', { withCredentials: true });
    es.addEventListener('important:snapshot', (e: MessageEvent) => {
      try { applyServerState(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('important:changed', (e: MessageEvent) => {
      try { applyServerState(JSON.parse(e.data)); } catch {}
    });

    return () => {
      aborted = true;
      es.close();
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commit(nextText: string): void {
    const lines = textToLines(nextText, maxLines);
    fetch('/v1/important', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        dirtyRef.current = false;
        if (data) applyServerState(data);
      })
      .catch(() => {});
  }

  function scheduleSave(nextText: string): void {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      commit(nextText);
    }, 400);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    dirtyRef.current = true;
    let v = e.target.value;
    const ls = v.split('\n');
    if (ls.length > maxLines) v = ls.slice(0, maxLines).join('\n');
    setText(v);
    scheduleSave(v);
  }

  function handleFocus(): void {
    focusedRef.current = true;
    setFocused(true);
    setCounter(0);
    fetch('/v1/important?seen=1', { credentials: 'same-origin' }).catch(() => {});
  }

  function handleBlur(): void {
    focusedRef.current = false;
    setFocused(false);
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyRef.current) commit(text);
  }

  const lineCount = text ? text.split('\n').filter((l) => l.trim()).length : 0;
  const glow = counter > 0 && !focused;

  return (
    <div className={`hs-section${open ? ' hs-open' : ''}`} id="hs-global-context">
      <button
        className={`hm-item hs-toggle${open ? ' hs-open' : ''}${glow ? ' gctx-glow' : ''}`}
        id="btn-global-context"
        onClick={onToggle}
        title="Global context — small shared memory across agents. Models read/edit via the `important` MCP tool; the same lines are auto-injected into every system prompt."
      >
        <span className="hm-icon" aria-hidden="true">
          <svg
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </span>
        global context<span className="gctx-count">{lineCount}/{maxLines}</span>
      </button>
      <div className={`hs-body${open ? ' hs-open' : ''}`} id="global-context-panel">
        <div className="gctx-body">
          <textarea
            className="gctx-textarea"
            rows={5}
            value={text}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder="(empty — facts/thoughts to share with all agents)"
            spellCheck={false}
          />
          <div className="gctx-hint">
            up to {maxLines} short keyword-style lines · auto-saved
          </div>
          <SystemPromptPreview refreshKey={counter} />
        </div>
      </div>
    </div>
  );
}

type PreviewSource = {
  kind: string;
  label: string;
  scope: string;
  bytes: number;
  text: string;
  note?: string;
};

type SystemPreview = {
  cwd: string;
  assembled: string;
  totalBytes: number;
  sources: PreviewSource[];
};

function SystemPromptPreview({ refreshKey }: { refreshKey: number }) {
  const sessionId = useAppStore((s) => String(s.currentSession || 'default'));
  const cwd = useAppStore((s) => s.sessionWorkingDir ?? '');
  const presetMode = useAppStore((s) => s.sysPrompt.selection.mode);
  const presetSelection = useAppStore((s) => s.sysPrompt.selection);
  const skillSet = useAppStore((s) => s.skillSet);

  const [preview, setPreview] = useState<SystemPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (sessionId) qs.set('session', sessionId);
    if (cwd.trim()) qs.set('cwd', cwd.trim());
    const presetNames = presetSelection.presets?.length ? presetSelection.presets : (presetSelection.preset ? [presetSelection.preset] : []);
    const cleanedPresetNames = Array.from(new Set(presetNames.map((name) => name.trim()).filter(Boolean)));
    if (cleanedPresetNames.length && presetMode !== 'off') {
      qs.set('preset', cleanedPresetNames[0]);
      cleanedPresetNames.forEach((name) => qs.append('presets', name));
    }
    if (presetMode && presetMode !== 'off') qs.set('mode', presetMode);
    if (skillSet) qs.set('skillSet', skillSet);
    let aborted = false;
    fetch(`/v1/system-preview?${qs.toString()}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http ${r.status}`))))
      .then((data: SystemPreview) => {
        if (aborted) return;
        setPreview(data);
        setError(null);
      })
      .catch((err: Error) => {
        if (aborted) return;
        setError(err.message || String(err));
      });
    return () => {
      aborted = true;
    };
  }, [sessionId, cwd, presetSelection, presetMode, skillSet, refreshKey]);

  if (error) {
    return <div className="gctx-preview-err">preview unavailable — {error}</div>;
  }
  if (!preview) {
    return <div className="gctx-preview-loading">loading preview…</div>;
  }

  const promptLayers = preview.sources.filter((s) => s.kind !== 'mcp' && s.text);

  return (
    <div className="gctx-preview">
      <div className="gctx-preview-head">
        <span className="gctx-preview-title">what the model sees</span>
        <span className="gctx-preview-bytes">
          {preview.totalBytes.toLocaleString()} chars · {promptLayers.length} layers
        </span>
      </div>
      {preview.cwd ? (
        <div className="gctx-preview-cwd">
          CWD: <code>{preview.cwd}</code>
        </div>
      ) : null}
      <details className="gctx-preview-full">
        <summary>full assembled system prompt</summary>
        <pre className="gctx-preview-pre">{preview.assembled || '(empty)'}</pre>
      </details>
      <div className="gctx-preview-list">
        {preview.sources.map((s, i) => (
          <details className="gctx-preview-row" key={`${s.kind}-${i}`}>
            <summary>
              <span className={`gctx-scope gctx-scope-${s.scope}`}>{s.scope}</span>
              <span className="gctx-preview-label">{s.label}</span>
              <span className="gctx-preview-meta">
                {s.bytes > 0 ? `${s.bytes.toLocaleString()}b` : '—'}
              </span>
            </summary>
            {s.note ? <div className="gctx-preview-note">{s.note}</div> : null}
            <pre className="gctx-preview-pre">{s.text || '(empty)'}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}
