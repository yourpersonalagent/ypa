// PersonnelPanel — header section listing employees with inline edit/new forms.
//
// Registered as a HeaderSection component (bootstrap-core-header-sections.tsx).
// Renders its own hs-section / hs-toggle / hs-body inline — no portal. The
// same component is rendered both in the full layout's header sidebar and in
// the PanelsDrawer overlay (messenger/zen), so the contents always sit in
// the same node hierarchy as the wrapping section.
//
// Data flow: on first open (`open` prop transitions to true), fetches
// /v1/employees/ + /v1/config/. Active employee → render <EditForm>;
// '__new__' → <NewForm>. CRUD calls go straight to /v1/employees/* and
// re-fetch on success.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getSessionActions, getAppState, getEmployeesActions } from '../stores/index.js';
import { api } from '../api.js';
import { toast } from '../toast.js';
import {
  AVATAR_CHOICES,
  DEFAULT_AVATAR,
  avatarColorsEqual,
  resolveAvatarColor,
} from '../color-themes-config.js';
import { openModelPicker } from '../pickers/ModelPicker.js';
import { session } from '../session.js';
import { useLiveForm, type SaveStatus } from '../util/useLiveForm.js';
import { SaveStatusBadge } from '../components/SaveStatusBadge.js';
import { seedSkillCommand } from '../chat/seedCommand.js';

const RECRUIT_SKILL = 'recruit-team';

interface Employee {
  id: string;
  name?: string;
  role?: string;
  fullName?: string;
  defaultModel?: string;
  defaultModelProvider?: string;
  fallbackModel?: string;
  fallbackModelProvider?: string;
  toolSetPreset?: string;
  systemPromptPreset?: string;
  skillSetPreset?: string;
  symbolColor?: string;
  capVision?: string | null;
  capReasoning?: string | null;
  capTools?: string | null;
  standard?: boolean;
  virtual?: boolean;
  exposeAsAgent?: boolean;
}

interface Configs {
  toolSets: Record<string, unknown>;
  presets: Record<string, unknown>;
  skillSets: Record<string, unknown>;
}

interface OrgTeam {
  id: string;
  label: string;
  description?: string;
  lead?: string;
  context?: string;
  members: string[];
}
interface OrgDept {
  id: string;
  label: string;
  description?: string;
  teams: OrgTeam[];
}
interface Org {
  departments: OrgDept[];
}

interface ApiResult {
  success: boolean;
  error?: string;
  employees?: Employee[];
  employee?: Employee;
  participants?: unknown[];
  config?: { toolSets?: Record<string, unknown>; presetsMap?: Record<string, unknown>; skillSets?: Record<string, unknown> };
  models?: Array<{ name?: string; id?: string } | string>;
  org?: Org;
}

type CapState = '' | 'on' | 'off' | 'filter';

function capBtnClass(val: string | null | undefined): string {
  if (val === 'on') return 'emp-cap-on';
  if (val === 'off') return 'emp-cap-off';
  if (val === 'filter') return 'emp-cap-filter';
  return 'emp-cap-inherit';
}

function capLabel(id: 'vision' | 'reasoning' | 'tools', val: string | null | undefined): string {
  const suffix = val ? `:${val}` : '';
  if (id === 'vision') return `👁${suffix}`;
  if (id === 'reasoning') return `◈${suffix}`;
  return `⚙${suffix}`;
}

function nextCap(cap: 'vision' | 'reasoning' | 'tools', cur: string): CapState {
  if (cap === 'tools') {
    if (cur === '') return 'on';
    if (cur === 'on') return 'filter';
    if (cur === 'filter') return 'off';
    return '';
  }
  if (cur === '') return 'on';
  if (cur === 'on') return 'off';
  return '';
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="pers-color-pick">
      {AVATAR_CHOICES.map(({ value: v, label, swatchBg }) => (
        <button
          key={v}
          type="button"
          className={`pers-color-swatch${avatarColorsEqual(v, value) ? ' selected' : ''}`}
          title={label}
          style={{ background: swatchBg }}
          onClick={() => onChange(v)}
        />
      ))}
    </div>
  );
}

function CapabilityRow({
  vision,
  reasoning,
  tools,
  onChange,
}: {
  vision: string;
  reasoning: string;
  tools: string;
  onChange: (caps: { vision: string; reasoning: string; tools: string }) => void;
}) {
  return (
    <div className="emp-caps-row">
      <button
        type="button"
        className={`emp-cap-btn ${capBtnClass(vision)}`}
        title="Vision (image input)"
        onClick={() => onChange({ vision: nextCap('vision', vision), reasoning, tools })}
      >
        {capLabel('vision', vision)}
      </button>
      <button
        type="button"
        className={`emp-cap-btn ${capBtnClass(reasoning)}`}
        title="Extended thinking/reasoning"
        onClick={() => onChange({ vision, reasoning: nextCap('reasoning', reasoning), tools })}
      >
        {capLabel('reasoning', reasoning)}
      </button>
      <button
        type="button"
        className={`emp-cap-btn ${capBtnClass(tools)}`}
        title="Tool calls: on / filter / off"
        onClick={() => onChange({ vision, reasoning, tools: nextCap('tools', tools) })}
      >
        {capLabel('tools', tools)}
      </button>
    </div>
  );
}

function ModelInput({
  id,
  value,
  provider,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  provider: string;
  placeholder: string;
  onChange: (v: { model: string; provider: string }) => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);

  function openPicker() {
    if (!btnRef.current) return;
    openModelPicker(btnRef.current, (m) => {
      onChange({ model: m.name, provider: m.provider ?? '' });
    });
  }

  return (
    <div className="pers-model-wrap">
      <input
        className="pers-input pers-model-input"
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange({ model: e.target.value, provider })}
      />
      <span className="pers-model-prov">{provider}</span>
      <button
        type="button"
        ref={btnRef}
        className="pers-model-pick-btn"
        title="Browse models"
        onClick={openPicker}
      >
        ⊞
      </button>
    </div>
  );
}

function PresetSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: Record<string, unknown>;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className="pers-input"
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">(none)</option>
      {Object.keys(options).map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

// ── Edit existing employee ─────────────────────────────────────────────────

interface EmployeeFormValues {
  name: string;
  role: string;
  fullName: string;
  defaultModel: string;
  defaultModelProvider: string;
  fallbackModel: string;
  fallbackModelProvider: string;
  toolSetPreset: string;
  systemPromptPreset: string;
  skillSetPreset: string;
  symbolColor: string;
  capVision: string;
  capReasoning: string;
  capTools: string;
  exposeAsAgent: boolean;
}

function EditForm({
  employee,
  configs,
  onSaved,
  onDeleted,
}: {
  employee: Employee;
  configs: Configs;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const form = useLiveForm<EmployeeFormValues>({
    endpoint: api.config.baseUrl + `/v1/employees/${encodeURIComponent(employee.id)}`,
    initial: {
      name: employee.name ?? '',
      role: employee.role ?? '',
      fullName: employee.fullName ?? '',
      defaultModel: employee.defaultModel ?? '',
      defaultModelProvider: employee.defaultModelProvider ?? '',
      fallbackModel: employee.fallbackModel ?? '',
      fallbackModelProvider: employee.fallbackModelProvider ?? '',
      toolSetPreset: employee.toolSetPreset ?? '',
      systemPromptPreset: employee.systemPromptPreset ?? '',
      skillSetPreset: employee.skillSetPreset ?? '',
      symbolColor: employee.symbolColor || DEFAULT_AVATAR,
      capVision: employee.capVision ?? '',
      capReasoning: employee.capReasoning ?? '',
      capTools: employee.capTools ?? '',
      exposeAsAgent: employee.exposeAsAgent === true,
    },
    onSaved,
    errorLabel: 'Save failed',
  });

  // Notes — separate endpoint that wraps the body in preserved frontmatter,
  // so it gets its own small debounce instead of going through useLiveForm.
  const [notes, setNotes] = useState('');
  const [notesStatus, setNotesStatus] = useState<SaveStatus>('idle');
  const frontRef = useRef('');
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notesSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch(api.config.baseUrl + `/v1/employees/${encodeURIComponent(employee.id)}/md`)
      .then((r) => r.text())
      .then((md) => {
        frontRef.current = md.match(/^---[\s\S]*?---/)?.[0] ?? '';
        setNotes(md.replace(/^---[\s\S]*?---\n?/, '').trim());
      })
      .catch(() => {});
  }, [employee.id]);

  useEffect(() => () => {
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    if (notesSavedTimerRef.current) clearTimeout(notesSavedTimerRef.current);
  }, []);

  function changeNotes(val: string): void {
    setNotes(val);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(async () => {
      setNotesStatus('saving');
      try {
        const r = await fetch(api.config.baseUrl + `/v1/employees/${encodeURIComponent(employee.id)}/md`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: frontRef.current + '\n\n' + val + '\n' }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setNotesStatus('saved');
        if (notesSavedTimerRef.current) clearTimeout(notesSavedTimerRef.current);
        notesSavedTimerRef.current = setTimeout(() => setNotesStatus('idle'), 1400);
      } catch (err) {
        setNotesStatus('error');
        toast.show('Notes save failed: ' + (err as Error).message, 'error');
      }
    }, 600);
  }

  async function del(): Promise<void> {
    if (!confirm(`Delete ${form.values.name || employee.id}? This cannot be undone.`)) return;
    try {
      const r = await fetch(api.config.baseUrl + `/v1/employees/${encodeURIComponent(employee.id)}`, {
        method: 'DELETE',
      });
      const d = (await r.json()) as ApiResult;
      if (!d.success) {
        toast.show('Error: ' + (d.error ?? 'unknown'), 'error');
        return;
      }
      toast.show(`Deleted ${form.values.name || employee.id}`);
      onDeleted();
    } catch (err) {
      toast.show('Error: ' + (err as Error).message, 'error');
    }
  }

  // Show whichever stream is non-idle (notes typing is the more frequent one).
  const combinedStatus: SaveStatus = notesStatus !== 'idle' ? notesStatus : form.status;

  const model = { model: form.values.defaultModel, provider: form.values.defaultModelProvider };
  const fallback = { model: form.values.fallbackModel, provider: form.values.fallbackModelProvider };
  const caps = { vision: form.values.capVision, reasoning: form.values.capReasoning, tools: form.values.capTools };

  return (
    <div className="pers-form">
      <div className="pers-form-status-bar">
        <SaveStatusBadge status={combinedStatus} />
      </div>
      <div className="pers-field"><label>Name</label>
        <input className="pers-input" type="text" value={form.values.name}
          onChange={(e) => form.setField('name', e.target.value)} /></div>
      <div className="pers-field"><label>Role</label>
        <input className="pers-input" type="text" value={form.values.role}
          onChange={(e) => form.setField('role', e.target.value)} /></div>
      <div className="pers-field"><label>Full Name</label>
        <input className="pers-input" type="text" value={form.values.fullName}
          onChange={(e) => form.setField('fullName', e.target.value)} /></div>
      <div className="pers-field"><label>Model</label>
        <ModelInput id="pf-model" value={model.model} provider={model.provider}
          placeholder="— session default —"
          onChange={(m) => form.setMany({ defaultModel: m.model, defaultModelProvider: m.provider })} /></div>
      <div className="pers-field"><label>Fallback</label>
        <ModelInput id="pf-fallback" value={fallback.model} provider={fallback.provider}
          placeholder="— none —"
          onChange={(m) => form.setMany({ fallbackModel: m.model, fallbackModelProvider: m.provider })} /></div>
      <div className="pers-field"><label>Capabilities</label>
        <CapabilityRow vision={caps.vision} reasoning={caps.reasoning} tools={caps.tools}
          onChange={(c) => form.setMany({ capVision: c.vision, capReasoning: c.reasoning, capTools: c.tools })} /></div>
      {caps.tools === 'filter' && (
        <div className="pers-field"><label>Tool Set</label>
          <PresetSelect id="pf-toolset" value={form.values.toolSetPreset}
            options={configs.toolSets} onChange={(v) => form.setField('toolSetPreset', v)} /></div>
      )}
      <div className="pers-field"><label>Sys Preset</label>
        <PresetSelect id="pf-sysprompt" value={form.values.systemPromptPreset}
          options={configs.presets} onChange={(v) => form.setField('systemPromptPreset', v)} /></div>
      <div className="pers-field"><label>Skill Set</label>
        <PresetSelect id="pf-skillset" value={form.values.skillSetPreset}
          options={configs.skillSets} onChange={(v) => form.setField('skillSetPreset', v)} /></div>
      <div className="pers-field"><label>Symbol Color</label>
        <ColorSwatches value={form.values.symbolColor}
          onChange={(c) => form.setField('symbolColor', c)} /></div>
      <div className="pers-field"><label>Expose as MCP agent</label>
        <label className="pers-toggle" title="Publish this employee through the agent-tools MCP server so other agents (Claude Code, Codex, API callers) can list and call them via list_agents / call_agent.">
          <input type="checkbox" checked={form.values.exposeAsAgent}
            onChange={(e) => form.setField('exposeAsAgent', e.target.checked)} />
          <span>{form.values.exposeAsAgent ? 'on' : 'off'}</span>
        </label></div>
      <div className="pers-field"><label>Notes</label>
        <textarea className="pers-input pers-notes" value={notes} onChange={(e) => changeNotes(e.target.value)} /></div>
      {!employee.standard && (
        <div className="pers-form-actions">
          <span className="pers-form-actions-spacer" />
          <button className="pers-btn pers-btn-text pers-btn-danger" onClick={del}>Delete</button>
        </div>
      )}
    </div>
  );
}

// ── New employee ───────────────────────────────────────────────────────────

function NewForm({
  configs,
  onCreated,
  onCancel,
}: {
  configs: Configs;
  onCreated: (newId: string) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [fullName, setFullName] = useState('');
  const [model, setModel] = useState({ model: '', provider: '' });
  const [fallback, setFallback] = useState({ model: '', provider: '' });
  const [caps, setCaps] = useState({ vision: '', reasoning: '', tools: '' });
  const [toolSet, setToolSet] = useState('');
  const [sysPreset, setSysPreset] = useState('');
  const [skillSet, setSkillSet] = useState('');
  const [color, setColor] = useState('');
  const [status, setStatus] = useState('');

  async function create() {
    const rawId = id.trim();
    if (!rawId) { setStatus('ID is required.'); return; }
    setStatus('Creating…');
    try {
      const r = await fetch(api.config.baseUrl + '/v1/employees/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: rawId,
          name: name.trim(),
          role: role.trim(),
          fullName: fullName.trim(),
          defaultModel: model.model,
          defaultModelProvider: model.provider,
          fallbackModel: fallback.model,
          fallbackModelProvider: fallback.provider,
          toolSetPreset: toolSet,
          systemPromptPreset: sysPreset,
          skillSetPreset: skillSet,
          symbolColor: color || DEFAULT_AVATAR,
          capVision: caps.vision,
          capReasoning: caps.reasoning,
          capTools: caps.tools,
        }),
      });
      const d = (await r.json()) as ApiResult;
      if (!d.success) { setStatus('Error: ' + d.error); return; }
      onCreated(d.employee?.id ?? rawId);
    } catch (err) {
      setStatus('Error: ' + (err as Error).message);
    }
  }

  return (
    <div className="pers-form">
      <div className="pers-field"><label>ID <span style={{ fontSize: 10, opacity: 0.6 }}>(lowercase)</span></label>
        <input className="pers-input" type="text" value={id} placeholder="e.g. scribe" onChange={(e) => setId(e.target.value)} /></div>
      <div className="pers-field"><label>Name</label>
        <input className="pers-input" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="pers-field"><label>Role</label>
        <input className="pers-input" type="text" value={role} onChange={(e) => setRole(e.target.value)} /></div>
      <div className="pers-field"><label>Full Name</label>
        <input className="pers-input" type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
      <div className="pers-field"><label>Model</label>
        <ModelInput id="pf-model" value={model.model} provider={model.provider} placeholder="— session default —" onChange={setModel} /></div>
      <div className="pers-field"><label>Fallback</label>
        <ModelInput id="pf-fallback" value={fallback.model} provider={fallback.provider} placeholder="— none —" onChange={setFallback} /></div>
      <div className="pers-field"><label>Capabilities</label>
        <CapabilityRow vision={caps.vision} reasoning={caps.reasoning} tools={caps.tools} onChange={setCaps} /></div>
      {caps.tools === 'filter' && (
        <div className="pers-field"><label>Tool Set</label>
          <PresetSelect id="pf-toolset" value={toolSet} options={configs.toolSets} onChange={setToolSet} /></div>
      )}
      <div className="pers-field"><label>Sys Preset</label>
        <PresetSelect id="pf-sysprompt" value={sysPreset} options={configs.presets} onChange={setSysPreset} /></div>
      <div className="pers-field"><label>Skill Set</label>
        <PresetSelect id="pf-skillset" value={skillSet} options={configs.skillSets} onChange={setSkillSet} /></div>
      <div className="pers-field"><label>Symbol Color</label>
        <ColorSwatches value={color} onChange={setColor} /></div>
      {status && <div className="pers-status">{status}</div>}
      <div className="pers-form-actions">
        <button className="pers-btn pers-btn-text pers-btn-primary" onClick={create}>Create</button>
        <span className="pers-form-actions-spacer" />
        <button className="pers-btn pers-btn-text" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Tile (one employee in the list) ────────────────────────────────────────

function EmployeeTile({
  employee,
  active,
  onSelect,
  onInvite,
  onRecruit,
}: {
  employee: Employee;
  active: boolean;
  onSelect: () => void;
  onInvite: (btn: HTMLButtonElement) => void;
  /** Only passed for CEO Dave — opens the recruit-team skill in chat. */
  onRecruit?: () => void;
}) {
  const initial = (employee.name ?? employee.id ?? '?')[0].toUpperCase();
  return (
    <div className={`pers-tile${active ? ' active' : ''}`} onClick={onSelect}>
      <span className="pers-tile-av" style={{ background: resolveAvatarColor(employee.symbolColor) }}>{initial}</span>
      <span className="pers-tile-info">
        <span className="pers-tile-name">{employee.name ?? employee.id}</span>
        <span className="pers-tile-role">{employee.role ?? '—'}</span>
      </span>
      {employee.exposeAsAgent && (
        <span className="pers-tile-mcp" title="Exposed via the agent-tools MCP server — other agents (Claude Code, Codex, API callers) can list and call this employee.">🛰</span>
      )}
      {employee.standard && <span className="pers-tile-std" title="Standard">★</span>}
      {onRecruit && (
        <button
          className="pers-tile-recruit"
          title="Recruit a team — opens the recruit-team skill so CEOdave can build departments &amp; teams for you"
          onClick={(e) => {
            e.stopPropagation();
            onRecruit();
          }}
        >
          ⚒
        </button>
      )}
      <button
        className="pers-tile-invite"
        title="Invite to session"
        onClick={(e) => {
          e.stopPropagation();
          onInvite(e.currentTarget);
        }}
      >
        +
      </button>
    </div>
  );
}

// ── Org grouping (Department → Team → members) ─────────────────────────────

function TeamSection({
  team,
  members,
  expanded,
  onToggleExpand,
  renderTile,
  onInviteTeam,
}: {
  team: OrgTeam;
  members: Employee[];
  expanded: boolean;
  onToggleExpand: () => void;
  renderTile: (emp: Employee) => ReactNode;
  onInviteTeam: (memberIds: string[], btn: HTMLButtonElement) => void;
}) {
  return (
    <div className="pers-team" data-team={team.id}>
      <div className="pers-team-header">
        <button className="pers-group-toggle" onClick={onToggleExpand} title={team.description || team.label}>
          <span className="pers-group-caret">{expanded ? '▾' : '▸'}</span>
          <span className="pers-team-label">{team.label}</span>
          <span className="pers-group-count">{members.length}</span>
        </button>
        <button
          className="pers-team-invite"
          title="Invite the whole team to this session"
          disabled={members.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            onInviteTeam(members.map((m) => m.id), e.currentTarget);
          }}
        >
          + team
        </button>
      </div>
      {expanded && (
        <div className="pers-team-body">
          {members.length === 0 ? (
            <div className="pers-empty">No members yet.</div>
          ) : (
            members.map((m) => renderTile(m))
          )}
        </div>
      )}
    </div>
  );
}

function DeptSection({
  dept,
  expanded,
  onToggleExpand,
  count,
  children,
}: {
  dept: OrgDept;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Badge count; defaults to the number of teams. */
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="pers-dept" data-dept={dept.id}>
      <button className="pers-dept-header pers-group-toggle" onClick={onToggleExpand} title={dept.description || dept.label}>
        <span className="pers-group-caret">{expanded ? '▾' : '▸'}</span>
        <span className="pers-dept-label">{dept.label}</span>
        <span className="pers-group-count">{count ?? dept.teams.length}</span>
      </button>
      {expanded && <div className="pers-dept-body">{children}</div>}
    </section>
  );
}

// ── Root panel ─────────────────────────────────────────────────────────────

export function PersonnelPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [configs, setConfigs] = useState<Configs>({ toolSets: {}, presets: {}, skillSets: {} });
  const [org, setOrg] = useState<Org>({ departments: [] });
  const [activeId, setActiveId] = useState<string | null>(null);
  // Collapsed-by-default org sections. Keys: `dept:<id>` and `team:<dept>/<id>`.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const base = api.config.baseUrl as string;
      const [empR, cfgR, orgR] = await Promise.all([
        fetch(base + '/v1/employees/').catch(() => null),
        fetch(base + '/v1/config/').catch(() => null),
        fetch(base + '/v1/org/').catch(() => null),
      ]);
      if (empR?.ok) {
        const d = (await empR.json()) as ApiResult;
        const list = (d.employees ?? []).filter((e) => !e.virtual);
        setEmployees(list);
        getEmployeesActions().setEmployees(list);
      }
      if (cfgR?.ok) {
        const d = (await cfgR.json()) as ApiResult;
        setConfigs({
          toolSets: d.config?.toolSets ?? {},
          presets: d.config?.presetsMap ?? {},
          skillSets: d.config?.skillSets ?? {},
        });
      }
      if (orgR?.ok) {
        const d = (await orgR.json()) as ApiResult;
        setOrg({ departments: d.org?.departments ?? [] });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount + whenever the section transitions to open. Pre-fetch on
  // mount means the list is ready by the time the user clicks the toggle in
  // the full layout; the open-transition re-fetch keeps data fresh across
  // re-opens and covers the messenger/zen drawer case where the component
  // first mounts already-open.
  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { if (open) loadAll(); }, [open, loadAll]);

  // Core: add one employee as a participant on the current session. Returns
  // the server's updated participants array (or null), throws on failure.
  async function postParticipant(empId: string): Promise<unknown[] | null> {
    const sessionId = session?.getCurrentId?.() ?? getAppState().currentSession;
    const r = await fetch(
      api.config.baseUrl + `/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: empId }),
      },
    );
    const d = (await r.json()) as ApiResult;
    if (!r.ok || !d.success) throw new Error(String(d.error ?? r.status));
    return Array.isArray(d.participants) ? d.participants : null;
  }

  // Mirror the latest participants onto the cached session + notify the UI.
  function commitParticipants(participants: unknown[] | null) {
    if (!participants) return;
    const sessionId = session?.getCurrentId?.() ?? getAppState().currentSession;
    const cache = session?.getCached?.() ?? [];
    const cached = cache.find((s: { id: unknown }) => String(s.id) === String(sessionId));
    if (cached) cached.participants = participants;
    getSessionActions().bumpParticipantsRevision();
  }

  async function inviteFromTile(emp: Employee, btn: HTMLButtonElement) {
    const orig = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    try {
      const participants = await postParticipant(emp.id);
      commitParticipants(participants);
      btn.textContent = '✓';
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
      return;
    } catch (err) {
      toast.show('Error: ' + (err as Error).message);
    }
    btn.textContent = orig;
    btn.disabled = false;
  }

  // Bulk-invite every member of a team. Mode (each/mod/vs) is left to the
  // user — this only drops the roster in as participants.
  async function inviteTeam(memberIds: string[], btn: HTMLButtonElement) {
    if (memberIds.length === 0) return;
    const orig = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    let last: unknown[] | null = null;
    let failed = 0;
    for (const id of memberIds) {
      try {
        const p = await postParticipant(id);
        if (p) last = p;
      } catch (_) {
        failed += 1;
      }
    }
    commitParticipants(last);
    if (failed) toast.show(`Invited team — ${failed} of ${memberIds.length} failed`, 'error');
    btn.textContent = failed ? '!' : '✓';
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1500);
  }

  const active = activeId && activeId !== '__new__' ? employees.find((e) => e.id === activeId) : null;

  // Resolve member ids → Employee records (skip ids that no longer exist).
  const byId = new Map(employees.map((e) => [e.id, e]));
  const renderTile = (emp: Employee) => (
    <EmployeeTile
      key={emp.id}
      employee={emp}
      active={activeId === emp.id}
      onSelect={() => setActiveId(activeId === emp.id ? null : emp.id)}
      onInvite={(btn) => inviteFromTile(emp, btn)}
      onRecruit={emp.id === 'ceodave' ? () => seedSkillCommand(RECRUIT_SKILL) : undefined}
    />
  );

  // Employees referenced by any team → everyone else falls into "Unassigned".
  const assignedIds = new Set<string>();
  for (const d of org.departments) for (const t of d.teams) for (const m of t.members) assignedIds.add(m);
  const unassigned = employees.filter((e) => !assignedIds.has(e.id));
  const hasOrg = org.departments.length > 0;

  const body = !open ? null : loading && employees.length === 0 ? (
    <div className="hs-loading">Loading…</div>
  ) : (
    <>
      <div className="pers-list">
        {employees.length === 0 ? (
          <div className="pers-empty">No employees yet.</div>
        ) : !hasOrg ? (
          // No org chart defined → flat list (original behaviour).
          employees.map((e) => renderTile(e))
        ) : (
          <>
            {org.departments.map((dept) => {
              const deptKey = `dept:${dept.id}`;
              return (
                <DeptSection
                  key={dept.id}
                  dept={dept}
                  expanded={!collapsed.has(deptKey)}
                  onToggleExpand={() => toggleCollapse(deptKey)}
                >
                  {dept.teams.length === 0 ? (
                    <div className="pers-empty">No teams yet.</div>
                  ) : (
                    dept.teams.map((team) => {
                      const teamKey = `team:${dept.id}/${team.id}`;
                      const members = team.members
                        .map((id) => byId.get(id))
                        .filter((e): e is Employee => !!e);
                      return (
                        <TeamSection
                          key={team.id}
                          team={team}
                          members={members}
                          expanded={!collapsed.has(teamKey)}
                          onToggleExpand={() => toggleCollapse(teamKey)}
                          renderTile={renderTile}
                          onInviteTeam={inviteTeam}
                        />
                      );
                    })
                  )}
                </DeptSection>
              );
            })}
            {unassigned.length > 0 && (
              <DeptSection
                dept={{ id: '__unassigned__', label: 'Unassigned', teams: [] }}
                expanded={!collapsed.has('dept:__unassigned__')}
                onToggleExpand={() => toggleCollapse('dept:__unassigned__')}
                count={unassigned.length}
              >
                {unassigned.map((e) => renderTile(e))}
              </DeptSection>
            )}
          </>
        )}
      </div>
      <div className="pers-form-wrap">
        {active && (
          <EditForm
            key={active.id}
            employee={active}
            configs={configs}
            onSaved={loadAll}
            onDeleted={() => { setActiveId(null); loadAll(); }}
          />
        )}
        {activeId === '__new__' && (
          <NewForm
            configs={configs}
            onCreated={(newId) => { setActiveId(newId); loadAll(); }}
            onCancel={() => setActiveId(null)}
          />
        )}
      </div>
      <button className="pers-new-btn" onClick={() => setActiveId('__new__')}>+ New employee</button>
    </>
  );

  return (
    <div className={`hs-section${open ? ' hs-open' : ''}`} id="hs-personnel">
      <button
        className={`hm-item hs-toggle${open ? ' hs-open' : ''}`}
        id="btn-personnel"
        title="Personnel (employees)"
        onClick={onToggle}
      >
        <span className="hm-icon" aria-hidden="true">
          <svg
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </span>
        personnel
      </button>
      <div className={`hs-body${open ? ' hs-open' : ''}`} id="personnel-panel">
        {body}
      </div>
    </div>
  );
}
