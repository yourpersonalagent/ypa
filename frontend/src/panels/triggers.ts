// Trigger data layer — server-backed via bridge REST + SSE.
// Timer heartbeats live on the server (survive tab close).
// Local localStorage cache used only for instant paint on boot.
//
// UI lives in panels/TriggersPanel.tsx — listens to the 'yha:triggers-changed'
// CustomEvent fired by this module whenever triggerList changes.

import { useGraphStore, getGraphState, getAppState, getToastActions, useSessionStore } from '../stores/index.js';

function _toastEventEnabled(key: string): boolean {
  try {
    const cfg = JSON.parse(localStorage.getItem('yha.toast') || '{}');
    if (cfg.enabled === false) return false;
    const events = cfg.events || {};
    return events[key] !== false;
  } catch {
    return true;
  }
}

export interface TriggerConfig {
  duration?: number;
  time?: string;
  url?: string;
  interval?: number;
  path?: string;
  calendarId?: string;
  eventQuery?: string;
  triggerType?: string;
  [key: string]: unknown;
}

export interface Trigger {
  id: string;
  type: string;
  config: TriggerConfig;
  workflowId: string;
  enabled: boolean;
  nextFire?: string;
  lastFired?: string;
  execCount?: number;
  standard?: boolean;
  _nodeId?: string;
}

interface ApiResult {
  success: boolean;
  error?: string;
  trigger?: Trigger;
  triggers?: Trigger[];
}

const CACHE_KEY = 'yha.triggers.cache';

function BASE(): string {
  return (window as Window & { API_CONFIG?: { baseUrl: string } }).API_CONFIG?.baseUrl || window.location.origin;
}

function cacheRead(): Trigger[] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]') as Trigger[];
  } catch {
    return [];
  }
}

function cacheWrite(list: Trigger[]): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(list));
}

let triggerList: Trigger[] = cacheRead();
let _es: EventSource | null = null;

function notify(): void {
  window.dispatchEvent(new CustomEvent('yha:triggers-changed'));
}

async function apiFetch(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
    mode: 'cors',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE() + path, opts);
  return res.json() as Promise<ApiResult>;
}

// ── SSE ───────────────────────────────────────────────────────────────────
function connectSSE(): void {
  if (_es) { _es.close(); _es = null; }
  _es = new EventSource(BASE() + '/v1/triggers/events');

  _es.addEventListener('trigger:snapshot', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as { triggers?: Trigger[] };
    triggerList = data.triggers || [];
    cacheWrite(triggerList);
    notify();
  });

  _es.addEventListener('trigger:fire', (e) => {
    const t = JSON.parse((e as MessageEvent).data) as Trigger;
    const idx = triggerList.findIndex((x) => x.id === t.id);
    if (idx !== -1) triggerList[idx] = { ...triggerList[idx], ...t };
    cacheWrite(triggerList);
    notify();
    showFireToast(t);
  });

  _es.addEventListener('trigger:created', (e) => {
    const t = JSON.parse((e as MessageEvent).data) as Trigger;
    if (!triggerList.find((x) => x.id === t.id)) triggerList.push(t);
    cacheWrite(triggerList);
    notify();
  });

  _es.addEventListener('trigger:updated', (e) => {
    const t = JSON.parse((e as MessageEvent).data) as Trigger;
    const idx = triggerList.findIndex((x) => x.id === t.id);
    if (idx !== -1) triggerList[idx] = t;
    else triggerList.push(t);
    cacheWrite(triggerList);
    notify();
  });

  _es.addEventListener('trigger:deleted', (e) => {
    const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
    triggerList = triggerList.filter((x) => x.id !== id);
    cacheWrite(triggerList);
    notify();
  });

  // Per-session auto-title event — used to live-patch the SessionPicker so a
  // newly-titled chat instantly shows its real name. Toast emission is
  // deliberately suppressed here: the bridge also fires `auto-title:batch-summary`
  // at end-of-run with the total count, and that is what produces the single
  // user-visible toast. This avoids the 17×-toast spam from a 17-session batch.
  _es.addEventListener('auto-title:titled', (e) => {
    const { sid, title } = JSON.parse((e as MessageEvent).data) as { sid: string; title: string };
    // Patch session name live in the store so SessionPicker reflects the new title immediately
    const { sessions, setSessions } = useSessionStore.getState();
    const updated = sessions.map((s) => String(s.id) === String(sid) ? { ...s, name: title } : s);
    setSessions(updated);
    // No per-session toast — see batch-summary handler below.
  });

  // Single summary toast per auto-title run (Phase 1.7 — user request 2026-05-06).
  // Replaces the per-session toast that previously stacked N entries for an
  // N-session batch.
  _es.addEventListener('auto-title:batch-summary', (e) => {
    let payload: { count?: number } = {};
    try { payload = JSON.parse((e as MessageEvent).data) || {}; } catch { /* ignore */ }
    if (!_toastEventEnabled('auto-title:titled')) return;
    const n = payload.count ?? 0;
    if (n <= 0) return;
    getToastActions().show(
      n === 1 ? 'Auto-titled 1 session' : `Auto-titled ${n} sessions`,
      'success',
      { duration: 3500 },
    );
  });

  // Phase 1.7 — categorizer summary toast (single per run). The per-session
  // `context:categorized` event still fires for any consumers that need live
  // category info, but it does NOT show a toast. This event does.
  _es.addEventListener('context:categorized-batch', (e) => {
    let payload: { count?: number } = {};
    try { payload = JSON.parse((e as MessageEvent).data) || {}; } catch { /* ignore */ }
    if (!_toastEventEnabled('context:categorized')) return;
    const n = payload.count ?? 0;
    if (n <= 0) return;
    getToastActions().show(
      n === 1 ? 'Categorized 1 session' : `Categorized ${n} sessions`,
      'success',
      { duration: 3000 },
    );
  });

  // Phase 2 — context-sorter run finished. Re-dispatched to a window event so
  // HubGeneratorTab and any future consumers can refresh without polling.
  _es.addEventListener('context:wiki-updated', (e) => {
    let payload: { filesWritten?: number; totalSessions?: number } = {};
    try { payload = JSON.parse((e as MessageEvent).data) || {}; } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('yha:context:wiki-updated', { detail: payload }));
    if (!_toastEventEnabled('context:wiki-updated')) return;
    const n = payload.filesWritten ?? 0;
    if (n > 0) {
      getToastActions().show(`Wiki updated: ${n} file${n === 1 ? '' : 's'} written`, 'success', { duration: 3000 });
    }
  });

  // Phase 3.1 — LINK / Obsidian-Sync run finished. Same pattern: re-dispatch
  // to a window event so HubGeneratorTab refreshes immediately, optional toast.
  _es.addEventListener('link:synced', (e) => {
    let payload: { pushed?: number; pulled?: number; conflicts?: number; errors?: number } = {};
    try { payload = JSON.parse((e as MessageEvent).data) || {}; } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('yha:link:synced', { detail: payload }));
    if (!_toastEventEnabled('link:synced')) return;
    const up = payload.pushed   ?? 0;
    const dn = payload.pulled   ?? 0;
    const cx = payload.conflicts ?? 0;
    if (up + dn === 0 && cx === 0) return;
    const cxSuffix = cx > 0 ? ` ⚠${cx} conflict${cx === 1 ? '' : 's'}` : '';
    getToastActions().show(`LINK: ↑${up} ↓${dn}${cxSuffix}`, cx > 0 ? 'warning' : 'success', { duration: 3000 });
  });

  _es.onerror = () => {
    _es!.close();
    setTimeout(connectSSE, 5000);
  };
}


function showFireToast(t: Trigger): void {
  getToastActions().show(`⚡ Trigger fired: ${t.type} → ${t.workflowId}`, 'info', { duration: 3000 });
}

// ── CRUD ──────────────────────────────────────────────────────────────────
async function add(type: string, config: TriggerConfig, workflowId: string): Promise<Trigger | undefined> {
  const data = await apiFetch('POST', '/v1/triggers/', { type, config, workflowId, enabled: true });
  if (data.success && data.trigger) {
    if (!triggerList.find((x) => x.id === data.trigger!.id)) triggerList.push(data.trigger);
    cacheWrite(triggerList);
    notify();
    return data.trigger;
  }
}

async function remove(id: string): Promise<void> {
  const data = await apiFetch('DELETE', `/v1/triggers/${id}`);
  if (!data.success) {
    getToastActions().show('Cannot delete: ' + (data.error || 'server error'), 'error');
    return;
  }
  triggerList = triggerList.filter((t) => t.id !== id);
  cacheWrite(triggerList);
  notify();
}

async function toggle(id: string): Promise<boolean | undefined> {
  const data = await apiFetch('POST', `/v1/triggers/${id}/toggle`);
  if (data.success && data.trigger) {
    const idx = triggerList.findIndex((t) => t.id === id);
    if (idx !== -1) triggerList[idx] = data.trigger;
    cacheWrite(triggerList);
    notify();
    return data.trigger.enabled;
  }
}

async function update(id: string, type: string, config: TriggerConfig, workflowId: string): Promise<Trigger | undefined> {
  const data = await apiFetch('PATCH', `/v1/triggers/${id}`, { type, config, workflowId });
  if (data.success && data.trigger) {
    const idx = triggerList.findIndex((t) => t.id === id);
    if (idx !== -1) triggerList[idx] = data.trigger;
    cacheWrite(triggerList);
    notify();
    return data.trigger;
  }
}

async function fireManual(id: string): Promise<void> {
  await apiFetch('POST', `/v1/triggers/${id}/fire`);
}

function getAll(): Trigger[] {
  return triggerList;
}

async function loadMd(id: string): Promise<string> {
  const res = await fetch(BASE() + `/v1/triggers/${id}/md`);
  return res.text();
}

async function saveMd(id: string, content: string): Promise<ApiResult> {
  return apiFetch('PUT', `/v1/triggers/${id}/md`, { content });
}

// ── Graph sync — auto-register trigger nodes ──────────────────────────────
async function syncFromGraph(): Promise<void> {
  const graphNodes = (getGraphState().nodes as Array<{ id: string; type: string; triggerConfig?: TriggerConfig }>)
    .filter((n) => n.type === 'trigger');
  for (const t of [...triggerList]) {
    if (t._nodeId && !graphNodes.find((n) => n.id === t._nodeId)) {
      await remove(t.id);
    }
  }
  for (const n of graphNodes) {
    const tc = n.triggerConfig || {};
    const ttype = tc.triggerType || 'timer';
    const config: TriggerConfig = { ...tc };
    delete config.triggerType;

    const existing = triggerList.find((t) => t._nodeId === n.id);
    if (existing) {
      const changed =
        existing.type !== ttype || JSON.stringify(existing.config) !== JSON.stringify(config);
      if (changed) await apiFetch('PATCH', `/v1/triggers/${existing.id}`, { type: ttype, config });
    } else {
      await add(ttype, config, getAppState().workflow.name || 'current');
    }
  }
}

function init(): void {
  connectSSE();

  apiFetch('GET', '/v1/triggers/')
    .then((data) => {
      if (data.success && data.triggers) {
        triggerList = data.triggers;
        cacheWrite(triggerList);
        notify();
      }
    })
    .catch(() => {});

  let _prevRev = useGraphStore.getState().graphRevision;
  useGraphStore.subscribe((state) => {
    if (state.graphRevision === _prevRev) return;
    _prevRev = state.graphRevision;
    syncFromGraph();
  });

  if (import.meta.env.DEV) console.log(`[triggers] init — ${triggerList.length} trigger(s) from cache`);
}

export const triggers = {
  init,
  getAll,
  add,
  remove,
  toggle,
  update,
  fireManual,
  syncFromGraph,
  loadMd,
  saveMd,
};
