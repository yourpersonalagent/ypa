import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';
import { commands } from '../commands.js';
import { liveSave, type LiveSaveHandle } from '../util/liveSave.js';
import { renderMetaSection } from './meta-section.js';

const BASE_URL = () => api.config.baseUrl as string;
const DEFAULT_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'Task'];

const ITER_FIELDS = [
  { key: 'agent_max_iter', label: 'Agent max iterations', hint: 'Max tool-call loops for the OpenAI-compatible non-streaming agent (proxy for Claude Code). Default: 25.', default: 25, min: 1, max: 200 },
  { key: 'tool_max_iter', label: 'Tool max iterations (streaming)', hint: 'Max tool-call loops for all direct streaming calls (OpenAI / Gemini). Higher = deeper autonomous work. Default: 8.', default: 8, min: 1, max: 100 },
  { key: 'tool_result_limit', label: 'Tool result limit (chars fed to model)', hint: 'Max characters of each tool result sent back to the model per iteration. Higher = model sees more context. Default: 8000.', default: 8000, min: 500, max: 100000 },
  { key: 'tool_preview_limit', label: 'Tool result preview (chars shown in chat)', hint: 'Max characters of tool output shown in the chat UI. Does not affect what the model sees. Default: 200.', default: 200, min: 50, max: 5000 },
];

interface ToolGroup {
  id?: string;
  items?: { toolName?: string; server?: string }[];
}

interface ConfigData {
  config?: {
    defaults?: Record<string, unknown>;
    agents?: Record<string, unknown>;
    toolSets?: Record<string, string[]>;
  };
}

interface ToolsResponse {
  groups?: ToolGroup[];
}

interface ToolSetEditorProps {
  name: string;
  tools: string[];
  allTools: string[];
  base: string;
  onDone: () => void;
  onDelete: (name: string) => void;
}

function ToolSetEditor({ name, tools, allTools, base, onDone, onDelete }: ToolSetEditorProps) {
  const selected = new Set(tools);
  const statusRef = useRef<HTMLSpanElement>(null);
  const liveRef = useRef<LiveSaveHandle | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    liveRef.current = liveSave({
      endpoint: `${base}/v1/config/toolSets/${encodeURIComponent(name)}`,
      method: 'PUT',
      debounceMs: 250,
      statusEl: statusRef.current,
      errorLabel: 'Save tool set failed',
    });
    return () => { liveRef.current?.flush(); };
  }, [base, name]);

  function collectChecked(): string[] {
    if (!gridRef.current) return [];
    return [...gridRef.current.querySelectorAll<HTMLInputElement>('.prefs-ts-tool:checked')]
      .map((el) => el.dataset.tool!);
  }

  function handleChange() {
    liveRef.current?.patch({ tools: collectChecked() });
  }

  return (
    <div className="prefs-prompt-row" data-name={name}>
      <div className="prefs-prompt-header">
        <span className="prefs-prompt-name">{name}</span>
        <span ref={statusRef} className="prefs-live-status" style={{ fontSize: '11px', color: 'var(--fg-dim)', marginLeft: 'auto', minWidth: '60px', textAlign: 'right' }} />
        <div style={{ display: 'flex', gap: '4px', marginLeft: '8px' }}>
          <button className="prefs-btn prefs-ts-edit" onClick={onDone} style={{ padding: '3px 8px', fontSize: '11px' }}>Done</button>
          <button className="prefs-btn prefs-btn-danger prefs-ts-del" onClick={() => onDelete(name)} style={{ padding: '3px 8px', fontSize: '11px' }}>Del</button>
        </div>
      </div>
      <div ref={gridRef} className="prefs-over-grid" data-ts={name}>
        {allTools.map((t) => (
          <label key={t} className="prefs-over-item">
            <input type="checkbox" className="prefs-ts-tool" data-tool={t} defaultChecked={selected.has(t)} onChange={handleChange} />
            <span>{t}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

interface ToolSetRowProps {
  name: string;
  tools: string[];
  allTools: string[];
  base: string;
  onDelete: (name: string) => void;
  onEdited: () => void;
}

function ToolSetRow({ name, tools, allTools, base, onDelete, onEdited }: ToolSetRowProps) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <ToolSetEditor
        name={name}
        tools={tools}
        allTools={allTools}
        base={base}
        onDone={() => { setEditing(false); onEdited(); }}
        onDelete={onDelete}
      />
    );
  }

  return (
    <div className="prefs-prompt-row" data-name={name}>
      <div className="prefs-prompt-header">
        <span className="prefs-prompt-name">{name}</span>
        <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          <button className="prefs-btn prefs-ts-edit" onClick={() => setEditing(true)} style={{ padding: '3px 8px', fontSize: '11px' }}>Edit</button>
          <button className="prefs-btn prefs-btn-danger prefs-ts-del" onClick={() => onDelete(name)} style={{ padding: '3px 8px', fontSize: '11px' }}>Del</button>
        </div>
      </div>
      <div className="prefs-prompt-preview">{(tools || []).join(', ') || '(empty)'}</div>
    </div>
  );
}

interface OverFilterGroupProps {
  label: string;
  toolNames: string[];
  groupKey: string;
  selectedTools: Set<string>;
  onChange: (tool: string, checked: boolean) => void;
  onAll: (groupKey: string) => void;
  onNone: (groupKey: string) => void;
}

function OverFilterGroup({ label, toolNames, groupKey, selectedTools, onChange, onAll, onNone }: OverFilterGroupProps) {
  if (!toolNames.length) return null;
  return (
    <div className="prefs-over-block" style={{ marginBottom: '8px' }}>
      <div className="prefs-over-group-header">
        <div className="prefs-over-title">{label}</div>
        <div className="prefs-over-group-btns">
          <button className="prefs-btn prefs-over-group-all" data-group={groupKey} onClick={() => onAll(groupKey)} style={{ padding: '2px 7px', fontSize: '11px' }}>All</button>
          <button className="prefs-btn prefs-over-group-none" data-group={groupKey} onClick={() => onNone(groupKey)} style={{ padding: '2px 7px', fontSize: '11px' }}>None</button>
        </div>
      </div>
      <div className="prefs-over-grid" data-group={groupKey}>
        {toolNames.map((name) => (
          <label key={name} className="prefs-over-item">
            <input
              type="checkbox"
              className="prefs-over-tool"
              data-tool={name}
              checked={selectedTools.has(name)}
              onChange={(e) => onChange(name, e.target.checked)}
            />
            <span>{name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

interface MetaSectionHostProps {
  kind: 'tool';
}

function MetaSectionHost({ kind }: MetaSectionHostProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) renderMetaSection(ref.current, kind);
  }, [kind]);
  return <div ref={ref} />;
}

export function TabTools() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [useAgents, setUseAgents] = useState(true);
  const [subAgentNames, setSubAgentNames] = useState<string[]>([]);
  const [iterValues, setIterValues] = useState<Record<string, number>>({});
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set(DEFAULT_TOOLS));

  const [ccTools, setCcTools] = useState<string[]>([]);
  const [codexTools, setCodexTools] = useState<string[]>([]);
  const [mcpByServer, setMcpByServer] = useState<Map<string, string[]>>(new Map());
  const [allNonMcpTools, setAllNonMcpTools] = useState<string[]>([]);

  const [toolSets, setToolSets] = useState<Record<string, string[]>>({});
  const [newTsName, setNewTsName] = useState('');
  const [newTsNameError, setNewTsNameError] = useState(false);

  const iterStatusRef = useRef<HTMLSpanElement>(null);
  const filterStatusRef = useRef<HTMLSpanElement>(null);
  const iterLiveRef = useRef<LiveSaveHandle | null>(null);
  const filterLiveRef = useRef<LiveSaveHandle | null>(null);

  const base = BASE_URL();

  const loadToolSets = useCallback(async (): Promise<Record<string, string[]>> => {
    const r = await fetch(base + '/v1/config/');
    const dd = await r.json() as ConfigData;
    return dd.config?.toolSets || {};
  }, [base]);

  useEffect(() => {
    Promise.all([
      fetch(base + '/v1/config/').then((r) => r.json() as Promise<ConfigData>),
      fetch(base + '/v1/tools/').then((r) => r.json() as Promise<ToolsResponse>).catch((): ToolsResponse => ({ groups: [] })),
    ])
      .then(([d, toolsResp]) => {
        const defs = (d.config?.defaults || {}) as Record<string, unknown>;
        const groups = (toolsResp?.groups || []) as ToolGroup[];

        setUseAgents(defs.useAgents !== false);

        const agentsObj = (d.config?.agents || {}) as Record<string, unknown>;
        setSubAgentNames(Object.keys(agentsObj).sort((a, b) => a.localeCompare(b)));

        const iv: Record<string, number> = {};
        for (const f of ITER_FIELDS) {
          iv[f.key] = (defs[f.key] as number | undefined) ?? f.default;
        }
        setIterValues(iv);

        const selTools = new Set(
          Array.isArray(defs.tool_command_overwrite_tools) && (defs.tool_command_overwrite_tools as unknown[]).length
            ? (defs.tool_command_overwrite_tools as string[])
            : DEFAULT_TOOLS
        );
        setSelectedTools(selTools);

        const ccGrp = groups.find((g) => g.id === 'claude-tools');
        setCcTools((ccGrp?.items || []).filter((i) => i.toolName).map((i) => i.toolName!));

        const codexGrp = groups.find((g) => g.id === 'codex-tools');
        setCodexTools((codexGrp?.items || []).filter((i) => i.toolName).map((i) => i.toolName!));

        const mcpGrp = groups.find((g) => g.id === 'claude-mcp');
        const mcpItems = (mcpGrp?.items || []).filter((i) => i.toolName);
        const byServer = new Map<string, string[]>();
        for (const item of mcpItems) {
          const srv = item.server || 'Unknown';
          if (!byServer.has(srv)) byServer.set(srv, []);
          byServer.get(srv)!.push(item.toolName!);
        }
        setMcpByServer(byServer);

        const allToolNames: string[] = [];
        for (const g of groups) {
          if (g.id === 'claude-mcp') continue;
          for (const it of g.items || []) if (it.toolName) allToolNames.push(it.toolName);
        }
        setAllNonMcpTools([...new Set(allToolNames)]);

        setLoading(false);

        loadToolSets().then(setToolSets).catch(() => {});
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, [base, loadToolSets]);

  useEffect(() => {
    if (loading || error) return;
    iterLiveRef.current = liveSave({
      endpoint: base + '/v1/config/',
      debounceMs: 500,
      statusEl: iterStatusRef.current,
      errorLabel: 'Save iteration limit failed',
      buildBody: (patch) => ({ defaults: patch }),
    });
    filterLiveRef.current = liveSave({
      endpoint: base + '/v1/config/',
      debounceMs: 350,
      statusEl: filterStatusRef.current,
      errorLabel: 'Save filter list failed',
      buildBody: (patch) => ({ defaults: patch }),
      onSaved: () => commands?.fetchTools?.(),
    });
    return () => {
      iterLiveRef.current?.flush();
      filterLiveRef.current?.flush();
    };
  }, [loading, error, base]);

  function handleIterChange(key: string, val: number) {
    setIterValues((prev) => ({ ...prev, [key]: val }));
    if (!isNaN(val) && val > 0) iterLiveRef.current?.patch({ [key]: val });
  }

  function handleIterBlur() {
    iterLiveRef.current?.flush();
  }

  function handleIterReset() {
    const patch: Record<string, number> = {};
    const next: Record<string, number> = {};
    for (const f of ITER_FIELDS) {
      patch[f.key] = f.default;
      next[f.key] = f.default;
    }
    setIterValues(next);
    iterLiveRef.current?.patch(patch);
    iterLiveRef.current?.flush();
  }

  async function handleUseAgentsChange(checked: boolean) {
    setUseAgents(checked);
    await fetch(base + '/v1/config/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaults: { useAgents: checked } }),
    });
  }

  function handleToolToggle(tool: string, checked: boolean) {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (checked) next.add(tool); else next.delete(tool);
      filterLiveRef.current?.patch({ tool_command_overwrite_tools: [...next] });
      return next;
    });
  }

  function handleGroupAll(_groupKey: string, tools: string[]) {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      for (const t of tools) next.add(t);
      filterLiveRef.current?.patch({ tool_command_overwrite_tools: [...next] });
      return next;
    });
  }

  function handleGroupNone(_groupKey: string, tools: string[]) {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      for (const t of tools) next.delete(t);
      filterLiveRef.current?.patch({ tool_command_overwrite_tools: [...next] });
      return next;
    });
  }

  function handleFilterReset() {
    setSelectedTools(new Set(DEFAULT_TOOLS));
    filterLiveRef.current?.patch({ tool_command_overwrite_tools: [...DEFAULT_TOOLS] });
    filterLiveRef.current?.flush();
  }

  async function handleAddToolSet() {
    const name = newTsName.trim();
    if (!name) return;
    if (toolSets[name] !== undefined) {
      setNewTsNameError(true);
      setTimeout(() => setNewTsNameError(false), 1500);
      return;
    }
    await fetch(`${base}/v1/config/toolSets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: [] }),
    });
    setNewTsName('');
    const updated = await loadToolSets();
    setToolSets(updated);
  }

  async function handleDeleteToolSet(name: string) {
    if (!confirm(`Delete tool set "${name}"?`)) return;
    await fetch(`${base}/v1/config/toolSets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const updated = await loadToolSets();
    setToolSets(updated);
  }

  async function handleToolSetEdited() {
    const updated = await loadToolSets();
    setToolSets(updated);
  }

  if (loading) return <div className="prefs-loading">Loading…</div>;
  if (error) return <div className="dim" style={{ padding: '16px 0' }}>Failed to reach bridge server.</div>;

  const toolGroupsEmpty = !ccTools.length && !codexTools.length && !mcpByServer.size;

  return (
    <>
      <h4 className="prefs-sec">Sub-agents</h4>
      <div className="prefs-row" style={{ alignItems: 'center', gap: '8px' }}>
        <input
          type="checkbox"
          id="prefs-use-agents"
          checked={useAgents}
          onChange={(e) => handleUseAgentsChange(e.target.checked)}
          style={{ accentColor: 'var(--accent)', width: '14px', height: '14px' }}
        />
        <label htmlFor="prefs-use-agents" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}>
          Enable sub-agents (Task tool / parallel spawning)
        </label>
      </div>
      <div className="prefs-hint">
        Agents dir: <code>~/.claude/agents/</code> &mdash;{' '}
        {subAgentNames.length} agent{subAgentNames.length !== 1 ? 's' : ''} loaded:{' '}
        {subAgentNames.length
          ? subAgentNames.map((n) => <span key={n} className="prefs-agent-chip">{n}</span>)
          : <em>none</em>}
      </div>
      <div className="prefs-hint" style={{ lineHeight: '1.6', marginTop: '6px' }}>
        <b>Agent calls</b> appear in the chat as tool-call blocks titled <code>Task</code>.
        When a model uses the <code>Task</code> tool it spawns a Claude Code sub-agent to handle
        an independent workstream.
      </div>

      <h4 className="prefs-sec" style={{ marginTop: '24px' }}>Iteration limits</h4>
      <div className="prefs-hint" style={{ marginBottom: '12px' }}>
        Controls how many times the model can call tools in a single response turn.
        Higher numbers allow deeper autonomous reasoning but use more tokens and cost.
      </div>

      {ITER_FIELDS.map((f) => (
        <div key={f.key} className="prefs-ta-row">
          <div className="prefs-ta-label">{f.label}</div>
          <input
            className="prefs-input prefs-ta-input"
            type="number"
            step={1}
            min={f.min}
            max={f.max}
            data-key={f.key}
            data-default={f.default}
            value={iterValues[f.key] ?? f.default}
            onChange={(e) => handleIterChange(f.key, parseInt(e.target.value, 10))}
            onBlur={handleIterBlur}
            style={{ width: '100px', textAlign: 'right' }}
          />
          <div className="prefs-hint">{f.hint}</div>
        </div>
      ))}

      <div className="prefs-row" style={{ marginTop: '14px', gap: '8px', alignItems: 'center' }}>
        <button className="prefs-btn" id="prefs-ta-reset" onClick={handleIterReset}>Reset to defaults</button>
        <span ref={iterStatusRef} className="prefs-live-status" id="prefs-ta-status" style={{ fontSize: '11px', color: 'var(--fg-dim)', minWidth: '60px' }} />
      </div>

      <h4 className="prefs-sec" style={{ marginTop: '24px' }}>Tool filter list</h4>
      <div className="prefs-hint" style={{ lineHeight: '1.5' }}>
        Configure which tools are available when the chat bar tool button is in{' '}
        <strong>filter mode</strong> (amber). Activate filter mode with the ⚙ button in the chat input.
        Default: <code>Write, Read, Edit, Bash, Task</code>.
      </div>

      <div id="prefs-overwrite-wrap">
        {toolGroupsEmpty
          ? <div className="prefs-hint">No tool list available right now.</div>
          : <>
              <OverFilterGroup
                label="Claude Code (Harness)"
                toolNames={ccTools}
                groupKey="cc"
                selectedTools={selectedTools}
                onChange={handleToolToggle}
                onAll={(gk) => handleGroupAll(gk, ccTools)}
                onNone={(gk) => handleGroupNone(gk, ccTools)}
              />
              {codexTools.length > 0 && (
                <OverFilterGroup
                  label="Codex Harness"
                  toolNames={codexTools}
                  groupKey="codex"
                  selectedTools={selectedTools}
                  onChange={handleToolToggle}
                  onAll={(gk) => handleGroupAll(gk, codexTools)}
                  onNone={(gk) => handleGroupNone(gk, codexTools)}
                />
              )}
              {[...mcpByServer.entries()].map(([srv, tools]) => (
                <OverFilterGroup
                  key={`mcp:${srv}`}
                  label={`MCP: ${srv}`}
                  toolNames={tools}
                  groupKey={`mcp:${srv}`}
                  selectedTools={selectedTools}
                  onChange={handleToolToggle}
                  onAll={(gk) => handleGroupAll(gk, tools)}
                  onNone={(gk) => handleGroupNone(gk, tools)}
                />
              ))}
            </>
        }
        <div className="prefs-row" style={{ marginTop: '10px', gap: '8px', alignItems: 'center' }}>
          <button className="prefs-btn" id="prefs-overwrite-defaults" onClick={handleFilterReset}>Reset to defaults</button>
          <span ref={filterStatusRef} className="prefs-live-status" id="prefs-overwrite-status" style={{ fontSize: '11px', color: 'var(--fg-dim)', minWidth: '60px' }} />
        </div>
      </div>

      <h4 className="prefs-sec" style={{ marginTop: '24px' }}>Tool Sets</h4>
      <div className="prefs-hint" style={{ lineHeight: '1.5' }}>
        Saveable tool-set presets. Employees reference a set by name in their profile.
      </div>
      <div id="prefs-toolsets-section">
        <div className="prefs-row" style={{ gap: '8px', margin: '6px 0 10px' }}>
          <input
            className="prefs-input"
            id="prefs-new-toolset-name"
            placeholder="New tool-set name…"
            value={newTsName}
            onChange={(e) => setNewTsName(e.target.value)}
            style={{ flex: 1, maxWidth: '180px', borderColor: newTsNameError ? 'var(--danger)' : undefined }}
          />
          <button className="prefs-btn" id="prefs-add-toolset" onClick={handleAddToolSet}>+ Add</button>
        </div>
        <div className="prefs-prompts-list">
          {Object.entries(toolSets).map(([name, tools]) => (
            <ToolSetRow
              key={name}
              name={name}
              tools={tools}
              allTools={allNonMcpTools}
              base={base}
              onDelete={handleDeleteToolSet}
              onEdited={handleToolSetEdited}
            />
          ))}
        </div>
      </div>

      <h4 className="prefs-sec" style={{ marginTop: '24px' }}>Meta Tools</h4>
      <MetaSectionHost kind="tool" />

      <h4 className="prefs-sec" style={{ marginTop: '24px' }}>Optimizing depth</h4>
      <div className="prefs-hint" style={{ lineHeight: '1.6' }}>
        To let models reach deeper conclusions:<br />
        • Increase <b>Tool max iterations</b> (streaming) — covers most chat turns.<br />
        • Increase <b>Tool result limit</b> — models see richer tool output; especially useful for Bash &amp; file reads.<br />
        • Increase model <b>context length</b> in the Models tab.<br />
        • Use larger <b>output token</b> limits via the provider caps in <code>PROVIDER_MAX_TOKENS</code>.<br />
        • For Claude proxy calls (via the <code>/proxy/</code> route), the <b>Agent max iterations</b> value applies.
      </div>
    </>
  );
}
