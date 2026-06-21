import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { liveSave } from '../util/liveSave.js';
import { confirm as confirmDialog } from '../stores/confirmStore.js';

interface McpServer {
  name: string;
  kind?: 'internal' | 'external';
  running: boolean;
  ok?: boolean;
  tools?: { name: string; desc: string }[];
  prompts?: { name: string; desc: string }[];
  resources?: { uri: string; name: string; desc?: string }[];
  args?: string[];
  command?: string;
  transport?: 'stdio' | 'http';
  url?: string;
  error?: string;
}

interface SharingResp {
  enabled?: boolean;
  gatewayMode?: 'direct' | 'search';
  tools?: number;
  prompts?: number;
  resources?: number;
  activeUpstreams?: number;
  connection?: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

interface ConfigResp {
  config?: {
    defaults?: {
      notebooklm_bin?: string;
      playwright_real_url?: string;
      playwright_default_mode?: string;
    };
  };
}

interface McpResp {
  servers?: McpServer[];
}

type AudienceValue = 'all' | 'chat-only' | 'pet-only';
interface AudienceServerEntry {
  resolved: AudienceValue;
  default: AudienceValue;
  override: AudienceValue | null;
}
interface AudienceResp {
  petActive?: boolean;
  servers?: Record<string, AudienceServerEntry>;
}

// External source definition (mirrors mcp-external-sources/lib/store.ts).
interface ExternalSource {
  id: string;
  label: string;
  transport:
    | { type: 'stdio'; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
    | { type: 'http'; url: string; auth?: 'none' | 'bearer' | 'oauth'; tokenEnv?: string; token?: string; headers?: Record<string, string> };
  enabledByDefault?: boolean;
  audienceDefault?: AudienceValue;
  trust?: 'trusted' | 'ask' | 'disabled';
  allowWrite?: boolean;
  origin?: 'manual' | 'import' | 'registry';
  addedAt?: string;
}
interface SourcesResp {
  sources?: ExternalSource[];
}

// Gateway tool-call audit entry (mirrors mcp-client/lib/audit.ts).
interface AuditEntry {
  t: string;
  server: string;
  tool: string;
  kind?: 'internal' | 'external';
  status?: 'ok' | 'denied' | 'error';
  reason?: string;
  session?: string;
  args?: string;
}

const TRUST_LABELS: Record<NonNullable<ExternalSource['trust']>, string> = {
  trusted:  'Trusted (read + write)',
  ask:      'Limited (read only)',
  disabled: 'Disabled (block all)',
};

const AUDIENCE_LABELS: Record<AudienceValue, string> = {
  'all':       'Chat + Pet (all)',
  'chat-only': 'Chat only',
  'pet-only':  'Pet only',
};

type SubTab = 'internal' | 'external' | 'gateway';

function ServerCard({
  srv,
  audience,
  petActive,
  onStartStop,
  onAudienceChange,
  onRemove,
  originBadge,
  sourceDef,
  onUpdateSource,
}: {
  srv: McpServer;
  audience: AudienceServerEntry | undefined;
  petActive: boolean;
  onStartStop: (name: string, action: 'start' | 'stop') => Promise<void>;
  onAudienceChange: (name: string, value: AudienceValue | null) => Promise<void>;
  onRemove?: (name: string) => Promise<void>;
  originBadge?: string;
  // Present only for external sources — drives the trust/write security row.
  sourceDef?: ExternalSource;
  onUpdateSource?: (id: string, patch: Partial<ExternalSource>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const running = srv.running;
  const dotClass = srv.ok ? 'ok' : running ? 'starting' : 'stopped';
  const statusLabel = srv.ok ? 'Running' : running ? 'Starting…' : 'Stopped';
  const toolCount = srv.tools?.length || 0;
  const promptCount = srv.prompts?.length || 0;
  const resourceCount = srv.resources?.length || 0;
  const argsStr = (srv.args || []).join(' ');

  const summaryParts: string[] = [];
  if (toolCount) summaryParts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`);
  if (promptCount) summaryParts.push(`${promptCount} prompt${promptCount !== 1 ? 's' : ''}`);
  if (resourceCount) summaryParts.push(`${resourceCount} resource${resourceCount !== 1 ? 's' : ''}`);
  const summaryStr = summaryParts.join(' · ');

  const resources = srv.resources || [];
  const visibleResources = resources.slice(0, 50);
  const extraResources = resources.length > 50 ? resources.length - 50 : 0;

  async function handleActionClick(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await onStartStop(srv.name, running ? 'stop' : 'start');
    } catch {
      setBusy(false);
    }
  }

  async function handleRemoveClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!onRemove) return;
    setBusy(true);
    try { await onRemove(srv.name); }
    finally { setBusy(false); }
  }

  return (
    <div className="mcp-server-card" data-srv={srv.name}>
      <div
        className="mcp-server-header"
        data-srv={srv.name}
        style={{ cursor: 'pointer' }}
        title="Click to toggle details"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`mcp-status-dot ${dotClass}`} title={statusLabel} />
        <span className="mcp-server-name">{srv.name}</span>
        {originBadge && (
          <span className="dim" style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, border: '1px solid rgba(255,255,255,.12)' }}>{originBadge}</span>
        )}
        {sourceDef && (sourceDef.trust === 'disabled'
          ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, color: 'var(--danger)', border: '1px solid rgba(255,91,110,.3)' }}>blocked</span>
          : sourceDef.allowWrite
            ? <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, color: '#e0b400', border: '1px solid rgba(224,180,0,.35)' }} title="Write/destructive tools are permitted for this source">write</span>
            : <span className="dim" style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, border: '1px solid rgba(255,255,255,.12)' }} title="Only read-only tools are permitted">read-only</span>
        )}
        {running && summaryStr && <span className="mcp-tool-count">{summaryStr}</span>}
        <span className="mcp-status-label">{statusLabel}</span>
        <div style={{ flex: 1 }} />
        {onRemove && (
          <button
            className="prefs-btn"
            style={{ padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'rgba(255,91,110,.3)' }}
            disabled={busy}
            onClick={handleRemoveClick}
            title="Remove this external source"
          >
            Remove
          </button>
        )}
        <button
          className="prefs-btn"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: running ? 'var(--danger)' : 'var(--accent)',
            borderColor: running ? 'rgba(255,91,110,.3)' : 'rgba(0,224,138,.3)',
          }}
          disabled={busy}
          onClick={handleActionClick}
        >
          {busy ? (running ? 'Stopping…' : 'Starting…') : (running ? 'Stop' : 'Start')}
        </button>
        <span className="mcp-expand-btn" aria-hidden="true">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="mcp-server-details" id={`mcp-det-${srv.name}`}>
          {petActive && audience && (
            <div className="mcp-detail-row" style={{ alignItems: 'center' }}>
              <span className="mcp-detail-lbl">Audience</span>
              <select
                className="prefs-input"
                style={{ padding: '3px 6px', fontSize: 11, maxWidth: 220 }}
                value={audience.override ?? audience.default}
                onChange={(e) => {
                  const next = e.target.value as AudienceValue;
                  const value: AudienceValue | null = next === audience.default ? null : next;
                  void onAudienceChange(srv.name, value);
                }}
              >
                <option value="all">{AUDIENCE_LABELS['all']}</option>
                <option value="chat-only">{AUDIENCE_LABELS['chat-only']}</option>
                <option value="pet-only">{AUDIENCE_LABELS['pet-only']}</option>
              </select>
              <span className="dim" style={{ fontSize: 11, marginLeft: 8 }}>
                {audience.override
                  ? `overridden (default: ${AUDIENCE_LABELS[audience.default]})`
                  : `default`}
              </span>
            </div>
          )}
          {sourceDef && onUpdateSource && (
            <>
              <div className="mcp-detail-row" style={{ alignItems: 'center' }}>
                <span className="mcp-detail-lbl">Trust</span>
                <select
                  className="prefs-input"
                  style={{ padding: '3px 6px', fontSize: 11, maxWidth: 220 }}
                  value={sourceDef.trust ?? 'ask'}
                  onChange={(e) => void onUpdateSource(sourceDef.id, { trust: e.target.value as ExternalSource['trust'] })}
                >
                  <option value="trusted">{TRUST_LABELS.trusted}</option>
                  <option value="ask">{TRUST_LABELS.ask}</option>
                  <option value="disabled">{TRUST_LABELS.disabled}</option>
                </select>
              </div>
              <div className="mcp-detail-row" style={{ alignItems: 'center' }}>
                <span className="mcp-detail-lbl">Write tools</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: sourceDef.trust === 'disabled' ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!sourceDef.allowWrite}
                    disabled={sourceDef.trust === 'disabled'}
                    onChange={(e) => void onUpdateSource(sourceDef.id, { allowWrite: e.target.checked })}
                  />
                  Allow write/destructive tools through the gateway
                </label>
              </div>
              <div className="dim" style={{ fontSize: 11, padding: '0 0 4px', lineHeight: 1.5 }}>
                Read-only tools always pass while the source is enabled. Write/destructive tools are blocked unless allowed above; classification uses the server's own annotations, falling back to the tool name.
              </div>
            </>
          )}
          <div className="mcp-detail-row">
            <span className="mcp-detail-lbl">{srv.transport === 'http' ? 'URL' : 'Command'}</span>
            <code className="mcp-detail-val">{srv.transport === 'http' ? (srv.url || (sourceDef?.transport.type === 'http' ? (sourceDef.transport as any).url : '')) : `${srv.command || ''} ${argsStr}`}</code>
          </div>
          {srv.error && (
            <div className="mcp-detail-row">
              <span className="mcp-detail-lbl">Error</span>
              <span className="mcp-detail-val" style={{ color: 'var(--danger)' }}>{srv.error}</span>
            </div>
          )}
          {(srv.tools || []).length > 0 && (
            <>
              <div className="mcp-detail-lbl" style={{ marginTop: 10, marginBottom: 4 }}>Tools</div>
              {(srv.tools || []).map((t) => (
                <div key={t.name} className="mcp-tool-row">
                  <code className="mcp-tool-name">{t.name}</code>
                  <span className="mcp-tool-desc">{t.desc}</span>
                </div>
              ))}
            </>
          )}
          {(srv.prompts || []).length > 0 && (
            <>
              <div className="mcp-detail-lbl" style={{ marginTop: 10, marginBottom: 4 }}>Prompts</div>
              {(srv.prompts || []).map((p) => (
                <div key={p.name} className="mcp-tool-row">
                  <code className="mcp-tool-name">{p.name}</code>
                  <span className="mcp-tool-desc">{p.desc}</span>
                </div>
              ))}
            </>
          )}
          {visibleResources.length > 0 && (
            <>
              <div className="mcp-detail-lbl" style={{ marginTop: 10, marginBottom: 4 }}>Resources</div>
              {visibleResources.map((r) => (
                <div key={r.uri} className="mcp-tool-row">
                  <code className="mcp-tool-name">{r.name}</code>
                  <span className="mcp-tool-desc">{r.desc || r.uri}</span>
                </div>
              ))}
              {extraResources > 0 && (
                <div className="dim" style={{ fontSize: 11, padding: '4px 0' }}>…and {extraResources} more</div>
              )}
            </>
          )}
          {running && !toolCount && !promptCount && !resourceCount && (
            <div className="dim" style={{ fontSize: 11, padding: '4px 0' }}>No tools, prompts, or resources discovered</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── External Sources: add-a-source form (stdio) ───────────────────────────────
function AddExternalForm({ base, onAdded }: { base: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [command, setCommand] = useState('');
  const [argsStr, setArgsStr] = useState('');
  const [envStr, setEnvStr] = useState('');
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  async function submit() {
    setErr('');
    if (!id.trim() || !command.trim()) { setErr('id and command are required'); return; }
    setBusy(true);
    try {
      const env = parseEnv(envStr);
      const body = {
        id: id.trim(),
        label: id.trim(),
        enabledByDefault: autostart,
        transport: {
          type: 'stdio',
          command: command.trim(),
          args: argsStr.trim() ? argsStr.trim().split(/\s+/) : [],
          ...(Object.keys(env).length ? { env } : {}),
        },
      };
      const r = await fetch(base + '/v1/mcp/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.success) { setErr(data?.error || 'failed to add source'); setBusy(false); return; }
      setId(''); setCommand(''); setArgsStr(''); setEnvStr(''); setAutostart(false);
      setOpen(false);
      await onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcp-server-card" style={{ marginBottom: 10 }}>
      <div className="mcp-server-header" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <span className="mcp-server-name">＋ Add local (stdio) MCP</span>
        <div style={{ flex: 1 }} />
        <span className="mcp-expand-btn" aria-hidden="true">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="mcp-server-details">
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90 }}>Name / id</label>
            <input className="prefs-input flex1" value={id} placeholder="github" onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90 }}>Command</label>
            <input className="prefs-input flex1" value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90 }}>Arguments</label>
            <input className="prefs-input flex1" value={argsStr} placeholder="-y @modelcontextprotocol/server-github" onChange={(e) => setArgsStr(e.target.value)} />
          </div>
          <div className="prefs-row" style={{ alignItems: 'flex-start', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90, marginTop: 6 }}>Env vars</label>
            <textarea
              className="prefs-input flex1"
              value={envStr}
              placeholder={'GITHUB_TOKEN=ghp_...\nONE_PER_LINE=value'}
              rows={3}
              style={{ fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
              onChange={(e) => setEnvStr(e.target.value)}
            />
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
              Autostart (otherwise added stopped — recommended for review first)
            </label>
          </div>
          {err && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="prefs-btn" style={{ padding: '5px 12px', color: 'var(--accent)', borderColor: 'rgba(0,224,138,.3)' }} disabled={busy} onClick={() => void submit()}>
              {busy ? 'Adding…' : 'Add source'}
            </button>
            <button className="prefs-btn" style={{ padding: '5px 12px' }} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}


// ── External Sources: add a remote HTTP MCP endpoint ─────────────────────────
function AddRemoteForm({ base, onAdded }: { base: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'bearer' | 'oauth'>('none');
  const [tokenEnv, setTokenEnv] = useState('');
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (!id.trim() || !url.trim()) { setErr('id and URL are required'); return; }
    setBusy(true);
    try {
      const body = {
        id: id.trim(),
        label: id.trim(),
        enabledByDefault: autostart,
        transport: {
          type: 'http',
          url: url.trim(),
          auth,
          ...(tokenEnv.trim() ? { tokenEnv: tokenEnv.trim() } : {}),
        },
      };
      const r = await fetch(base + '/v1/mcp/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.success) { setErr(data?.error || 'failed to add remote source'); setBusy(false); return; }
      setId(''); setUrl(''); setAuth('none'); setTokenEnv(''); setAutostart(false); setOpen(false);
      await onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcp-server-card" style={{ marginBottom: 10 }}>
      <div className="mcp-server-header" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <span className="mcp-server-name">＋ Add remote (HTTP) MCP</span>
        <div style={{ flex: 1 }} />
        <span className="mcp-expand-btn" aria-hidden="true">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="mcp-server-details">
          <p className="dim" style={{ fontSize: 11, margin: '6px 0' }}>
            Connect to a remote Streamable-HTTP MCP endpoint. Bearer auth can read a token from an environment variable; OAuth sources are stored now and will use a completed token flow when configured.
          </p>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90 }}>Name / id</label>
            <input className="prefs-input flex1" value={id} placeholder="company-registry" onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90 }}>Endpoint URL</label>
            <input className="prefs-input flex1" value={url} placeholder="https://example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 90 }}>Auth</label>
            <select className="prefs-input" value={auth} onChange={(e) => setAuth(e.target.value as any)}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="oauth">OAuth (token-flow ready)</option>
            </select>
            {(auth === 'bearer' || auth === 'oauth') && (
              <input className="prefs-input flex1" value={tokenEnv} placeholder="TOKEN_ENV_VAR (recommended)" onChange={(e) => setTokenEnv(e.target.value)} />
            )}
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
              Autostart (otherwise added stopped — recommended for review first)
            </label>
          </div>
          {err && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="prefs-btn" style={{ padding: '5px 12px', color: 'var(--accent)', borderColor: 'rgba(0,224,138,.3)' }} disabled={busy} onClick={() => void submit()}>
              {busy ? 'Adding…' : 'Add remote'}
            </button>
            <button className="prefs-btn" style={{ padding: '5px 12px' }} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── External Sources: official registry discovery ────────────────────────────
function DiscoverExternalForm({ base, onImported }: { base: string; onImported: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [err, setErr] = useState('');

  async function search() {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(`${base}/v1/mcp/sources/discover?q=${encodeURIComponent(q)}&limit=20`);
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.success) { setErr(data?.error || 'registry search failed'); return; }
      setResults(data.results || []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function add(cand: any) {
    setErr(''); setBusy(true);
    try {
      const r = await fetch(base + '/v1/mcp/sources/import-discovered', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate: cand }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.success) { setErr(data?.error || 'import failed'); return; }
      await onImported();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="mcp-server-card" style={{ marginBottom: 10 }}>
      <div className="mcp-server-header" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <span className="mcp-server-name">⌕ Discover from official registry</span>
        <div style={{ flex: 1 }} />
        <span className="mcp-expand-btn" aria-hidden="true">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="mcp-server-details">
          <div className="prefs-row" style={{ gap: 8, alignItems: 'center' }}>
            <input className="prefs-input flex1" value={q} placeholder="Search MCP servers…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
            <button className="prefs-btn" disabled={busy} onClick={() => void search()}>{busy ? 'Searching…' : 'Search'}</button>
          </div>
          {err && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>{err}</div>}
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {results.map((r) => (
              <div key={r.name} className="mcp-tool-row" style={{ alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <code className="mcp-tool-name">{r.label || r.name}</code>
                  <span className="mcp-tool-desc">{r.description || r.name}</span>
                  {r.transport && <div className="dim" style={{ fontSize: 10 }}>{r.transport.type === 'http' ? r.transport.url : `${r.transport.command} ${(r.transport.args || []).join(' ')}`}</div>}
                </div>
                <button className="prefs-btn" style={{ padding: '3px 8px', fontSize: 11 }} disabled={busy || !r.transport} onClick={() => void add(r)}>{r.transport ? 'Add stopped' : 'No recipe'}</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── External Sources: paste / import an mcpServers config ─────────────────────
function ImportExternalForm({ base, onImported }: { base: string; onImported: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function submit() {
    setErr(''); setMsg('');
    if (!text.trim()) { setErr('paste an MCP config first'); return; }
    setBusy(true);
    try {
      const r = await fetch(base + '/v1/mcp/sources/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: text }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.success) { setErr(data?.error || 'import failed'); setBusy(false); return; }
      const added = (data.added || []).length;
      const skipped = (data.skipped || []) as { id: string; reason: string }[];
      setMsg(`Imported ${added} source${added !== 1 ? 's' : ''} (added stopped).` + (skipped.length ? ` Skipped ${skipped.length}: ${skipped.map((s) => s.id).join(', ')}.` : ''));
      setText('');
      await onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcp-server-card" style={{ marginBottom: 10 }}>
      <div className="mcp-server-header" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <span className="mcp-server-name">⇪ Import from config (Claude / Cursor / Codex)</span>
        <div style={{ flex: 1 }} />
        <span className="mcp-expand-btn" aria-hidden="true">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="mcp-server-details">
          <p className="dim" style={{ fontSize: 11, margin: '6px 0' }}>
            Paste a <code>{'{ "mcpServers": { … } }'}</code> block from another host's config (or a bare server map). Each server is added <strong>stopped</strong> so you can review the command before anything runs.
          </p>
          <textarea
            className="prefs-input flex1"
            value={text}
            placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'}
            rows={8}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
            onChange={(e) => setText(e.target.value)}
          />
          {err && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>{err}</div>}
          {msg && <div style={{ color: 'var(--accent)', fontSize: 11, marginTop: 8 }}>{msg}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="prefs-btn" style={{ padding: '5px 12px', color: 'var(--accent)', borderColor: 'rgba(0,224,138,.3)' }} disabled={busy} onClick={() => void submit()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
            <button className="prefs-btn" style={{ padding: '5px 12px' }} disabled={busy} onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── External Sources: gateway tool-call audit ("Recent activity") ─────────────
// Read-only tail of /v1/mcp/audit — every tools/call that crossed the MCP-Tools
// gateway with its policy outcome. Denied/error rows are highlighted so a
// blocked external write tool is obvious. Lazy-loads on first expand.
function AuditPanel({ base }: { base: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch(base + '/v1/mcp/audit?limit=100').then((x) => x.json()).catch(() => null);
      setEntries((r?.entries as AuditEntry[]) || []);
    } finally {
      setBusy(false);
    }
  }, [base]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const statusColor = (s?: string) => (s === 'denied' ? 'var(--danger)' : s === 'error' ? '#e0b400' : 'var(--accent)');

  return (
    <div className="mcp-server-card" style={{ marginTop: 18 }}>
      <div className="mcp-server-header" style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <span className="mcp-server-name">Recent activity <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>(gateway tool-call audit)</span></span>
        <div style={{ flex: 1 }} />
        {open && (
          <button className="prefs-btn" style={{ padding: '4px 10px', fontSize: 11 }} disabled={busy} onClick={(e) => { e.stopPropagation(); void refresh(); }}>↻ Refresh</button>
        )}
        <span className="mcp-expand-btn" aria-hidden="true">{open ? '▼' : '▶'}</span>
      </div>
      {open && (
        <div className="mcp-server-details">
          {entries.length === 0 ? (
            <div className="dim" style={{ padding: '12px 0', fontSize: 12 }}>
              {busy ? 'Loading…' : 'No tool calls recorded yet. Calls through the MCP-Tools gateway appear here with their allow/deny outcome.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
              {entries.map((e, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
                  <span className="dim" style={{ minWidth: 64, fontVariantNumeric: 'tabular-nums' }}>{new Date(e.t).toLocaleTimeString()}</span>
                  <span style={{ minWidth: 56, fontWeight: 600, color: statusColor(e.status) }}>{e.status || 'ok'}</span>
                  {e.kind === 'external' && <span className="dim" style={{ fontSize: 9, padding: '0 4px', borderRadius: 3, border: '1px solid rgba(255,255,255,.12)' }}>ext</span>}
                  <code style={{ color: '#cdd' }}>{e.server}__{e.tool}</code>
                  <span className="dim" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.reason || e.args}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TabMcp() {
  const base = api.config.baseUrl as string;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [subTab, setSubTab] = useState<SubTab>('internal');

  const [nlmBin, setNlmBin] = useState('');
  const [pwRealUrl, setPwRealUrl] = useState('');
  const [pwDefaultMode, setPwDefaultMode] = useState('auto');
  const [sharing, setSharing] = useState<SharingResp>({ enabled: true, tools: 0, prompts: 0, resources: 0, activeUpstreams: 0 });
  const [servers, setServers] = useState<McpServer[]>([]);
  const [sources, setSources] = useState<ExternalSource[]>([]);
  const [shareBusy, setShareBusy] = useState(false);
  const [audience, setAudience] = useState<AudienceResp>({ petActive: false, servers: {} });

  const nlmStatusRef = useRef<HTMLSpanElement>(null);
  const pwUrlStatusRef = useRef<HTMLSpanElement>(null);
  const pwModeStatusRef = useRef<HTMLSpanElement>(null);
  const snippetRef = useRef<HTMLPreElement>(null);
  const claudeCmdRef = useRef<HTMLElement>(null);

  const nlmLiveRef = useRef<ReturnType<typeof liveSave> | null>(null);
  const pwUrlLiveRef = useRef<ReturnType<typeof liveSave> | null>(null);
  const pwModeLiveRef = useRef<ReturnType<typeof liveSave> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [configResp, mcpResp, sharingResp, audienceResp, sourcesResp] = await Promise.all([
        fetch(base + '/v1/config/').then((r) => r.json()) as Promise<ConfigResp>,
        fetch(base + '/v1/mcp/').then((r) => r.json()) as Promise<McpResp>,
        fetch(base + '/v1/mcp/external-sharing').then((r) => r.json()).catch(() => ({ enabled: true, tools: 0, prompts: 0, resources: 0, activeUpstreams: 0 })) as Promise<SharingResp>,
        fetch(base + '/v1/mcp/audience').then((r) => r.json()).catch(() => ({ petActive: false, servers: {} })) as Promise<AudienceResp>,
        fetch(base + '/v1/mcp/sources').then((r) => r.json()).catch(() => ({ sources: [] })) as Promise<SourcesResp>,
      ]);
      setNlmBin(configResp.config?.defaults?.notebooklm_bin || '');
      setPwRealUrl(configResp.config?.defaults?.playwright_real_url || '');
      setPwDefaultMode(configResp.config?.defaults?.playwright_default_mode || 'auto');
      setSharing(sharingResp);
      setServers(mcpResp.servers || []);
      setAudience(audienceResp || { petActive: false, servers: {} });
      setSources(sourcesResp.sources || []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    const configEndpoint = base + '/v1/config/';

    const nlmGroup = liveSave({
      endpoint: configEndpoint,
      statusEl: nlmStatusRef.current,
      buildBody: (p) => ({ defaults: p }),
      errorLabel: 'NotebookLM bin save failed',
    });
    nlmLiveRef.current = nlmGroup;

    const pwUrlGroup = liveSave({
      endpoint: configEndpoint,
      statusEl: pwUrlStatusRef.current,
      buildBody: (p) => ({ defaults: p }),
      errorLabel: 'CDP URL save failed',
    });
    pwUrlLiveRef.current = pwUrlGroup;

    const pwModeGroup = liveSave({
      endpoint: configEndpoint,
      statusEl: pwModeStatusRef.current,
      buildBody: (p) => ({ defaults: p }),
      errorLabel: 'Default mode save failed',
    });
    pwModeLiveRef.current = pwModeGroup;

    return () => {
      void nlmGroup.flush();
      void pwUrlGroup.flush();
      void pwModeGroup.flush();
    };
  }, [base, loading, subTab]);

  async function handleShareToggle(enable: boolean) {
    setShareBusy(true);
    try {
      await fetch(base + '/v1/mcp/external-sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enable }),
      });
      await load();
    } catch {
      setShareBusy(false);
    }
  }

  async function handleGatewayMode(mode: 'direct' | 'search') {
    // Optimistic: the switch is a cheap runtime flag with no respawn.
    setSharing((s) => ({ ...s, gatewayMode: mode }));
    try {
      await fetch(base + '/v1/mcp/gateway-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    } catch {
      await load();
    }
  }

  async function handleStartStop(name: string, action: 'start' | 'stop') {
    let resp: { success?: boolean; running?: boolean; ok?: boolean; error?: string } | null = null;
    try {
      const r = await fetch(base + '/v1/mcp/' + encodeURIComponent(name) + '/' + action, { method: 'POST' });
      resp = await r.json().catch(() => null);
    } catch {
      resp = null;
    }
    await load();
    // A start that was accepted but didn't bring the process up: surface it
    // loudly instead of letting the row quietly sit on "Stopped". The server
    // stays in the desired set and the supervisor keeps retrying in the
    // background; "Retry now" forces an immediate attempt.
    if (action === 'start' && resp && resp.running === false) {
      const retry = await confirmDialog({
        scope: `mcp-start-fail:${name}`,
        title: `“${name}” didn’t start`,
        message: resp.error
          ? `${resp.error}  ·  YHA will keep retrying it in the background.`
          : `“${name}” was started but didn’t come up. YHA will keep retrying it in the background.`,
        confirmLabel: 'Retry now',
        cancelLabel: 'Dismiss',
        danger: true,
        trustMs: 0,
      });
      if (retry) await handleStartStop(name, 'start');
    }
  }

  async function handleAudienceChange(name: string, value: AudienceValue | null) {
    await fetch(base + '/v1/mcp/' + encodeURIComponent(name) + '/audience', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audience: value }),
    });
    await load();
  }

  async function handleUpdateSource(id: string, patch: Partial<ExternalSource>) {
    // Optimistic: reflect the new posture immediately so the toggle feels live,
    // then PATCH and reconcile with the server's authoritative copy.
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    await fetch(base + '/v1/mcp/sources/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    await load();
  }

  async function handleRemoveSource(name: string) {
    const ok = await confirmDialog({
      scope: `mcp-remove-source:${name}`,
      title: `Remove “${name}”?`,
      message: `This stops the server (if running) and deletes the external source definition. It will no longer be available to YHA or any harness.`,
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
      danger: true,
      trustMs: 0,
    });
    if (!ok) return;
    await fetch(base + '/v1/mcp/sources/' + encodeURIComponent(name), { method: 'DELETE' });
    await load();
  }

  if (loading) return <div className="prefs-loading">Loading MCP status…</div>;
  if (error) return <div className="dim" style={{ padding: '16px 0' }}>Failed to reach bridge server.</div>;

  const internalServers = servers.filter((s) => s.kind !== 'external');
  const externalServers = servers.filter((s) => s.kind === 'external');
  const externalRunning = externalServers.filter((s) => s.running).length;

  const sharingEnabled = sharing.enabled !== false;
  const shareCounts: string[] = [];
  if (sharing.tools)     shareCounts.push(`${sharing.tools} tools`);
  if (sharing.prompts)   shareCounts.push(`${sharing.prompts} prompts`);
  if (sharing.resources) shareCounts.push(`${sharing.resources} resources`);
  const shareSummary = shareCounts.length
    ? shareCounts.join(' · ') + ` · from ${sharing.activeUpstreams || 0} upstream${sharing.activeUpstreams === 1 ? '' : 's'}`
    : `0 tools (no upstream MCPs running)`;
  const shareDot = sharingEnabled ? 'ok' : 'stopped';
  const shareStatus = sharingEnabled ? 'Sharing' : 'Stopped';

  const conn = sharing.connection || null;
  const connSnippet = conn
    ? JSON.stringify({ mcpServers: { [conn.name]: { command: conn.command, args: conn.args, env: conn.env } } }, null, 2)
    : '';
  const claudeAddCmd = conn
    ? `claude mcp add ${conn.name} -- ${conn.command} ${(conn.args || []).join(' ')}`
    : '';

  const tabBtn = (key: SubTab, label: string, count?: number) => (
    <button
      className="prefs-btn"
      style={{
        padding: '6px 14px',
        fontSize: 12,
        fontWeight: subTab === key ? 600 : 400,
        color: subTab === key ? 'var(--accent)' : 'var(--fg-dim)',
        borderColor: subTab === key ? 'rgba(0,224,138,.4)' : 'rgba(255,255,255,.1)',
        background: subTab === key ? 'rgba(0,224,138,.06)' : 'transparent',
      }}
      onClick={() => setSubTab(key)}
    >
      {label}{typeof count === 'number' ? <span className="dim" style={{ marginLeft: 6, fontSize: 11 }}>{count}</span> : null}
    </button>
  );

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid rgba(255,255,255,.08)', paddingBottom: 12 }}>
        {tabBtn('internal', 'Internal', internalServers.length)}
        {tabBtn('external', 'External', externalServers.length)}
        {tabBtn('gateway', 'Gateway')}
      </div>

      {subTab === 'gateway' && (
        <GatewayView
          sharingEnabled={sharingEnabled}
          shareDot={shareDot}
          shareStatus={shareStatus}
          shareSummary={shareSummary}
          shareBusy={shareBusy}
          onToggle={handleShareToggle}
          gatewayMode={sharing.gatewayMode === 'search' ? 'search' : 'direct'}
          onModeChange={handleGatewayMode}
          toolCount={sharing.tools || 0}
          conn={conn}
          connSnippet={connSnippet}
          claudeAddCmd={claudeAddCmd}
          snippetRef={snippetRef}
          claudeCmdRef={claudeCmdRef}
        />
      )}

      {subTab === 'external' && (
        <>
          <p className="dim" style={{ fontSize: 12, margin: '0 0 14px', lineHeight: 1.5 }}>
            Third-party / user-added MCP servers — connect tools from GitHub, databases, cloud services, or local scripts.
            External sources are added <strong>stopped</strong> and never autostart until you enable them. Once running, they flow
            into the same <code>MCP-Tools</code> gateway (Gateway tab) as the internal servers.
          </p>
          <AddExternalForm base={base} onAdded={load} />
          <AddRemoteForm base={base} onAdded={load} />
          <DiscoverExternalForm base={base} onImported={load} />
          <ImportExternalForm base={base} onImported={load} />
          <p className="dim" style={{ fontSize: 11, margin: '4px 0 4px' }}>
            Remote HTTP sources use the same trust/write gate and audit log as local stdio sources. OAuth entries are stored with an OAuth posture; full interactive token setup can layer onto that metadata.
          </p>

          <div className="prefs-row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '18px 0 4px 0' }}>
            <h4 className="prefs-sec" style={{ margin: 0 }}>External MCP Sources {externalServers.length ? `(${externalRunning}/${externalServers.length} active)` : ''}</h4>
            <button className="prefs-btn" style={{ padding: '5px 10px' }} onClick={() => void load()}>↻ Refresh</button>
          </div>
          {externalServers.length === 0 ? (
            <div className="dim" style={{ padding: '20px 0' }}>
              No external MCP sources yet. Add one above, or import an existing config.
            </div>
          ) : (
            <div className="mcp-server-list">
              {externalServers.map((srv) => {
                const def = sources.find((s) => s.id === srv.name);
                return (
                  <ServerCard
                    key={srv.name}
                    srv={srv}
                    audience={audience.servers?.[srv.name]}
                    petActive={!!audience.petActive}
                    onStartStop={handleStartStop}
                    onAudienceChange={handleAudienceChange}
                    onRemove={handleRemoveSource}
                    originBadge={def?.origin === 'import' ? 'imported' : def?.origin === 'registry' ? 'registry' : 'external'}
                    sourceDef={def}
                    onUpdateSource={handleUpdateSource}
                  />
                );
              })}
            </div>
          )}

          <AuditPanel base={base} />
        </>
      )}

      {subTab === 'internal' && (
        <>
          <h4 className="prefs-sec">NotebookLM MCP Server</h4>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 100 }}>Binary path</label>
            <input
              className="prefs-input flex1"
              id="prefs-nlm-bin"
              type="text"
              value={nlmBin}
              placeholder="Path to notebooklm executable..."
              onChange={(e) => {
                setNlmBin(e.target.value);
                nlmLiveRef.current?.patch({ notebooklm_bin: e.target.value.trim() });
              }}
            />
            <span ref={nlmStatusRef} className="prefs-live-status" id="prefs-status-nlm-bin" style={{ fontSize: 11, color: 'var(--fg-dim)', minWidth: 60 }} />
          </div>
          <div className="prefs-hint">Path to the notebooklm executable. After changing, restart the NotebookLM server below.</div>

          <h4 className="prefs-sec">Desktop Browser — YHA Browser (real Chrome via CDP)</h4>
          <div className="prefs-hint" style={{ marginBottom: 8 }}>
            Drives your real Chrome on Windows over the Chrome DevTools Protocol — real cookies, real fingerprint, real login sessions. Use this for sites that detect headless/stealth browsers (Twitter/X, Google, etc.). Pick the default mode and CDP URL below; expand the checklist for the one-time Windows setup.
          </div>

          <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 100 }}>Default mode</label>
            <select
              className="prefs-input"
              id="prefs-pw-default-mode"
              style={{ flex: 1 }}
              value={pwDefaultMode}
              onChange={(e) => {
                setPwDefaultMode(e.target.value);
                pwModeLiveRef.current?.patch({ playwright_default_mode: e.target.value });
              }}
            >
              <option value="auto">auto (recommended) — real if CDP URL reachable, else stealth fallback</option>
              <option value="real">real (force) — CDP-attach only; falls back to stealth if unreachable</option>
              <option value="stealth">stealth (force) — rebrowser-playwright + fingerprint patches</option>
              <option value="normal">normal (debug only) — vanilla Playwright, no anti-detection</option>
            </select>
            <span ref={pwModeStatusRef} className="prefs-live-status" id="prefs-status-pw-default-mode" style={{ fontSize: 11, color: 'var(--fg-dim)', minWidth: 60 }} />
          </div>

          <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 6 }}>
            <label className="prefs-field-lbl" style={{ minWidth: 100 }}>CDP URL</label>
            <input
              className="prefs-input flex1"
              id="prefs-pw-real-url"
              type="text"
              value={pwRealUrl}
              placeholder="http://192.168.1.42:9222"
              onChange={(e) => {
                setPwRealUrl(e.target.value);
                pwUrlLiveRef.current?.patch({ playwright_real_url: e.target.value.trim() });
              }}
            />
            <span ref={pwUrlStatusRef} className="prefs-live-status" id="prefs-status-pw-real-url" style={{ fontSize: 11, color: 'var(--fg-dim)', minWidth: 60 }} />
          </div>

          <details className="mcp-setup-details" style={{ margin: '8px 0 16px' }}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--accent)', userSelect: 'none', padding: '4px 0' }}>
              ▸ First-time setup (one-time on Windows)
            </summary>
            <div style={{ marginTop: 8, padding: '12px 14px', border: '1px solid rgba(255,255,255,.08)', borderRadius: 6, background: 'rgba(0,0,0,.18)', fontSize: 12, lineHeight: 1.55 }}>
              <div style={{ marginBottom: 10 }}>
                <strong>1. Create Desktop shortcut</strong> — right-click desktop → New → Shortcut. Paste as target (replace <code>UserName</code>; adjust chrome.exe path if needed). Name it <strong>YHA Browser</strong>:
              </div>
              <code style={{ display: 'block', padding: '8px 10px', margin: '0 0 12px', background: 'rgba(0,0,0,.45)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>
                {'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\UserName\\YHA-Browser"'}
              </code>
              <div style={{ marginBottom: 10 }}>
                <strong>2. Double-click the shortcut → log in once</strong> to Twitter/X, Google, etc. Sessions persist in <code>C:\Users\UserName\YHA-Browser</code>. Your everyday Chrome stays untouched (separate profile, both can run side-by-side).
              </div>
              <div style={{ marginBottom: 6 }}>
                <strong>3. Expose port 9222 to the LAN.</strong> Modern Chrome (≥111) <em>ignores</em> <code>--remote-debugging-address</code> for security and binds only to <code>127.0.0.1</code>. Use a Windows port proxy. PowerShell as Admin:
              </div>
              <code style={{ display: 'block', padding: '8px 10px', margin: '0 0 12px', background: 'rgba(0,0,0,.45)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>
                netsh interface portproxy add v4tov4 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1
              </code>
              <div style={{ marginBottom: 6 }}>
                <strong>4. Restrict who can reach 9222</strong> — Windows Firewall, allow only the YHA bridge. PowerShell as Admin:
              </div>
              <code style={{ display: 'block', padding: '8px 10px', margin: '0 0 4px', background: 'rgba(0,0,0,.45)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>
                {'New-NetFirewallRule -DisplayName "YHA-Browser CDP" -Direction Inbound -LocalPort 9222 -Protocol TCP -Action Allow -RemoteAddress <bridge-lan-ip>,<bridge-tailscale-ip>'}
              </code>
              <div style={{ fontSize: 11, color: '#9aa', marginBottom: 12 }}>
                <code>{'<bridge-lan-ip>'}</code> = the bridge host's LAN-IP (used when CDP URL is the Windows LAN-IP). <code>{'<bridge-tailscale-ip>'}</code> = the bridge host's Tailscale-IP (used when CDP URL is the Tailscale hostname). Drop the one you don't need.
              </div>
              <div style={{ marginBottom: 10 }}>
                <strong>5. Set CDP URL above</strong> to <code>{'http://<windows-lan-ip>:9222'}</code> (or <code>{'http://<tailscale-hostname>:9222'}</code>) → Save.
              </div>
              <div style={{ marginBottom: 0 }}>
                <strong>6. Pick Default mode "real"</strong> above (or call <code>set_mode "real"</code> per session). All <code>browse</code>/<code>click</code>/<code>fill</code> tools now drive your desktop Chrome.
              </div>
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)', fontSize: 11, lineHeight: 1.6, color: '#9aa' }}>
                <div><strong>Verify on Windows:</strong> <code>netstat -an | findstr 9222</code> → expect <code>127.0.0.1:9222</code> AND <code>0.0.0.0:9222</code> LISTENING.</div>
                <div style={{ marginTop: 3 }}><strong>Verify from Pi:</strong> <code>{'curl http://<windows-ip>:9222/json/version'}</code> → returns Chrome version JSON.</div>
                <div style={{ marginTop: 6 }}><strong>Reset profile:</strong> close YHA Browser, delete <code>C:\Users\UserName\YHA-Browser</code>.</div>
                <div style={{ marginTop: 3 }}><strong>Cleanup port proxy:</strong> <code>netsh interface portproxy delete v4tov4 listenport=9222 listenaddress=0.0.0.0</code></div>
                <div style={{ marginTop: 3 }}><strong>Cleanup firewall rule:</strong> <code>{'Remove-NetFirewallRule -DisplayName "YHA-Browser CDP"'}</code></div>
              </div>
            </div>
          </details>

          <h4 className="prefs-sec">Desktop Browser (Windows native) — YHA-managed Chromium with live screencast</h4>
          <div className="prefs-hint" style={{ marginBottom: 8 }}>
            Different MCP from the one above. This is the <code>web</code> server's Windows-native variant: YHA launches its own off-screen Chromium via Playwright (separate from your real Chrome) and streams JPEG frames over a localhost WebSocket into the BrowserWindow canvas — same in-app live-takeover UX as the Pi's KasmVNC, no Docker, no LAN port to expose. Sessions persist in <code>%LOCALAPPDATA%\YHA\desktop-browser</code> so logins survive restarts. Use this when you want a sandboxed browser YHA fully drives; use the <em>YHA Browser (CDP)</em> section above when you need your real Chrome's cookies/fingerprint.
          </div>

          <details className="mcp-setup-details" style={{ margin: '8px 0 16px' }}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--accent)', userSelect: 'none', padding: '4px 0' }}>
              ▸ How it works & first-time notes
            </summary>
            <div style={{ marginTop: 8, padding: '12px 14px', border: '1px solid rgba(255,255,255,.08)', borderRadius: 6, background: 'rgba(0,0,0,.18)', fontSize: 12, lineHeight: 1.55 }}>
              <div style={{ marginBottom: 10 }}>
                <strong>1. No setup steps.</strong> Start the <code>web</code> MCP from the list below (or let an agent call it). On first launch Playwright downloads Chromium into the YHA bridge's cache and creates the profile at:
              </div>
              <code style={{ display: 'block', padding: '8px 10px', margin: '0 0 12px', background: 'rgba(0,0,0,.45)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>
                %LOCALAPPDATA%\YHA\desktop-browser
              </code>
              <div style={{ marginBottom: 10 }}>
                <strong>2. Watch & drive it from the YHA Browser window</strong> (header → 🌐). The canvas shows live frames; click/type/scroll/paste all forward to the page. The 5-dot quality row in the header tunes <em>fps · JPEG quality · max dimension</em> — same control as the Pi flow, just JPEG-only (no H.264 column). Preference saves to <code>yha.browserWindow.quality</code> and survives across platforms.
              </div>
              <div style={{ marginBottom: 10 }}>
                <strong>3. Window is hidden by default.</strong> Chromium boots off-screen so the canvas is the source of truth. Call the MCP tool <code>show_window</code> to pop it on-screen for debugging; <code>hide_window</code> sends it back. The window is real, not headless — page features that detect headless mode work normally.
              </div>
              <div style={{ marginBottom: 10 }}>
                <strong>4. CDP port 9333</strong> (localhost-only). Picked to avoid the 9222 the section above uses for your real Chrome. The screencast itself is served at <code>/proxy/desktop-browser-stream</code> through go-core — also localhost-only, no firewall rule needed.
              </div>
              <div style={{ marginBottom: 10 }}>
                <strong>5. Separate from your real Chrome.</strong> Cookies and logins do <em>not</em> leak between the two browsers. If you want Gmail in both, sign in twice. Reset this profile by closing the MCP and deleting <code>%LOCALAPPDATA%\YHA\desktop-browser</code>.
              </div>
              <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,.08)', fontSize: 11, lineHeight: 1.6, color: '#9aa' }}>
                <div><strong>v1 limitations:</strong></div>
                <div style={{ marginTop: 3 }}>• IME composition (non-Latin keyboards) — ASCII works; composed input is not yet forwarded.</div>
                <div style={{ marginTop: 3 }}>• Page → user clipboard (outbound copy) — paste <em>into</em> the page works (Ctrl+V emits <code>insertText</code>); reading what the page copied back to your clipboard is not wired yet.</div>
                <div style={{ marginTop: 3 }}>• Synthetic cursor — drawn on the canvas because CDP screencast frames don't include the OS cursor.</div>
              </div>
            </div>
          </details>

          {internalServers.length === 0 ? (
            <div className="dim" style={{ padding: '20px 0' }}>
              No internal MCP servers registered.
            </div>
          ) : (
            <>
              <div className="prefs-row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '24px 0 4px 0' }}>
                <h4 className="prefs-sec" style={{ margin: 0 }}>Internal YHA MCP Sources</h4>
                <button className="prefs-btn" style={{ padding: '5px 10px' }} onClick={() => void load()}>↻ Refresh</button>
              </div>
              <p className="dim" style={{ fontSize: 11, margin: '0 0 10px' }}>
                Built into YHA and managed automatically — they power browser, memory, search, media, agent tools, and more. When the Gateway is on, they're aggregated and re-exposed externally as <code>MCP-Tools</code>.
              </p>
              <div className="mcp-server-list">
                {internalServers.map((srv) => (
                  <ServerCard
                    key={srv.name}
                    srv={srv}
                    audience={audience.servers?.[srv.name]}
                    petActive={!!audience.petActive}
                    onStartStop={handleStartStop}
                    onAudienceChange={handleAudienceChange}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function GatewayView({
  sharingEnabled, shareDot, shareStatus, shareSummary, shareBusy, onToggle,
  gatewayMode, onModeChange, toolCount,
  conn, connSnippet, claudeAddCmd, snippetRef, claudeCmdRef,
}: {
  sharingEnabled: boolean;
  shareDot: string;
  shareStatus: string;
  shareSummary: string;
  shareBusy: boolean;
  onToggle: (enable: boolean) => Promise<void>;
  gatewayMode: 'direct' | 'search';
  onModeChange: (mode: 'direct' | 'search') => Promise<void>;
  toolCount: number;
  conn: SharingResp['connection'] | null;
  connSnippet: string;
  claudeAddCmd: string;
  snippetRef: React.RefObject<HTMLPreElement | null>;
  claudeCmdRef: React.RefObject<HTMLElement | null>;
}) {
  return (
    <div className="mcp-server-card" style={{ border: '1px solid rgba(0,224,138,.4)', background: 'rgba(0,224,138,.04)', marginBottom: 14 }}>
      <div className="mcp-server-header" style={{ cursor: 'default' }}>
        <span className={`mcp-status-dot ${shareDot}`} title={shareStatus} />
        <span className="mcp-server-name">
          MCP-Tools <span className="dim" style={{ fontWeight: 400, fontSize: 11 }}>(unified gateway)</span>
        </span>
        <span className="mcp-tool-count">{shareSummary}</span>
        <span className="mcp-status-label">{shareStatus}</span>
        <div style={{ flex: 1 }} />
        <button
          className="prefs-btn"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: sharingEnabled ? 'var(--danger)' : 'var(--accent)',
            borderColor: sharingEnabled ? 'rgba(255,91,110,.3)' : 'rgba(0,224,138,.3)',
          }}
          disabled={shareBusy}
          onClick={() => void onToggle(!sharingEnabled)}
        >
          {shareBusy
            ? (sharingEnabled ? 'Stopping…' : 'Starting…')
            : (sharingEnabled ? 'Stop sharing' : 'Start sharing')}
        </button>
      </div>
      <div className="prefs-hint" style={{ padding: '6px 12px 10px' }}>
        One MCP server that aggregates every running internal <em>and external</em> source and exposes them to outside hosts (Claude Code, Codex, Cursor, …) as <code>MCP-Tools</code>. Toggling this off hides every source from external hosts and writes <code>mcpServers: {'{}'}</code> into all spawned-harness configs. Sources keep running for YHA's own use.
      </div>
      {sharingEnabled && (
        <div style={{ padding: '0 12px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 6px' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#cdd' }}>Tool exposure</span>
            <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(255,255,255,.12)' }}>
              {(['direct', 'search'] as const).map((m) => (
                <button
                  key={m}
                  className="prefs-btn"
                  style={{
                    padding: '4px 12px',
                    fontSize: 11,
                    borderRadius: 0,
                    border: 'none',
                    fontWeight: gatewayMode === m ? 600 : 400,
                    color: gatewayMode === m ? 'var(--accent)' : 'var(--fg-dim)',
                    background: gatewayMode === m ? 'rgba(0,224,138,.1)' : 'transparent',
                  }}
                  onClick={() => { if (gatewayMode !== m) void onModeChange(m); }}
                >
                  {m === 'direct' ? 'Direct' : 'Smart (search)'}
                </button>
              ))}
            </div>
          </div>
          <div className="dim" style={{ fontSize: 11, lineHeight: 1.5 }}>
            {gatewayMode === 'direct' ? (
              <>Advertises all <strong>{toolCount}</strong> aggregated tools to connected hosts directly — simplest, best for a handful of sources.</>
            ) : (
              <>Advertises only four meta-tools (<code>search_mcp_tools</code>, <code>describe_mcp_tool</code>, <code>call_mcp_tool</code>, <code>list_mcp_sources</code>) instead of all {toolCount}. Hosts search for the tool they need on demand — keeps their context small when many sources are connected (like Claude Code's MCP tool search).</>
            )}
          </div>
        </div>
      )}
      {conn && (
        <div style={{ padding: '0 12px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 6px' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#cdd' }}>Connect from another host</span>
            <span className="dim" style={{ fontSize: 11 }}>— stdio MCP (no URL). Add this entry to the host's MCP config:</span>
          </div>
          <div style={{ position: 'relative' }}>
            <pre
              ref={snippetRef}
              id="mcp-tools-snippet"
              style={{ margin: 0, padding: '10px 12px', background: 'rgba(0,0,0,.45)', borderRadius: 4, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all', border: '1px solid rgba(255,255,255,.06)' }}
            >
              {connSnippet}
            </pre>
            <CopyButton targetRef={snippetRef} style={{ position: 'absolute', top: 6, right: 6, padding: '3px 8px', fontSize: 10 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 4px' }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#cdd' }}>Or (Claude Code CLI):</span>
          </div>
          <div style={{ position: 'relative' }}>
            <code
              ref={claudeCmdRef as React.RefObject<HTMLElement>}
              id="mcp-tools-claude-cmd"
              style={{ display: 'block', padding: '8px 12px', background: 'rgba(0,0,0,.45)', borderRadius: 4, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all', border: '1px solid rgba(255,255,255,.06)' }}
            >
              {claudeAddCmd}
            </code>
            <CopyButton targetRef={claudeCmdRef as React.RefObject<HTMLElement>} style={{ position: 'absolute', top: 4, right: 4, padding: '3px 8px', fontSize: 10 }} />
          </div>
          <div className="dim" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
            Replace <code>127.0.0.1</code> with the YHA host's reachable address (LAN-IP or Tailscale hostname) when registering from another machine. The stub binary path must exist on the host that runs MCP — for remote hosts, copy <code>bridge/mcp/yha-bridge-stub.js</code> over and point <code>YHA_BRIDGE_URL</code> at YHA.
          </div>
        </div>
      )}
    </div>
  );
}

function CopyButton({ targetRef, style }: { targetRef: React.RefObject<HTMLElement | null>; style?: React.CSSProperties }) {
  const [label, setLabel] = useState('Copy');
  async function handleClick() {
    const el = targetRef.current;
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent || '');
      setLabel('Copied');
      setTimeout(() => setLabel('Copy'), 1200);
    } catch { /* ignore */ }
  }
  return (
    <button className="prefs-btn" style={style} onClick={() => void handleClick()}>
      {label}
    </button>
  );
}
