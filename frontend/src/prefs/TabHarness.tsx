import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';
import { getAppActions, getAppState } from '../stores/index.js';
import { liveSave, type LiveSaveHandle } from '../util/liveSave.js';
import { useRegisterList } from '../host/useRegisterList.js';
import { registers, type HarnessTypeEntry } from '../host/keys.js';
import type { Entry } from '../host/registers.js';

const BASE_URL = () => api.config.baseUrl as string;

type HarnessType = Entry<HarnessTypeEntry>;

interface HarnessDetect {
  type: string;
  label: string;
  category: 'subscription' | 'single-account';
  installed: boolean;
  binaryPath: string | null;
  configDirHint: string;
  configDirExists: boolean;
}

function setHarnessSelection(type: string, label: string): void {
  const storageKey = type === 'codex' ? 'yha.codexInstance' : 'yha.harnessInstance';
  if (type === 'codex') getAppActions().setCodexInstance(label || '');
  else getAppActions().setHarnessInstance(label || '');
  if (label) localStorage.setItem(storageKey, label);
  else localStorage.removeItem(storageKey);
  getAppActions().bumpHarnessRevision();
}

function copyToClipboard(text: string, btn: HTMLElement): void {
  const orig = btn.textContent;
  const flash = (ok: boolean): void => {
    btn.textContent = ok ? '✓ Copied!' : '✗ Failed';
    setTimeout(() => { btn.textContent = orig!; }, 1800);
  };
  navigator.clipboard.writeText(text).then(() => flash(true)).catch(() => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flash(ok);
    } catch { flash(false); }
  });
}

interface SubscriptionSectionProps {
  t: HarnessType;
  config: Record<string, unknown>;
  detect: HarnessDetect | undefined;
  base: string;
  onRenderAll: () => void;
}

function SubscriptionSection({ t, config, detect, base, onRenderAll }: SubscriptionSectionProps) {
  const instancesKey = `${t.type}Instances`;
  // REST path: claude uses the legacy /v1/config/instances/:label, all
  // others use /v1/config/<type>-instances/:label (codex-instances,
  // grok-instances, …).
  const instancesPath = t.type === 'claude' ? 'instances' : `${t.type}-instances`;
  const instances = (config[instancesKey] || []) as Array<{ label: string; configDir: string } & Record<string, string | undefined>>;
  const activeStored = (t.type === 'codex' ? getAppState().codexInstance : getAppState().harnessInstance) || '';
  const activeLabel = instances.some((i) => i.label === activeStored) ? activeStored : (instances[0]?.label || '');
  const defs = (config['defaults'] || {}) as Record<string, unknown>;
  const initBin = String((config as Record<string, unknown>)[t.configBinKey] || defs[t.configBinKey] || localStorage.getItem(t.binStorageKey) || '');

  const [binVal, setBinVal] = useState(initBin);
  const statusRef = useRef<HTMLSpanElement>(null);
  const binLiveRef = useRef<LiveSaveHandle | null>(null);

  const [newLabel, setNewLabel] = useState('');
  const [newDir, setNewDir] = useState('');
  const [newBin, setNewBin] = useState('');

  useEffect(() => {
    binLiveRef.current = liveSave({
      endpoint: base + '/v1/config/',
      statusEl: statusRef.current,
      buildBody: (p) => (t.configBinKey === 'claudeBin' ? { claudeBin: p[t.configBinKey] } : { defaults: p }),
      errorLabel: `${t.label} bin save failed`,
    });
    return () => { binLiveRef.current?.flush(); };
  }, [base, t]);

  function handleBinChange(v: string) {
    setBinVal(v);
    localStorage.setItem(t.binStorageKey, v);
    binLiveRef.current?.patch({ [t.configBinKey]: v });
  }

  async function handleFetchBin() {
    try {
      const r = await fetch(base + '/v1/config/');
      const d = await r.json() as { config?: Record<string, unknown> };
      const cfg = (d.config || {}) as Record<string, unknown>;
      const cfgDefs = (cfg['defaults'] || {}) as Record<string, unknown>;
      const v = String(cfg[t.configBinKey] || cfgDefs[t.configBinKey] || '');
      setBinVal(v);
      localStorage.setItem(t.binStorageKey, v);
    } catch { /* ignore */ }
  }

  async function handleAdd() {
    const label = newLabel.trim();
    const dir = newDir.trim();
    if (!label || !dir) return;
    const body: Record<string, string> = { configDir: dir };
    if (newBin.trim()) body[t.configBinKey] = newBin.trim();
    await fetch(`${base}/v1/config/${instancesPath}/${encodeURIComponent(label)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    getAppActions().bumpHarnessRevision();
    const stored = t.type === 'codex' ? getAppState().codexInstance : getAppState().harnessInstance;
    if (!stored) setHarnessSelection(t.type, label);
    setNewLabel('');
    setNewDir('');
    setNewBin('');
    onRenderAll();
  }

  async function handleDel(label: string) {
    if (!confirm(`Remove instance "${label}"?`)) return;
    await fetch(`${base}/v1/config/${instancesPath}/${encodeURIComponent(label)}`, { method: 'DELETE' });
    const stored = t.type === 'codex' ? getAppState().codexInstance : getAppState().harnessInstance;
    if (stored === label) setHarnessSelection(t.type, '');
    getAppActions().bumpHarnessRevision();
    onRenderAll();
  }

  function handleUse(label: string) {
    setHarnessSelection(t.type, label);
    onRenderAll();
  }

  function handleAuth(inst: { label: string; configDir: string } & Record<string, string | undefined>, btnEl: HTMLElement) {
    const dir = inst.configDir;
    // Cross-platform isolated-home derivation: ~\.claude on Windows
    // ends with backslash too, not just /.claude. Match both.
    const isolatedHome = /[\\/]\.claude$|[\\/]\.codex$|[\\/]\.grok$/.test(dir)
      ? dir.replace(/[\\/]\.(claude|codex|grok)$/, '')
      : dir;
    const perBin = inst[t.configBinKey] || '';
    // Authentication runs on the bridge host, so prefer the bridge's current
    // executable detection over saved paths. Saved config can legitimately be
    // copied from another machine (for example /home/user/... on macOS), and
    // using it here produced a copy-paste command that could never run. Keep
    // the configured values as fallbacks for hosts where detection is absent.
    const bin = detect?.binaryPath || perBin || binVal.trim() || '';
    // serverPlatform comes from the bridge's GET /v1/config/ (process.platform).
    // Templates use it to pick bash vs PowerShell syntax.
    const cmd = t.authCmdTemplate(bin, isolatedHome, dir, (config['serverPlatform'] as string) || '');
    copyToClipboard(cmd, btnEl);
  }

  return (
    <div className="prefs-harness-section" style={{ border: '1px solid var(--stroke)', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
      <h4 className="prefs-sec" style={{ marginTop: '0' }}>
        {t.label} <span className="prefs-mini-chip">Subscription · multi-account</span>
      </h4>
      <div className="prefs-row">
        <input
          className="prefs-input flex1"
          type="text"
          value={binVal}
          onChange={(e) => handleBinChange(e.target.value)}
          onBlur={() => binLiveRef.current?.flush()}
          placeholder={`Path to ${t.label.toLowerCase()} binary…`}
        />
        <button className="prefs-btn" onClick={handleFetchBin}>Fetch from server</button>
        <span ref={statusRef} className="prefs-live-status" style={{ fontSize: '11px', color: 'var(--fg-dim)', minWidth: '60px' }} />
      </div>
      <div className="prefs-hint" style={{ marginBottom: '10px' }}>
        Multiple accounts: each instance uses its own config directory + isolated <code>HOME</code>.
      </div>
      <div className="prefs-row" style={{ gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
        <input className="prefs-input" placeholder="Label…" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} style={{ flex: 1, minWidth: '100px', maxWidth: '120px' }} />
        <input className="prefs-input" placeholder="Config dir (e.g. /home/user2/.claude)…" value={newDir} onChange={(e) => setNewDir(e.target.value)} style={{ flex: 2, minWidth: '200px' }} />
        <input className="prefs-input" placeholder="Optional: per-instance binary path…" value={newBin} onChange={(e) => setNewBin(e.target.value)} style={{ flex: 2, minWidth: '200px' }} />
        <button className="prefs-btn" onClick={handleAdd}>+ Add</button>
      </div>
      <div>
        {!instances.length
          ? <div className="dim" style={{ fontSize: '12px' }}>No {t.label} instances configured yet.</div>
          : instances.map((inst) => {
              const isActive = activeLabel === inst.label;
              const perInstanceBin = inst[t.configBinKey] || '';
              return (
                <div key={inst.label} className="prefs-provider-row" style={{ alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '13px' }}>{inst.label}</div>
                    <div className="dim" style={{ fontSize: '11px' }}>{inst.configDir}</div>
                    {perInstanceBin && <div className="dim" style={{ fontSize: '10px' }}>bin: {perInstanceBin}</div>}
                  </div>
                  {isActive
                    ? <span className="prefs-mini-chip">Active</span>
                    : <button className="prefs-btn" onClick={() => handleUse(inst.label)} style={{ padding: '3px 8px', fontSize: '11px' }}>Use</button>
                  }
                  <button
                    className="prefs-btn"
                    onClick={(e) => handleAuth(inst, e.currentTarget as HTMLElement)}
                    style={{ padding: '3px 8px', fontSize: '11px' }}
                    title="Copy auth command to clipboard"
                  >
                    📋 Auth
                  </button>
                  <button className="prefs-btn prefs-btn-danger" onClick={() => handleDel(inst.label)} style={{ padding: '3px 8px', fontSize: '11px' }}>Del</button>
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

interface SingleAccountSectionProps {
  t: HarnessType;
  config: Record<string, unknown>;
  detect: HarnessDetect | undefined;
  base: string;
}

function SingleAccountSection({ t, config, detect, base }: SingleAccountSectionProps) {
  const defs = (config['defaults'] || {}) as Record<string, unknown>;
  const dirKey = `${t.type}ConfigDir`;
  const [binVal, setBinVal] = useState(String(defs[t.configBinKey] || (detect?.binaryPath ?? '')));
  const [dirVal, setDirVal] = useState(String(defs[dirKey] || (detect?.configDirHint ?? '')));
  const statusRef = useRef<HTMLDivElement>(null);
  const saverRef = useRef<LiveSaveHandle | null>(null);

  useEffect(() => {
    saverRef.current = liveSave({
      endpoint: base + '/v1/config/',
      statusEl: statusRef.current,
      buildBody: (p) => ({ defaults: p }),
      errorLabel: `${t.label} save failed`,
    });
    return () => { saverRef.current?.flush(); };
  }, [base, t]);

  function handleBinChange(v: string) {
    setBinVal(v);
    localStorage.setItem(t.binStorageKey, v);
    saverRef.current?.patch({ [t.configBinKey]: v });
  }

  function handleDirChange(v: string) {
    setDirVal(v);
    saverRef.current?.patch({ [dirKey]: v });
  }

  return (
    <div className="prefs-harness-section" style={{ border: '1px solid var(--stroke)', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
      <h4 className="prefs-sec" style={{ marginTop: '0' }}>
        {t.label} <span className="prefs-mini-chip">Single-account</span>
      </h4>
      <div className="prefs-hint" style={{ marginBottom: '8px' }}>
        Single binary + one config dir.{' '}
        {t.type === 'aider'
          ? 'Aider reads API keys from the API Keys tab — no separate auth login needed.'
          : 'No multi-account support; one configuration is enough.'}
      </div>
      <div className="prefs-row">
        <label style={{ fontSize: '12px', color: 'var(--fg-dim)', minWidth: '80px' }}>Binary</label>
        <input
          className="prefs-input flex1"
          type="text"
          value={binVal}
          onChange={(e) => handleBinChange(e.target.value)}
          onBlur={() => saverRef.current?.flush()}
          placeholder={`Path to ${t.label.toLowerCase()} binary…`}
        />
      </div>
      <div className="prefs-row" style={{ marginTop: '8px' }}>
        <label style={{ fontSize: '12px', color: 'var(--fg-dim)', minWidth: '80px' }}>Config dir</label>
        <input
          className="prefs-input flex1"
          type="text"
          value={dirVal}
          onChange={(e) => handleDirChange(e.target.value)}
          onBlur={() => saverRef.current?.flush()}
          placeholder={`e.g. ~/.${t.type}`}
        />
      </div>
      <div className="prefs-hint" ref={statusRef} style={{ marginTop: '6px' }} />
    </div>
  );
}

interface HarnessToggleProps {
  types: ReadonlyArray<HarnessType>;
  detect: Record<string, HarnessDetect>;
  enabled: Set<string>;
  base: string;
  onRenderAll: () => void;
}

function HarnessToggles({ types, detect, enabled, base, onRenderAll }: HarnessToggleProps) {
  async function handleToggle(type: string, checked: boolean) {
    const next = new Set(enabled);
    if (checked) next.add(type); else next.delete(type);
    try {
      await fetch(base + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { enabledHarnessTypes: [...next] } }),
      });
    } catch { /* ignore */ }
    onRenderAll();
  }

  return (
    <div id="prefs-harness-toggles" className="prefs-harness-toggles" style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '18px' }}>
      {types.map((t) => {
        const d = detect[t.type];
        const isInstalled = !!d?.installed;
        const isEnabled = enabled.has(t.type);
        const cat = t.category === 'subscription' ? 'Subscription' : 'Single-account';
        return (
          <label key={t.type} className="prefs-harness-toggle" style={{ display: 'flex', alignItems: 'center', gap: '8px', border: '1px solid var(--stroke)', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              className="prefs-harness-type-toggle"
              data-type={t.type}
              checked={isEnabled}
              onChange={(e) => handleToggle(t.type, e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontWeight: 600, fontSize: '13px' }}>{t.label}</span>
              <span style={{ fontSize: '11px', color: 'var(--fg-dim)' }}>
                {cat}{' '}
                {isInstalled
                  ? <span className="prefs-mini-chip" style={{ background: 'rgba(80,200,120,.18)', color: '#7fd49a' }}>Detected</span>
                  : <span className="prefs-mini-chip" style={{ background: 'rgba(255,150,0,.18)', color: '#e8a754' }}>Not detected</span>
                }
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function TabHarness() {
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [detect, setDetect] = useState<Record<string, HarnessDetect>>({});
  const [rev, setRev] = useState(0);
  const [refreshStatus, setRefreshStatus] = useState<string>('');
  const [refreshing, setRefreshing] = useState(false);

  const base = BASE_URL();

  const harnessTypes = useRegisterList(registers.harnessTypes);

  const loadAll = useCallback(async () => {
    let cfg: Record<string, unknown> = {};
    let det: Record<string, HarnessDetect> = {};
    try {
      const [cfgResp, detResp] = await Promise.all([
        fetch(base + '/v1/config/').then((r) => r.json() as Promise<{ config?: Record<string, unknown> }>),
        fetch(base + '/v1/harness/detect').then((r) => r.json() as Promise<{ harnesses?: Record<string, HarnessDetect> }>).catch(() => ({ harnesses: {} })),
      ]);
      cfg = cfgResp.config || {};
      det = detResp.harnesses || {};
    } catch { /* ignore */ }
    setConfig(cfg);
    setDetect(det);
  }, [base]);

  // Manually-triggered re-detect that ALSO rewrites stored binary paths
  // when they're broken (e.g. Claude Code auto-updated to a new version).
  // Hits POST /v1/harness/refresh; backend returns the new detect map plus
  // a list of config changes it applied, which we surface as the status
  // line so the user knows what got updated.
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshStatus('Refreshing…');
    try {
      const resp = await fetch(base + '/v1/harness/refresh', { method: 'POST' });
      const data = await resp.json() as {
        success?: boolean;
        harnesses?: Record<string, HarnessDetect>;
        changes?: Array<{ where: string; old: string; new: string }>;
        error?: string;
      };
      if (!data.success) throw new Error(data.error || 'refresh failed');
      const n = data.changes?.length || 0;
      if (n === 0) {
        setRefreshStatus('All binary paths still valid — nothing to update.');
      } else {
        setRefreshStatus(`Updated ${n} path${n > 1 ? 's' : ''}: ${data.changes!.map((c) => c.where).join(', ')}`);
      }
      // Trigger a full reload so SubscriptionSection / SingleAccountSection
      // see the new config + detect data.
      setRev((r) => r + 1);
    } catch (e) {
      setRefreshStatus('Refresh failed: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshStatus(''), 8000);
    }
  }, [base]);

  useEffect(() => { loadAll(); }, [loadAll, rev]);

  function triggerRenderAll() {
    setRev((r) => r + 1);
  }

  const defs = (config['defaults'] || {}) as Record<string, unknown>;
  const enabledList = Array.isArray(defs['enabledHarnessTypes'])
    ? (defs['enabledHarnessTypes'] as string[])
    : ['claude', 'codex', 'grok'];
  const enabled = new Set(enabledList);
  const noEnabled = [...enabled].length === 0;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <h4 className="prefs-sec" style={{ margin: 0 }}>Enabled Harness Types</h4>
        <button
          type="button"
          className="prefs-btn"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Re-scan PATH and standard install dirs for claude / codex / aider / pi. Updates config.json wherever the stored binary path no longer exists (e.g. Claude Code auto-updated to a new version)."
          style={{ fontSize: '12px', padding: '4px 10px' }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh from server'}
        </button>
      </div>
      {refreshStatus && (
        <div className="prefs-hint" style={{ marginBottom: '6px', color: refreshStatus.startsWith('Refresh failed') ? 'var(--err)' : 'var(--fg-dim)' }}>
          {refreshStatus}
        </div>
      )}
      <div className="prefs-hint" style={{ marginBottom: '8px' }}>
        Tick the harnesses you want to use. Subscription-based harnesses (Claude Code, Codex)
        support multiple accounts via separate config directories. Single-account harnesses
        (Aider, Pi) need only one binary path + config dir.
      </div>

      <HarnessToggles
        types={harnessTypes}
        detect={detect}
        enabled={enabled}
        base={base}
        onRenderAll={triggerRenderAll}
      />

      {harnessTypes.map((t) => (
        t.configSection
          ? <t.configSection key={`cfg-${t.type}`} config={config} base={base} onRenderAll={triggerRenderAll} enabled={enabled.has(t.type)} />
          : null
      ))}

      <div id="prefs-harness-sections">
        {noEnabled
          ? <div className="dim" style={{ fontSize: '12px', padding: '12px 0' }}>Enable a harness type above to configure it.</div>
          : harnessTypes.filter((t) => enabled.has(t.type)).map((t) =>
              t.category === 'subscription'
                ? <SubscriptionSection key={t.type} t={t} config={config} detect={detect[t.type]} base={base} onRenderAll={triggerRenderAll} />
                : <SingleAccountSection key={t.type} t={t} config={config} detect={detect[t.type]} base={base} />
            )
        }
      </div>
    </>
  );
}
