// TriggersPanel — trigger UI components used by TriggersPicker popover.
// Pure UI; data + SSE + CRUD live in panels/triggers.ts. Subscribes to
// 'yha:triggers-changed' for snapshot/fire/create/update/delete updates.

import { useCallback, useEffect, useState } from 'react';
import { triggers, type Trigger, type TriggerConfig } from './triggers.js';

interface FormFieldDef {
  key: string;
  label: string;
  type: string;
  placeholder?: string;
  hint?: string;
}

const FORM_DEFS: Record<string, FormFieldDef[]> = {
  timer: [
    {
      key: 'duration',
      label: 'Interval (minutes)',
      type: 'number',
      placeholder: '5',
      hint: 'Server-side heartbeat — fires every N minutes even when browser is closed.',
    },
  ],
  daily: [
    {
      key: 'time',
      label: 'Time of day',
      type: 'time',
      hint: 'Fires once per day at this time (server local time).',
    },
  ],
  website: [
    { key: 'url', label: 'URL to monitor', type: 'text', placeholder: 'https://example.com' },
    {
      key: 'interval',
      label: 'Check every (minutes)',
      type: 'number',
      placeholder: '5',
      hint: 'Server polls the URL. Fires when page content changes.',
    },
  ],
  newdata: [
    { key: 'path', label: 'File path (server)', type: 'text', placeholder: '/data/feed.csv' },
    {
      key: 'interval',
      label: 'Poll every (minutes)',
      type: 'number',
      placeholder: '2',
      hint: 'Uses fs.watch + stat polling. Fires when file changes.',
    },
  ],
  calendar: [
    { key: 'calendarId', label: 'Calendar ID', type: 'text', placeholder: 'primary' },
    { key: 'eventQuery', label: 'Event keyword', type: 'text', placeholder: 'meeting' },
  ],
};

async function fetchWorkflowNames(): Promise<string[]> {
  try {
    const base = (localStorage.getItem('yha.apiBase') || '').replace(/\/$/, '');
    const r = await fetch(base + '/v1/workflows/');
    if (!r.ok) return [];
    const d = await r.json() as { success: boolean; workflows?: Array<{ name: string }> };
    return (d.workflows || []).map((w) => w.name);
  } catch {
    return [];
  }
}

function nextFireLabel(t: Trigger): string | null {
  if (!t.nextFire || !t.enabled) return null;
  const diff = Math.max(0, Math.round((new Date(t.nextFire).getTime() - Date.now()) / 1000));
  return diff < 60 ? `${diff}s` : `${Math.round(diff / 60)}m`;
}

function TriggerEntry({
  trigger,
  selected,
  onSelect,
  onToggle,
}: {
  trigger: Trigger;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const nf = nextFireLabel(trigger);
  return (
    <div
      className={`trigger-entry${!trigger.enabled ? ' disabled' : ''}${selected ? ' selected' : ''}`}
      onClick={onSelect}
    >
      <span className={`trigger-type-badge ${trigger.type}`}>{trigger.type}</span>
      <div className="trigger-entry-info" title={trigger.workflowId || ''}>
        {trigger.workflowId || '—'}
      </div>
      {nf && (
        <div className="trigger-entry-next" title={`Next fire: ${trigger.nextFire}`}>
          {nf}
        </div>
      )}
      <button
        className={`trigger-entry-toggle${trigger.enabled ? ' on' : ''}`}
        title={trigger.enabled ? 'Disable' : 'Enable'}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      />
    </div>
  );
}

function TriggerForm({
  trigger,
  onSaved,
  onDeleted,
  onCreated,
  onCancel,
}: {
  trigger: Trigger | null;
  onSaved: (t: Trigger) => void;
  onDeleted: () => void;
  onCreated: (t: Trigger) => void;
  onCancel: () => void;
}) {
  void onCancel; // reserved for future cancel-button on new form
  const [type, setType] = useState(trigger?.type || 'timer');
  const [workflowId, setWorkflowId] = useState(trigger?.workflowId || '');
  const [config, setConfig] = useState<TriggerConfig>({ ...(trigger?.config || {}) });
  const [mdOpen, setMdOpen] = useState(false);
  const [mdContent, setMdContent] = useState('');
  const [workflows, setWorkflows] = useState<string[]>([]);
  const fieldDefs = FORM_DEFS[type] || [];

  useEffect(() => {
    fetchWorkflowNames().then(setWorkflows);
  }, []);

  // Reset form fields when trigger changes (so Edit form refreshes)
  useEffect(() => {
    setType(trigger?.type || 'timer');
    setWorkflowId(trigger?.workflowId || '');
    setConfig({ ...(trigger?.config || {}) });
    setMdOpen(false);
  }, [trigger?.id]);

  function setField(key: string, value: string, isNumber: boolean) {
    setConfig((c) => ({ ...c, [key]: isNumber ? Number(value) : value }));
  }

  async function save() {
    if (!type || !workflowId) return;
    const cleanConfig: TriggerConfig = {};
    fieldDefs.forEach((f) => { cleanConfig[f.key] = config[f.key]; });
    if (trigger) {
      const updated = await triggers.update(trigger.id, type, cleanConfig, workflowId);
      if (updated) onSaved(updated);
    } else {
      const created = await triggers.add(type, cleanConfig, workflowId);
      if (created) onCreated(created);
    }
  }

  async function del() {
    if (!trigger) return;
    await triggers.remove(trigger.id);
    onDeleted();
  }

  async function fire() {
    if (!trigger) return;
    await triggers.fireManual(trigger.id);
  }

  async function toggleMd() {
    if (!trigger) return;
    if (mdOpen) { setMdOpen(false); return; }
    const content = await triggers.loadMd(trigger.id);
    setMdContent(content);
    setMdOpen(true);
  }

  async function saveMd() {
    if (!trigger) return;
    await triggers.saveMd(trigger.id, mdContent);
    setMdOpen(false);
  }

  return (
    <>
      <div className="trigger-form-actions">
        <button className="trigger-save-btn" title={trigger ? 'Save' : 'Create'} onClick={save}>
          {trigger ? '✓' : '＋'}
        </button>
        {trigger && (
          <>
            <button className="trigger-fire-btn" title="Fire now" onClick={fire}>▶</button>
            <button className="trigger-md-btn" title="Edit notes (.md)" onClick={toggleMd}>✎</button>
            {!trigger.standard && (
              <button className="trigger-delete-btn" title="Delete" onClick={del}>✕</button>
            )}
          </>
        )}
      </div>
      <div className="trigger-field">
        <label>Type</label>
        <select value={type} onChange={(e) => { setType(e.target.value); setConfig({}); }}>
          {Object.keys(FORM_DEFS).map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </div>
      <div className="trigger-field">
        <label>Workflow</label>
        <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
          <option value="">— select —</option>
          {workflows.length === 0 && <option value="">No saved workflows</option>}
          {workflows.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      </div>
      <div>
        {fieldDefs.map((f) => (
          <div key={f.key} className="trigger-field">
            <label>{f.label}</label>
            <input
              type={f.type}
              placeholder={f.placeholder ?? ''}
              value={config[f.key] != null ? String(config[f.key]) : ''}
              onChange={(e) => setField(f.key, e.target.value, f.type === 'number')}
            />
            {f.hint && <div className="field-hint">{f.hint}</div>}
          </div>
        ))}
      </div>
      {trigger && (
        <>
          <div className="trigger-field">
            <label>Executions</label>
            <div style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
              {trigger.execCount || 0} times
              {trigger.lastFired && ` · last: ${new Date(trigger.lastFired).toLocaleString()}`}
            </div>
          </div>
          <div className="trigger-field">
            <label>Next fire</label>
            <div style={{ fontSize: 13, color: 'var(--fg-dim)' }}>
              {trigger.nextFire ? new Date(trigger.nextFire).toLocaleString() : '—'}
            </div>
          </div>
          {mdOpen && (
            <div style={{ marginTop: 12 }}>
              <textarea
                rows={14}
                style={{
                  width: '100%',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  background: 'var(--bg-deep)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: 8,
                  boxSizing: 'border-box',
                  resize: 'vertical',
                }}
                value={mdContent}
                onChange={(e) => setMdContent(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="trigger-save-btn" onClick={saveMd}>Save .md</button>
                <button className="trigger-md-btn" onClick={() => setMdOpen(false)}>✕</button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ── List pane ──────────────────────────────────────────────────────────────

function ListPane({
  list,
  selectedId,
  onSelect,
  onToggle,
  onNew,
}: {
  list: Trigger[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <>
      {list.length === 0 ? (
        <div className="trigger-list-empty" style={{ whiteSpace: 'pre-line' }}>
          {'No triggers yet.\nClick + to add one.'}
        </div>
      ) : (
        list.map((t) => (
          <TriggerEntry
            key={t.id}
            trigger={t}
            selected={selectedId === t.id}
            onSelect={() => onSelect(t.id)}
            onToggle={() => onToggle(t.id)}
          />
        ))
      )}
      <button className="trigger-add-btn" onClick={onNew}>+ New Trigger</button>
    </>
  );
}

// ── Panel content — renders inline (used by TriggersPicker) ──────────────

export function TriggersPanelContent() {
  const [list, setList] = useState<Trigger[]>(triggers.getAll());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const onChange = () => setList([...triggers.getAll()]);
    window.addEventListener('yha:triggers-changed', onChange);
    return () => window.removeEventListener('yha:triggers-changed', onChange);
  }, []);

  // Re-render countdown timers every 30s
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Drop selection if the trigger was deleted
  useEffect(() => {
    if (selectedId && !list.find((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [list, selectedId]);

  const onSelect = useCallback((id: string) => {
    setSelectedId((cur) => (cur === id ? null : id));
    setCreating(false);
  }, []);

  const onToggle = useCallback((id: string) => {
    triggers.toggle(id);
  }, []);

  const onNew = useCallback(() => {
    setSelectedId(null);
    setCreating(true);
  }, []);

  const selected = selectedId ? list.find((t) => t.id === selectedId) ?? null : null;
  const showForm = !!selected || creating;

  return (
    <div className="trigger-panes">
      <div className="trigger-list-pane">
        <ListPane
          list={list}
          selectedId={selectedId}
          onSelect={onSelect}
          onToggle={onToggle}
          onNew={onNew}
        />
      </div>
      <div className="trigger-form-pane">
        {showForm ? (
          <TriggerForm
            key={selected?.id ?? '__new__'}
            trigger={selected}
            onSaved={(t) => { setSelectedId(t.id); setCreating(false); }}
            onDeleted={() => { setSelectedId(null); setCreating(false); }}
            onCreated={(t) => { setSelectedId(t.id); setCreating(false); }}
            onCancel={() => { setCreating(false); setSelectedId(null); }}
          />
        ) : list.length > 0 ? (
          <div style={{ color: 'var(--fg-mute)', fontSize: 12, padding: '20px 0' }}>
            Select a trigger to edit, or click <strong>+ New Trigger</strong>.
          </div>
        ) : null}
      </div>
    </div>
  );
}
