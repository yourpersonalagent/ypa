// Modules tab — list bridge modules from /v1/modules with on/off toggles.
// Toggles write back to bridge/modules.json (PATCH /v1/modules/:name) and,
// where the module's lifecycle allows it, apply live without a bridge
// restart. Modules whose manifest declares lifecycle.reload="never" (or
// pure FE-kind modules whose static import only takes effect at FE boot)
// still need a restart — those flip the dirty flag.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { listEnabledModules, setFEModuleActive } from '../host/enabled-modules.js';

interface BridgeModule {
  name: string;
  state: 'pending' | 'active' | 'failed' | 'disabled';
  version?: string;
  kind?: 'bridge' | 'frontend' | 'both' | 'mcp-server';
  core?: boolean;
  needs?: string[];
  description?: string;
  category?: string;
  loadedAt?: number | null;
  error?: string | null;
  enabled?: boolean;
}

// Category order shown in the UI. Anything not listed gets bucketed under
// "other" and rendered last. Display labels mirror the manifest category
// slugs lightly capitalised.
const CATEGORY_ORDER = [
  'chat',
  'context',
  'harness',
  'multichat',
  'mcp',
  'files',
  'integrations',
  'productivity',
  'system',
  'other',
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  chat: 'Chat',
  context: 'Context & Knowledge',
  harness: 'Model Harnesses',
  multichat: 'Multichat',
  mcp: 'MCP',
  files: 'Files',
  integrations: 'Integrations',
  productivity: 'Productivity',
  system: 'System',
  other: 'Other',
};

function categoryOf(m: BridgeModule): string {
  if (m.category && typeof m.category === 'string') return m.category;
  const dash = m.name.indexOf('-');
  if (dash > 0) {
    const prefix = m.name.slice(0, dash);
    if (CATEGORY_LABELS[prefix]) return prefix;
  }
  return 'other';
}

interface ConfiguredEntry {
  name: string;
  enabled: boolean;
}

const STATE_CHIP_STYLE: Record<BridgeModule['state'], React.CSSProperties> = {
  active:   { background: 'rgba(80,200,120,.18)',  color: '#7fd49a' },
  pending:  { background: 'rgba(120,160,255,.18)', color: '#9ab8ff' },
  failed:   { background: 'rgba(255,90,90,.20)',   color: '#ff9b9b' },
  disabled: { background: 'rgba(180,180,180,.18)', color: '#bdbdbd' },
};

export function TabModules() {
  const base = api.config.baseUrl as string;

  const [modules, setModules] = useState<BridgeModule[]>([]);
  const [configured, setConfigured] = useState<ConfiguredEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Two distinct kinds of "you need to do something to finish this":
  //   bridgeDirty — at least one toggle requires a full bridge restart (the
  //                 module declared lifecycle.reload="never", or its hot
  //                 transition refused/failed).
  //   feDirty     — at least one toggle changed a frontend module whose
  //                 live lifecycle is unsupported in this tab (no
  //                 deactivate(), or it threw), so the FE surface only
  //                 catches up on a page reload.
  // These are independent and accumulate across toggles until the user
  // acts on the corresponding CTA.
  const [bridgeDirty, setBridgeDirty] = useState(false);
  const [feDirty, setFeDirty] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // The bridge's currently running mode (dev = bun --watch + Vite middleware,
  // build = production dist served statically). Drives the restart tooltip
  // and the Swap-Mode button label. null = not loaded yet.
  const [runtimeMode, setRuntimeMode] = useState<'dev' | 'build' | null>(null);
  const [swapping, setSwapping] = useState(false);

  const feEnabled = listEnabledModules();

  useEffect(() => {
    let cancelled = false;
    fetch(`${base}/v1/runtime/mode`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled && (j?.mode === 'dev' || j?.mode === 'build')) setRuntimeMode(j.mode); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [base]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(base + '/v1/modules');
      const d = await r.json() as { success?: boolean; modules?: BridgeModule[]; configured?: ConfiguredEntry[] };
      setModules(Array.isArray(d.modules) ? d.modules : []);
      setConfigured(Array.isArray(d.configured) ? d.configured : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  async function handleToggle(name: string, next: boolean) {
    // Warn when disabling a module that other ENABLED modules depend on.
    if (!next) {
      const enabledRequiredBy = (requiredByMap.get(name) ?? [])
        .filter((n) => {
          const r = rows.find((m) => m.name === n);
          return r && r.enabled !== false;
        });
      if (enabledRequiredBy.length > 0) {
        const ok = window.confirm(
          `"${name}" is required by: ${enabledRequiredBy.join(', ')}.\n\n` +
          `Disabling it may break those modules after the next restart. Continue?`
        );
        if (!ok) return;
      }
    }
    setPending((p) => { const n = new Set(p); n.add(name); return n; });
    try {
      const r = await fetch(`${base}/v1/modules/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json() as {
        success?: boolean;
        error?: string;
        hot?: boolean;
        restartRequired?: boolean;
        hotError?: string | null;
        feReloadRequired?: boolean;
      };
      if (!d.success) throw new Error(d.error || `HTTP ${r.status}`);
      setConfigured((prev) => {
        const idx = prev.findIndex((m) => m.name === name);
        if (idx < 0) return [...prev, { name, enabled: next }];
        const out = prev.slice();
        out[idx] = { name, enabled: next };
        return out;
      });
      // Mirror onto the registry-derived `modules` state too — the row's
      // checkbox reads from the merged map and that map prefers the
      // `modules` entry, so without this the controlled checkbox snaps
      // back to its pre-PATCH value and looks "locked".
      setModules((prev) => prev.map((m) => (m.name === name ? { ...m, enabled: next } : m)));
      // Bridge side: only flip dirty when the bridge itself couldn't apply
      // the change live. Hot toggles applied live shouldn't push the user
      // toward a needless restart.
      if (d.restartRequired) setBridgeDirty(true);
      // FE side: if the module has a FE half, ask the host to run its
      // activate()/deactivate() now. If that's unsupported (no
      // deactivate() declared, throw, etc.), fall back to needing a page
      // reload. This is how chat-minimap actually disappears without a
      // reload — host.removeModuleEverywhere() emits a register change
      // and PanelSlot re-renders.
      if (d.feReloadRequired) {
        const fe = await setFEModuleActive(name, next);
        if (!fe.supported) {
          setFeDirty(true);
          console.info(`[modules] "${name}" needs page reload to ${next ? 'activate' : 'deactivate'} FE half: ${fe.reason ?? 'unsupported'}`);
        } else if (!fe.ok) {
          setFeDirty(true);
          console.warn(`[modules] live FE toggle for "${name}" failed: ${fe.reason ?? 'unknown'}`);
        }
      }
      // Refresh from the server so state badges (active/disabled) reflect
      // what the loader did, including any failures during enable.
      load();
      if (d.hotError) {
        console.warn(`[modules] hot ${next ? 'enable' : 'disable'} of "${name}" fell back: ${d.hotError}`);
      }
    } catch (e) {
      alert(`Toggle failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(name); return n; });
    }
  }

  async function handleRestart() {
    if (restarting) return;
    setRestarting(true);
    // No body → bridge restarts in the mode it is currently in.
    try { await fetch(`${base}/v1/restart`, { method: 'POST' }); }
    catch { /* ignore */ }
    setTimeout(() => { setRestarting(false); setBridgeDirty(false); load(); }, 5000);
  }

  async function handleSwapMode() {
    if (swapping || restarting || !runtimeMode) return;
    const next: 'dev' | 'build' = runtimeMode === 'dev' ? 'build' : 'dev';
    const msg = next === 'dev'
      ? 'Switch to DEV mode?\n\nPros:\n  • Vite HMR in the browser (frontend changes visible instantly)\n  • bun --watch — bridge restarts automatically on .ts changes (~1–2 s)\n  • No more "bun run build" needed after every change\n\nCons:\n  • Vite runs as middleware → higher RAM usage\n  • First page load is slower (no minifying)\n  • Behavior may differ slightly from production\n\nThe server fully restarts (~5–10 s downtime).'
      : 'Switch to BUILD mode?\n\nPros:\n  • Faster page loads (minified + bundled dist/)\n  • Lower memory usage (no Vite dev server)\n  • Behavior matches production\n\nCons:\n  • No live reload — every frontend change needs "bun run build"\n  • Bridge must be restarted manually on .ts changes\n  • Startup takes longer (Vite has to build first)\n\nThe server fully restarts (~10–30 s, including Vite build).';
    if (!window.confirm(msg)) return;
    setSwapping(true);
    try {
      await fetch(`${base}/v1/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
    } catch { /* ignore */ }
    // The bridge will go down + come back up with the new mode. Reload the
    // page after the restart settles so the FE picks up Vite (or the fresh
    // dist) for the new mode.
    setTimeout(() => { setSwapping(false); window.location.reload(); }, 8000);
  }

  function handlePageReload() {
    // Page reload re-runs activateEnabledModules(), which re-reads the
    // bridge's enabled flags and re-decides which FE halves boot.
    window.location.reload();
  }

  // What does the primary CTA need to do?
  //   bridge — bridge half couldn't hot-apply, so the user needs to
  //            restart the bridge.
  //   fe     — FE half couldn't be cycled in-place, so a page reload
  //            will pick up the new state.
  //   both   — both happened; restart first, then reload. Clicking does
  //            restart, after which the user can reload (browsers strip
  //            cached state on reload, so we don't auto-redirect — the
  //            bridge may not be back yet when reload fires).
  //   none   — no toggles changed anything non-hot. Button is still
  //            available as a manual idempotent action.
  const ctaKind: 'none' | 'bridge' | 'fe' | 'both' =
    bridgeDirty && feDirty ? 'both'
    : bridgeDirty ? 'bridge'
    : feDirty ? 'fe'
    : 'none';
  const ctaLabel = restarting
    ? '… Restarting'
    : ctaKind === 'both' ? '↺ Restart bridge + reload page'
    : ctaKind === 'bridge' ? '↺ Restart bridge to apply'
    : ctaKind === 'fe' ? '↻ Reload page to apply'
    : '↺ Restart bridge';
  const ctaAccent = ctaKind !== 'none';
  function handleCta() {
    if (ctaKind === 'fe') handlePageReload();
    else handleRestart();
  }

  async function handleReload(name: string) {
    setPending((p) => { const n = new Set(p); n.add(name); return n; });
    try {
      const r = await fetch(`${base}/v1/modules/${encodeURIComponent(name)}/reload`, { method: 'POST' });
      const d = await r.json() as { success?: boolean; error?: string };
      if (!d.success) alert(`Reload failed: ${d.error || `HTTP ${r.status}`}`);
      else load();
    } catch (e) {
      alert(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(name); return n; });
    }
  }

  // Emergency "undo last edit" — surfaced next to failed modules so the user
  // doesn't have to know /rewind exists when a hot-reload kills a module.
  // Goes straight to the standalone yha-rewind service via the bridge's
  // /__rewind proxy (loopback-only on the Go side; WorkOS-gated on the
  // proxy). Bypasses the chat in-flight gate on purpose — if a module
  // just failed there's no tool call worth waiting on.
  async function handleEmergencyRewind(name: string) {
    setPending((p) => { const n = new Set(p); n.add(name); return n; });
    try {
      const r = await fetch(`${base}/__rewind/api/edits?limit=1`);
      if (!r.ok) throw new Error(`fetch edits: HTTP ${r.status}`);
      const d = await r.json() as { edits?: Array<{ id: string; module?: string }> };
      const latest = d.edits?.[0];
      if (!latest) {
        alert('No rewind records to undo.');
        return;
      }
      const proceed = window.confirm(
        `Undo last edit ${latest.id.slice(0, 8)}… (module: ${latest.module || '?'})?\n\n` +
        `Then click "Reload" on ${name} to try loading the module again.`,
      );
      if (!proceed) return;
      const rr = await fetch(`${base}/__rewind/api/restore/${encodeURIComponent(latest.id)}`, { method: 'POST' });
      const rd = await rr.json() as {
        id?: string;
        direction?: string;
        results?: Array<{ path: string; op: string; ok: boolean; err?: string }>;
        error?: string;
      };
      if (!rr.ok || rd.error) {
        alert(`Rewind failed: ${rd.error || `HTTP ${rr.status}`}`);
        return;
      }
      const results = rd.results || [];
      const okN = results.filter((x) => x.ok).length;
      const failN = results.length - okN;
      const failMsgs = results.filter((x) => !x.ok).map((x) => `${x.path}: ${x.err}`);
      if (failN > 0) {
        alert(`Rewind partial: ${okN} OK, ${failN} failed.\n\n${failMsgs.join('\n')}`);
      } else {
        alert(`Rewind OK: ${okN} files restored.`);
      }
      load();
    } catch (e) {
      alert(`Rewind failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(name); return n; });
    }
  }

  // Merge so we also surface entries in modules.json that didn't load.
  const byName = new Map(modules.map((m) => [m.name, m] as const));
  for (const c of configured) {
    if (!byName.has(c.name)) {
      byName.set(c.name, { name: c.name, state: 'disabled', enabled: c.enabled });
    }
  }
  const rows = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totalEnabled = rows.filter((m) => m.enabled !== false).length;
  const totalActive = modules.filter((m) => m.state === 'active').length;

  // Reverse-dependency map: modName -> [names that list modName in `needs`].
  // Built off the same merged row set used for rendering so the
  // "Required by" line and the toggle-off warning stay consistent.
  const requiredByMap = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.needs || r.needs.length === 0) continue;
    for (const dep of r.needs) {
      const arr = requiredByMap.get(dep) ?? [];
      arr.push(r.name);
      requiredByMap.set(dep, arr);
    }
  }

  // Bucket rows into categories. Anything not in CATEGORY_ORDER lands in
  // "other"; categories with no rows are dropped from the rendered list.
  const grouped = new Map<string, BridgeModule[]>();
  for (const r of rows) {
    const cat = categoryOf(r);
    const bucket = grouped.get(cat) ?? [];
    bucket.push(r);
    grouped.set(cat, bucket);
  }
  const knownOrder = new Set<string>(CATEGORY_ORDER);
  const orderedCategories: string[] = [
    ...CATEGORY_ORDER.filter((c) => grouped.has(c) && c !== 'other'),
    ...[...grouped.keys()].filter((c) => !knownOrder.has(c)).sort(),
    ...(grouped.has('other') ? ['other'] : []),
  ];

  return (
    <>
      <h4 className="prefs-sec">Bridge Modules</h4>
      <div className="prefs-hint" style={{ marginBottom: '8px' }}>
        Toggle modules on/off. Changes are written to <code>bridge/modules.json</code> and apply
        live: the bridge hot-swaps the backend half, the FE host runs the module's
        <code> activate()</code>/<code>deactivate()</code> for the in-page half. Modules whose manifest
        declares <code>lifecycle.reload="never"</code> need a bridge restart; FE modules without a
        <code> deactivate()</code> need a page reload. <em>Core</em> modules cannot be disabled.
      </div>

      <div className="prefs-row" style={{ alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '12px', color: 'var(--fg-dim)' }}>
          {loading ? 'Loading…' : `${totalActive} active · ${totalEnabled} enabled · ${rows.length} total`}
        </span>
        <button className="prefs-btn" onClick={load} disabled={loading}>↻ Refresh</button>
        {runtimeMode && (
          <button
            className="prefs-btn"
            onClick={handleSwapMode}
            disabled={swapping || restarting}
            title={runtimeMode === 'dev'
              ? 'Current: DEV mode.\n\nSwitch to BUILD:\n  ✓ Faster page loads (minified dist/)\n  ✓ Lower RAM usage (no Vite dev server)\n  ✓ Matches production\n  ✗ No live reload — "bun run build" after every frontend change\n  ✗ Bridge must be restarted manually on .ts changes'
              : 'Current: BUILD mode.\n\nSwitch to DEV:\n  ✓ Vite HMR — frontend changes visible instantly\n  ✓ bun --watch — bridge restarts on .ts changes (~1–2 s)\n  ✓ No more "bun run build" needed\n  ✗ Vite as middleware → more RAM\n  ✗ First page load is slower'}
          >
            {swapping ? '… Switching' : `⇄ Switch to ${runtimeMode === 'dev' ? 'BUILD' : 'DEV'}`}
          </button>
        )}
        <button
          className={`prefs-btn${ctaAccent ? ' prefs-btn-primary' : ''}`}
          title={
            ctaKind === 'fe' ? 'Reload this browser tab to apply FE module changes'
            : ctaKind === 'both' ? 'Restart bridge first, then reload the page to apply FE module changes'
            : runtimeMode
              ? `Restart server in ${runtimeMode} mode (./yha.sh ${runtimeMode}) — same mode it's running in now`
              : 'Restart server in current mode (./yha.sh)'
          }
          onClick={handleCta}
          disabled={restarting || swapping}
          style={{
            marginLeft: 'auto',
            background: ctaAccent ? 'var(--accent)' : undefined,
            color: ctaAccent ? 'var(--bg)' : undefined,
            fontWeight: ctaAccent ? 600 : undefined,
          }}
        >
          {ctaLabel}
        </button>
      </div>

      {error && (
        <div className="prefs-hint" style={{ color: '#ff9b9b', marginBottom: '8px' }}>
          Failed to load modules: {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {orderedCategories.map((cat) => {
          const bucket = grouped.get(cat) ?? [];
          const label = CATEGORY_LABELS[cat] || (cat.charAt(0).toUpperCase() + cat.slice(1));
          const activeInCat = bucket.filter((m) => m.state === 'active').length;
          return (
            <section key={cat}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '8px',
                  margin: '4px 0 6px',
                  paddingBottom: '4px',
                  borderBottom: '1px solid var(--stroke)',
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                  {label}
                </span>
                <span className="dim" style={{ fontSize: '11px' }}>
                  {activeInCat}/{bucket.length} active
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {bucket.map((m) => {
                  const isPending = pending.has(m.name);
                  const isCore = m.core === true;
                  const checked = m.enabled !== false;
                  const hasFE = feEnabled.includes(m.name);
                  const stateStyle = STATE_CHIP_STYLE[m.state] || STATE_CHIP_STYLE.disabled;
                  return (
                    <div
                      key={m.name}
                      className="prefs-provider-row"
                      style={{ alignItems: 'center', gap: '10px', border: '1px solid var(--stroke)', borderRadius: '8px', padding: '8px 12px' }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isCore || isPending}
                        onChange={(e) => handleToggle(m.name, e.target.checked)}
                        style={{ accentColor: 'var(--accent)', width: '14px', height: '14px' }}
                        title={isCore ? 'Core module — cannot be disabled' : (checked ? 'Disable' : 'Enable')}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 600, fontSize: '13px' }}>{m.name}</span>
                          {m.version && <span className="dim" style={{ fontSize: '11px' }}>v{m.version}</span>}
                          {m.kind && <span className="prefs-mini-chip">{m.kind}</span>}
                          {hasFE && <span className="prefs-mini-chip" title="Frontend half is statically imported in enabled-modules.ts">FE</span>}
                          {isCore && <span className="prefs-mini-chip" style={{ background: 'rgba(255,200,80,.18)', color: '#e8c454' }}>core</span>}
                          <span className="prefs-mini-chip" style={stateStyle}>{m.state}</span>
                        </div>
                        {m.description && (
                          <div className="dim" style={{ fontSize: '11.5px', lineHeight: 1.45, marginTop: '4px' }}>
                            {m.description}
                          </div>
                        )}
                        {m.needs && m.needs.length > 0 && (
                          <div className="dim" style={{ fontSize: '11px', marginTop: '3px' }}>Depends on: {m.needs.join(', ')}</div>
                        )}
                        {(() => {
                          const rb = requiredByMap.get(m.name);
                          return rb && rb.length > 0 ? (
                            <div className="dim" style={{ fontSize: '11px' }}>Required by: {rb.join(', ')}</div>
                          ) : null;
                        })()}
                        {m.error && (
                          <div style={{ fontSize: '11px', color: '#ff9b9b' }}>error: {m.error}</div>
                        )}
                      </div>
                      {m.state === 'failed' && (
                        <button
                          className="prefs-btn"
                          onClick={() => handleEmergencyRewind(m.name)}
                          disabled={isPending}
                          title="Undo the most recent rewind record — useful when a hot reload broke this module"
                          style={{ padding: '3px 8px', fontSize: '11px', background: 'rgba(255,90,90,.20)', color: '#ff9b9b' }}
                        >
                          ↩ Rewind last edit
                        </button>
                      )}
                      <button
                        className="prefs-btn"
                        onClick={() => handleReload(m.name)}
                        disabled={isPending || m.state !== 'active'}
                        title="Hot reload — only safe for modules with no external require() callers (today: none)"
                        style={{ padding: '3px 8px', fontSize: '11px' }}
                      >
                        Reload
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
        {!loading && rows.length === 0 && (
          <div className="dim" style={{ fontSize: '12px' }}>No modules found.</div>
        )}
      </div>

      {hasFEOnlyHint(feEnabled, rows) && (
        <div className="prefs-hint" style={{ marginTop: '12px' }}>
          Frontend modules are imported statically in <code>frontend/src/host/enabled-modules.ts</code>.
          A module flagged <span className="prefs-mini-chip">FE</span> has a frontend half that ships
          even if the bridge module is disabled — the FE surface will simply have no backend to talk to.
        </div>
      )}
    </>
  );
}

function hasFEOnlyHint(feEnabled: string[], rows: BridgeModule[]): boolean {
  return feEnabled.some((n) => {
    const r = rows.find((m) => m.name === n);
    return !r || r.enabled === false;
  });
}
