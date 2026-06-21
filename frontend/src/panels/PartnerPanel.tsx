// PartnerPanel — header section for external partner agents (Hermes, …).
// Registered as a HeaderSection component (bootstrap-core-header-sections.tsx).
// Renders its own hs-section / hs-toggle / hs-body inline — no portal. The
// same component is rendered both in the full layout's header sidebar and in
// the PanelsDrawer overlay (messenger/zen). Fetches /v1/partners/, renders
// tile list + inline edit form. Quick-add immediately POSTs and selects new
// partner.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { toast } from '../toast.js';
import { getSessionActions, getAppState } from '../stores/index.js';
import {
  AVATAR_CHOICES,
  DEFAULT_AVATAR,
  avatarColorsEqual,
  resolveAvatarColor,
} from '../color-themes-config.js';
import { session } from '../session.js';
import { useLiveForm } from '../util/useLiveForm.js';
import { SaveStatusBadge } from '../components/SaveStatusBadge.js';

interface PartnerInstance {
  id: string;
  type: string;
  name: string;
  symbolColor: string;
  enabled: boolean;
  running: boolean;
  installed: boolean;
  model?: string;
  systemPrompt?: string;
  promptFile?: string;
  connectionType?: 'local' | 'network';
  host?: string;
  port?: number;
  // tokenSet — whether a bearer token is stored server-side. The raw token
  // is NEVER returned by /v1/partners/* so the FE only knows on/off here.
  tokenSet?: boolean;
  agentId?: string;
  exposeAsAgent?: boolean;
}

interface AvailableType {
  type: string;
  label: string;
  installed: boolean;
  maxInstances?: number;
  count?: number;
  connectionType?: 'local' | 'network';
}

interface PartnersResponse {
  partners?: PartnerInstance[];
  availableTypes?: AvailableType[];
}

const DEFAULT_HERMES_MODEL = 'deepseek v4 flash';

function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
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

interface PartnerFormValues {
  name: string;
  symbolColor: string;
  enabled: boolean;
  model: string;
  systemPrompt: string;
  host: string;
  port: number;
  token: string;
  agentId: string;
  exposeAsAgent: boolean;
}

function EditForm({
  partner,
  onSaved,
  onDeleted,
  onConnectToggle,
}: {
  partner: PartnerInstance;
  onSaved: () => void;
  onDeleted: () => void;
  onConnectToggle: () => void;
}) {
  // The bridge never echoes the stored bearer token back to the client, so
  // we start with an empty string and only PUT the field if the user types
  // something. An empty submission must NOT clear an existing token —
  // useLiveForm's diff already handles that because the initial is '' and
  // the field will not be marked dirty until edited.
  const form = useLiveForm<PartnerFormValues>({
    endpoint: api.config.baseUrl + `/v1/partners/${encodeURIComponent(partner.id)}`,
    initial: {
      name: partner.name,
      symbolColor: partner.symbolColor || DEFAULT_AVATAR,
      enabled: partner.enabled,
      model: partner.model ?? '',
      systemPrompt: partner.systemPrompt ?? '',
      host: partner.host ?? '',
      port: partner.port ?? 18789,
      token: '',
      agentId: partner.agentId ?? 'main',
      exposeAsAgent: partner.exposeAsAgent === true,
    },
    onSaved,
    errorLabel: 'Save failed',
  });
  const [connecting, setConnecting] = useState(false);

  async function del() {
    if (!confirm(`Remove ${partner.name}?`)) return;
    try {
      await fetch(api.config.baseUrl + `/v1/partners/${encodeURIComponent(partner.id)}`, { method: 'DELETE' });
      toast.show(`Removed ${partner.name}`);
      onDeleted();
    } catch (err) {
      toast.show('Error: ' + (err as Error).message);
    }
  }

  async function toggleConnect() {
    setConnecting(true);
    try {
      await form.flush();
      await fetch(
        api.config.baseUrl + `/v1/partners/${encodeURIComponent(partner.id)}/${partner.running ? 'disconnect' : 'connect'}`,
        { method: 'POST' },
      );
      onConnectToggle();
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="pers-form">
      <div className="pers-form-status-bar">
        <SaveStatusBadge status={form.status} />
      </div>
      <div className="pers-field"><label>Name</label>
        <input
          className="pers-input"
          type="text"
          value={form.values.name}
          onChange={(e) => form.setField('name', e.target.value)}
        />
      </div>
      <div className="pers-field"><label>Symbol Color</label>
        <ColorSwatches value={form.values.symbolColor} onChange={(c) => form.setField('symbolColor', c)} />
      </div>
      {partner.type === 'hermes' && (
        <>
          <div className="pers-field"><label>Model</label>
            <input
              className="pers-input"
              type="text"
              value={form.values.model}
              placeholder={DEFAULT_HERMES_MODEL}
              onChange={(e) => form.setField('model', e.target.value)}
            />
          </div>
          <div className="pers-field">
            <label>System Prompt
              {partner.promptFile && (
                <span style={{ fontSize: '.72rem', color: 'var(--fg-dim)', marginLeft: 6 }} title={partner.promptFile}>
                  {partner.promptFile.replace(/^.*\/bridge\//, 'bridge/')}
                </span>
              )}
            </label>
            <textarea
              className="pers-input"
              rows={8}
              placeholder={`Free-form persona / instructions saved to bridge/partners/${partner.id}.md`}
              value={form.values.systemPrompt}
              onChange={(e) => form.setField('systemPrompt', e.target.value)}
            />
          </div>
        </>
      )}
      {partner.type === 'openclaw' && (
        <>
          <div className="pers-field"><label>Gateway Host</label>
            <input
              className="pers-input"
              type="text"
              value={form.values.host}
              placeholder="100.x.x.x or hostname"
              onChange={(e) => form.setField('host', e.target.value)}
            />
          </div>
          <div className="pers-field"><label>Port</label>
            <input
              className="pers-input"
              type="number"
              value={form.values.port}
              onChange={(e) => form.setField('port', parseInt(e.target.value, 10) || 18789)}
            />
          </div>
          <div className="pers-field">
            <label>Bearer Token
              {partner.tokenSet && (
                <span style={{ fontSize: '.72rem', color: 'var(--fg-dim)', marginLeft: 6 }}>
                  (stored — leave blank to keep, type to replace)
                </span>
              )}
            </label>
            <input
              className="pers-input"
              type="password"
              value={form.values.token}
              placeholder={partner.tokenSet ? '••••••••' : 'from openclaw.json on remote'}
              onChange={(e) => form.setField('token', e.target.value)}
            />
          </div>
          <div className="pers-field"><label>Agent ID</label>
            <input
              className="pers-input"
              type="text"
              value={form.values.agentId}
              placeholder="main"
              onChange={(e) => form.setField('agentId', e.target.value)}
            />
          </div>
          <div className="pers-field">
            <label>System Prompt
              {partner.promptFile && (
                <span style={{ fontSize: '.72rem', color: 'var(--fg-dim)', marginLeft: 6 }} title={partner.promptFile}>
                  {partner.promptFile.replace(/^.*\/bridge\//, 'bridge/')}
                </span>
              )}
            </label>
            <textarea
              className="pers-input"
              rows={8}
              placeholder={`Free-form persona / instructions saved to bridge/partners/${partner.id}.md`}
              value={form.values.systemPrompt}
              onChange={(e) => form.setField('systemPrompt', e.target.value)}
            />
          </div>
        </>
      )}
      <div className="pers-field" style={{ alignItems: 'center', gap: 8, flexDirection: 'row' }}>
        <input
          type="checkbox"
          id="pt-enabled"
          checked={form.values.enabled}
          onChange={(e) => form.setField('enabled', e.target.checked)}
          style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
        />
        <label htmlFor="pt-enabled" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}>enabled</label>
      </div>
      <div className="pers-field" style={{ alignItems: 'center', gap: 8, flexDirection: 'row' }}>
        <input
          type="checkbox"
          id="pt-expose"
          checked={form.values.exposeAsAgent}
          onChange={(e) => form.setField('exposeAsAgent', e.target.checked)}
          style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
        />
        <label htmlFor="pt-expose" style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }} title="Publish via the agent-tools MCP server so other agents (Claude Code, Codex, API callers) can list and call this partner.">
          expose as MCP agent
        </label>
      </div>
      <div className="pers-form-actions">
        <button
          className="pers-btn pers-btn-text pers-btn-primary pt-connect-btn"
          onClick={toggleConnect}
          disabled={connecting}
        >
          {connecting ? '…' : partner.running ? 'Disconnect' : 'Connect'}
        </button>
        <span className="pers-form-actions-spacer" />
        <button className="pers-btn pers-btn-text pers-btn-danger" onClick={del}>Remove</button>
      </div>
    </div>
  );
}

function Tile({
  partner,
  active,
  onSelect,
  onInvite,
}: {
  partner: PartnerInstance;
  active: boolean;
  onSelect: () => void;
  onInvite: (btn: HTMLButtonElement) => void;
}) {
  const isNetwork = partner.connectionType === 'network';
  let dotClass: string;
  let statusText: string;
  if (isNetwork) {
    dotClass = partner.running ? 'partner-dot-on' : 'partner-dot-off';
    statusText = partner.running ? 'connected (net)' : partner.host ? 'offline' : 'not configured';
  } else {
    dotClass = partner.running ? 'partner-dot-on' : partner.installed ? 'partner-dot-off' : 'partner-dot-na';
    statusText = partner.running ? 'connected' : partner.installed ? 'ready' : 'not installed';
  }
  const connLabel = isNetwork ? 'net' : 'local';
  return (
    <div className={`pers-tile${active ? ' active' : ''}`} onClick={onSelect}>
      <span className="pers-tile-av" style={{ background: resolveAvatarColor(partner.symbolColor) }}>
        {partner.name[0]?.toUpperCase()}
      </span>
      <span className="pers-tile-info">
        <span className="pers-tile-name">{partner.name}</span>
        <span className="pers-tile-role" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className={`partner-dot ${dotClass}`} style={{ width: 6, height: 6, borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />
          {statusText}
        </span>
        <span style={{ fontSize: '.7rem', color: 'var(--fg-dim)' }}>{partner.type} · {connLabel}</span>
      </span>
      {partner.exposeAsAgent && (
        <span className="pers-tile-mcp" title="Exposed via the agent-tools MCP server — other agents (Claude Code, Codex, API callers) can list and call this partner.">🛰</span>
      )}
      <button
        className="pers-tile-invite"
        title="Invite to session"
        onClick={(e) => { e.stopPropagation(); onInvite(e.currentTarget); }}
      >
        +
      </button>
    </div>
  );
}

function AddNetworkForm({
  typeInfo,
  onCreated,
  onCancel,
}: {
  typeInfo: AvailableType;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(18789);
  const [token, setToken] = useState('');
  const [agentId, setAgentId] = useState('main');
  const [hostError, setHostError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate() {
    if (!host.trim()) { setHostError(true); return; }
    setHostError(false);
    setSubmitting(true);
    try {
      const r = await fetch(api.config.baseUrl + '/v1/partners/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: typeInfo.type, name: name.trim() || undefined, host: host.trim(), port, token, agentId }),
      });
      const d = await r.json();
      if (!d.success) { toast.show('Error: ' + (d.error ?? r.status)); return; }
      onCreated(d.partner?.id ?? null);
    } catch (err) {
      toast.show('Error: ' + (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="pers-form" style={{ marginTop: 8, padding: '10px', border: '1px solid var(--stroke)', borderRadius: 6 }}>
      <div style={{ fontSize: '.8rem', fontWeight: 600, marginBottom: 8 }}>Add {typeInfo.label}</div>
      <div className="pers-field"><label>Name <span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}>(optional)</span></label>
        <input className="pers-input" type="text" value={name} placeholder="auto-named if blank" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="pers-field"><label>Host <span style={{ color: 'var(--accent)', fontWeight: 400 }}>*</span></label>
        <input
          className="pers-input"
          type="text"
          value={host}
          placeholder="100.x.x.x or hostname"
          style={hostError ? { borderColor: 'var(--danger, #e05c3a)' } : undefined}
          onChange={(e) => { setHost(e.target.value); if (e.target.value.trim()) setHostError(false); }}
        />
      </div>
      <div className="pers-field"><label>Port</label>
        <input className="pers-input" type="number" value={port} onChange={(e) => setPort(parseInt(e.target.value, 10) || 18789)} />
      </div>
      <div className="pers-field"><label>Token</label>
        <input className="pers-input" type="password" value={token} placeholder="from openclaw.json on remote" onChange={(e) => setToken(e.target.value)} />
      </div>
      <div className="pers-field"><label>Agent ID</label>
        <input className="pers-input" type="text" value={agentId} placeholder="main" onChange={(e) => setAgentId(e.target.value)} />
      </div>
      <div className="pers-form-actions">
        <button className="pers-btn pers-btn-text pers-btn-primary" onClick={handleCreate} disabled={submitting}>
          {submitting ? '…' : 'Create'}
        </button>
        <button className="pers-btn pers-btn-text" onClick={onCancel} disabled={submitting}>Cancel</button>
      </div>
    </div>
  );
}

export function PartnerPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [partners, setPartners] = useState<PartnerInstance[]>([]);
  const [availableTypes, setAvailableTypes] = useState<AvailableType[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addingNetworkType, setAddingNetworkType] = useState<AvailableType | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(api.config.baseUrl + '/v1/partners/');
      if (r.ok) {
        const d = (await r.json()) as PartnersResponse;
        setPartners(d.partners ?? []);
        setAvailableTypes(d.availableTypes ?? []);
      }
    } catch {}
    finally { setLoading(false); }
  }, []);

  // Re-fetch on open transitions so data stays fresh across re-opens.
  useEffect(() => { if (open) load(); }, [open, load]);

  async function quickAdd(type: string) {
    try {
      const r = await fetch(api.config.baseUrl + '/v1/partners/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      const d = await r.json();
      if (!d.success) { toast.show('Error: ' + (d.error ?? r.status)); return; }
      const newId = d.partner?.id ?? null;
      await load();
      if (newId) setActiveId(newId);
    } catch (err) {
      toast.show('Error: ' + (err as Error).message);
    }
  }

  async function invite(partnerId: string, btn: HTMLButtonElement) {
    const orig = btn.textContent;
    btn.textContent = '…';
    btn.disabled = true;
    const sessionId = getAppState().currentSession;
    try {
      const r = await fetch(
        api.config.baseUrl + `/v1/sessions/${encodeURIComponent(String(sessionId))}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employeeId: partnerId }),
        },
      );
      const d = await r.json();
      if (!r.ok || !d.success) {
        toast.show('Error: ' + (d.error ?? r.status));
      } else {
        btn.textContent = '✓';
        const cache = session?.getCached?.() ?? [];
        const cached = cache.find((s: { id: unknown }) => String(s.id) === String(sessionId));
        if (cached && Array.isArray(d.participants)) cached.participants = d.participants;
        getSessionActions().bumpParticipantsRevision();
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
        return;
      }
    } catch (err) {
      toast.show('Error: ' + (err as Error).message);
    }
    btn.textContent = orig;
    btn.disabled = false;
  }

  const activePartner = activeId ? partners.find((p) => p.id === activeId) : null;
  const addable = availableTypes.filter((t) => {
    if (!t.installed) return false;
    const count = typeof t.count === 'number' ? t.count : partners.filter((p) => p.type === t.type).length;
    const cap = typeof t.maxInstances === 'number' ? t.maxInstances : 1;
    return count < cap;
  });

  const body = !open ? null : loading && partners.length === 0 ? (
    <div className="hs-loading">Loading…</div>
  ) : (
    <>
      <div className="pers-list">
        {partners.length === 0 ? (
          <div className="pers-empty">No partners configured yet.</div>
        ) : (
          partners.map((p) => (
            <Tile
              key={p.id}
              partner={p}
              active={activeId === p.id}
              onSelect={() => setActiveId(activeId === p.id ? null : p.id)}
              onInvite={(btn) => invite(p.id, btn)}
            />
          ))
        )}
      </div>
      <div className="pers-form-wrap">
        {activePartner && (
          <EditForm
            key={activePartner.id}
            partner={activePartner}
            onSaved={load}
            onDeleted={() => { setActiveId(null); load(); }}
            onConnectToggle={load}
          />
        )}
      </div>
      {addable.map((t) => {
        const cap = t.maxInstances ?? 1;
        const count = t.count ?? partners.filter((p) => p.type === t.type).length;
        const remainingHint = cap > 1 ? ` (${count}/${cap})` : '';
        const isNetwork = t.connectionType === 'network';

        if (isNetwork) {
          if (addingNetworkType?.type === t.type) {
            return (
              <AddNetworkForm
                key={t.type}
                typeInfo={t}
                onCreated={async (id) => {
                  setAddingNetworkType(null);
                  await load();
                  if (id) setActiveId(id);
                }}
                onCancel={() => setAddingNetworkType(null)}
              />
            );
          }
          return (
            <button
              key={t.type}
              className="pers-new-btn pt-add-type-btn"
              style={{ marginTop: 4 }}
              onClick={() => setAddingNetworkType(t)}
            >
              + Add {t.label}{remainingHint}
            </button>
          );
        }

        return (
          <button
            key={t.type}
            className="pers-new-btn pt-add-type-btn"
            style={{ marginTop: 4 }}
            onClick={() => quickAdd(t.type)}
          >
            + Add {t.label}{remainingHint}
          </button>
        );
      })}
    </>
  );

  return (
    <div className={`hs-section${open ? ' hs-open' : ''}`} id="hs-partner">
      <button
        className={`hm-item hs-toggle${open ? ' hs-open' : ''}`}
        id="btn-partner"
        title="Partner agents (Hermes, …)"
        onClick={onToggle}
      >
        <span className="hm-icon" aria-hidden="true">
          <svg
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <rect x="16" y="16" width="6" height="6" rx="1" />
            <rect x="2" y="16" width="6" height="6" rx="1" />
            <rect x="9" y="2" width="6" height="6" rx="1" />
            <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
            <path d="M12 12V8" />
          </svg>
        </span>
        partner
      </button>
      <div className={`hs-body${open ? ' hs-open' : ''}`} id="partner-panel">
        {body}
      </div>
    </div>
  );
}
