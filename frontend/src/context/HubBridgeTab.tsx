// HubBridgeTab — Standalone / MCP / Both toggle for the ContextGenerator.
// Phase 1b / Adaption 3 (Bridge-Toggle) — second half of Adaption 3 that
// lives entirely in the Hub (the Quick-Picker doesn't expose this on
// purpose so users aren't forced to make this choice in-flight).
//
// Modes:
//   • standalone — context items are pulled by the YHA frontend only.
//                  No Hermes / external partner sees them. Default.
//   • mcp        — items are exposed via the MCP bridge so partner agents
//                  (Hermes etc.) can request them through the same
//                  sensitivity-gate as the user. Phase 3 wires the actual
//                  MCP-side route — for now, the toggle persists state.
//   • both       — both surfaces active. Useful while migrating.
//
// The selected mode is server-persisted under config.defaults.contextBridge.mode
// via PATCH /v1/config/context/bridge. We read it back from the same
// /v1/config/context/status endpoint the Generator tab uses.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useContextStore, type BridgeMode } from './contextStore.js';

interface ModeSpec {
  id:    BridgeMode;
  label: string;
  hint:  string;
}

const MODES: ReadonlyArray<ModeSpec> = Object.freeze([
  { id: 'standalone', label: 'Standalone', hint: 'YHA-only. Context never leaves this app. Default — safest.' },
  { id: 'mcp',        label: 'MCP only',   hint: 'Expose context to MCP partners (e.g. Hermes). Phase 3 wires this end-to-end.' },
  { id: 'both',       label: 'Both',       hint: 'YHA frontend + MCP partners. Useful while migrating workflows.' },
]);

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

export function HubBridgeTab() {
  const bridgeMode = useContextStore((s) => s.bridgeMode);
  const setBridgeMode = useContextStore((s) => s.setBridgeMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverMode, setServerMode] = useState<BridgeMode | null>(null);

  // On mount: pull the server-persisted mode and reconcile the store.
  // We don't blindly overwrite — if the user just clicked a mode the
  // optimistic update should win — only sync when we have no pending
  // local mutation.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const url = _baseUrl();
      if (!url) return;
      try {
        const r = await fetch(`${url}/v1/config/context/status`);
        const j = await r.json();
        if (cancelled) return;
        if (j?.success && typeof j.bridgeMode === 'string') {
          const m = j.bridgeMode as BridgeMode;
          setServerMode(m);
          if (m !== bridgeMode) setBridgeMode(m);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeMode(next: BridgeMode) {
    if (next === bridgeMode) return;
    const url = _baseUrl();
    if (!url) return;
    // Optimistic update — store flips first, server confirms second.
    setBridgeMode(next);
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${url}/v1/config/context/bridge`, {
        method:  'PATCH',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ mode: next }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      setServerMode(j.mode as BridgeMode);
    } catch (e) {
      // Roll back on failure so the UI doesn't lie.
      setError(e instanceof Error ? e.message : String(e));
      if (serverMode) setBridgeMode(serverMode);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header>
        <h4 style={{ margin: 0 }}>Bridge mode</h4>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
          Where the ContextGenerator pipeline publishes its index. Affects which
          surfaces (YHA chat, MCP partner agents) can request context items.
        </p>
      </header>

      {error && (
        <div style={{
          padding: '8px 10px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: '12px',
        }}>
          {error}
        </div>
      )}

      <div role="radiogroup" aria-label="Bridge mode" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MODES.map((m) => {
          const active = bridgeMode === m.id;
          return (
            <label
              key={m.id}
              style={{
                display:       'flex',
                gap:           10,
                padding:       '10px 12px',
                border:        active ? '1px solid var(--accent, #4a8)' : '1px solid var(--border, #2a2a2a)',
                background:    active ? 'rgba(80,160,128,0.08)' : 'transparent',
                borderRadius:  6,
                cursor:        busy ? 'wait' : 'pointer',
                opacity:       busy ? 0.7 : 1,
              }}
            >
              <input
                type="radio"
                name="context-bridge-mode"
                value={m.id}
                checked={active}
                disabled={busy}
                onChange={() => void changeMode(m.id)}
                style={{ marginTop: 3 }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <strong>{m.label}</strong>
                <span style={{ fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
                  {m.hint}
                </span>
              </div>
            </label>
          );
        })}
      </div>

      <p style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
        Setting persists in <code>config.defaults.contextBridge.mode</code> on the bridge.
        MCP-side wiring is Phase 3 — until then "MCP only" and "Both" function
        identically to "Standalone" but the preference is preserved.
      </p>
    </div>
  );
}
