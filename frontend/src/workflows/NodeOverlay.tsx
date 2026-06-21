// NodeOverlay — click a workflow node → expanded editor (inputs/outputs/run).
// Replaces workflows/node.ts (deleted). Hosted in #node-overlay (yha.html).
//
// Open the overlay imperatively via openNodeOverlay(nodeId) — used by
// WorkflowEditor (node card click) and editor.ts (legacy double-click handler).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getGraphActions,
  getGraphState,
  useGraphStore,
  useAppStore,
} from '../stores/index.js';
import { save } from '../state.js';
import { triggers } from '../panels/triggers.js';
import { workflow } from './workflow.js';
import { chat } from '../chat.js';
import { openModelPicker } from '../pickers/ModelPicker.js';
import { api } from '../api.js';

interface DecisionLogic {
  leftOperand: string;
  operator: string;
  rightOperand?: string;
}

interface TriggerFieldDef {
  key: string;
  label: string;
  type: string;
  placeholder: string;
}

interface GraphNode {
  id: number | string;
  type: string;
  title?: string;
  command?: string;
  input?: string;
  output?: string;
  status: string;
  disabled?: boolean;
  inputMode?: 'upstream' | 'manual' | 'off';
  x: number;
  y: number;
  decisionLogic?: DecisionLogic;
  triggerConfig?: Record<string, unknown>;
  // Per-node agent config (chat nodes)
  nodeModel?: string;
  nodeModelProvider?: string;
  nodePreset?: string;
  nodeSystemMode?: 'replace' | 'append' | 'off';
  nodeSkillSet?: string;
  nodeToolSetPreset?: string;
  nodeCapVision?: boolean;
  nodeCapReasoning?: 'enabled' | 'disabled' | null;
  nodeCapTools?: 'on' | 'filter' | false;
  [key: string]: unknown;
}

const TRIGGER_TYPE_FIELDS: Record<string, TriggerFieldDef[]> = {
  timer: [{ key: 'duration', label: 'Interval (min)', type: 'number', placeholder: '30' }],
  daily: [{ key: 'time', label: 'Time of day', type: 'time', placeholder: '' }],
  website: [
    { key: 'url', label: 'URL', type: 'text', placeholder: 'https://...' },
    { key: 'interval', label: 'Check every (min)', type: 'number', placeholder: '5' },
  ],
  newdata: [
    { key: 'path', label: 'File / DB path', type: 'text', placeholder: '/data/feed.csv' },
    { key: 'interval', label: 'Poll every (min)', type: 'number', placeholder: '2' },
  ],
};

// ── Imperative open API for callers ────────────────────────────────────────

export function openNodeOverlay(nodeId: number | string): void {
  window.dispatchEvent(new CustomEvent('yha:open-node-overlay', { detail: { nodeId } }));
}

export function closeNodeOverlay(): void {
  window.dispatchEvent(new CustomEvent('yha:close-node-overlay'));
}

// Backwards-compat shim for code still importing { node } from './node'.
export const node = {
  init(): void { /* React component handles init via mount */ },
  openOverlay(nodeId: number | string): void { openNodeOverlay(nodeId); },
  close(): void { closeNodeOverlay(); },
};

// ── Per-node agent config (chat nodes) ────────────────────────────────────

function ChatAgentConfig({
  node: n,
  onBind,
}: {
  node: GraphNode;
  onBind: (key: string, value: unknown) => void;
}) {
  const presets = useAppStore((s) => s.sysPrompt.presets);
  const [configs, setConfigs] = useState<{ skillSets: Record<string, unknown>; toolSets: Record<string, unknown> }>({ skillSets: {}, toolSets: {} });
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    fetch(api.config.baseUrl + '/v1/config/')
      .then((r) => r.json())
      .then((d: { config?: { skillSets?: Record<string, unknown>; toolSets?: Record<string, unknown> } }) => {
        setConfigs({
          skillSets: d.config?.skillSets ?? {},
          toolSets: d.config?.toolSets ?? {},
        });
      })
      .catch(() => {});
  }, []);

  const sysMode = n.nodeSystemMode ?? 'off';
  const capVision = n.nodeCapVision ?? false;
  const capReasoning = n.nodeCapReasoning ?? null;
  const capTools = n.nodeCapTools ?? false;

  function openPicker() {
    if (!btnRef.current) return;
    openModelPicker(btnRef.current, (m) => {
      onBind('nodeModel', m.name);
      onBind('nodeModelProvider', m.provider ?? '');
    });
  }

  const modelLabel = n.nodeModel
    ? `${n.nodeModel}${n.nodeModelProvider ? ' · ' + n.nodeModelProvider : ''}`
    : '(session default)';

  return (
    <details className="noc-agent-config">
      <summary className="noc-agent-summary">Agent config{n.nodeModel ? ` · ${n.nodeModel}` : ''}</summary>
      <div className="noc-agent-body">
        <div className="noc-field">
          <label>Model</label>
          <div className="noc-model-wrap">
            <span className="noc-model-label">{modelLabel}</span>
            <button ref={btnRef} type="button" className="noc-model-pick-btn" title="Browse models" onClick={openPicker}>⊞</button>
            {n.nodeModel && (
              <button type="button" className="noc-model-clear-btn" title="Clear" onClick={() => { onBind('nodeModel', ''); onBind('nodeModelProvider', ''); }}>✕</button>
            )}
          </div>
        </div>
        <div className="noc-field">
          <label>System prompt</label>
          <div className="noc-field-header" style={{ marginBottom: 4 }}>
            <select
              value={n.nodePreset ?? ''}
              onChange={(e) => onBind('nodePreset', e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">(none)</option>
              {Object.keys(presets).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <div className="noc-input-mode" style={{ marginLeft: 6 }}>
              {(['off', 'append', 'replace'] as const).map((m) => (
                <button
                  key={m}
                  className={`noc-mode-btn${sysMode === m ? ' active' : ''}`}
                  onClick={() => onBind('nodeSystemMode', m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="noc-field">
          <label>Skill set</label>
          <select value={n.nodeSkillSet ?? ''} onChange={(e) => onBind('nodeSkillSet', e.target.value)}>
            <option value="">(none)</option>
            {Object.keys(configs.skillSets).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div className="noc-field">
          <label>Tool set</label>
          <select value={n.nodeToolSetPreset ?? ''} onChange={(e) => onBind('nodeToolSetPreset', e.target.value)}>
            <option value="">(none)</option>
            {Object.keys(configs.toolSets).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div className="noc-field">
          <label>Capabilities</label>
          <div className="noc-caps">
            <label className="noc-cap-toggle">
              <input type="checkbox" checked={capVision} onChange={(e) => onBind('nodeCapVision', e.target.checked)} />
              Vision
            </label>
            <select
              className="noc-cap-select"
              value={capReasoning ?? 'null'}
              onChange={(e) => {
                const v = e.target.value;
                onBind('nodeCapReasoning', v === 'null' ? null : v);
              }}
            >
              <option value="null">Reasoning default</option>
              <option value="enabled">Reasoning on</option>
              <option value="disabled">Reasoning off</option>
            </select>
            <select
              className="noc-cap-select"
              value={capTools === false ? 'false' : capTools}
              onChange={(e) => {
                const v = e.target.value;
                onBind('nodeCapTools', v === 'false' ? false : v);
              }}
            >
              <option value="false">Tools off</option>
              <option value="on">Tools on</option>
              <option value="filter">Tools filtered</option>
            </select>
          </div>
        </div>
      </div>
    </details>
  );
}

// ── Card content ───────────────────────────────────────────────────────────

function NodeCard({
  node: n,
  onClose,
  onTypeChanged,
  onTriggerTypeChanged,
}: {
  node: GraphNode;
  onClose: () => void;
  onTypeChanged: () => void;
  onTriggerTypeChanged: () => void;
}) {
  const isActive = !n.disabled;

  function bind(key: string, value: string) {
    if (key.includes('.')) {
      const [parent, child] = key.split('.');
      getGraphActions().updateNode(String(n.id), {
        [parent]: { ...((n[parent] as object) ?? {}), [child]: value },
      });
    } else {
      getGraphActions().updateNode(String(n.id), { [key]: value });
    }
    if (key === 'type') { onTypeChanged(); return; }
    save.graph();
  }

  function bindTrigger(key: string, raw: string, isNumber: boolean) {
    const val = isNumber ? Number(raw) : raw;
    const cur = getGraphActions().getNode(String(n.id)) as GraphNode | null;
    getGraphActions().updateNode(String(n.id), {
      triggerConfig: { ...(((cur?.triggerConfig) ?? {}) as object), [key]: val },
    });
    save.graph();
    if (key === 'triggerType') { onTriggerTypeChanged(); return; }
  }

  async function handleAction(act: string) {
    if (act === 'close') return onClose();
    if (act === 'delete') {
      getGraphActions().removeNode(String(n.id));
      save.graph();
      return onClose();
    }
    if (act === 'duplicate') {
      const { id: _id, input: _in, output: _out, status: _st, ...rest } = n;
      void _id; void _in; void _out; void _st;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getGraphActions().addNode({
        ...rest,
        x: n.x + 30,
        y: n.y + 30,
        input: '',
        output: '',
        status: 'idle',
      } as any);
      save.graph();
      return;
    }
    if (act === 'reset') {
      getGraphActions().updateNode(String(n.id), { input: '', output: '', status: 'idle' });
      save.graph();
      onTypeChanged(); // re-render to reflect cleared fields
      return;
    }
    if (act === 'run') {
      const current = getGraphActions().getNode(String(n.id)) as GraphNode | null;
      if (current?.status === 'running') {
        chat?.stopStream?.();
        return;
      }
      try {
        await workflow.runNode(String(n.id));
      } finally {
        // graphRevision update will trigger re-render via subscriber
      }
    }
  }

  // Decision logic (if-node) fields
  let decisionFields: React.ReactNode = null;
  if (n.type === 'if') {
    const logic: DecisionLogic = n.decisionLogic ?? {
      leftOperand: 'wordCount',
      operator: '>',
      rightOperand: '1',
    };
    const isUnary = logic.operator === 'isEmpty' || logic.operator === 'isNotEmpty';
    decisionFields = (
      <>
        <div className="noc-field">
          <label>Test</label>
          <select value={logic.leftOperand} onChange={(e) => bind('decisionLogic.leftOperand', e.target.value)}>
            <option value="content">Content</option>
            <option value="wordCount">Word Count</option>
            <option value="charCount">Char Count</option>
            <option value="lineCount">Line Count</option>
          </select>
        </div>
        <div className="noc-field">
          <label>Operator</label>
          <select value={logic.operator} onChange={(e) => bind('decisionLogic.operator', e.target.value)}>
            <option value=">">{'>'}</option>
            <option value="<">{'<'}</option>
            <option value=">=">{'>='}</option>
            <option value="<=">{'<='}</option>
            <option value="==">{'='}</option>
            <option value="!=">!=</option>
            <option value="contains">contains</option>
            <option value="notContains">not contains</option>
            <option value="isEmpty">is empty</option>
            <option value="isNotEmpty">is not empty</option>
          </select>
        </div>
        {!isUnary && (
          <div className="noc-field">
            <label>Value</label>
            <input
              value={logic.rightOperand ?? '1'}
              placeholder="Value to compare"
              onChange={(e) => bind('decisionLogic.rightOperand', e.target.value)}
            />
          </div>
        )}
      </>
    );
  }

  const chatConfigFields = n.type === 'chat'
    ? <ChatAgentConfig node={n} onBind={(k, v) => { getGraphActions().updateNode(String(n.id), { [k]: v }); save.graph(); }} />
    : null;

  // Trigger fields
  let triggerFields: React.ReactNode = null;
  if (n.type === 'trigger') {
    const tc = (n.triggerConfig ?? {}) as Record<string, unknown>;
    const ttype = (tc.triggerType as string) || 'timer';
    const fieldDefs = TRIGGER_TYPE_FIELDS[ttype] ?? [];
    const liveTrigger = triggers.getAll().find((t) => t._nodeId === n.id);
    triggerFields = (
      <>
        <div className="noc-field">
          <label>Trigger type</label>
          <select value={ttype} onChange={(e) => bindTrigger('triggerType', e.target.value, false)}>
            <option value="timer">Timer (interval)</option>
            <option value="daily">Daily (time of day)</option>
            <option value="website">Website change</option>
            <option value="newdata">New data (file/DB)</option>
          </select>
        </div>
        {fieldDefs.map((f) => (
          <div key={f.key} className="noc-field">
            <label>{f.label}</label>
            <input
              type={f.type}
              placeholder={f.placeholder}
              value={String(tc[f.key] ?? '')}
              onChange={(e) => bindTrigger(f.key, e.target.value, f.type === 'number')}
            />
          </div>
        ))}
        {liveTrigger ? (
          <div className={`trigger-node-status ${liveTrigger.enabled ? 'on' : 'off'}`}>
            ⚡ {liveTrigger.enabled ? 'Active' : 'Paused'} · fired {liveTrigger.execCount ?? 0}×
          </div>
        ) : (
          <div className="trigger-node-status off">⚡ Not registered yet — save the workflow.</div>
        )}
      </>
    );
  }

  const headerTitle =
    n.type === 'if' ? 'if'
    : n.type === 'trigger' ? '⚡ trigger'
    : (n.title || n.type);

  return (
    <>
      <div className="noc-header">
        <div>
          <h3>{headerTitle}</h3>
          <div className="dim">{n.id} · status: {n.status}</div>
        </div>
        <div className="header-controls">
          <label className="toggle-switch" title="Activate/Deactivate node">
            <input
              type="checkbox"
              className="toggle-input"
              checked={isActive}
              onChange={(e) => {
                getGraphActions().updateNode(String(n.id), { disabled: !e.target.checked });
                save.graph();
              }}
            />
            <span className="toggle-slider" />
          </label>
          <button className="noc-btn" onClick={() => handleAction('close')}>✕</button>
        </div>
      </div>
      <div className="noc-body">
        <div className="noc-field">
          <label>Title</label>
          <input
            value={n.type === 'if' ? 'if' : (n.title ?? '')}
            onChange={(e) => bind('title', e.target.value)}
          />
        </div>
        <div className="noc-field">
          <label>Type</label>
          <select value={n.type} onChange={(e) => bind('type', e.target.value)}>
            {['command', 'chat', 'agent', 'if', 'workflow', 'trigger'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        {decisionFields}
        {triggerFields}
        {n.type !== 'if' && n.type !== 'trigger' && (
          <div className="noc-field">
            <label>Command / Prompt</label>
            <textarea
              placeholder="# or plain text"
              value={n.command ?? ''}
              onChange={(e) => bind('command', e.target.value)}
            />
          </div>
        )}
        {chatConfigFields}
        {n.type !== 'trigger' && (
          <>
            <div className="noc-field">
              <div className="noc-field-header">
                <label>Input</label>
                <div className="noc-input-mode">
                  {(['upstream', 'manual', 'off'] as const).map((m) => {
                    const defaultMode = n.type === 'chat' ? 'upstream' : 'off';
                    const active = (n.inputMode ?? defaultMode) === m;
                    return (
                      <button
                        key={m}
                        className={`noc-mode-btn${active ? ' active' : ''}`}
                        onClick={() => bind('inputMode', m)}
                      >
                        {m === 'upstream' ? 'Upstream' : m === 'manual' ? 'Manual' : 'Off'}
                      </button>
                    );
                  })}
                </div>
              </div>
              {(() => {
                const defaultMode = n.type === 'chat' ? 'upstream' : 'off';
                const mode = n.inputMode ?? defaultMode;
                if (mode === 'manual') {
                  return (
                    <textarea
                      placeholder="manual input…"
                      value={n.input ?? ''}
                      onChange={(e) => bind('input', e.target.value)}
                    />
                  );
                }
                if (mode === 'upstream' && n.input) {
                  return <div className="noc-output noc-upstream-preview">{n.input}</div>;
                }
                return null;
              })()}
            </div>
            <div className="noc-field">
              <label>Output</label>
              <div className="noc-output">{n.output || '(no output yet)'}</div>
            </div>
          </>
        )}
      </div>
      <div className="noc-footer">
        <div className="actions">
          <button className="noc-btn danger" onClick={() => handleAction('delete')}>Delete</button>
          <button className="noc-btn" title="Clear input/output and reset status" onClick={() => handleAction('reset')}>Reset</button>
          <button className="noc-btn" onClick={() => handleAction('duplicate')}>Duplicate</button>
        </div>
        {n.type !== 'trigger' && (
          <button
            className={`noc-btn ${n.status === 'running' ? 'stop-btn is-running' : 'primary'}`}
            onClick={() => handleAction('run')}
          >
            {n.status === 'running' ? 'Stop ⏹' : 'Run ▶'}
          </button>
        )}
      </div>
    </>
  );
}

// ── Root component ────────────────────────────────────────────────────────

export function NodeOverlay() {
  const [activeId, setActiveId] = useState<number | string | null>(null);
  const activeNode = useGraphStore(useCallback((state) => {
    if (activeId == null) return null;
    return state.nodes.find((n) => String(n.id) === String(activeId)) ?? null;
  }, [activeId]));

  const close = useCallback(() => {
    setActiveId(null);
    if (getGraphState().selectedNodeId !== null) getGraphActions().setSelectedNodeId(null);
  }, []);

  const open = useCallback((nodeId: number | string) => {
    const n = getGraphActions().getNode(String(nodeId)) as GraphNode | null;
    if (!n) return;
    setActiveId(nodeId);
    getGraphActions().setSelectedNodeId(String(nodeId));
  }, []);

  // Listen for open/close events
  useEffect(() => {
    function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ nodeId: number | string }>).detail;
      if (detail?.nodeId != null) open(detail.nodeId);
    }
    function onClose() { close(); }
    window.addEventListener('yha:open-node-overlay', onOpen as EventListener);
    window.addEventListener('yha:close-node-overlay', onClose);
    return () => {
      window.removeEventListener('yha:open-node-overlay', onOpen as EventListener);
      window.removeEventListener('yha:close-node-overlay', onClose);
    };
  }, [open, close]);

  // Close if the active node disappears from the graph.
  useEffect(() => {
    if (activeId != null && activeNode == null) close();
  }, [activeId, activeNode, close]);

  // Escape closes
  useEffect(() => {
    if (activeId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeId, close]);

  // Toggle the overlay's hidden attribute on the static yha.html element
  useEffect(() => {
    const overlay = document.getElementById('node-overlay');
    if (!overlay) return;
    if (activeId != null) overlay.removeAttribute('hidden');
    else overlay.setAttribute('hidden', '');
  }, [activeId]);

  if (activeId == null) return null;
  if (!activeNode) return null;

  const card = document.getElementById('node-overlay-card');
  const overlay = document.getElementById('node-overlay');
  if (!card || !overlay) return null;

  // Click outside (on overlay backdrop) closes
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  return createPortal(
    <NodeCard
      node={activeNode}
      onClose={close}
      onTypeChanged={() => undefined}
      onTriggerTypeChanged={() => undefined}
    />,
    card,
  );
}
