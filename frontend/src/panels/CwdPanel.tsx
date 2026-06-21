// CwdPanel — header section that pivots around the active session's
// working directory. Subsumes the standalone Todos and Serve header buttons.
// Lives at the top of `header-actions` (before Personnel).
//
// Body sub-sections (top to bottom):
//   1. Sessions in this CWD — list of chat sessions that share the current
//      working directory, click to switch, plus "+ new chat" + "open file picker".
//   2. Todos for this CWD — owned by the `todos` module, plugged in via
//      <SessionPickerSlot region="belowSessions" />. With the module
//      disabled, this slot renders nothing and the section disappears.
//   3. Serve — profile picker + start/stop + status. The iframe view itself
//      still lives in ServePreview.tsx and is opened via the existing
//      `yha:open-serve-preview` event.
//
// Uses the standard hs-section / hs-toggle / hs-body pattern so the body
// collapses inline (vertical) or floats as a popup (horizontal). The popup
// style gets a `wide` modifier on this section because the contents need
// more room than a 360 px popup gives.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore.js';
import { useSessionStore, type SessionEntry } from '../stores/sessionStore.js';
import { session } from '../session.js';
import { chat } from '../chat.js';
import { filePicker } from '../modals/file-picker.js';
import { SessionPickerSlot } from '../host/slots/SessionPickerSlot.js';
import { CwdDropdownSlot } from '../host/slots/CwdDropdownSlot.js';
import { CwdActionsSlot } from '../host/slots/CwdActionsSlot.js';

// ServeSubsection / serve profile helpers moved into the
// `files-serve-preview` module — frontend/src/modules/files-serve-preview/.
// They register here via host.registers.cwdDropdownEntries so the row
// disappears when the bridge module is disabled.

function shortPath(p: string | null, max = 38): string {
  if (!p) return '(no working directory)';
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

const DEFAULT_CTX_MAX = 7;

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

function CwdContextSubsection({ cwd }: { cwd: string | null }) {
  const [text, setText] = useState('');
  const [maxLines, setMaxLines] = useState(DEFAULT_CTX_MAX);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyServerState(state: { lines?: string[]; maxLines?: number } | null | undefined) {
    if (!state) return;
    if (typeof state.maxLines === 'number') setMaxLines(state.maxLines);
    if (Array.isArray(state.lines) && !dirtyRef.current) {
      setText(linesToText(state.lines));
    }
  }

  useEffect(() => {
    dirtyRef.current = false;
    setText('');
    setMaxLines(DEFAULT_CTX_MAX);
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!cwd) return;

    let aborted = false;
    fetch(`/v1/cwd-context?cwd=${encodeURIComponent(cwd)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (aborted || !data) return;
        applyServerState(data);
      })
      .catch(() => {});

    const es = new EventSource(`/v1/cwd-context/events?cwd=${encodeURIComponent(cwd)}`, { withCredentials: true });
    es.addEventListener('cwd-context:snapshot', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.cwd === cwd) applyServerState(data);
      } catch {}
    });
    es.addEventListener('cwd-context:changed', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.cwd === cwd) applyServerState(data);
      } catch {}
    });

    return () => {
      aborted = true;
      es.close();
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [cwd]);

  function commit(nextText: string) {
    if (!cwd) return;
    const lines = textToLines(nextText, maxLines);
    fetch('/v1/cwd-context', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, lines }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        dirtyRef.current = false;
        if (data) applyServerState(data);
      })
      .catch(() => {});
  }

  function scheduleSave(nextText: string) {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      commit(nextText);
    }, 400);
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    dirtyRef.current = true;
    let v = e.target.value;
    const ls = v.split('\n');
    if (ls.length > maxLines) v = ls.slice(0, maxLines).join('\n');
    setText(v);
    scheduleSave(v);
  }

  function handleBlur() {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (dirtyRef.current) commit(text);
  }

  const lineCount = text ? text.split('\n').filter((l) => l.trim()).length : 0;

  return (
    <div className="cwd-sub">
      <div className="cwd-sub-head">
        <span className="cwd-sub-title">Working-dir context</span>
        <span className="cwd-sub-count">{lineCount}/{maxLines}</span>
      </div>
      {!cwd ? (
        <div className="cwd-empty">no working directory bound</div>
      ) : (
        <div className="gctx-body cwd-context-body">
          <textarea
            className="gctx-textarea cwd-context-textarea"
            rows={5}
            value={text}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="(empty — notes only for chats in this working directory)"
            spellCheck={false}
          />
          <div className="gctx-hint">
            up to {maxLines} short keyword-style lines · auto-saved · injected only for chats in this cwd
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-section: sessions in this CWD ──────────────────────────────────────
function SessionsSubsection({ cwd }: { cwd: string | null }) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentId = useSessionStore((s) => s.currentId);

  const matches = useMemo<SessionEntry[]>(() => {
    if (!cwd) return [];
    return sessions
      .filter((s) => (s.workingDir || '') === cwd)
      .sort((a, b) => (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt));
  }, [sessions, cwd]);

  function switchTo(id: string | number) {
    session?.switchTo(id);
  }

  function newChatHere() {
    chat?.startNewSessionSameDir?.();
  }

  function openFilePicker() {
    (filePicker as { open?: () => void })?.open?.();
  }

  return (
    <div className="cwd-sub">
      <div className="cwd-sub-head">
        <span className="cwd-sub-title">Sessions in this directory</span>
        <span className="cwd-sub-count">{matches.length}</span>
      </div>
      {matches.length === 0 ? (
        <div className="cwd-empty">no other chats use this directory</div>
      ) : (
        <ul className="cwd-session-list">
          {matches.map((s) => {
            const active = String(s.id) === String(currentId);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`cwd-session-item${active ? ' active' : ''}`}
                  onClick={() => switchTo(s.id)}
                  title={`Switch to: ${s.name}`}
                >
                  <span className="cwd-session-name">{s.name || '(unnamed)'}</span>
                  {s.isRunning ? <span className="cwd-session-busy" title="busy">●</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="cwd-actions">
        <button
          type="button"
          className="cwd-btn"
          onClick={newChatHere}
          disabled={!cwd}
          title="Start a new chat session bound to this working directory"
        >＋ new chat here</button>
        <button
          type="button"
          className="cwd-btn"
          onClick={openFilePicker}
          title="Open the file picker (anchored to the chat input)"
        >📁 file picker</button>
      </div>
    </div>
  );
}

// CwdActionsSubsection (rclone / github / knowledge graph) is gone — each
// button moved into its own module and registers via cwdDropdownEntries.
// See frontend/src/modules/files-rclone, files-github, knowledge.

// ── Top-level panel ────────────────────────────────────────────────────────
export function CwdPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const cwd = useAppStore((s) => s.sessionWorkingDir);
  const hostname = useSessionStore((s) => s.hostname);
  const currentSessionId = useSessionStore((s) => s.currentId);

  const cwdTail = (() => {
    if (!cwd) return '';
    // Cross-platform split: strip trailing '/' or '\' then split on either.
    const segs = cwd.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
    return segs[segs.length - 1] || '/';
  })();

  return (
    <div className={`hs-section hs-section-wide${open ? ' hs-open' : ''}`} id="hs-cwd">
      <button
        className={`hm-item hs-toggle cwd-toggle${open ? ' hs-open' : ''}`}
        id="btn-cwd"
        onClick={onToggle}
        title={`Y.O.L.O. — ${cwd || '(no working directory)'} · sessions, tasks & serve`}
      >
        <span className="hm-icon" aria-hidden="true">
          <svg
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M3 6.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6l1.4 1.4H17a2 2 0 0 1 2 2" />
            <path d="M3 10a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6l1.4 1.4H19a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Z" />
          </svg>
        </span>
        <span className="yolo-tag">Y.O.L.O.</span>
        {cwdTail ? <span className="cwd-toggle-cwd">{cwdTail}</span> : null}
      </button>
      <div className={`hs-body${open ? ' hs-open' : ''}`} id="cwd-panel">
        {hostname ? (
          <div className="cwd-cwd-row" title={hostname}>
            <span className="cwd-cwd-label">host</span>
            <code className="cwd-cwd-value">{hostname}</code>
          </div>
        ) : null}
        <div className="cwd-cwd-row" title={cwd || ''}>
          <span className="cwd-cwd-label">cwd</span>
          <code className="cwd-cwd-value">{shortPath(cwd, 48)}</code>
        </div>
        <CwdContextSubsection cwd={cwd} />
        <SessionsSubsection cwd={cwd} />
        <SessionPickerSlot
          region="aboveTodos"
          cwd={cwd}
          sessionId={currentSessionId || null}
        />
        <SessionPickerSlot
          region="belowSessions"
          cwd={cwd}
          sessionId={currentSessionId || null}
        />
        <SessionPickerSlot
          region="belowTodos"
          cwd={cwd}
          sessionId={currentSessionId || null}
        />
        {/* Shared Actions row (rclone / github / knowledge graph). Auto-hides
            when no module has registered an entry. */}
        <CwdActionsSlot />
        {/* Heavyweight per-module sections — Serve is registered with a high
            order so it lands at the bottom, after Actions. */}
        <CwdDropdownSlot cwd={cwd} />
      </div>
    </div>
  );
}
