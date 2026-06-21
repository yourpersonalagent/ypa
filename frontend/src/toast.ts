// Toast notification system — app.toast
// A lightweight Sonner-style stacked toast stack.
//
// API:
//   app.toast.show(message, type?, opts?)
//     type: 'info' | 'success' | 'error' | 'warning' | 'running'  (default 'info')
//     opts: { duration?: ms, title?: string, id?: string }
//       duration=0 → persistent until dismissed
//       id → replaces existing toast with same id (good for "running" → "done" updates)
//
//   app.toast.dismiss(id)
//   app.toast.clear()
//
// Configuration (stored in localStorage as 'yha.toast'):
//   enabled        boolean   — master switch
//   events         object    — per-event-key boolean flags
//   position       string    — 'bottom-right'|'bottom-left'|'bottom-center'|'top-right'
//   maxVisible     number    — max toasts shown at once

import { useAppStore, useGraphStore, getToastActions } from './stores/index.js';
import type { LastExecuted } from './stores/index.js';

type ToastType = 'info' | 'success' | 'error' | 'warning' | 'running';

interface ToastOpts {
  duration?: number;
  title?: string;
  id?: string;
}

interface ToastCfg {
  enabled: boolean;
  position: string;
  maxVisible: number;
  events: Record<string, boolean>;
}

interface ToastEntry {
  el: HTMLElement;
  timerId: ReturnType<typeof setTimeout> | null;
}

export const toast = (() => {
  const LS_KEY = 'yha.toast';
  const DEFAULTS: ToastCfg = {
    enabled: true,
    position: 'bottom-right',
    maxVisible: 5,
    events: {
      'cwd:change': true,
      'node:executed': true,
      'chat:done': true,
      'chat:error': true,
      'api:error': true,
      'workflow:run': true,
      'auto-title:titled': true,
    },
  };

  // ── Config ────────────────────────────────────────────────────────────────
  function loadCfg(): ToastCfg {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') } as ToastCfg;
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function saveCfg(cfg: ToastCfg): void {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  }
  function getCfg(): ToastCfg {
    return loadCfg();
  }
  function setCfg(patch: Partial<ToastCfg>): void {
    saveCfg({ ...loadCfg(), ...patch });
    _updateContainerPosition();
  }

  // ── DOM container ─────────────────────────────────────────────────────────
  let _container: HTMLElement | null = null;
  function _ensureContainer(): HTMLElement {
    if (_container && document.contains(_container)) return _container;
    _container = document.getElementById('toast-stack');
    if (!_container) {
      _container = document.createElement('div');
      _container.id = 'toast-stack';
      document.body.appendChild(_container);
    }
    _updateContainerPosition();
    return _container;
  }

  function _updateContainerPosition(): void {
    const c = document.getElementById('toast-stack');
    if (!c) return;
    const pos = loadCfg().position || 'bottom-right';
    c.dataset.position = pos;
  }

  // ── Toast registry ────────────────────────────────────────────────────────
  const _toasts = new Map<string, ToastEntry>();
  let _counter = 0;

  // ── Core show ─────────────────────────────────────────────────────────────
  function show(message: string, type?: ToastType, opts?: ToastOpts): string {
    const cfg = loadCfg();
    if (!cfg.enabled) return '';

    const resolvedType: ToastType = type || 'info';
    const resolvedOpts = opts || {};
    const id = resolvedOpts.id || `t${++_counter}`;
    const duration =
      resolvedOpts.duration !== undefined ? resolvedOpts.duration : _defaultDuration(resolvedType);

    if (_toasts.has(id)) dismiss(id, true);

    const visible = [..._toasts.keys()];
    if (visible.length >= cfg.maxVisible) dismiss(visible[0], true);

    const c = _ensureContainer();
    const el = _buildEl(id, message, resolvedType, resolvedOpts.title);
    c.appendChild(el);

    requestAnimationFrame(() => el.classList.add('toast--visible'));

    const entry: ToastEntry = { el, timerId: null };
    _toasts.set(id, entry);

    if (duration > 0) {
      entry.timerId = setTimeout(() => dismiss(id), duration);
    }

    el.addEventListener('mouseenter', () => {
      if (entry.timerId) {
        clearTimeout(entry.timerId);
        entry.timerId = null;
      }
    });
    el.addEventListener('mouseleave', () => {
      if (duration > 0 && _toasts.has(id)) {
        entry.timerId = setTimeout(() => dismiss(id), duration * 0.5);
      }
    });

    return id;
  }

  function dismiss(id: string, instant?: boolean): void {
    const entry = _toasts.get(id);
    if (!entry) return;
    clearTimeout(entry.timerId ?? undefined);
    _toasts.delete(id);
    const el = entry.el;
    if (instant) {
      el.remove();
    } else {
      el.classList.remove('toast--visible');
      el.classList.add('toast--out');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 500);
    }
  }

  function clear(): void {
    for (const id of [..._toasts.keys()]) dismiss(id, true);
  }

  // ── Build element ─────────────────────────────────────────────────────────
  const ICONS: Record<ToastType, string> = {
    success:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="2,8 6,12 14,4"/></svg>',
    error:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>',
    warning:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8,3 8,9"/><circle cx="8" cy="12.5" r=".8" fill="currentColor"/></svg>',
    info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/><line x1="8" y1="7" x2="8" y2="11"/><circle cx="8" cy="5" r=".8" fill="currentColor"/></svg>',
    running:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" class="toast-spin"><circle cx="8" cy="8" r="6" stroke-dasharray="20 18"/></svg>',
  };

  function _buildEl(id: string, message: string, type: ToastType, title?: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.dataset.id = id;

    const icon = ICONS[type] || ICONS.info;
    const titleHtml = title ? `<div class="toast-title">${_esc(title)}</div>` : '';

    el.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <div class="toast-body">
        ${titleHtml}
        <div class="toast-msg">${_esc(message)}</div>
      </div>
      <button class="toast-close" aria-label="Dismiss">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
        </svg>
      </button>
    `;
    el.querySelector('.toast-close')!.addEventListener('click', () => dismiss(id));
    return el;
  }

  function _esc(s: unknown): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return String(s).replace(/[&<>"']/g, (c) => map[c]);
  }

  function _defaultDuration(type: ToastType): number {
    if (type === 'error') return 6000;
    if (type === 'warning') return 5000;
    if (type === 'running') return 0;
    return 3500;
  }

  // ── Event wiring — listens on Zustand stores ───────────────────────────
  // chat:done, chat:error, api:error, workflow:run/done are now triggered by
  // direct getToastActions() calls in the producer modules. This function
  // wires the few store-backed events that still need toast surfacing.
  function _wire(): void {
    // node:executed → subscribe to graphStore.lastExecuted
    useGraphStoreLastExecutedSubscribe();
    // cwd:change → subscribe to appStore.sessionWorkingDir
    useAppStoreCwdSubscribe();
  }

  function useGraphStoreLastExecutedSubscribe(): void {
    let prev: LastExecuted | null = useGraphStore.getState().lastExecuted;
    useGraphStore.subscribe((state) => {
      const next = state.lastExecuted;
      if (next === prev) return;
      prev = next;
      if (!next) return;
      if (!loadCfg().events['node:executed']) return;
      const { node, output, error } = next;
      const label = node?.title || node?.id || 'Node';
      if (error) {
        show(`${label}: ${String(output).slice(0, 120)}`, 'error', { title: 'Node error' });
      } else {
        const preview = String(output || '')
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        show(preview ? `${label} → ${preview}` : `${label} done`, 'success', { duration: 2800 });
      }
    });
  }

  function useAppStoreCwdSubscribe(): void {
    let prev = useAppStore.getState().sessionWorkingDir;
    useAppStore.subscribe((state) => {
      const next = state.sessionWorkingDir;
      if (next === prev) return;
      prev = next;
      if (!loadCfg().events['cwd:change']) return;
      show(next ?? '', 'success', { title: 'Working dir set' });
    });
  }

  // Also bridge Zustand toastStore so app.toast.show/dismiss/clear go through
  // Zustand → <ToastStack />. main.ts also patches these for safety.
  void getToastActions;

  // ── Public API ────────────────────────────────────────────────────────────
  function init(): void {
    _ensureContainer();
    _wire();
  }

  return {
    init,
    show,
    dismiss,
    clear,
    getCfg,
    setCfg,
    DEFAULTS,
  };
})();
