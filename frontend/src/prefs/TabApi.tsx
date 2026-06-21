import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

interface KeyUsageEntry {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  calls: number;
}

interface PublicKey {
  id: string;
  label: string;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  usage: { byModel: Record<string, KeyUsageEntry> };
  totals: KeyUsageEntry;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return s;
  }
}

function fmt$(n: number): string {
  return '$' + (n || 0).toFixed(5);
}

function copyViaTextarea(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.contentEditable = 'true';
    ta.style.cssText =
      'position:fixed;left:0;top:0;width:2em;height:2em;padding:0;border:0;outline:0;box-shadow:none;background:transparent;color:transparent;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (copyViaTextarea(text)) return true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    window.prompt('Copy this key (Cmd/Ctrl+C):', text);
    return true;
  } catch {
    return false;
  }
}

function endpointBaseUrl(): string {
  return 'http://127.0.0.1:8444/v1';
}

function KeyCard({ k, onReload }: { k: PublicKey; onReload: () => void }) {
  const modelRows = Object.entries(k.usage.byModel)
    .sort((a, b) => b[1].cost - a[1].cost);

  async function handleDelete() {
    if (!confirm(`Delete key "${k.label}"? This cannot be undone — any client using it will lose access.`)) return;
    try {
      await fetch(api.config.baseUrl + '/v1/api-keys/' + encodeURIComponent(k.id), { method: 'DELETE' });
      onReload();
    } catch {
      alert('Failed to delete key.');
    }
  }

  async function handleResetUsage() {
    if (!confirm('Reset token/cost counters for this key?')) return;
    try {
      await fetch(api.config.baseUrl + '/v1/api-keys/' + encodeURIComponent(k.id) + '/reset-usage', { method: 'POST' });
      onReload();
    } catch {
      alert('Failed to reset usage.');
    }
  }

  return (
    <div className="prefs-api-key">
      <div className="prefs-api-key-head">
        <div>
          <div className="prefs-api-key-label">{k.label}</div>
          <div className="dim prefs-api-key-meta">
            <code>{k.hint}</code> · created {fmtDate(k.createdAt)}
            {' '}· last used {fmtDate(k.lastUsedAt)}
            {' '}· {fmtNum(k.totals.calls)} calls · {fmt$(k.totals.cost)} total
          </div>
        </div>
        <div className="prefs-api-key-actions">
          <button className="prefs-btn" onClick={handleResetUsage}>Reset usage</button>
          <button className="prefs-btn-danger" onClick={handleDelete}>Delete</button>
        </div>
      </div>
      {modelRows.length > 0 ? (
        <table className="prefs-table prefs-api-usage-table">
          <thead>
            <tr><th>Model</th><th>Calls</th><th>Prompt</th><th>Completion</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {modelRows.map(([model, u]) => (
              <tr key={model}>
                <td>{model}</td>
                <td className="dim">{fmtNum(u.calls)}</td>
                <td className="dim">{fmtNum(u.promptTokens)}</td>
                <td className="dim">{fmtNum(u.completionTokens)}</td>
                <td className="cost-val">{fmt$(u.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="dim prefs-api-empty-usage">No usage yet.</div>
      )}
    </div>
  );
}

interface RevealedToken {
  token: string;
  label: string;
  autoCopied: boolean;
}

export function TabApi() {
  const [keys, setKeys] = useState<PublicKey[] | null>(null);
  const [subscriptionMode, setSubscriptionMode] = useState<'sdk' | 'binary'>('sdk');
  const [loadError, setLoadError] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateLabel, setGenerateLabel] = useState('+ Generate key');
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [copyUrlLabel, setCopyUrlLabel] = useState('Copy');
  const [copyTokenLabel, setCopyTokenLabel] = useState('Copy');
  const baseUrl = endpointBaseUrl();
  const reloadRef = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    try {
      const [keysRes, prefsRes] = await Promise.all([
        fetch(api.config.baseUrl + '/v1/api-keys'),
        fetch(api.config.baseUrl + '/v1/api-keys/proxy-prefs'),
      ]);
      const keysData = (await keysRes.json()) as { keys: PublicKey[] };
      const prefs = (await prefsRes.json()) as { subscriptionMode: 'sdk' | 'binary' };
      setKeys(keysData.keys || []);
      setSubscriptionMode(prefs.subscriptionMode || 'sdk');
    } catch {
      setLoadError(true);
    }
  }, []);

  reloadRef.current = load as () => void;

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCopyUrl() {
    const ok = await copyToClipboard(baseUrl);
    setCopyUrlLabel(ok ? 'Copied ✓' : 'Copy failed');
    setTimeout(() => setCopyUrlLabel('Copy'), 1600);
  }

  async function handleModeChange(mode: 'sdk' | 'binary') {
    setSubscriptionMode(mode);
    try {
      await fetch(api.config.baseUrl + '/v1/api-keys/proxy-prefs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionMode: mode }),
      });
    } catch {
      alert('Failed to update mode.');
    }
  }

  async function handleGenerate() {
    const label = newLabel.trim() || 'Unnamed key';
    setGenerating(true);
    setGenerateLabel('Generating…');
    try {
      const r = await fetch(api.config.baseUrl + '/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const data = (await r.json()) as { key: PublicKey & { token: string } };
      const copied = await copyToClipboard(data.key.token);
      setRevealed({ token: data.key.token, label: data.key.label, autoCopied: copied });
      setNewLabel('');
      void load();
      setGenerateLabel(copied ? 'Generated + copied ✓' : 'Generated (copy below)');
      setTimeout(() => {
        setGenerating(false);
        setGenerateLabel('+ Generate key');
      }, 1800);
    } catch {
      alert('Failed to generate key.');
      setGenerating(false);
      setGenerateLabel('+ Generate key');
    }
  }

  async function handleCopyToken() {
    if (!revealed) return;
    const ok = await copyToClipboard(revealed.token);
    setCopyTokenLabel(ok ? 'Copied ✓' : 'Copy failed');
    setTimeout(() => setCopyTokenLabel('Copy'), 1600);
  }

  if (loadError) {
    return <div className="dim" style={{ padding: 10 }}>Failed to load API keys.</div>;
  }
  if (keys === null) {
    return <div className="prefs-loading">Loading API keys…</div>;
  }

  return (
    <>
      <h4 className="prefs-sec">OpenAI-compatible endpoint</h4>
      <div className="prefs-api-info">
        <div className="prefs-field-wrap">
          <label className="prefs-field-lbl">Base URL</label>
          <div className="prefs-api-url-row">
            <code className="prefs-api-url">{baseUrl}</code>
            <button className="prefs-btn" onClick={handleCopyUrl}>{copyUrlLabel}</button>
          </div>
        </div>
        <div className="dim prefs-api-hint">
          Loopback only — clients must run on this machine.<br />
          Configure e.g. <code>hermes config set model.base_url {baseUrl}</code>
          {' '}and use any key below as <code>api_key</code>. WorkOS-Auth wird auf diesem
          Port nicht angewandt; nur der <code>yha_</code>-Bearer-Key.
        </div>
      </div>

      <h4 className="prefs-sec">Anthropic Subscription routing</h4>
      <div className="prefs-api-mode">
        <label className="prefs-api-mode-row">
          <input
            type="radio"
            name="prefs-api-submode"
            value="sdk"
            checked={subscriptionMode === 'sdk'}
            onChange={() => handleModeChange('sdk')}
          />
          <span><strong>SDK</strong> <span className="dim">— full YHA setup (MCP, skills, claude_code preset, plugins)</span></span>
        </label>
        <label className="prefs-api-mode-row">
          <input
            type="radio"
            name="prefs-api-submode"
            value="binary"
            checked={subscriptionMode === 'binary'}
            onChange={() => handleModeChange('binary')}
          />
          <span><strong>Binary</strong> <span className="dim">— bare Claude binary spawn, no MCP / no skills (legacy)</span></span>
        </label>
      </div>

      <h4 className="prefs-sec">Generate new key</h4>
      <div className="prefs-api-newkey">
        <input
          className="prefs-input flex1"
          type="text"
          placeholder="Label (e.g. Hermes laptop)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleGenerate(); }}
        />
        <button className="prefs-btn" disabled={generating} onClick={() => void handleGenerate()}>
          {generateLabel}
        </button>
      </div>

      {revealed && (
        <div className="prefs-api-reveal">
          <div className="prefs-api-reveal-title">
            {revealed.autoCopied && <span className="prefs-api-reveal-copied">Copied to clipboard ✓</span>}{' '}
            New key for &quot;{revealed.label}&quot; — copy it now, you won&apos;t see it again.
          </div>
          <div className="prefs-api-reveal-row">
            <code className="prefs-api-token">{revealed.token}</code>
            <button className="prefs-btn" onClick={() => void handleCopyToken()}>{copyTokenLabel}</button>
            <button className="prefs-btn" onClick={() => setRevealed(null)}>Done</button>
          </div>
        </div>
      )}

      <h4 className="prefs-sec">Active keys</h4>
      <div className="prefs-api-keylist">
        {keys.length === 0 ? (
          <div className="dim" style={{ padding: '14px', textAlign: 'center' }}>No API keys yet. Generate one above.</div>
        ) : (
          keys.map((k) => (
            <KeyCard key={k.id} k={k} onReload={() => void load()} />
          ))
        )}
      </div>
    </>
  );
}
