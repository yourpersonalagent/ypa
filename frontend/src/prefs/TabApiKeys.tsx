import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';

type ApiStyle = 'anthropic' | 'openai' | 'google';

interface Provider {
  name: string;
  has_key?: boolean;
  key_hint?: string;
  endpoint?: string;
  api_style?: ApiStyle;
  env_key?: string;
  fetch_live?: boolean;
  preset_id?: string;
  hidden?: boolean;
}

interface ProviderPreset {
  id: string;
  display_name: string;
  default_name: string;
  endpoint: string;
  api_style: ApiStyle;
  env_key: string;
  fetch_live: boolean;
  key_link?: string;
  notes?: string;
  active?: boolean;
}

const API_STYLE_LABELS: Record<ApiStyle, string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI-compatible',
  google: 'Google Gemini API',
};

const API_STYLE_TOOLTIPS: Record<ApiStyle, string> = {
  anthropic: 'Native Anthropic /v1/messages format',
  openai: 'Works with OpenAI, OpenRouter, Ollama, LM Studio, NVIDIA, vLLM, etc.',
  google: "Google's generateContent format",
};

type SaveStatus = '' | 'saving…' | 'saved' | 'error';

function useDebounce(fn: () => void, ms: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  }, [fn, ms]);
}

function ProviderRow({
  p,
  preset,
  onChanged,
  onDeleted,
}: {
  p: Provider;
  preset?: ProviderPreset;
  onChanged: (oldName: string, updated: Provider) => void;
  onDeleted: (name: string) => void;
}) {
  const [keyVal, setKeyVal] = useState('');
  const [nameVal, setNameVal] = useState(p.name);
  const [endpointVal, setEndpointVal] = useState(p.endpoint || '');
  const [apiStyle, setApiStyle] = useState<ApiStyle>(p.api_style || 'openai');
  const [envKeyVal, setEnvKeyVal] = useState(p.env_key || '');
  const [fetchLive, setFetchLive] = useState(!!p.fetch_live);
  const [hidden, setHidden] = useState(!!p.hidden);
  const [status, setStatus] = useState<SaveStatus>('');
  const [fetchNowStatus, setFetchNowStatus] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const endpointInputRef = useRef<HTMLInputElement>(null);

  // Keep local state synced when the parent reloads providers (e.g. after a
  // concurrent save on another field). Skip resetting a field that the user is
  // actively typing in — otherwise the debounced endpoint save would clobber
  // an in-progress name edit (and vice-versa), causing cursor jumps.
  useEffect(() => {
    if (document.activeElement !== nameInputRef.current) setNameVal(p.name);
    if (document.activeElement !== endpointInputRef.current) setEndpointVal(p.endpoint || '');
    setApiStyle(p.api_style || 'openai');
    setEnvKeyVal(p.env_key || '');
    setFetchLive(!!p.fetch_live);
    setHidden(!!p.hidden);
  }, [p.name, p.endpoint, p.api_style, p.env_key, p.fetch_live, p.hidden]);

  const showSaved = useCallback(() => {
    setStatus('saved');
    setTimeout(() => setStatus(''), 1400);
  }, []);

  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setStatus('saving…');
      const oldName = p.name;
      try {
        const r = await fetch(api.config.baseUrl + '/v1/config/providers/' + encodeURIComponent(oldName), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (data?.provider) onChanged(oldName, data.provider);
        showSaved();
        return data;
      } catch {
        setStatus('error');
        return null;
      }
    },
    [p.name, showSaved, onChanged]
  );

  const flushEndpoint = useCallback(() => {
    const v = endpointVal.trim();
    if (v && v !== (p.endpoint || '')) void save({ endpoint: v });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointVal, p.endpoint]);
  const debouncedEndpoint = useDebounce(flushEndpoint, 500);

  function handleEndpointInput(e: React.ChangeEvent<HTMLInputElement>) {
    setEndpointVal(e.target.value);
    debouncedEndpoint();
  }

  function handleNameBlur() {
    const v = nameVal.trim();
    if (!v || v === p.name) {
      setNameVal(p.name);
      return;
    }
    void save({ name: v });
  }

  function handleEnvKeyBlur() {
    const v = envKeyVal.trim();
    if (v === (p.env_key || '')) return;
    void save({ env_key: v });
  }

  function handleKeyBlur() {
    const v = keyVal.trim();
    if (!v) return;
    void save({ api_key: v }).then(() => setKeyVal(''));
  }

  function handleApiStyleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value as ApiStyle;
    setApiStyle(v);
    void save({ api_style: v });
  }

  function handleFetchLiveChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.checked;
    setFetchLive(v);
    void save({ fetch_live: v });
  }

  function handleHiddenChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.checked;
    setHidden(v);
    void save({ hidden: v });
  }

  async function handleDelete() {
    setStatus('saving…');
    try {
      const r = await fetch(api.config.baseUrl + '/v1/config/providers/' + encodeURIComponent(p.name) + '?force=1', {
        method: 'DELETE',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      onDeleted(p.name);
    } catch {
      setStatus('error');
    }
  }

  const keyPlaceholder = p.has_key
    ? `•••• set (${p.key_hint}) — enter new to update`
    : envKeyVal
      ? `Reads from $${envKeyVal} — enter to override`
      : 'No key — enter to add';

  return (
    <div className="prefs-provider-row" style={{ flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          ref={nameInputRef}
          className="prefs-input"
          type="text"
          value={nameVal}
          style={{ fontWeight: 600, fontSize: 13, maxWidth: 220 }}
          onChange={(e) => setNameVal(e.target.value)}
          onBlur={handleNameBlur}
        />
        {p.preset_id ? (
          <span className="prefs-mini-chip" title={`Loaded from ${p.preset_id} preset`}>
            preset · {p.preset_id}
          </span>
        ) : (
          <span className="prefs-mini-chip" style={{ color: 'var(--fg-mute)', borderColor: 'var(--stroke)' }}>custom</span>
        )}
        {preset?.key_link && (
          <a
            href={preset.key_link}
            target="_blank"
            rel="noopener noreferrer"
            title={`Get an API key from ${preset.display_name}`}
            style={{ fontSize: 11, color: 'var(--fg-mute)', textDecoration: 'underline' }}
          >
            Get API key ↗
          </a>
        )}
        <span style={{ flex: 1 }} />
        <span className="prefs-live-status" style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          {status}
        </span>
        <button
          type="button"
          className="prefs-btn"
          onClick={() => setConfirmingDelete((s) => !s)}
          title={confirmingDelete ? 'Cancel' : 'Remove provider'}
          style={{ fontSize: 11 }}
        >
          {confirmingDelete ? 'Cancel' : 'Remove'}
        </button>
        {confirmingDelete && (
          <button
            type="button"
            className="prefs-btn"
            onClick={handleDelete}
            style={{ fontSize: 11, color: 'var(--danger, #c33)' }}
            title="Permanently remove this provider (config + model pricing)"
          >
            Confirm delete
          </button>
        )}
      </div>

      <form className="prefs-provider-fields" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="prefs-field-wrap" style={{ flex: '1 1 200px' }}>
            <label className="prefs-field-lbl" title={API_STYLE_TOOLTIPS[apiStyle]}>API Style</label>
            <select
              className="prefs-input"
              value={apiStyle}
              onChange={handleApiStyleChange}
              title={API_STYLE_TOOLTIPS[apiStyle]}
            >
              <option value="anthropic">{API_STYLE_LABELS.anthropic}</option>
              <option value="openai">{API_STYLE_LABELS.openai}</option>
              <option value="google">{API_STYLE_LABELS.google}</option>
            </select>
          </div>
          <div className="prefs-field-wrap" style={{ flex: '2 1 280px' }}>
            <label className="prefs-field-lbl">Endpoint</label>
            <input
              ref={endpointInputRef}
              className="prefs-input"
              type="text"
              value={endpointVal}
              placeholder="https://api.example.com/v1"
              onChange={handleEndpointInput}
              onBlur={flushEndpoint}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="prefs-field-wrap" style={{ flex: '2 1 280px' }}>
            <label className="prefs-field-lbl">API Key</label>
            <input
              className="prefs-input"
              type="password"
              autoComplete="off"
              value={keyVal}
              placeholder={keyPlaceholder}
              onChange={(e) => setKeyVal(e.target.value)}
              onBlur={handleKeyBlur}
            />
          </div>
          <div className="prefs-field-wrap" style={{ flex: '1 1 180px' }}>
            <label className="prefs-field-lbl" title="Environment variable that holds this key. Leave empty for local servers without auth.">
              Env var
            </label>
            <input
              className="prefs-input"
              type="text"
              value={envKeyVal}
              placeholder="(no auth)"
              onChange={(e) => setEnvKeyVal(e.target.value)}
              onBlur={handleEnvKeyBlur}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--fg-mute)', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={fetchLive} onChange={handleFetchLiveChange} />
            Fetch live models from <code>/models</code>
          </label>
          {fetchLive && (
            <button
              type="button"
              className="prefs-btn"
              disabled={fetchNowStatus === 'fetching…'}
              style={{ fontSize: 11 }}
              onClick={async () => {
                setFetchNowStatus('fetching…');
                try {
                  const r = await fetch(api.config.baseUrl + '/v1/config/providers/' + encodeURIComponent(p.name) + '/fetch-models', { method: 'POST' });
                  const data = await r.json();
                  if (!r.ok || !data.success) throw new Error(data.error || 'HTTP ' + r.status);
                  setFetchNowStatus('fetched ' + data.count + ' models');
                  setTimeout(() => setFetchNowStatus(''), 3000);
                } catch (e: any) {
                  setFetchNowStatus('error: ' + (e?.message || String(e)));
                  setTimeout(() => setFetchNowStatus(''), 4000);
                }
              }}
            >
              {fetchNowStatus === 'fetching…' ? 'Fetching…' : 'Fetch now'}
            </button>
          )}
          {fetchNowStatus && fetchNowStatus !== 'fetching…' && (
            <span style={{ color: fetchNowStatus.startsWith('error') ? 'var(--danger, #c33)' : 'var(--fg-mute)' }}>
              {fetchNowStatus}
            </span>
          )}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={hidden} onChange={handleHiddenChange} />
            Hide (keep config, exclude from routing)
          </label>
        </div>
      </form>
    </div>
  );
}

function AddProviderPanel({
  presets,
  onAdded,
}: {
  presets: ProviderPreset[];
  onAdded: (p: Provider) => void;
}) {
  const [mode, setMode] = useState<'preset' | 'custom'>('preset');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [customName, setCustomName] = useState('');
  const [customEndpoint, setCustomEndpoint] = useState('http://localhost:8080/v1');
  const [customStyle, setCustomStyle] = useState<ApiStyle>('openai');
  const [customEnvKey, setCustomEnvKey] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [fetchLive, setFetchLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const inactivePresets = presets.filter((p) => !p.active);

  async function handleLoadPreset() {
    if (!selectedPreset) return;
    const preset = presets.find((p) => p.id === selectedPreset);
    if (!preset) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(api.config.baseUrl + '/v1/config/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset_id: preset.id }),
      });
      const data = await r.json();
      if (!r.ok || !data.success) throw new Error(data.error || 'HTTP ' + r.status);
      onAdded(data.provider);
      setSelectedPreset('');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddCustom() {
    if (!customName.trim() || !customEndpoint.trim()) {
      setError('name and endpoint are required');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        name: customName.trim(),
        endpoint: customEndpoint.trim(),
        api_style: customStyle,
        env_key: customEnvKey.trim(),
        fetch_live: fetchLive,
      };
      if (customKey.trim()) body.api_key = customKey.trim();
      const r = await fetch(api.config.baseUrl + '/v1/config/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || !data.success) throw new Error(data.error || 'HTTP ' + r.status);
      onAdded(data.provider);
      setCustomName('');
      setCustomKey('');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const selectedPresetData = presets.find((p) => p.id === selectedPreset);

  return (
    <div
      style={{
        padding: 10,
        marginBottom: 16,
        border: '1px solid var(--stroke)',
        borderRadius: 6,
        background: 'var(--bg2)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          type="button"
          className="prefs-btn"
          onClick={() => setMode('preset')}
          style={{ fontWeight: mode === 'preset' ? 600 : 400 }}
        >
          Load from preset
        </button>
        <button
          type="button"
          className="prefs-btn"
          onClick={() => setMode('custom')}
          style={{ fontWeight: mode === 'custom' ? 600 : 400 }}
        >
          Custom provider
        </button>
      </div>

      {mode === 'preset' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="prefs-field-wrap" style={{ flex: '1 1 260px' }}>
            <label className="prefs-field-lbl">Preset</label>
            <select
              className="prefs-input"
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
            >
              <option value="">— pick a preset —</option>
              {inactivePresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} ({API_STYLE_LABELS[p.api_style]})
                </option>
              ))}
            </select>
            {selectedPresetData?.notes && (
              <span style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 4 }}>
                {selectedPresetData.notes}
              </span>
            )}
            {selectedPresetData?.key_link && (
              <a
                href={selectedPresetData.key_link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 4, textDecoration: 'underline' }}
              >
                Get an API key from {selectedPresetData.display_name} ↗
              </a>
            )}
          </div>
          <button type="button" className="prefs-btn" onClick={handleLoadPreset} disabled={busy || !selectedPreset}>
            {busy ? 'Loading…' : 'Load'}
          </button>
        </div>
      )}

      {mode === 'custom' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div className="prefs-field-wrap" style={{ flex: '1 1 200px' }}>
              <label className="prefs-field-lbl">Name</label>
              <input
                className="prefs-input"
                type="text"
                value={customName}
                placeholder="e.g. My Local Mixtral"
                onChange={(e) => setCustomName(e.target.value)}
              />
            </div>
            <div className="prefs-field-wrap" style={{ flex: '1 1 160px' }}>
              <label className="prefs-field-lbl">API Style</label>
              <select className="prefs-input" value={customStyle} onChange={(e) => setCustomStyle(e.target.value as ApiStyle)}>
                <option value="openai">{API_STYLE_LABELS.openai}</option>
                <option value="anthropic">{API_STYLE_LABELS.anthropic}</option>
                <option value="google">{API_STYLE_LABELS.google}</option>
              </select>
            </div>
            <div className="prefs-field-wrap" style={{ flex: '2 1 260px' }}>
              <label className="prefs-field-lbl">Endpoint</label>
              <input
                className="prefs-input"
                type="text"
                value={customEndpoint}
                onChange={(e) => setCustomEndpoint(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div className="prefs-field-wrap" style={{ flex: '2 1 280px' }}>
              <label className="prefs-field-lbl">API Key (optional)</label>
              <input
                className="prefs-input"
                type="password"
                autoComplete="off"
                value={customKey}
                placeholder="Leave blank for local / no-auth servers"
                onChange={(e) => setCustomKey(e.target.value)}
              />
            </div>
            <div className="prefs-field-wrap" style={{ flex: '1 1 180px' }}>
              <label className="prefs-field-lbl">Env var (optional)</label>
              <input
                className="prefs-input"
                type="text"
                value={customEnvKey}
                placeholder="auto-generated if blank"
                onChange={(e) => setCustomEnvKey(e.target.value)}
              />
            </div>
          </div>
          <label style={{ fontSize: 11, color: 'var(--fg-mute)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={fetchLive} onChange={(e) => setFetchLive(e.target.checked)} />
            Fetch live models from <code>/models</code>
          </label>
          <div>
            <button type="button" className="prefs-btn" onClick={handleAddCustom} disabled={busy}>
              {busy ? 'Adding…' : 'Add provider'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--danger, #c33)', fontSize: 11, marginTop: 8 }}>{error}</div>
      )}
    </div>
  );
}

export function TabApiKeys() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [error, setError] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [confRes, presetsRes] = await Promise.all([
        fetch(api.config.baseUrl + '/v1/config/'),
        fetch(api.config.baseUrl + '/v1/config/provider-presets'),
      ]);
      const conf = await confRes.json();
      const presetsData = await presetsRes.json();
      setProviders((conf.config?.providers || []) as Provider[]);
      setPresets((presetsData.presets || []) as ProviderPreset[]);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleAdded = useCallback(
    (p: Provider) => {
      setProviders((cur) => (cur ? [...cur, p] : [p]));
      // Reload presets so the dropdown's `active` flag updates
      fetch(api.config.baseUrl + '/v1/config/provider-presets')
        .then((r) => r.json())
        .then((d) => setPresets((d.presets || []) as ProviderPreset[]))
        .catch(() => {});
    },
    []
  );

  const handleChanged = useCallback(
    (oldName: string, updated: Provider) => {
      setProviders((cur) => {
        if (!cur) return cur;
        const idx = cur.findIndex((p) => p.name === oldName);
        if (idx >= 0) {
          const next = [...cur];
          next[idx] = { ...next[idx], ...updated };
          return next;
        }
        return cur;
      });
    },
    []
  );

  const handleDeleted = useCallback(
    (name: string) => {
      setProviders((cur) => (cur ? cur.filter((p) => p.name !== name) : cur));
      fetch(api.config.baseUrl + '/v1/config/provider-presets')
        .then((r) => r.json())
        .then((d) => setPresets((d.presets || []) as ProviderPreset[]))
        .catch(() => {});
    },
    []
  );

  if (error) {
    return <div className="dim" style={{ padding: 10 }}>Failed to load config from server.</div>;
  }
  if (providers === null) {
    return <div className="prefs-loading">Loading…</div>;
  }

  return (
    <>
      <h4 className="prefs-sec">Providers</h4>
      <AddProviderPanel presets={presets} onAdded={handleAdded} />
      {providers.length === 0 && (
        <div className="dim" style={{ padding: 10 }}>
          No providers configured. Load one from a preset above, or add a custom provider.
        </div>
      )}
      {providers.map((p) => {
        // Match preset by preset_id first; fall back to default_name (case-insensitive)
        // so legacy providers configured before the preset system still get the key_link.
        const preset =
          (p.preset_id && presets.find((pr) => pr.id === p.preset_id)) ||
          presets.find((pr) => pr.default_name.toLowerCase() === p.name.toLowerCase()) ||
          undefined;
        return (
          <ProviderRow
            key={p.name}
            p={p}
            preset={preset}
            onChanged={handleChanged}
            onDeleted={handleDeleted}
          />
        );
      })}
    </>
  );
}
