// TodosModal — full per-WD task editor. Opens via header buttons and the
// 'yha:open-todos' window event. Two-pane layout: WD switcher on the left,
// active list editor on the right.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTodoStore, type Todo } from './todoStore.js';

const EMPTY_TODOS: Todo[] = [];

function shortPath(p: string, max = 36): string {
  if (!p) return '(default)';
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

function newId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function TodosModal() {
  const open = useTodoStore((s) => s.modalOpen);
  const cwd = useTodoStore((s) => s.modalCwd);
  const cwds = useTodoStore((s) => s.cwds);
  const byCwd = useTodoStore((s) => s.byCwd);
  const defaultCwd = useTodoStore((s) => s.defaultCwd);
  const closeModal = useTodoStore((s) => s.closeModal);
  const setModalCwd = useTodoStore((s) => s.setModalCwd);
  const saveTodos = useTodoStore((s) => s.saveTodos);
  const refresh = useTodoStore((s) => s.refresh);

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent).detail || {};
      useTodoStore.getState().openModal(detail.cwd);
    }
    function onEscape() { useTodoStore.getState().closeModal(); }
    window.addEventListener('yha:open-todos', onOpen);
    window.addEventListener('yha:escape', onEscape);
    return () => {
      window.removeEventListener('yha:open-todos', onOpen);
      window.removeEventListener('yha:escape', onEscape);
    };
  }, []);

  useEffect(() => {
    if (open) {
      refresh();
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, refresh]);

  if (!open) return null;

  const activeCwd = cwd || defaultCwd || cwds[0]?.cwd || '';
  const todos = byCwd[activeCwd] ?? EMPTY_TODOS;

  // Build switcher list — current WD always shown first, then others with todos.
  const allCwds: string[] = [];
  if (defaultCwd) allCwds.push(defaultCwd);
  for (const c of cwds) if (!allCwds.includes(c.cwd)) allCwds.push(c.cwd);
  if (activeCwd && !allCwds.includes(activeCwd)) allCwds.push(activeCwd);

  function addTodo() {
    const text = draft.trim();
    if (!text) return;
    const next: Todo[] = [...todos, { id: newId(), content: text, status: 'pending' }];
    saveTodos(activeCwd, next);
    setDraft('');
  }

  function updateTodo(id: string, patch: Partial<Todo>) {
    const next = todos.map((t) => (t.id === id ? { ...t, ...patch } : t));
    saveTodos(activeCwd, next);
  }

  function removeTodo(id: string) {
    saveTodos(activeCwd, todos.filter((t) => t.id !== id));
  }

  function clearCompleted() {
    saveTodos(activeCwd, todos.filter((t) => t.status !== 'completed'));
  }

  function copyAsMarkdown() {
    const md = todos
      .map((t) => {
        const box = t.status === 'completed' ? '[x]' : '[ ]';
        const prio = t.priority ? ` _(${t.priority})_` : '';
        return `- ${box} ${t.content}${prio}`;
      })
      .join('\n');
    navigator.clipboard?.writeText(md).catch(() => {});
  }

  const content = (
    <div className="sc-modal-overlay todos-modal-overlay" onClick={closeModal}>
      <div className="sc-modal-card todos-modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="sc-modal-header">
          <h3>Tasks</h3>
          <button className="sc-modal-close" title="Close [Esc]" onClick={closeModal}>✕</button>
        </header>
        <div className="todos-modal-body">
          <aside className="todos-switcher" aria-label="Working directories">
            <div className="todos-switcher-title">Working directories</div>
            <ul>
              {allCwds.map((c) => {
                const entry = cwds.find((e) => e.cwd === c);
                const isActive = c === activeCwd;
                const isDefault = c === defaultCwd;
                return (
                  <li key={c}>
                    <button
                      type="button"
                      className={`todos-switcher-item${isActive ? ' is-active' : ''}`}
                      title={c}
                      onClick={() => setModalCwd(c)}
                    >
                      <span className="todos-switcher-path">{shortPath(c)}</span>
                      <span className="todos-switcher-meta">
                        {isDefault ? <span className="todos-switcher-tag">current</span> : null}
                        {entry ? <span className="todos-switcher-count">{entry.openCount}/{entry.count}</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
          <section className="todos-editor">
            <div className="todos-editor-cwd" title={activeCwd}>{activeCwd || '(no working directory)'}</div>
            <div className="todos-add-row">
              <input
                ref={inputRef}
                type="text"
                className="todos-add-input"
                placeholder="Add a task and press Enter…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addTodo(); }}
              />
              <button type="button" className="todos-action-btn" onClick={addTodo}>add</button>
            </div>
            {todos.length === 0 ? (
              <div className="todo-empty">No tasks yet.</div>
            ) : (
              <ul className="todos-editor-list">
                {todos.map((t) => (
                  <li key={t.id} className={`todo-item todo-${t.status}`}>
                    <select
                      className="todo-status-select"
                      value={t.status}
                      onChange={(e) => updateTodo(t.id, { status: e.target.value as Todo['status'] })}
                    >
                      <option value="pending">pending</option>
                      <option value="in_progress">in progress</option>
                      <option value="completed">completed</option>
                    </select>
                    <input
                      type="text"
                      className="todo-content-input"
                      value={t.content}
                      onChange={(e) => updateTodo(t.id, { content: e.target.value })}
                    />
                    <select
                      className="todo-prio-select"
                      value={t.priority || ''}
                      onChange={(e) => updateTodo(t.id, { priority: (e.target.value || undefined) as Todo['priority'] })}
                    >
                      <option value="">—</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                    <button
                      type="button"
                      className="todo-remove-btn"
                      title="Remove task"
                      onClick={() => removeTodo(t.id)}
                    >✕</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="todos-editor-footer">
              <button type="button" className="todos-action-btn" onClick={clearCompleted} disabled={!todos.some((t) => t.status === 'completed')}>
                clear completed
              </button>
              <button type="button" className="todos-action-btn" onClick={copyAsMarkdown} disabled={!todos.length}>
                copy as markdown
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
