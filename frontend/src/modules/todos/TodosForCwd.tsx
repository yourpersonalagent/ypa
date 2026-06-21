// TodosForCwd — module-side rendering of the per-CWD task list. Plugs
// into the `sessionPickerSlots` register at the `belowSessions` region
// (see `index.ts`). With the `todos` module disabled, the slot is
// empty and the cwd panel skips this section entirely.
//
// Extracted from `panels/CwdPanel.tsx`'s inline TodosSubsection.
// The `open` refresh-trigger from the previous inline version is gone:
// the 15 s polling loop + the manual save-time refresh cover the cases
// the open-event used to.

import { useEffect, useState } from 'react';
import { useTodoStore, type Todo } from './todoStore.js';

const POLL_INTERVAL_MS = 15_000;

const EMPTY_TODOS: Todo[] = [];

function newTodoId(): string { return Math.random().toString(36).slice(2, 8); }

function statusGlyph(status: Todo['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '◐';
  return '○';
}

function shortPath(p: string | null, max = 38): string {
  if (!p) return '(no working directory)';
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

export function TodosForCwd({ cwd }: { cwd: string | null; sessionId: string | null }) {
  const refresh = useTodoStore((s) => s.refresh);
  const openModal = useTodoStore((s) => s.openModal);
  const todos = useTodoStore((s) => (cwd ? s.byCwd[cwd] ?? EMPTY_TODOS : EMPTY_TODOS));
  const saveTodos = useTodoStore((s) => s.saveTodos);
  const cwds = useTodoStore((s) => s.cwds);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  function cycleStatus(t: Todo) {
    if (!cwd) return;
    const order: Todo['status'][] = ['pending', 'in_progress', 'completed'];
    const next = order[(order.indexOf(t.status) + 1) % order.length];
    saveTodos(cwd, todos.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
  }

  function addTodo() {
    if (!cwd) return;
    const text = draft.trim();
    if (!text) return;
    saveTodos(cwd, [...todos, { id: newTodoId(), content: text, status: 'pending' }]);
    setDraft('');
  }

  const otherCwds = cwd
    ? cwds.filter((c) => c.cwd !== cwd && !c.cwd.startsWith(cwd.endsWith('/') ? cwd : cwd + '/'))
    : cwds;

  return (
    <div className="cwd-sub">
      <div className="cwd-sub-head">
        <span className="cwd-sub-title">Tasks</span>
        <button
          type="button"
          className="cwd-sub-action"
          title="Open full editor"
          onClick={() => cwd && openModal(cwd)}
          disabled={!cwd}
        >edit</button>
      </div>
      {!cwd ? (
        <div className="cwd-empty">no working directory bound</div>
      ) : todos.length === 0 ? (
        <div className="cwd-empty">no tasks for this directory yet</div>
      ) : (
        <ul className="cwd-todo-list">
          {todos.map((t) => (
            <li key={t.id} className={`cwd-todo-item todo-${t.status}`}>
              <button
                type="button"
                className="cwd-todo-status"
                title={`Status: ${t.status} (click to cycle)`}
                onClick={() => cycleStatus(t)}
              >
                {statusGlyph(t.status)}
              </button>
              <span className="cwd-todo-content">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="cwd-todo-add">
        <input
          type="text"
          className="cwd-todo-input"
          placeholder="+ add task…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTodo(); }}
          disabled={!cwd}
        />
      </div>
      {otherCwds.length > 0 && (
        <details className="cwd-todo-others">
          <summary>other directories ({otherCwds.length})</summary>
          <ul>
            {otherCwds.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  className="cwd-todo-other"
                  title={c.cwd}
                  onClick={() => openModal(c.cwd)}
                >
                  <span className="cwd-todo-other-path">{shortPath(c.cwd)}</span>
                  <span className="cwd-todo-other-count">{c.openCount}/{c.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
