// Central Escape stack for stacked modals.
//
// Without this, each modal binds its own `document.addEventListener('keydown',
// onKey)` for Escape. When multiple modals are open simultaneously, every
// listener fires on a single Escape press and close order depends on listener
// registration order, not on which modal is on top.
//
// Replacement: a single global keydown listener walks the stack from top to
// bottom and calls the top entry's `close`. Mounting a modal `push(close)`s
// onto the stack and gets back an `unsubscribe()` that removes it (call from
// the same effect cleanup that used to remove the listener).
'use strict';

type EscapeHandler = () => void;

const _stack: EscapeHandler[] = [];
let _listenerInstalled = false;

function _onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = _stack[_stack.length - 1];
  if (!top) return;
  // Don't preventDefault — the form inside the modal may still want native
  // Escape behaviour (close menus, clear inputs). The handler is responsible
  // for calling preventDefault itself if it needs to. We DO stopPropagation
  // so older listeners outside this stack don't double-close.
  e.stopPropagation();
  try { top(); } catch (_) { /* ignore — caller's problem */ }
}

function _ensureListener(): void {
  if (_listenerInstalled) return;
  _listenerInstalled = true;
  // `capture: true` so we beat per-element handlers and stopPropagation
  // actually stops them. Bubble-phase would fire AFTER the modal's own
  // listener and leave the legacy double-close intact.
  document.addEventListener('keydown', _onKey, { capture: true });
}

export function pushEscapeHandler(close: EscapeHandler): () => void {
  _ensureListener();
  _stack.push(close);
  let removed = false;
  return function unsubscribe() {
    if (removed) return;
    removed = true;
    const i = _stack.lastIndexOf(close);
    if (i >= 0) _stack.splice(i, 1);
  };
}

// Test helper — not exported as part of the public surface but available
// for vitest specs that need to inspect stack state.
export function _stackDepth(): number { return _stack.length; }
