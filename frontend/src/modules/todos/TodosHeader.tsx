// TodosHeader — collapsible header section (slotted before triggers).
// Shows the current WD's todos expanded; lists other WDs with non-empty
// todo files below, each opening the modal scoped to that WD.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTodoStore, type Todo } from './todoStore.js';
import { useAppStore } from '../../stores/index.js';

const POLL_INTERVAL_MS = 15_000;

function newTodoId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function shortPath(p: string, max = 28): string {
  if (!p) return '(default)';
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

function statusGlyph(status: Todo['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '◐';
  return '○';
}

const EMPTY_TODOS: Todo[] = [];

function CurrentWdList({ cwd }: { cwd: string }) {
  const todos = useTodoStore((s) => s.byCwd[cwd] ?? EMPTY_TODOS);
  const saveTodos = useTodoStore((s) => s.saveTodos);
  const [draft, setDraft] = useState('');

  function cycleStatus(t: Todo) {
    const order: Todo['status'][] = ['pending', 'in_progress', 'completed'];
    const next = order[(order.indexOf(t.status) + 1) % order.length];
    const updated = todos.map((x) => (x.id === t.id ? { ...x, status: next } : x));
    saveTodos(cwd, updated);
  }

  function addTodo() {
    const text = draft.trim();
    if (!text) return;
    saveTodos(cwd, [...todos, { id: newTodoId(), content: text, status: 'pending' }]);
    setDraft('');
  }

  return (
    <>
      {todos.length === 0 ? (
        <div className="todo-empty">No tasks for this directory yet.</div>
      ) : (
        <ul className="todo-list">
          {todos.map((t) => (
            <li key={t.id} className={`todo-item todo-${t.status}`}>
              <button
                type="button"
                className="todo-status-btn"
                title={`Status: ${t.status} (click to cycle)`}
                onClick={() => cycleStatus(t)}
              >
                {statusGlyph(t.status)}
              </button>
              <span className="todo-content">{t.content}</span>
              {t.priority ? <span className={`todo-prio todo-prio-${t.priority}`}>{t.priority}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <div className="todo-quick-add">
        <input
          type="text"
          className="todo-quick-add-input"
          placeholder="+ add task…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTodo(); }}
        />
        <button
          type="button"
          className="todo-action-btn"
          onClick={addTodo}
          disabled={!draft.trim()}
          title="Add task (Enter)"
        >
          add
        </button>
      </div>
    </>
  );
}

export function TodosHeader() {
  const refresh = useTodoStore((s) => s.refresh);
  const openModal = useTodoStore((s) => s.openModal);
  const cwds = useTodoStore((s) => s.cwds);
  const defaultCwd = useTodoStore((s) => s.defaultCwd);
  // Use the ACTIVE SESSION's working directory as the primary cwd for the
  // todo list. This makes the inline panel automatically scope to the session
  // that's currently open — matching what MCP tools (TodoWrite/TodoRead) use
  // when they're called from that session's Claude invocation.
  // Falls back to the bridge server's process.cwd() when no session is active.
  const sessionCwd = useAppStore((s) => s.sessionWorkingDir);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const badgeHost = document.getElementById('btn-todos-badge');
  const bodyHost = document.getElementById('todos-panel');
  if (!badgeHost || !bodyHost) return null;

  // Session WD takes priority: when an AI model calls TodoWrite in a session
  // at path X, those todos land under cwd=X. Showing X's list here means the
  // inline panel always reflects what the active agent is working on.
  const currentCwd = sessionCwd || defaultCwd;
  const currentEntry = cwds.find((c) => c.cwd === currentCwd);
  const otherCwds = cwds.filter((c) => c.cwd !== currentCwd);
  const openCount = currentEntry?.openCount ?? 0;

  return (
    <>
      {createPortal(
        openCount > 0 ? <span className="todo-badge">{openCount}</span> : null,
        badgeHost,
      )}
      {createPortal(
        <>
          <div className="todo-section">
            <div className="todo-section-header">
              <span className="todo-section-title" title={currentCwd}>
                {shortPath(currentCwd)}
              </span>
              <button
                type="button"
                className="todo-action-btn"
                title="Open full editor"
                onClick={() => openModal(currentCwd)}
              >
                edit
              </button>
            </div>
            <CurrentWdList cwd={currentCwd} />
          </div>
          {otherCwds.length > 0 ? (
            <div className="todo-section todo-section-others">
              <div className="todo-section-title todo-section-title-dim">Other directories</div>
              <ul className="todo-other-list">
                {otherCwds.map((c) => (
                  <li key={c.key}>
                    <button
                      type="button"
                      className="todo-other-item"
                      title={c.cwd}
                      onClick={() => openModal(c.cwd)}
                    >
                      <span className="todo-other-path">{shortPath(c.cwd)}</span>
                      <span className="todo-other-count">{c.openCount}/{c.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>,
        bodyHost,
      )}
    </>
  );
}
