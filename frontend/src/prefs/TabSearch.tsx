import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { liveSave, type LiveSaveHandle } from '../util/liveSave.js';

interface SearchProvider {
  name: string;
  enabled: boolean;
  priority: number;
  endpoint: string;
  cap: { window: 'day' | 'month'; limit: number | null } | null;
  has_key: boolean;
  key_hint: string;
  api_key_url: string | null;
  used_today: number;
  used_this_month: number;
  used_total: number;
  cx_set?: boolean;
  cx_url?: string;
  enable_api_url?: string;
}

interface SearchConfig {
  success: boolean;
  surface: 'bridge' | 'mcp' | 'both';
  providers: SearchProvider[];
}

const PROVIDER_LABELS: Record<string, string> = {
  tavily:         'Tavily',
  exa:            'Exa',
  google_cse:     'Google Custom Search',
  bing:           'Bing (Azure)',
  brave:          'Brave Search',
  playwright_mcp: 'Playwright MCP (legacy real-Chrome)',
  web_mcp:        'Web MCP (Pi-local visible Chromium)',
};

const PROVIDER_BLURBS: Record<string, string> = {
  tavily:         'AI-optimized, returns cleaned content. Free tier: 1 000 / month.',
  exa:            'Neural search — finds semantically relevant pages. Free tier: 1 000 / month.',
  google_cse:     'Classic Google results via a Programmable Search Engine. Free tier: 100 / day. On the Cloud Console, pick "+ Create credentials → API key" — not OAuth, not a service account.',
  bing:           'Bing Web Search via Azure Cognitive Services. Free tier: 1 000 / month.',
  brave:          'Independent Brave Search index. Free tier: 2 000 / month, 1 query / sec. Uses an X-Subscription-Token header.',
  playwright_mcp: 'Drives the legacy playwright-mcp MCP (Windows CDP or stealth headless) through a real Chrome — invisible to the user. No API key, no quota.',
  web_mcp:        'Drives the visible Pi-local Chromium-in-Docker (the same browser shown in the BrowserWindow). No API key, no quota. Requires the web MCP to be running.',
};

function QuotaBadge({ p }: { p: SearchProvider }) {
  const cap = p.cap;
  const dayLimit   = cap && cap.window === 'day'   && Number.isFinite(cap.limit as number) ? (cap.limit as number) : null;
  const monthLimit = cap && cap.window === 'month' && Number.isFinite(cap.limit as number) ? (cap.limit as number) : null;
  const dayPart   = dayLimit   != null ? `${p.used_today} / ${dayLimit} today`             : `${p.used_today} today`;
  const monthPart = monthLimit != null ? `${p.used_this_month} / ${monthLimit} this month`  : `${p.used_this_month} this month`;
  const dayCls   = dayLimit   != null && p.used_today      >= dayLimit   ? 'prefs-quota prefs-quota--exhausted' : 'prefs-quota';
  const monthCls = monthLimit != null && p.used_this_month >= monthLimit ? 'prefs-quota prefs-quota--exhausted' : 'prefs-quota';
  return (
    <>
      <span className={dayCls}>{dayPart}</span>{' '}
      <span className={monthCls}>{monthPart}</span>{' '}
      <span className="prefs-quota">{p.used_total} total</span>
    </>
  );
}

function ProviderRow({
  p,
  isFirst,
  isLast,
  onMove,
  onResetUsage,
  liveRef,
  statusElRef,
}: {
  p: SearchProvider;
  isFirst: boolean;
  isLast: boolean;
  onMove: (name: string, dir: 'up' | 'down') => void;
  onResetUsage: (name: string) => void;
  liveRef: React.MutableRefObject<LiveSaveHandle | null>;
  statusElRef: React.RefObject<HTMLSpanElement | null>;
}) {
  const base = api.config.baseUrl as string;
  const label = PROVIDER_LABELS[p.name] || p.name;
  const blurb = PROVIDER_BLURBS[p.name] || '';
  const link = p.api_key_url;

  useEffect(() => {
    const statusEl = statusElRef.current;
    const live = liveSave({
      endpoint: base + '/v1/search/config/',
      statusEl,
      buildBody: (body) => ({ provider: p.name, ...body }),
      errorLabel: `${p.name} save failed`,
    });
    liveRef.current = live;
    return () => {
      void live.flush();
      liveRef.current = null;
    };
  }, [p.name, base, liveRef, statusElRef]);

  return (
    <div className="prefs-provider-row" data-search-row={p.name}>
      <div className="prefs-provider-name">
        <div>
          {link ? (
            <a className="prefs-provider-link" href={link} target="_blank" rel="noopener" title="Get API key">
              {label} ↗
            </a>
          ) : label}
          {p.enable_api_url && (
            <> <a className="prefs-provider-link" href={p.enable_api_url} target="_blank" rel="noopener" title="Enable the Custom Search JSON API in your Cloud project (one-time step)">enable API ↗</a></>
          )}
          {' '}<QuotaBadge p={p} />
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>{blurb}</div>
      </div>
      <form className="prefs-provider-fields" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <div className="prefs-field-wrap">
          <label className="prefs-field-lbl">API Key</label>
          <input
            className="prefs-input"
            data-provider={p.name}
            data-field="api_key"
            type="password"
            autoComplete="off"
            defaultValue=""
            placeholder={p.has_key ? `•••• set (${p.key_hint}) — enter new to update` : 'No key — enter to add'}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (!v) return;
              liveRef.current?.patch({ api_key: v });
              void liveRef.current?.flush().then(() => { e.currentTarget.value = ''; });
            }}
          />
        </div>
        {p.name === 'google_cse' && (
          <div className="prefs-field-wrap">
            <label className="prefs-field-lbl">
              Search Engine ID (cx)
              {p.cx_url && (
                <> <a className="prefs-provider-link" href={p.cx_url} target="_blank" rel="noopener" title="Manage Programmable Search Engines (copy the cx id)">control panel ↗</a></>
              )}
            </label>
            <input
              className="prefs-input"
              data-provider={p.name}
              data-field="cx"
              type="text"
              autoComplete="off"
              defaultValue=""
              placeholder={p.cx_set ? '•••• set — enter new to update' : 'No cx — enter to add'}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (!v) return;
                liveRef.current?.patch({ cx: v });
                void liveRef.current?.flush().then(() => { e.currentTarget.value = ''; });
              }}
            />
          </div>
        )}
        <div className="prefs-field-wrap">
          <label className="prefs-field-lbl">Endpoint</label>
          <input
            className="prefs-input"
            data-provider={p.name}
            data-field="endpoint"
            type="text"
            defaultValue={p.endpoint || ''}
            placeholder="https://api.example.com/..."
            onChange={(e) => liveRef.current?.patch({ endpoint: e.currentTarget.value })}
          />
        </div>
        <div className="prefs-field-wrap">
          <label className="prefs-field-lbl">
            <input
              type="checkbox"
              data-provider={p.name}
              data-field="enabled"
              defaultChecked={p.enabled}
              onChange={(e) => liveRef.current?.patch({ enabled: e.currentTarget.checked })}
            />
            {' '}Enabled
          </label>
        </div>
      </form>
      <div className="prefs-provider-actions" style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
        <button className="prefs-btn" onClick={() => onMove(p.name, 'up')} disabled={isFirst}>↑</button>
        <button className="prefs-btn" onClick={() => onMove(p.name, 'down')} disabled={isLast}>↓</button>
        <button className="prefs-btn" onClick={() => onResetUsage(p.name)} title="Reset this provider's usage counters">⟲</button>
        <span ref={statusElRef} className="prefs-live-status" style={{ fontSize: 11, color: 'var(--fg-dim)', minHeight: 14, textAlign: 'center' }} />
      </div>
    </div>
  );
}

function ProviderRowWrapper(props: {
  p: SearchProvider;
  isFirst: boolean;
  isLast: boolean;
  onMove: (name: string, dir: 'up' | 'down') => void;
  onResetUsage: (name: string) => void;
}) {
  const liveRef = useRef<LiveSaveHandle | null>(null);
  const statusElRef = useRef<HTMLSpanElement>(null);
  return <ProviderRow {...props} liveRef={liveRef} statusElRef={statusElRef} />;
}

async function patchSearch(body: object): Promise<{ success?: boolean; mcpAction?: string | null; mcpError?: string }> {
  const res = await fetch(api.config.baseUrl + '/v1/search/config/', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function TabSearch() {
  const base = api.config.baseUrl as string;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [surface, setSurface] = useState<'bridge' | 'mcp' | 'both'>('bridge');
  const [providers, setProviders] = useState<SearchProvider[]>([]);
  const reloadRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const d = await fetch(base + '/v1/search/config/').then((r) => r.json()) as SearchConfig;
      setSurface(d.surface || 'bridge');
      setProviders((d.providers || []).slice().sort((a, b) => a.priority - b.priority));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load, reloadRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSurfaceChange(val: 'bridge' | 'mcp' | 'both') {
    setSurface(val);
    const r = await patchSearch({ surface: val });
    if (r.mcpError) alert('MCP toggle warning: ' + r.mcpError);
  }

  async function handleMove(name: string, dir: 'up' | 'down') {
    const order = providers.map((p) => p.name);
    const idx = order.indexOf(name);
    if (idx === -1) return;
    if (dir === 'up' && idx > 0) [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    else if (dir === 'down' && idx < order.length - 1) [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
    else return;
    await patchSearch({ reorder: order });
    reloadRef.current += 1;
    void load();
  }

  async function handleResetUsage(name: string) {
    await fetch(base + '/v1/search/usage?provider=' + encodeURIComponent(name), { method: 'DELETE' });
    reloadRef.current += 1;
    void load();
  }

  if (loading) return <div className="prefs-loading">Loading…</div>;
  if (error) return <div className="dim" style={{ padding: 10 }}>Failed to load search config from server.</div>;

  const last = providers.length - 1;

  return (
    <>
      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">Where to expose <code>search</code></h4>
        <div className="prefs-provider-row" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'nowrap' }}>
          {(['bridge', 'mcp', 'both'] as const).map((val) => {
            const labels: Record<string, string> = { bridge: 'Bridge tool only', mcp: 'MCP server only', both: 'Both' };
            const titles: Record<string, string> = {
              bridge: 'Models call WebSearch on the bridge.',
              mcp: 'Models call websearch__search via the MCP-Tools aggregator.',
              both: 'Both surfaces active — same orchestrator and quota counters.',
            };
            return (
              <label key={val} className="prefs-field-wrap" style={{ cursor: 'pointer', flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }} title={titles[val]}>
                <input
                  type="radio"
                  name="search-surface"
                  value={val}
                  checked={surface === val}
                  onChange={() => void handleSurfaceChange(val)}
                />
                <strong>{labels[val]}</strong>
              </label>
            );
          })}
        </div>
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">Providers (in fallback order)</h4>
        {providers.map((p, i) => (
          <ProviderRowWrapper
            key={p.name}
            p={p}
            isFirst={i === 0}
            isLast={i === last}
            onMove={(name, dir) => void handleMove(name, dir)}
            onResetUsage={(name) => void handleResetUsage(name)}
          />
        ))}
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">Stage 5 — free fallback</h4>
        <div className="prefs-provider-row">
          <div className="prefs-provider-name">
            <strong>DuckDuckGo / Brave</strong>
            <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
              Always-on. No API key, no quota — used when all paid providers are exhausted or unconfigured.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
