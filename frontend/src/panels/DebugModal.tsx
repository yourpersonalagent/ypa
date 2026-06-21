// DebugModal — React shell around the existing debug renderer registry.
// The type-specific renderers (chathistory/routing/mcp/
// costs/prefs/overview) live in panels/debug-panel.ts as HTML-string generators
// + post-render event wiring. This component owns: open/close state, tabs,
// refresh, restart, and copy-snapshot — but delegates body innerHTML to the
// renderers and drag/resize/clamp/Escape to <MoveableWindow>.
//
// Open the modal from anywhere via:
//   showDebugModal(type, data)      — see panels/debug-panel.ts
// Internally that dispatches a 'yha:debug-modal' CustomEvent which this
// component listens for.

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { RENDERERS, type Renderer } from './debug-panel.js';
import { getNetMetrics, getReconnectMetrics } from '../util/net-metrics.js';
import { getToastActions } from '../stores/toastStore.js';
import { MoveableWindow } from '../components/MoveableWindow.js';

interface OpenDetail {
  type: string;
  data: Record<string, unknown>;
}

export function DebugModal() {
  const [open, setOpen] = useState(false);
  const [currentType, setCurrentType] = useState<string>('');
  const [currentData, setCurrentData] = useState<Record<string, unknown>>({});
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<'dev' | 'build' | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Pull the bridge's current mode once on open so the restart tooltip can
  // tell the user what mode they'll restart in (same as the running one).
  useEffect(() => {
    if (!open || runtimeMode !== null) return;
    let cancelled = false;
    fetch(`${api.config.baseUrl}/v1/runtime/mode`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && (j?.mode === 'dev' || j?.mode === 'build')) setRuntimeMode(j.mode); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, runtimeMode]);

  // Listen for show events
  useEffect(() => {
    function onShow(e: Event) {
      const detail = (e as CustomEvent<OpenDetail>).detail;
      if (!detail) return;
      const renderer = RENDERERS[detail.type];
      if (!renderer) {
        setCurrentType(detail.type);
        setCurrentData({});
        setActiveTabId('');
        setOpen(true);
        return;
      }
      setCurrentType(detail.type);
      setCurrentData(detail.data);
      setActiveTabId(renderer.tabs[0].id);
      setOpen(true);
    }
    window.addEventListener('yha:debug-modal', onShow as EventListener);
    return () => window.removeEventListener('yha:debug-modal', onShow as EventListener);
  }, []);

  // Render body whenever active tab or data changes
  useEffect(() => {
    if (!open || !bodyRef.current) return;
    const renderer: Renderer | undefined = RENDERERS[currentType];
    if (!renderer) {
      bodyRef.current.innerHTML = `<p class="dbg-empty">Unknown debug type: ${currentType}</p>`;
      return;
    }
    const tab = renderer.tabs.find((t) => t.id === activeTabId) || renderer.tabs[0];
    tab.render(currentData, bodyRef.current);
    bodyRef.current.scrollTop = 0;
  }, [open, currentType, currentData, activeTabId]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const sid = String(currentData?.sessionId ?? '_');
      const r = await fetch(
        `${api.config.baseUrl}/v1/debug/${encodeURIComponent(currentType)}/${encodeURIComponent(sid)}`,
      );
      const j = await r.json();
      if (j?.success && j.data) {
        setCurrentData(j.data);
      }
    } catch (err) {
      console.error('debug refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  }

  // Build a clipboard-friendly snapshot: server-side debug payload for the
  // active type + frontend net/reconnect metrics + browser context. Pasted
  // directly into a chat with Claude this is enough to debug stream
  // connectivity / monitoring issues without going through DevTools.
  async function copySnapshot() {
    try {
      const sid = String(currentData?.sessionId ?? '_');
      let monitoring: any = null;
      try {
        const r = await fetch(`${api.config.baseUrl}/v1/debug/monitoring/${encodeURIComponent(sid)}`);
        const j = await r.json();
        if (j?.success && j.data) monitoring = j.data;
      } catch (_) {}
      const net = getNetMetrics();
      const recon = getReconnectMetrics();
      const ctx = {
        ts: new Date().toISOString(),
        ua: navigator.userAgent,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        url: window.location.href,
        currentSessionFromUrl: window.location.hash || null,
        debugView: { type: currentType, activeTab: activeTabId },
      };
      const md = [
        `# YHA debug snapshot — ${ctx.ts}`,
        '',
        '## Browser context',
        '```json',
        JSON.stringify(ctx, null, 2),
        '```',
        '',
        '## Frontend net metrics',
        '```json',
        JSON.stringify(net, null, 2),
        '```',
        '',
        '## Frontend reconnect metrics',
        '```json',
        JSON.stringify(recon, null, 2),
        '```',
        '',
        '## Backend monitoring (`/v1/debug/monitoring/' + sid + '`)',
        '```json',
        JSON.stringify(monitoring, null, 2),
        '```',
        '',
        ...(currentType !== 'monitoring'
          ? [
              '## Active debug view (`/v1/debug/' + currentType + '/' + sid + '`)',
              '```json',
              JSON.stringify(currentData, null, 2),
              '```',
            ]
          : []),
      ].join('\n');
      try {
        await navigator.clipboard.writeText(md);
        getToastActions().show('Debug snapshot copied to clipboard', 'success', { duration: 2500 });
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = md;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); getToastActions().show('Debug snapshot copied (fallback)', 'success', { duration: 2500 }); }
        catch (_) { getToastActions().show('Clipboard blocked — see console for snapshot', 'error', { duration: 4000 }); console.log(md); }
        document.body.removeChild(ta);
      }
    } catch (e) {
      console.error('copy snapshot failed', e);
      getToastActions().show('Copy failed: ' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  }

  async function restartSameMode() {
    if (restarting) return;
    setRestarting(true);
    try {
      // No body → bridge restarts in whatever mode it is currently in.
      await fetch(`${api.config.baseUrl}/v1/restart`, { method: 'POST' });
    } catch (_) {}
    setTimeout(() => setRestarting(false), 5000);
  }

  const renderer = RENDERERS[currentType];
  const sid = String((currentData?.sessionId as string | undefined) ?? '').slice(0, 24);
  const title = renderer ? `${renderer.label}${sid ? ` — session "${sid}"` : ''}` : 'Debug';

  const headerExtras = (
    <>
      <button
        className={`mw-btn debug-modal-restart${restarting ? ' disabled' : ''}`}
        type="button"
        title={runtimeMode
          ? `Restart server in ${runtimeMode} mode (./yha.sh ${runtimeMode}) — same mode it's running in now`
          : 'Restart server in current mode (./yha.sh)'}
        disabled={restarting}
        onClick={(e) => { e.stopPropagation(); restartSameMode(); }}
      >
        {restarting ? '…' : '↺'}
      </button>
      <button
        className="mw-btn debug-modal-copy"
        type="button"
        title="Copy debug snapshot to clipboard (monitoring + net + reconnect + active view)"
        onClick={(e) => { e.stopPropagation(); copySnapshot(); }}
      >
        📋
      </button>
      <button
        className={`mw-btn debug-modal-refresh${refreshing ? ' spinning' : ''}`}
        type="button"
        title="Refresh"
        onClick={(e) => { e.stopPropagation(); refresh(); }}
      >
        ↻
      </button>
    </>
  );

  return (
    <MoveableWindow
      isOpen={open}
      title={title}
      storageKey="yha:debug-modal:geometry"
      defaultGeometry={{ width: 900, height: 640 }}
      minWidth={320}
      minHeight={240}
      zIndex={1400}
      onClose={() => setOpen(false)}
      headerExtras={headerExtras}
      cardClassName="debug-modal-card"
      bodyClassName="debug-modal-shell"
    >
      {renderer && (
        <nav className="debug-modal-tabs">
          {renderer.tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`debug-modal-tab${t.id === activeTabId ? ' active' : ''}`}
              onClick={() => setActiveTabId(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <div className="debug-modal-body" ref={bodyRef} />
    </MoveableWindow>
  );
}
