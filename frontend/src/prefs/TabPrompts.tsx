import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const base = api.config.baseUrl;

function reloadSysPromptPresets() {
  window.dispatchEvent(new CustomEvent('yha:reload-sysprompt-presets'));
}

async function loadPresets(): Promise<Record<string, string>> {
  const r = await fetch(base + '/v1/config/');
  const d = await r.json() as { config?: { presetsMap?: Record<string, string> } };
  return d.config?.presetsMap || {};
}

export function TabPrompts() {
  const [presets, setPresets] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState('');
  const [newNameError, setNewNameError] = useState(false);

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  async function refresh(nextEditing?: string | null) {
    try {
      const p = await loadPresets();
      setPresets(p);
      if (nextEditing !== undefined) setEditing(nextEditing);
    } catch {
      // keep existing state on error
    }
    setLoading(false);
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  const handleAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    if (presets[name] !== undefined) {
      setNewNameError(true);
      setTimeout(() => setNewNameError(false), 1500);
      return;
    }
    await fetch(`${base}/v1/config/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    reloadSysPromptPresets();
    setNewName('');
    void refresh(name);
  }, [newName, presets]);

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Delete preset "${name}"?`)) return;
    const r = await fetch(`${base}/v1/config/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) return;
    reloadSysPromptPresets();
    void refresh(null);
  }, []);

  const handleTextChange = useCallback((name: string, value: string) => {
    setPresets((prev) => ({ ...prev, [name]: value }));
    setSaveStatus((prev) => ({ ...prev, [name]: 'saving…' }));
    if (debounceTimers.current[name]) clearTimeout(debounceTimers.current[name]);
    debounceTimers.current[name] = setTimeout(async () => {
      try {
        await fetch(`${base}/v1/config/presets/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: value }),
        });
        reloadSysPromptPresets();
        setSaveStatus((prev) => ({ ...prev, [name]: 'saved' }));
        setTimeout(() => setSaveStatus((prev) => {
          const next = { ...prev };
          if (next[name] === 'saved') delete next[name];
          return next;
        }), 1400);
      } catch {
        setSaveStatus((prev) => ({ ...prev, [name]: 'error' }));
      }
    }, 500);
  }, []);

  if (loading) return <div className="prefs-loading">Loading…</div>;

  const names = Object.keys(presets);

  return (
    <>
      <p className="dim" style={{ fontSize: '11px', margin: '0 0 10px' }}>
        These presets are available in the system-prompt override picker and as{' '}
        <code>Preset</code> in API calls. Changes are saved to <code>config.json</code>.
      </p>
      <div className="prefs-row" style={{ gap: '8px', marginBottom: '10px' }}>
        <input
          className="prefs-input"
          placeholder="New preset name…"
          style={{ flex: 1, maxWidth: '160px', borderColor: newNameError ? 'var(--danger)' : '' }}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
        />
        <button className="prefs-btn" onClick={() => void handleAdd()}>+ Add</button>
      </div>
      <div className="prefs-prompts-list">
        {names.map((name) => {
          const isEdit = editing === name;
          const status = saveStatus[name];
          return (
            <div className="prefs-prompt-row" key={name} data-name={name}>
              <div className="prefs-prompt-header">
                <span className="prefs-prompt-name">{name}</span>
                {isEdit && (
                  <span
                    className="prefs-live-status"
                    style={{ fontSize: '11px', color: 'var(--fg-dim)', marginLeft: 'auto', minWidth: '60px', textAlign: 'right' }}
                  >
                    {status || ''}
                  </span>
                )}
                <div style={{ display: 'flex', gap: '4px', marginLeft: isEdit ? '8px' : 'auto' }}>
                  <button
                    className="prefs-btn prefs-prompt-edit"
                    style={{ padding: '3px 8px', fontSize: '11px' }}
                    onClick={() => setEditing(isEdit ? null : name)}
                  >
                    {isEdit ? 'Done' : 'Edit'}
                  </button>
                  <button
                    className="prefs-btn prefs-btn-danger prefs-prompt-del"
                    style={{ padding: '3px 8px', fontSize: '11px' }}
                    onClick={() => void handleDelete(name)}
                  >
                    Del
                  </button>
                </div>
              </div>
              {isEdit
                ? (
                  <textarea
                    ref={textareaRef}
                    className="prefs-prompt-ta"
                    rows={4}
                    value={presets[name]}
                    onChange={(e) => handleTextChange(name, e.target.value)}
                  />
                )
                : (
                  <div className="prefs-prompt-preview">
                    {presets[name] || '(empty)'}
                  </div>
                )
              }
            </div>
          );
        })}
      </div>
    </>
  );
}
