// HubSettingsTab — pipeline-stage toggles + sensitivity policy + whitelist.
// Phase 1b / Adaption 6 (Hub Settings) — migrated 2026-05-06 to also own
// the Auto-title + Categorizer + Sorter knobs that previously lived in
// Preferences > System.
//
// Surfaces:
//   • Auto-title (model + provider + enable toggle) — parent gate of the
//     entire ContextGenerator pipeline. Disabling it stops every stage.
//   • Per-stage enable/disable for Categorizer + Sorter. Each stage can be
//     independently switched off without disabling Auto-title.
//   • Sensitivity policy radio + whitelist controls (unchanged from before).
//
// Live status badges + Run-now / Force-rebuild buttons live in the
// Generator-tab dashboard (HubGeneratorTab) — keeping toggles here and
// dashboard there mirrors the Preferences pattern of "settings" vs
// "monitoring".

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { clearAll, usePendingConfirms } from './usePendingConfirms.js';

type Policy = 'always-prompt' | 'session-whitelist' | 'never-prompt-system';

interface PolicySpec {
  id:    Policy;
  label: string;
  hint:  string;
  warn?: boolean;
}

const POLICIES: ReadonlyArray<PolicySpec> = Object.freeze([
  {
    id:    'always-prompt',
    label: 'Always prompt',
    hint:  'Confirm dialog every time. Safest. Default.',
  },
  {
    id:    'session-whitelist',
    label: 'Session whitelist (30 min)',
    hint:  'Once confirmed, items in the same tier stay unlocked for 30 min. Cleared on bridge restart.',
  },
  {
    id:    'never-prompt-system',
    label: 'Never prompt — system tier ⚠',
    hint:  'Bypass the gate entirely for ⚙️🔒 system items. NOT recommended — credentials/keys leak with one stray click.',
    warn:  true,
  },
]);

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

interface AutoTitleStatus {
  isRunning?:      boolean;
  pendingCount?:   number;
  abandonedCount?: number;
  lifetimeTitled?: number;
  lastRunAt?:      number | null;
  enabled?:        boolean;
}

interface CategorizerStatus {
  isRunning?:           boolean;
  pendingCount?:        number;
  lifetimeCategorized?: number;
  enabled?:             boolean;
  sorter?: {
    isRunning?:            boolean;
    pendingCount?:         number;
    lifetimeFilesWritten?: number;
    enabled?:              boolean;
  } | null;
}

export function HubSettingsTab() {
  // Sensitivity controls (legacy — unchanged behaviour).
  const [policy, setPolicy] = useState<Policy>('always-prompt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whitelistSize, setWhitelistSize] = useState<number>(0);
  const [whitelistTtlMs, setWhitelistTtlMs] = useState<number>(30 * 60 * 1_000);
  const { size: localSize } = usePendingConfirms();

  // Pipeline controls — moved here on 2026-05-06.
  const [autoTitleEnabled, setAutoTitleEnabled]   = useState(false);
  const [autoTitleModel, setAutoTitleModel]       = useState('meta/llama-3.1-8b-instruct');
  const [autoTitleProvider, setAutoTitleProvider] = useState('NVIDIA');
  const [autoTitleHint, setAutoTitleHint]         = useState('');
  const autoTitleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoTitleStatus, setAutoTitleStatus]     = useState<AutoTitleStatus | null>(null);

  // `null` = unset (still follows auto-title); true/false = explicit override.
  const [categorizerEnabled, setCategorizerEnabled] = useState<boolean | null>(null);
  const [sorterEnabled, setSorterEnabled]           = useState<boolean | null>(null);
  const [categorizerHint, setCategorizerHint]       = useState('');
  const [sorterHint, setSorterHint]                 = useState('');
  const [pipelineStatus, setPipelineStatus]         = useState<CategorizerStatus | null>(null);

  // Categorizer LLM (separate from auto-title — defaults to a smarter 70B
  // model since classification quality matters more than raw throughput).
  const [categorizerModel, setCategorizerModel]       = useState('meta/llama-3.3-70b-instruct');
  const [categorizerProvider, setCategorizerProvider] = useState('NVIDIA');
  const [categorizerModelHint, setCategorizerModelHint] = useState('');
  const categorizerModelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Loaders ────────────────────────────────────────────────────────────────
  async function loadStatus() {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/context/status`);
      const j = await r.json();
      if (j?.success) {
        if (typeof j.sensitivityPolicy === 'string') setPolicy(j.sensitivityPolicy as Policy);
        if (typeof j.whitelistSize === 'number') setWhitelistSize(j.whitelistSize);
        if (typeof j.whitelistTtlMs === 'number') setWhitelistTtlMs(j.whitelistTtlMs);
        setPipelineStatus({
          isRunning:           !!j.isRunning,
          pendingCount:        j.pendingCount ?? 0,
          lifetimeCategorized: j.lifetimeCategorized ?? 0,
          enabled:             !!j.enabled,
          sorter:              j.sorter ?? null,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function loadAutoTitleStatus() {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/auto-title/status`);
      const j = await r.json();
      if (j?.success) setAutoTitleStatus(j);
    } catch { /* ignore */ }
  }

  async function loadConfig() {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/`);
      const d = (await r.json()) as { config?: { defaults?: Record<string, unknown> } };
      const at = (d.config?.defaults as Record<string, unknown>)?.autoTitle as Record<string, unknown> | undefined;
      if (at) {
        setAutoTitleEnabled(at.enabled === true);
        if (typeof at.model === 'string' && at.model) setAutoTitleModel(at.model);
        if (typeof at.provider === 'string' && at.provider) setAutoTitleProvider(at.provider);
      }
      const cc = (d.config?.defaults as Record<string, unknown>)?.contextCategorizer as Record<string, unknown> | undefined;
      if (cc && cc.enabled !== undefined) setCategorizerEnabled(cc.enabled === true);
      if (cc && typeof cc.model === 'string' && cc.model)       setCategorizerModel(cc.model);
      if (cc && typeof cc.provider === 'string' && cc.provider) setCategorizerProvider(cc.provider);
      const cs = (d.config?.defaults as Record<string, unknown>)?.contextSorter as Record<string, unknown> | undefined;
      if (cs && cs.enabled !== undefined) setSorterEnabled(cs.enabled === true);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    void loadStatus();
    void loadAutoTitleStatus();
    void loadConfig();
    const t = setInterval(() => {
      void loadStatus();
      void loadAutoTitleStatus();
    }, 7_000);
    return () => clearInterval(t);
  }, []);

  // ── Mutators ───────────────────────────────────────────────────────────────
  async function changePolicy(next: Policy) {
    if (next === policy) return;
    const url = _baseUrl();
    if (!url) return;
    const prev = policy;
    setPolicy(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${url}/v1/config/context/bridge`, {
        method:  'PATCH',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ sensitivityPolicy: next }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPolicy(prev); // rollback
    } finally {
      setBusy(false);
    }
  }

  async function lockEverything() {
    setBusy(true);
    try {
      clearAll();
      await loadStatus();
    } finally {
      setBusy(false);
    }
  }

  async function applyAutoTitle(enabled: boolean, model: string, provider: string) {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { autoTitle: { enabled, model: model.trim(), provider: provider.trim() } } }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      setAutoTitleHint(d.success
        ? (enabled ? '✓ Auto-title enabled' : '✓ Auto-title disabled')
        : `✗ ${d.error || 'failed'}`);
      setTimeout(() => setAutoTitleHint(''), 2500);
    } catch (e) {
      setAutoTitleHint(`✗ ${(e as Error).message}`);
    }
  }

  function scheduleAutoTitleSave(enabled: boolean, model: string, provider: string, immediate = false) {
    if (autoTitleTimer.current) clearTimeout(autoTitleTimer.current);
    if (immediate) { void applyAutoTitle(enabled, model, provider); return; }
    autoTitleTimer.current = setTimeout(() => { void applyAutoTitle(enabled, model, provider); }, 600);
  }

  async function applyCategorizerToggle(enabled: boolean) {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { contextCategorizer: { enabled } } }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      setCategorizerHint(d.success
        ? (enabled ? '✓ Categorizer enabled' : '✓ Categorizer disabled')
        : `✗ ${d.error || 'failed'}`);
      setTimeout(() => setCategorizerHint(''), 2500);
    } catch (e) {
      setCategorizerHint(`✗ ${(e as Error).message}`);
    }
  }

  async function applyCategorizerModel(model: string, provider: string) {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ defaults: { contextCategorizer: { model: model.trim(), provider: provider.trim() } } }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      setCategorizerModelHint(d.success ? '✓ Categorizer model saved' : `✗ ${d.error || 'failed'}`);
      setTimeout(() => setCategorizerModelHint(''), 2500);
    } catch (e) {
      setCategorizerModelHint(`✗ ${(e as Error).message}`);
    }
  }

  function scheduleCategorizerModelSave(model: string, provider: string, immediate = false) {
    if (categorizerModelTimer.current) clearTimeout(categorizerModelTimer.current);
    if (immediate) { void applyCategorizerModel(model, provider); return; }
    categorizerModelTimer.current = setTimeout(() => { void applyCategorizerModel(model, provider); }, 600);
  }

  async function applySorterToggle(enabled: boolean) {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/config/`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { contextSorter: { enabled } } }),
      });
      const d = (await r.json()) as { success?: boolean; error?: string };
      setSorterHint(d.success
        ? (enabled ? '✓ Sorter enabled' : '✓ Sorter disabled')
        : `✗ ${d.error || 'failed'}`);
      setTimeout(() => setSorterHint(''), 2500);
    } catch (e) {
      setSorterHint(`✗ ${(e as Error).message}`);
    }
  }

  const ttlMin = Math.round(whitelistTtlMs / 60_000);

  // Compact status badge — same shape as Preferences > System used to render.
  function StageBadge(p: { running?: boolean; pending?: number; lifetime?: number; lifetimeLabel: string }) {
    const cls = p.running ? 'at-status at-status--running' : 'at-status at-status--idle';
    const text = p.running
      ? `⏳ running — ${p.pending ?? 0} pending`
      : (p.pending ?? 0) > 0
        ? `${p.pending} pending`
        : (p.lifetime ?? 0) > 0
          ? `✓ ${p.lifetime} ${p.lifetimeLabel}`
          : 'idle';
    return <span className={cls}>{text}</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {error && (
        <div style={{
          padding: '8px 10px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: '12px',
        }}>
          {error}
        </div>
      )}

      {/* ── Auto-title parent gate ──────────────────────────────────────────── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h4 style={{ margin: 0 }}>🪪 Auto-title</h4>
          {autoTitleStatus && (
            <StageBadge
              running={autoTitleStatus.isRunning}
              pending={autoTitleStatus.pendingCount}
              lifetime={autoTitleStatus.lifetimeTitled}
              lifetimeLabel="titled"
            />
          )}
        </header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            id="hub-autotitle-enabled"
            checked={autoTitleEnabled}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            onChange={(e) => {
              setAutoTitleEnabled(e.target.checked);
              scheduleAutoTitleSave(e.target.checked, autoTitleModel, autoTitleProvider, true);
            }}
          />
          <label htmlFor="hub-autotitle-enabled" style={{ fontSize: '12.5px', color: 'var(--fg-dim, #aaa)' }}>
            Generate AI titles for new sessions (watchdog every 3 min, batches of 5)
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: autoTitleEnabled ? 1 : 0.45 }}>
          <label style={{ minWidth: 72, fontSize: '12px' }}>Provider</label>
          <input
            className="prefs-input"
            type="text"
            value={autoTitleProvider}
            placeholder="NVIDIA"
            style={{ maxWidth: 140 }}
            disabled={!autoTitleEnabled}
            onChange={(e) => {
              setAutoTitleProvider(e.target.value);
              scheduleAutoTitleSave(autoTitleEnabled, autoTitleModel, e.target.value);
            }}
            onBlur={(e) => scheduleAutoTitleSave(autoTitleEnabled, autoTitleModel, e.target.value, true)}
          />
          <label style={{ minWidth: 44, fontSize: '12px' }}>Model</label>
          <input
            className="prefs-input flex1"
            type="text"
            value={autoTitleModel}
            placeholder="meta/llama-3.1-8b-instruct"
            disabled={!autoTitleEnabled}
            onChange={(e) => {
              setAutoTitleModel(e.target.value);
              scheduleAutoTitleSave(autoTitleEnabled, e.target.value, autoTitleProvider);
            }}
            onBlur={(e) => scheduleAutoTitleSave(autoTitleEnabled, e.target.value, autoTitleProvider, true)}
          />
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
          {autoTitleHint || 'Manually renamed sessions are never overwritten. Provider must be configured with an API key.'}
          {autoTitleStatus && (autoTitleStatus.abandonedCount ?? 0) > 0 && (
            <span style={{ marginLeft: 6, color: '#e88' }}>
              · {autoTitleStatus.abandonedCount} session{autoTitleStatus.abandonedCount === 1 ? '' : 's'} abandoned after 3 failed retries
              — use "Force retry" in the Generator tab to try again.
            </span>
          )}
        </div>
      </section>

      {/* ── Categorizer LLM ─────────────────────────────────────────────────── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <header>
          <h4 style={{ margin: 0 }}>🧭 Categorizer model</h4>
        </header>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ minWidth: 72, fontSize: '12px' }}>Provider</label>
          <input
            className="prefs-input"
            type="text"
            value={categorizerProvider}
            placeholder="NVIDIA"
            style={{ maxWidth: 140 }}
            onChange={(e) => {
              setCategorizerProvider(e.target.value);
              scheduleCategorizerModelSave(categorizerModel, e.target.value);
            }}
            onBlur={(e) => scheduleCategorizerModelSave(categorizerModel, e.target.value, true)}
          />
          <label style={{ minWidth: 44, fontSize: '12px' }}>Model</label>
          <input
            className="prefs-input flex1"
            type="text"
            value={categorizerModel}
            placeholder="meta/llama-3.3-70b-instruct"
            onChange={(e) => {
              setCategorizerModel(e.target.value);
              scheduleCategorizerModelSave(e.target.value, categorizerProvider);
            }}
            onBlur={(e) => scheduleCategorizerModelSave(e.target.value, categorizerProvider, true)}
          />
        </div>
        <div style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
          {categorizerModelHint || 'Used by both session-categorizer and file-categorizer. Default is Llama-3.3-70B for better German + JSON adherence than the 8B auto-title model.'}
        </div>
      </section>

      {/* ── Pipeline stages — child toggles ────────────────────────────────── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <header>
          <h4 style={{ margin: 0 }}>Context pipeline stages</h4>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
            Run serially after Auto-title finishes: Categorizer → Sorter. Disable a stage to skip it
            without turning Auto-title off. Unchecked = forced off; checked = follows the parent gate.
          </p>
        </header>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: autoTitleEnabled ? 1 : 0.45 }}>
          <input
            type="checkbox"
            id="hub-categorizer-enabled"
            checked={categorizerEnabled === null ? autoTitleEnabled : categorizerEnabled}
            disabled={!autoTitleEnabled}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            onChange={(e) => {
              setCategorizerEnabled(e.target.checked);
              void applyCategorizerToggle(e.target.checked);
            }}
          />
          <label htmlFor="hub-categorizer-enabled" style={{ fontSize: '12.5px', color: 'var(--fg-dim, #aaa)', flex: 1 }}>
            🗂 Categorizer — assigns category, tags, sensitivity proposals
          </label>
          {pipelineStatus && (
            <StageBadge
              running={pipelineStatus.isRunning}
              pending={pipelineStatus.pendingCount}
              lifetime={pipelineStatus.lifetimeCategorized}
              lifetimeLabel="categorized"
            />
          )}
        </div>
        {categorizerHint && (
          <div style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>{categorizerHint}</div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: autoTitleEnabled ? 1 : 0.45 }}>
          <input
            type="checkbox"
            id="hub-sorter-enabled"
            checked={sorterEnabled === null ? autoTitleEnabled : sorterEnabled}
            disabled={!autoTitleEnabled}
            style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            onChange={(e) => {
              setSorterEnabled(e.target.checked);
              void applySorterToggle(e.target.checked);
            }}
          />
          <label htmlFor="hub-sorter-enabled" style={{ fontSize: '12.5px', color: 'var(--fg-dim, #aaa)', flex: 1 }}>
            📚 Sorter — builds the cross-link context graph + Markdown vault
          </label>
          {pipelineStatus?.sorter && (
            <StageBadge
              running={pipelineStatus.sorter.isRunning}
              pending={pipelineStatus.sorter.pendingCount}
              lifetime={pipelineStatus.sorter.lifetimeFilesWritten}
              lifetimeLabel="files"
            />
          )}
        </div>
        {sorterHint && (
          <div style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>{sorterHint}</div>
        )}
      </section>

      {/* ── Sensitivity ─────────────────────────────────────────────────────── */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <header>
          <h4 style={{ margin: 0 }}>Sensitivity</h4>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
            Controls when the 🔒 / ⚙️🔒 confirm-gate appears and how long
            confirmed items stay unlocked.
          </p>
        </header>

        <strong style={{ fontSize: '12.5px' }}>Confirmation policy</strong>
        <div role="radiogroup" aria-label="Sensitivity policy" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {POLICIES.map((p) => {
            const active = policy === p.id;
            return (
              <label
                key={p.id}
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
                  name="sensitivity-policy"
                  value={p.id}
                  checked={active}
                  disabled={busy}
                  onChange={() => void changePolicy(p.id)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <strong>
                    {p.label}
                    {p.warn && <span style={{ marginLeft: 6, color: '#e88' }}>⚠</span>}
                  </strong>
                  <span style={{ fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
                    {p.hint}
                  </span>
                </div>
              </label>
            );
          })}
        </div>

        <strong style={{ fontSize: '12.5px', marginTop: 8 }}>Active whitelist</strong>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 12px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 6,
          background: 'var(--bg-soft, #1f1f1f)',
        }}>
          <span style={{ fontSize: '13px' }}>
            {whitelistSize === 0
              ? 'Nothing unlocked.'
              : `${whitelistSize} item${whitelistSize === 1 ? '' : 's'} unlocked`}
          </span>
          {whitelistSize > 0 && (
            <span style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
              session-scoped entries expire after {ttlMin} min idle.
            </span>
          )}
          {localSize !== whitelistSize && (
            <span style={{ fontSize: '11.5px', color: '#d90', marginLeft: 'auto' }}>
              local mirror: {localSize}
            </span>
          )}
          <button
            type="button"
            onClick={() => void lockEverything()}
            disabled={busy || whitelistSize === 0}
            className="prefs-btn"
            style={{ marginLeft: 'auto', padding: '5px 10px' }}
          >
            🔒 Lock everything now
          </button>
        </div>
      </section>
    </div>
  );
}
