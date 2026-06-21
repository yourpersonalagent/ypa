import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { resolveAvatarColor } from '../color-themes-config.js';

const base = api.config.baseUrl;

interface PartnerType {
  type: string;
  label: string;
  defaultColor: string;
  installed: boolean;
  count: number;
  maxInstances: number;
  connectionType?: 'local' | 'network';
}

interface PartnerInstance {
  id: string;
  type: string;
  name: string;
  symbolColor: string;
  enabled: boolean;
  installed: boolean;
  running: boolean;
}

interface PartnerListResponse {
  partners?: PartnerInstance[];
  availableTypes?: PartnerType[];
}

function describeMissingJsx(type: string) {
  if (type === 'hermes') {
    return (
      <>
        Install Nous Research <code>Hermes</code> at <code>~/.hermes/hermes-agent/</code> with a
        working venv (<code>~/.hermes/hermes-agent/venv/bin/python</code>) and <code>tui_gateway/entry.py</code>.
      </>
    );
  }
  if (type === 'openclaw') {
    return (
      <>
        OpenClaw is a <strong>remote network agent</strong>. Run an OpenClaw gateway on another machine
        (or VM/Docker), set <code>bind: "0.0.0.0"</code> in its <code>openclaw.json</code>, and enter
        the host IP / Tailscale address + Bearer token in the partner sidebar.
      </>
    );
  }
  return <>Install instructions not available for this partner type yet.</>;
}

export function TabPartners() {
  const [types, setTypes] = useState<PartnerType[]>([]);
  const [partners, setPartners] = useState<PartnerInstance[]>([]);
  const [hopLimit, setHopLimit] = useState(25);
  const [hopStatus, setHopStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(base + '/v1/partners/').then((r) => r.json() as Promise<PartnerListResponse>),
      fetch(base + '/v1/config/').then((r) => r.json()),
    ])
      .then(([d, cfg]) => {
        setTypes(d.availableTypes || []);
        setPartners(d.partners || []);
        setHopLimit(Number(cfg?.config?.defaults?.partnerForwardLimit ?? 25) || 25);
        setLoading(false);
      })
      .catch(() => {
        setError(true);
        setLoading(false);
      });
  }, []);

  function handleHopLimitChange(raw: number) {
    if (isNaN(raw) || raw < 1 || raw > 200) return;
    setHopLimit(raw);
    setHopStatus('saving…');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(base + '/v1/config/', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaults: { partnerForwardLimit: raw } }),
      })
        .then((r) => r.json())
        .then((j) => setHopStatus(j?.success ? 'saved' : 'save failed'))
        .catch(() => setHopStatus('save failed'));
    }, 400);
  }

  if (loading) return <div className="prefs-loading">Loading…</div>;
  if (error) return <div className="dim" style={{ padding: '16px 0' }}>Failed to reach bridge server.</div>;

  return (
    <>
      <h4 className="prefs-sec">Multichat behaviour</h4>
      <div className="prefs-hint" style={{ marginBottom: '12px' }}>
        When an employee or partner replies starting with <code>@otherParticipant …</code>,
        the message is forwarded to that participant just as if you had typed it.
        The chain stops naturally when no leading <code>@mention</code> is found.
        Loops are bounded by the hop limit below; the primary loop guard is the{' '}
        <strong>stop button</strong> — pressing it aborts the in-flight reply and ends the chain.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '18px' }}>
        <label htmlFor="prefs-partner-forward-limit" style={{ fontSize: '13px' }}>
          Mention-forward hop limit
        </label>
        <input
          className="prefs-input"
          id="prefs-partner-forward-limit"
          type="number"
          min={1}
          max={200}
          step={1}
          value={hopLimit}
          style={{ width: '80px' }}
          onChange={(e) => handleHopLimitChange(parseInt(e.target.value, 10))}
        />
        <span className="prefs-hint" style={{ fontSize: '12px' }}>default 25</span>
        <span className="prefs-hint" style={{ fontSize: '12px', marginLeft: '6px' }}>{hopStatus}</span>
      </div>

      <h4 className="prefs-sec">Partner agents</h4>
      <div className="prefs-hint" style={{ marginBottom: '12px' }}>
        Partners are external autonomous agents (like Hermes) that appear in the @-mention picker.
        Per-instance enable / rename / colour lives in the <strong>partner sidebar</strong>; this tab is
        for type-level config and install diagnostics.
      </div>

      {types.length === 0
        ? <div className="dim" style={{ fontSize: '12px' }}>No partner types registered.</div>
        : (
          <div className="prefs-partner-types">
            {types.map((t) => {
              const recs = partners.filter((p) => p.type === t.type);
              const cap = t.maxInstances ?? 1;
              const fullness = `${recs.length} / ${cap}`;
              return (
                <div
                  key={t.type}
                  className="prefs-partner-type"
                  style={{ border: '1px solid var(--stroke)', borderRadius: '8px', padding: '12px', marginBottom: '10px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                    <span style={{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', background: t.defaultColor }} />
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>{t.label}</span>
                    <span className="prefs-mini-chip" style={{ background: 'rgba(120,160,255,.15)', color: 'var(--fg-dim)', fontSize: '11px' }}>
                      {t.connectionType === 'network' ? 'Network' : 'Local'}
                    </span>
                    {t.connectionType === 'network' && t.installed
                      ? <span className="prefs-mini-chip" style={{ background: 'rgba(80,200,120,.18)', color: '#7fd49a' }}>Available</span>
                      : t.installed
                        ? <span className="prefs-mini-chip" style={{ background: 'rgba(80,200,120,.18)', color: '#7fd49a' }}>Installed</span>
                        : <span className="prefs-mini-chip" style={{ background: 'rgba(255,150,0,.18)', color: '#e8a754' }}>Not installed</span>
                    }
                    <span className="prefs-mini-chip" title="Active instances vs max">{fullness}</span>
                  </div>
                  <div className="prefs-hint" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                    {t.installed
                      ? <>Configured. Add or remove instances from the <strong>Partner</strong> sidebar (left side). Cap: <code>{String(cap)}</code> instance{cap !== 1 ? 's' : ''}.</>
                      : describeMissingJsx(t.type)
                    }
                  </div>
                  {recs.length > 0 && (
                    <div style={{ marginTop: '8px', fontSize: '12px' }}>
                      Active:{' '}
                      {recs.map((r) => (
                        <span
                          key={r.id}
                          className="prefs-mini-chip"
                          style={{ background: resolveAvatarColor(r.symbolColor), color: '#fff', marginRight: '4px' }}
                        >
                          {r.name}{r.enabled ? '' : ' (disabled)'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      }
    </>
  );
}
