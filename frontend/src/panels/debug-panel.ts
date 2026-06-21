// ── Debug modal — renders #debug <type> payloads from server-debug.ts ─────────
// Shell DOM lives in yha.html (#debug-modal + .debug-modal-tabs + .debug-modal-body).
// Each subcommand has its own renderer function below; the dispatcher swaps tabs
// and body content based on payload type. New tabs ⇒ add a renderer + register
// it in `RENDERERS` below; no other file needs to change.
import chatUtils from '../chat/chat-utils.js';
import { api } from '../api.js';

export type Renderer = {
  label: string;
  // Tab definitions for this view. Each tab has its own panel renderer.
  tabs: { id: string; label: string; render: (data: any, body: HTMLElement) => void }[];
};

function escHtml(s: string): string {
  return chatUtils.escHtml(String(s ?? ''));
}

function fmtPrim(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function kv(k: string, v: unknown): string {
  return `<div class="dbg-kv"><span class="dbg-k">${escHtml(k)}</span><span class="dbg-v">${escHtml(fmtPrim(v))}</span></div>`;
}

function section(title: string, body: string): string {
  return `<div class="dbg-cfg-sec">${escHtml(title)}</div>${body}`;
}

function driftPill(state: string): string {
  // Drift indicator dot — green/yellow/red. Used in overview cards and tab headers.
  const cls = state === 'fail' ? 'dbg-drift-fail' : state === 'warn' ? 'dbg-drift-warn' : 'dbg-drift-ok';
  const label = state === 'fail' ? 'fail' : state === 'warn' ? 'warn' : 'ok';
  return `<span class="dbg-drift ${cls}" title="${escHtml(label)}"></span>`;
}

// ── monitoring helpers ────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

// Inline SVG sparkline — w×h px, points normalised to [0..max]. Returns an
// `<svg>` string ready to inject. Used by the History tab for cpu/heap/load
// rolling samples and per-stream chunk-rate buckets.
function sparkline(values: number[], opts: { w?: number; h?: number; color?: string; max?: number; label?: string } = {}): string {
  const w = opts.w ?? 240;
  const h = opts.h ?? 36;
  const color = opts.color ?? 'var(--accent)';
  if (!values.length) return `<svg class="dbg-spark" width="${w}" height="${h}"></svg>`;
  const max = opts.max ?? Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const range = Math.max(1, max - min);
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v, i) => {
    const x = (i * stepX).toFixed(1);
    const y = (h - ((v - min) / range) * h).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const last = values[values.length - 1];
  const lastX = ((values.length - 1) * stepX).toFixed(1);
  const lastY = (h - ((last - min) / range) * h).toFixed(1);
  const labelTxt = opts.label ?? `${last.toFixed?.(1) ?? last}`;
  return `<svg class="dbg-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${lastX}" cy="${lastY}" r="2" fill="${color}" />
    <text x="${w - 4}" y="11" text-anchor="end" font-size="10" font-family="monospace" fill="var(--fg-dim)">${escHtml(String(labelTxt))}</text>
  </svg>`;
}

function fmtTimestamp(at: number | null | undefined): string {
  if (!at) return '-';
  const d = new Date(at);
  return d.toLocaleTimeString();
}

// ── chathistory ───────────────────────────────────────────────────────────────

function renderProcessedEntry(msg: Record<string, unknown>, idx: number): string {
  const role = String(msg['role'] || '?');
  const content = String(msg['content'] || '');
  const chars = content.length;
  return `<div class="dbg-entry dbg-role-${escHtml(role)}"><div class="dbg-entry-hdr"><span class="dbg-role">${escHtml(role)}</span><span class="dbg-idx">#${idx}</span><span class="dbg-chars">${chars} chars</span></div><pre class="dbg-content">${escHtml(content)}</pre></div>`;
}

function renderBlock(b: Record<string, unknown>, bidx: number): string {
  const t = String(b['type'] || '?');
  let body = '';
  let badges = '';
  if (t === 'text') {
    const c = String(b['content'] || '');
    body = `<pre class="dbg-block-content">${escHtml(c)}</pre>`;
    badges = `<span class="dbg-badge">${c.length} chars</span>`;
  } else if (t === 'tool-call' || t === 'tool_use') {
    const name = String(b['name'] || b['tool'] || '?');
    const tid = String(b['toolId'] || b['id'] || '');
    const detail = b['detail'] !== undefined ? b['detail'] : b['input'];
    const detailStr = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail || '');
    body = `<pre class="dbg-block-content">${escHtml(detailStr)}</pre>`;
    badges = `<span class="dbg-badge">name: ${escHtml(name)}</span>${tid ? `<span class="dbg-badge">id: ${escHtml(tid.slice(0, 24))}</span>` : ''}`;
  } else if (t === 'tool-result' || t === 'tool_result') {
    const name = String(b['name'] || '?');
    const detail = b['detail'] !== undefined ? b['detail'] : b['content'];
    const detailStr = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail || '');
    body = `<pre class="dbg-block-content">${escHtml(detailStr)}</pre>`;
    badges = `<span class="dbg-badge">name: ${escHtml(name)}</span>`;
  } else if (t === 'btw') {
    const txt = String(b['text'] || b['content'] || '');
    body = `<pre class="dbg-block-content">${escHtml(txt)}</pre>`;
  } else {
    body = `<pre class="dbg-block-content">${escHtml(JSON.stringify(b, null, 2))}</pre>`;
  }
  return `<div class="dbg-block dbg-block-${escHtml(t)}"><div class="dbg-block-hdr"><span class="dbg-block-type">${escHtml(t)}</span><span class="dbg-idx">#${bidx}</span>${badges}</div>${body}</div>`;
}

function renderDisplayEntry(msg: Record<string, unknown>, idx: number): string {
  const role = String(msg['role'] || '?');
  const ts = msg['ts'] ? new Date(msg['ts'] as number).toLocaleTimeString() : '';
  const meta = (msg['meta'] as Record<string, unknown>) || {};
  const author = (msg['author'] as Record<string, unknown>) || {};
  const blocks = Array.isArray(msg['blocks']) ? (msg['blocks'] as Record<string, unknown>[]) : null;
  const text = msg['text'] !== undefined ? String(msg['text']) : '';

  const flagBadges: string[] = [];
  if (msg['streaming']) flagBadges.push('<span class="dbg-badge dbg-badge-warn">streaming</span>');
  if (msg['_liveToken'] !== undefined) flagBadges.push(`<span class="dbg-badge">liveToken: ${escHtml(fmtPrim(msg['_liveToken']))}</span>`);

  const metaKeys = ['model', 'cost', 'inputTokens', 'outputTokens', 'stopReason', 'durationMs', 'tokensPerSec'];
  const metaRows = metaKeys
    .filter((k) => meta[k] !== undefined && meta[k] !== null && meta[k] !== '')
    .map((k) => `<span class="dbg-meta-kv"><span class="dbg-meta-k">${k}</span><span class="dbg-meta-v">${escHtml(fmtPrim(meta[k]))}</span></span>`)
    .join('');
  const extraMetaKeys = Object.keys(meta).filter((k) => !metaKeys.includes(k));
  const extraMetaRows = extraMetaKeys
    .map((k) => `<span class="dbg-meta-kv"><span class="dbg-meta-k">${escHtml(k)}</span><span class="dbg-meta-v">${escHtml(fmtPrim(meta[k]))}</span></span>`)
    .join('');
  const authorRow = (author && (author['id'] || author['name']))
    ? `<span class="dbg-meta-kv"><span class="dbg-meta-k">author</span><span class="dbg-meta-v">${escHtml(String(author['name'] || author['id']))}${author['name'] && author['id'] ? ` (${escHtml(String(author['id']))})` : ''}</span></span>`
    : '';
  const metaPanel = (metaRows || extraMetaRows || authorRow)
    ? `<div class="dbg-meta">${authorRow}${metaRows}${extraMetaRows}</div>`
    : '';

  let contentHtml = '';
  if (blocks && blocks.length) {
    contentHtml = `<div class="dbg-blocks">${blocks.map((b, i) => renderBlock(b, i)).join('')}</div>`;
  } else if (text) {
    contentHtml = `<pre class="dbg-content">${escHtml(text)}</pre>`;
  } else {
    contentHtml = `<div class="dbg-empty-inline">(no text or blocks)</div>`;
  }

  return `<div class="dbg-entry dbg-role-${escHtml(role)}">
    <div class="dbg-entry-hdr">
      <span class="dbg-role">${escHtml(role)}</span>
      <span class="dbg-idx">#${idx}</span>
      ${ts ? `<span class="dbg-ts">${escHtml(ts)}</span>` : ''}
      ${flagBadges.join('')}
    </div>
    ${metaPanel}
    ${contentHtml}
  </div>`;
}

const chathistoryRenderer: Renderer = {
  label: 'Chat Session History',
  tabs: [
    {
      id: 'processed',
      label: 'What Models See',
      render: (data, body) => {
        const msgs = (data?.processedHistory as unknown[]) || [];
        body.innerHTML = msgs.length
          ? (msgs as Record<string, unknown>[]).map((m, i) => renderProcessedEntry(m, i)).join('')
          : '<p class="dbg-empty">No processed history entries — the model would see zero context. Either history was just cleared, or this provider path isn\'t writing pushHistory.</p>';
      },
    },
    {
      id: 'display',
      label: 'Raw Chat History',
      render: (data, body) => {
        const msgs = (data?.displayMessages as unknown[]) || [];
        body.innerHTML = msgs.length
          ? (msgs as Record<string, unknown>[]).map((m, i) => renderDisplayEntry(m, i)).join('')
          : '<p class="dbg-empty">No display messages for this session.</p>';
      },
    },
    {
      id: 'config',
      label: 'Config & Stats',
      render: (data, body) => {
        const cfg = (data?.config as Record<string, unknown>) || {};
        const model = (data?.currentModel as Record<string, unknown>) || {};
        const stats = (data?.stats as Record<string, unknown>) || {};
        body.innerHTML = `<div class="dbg-cfg">
          ${section('History Policy', kv('mode', cfg['mode']) + kv('max_turns', cfg['maxTurns']) + kv('max_chars', cfg['maxChars']))}
          ${section('Active LLM', kv('model', model['model']) + kv('provider', model['provider']))}
          ${section('Session Stats', kv('display messages', stats['displayCount']) + kv('processed entries', stats['processedCount']) + kv('processed chars', stats['processedChars']))}
        </div>`;
      },
    },
    {
      // Absorbed from the former standalone "Session" debug view. Display-session
      // metadata + the claude --resume binding are the parts that had no other
      // home; active-stream/process details moved out to Monitoring.
      id: 'session',
      label: 'Session State',
      render: (data, body) => {
        const d = data?.display as Record<string, unknown> | null;
        const cs = data?.cSid as Record<string, unknown> | null;
        const dispBlock = d
          ? kv('name', d['name']) + kv('createdAt', d['createdAt'] ? new Date(d['createdAt'] as number).toLocaleString() : '-') + kv('lastUsed', d['lastUsed'] ? new Date(d['lastUsed'] as number).toLocaleString() : '-') + kv('viewedAt', d['viewedAt'] ? new Date(d['viewedAt'] as number).toLocaleString() : '-') + kv('workingDir', d['workingDir']) + kv('messageCount', d['messageCount']) + kv('userMessageCount', d['userMessageCount']) + kv('participants', (d['participants'] as string[] || []).join(', ') || '(none)') + kv('groupMode', d['groupMode']) + kv('boundWorkflowName', d['boundWorkflowName'])
          : '<div class="dbg-empty-inline">(no displaySession entry)</div>';
        const csBlock = cs
          ? kv('claude session_id', cs['id']) + kv('bound configDir', cs['dir']) + kv('bound binary', cs['bin']) + (cs['legacy'] ? '<div class="dbg-kv"><span class="dbg-k">format</span><span class="dbg-v dbg-warn-inline">legacy (no bin/dir binding — resume may break across instance switches)</span></div>' : '')
          : '<div class="dbg-empty-inline">(no claude resume session bound — next turn starts fresh)</div>';
        body.innerHTML = `<div class="dbg-cfg">
          ${section(`Session (${data?.sessionId || ''})`, kv('cwd', data?.cwd))}
          ${section('Display Session', dispBlock)}
          ${section('Claude --resume binding', csBlock)}
        </div>`;
      },
    },
  ],
};

// ── routing ───────────────────────────────────────────────────────────────────

const routingRenderer: Renderer = {
  label: 'Routing',
  tabs: [
    {
      id: 'route',
      label: 'Resolved Route',
      render: (data, body) => {
        const route = data?.route || {};
        const sub = route.subscription?.instance;
        body.innerHTML = `<div class="dbg-cfg">
          ${section('Inputs', kv('modelId', data?.modelId) + kv('providerHint', data?.providerHint) + kv('isClaudeModel', data?.isClaudeModel) + kv('Anthropic API key present', data?.anthropicApiKeyPresent) + kv('anthropicApiMode', data?.anthropicApiMode) + kv('claudeRuntime (default)', data?.claudeRuntime))}
          ${section('resolveRouteType() output', kv('type', route.type) + kv('resolvedProvider', route.resolvedProvider) + (sub ? kv('subscription.instance', sub.label) + kv('subscription.index', route.subscription.index) : '<div class="dbg-kv"><span class="dbg-k">subscription</span><span class="dbg-v">none</span></div>'))}
          ${section('Effective spawn target', kv('actual code path', data?.actualPath) + kv('configDir', data?.configDir) + kv('binary (full)', data?.bin?.full) + kv('binary (basename)', data?.bin?.basename))}
        </div>`;
      },
    },
    {
      id: 'instances',
      label: 'Instances',
      render: (data, body) => {
        const cl = (data?.instances?.claude || []) as any[];
        const cx = (data?.instances?.codex || []) as any[];
        const claudeRows = cl.length
          ? cl.map((i) => `<div class="dbg-row"><span class="dbg-k">${escHtml(i.label)}</span><span class="dbg-v">configDir: ${escHtml(i.configDir || '-')}<br>claudeBin: ${escHtml(i.claudeBin || '(default)')}</span></div>`).join('')
          : '<div class="dbg-empty-inline">(none)</div>';
        const codexRows = cx.length
          ? cx.map((i) => `<div class="dbg-row"><span class="dbg-k">${escHtml(i.label)}</span><span class="dbg-v">configDir: ${escHtml(i.configDir || '-')}<br>codexBin: ${escHtml(i.codexBin || '(default)')}</span></div>`).join('')
          : '<div class="dbg-empty-inline">(none)</div>';
        body.innerHTML = `<div class="dbg-cfg">${section('Claude instances', claudeRows)}${section('Codex instances', codexRows)}</div>`;
      },
    },
  ],
};

// ── mcp ───────────────────────────────────────────────────────────────────────

const mcpRenderer: Renderer = {
  label: 'MCP Servers',
  tabs: [
    {
      id: 'servers',
      label: 'Servers',
      render: (data, body) => {
        const servers = (data?.servers || []) as any[];
        if (!servers.length) { body.innerHTML = '<p class="dbg-empty">No MCP servers configured.</p>'; return; }
        body.innerHTML = servers.map((s) => {
          const state = !s.configured ? 'fail' : !s.running ? 'warn' : s.error ? 'fail' : 'ok';
          const flags = [
            s.configured ? '' : '<span class="dbg-badge dbg-badge-warn">orphan</span>',
            s.running ? '<span class="dbg-badge">running</span>' : '<span class="dbg-badge dbg-badge-warn">stopped</span>',
            s.ok ? '<span class="dbg-badge">ok</span>' : '',
          ].filter(Boolean).join('');
          const cmdLine = s.command ? `${s.command} ${(s.args || []).join(' ')}` : '(no command)';
          const errBlock = s.error ? `<pre class="dbg-block-content dbg-warn-inline">${escHtml(String(s.error))}</pre>` : '';
          return `<div class="dbg-entry">
            <div class="dbg-entry-hdr">${driftPill(state)}<span class="dbg-role">${escHtml(s.name)}</span>${flags}<span class="dbg-chars">${s.tools} tools • ${s.prompts} prompts • ${s.resources} resources • ${s.pendingRequests} pending</span></div>
            <pre class="dbg-content">${escHtml(cmdLine)}</pre>
            ${errBlock}
          </div>`;
        }).join('');
      },
    },
    {
      id: 'summary',
      label: 'Summary',
      render: (data, body) => {
        body.innerHTML = `<div class="dbg-cfg">${section('Counts', kv('configured', data?.configured) + kv('running', data?.running) + kv('errored', data?.errored) + kv('totalTools', data?.totalTools))}</div>`;
      },
    },
  ],
};

// ── costs ─────────────────────────────────────────────────────────────────────

function fmtUSD(v: number): string {
  return `$${(Number(v) || 0).toFixed(4)}`;
}

function rankRows(rows: Array<{ key: string; value: number }>, fmt = fmtUSD): string {
  if (!rows || !rows.length) return '<div class="dbg-empty-inline">(none)</div>';
  return rows.map((r) => `<div class="dbg-kv"><span class="dbg-k">${escHtml(r.key)}</span><span class="dbg-v">${escHtml(fmt(r.value))}</span></div>`).join('');
}

const costsRenderer: Renderer = {
  label: 'Costs',
  tabs: [
    {
      id: 'today',
      label: 'Today',
      render: (data, body) => {
        body.innerHTML = `<div class="dbg-cfg">
          ${section(`Today (${escHtml(String(data?.today || ''))})`, kv('total', fmtUSD(data?.todayTotal || 0)))}
          ${section('By model — today', rankRows(data?.todayByModel || []))}
          ${section('By provider — today', rankRows(data?.todayByProvider || []))}
        </div>`;
      },
    },
    {
      id: 'alltime',
      label: 'All Time',
      render: (data, body) => {
        body.innerHTML = `<div class="dbg-cfg">
          ${section('All-time total', kv('total', fmtUSD(data?.allTimeTotal || 0)))}
          ${section('By model', rankRows(data?.allTimeByModel || []))}
          ${section('By provider', rankRows(data?.allTimeByProvider || []))}
        </div>`;
      },
    },
    {
      id: 'recent',
      label: 'Recent Days',
      render: (data, body) => {
        const rows = (data?.recentDays || []) as Array<{ day: string; total: number }>;
        body.innerHTML = rows.length
          ? `<div class="dbg-cfg">${rows.map((r) => kv(r.day, fmtUSD(r.total))).join('')}</div>`
          : '<p class="dbg-empty">No daily cost entries yet.</p>';
      },
    },
  ],
};

// ── tokens (daily token-mix breakdown by model) ──────────────────────────────
//
// The user wants to see token consumption split by category — input,
// cache-write, cache-read, output — per day, per model. Token *count* and
// token *cost share* tell different stories: a heavy cache-reuse session
// looks "huge" by count but cheap by cost (cache reads are 0.1× input price).
// Both charts are rendered together so the contrast is obvious at a glance.

const TOKEN_SEGMENTS = [
  { key: 'cacheRead',  label: 'cache read',  color: '#4d8' },
  { key: 'input',      label: 'input',       color: '#39c' },
  { key: 'cacheWrite', label: 'cache write', color: '#c93' },
  { key: 'output',     label: 'output',      color: '#e63' },
];

function fmtScale(n: number): string {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function tokenLegend(): string {
  return `<div class="dbg-tok-legend">${TOKEN_SEGMENTS
    .map((s) => `<span class="dbg-tok-legend-item"><span class="dbg-tok-legend-swatch" style="background:${s.color}"></span>${escHtml(s.label)}</span>`)
    .join('')}</div>`;
}

type DailyRow = { day: string; cacheRead: number; input: number; cacheWrite: number; output: number; total: number };

// SVG stacked-bar chart. Rows is one per day; segments are fixed in
// cheap→expensive order so the cheapest tokens always sit at the bottom.
// Hover tooltip shows the raw breakdown for that day; the empty SVG case
// keeps the layout from collapsing if the user opens the panel before any
// tokens have been recorded.
function stackedBars(rows: DailyRow[], opts: { w?: number; h?: number; valueFmt?: (n: number) => string; title?: string } = {}): string {
  const w = opts.w ?? 820;
  const h = opts.h ?? 160;
  const padL = 56, padR = 8, padT = 18, padB = 28;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const valueFmt = opts.valueFmt ?? fmtScale;

  if (!rows.length) {
    return `<svg class="dbg-tok-chart" width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="monospace" font-size="11" fill="var(--fg-dim)">no data</text></svg>`;
  }

  const max = Math.max(1, ...rows.map((r) => r.total));
  const barW = innerW / rows.length;
  const barInner = Math.max(2, Math.min(64, barW * 0.72));

  let svg = `<svg class="dbg-tok-chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  if (opts.title) {
    svg += `<text x="${padL}" y="12" font-size="11" font-family="monospace" fill="var(--fg-dim)">${escHtml(opts.title)}</text>`;
  }

  // Y-axis tick marks at 0, 50%, 100% — gives the user something to anchor
  // against when comparing across the two charts.
  for (const frac of [0, 0.5, 1]) {
    const y = padT + innerH - frac * innerH;
    const v = max * frac;
    svg += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--stroke)" stroke-width="0.5" stroke-dasharray="${frac === 0 ? '' : '2,2'}" />`;
    svg += `<text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-size="9" font-family="monospace" fill="var(--fg-dim)">${escHtml(valueFmt(v))}</text>`;
  }

  rows.forEach((r, i) => {
    const xCentre = padL + i * barW + barW / 2;
    const x = xCentre - barInner / 2;
    let yCursor = padT + innerH;
    const tooltip = `${r.day}\nin ${valueFmt(r.input)}\ncW ${valueFmt(r.cacheWrite)}\ncR ${valueFmt(r.cacheRead)}\nout ${valueFmt(r.output)}\ntotal ${valueFmt(r.total)}`;
    svg += `<g><title>${escHtml(tooltip)}</title>`;
    for (const s of TOKEN_SEGMENTS) {
      const v = (r as any)[s.key] || 0;
      if (v <= 0) continue;
      const segH = (v / max) * innerH;
      yCursor -= segH;
      svg += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barInner.toFixed(1)}" height="${segH.toFixed(1)}" fill="${s.color}" />`;
    }
    // X-label: render only every Nth day to avoid clutter on 30-day windows.
    const skip = rows.length > 14 ? 3 : rows.length > 8 ? 2 : 1;
    if (i % skip === 0 || i === rows.length - 1) {
      const lbl = r.day.slice(5); // MM-DD
      svg += `<text x="${xCentre.toFixed(1)}" y="${(h - padB + 14).toFixed(1)}" text-anchor="middle" font-size="9" font-family="monospace" fill="var(--fg-dim)">${escHtml(lbl)}</text>`;
    }
    svg += `</g>`;
  });

  svg += '</svg>';
  return svg;
}

function _calcCostFor(seg: { input: number; cacheWrite: number; cacheRead: number; output: number }, price: { pIn: number; pOut: number; pCw: number; pCr: number }): number {
  // Costs are per 1M tokens (Anthropic-style). Divide once at the end so each
  // segment's contribution stays in the same units as the others.
  return (
    (seg.input * price.pIn +
      seg.cacheWrite * price.pCw +
      seg.cacheRead * price.pCr +
      seg.output * price.pOut) / 1_000_000
  );
}

const tokensRenderer: Renderer = {
  label: 'Tokens',
  tabs: [
    {
      id: 'daily',
      label: 'Daily',
      render: (data, body) => {
        const days: string[] = data?.days || [];
        const totals: Record<string, any> = data?.dailyTotals || {};
        const matrix: Record<string, Record<string, any>> = data?.matrix || {};
        const priceTable: Record<string, any> = data?.priceTable || {};

        if (!days.length) {
          body.innerHTML = '<p class="dbg-empty">No tokens recorded yet — start a chat and this view will fill up.</p>';
          return;
        }

        // Count rows: total tokens per segment per day.
        const countRows: DailyRow[] = days.map((day) => {
          const t = totals[day] || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
          const total = t.input + t.cacheWrite + t.cacheRead + t.output;
          return { day, ...t, total };
        });

        // Cost rows: weight each segment by its model's price, summing across
        // all keys for the day. Done here instead of in the bridge so flipping
        // count↔cost doesn't refetch.
        const costRows: DailyRow[] = days.map((day) => {
          const dayMatrix = matrix[day] || {};
          let input = 0, cacheWrite = 0, cacheRead = 0, output = 0;
          for (const [k, v] of Object.entries(dayMatrix) as Array<[string, any]>) {
            const p = priceTable[k] || { pIn: 0, pOut: 0, pCw: 0, pCr: 0 };
            input      += (v.input || 0)      * p.pIn / 1_000_000;
            cacheWrite += (v.cacheWrite || 0) * p.pCw / 1_000_000;
            cacheRead  += (v.cacheRead || 0)  * p.pCr / 1_000_000;
            output     += (v.output || 0)     * p.pOut / 1_000_000;
          }
          const total = input + cacheWrite + cacheRead + output;
          return { day, input, cacheWrite, cacheRead, output, total };
        });

        const totalCount = countRows.reduce((s, r) => s + r.total, 0);
        const totalCost = costRows.reduce((s, r) => s + r.total, 0);

        body.innerHTML = `<div class="dbg-cfg">
          ${tokenLegend()}
          ${section(`Token COUNT — last ${days.length} days · total ${fmtScale(totalCount)} tok`,
            `<div class="dbg-tok-chart-wrap">${stackedBars(countRows, { title: 'tokens / day' })}</div>`)}
          ${section(`Token COST share — last ${days.length} days · total $${totalCost.toFixed(4)}`,
            `<div class="dbg-tok-chart-wrap">${stackedBars(costRows, { title: 'USD / day', valueFmt: (n) => `$${n.toFixed(n >= 1 ? 2 : 4)}` })}</div>`)}
          <div class="dbg-tok-note">Same data, two views. Cache reads dominate by count (cheap); output dominates by cost (5× input). If the two charts look very different, you're getting good cache reuse.</div>
        </div>`;
      },
    },
    {
      id: 'bymodel',
      label: 'By Model',
      render: (data, body) => {
        const days: string[] = data?.days || [];
        const matrix: Record<string, Record<string, any>> = data?.matrix || {};
        const byKey: Record<string, any> = data?.byKey || {};
        const priceTable: Record<string, any> = data?.priceTable || {};

        const keys = Object.keys(byKey).sort((a, b) => {
          // Sort by total cost descending — most expensive model on top.
          const ca = _calcCostFor(byKey[a], priceTable[a] || { pIn: 0, pOut: 0, pCw: 0, pCr: 0 });
          const cb = _calcCostFor(byKey[b], priceTable[b] || { pIn: 0, pOut: 0, pCw: 0, pCr: 0 });
          return cb - ca;
        });

        if (!keys.length) {
          body.innerHTML = '<p class="dbg-empty">No tokens recorded yet — start a chat and this view will fill up.</p>';
          return;
        }

        const blocks = keys.map((key) => {
          const total = byKey[key];
          const totalTok = total.input + total.cacheWrite + total.cacheRead + total.output;
          const cost = _calcCostFor(total, priceTable[key] || { pIn: 0, pOut: 0, pCw: 0, pCr: 0 });
          const cacheReadShare = totalTok > 0 ? Math.round((total.cacheRead / totalTok) * 100) : 0;

          // Per-day rows for this key only — keeps the chart focused on one
          // model so a quiet day doesn't get drowned out by a noisier one.
          const rows: DailyRow[] = days.map((day) => {
            const v = matrix[day]?.[key] || { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
            return { day, input: v.input || 0, cacheWrite: v.cacheWrite || 0, cacheRead: v.cacheRead || 0, output: v.output || 0, total: (v.input || 0) + (v.cacheWrite || 0) + (v.cacheRead || 0) + (v.output || 0) };
          });

          const tokSummary = `in ${fmtScale(total.input)} · cW ${fmtScale(total.cacheWrite)} · cR ${fmtScale(total.cacheRead)} · out ${fmtScale(total.output)}`;
          return `<div class="dbg-entry">
            <div class="dbg-entry-hdr">
              <span class="dbg-role">${escHtml(key)}</span>
              <span class="dbg-badge">${total.calls} call${total.calls === 1 ? '' : 's'}</span>
              <span class="dbg-badge">$${cost.toFixed(4)}</span>
              <span class="dbg-badge">${cacheReadShare}% cache-read</span>
              <span class="dbg-chars">${fmtScale(totalTok)} tok</span>
            </div>
            <div class="dbg-meta">
              <span class="dbg-meta-kv"><span class="dbg-meta-k">breakdown</span><span class="dbg-meta-v">${escHtml(tokSummary)}</span></span>
            </div>
            <div class="dbg-tok-chart-wrap">${stackedBars(rows, { w: 800, h: 100 })}</div>
          </div>`;
        });

        body.innerHTML = tokenLegend() + blocks.join('');
      },
    },
    {
      id: 'performance',
      label: 'Performance',
      render: (data, body) => {
        const byKey: Record<string, any> = data?.byKey || {};
        const priceTable: Record<string, any> = data?.priceTable || {};

        const keys = Object.keys(byKey).sort((a, b) => {
          const ta = byKey[a].input + byKey[a].cacheWrite + byKey[a].cacheRead + byKey[a].output;
          const tb = byKey[b].input + byKey[b].cacheWrite + byKey[b].cacheRead + byKey[b].output;
          return tb - ta;
        });

        if (!keys.length) {
          body.innerHTML = '<p class="dbg-empty">No tokens recorded yet — start a chat and this view will fill up.</p>';
          return;
        }

        // Performance metrics that the cost panel can't surface:
        //   - tokens/sec — output throughput (raw model speed)
        //   - tools/call — agentic intensity
        //   - chars/call — verbosity
        //   - duration/call — wall-clock per turn
        //   - cache hit ratio — caching efficiency
        //   - $/call & $/Mtok — economic density
        const rows = keys.map((key) => {
          const v = byKey[key];
          const calls = Math.max(1, v.calls);
          const totalTok = v.input + v.cacheWrite + v.cacheRead + v.output;
          const promptTok = v.input + v.cacheWrite + v.cacheRead;
          const tps = v.durationMs > 0 ? Math.round((v.output / (v.durationMs / 1000))) : 0;
          const cacheHitPct = promptTok > 0 ? Math.round((v.cacheRead / promptTok) * 100) : 0;
          const cost = _calcCostFor(v, priceTable[key] || { pIn: 0, pOut: 0, pCw: 0, pCr: 0 });
          return {
            key,
            calls: v.calls,
            totalTok,
            tokensPerCall: Math.round(totalTok / calls),
            outPerCall: Math.round(v.output / calls),
            toolsPerCall: (v.toolCalls / calls).toFixed(2),
            charsPerCall: Math.round(v.textLength / calls),
            avgDurMs: Math.round(v.durationMs / calls),
            tps,
            cacheHitPct,
            cost,
            costPerCall: cost / calls,
            costPerMTok: totalTok > 0 ? (cost / (totalTok / 1_000_000)) : 0,
          };
        });

        const headerRow = `<tr>
          <th>provider/model</th>
          <th>calls</th>
          <th>tok/call</th>
          <th>out/call</th>
          <th>tools/call</th>
          <th>chars/call</th>
          <th>avg dur</th>
          <th>out tok/s</th>
          <th>cache hit</th>
          <th>$/call</th>
          <th>$/Mtok</th>
          <th>$ total</th>
        </tr>`;
        const rowHtml = rows.map((r) => `<tr>
          <td title="${escHtml(r.key)}">${escHtml(r.key)}</td>
          <td>${r.calls}</td>
          <td>${fmtScale(r.tokensPerCall)}</td>
          <td>${fmtScale(r.outPerCall)}</td>
          <td>${r.toolsPerCall}</td>
          <td>${fmtScale(r.charsPerCall)}</td>
          <td>${fmtMs(r.avgDurMs)}</td>
          <td>${r.tps || '-'}</td>
          <td>${r.cacheHitPct}%</td>
          <td>$${r.costPerCall.toFixed(4)}</td>
          <td>$${r.costPerMTok.toFixed(2)}</td>
          <td>$${r.cost.toFixed(4)}</td>
        </tr>`).join('');

        body.innerHTML = `<div class="dbg-cfg">
          ${section('Per-model throughput & efficiency (window aggregate)', `<table class="dbg-tok-table"><thead>${headerRow}</thead><tbody>${rowHtml}</tbody></table>`)}
          <div class="dbg-tok-note">tok/call = (input + cache + output) / calls. cache hit = cacheRead / (input + cacheWrite + cacheRead). $/Mtok includes cache token costs at provider list prices.</div>
        </div>`;
      },
    },
    {
      id: 'table',
      label: 'Table',
      render: (data, body) => {
        const days: string[] = data?.days || [];
        const matrix: Record<string, Record<string, any>> = data?.matrix || {};
        const byKey: Record<string, any> = data?.byKey || {};
        const keys = Object.keys(byKey).sort();

        if (!days.length || !keys.length) {
          body.innerHTML = '<p class="dbg-empty">No tokens recorded yet.</p>';
          return;
        }

        // Show recent days first — newest on top is what people want when
        // scanning for "did anything weird happen yesterday?"
        const recentDays = days.slice().reverse();

        const headerRow = `<tr>
          <th>day</th>
          <th>provider/model</th>
          <th>input</th>
          <th>cacheW</th>
          <th>cacheR</th>
          <th>output</th>
          <th>calls</th>
          <th>tools</th>
          <th>chars</th>
          <th>dur</th>
        </tr>`;

        const dayBlocks = recentDays.map((day) => {
          const dayKeys = Object.keys(matrix[day] || {}).sort();
          if (!dayKeys.length) return '';
          const rows = dayKeys.map((k) => {
            const v = matrix[day][k];
            return `<tr>
              <td>${escHtml(day)}</td>
              <td>${escHtml(k)}</td>
              <td>${fmtScale(v.input || 0)}</td>
              <td>${fmtScale(v.cacheWrite || 0)}</td>
              <td>${fmtScale(v.cacheRead || 0)}</td>
              <td>${fmtScale(v.output || 0)}</td>
              <td>${v.calls || 0}</td>
              <td>${v.toolCalls || 0}</td>
              <td>${fmtScale(v.textLength || 0)}</td>
              <td>${fmtMs(v.durationMs || 0)}</td>
            </tr>`;
          }).join('');
          return rows;
        }).join('');

        body.innerHTML = `<div class="dbg-cfg">
          ${section('Daily breakdown', `<table class="dbg-tok-table"><thead>${headerRow}</thead><tbody>${dayBlocks}</tbody></table>`)}
        </div>`;
      },
    },
  ],
};

// ── monitoring (perf + network telemetry) ─────────────────────────────────────

const monitoringRenderer: Renderer = {
  label: 'Monitoring',
  tabs: [
    {
      id: 'backend',
      label: 'Node Bridge',
      render: (data, body) => {
        const b = data?.backend || {};
        const t = data?.totals || {};
        const memBar = (used: number, total: number) => {
          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
          return `<div class="dbg-bar"><div class="dbg-bar-fill" style="width:${pct}%"></div><span class="dbg-bar-label">${used} / ${total} MB (${pct}%)</span></div>`;
        };
        const cpuBar = (() => {
          const pct = Math.max(0, Math.min(400, b.cpuPercent || 0));
          const w = Math.min(100, pct);
          const cls = pct > 100 ? 'dbg-bar-fill dbg-bar-warn' : 'dbg-bar-fill';
          return `<div class="dbg-bar"><div class="${cls}" style="width:${w}%"></div><span class="dbg-bar-label">${pct}% (${b.cpuCount} cores)</span></div>`;
        })();
        body.innerHTML = `<div class="dbg-cfg">
          ${section('Process', kv('pid', b.pid) + kv('uptime', fmtMs((b.uptimeSec || 0) * 1000)) + kv('node', b.nodeVersion) + kv('platform', `${b.platform}/${b.arch}`) + kv('started at', b.startedAt || '-') + (b.prevExitSignal || b.prevExitVia || b.prevExitError ? kv('prev exit', [b.prevExitSignal, b.prevExitVia, b.prevExitError].filter(Boolean).join(' · ')) : ''))}
          ${section('CPU', `<div class="dbg-kv"><span class="dbg-k">cpu (since last sample)</span><span class="dbg-v">${cpuBar}</span></div>` + kv('load avg', `${(b.loadAvg1 || 0).toFixed(2)} / ${(b.loadAvg5 || 0).toFixed(2)} / ${(b.loadAvg15 || 0).toFixed(2)}`))}
          ${section('Memory', `<div class="dbg-kv"><span class="dbg-k">heap</span><span class="dbg-v">${memBar(b.memHeapUsedMb || 0, b.memHeapTotalMb || 0)}</span></div>` + kv('rss', `${b.memRssMb} MB`) + kv('external', `${b.memExternalMb} MB`))}
          ${section('Aggregate', kv('active streams', t.activeStreams) + kv('streaming now', t.streamingNow) + kv('active processes', t.activeProcesses) + kv('bytes broadcast (lifetime)', fmtBytes(t.globalBytesBroadcast || 0)) + kv('chunks broadcast (lifetime)', t.globalChunksBroadcast) + kv('listener calls (lifetime)', t.globalListenerCalls) + kv('process up since last restart', fmtMs(t.sinceMs)))}
        </div>`;
      },
    },
    {
      id: 'system',
      label: 'System (top)',
      render: (data, body) => {
        // System-wide sampler (/proc/stat, /proc/meminfo, /proc/[pid]/stat).
        // Companion to "Node Bridge" — answers "is yha eating CPU, or is
        // something else?". Per-process %CPU is kernel-side (utime+stime
        // jiffies), which is what `top` displays — NOT the same number as
        // Node's process.cpuUsage(). They're close for the yha PID but
        // surface them side-by-side so the discrepancy is visible rather
        // than hidden behind a single rounded value.
        const samples = (data?.systemSamples || []) as Array<any>;
        const b = data?.backend || {};
        if (!samples.length) {
          body.innerHTML = `<p class="dbg-empty">System sampler hasn't produced a usable reading yet — either the bridge just booted (first sample emits zeroes; refresh in ~15s) or this machine doesn't expose /proc (macOS dev?). Check pm2 logs for <code>[debug.system-sampler]</code>.</p>`;
          return;
        }
        const cur = samples[samples.length - 1];
        const cpu = cur.cpu || {};
        const load = cur.load || {};
        const mem = cur.mem || {};
        const tps = (cur.topProcs || []) as Array<{ pid: number; cpuPct: number; memPct: number; rssMb: number; command: string; isYha: boolean }>;

        // CPU bucket bar — width = % of total, color hints at "is this bucket
        // contributing to load?". Reuses the existing .dbg-bar styling so it
        // matches the rest of the modal.
        const cpuBucket = (label: string, pct: number, color?: string) => {
          const w = Math.max(0, Math.min(100, pct));
          const style = color ? ` style="width:${w}%;background:${color}"` : ` style="width:${w}%"`;
          return `<div class="dbg-row"><span class="dbg-k">${escHtml(label)}</span><span class="dbg-v"><div class="dbg-bar"><div class="dbg-bar-fill"${style}></div><span class="dbg-bar-label">${pct.toFixed(1)}%</span></div></span></div>`;
        };
        const cpuBlock = section('System CPU (last 15 s window)',
          cpuBucket('user', cpu.userPct || 0) +
          cpuBucket('system', cpu.systemPct || 0) +
          cpuBucket('iowait', cpu.iowaitPct || 0, 'var(--warn, #c70)') +
          cpuBucket('idle', cpu.idlePct || 0, 'var(--fg-dim)') +
          cpuBucket('softirq', cpu.softirqPct || 0) +
          cpuBucket('steal', cpu.stealPct || 0) +
          kv('non-idle (busy)', `${(cpu.nonIdlePct || 0).toFixed(1)}%`)
        );

        const loadBlock = section('Load avg + tasks',
          kv('load (1/5/15 min)', `${(load.l1 || 0).toFixed(2)} / ${(load.l5 || 0).toFixed(2)} / ${(load.l15 || 0).toFixed(2)}`) +
          kv('tasks running / total', `${load.running || 0} / ${load.total || 0}`)
        );

        const memBar = (used: number, total: number) => {
          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
          return `<div class="dbg-bar"><div class="dbg-bar-fill" style="width:${pct}%"></div><span class="dbg-bar-label">${used} / ${total} MB (${pct}%)</span></div>`;
        };
        const memBlock = section('Memory (host-wide)',
          `<div class="dbg-kv"><span class="dbg-k">used</span><span class="dbg-v">${memBar(mem.usedMb || 0, mem.totalMb || 0)}</span></div>` +
          kv('available', `${mem.availableMb || 0} MB`) +
          kv('cached', `${mem.cachedMb || 0} MB`) +
          kv('buffers', `${mem.buffersMb || 0} MB`) +
          (mem.swapTotalMb ? `<div class="dbg-kv"><span class="dbg-k">swap used</span><span class="dbg-v">${memBar(mem.swapUsedMb || 0, mem.swapTotalMb || 0)}</span></div>` : kv('swap', '(none configured)'))
        );

        // Side-by-side comparison: Node bridge's process.cpuUsage() (already
        // on the Backend tab) vs kernel utime+stime as seen by `top`. They
        // measure the same thing through different counters — useful to see
        // when they disagree (process.cpuUsage rounds; kernel jiffies have
        // 10ms resolution at CLK_TCK=100; transient spikes are visible here
        // but smoothed away in the cpuUsage delta).
        const yhaRow = tps.find((p) => p.isYha);
        const yhaCompare = section('yha bridge — node vs kernel CPU view',
          kv('Node process.cpuUsage()', `${(b.cpuPercent || 0).toFixed(1)}%  (rounded to single-core %)`) +
          kv('Kernel utime+stime (/proc)', yhaRow ? `${yhaRow.cpuPct.toFixed(1)}%  (Irix mode — may exceed 100 across cores)` : '(yha PID not in top-10 this sample)') +
          kv('cores', String(b.cpuCount || '?')) +
          `<div class="dbg-empty-inline" style="margin-top:6px">Same process, two counters — discrepancies of a few % are expected. Big gaps mean the sampler caught a spike one source averaged out.</div>`
        );

        const procRows = tps.length
          ? tps.map((p) => {
              const flag = p.isYha ? '<span class="dbg-badge">yha bridge</span>' : '';
              const hot = p.cpuPct > 50 ? ' dbg-warn-inline' : '';
              return `<tr>
                <td>${p.pid}</td>
                <td><code>${escHtml(p.command)}</code> ${flag}</td>
                <td style="text-align:right" class="${hot}">${p.cpuPct.toFixed(1)}%</td>
                <td style="text-align:right">${p.memPct.toFixed(1)}%</td>
                <td style="text-align:right">${p.rssMb} MB</td>
              </tr>`;
            }).join('')
          : '<tr><td colspan="5" class="dbg-empty-inline">First sample after boot has no delta to compute %CPU — wait one tick (~15s) and refresh.</td></tr>';
        const procBlock = section(`Top processes by CPU (${tps.length})`,
          `<table class="dbg-tok-table"><thead><tr><th>pid</th><th>command</th><th style="text-align:right">%CPU</th><th style="text-align:right">%MEM</th><th style="text-align:right">RSS</th></tr></thead><tbody>${procRows}</tbody></table>`);

        // System CPU history — non-idle % sparkline over the same 60-sample
        // window as the Backend "History & Trends" tab. This is the line you
        // overlay against "what was running" in the correlation block below.
        const nonIdleHist = samples.map((s: any) => s.cpu?.nonIdlePct || 0);
        const iowaitHist = samples.map((s: any) => s.cpu?.iowaitPct || 0);
        const histBlock = section('System CPU history (last 15 min)',
          `<div class="dbg-row"><span class="dbg-k">non-idle (busy)</span><span class="dbg-v">${sparkline(nonIdleHist, { w: 320, h: 36, max: 100, label: `${(cpu.nonIdlePct || 0).toFixed(0)}%` })}</span></div>` +
          `<div class="dbg-row"><span class="dbg-k">iowait</span><span class="dbg-v">${sparkline(iowaitHist, { w: 320, h: 36, max: Math.max(20, ...iowaitHist), color: 'var(--warn, #c70)', label: `${(cpu.iowaitPct || 0).toFixed(0)}%` })}</span></div>`
        );

        body.innerHTML = `<div class="dbg-cfg">${cpuBlock}${loadBlock}${memBlock}${yhaCompare}${histBlock}${procBlock}</div>`;
      },
    },
    {
      id: 'gocore',
      label: 'Go Core',
      render: async (_data, body) => {
        // Pull live snapshot from yha-core's /internal/metrics. Same-origin
        // because the Go front door reverse-proxies the rest of the app, so
        // no CORS / auth setup beyond the session cookie.
        body.innerHTML = '<div class="dbg-empty-inline">Loading /internal/metrics …</div>';
        let snap: any = null;
        let err: string | null = null;
        try {
          const r = await fetch(`${api.config.baseUrl}/internal/metrics`, { credentials: 'same-origin' });
          if (!r.ok) {
            err = `HTTP ${r.status} from /internal/metrics — go-core may not own this route.`;
          } else {
            snap = await r.json();
          }
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        if (err) {
          body.innerHTML = `<p class="dbg-empty">go-core metrics unavailable: ${escHtml(err)}<br><small>If the Node bridge is the front door (no <code>./yha.sh dev</code> active), this tab has nothing to show.</small></p>`;
          return;
        }
        const proc = snap?.process || {};
        const counters = (snap?.counters || []) as Array<{ name: string; labels: Record<string, string>; value: number }>;
        const histograms = (snap?.histograms || []) as Array<{ name: string; labels: Record<string, string>; count: number; p50: number; p95: number; p99: number; max: number; sumSeconds: number }>;
        const gauges = (snap?.gauges || []) as Array<{ name: string; labels: Record<string, string>; value: number }>;

        const fmtLabels = (l: Record<string, string>) => Object.keys(l || {}).length
          ? Object.entries(l).map(([k, v]) => `${escHtml(k)}=${escHtml(v)}`).join(' ')
          : '<span class="dbg-empty-inline">(no labels)</span>';

        // Group counters by name so the user sees one section per metric and
        // can scan label cardinality at a glance. Inside each group, sort by
        // value desc — the heaviest hitter rises to the top.
        const counterByName = new Map<string, typeof counters>();
        for (const c of counters) {
          const arr = counterByName.get(c.name) || [];
          arr.push(c);
          counterByName.set(c.name, arr);
        }
        const counterBlocks = [...counterByName.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rows]) => {
          rows.sort((a, b) => b.value - a.value);
          const total = rows.reduce((n, r) => n + r.value, 0);
          const head = `<tr><th>labels</th><th style="text-align:right">value</th></tr>`;
          const tbody = rows.map((r) => `<tr><td>${fmtLabels(r.labels)}</td><td style="text-align:right">${r.value.toLocaleString()}</td></tr>`).join('');
          return section(`${name} — ${total.toLocaleString()} total · ${rows.length} label set${rows.length === 1 ? '' : 's'}`,
            `<table class="dbg-tok-table"><thead>${head}</thead><tbody>${tbody}</tbody></table>`);
        }).join('');

        const histByName = new Map<string, typeof histograms>();
        for (const h of histograms) {
          const arr = histByName.get(h.name) || [];
          arr.push(h);
          histByName.set(h.name, arr);
        }
        const histBlocks = [...histByName.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, rows]) => {
          rows.sort((a, b) => b.p95 - a.p95);
          const head = `<tr><th>labels</th><th>count</th><th>p50</th><th>p95</th><th>p99</th><th>max</th></tr>`;
          // Histogram values from go-core are emitted as floats in the metric's
          // native unit. The HTTP and stream histograms are in milliseconds; if
          // the unit shifts later, we can dispatch on name. For now, format
          // numbers with 1 decimal — keeps the column tidy without losing sub-ms.
          const fmt = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(1)}`;
          const tbody = rows.map((r) => `<tr><td>${fmtLabels(r.labels)}</td><td>${r.count.toLocaleString()}</td><td>${fmt(r.p50)}</td><td>${fmt(r.p95)}</td><td>${fmt(r.p99)}</td><td>${fmt(r.max)}</td></tr>`).join('');
          const totalCount = rows.reduce((n, r) => n + r.count, 0);
          return section(`${name} — ${totalCount.toLocaleString()} obs · ${rows.length} label set${rows.length === 1 ? '' : 's'}`,
            `<table class="dbg-tok-table"><thead>${head}</thead><tbody>${tbody}</tbody></table>`);
        }).join('');

        const gaugeBlock = gauges.length
          ? section('Gauges', gauges.map((g) => `<div class="dbg-kv"><span class="dbg-k">${escHtml(g.name)} ${fmtLabels(g.labels)}</span><span class="dbg-v">${g.value.toLocaleString()}</span></div>`).join(''))
          : '';

        const procBlock = section('Process',
          kv('go version', proc.goVersion) +
          kv('goroutines', proc.goroutines) +
          kv('heap in use', `${(proc.heapInUseMB || 0).toFixed(2)} MB`) +
          kv('uptime', fmtMs(Math.round((proc.uptimeSeconds || 0) * 1000))) +
          kv('snapshot at', snap?.generatedAt || '-')
        );

        const emptyNote = (!counters.length && !histograms.length && !gauges.length)
          ? '<div class="dbg-empty-inline">No metrics emitted yet — exercise /v1/tools/, /v1/stream-direct/, /v1/mcp/, or any HTTP route to populate.</div>'
          : '';

        body.innerHTML = `<div class="dbg-cfg">${procBlock}${emptyNote}${counterBlocks}${histBlocks}${gaugeBlock}</div>`;
      },
    },
    {
      id: 'streams',
      label: 'Streams',
      render: (data, body) => {
        const streams = (data?.streams || []) as any[];
        if (!streams.length) { body.innerHTML = '<p class="dbg-empty">No active streams.</p>'; return; }
        body.innerHTML = streams.map((s) => {
          const state = s.status === 'streaming' ? 'ok' : s.status === 'error' ? 'fail' : 'warn';
          const flags = [
            s.isCurrent ? '<span class="dbg-badge">current session</span>' : '',
            `<span class="dbg-badge">${escHtml(s.status)}</span>`,
            s.source === 'go-core' ? '<span class="dbg-badge">go-core</span>' : '',
            s.listeners != null && s.listeners > 0 ? `<span class="dbg-badge">${s.listeners} listener${s.listeners === 1 ? '' : 's'}</span>` : '',
            s.reconnectsHere > 0 ? `<span class="dbg-badge dbg-badge-warn">${s.reconnectsHere} reconnect${s.reconnectsHere === 1 ? '' : 's'}</span>` : '',
            s.silentClose ? '<span class="dbg-badge dbg-badge-warn">silent close</span>' : '',
          ].filter(Boolean).join('');
          const meta = `${escHtml(s.model || '?')} • ${escHtml(s.provider || '?')}`;
          const idleSummary = (s.idleGapsMs && s.idleGapsMs.length)
            ? `${s.idleGapsMs.length}× (max ${fmtMs(Math.max(...s.idleGapsMs))})`
            : '—';
          const buckets = (s.chunkRateBuckets || []) as Array<{ atMin: number; chunks: number; bytes: number }>;
          const bucketSpark = buckets.length
            ? sparkline(buckets.map((b) => b.chunks), { w: 220, h: 28, label: `${buckets[buckets.length - 1].chunks}/min` })
            : '';
          const lh = (s.listenerHistory || []) as any[];
          const lhRow = lh.length
            ? `<div class="dbg-meta"><span class="dbg-meta-kv"><span class="dbg-meta-k">listener events (last)</span><span class="dbg-meta-v">${lh.map((e) => `${fmtTimestamp(e.at)}:${escHtml(e.action)}${e.isReconnect ? '↻' : ''}${e.hadEnd === false ? '⚠' : ''}`).join(' • ')}</span></span></div>`
            : '';
          // Go-core entries carry null for fields the bridge never sees
          // (bytesOut/textLength); render those as "—" so "null" doesn't leak.
          const nz = (v: any): string => (v == null ? '—' : String(v));
          return `<div class="dbg-entry">
            <div class="dbg-entry-hdr">${driftPill(state)}<span class="dbg-role">${escHtml(s.id)}</span>${flags}<span class="dbg-chars">${meta}</span></div>
            <div class="dbg-meta">
              <span class="dbg-meta-kv"><span class="dbg-meta-k">chunks (live)</span><span class="dbg-meta-v">${nz(s.chunks)}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">chunks (total)</span><span class="dbg-meta-v">${nz(s.chunksTotal)}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">bytes out</span><span class="dbg-meta-v">${s.bytesOut == null ? '—' : fmtBytes(s.bytesOut)}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">text length</span><span class="dbg-meta-v">${nz(s.textLength)}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">age</span><span class="dbg-meta-v">${fmtMs(s.ageMs)}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">tokens (in/out)</span><span class="dbg-meta-v">${s.inputTokens} / ${s.outputTokens}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">cost</span><span class="dbg-meta-v">$${(s.cost || 0).toFixed(4)}</span></span>
              <span class="dbg-meta-kv"><span class="dbg-meta-k">idle gaps &gt;5s</span><span class="dbg-meta-v">${idleSummary}</span></span>
            </div>
            ${bucketSpark ? `<div class="dbg-meta"><span class="dbg-meta-kv"><span class="dbg-meta-k">chunks/min</span><span class="dbg-meta-v">${bucketSpark}</span></span></div>` : ''}
            ${lhRow}
          </div>`;
        }).join('');
      },
    },
    {
      id: 'frontend',
      label: 'Frontend Network',
      render: async (_data, body) => {
        // Read live counters from the FE-side wrapper. Lazy import so this
        // tab only pulls in net-metrics when the user actually opens it.
        const { getNetMetrics, getReconnectMetrics } = await import('../util/net-metrics.js');
        const m = getNetMetrics() as any;
        const r = getReconnectMetrics();
        const windowMin = Math.max(0.001, (m.sinceMs || 1) / 60_000);
        const endpoints = Object.entries(m.byEndpoint || {})
          .map(([k, v]) => {
            const e = v as { hits: number; bytesIn: number; bytesOut: number; statusBuckets?: { '2xx': number; '4xx': number; '5xx': number; netErr: number }; latencyMs?: { count: number; totalMs: number; maxMs: number } };
            const ratePerMin = e.hits / windowMin;
            return { key: k, ...e, ratePerMin };
          })
          .sort((a, b) => b.ratePerMin - a.ratePerMin);
        const rows = endpoints.length
          ? endpoints.map((e) => {
              const cls = e.ratePerMin > 30 ? 'dbg-warn-inline' : '';
              const sb = e.statusBuckets;
              const errCls = sb && (sb['4xx'] + sb['5xx'] + sb.netErr) > 0 ? 'dbg-warn-inline' : '';
              const statusStr = sb
                ? `2xx:${sb['2xx']} 4xx:${sb['4xx']} 5xx:${sb['5xx']} err:${sb.netErr}`
                : '';
              const lm = e.latencyMs;
              const avgMs = lm && lm.count > 0 ? Math.round(lm.totalMs / lm.count) : null;
              const latencyStr = lm && lm.count > 0 ? `avg ${avgMs}ms max ${lm.maxMs}ms` : '';
              return `<div class="dbg-row"><span class="dbg-k ${cls}">${escHtml(e.key)}</span><span class="dbg-v">${e.ratePerMin.toFixed(1)} /min · ${e.hits} hits · in ${fmtBytes(e.bytesIn)} · out ${fmtBytes(e.bytesOut)}${statusStr ? ` · <span class="${errCls}">${escHtml(statusStr)}</span>` : ''}${latencyStr ? ` · ${escHtml(latencyStr)}` : ''}</span></div>`;
            }).join('')
          : '<div class="dbg-empty-inline">(no requests recorded yet)</div>';
        const reconnectRows = r.recent.length
          ? r.recent.slice().reverse().map((a) => {
              const cls = a.outcome === 'done' ? '' : a.outcome === 'error' ? 'dbg-warn-inline' : '';
              const meta = [
                a.replayChunkCount != null ? `replay ${a.replayChunkCount}` : '',
                a.liveChunkCount != null ? `live ${a.liveChunkCount}` : '',
                a.latencyToFirstChunkMs != null ? `t0 ${fmtMs(a.latencyToFirstChunkMs)}` : '',
                a.durationMs != null ? `dur ${fmtMs(a.durationMs)}` : '',
                a.bytesIn != null ? fmtBytes(a.bytesIn) : '',
                a.reason ? `· ${escHtml(a.reason)}` : '',
              ].filter(Boolean).join(' • ');
              return `<div class="dbg-row"><span class="dbg-k ${cls}">${fmtTimestamp(a.at)} ${escHtml(a.outcome)} <small>${escHtml(a.sid).slice(0, 14)}</small></span><span class="dbg-v">${meta || '—'}</span></div>`;
            }).join('')
          : '<div class="dbg-empty-inline">(no reconnects yet)</div>';
        body.innerHTML = `<div class="dbg-cfg">
          ${section('Totals (since page load)', kv('requests', m.totalRequests) + kv('bytes in', fmtBytes(m.totalBytesIn)) + kv('bytes out', fmtBytes(m.totalBytesOut)) + kv('eventsource opened', m.eventSourceOpen) + kv('eventsource closed', m.eventSourceClosed) + kv('eventsource errors', m.eventSourceErrors) + kv('eventsource bytes in', fmtBytes(m.eventSourceBytesIn)) + kv('measurement window', fmtMs(m.sinceMs)))}
          ${section('Reconnects', kv('attempts', r.attempts) + kv('successes', r.successes) + kv('errors', r.errors) + kv('detached', r.detached) + kv('skipped (no-op early returns)', r.skipped))}
          ${section('Recent reconnects', reconnectRows)}
          ${section('By endpoint', rows)}
        </div>`;
      },
    },
    {
      id: 'history',
      label: 'History & Trends',
      render: (data, body) => {
        const samples = (data?.resourceSamples || []) as Array<{ at: number; cpuPct: number; rssMb: number; heapUsedMb: number; heapTotalMb: number; load1: number }>;
        const sysSamples = (data?.systemSamples || []) as Array<{ at: number; cpu: { nonIdlePct: number }; telemetry15s: { totalCalls: number; topByP95: Array<{ surface: string; name: string; p95Ms: number; calls: number }> } }>;
        const hist = (data?.historicalStreams || []) as any[];
        const t = data?.totals || {};
        const cpuVals = samples.map((s) => s.cpuPct);
        const rssVals = samples.map((s) => s.rssMb);
        const heapVals = samples.map((s) => s.heapUsedMb);
        const load1Vals = samples.map((s) => s.load1);
        // Correlation overlay: align telemetry calls/sample alongside CPU%.
        // When you see a CPU spike, glance at the calls sparkline directly
        // below it — if calls also spike, the load is from the tool/route
        // mix (drill into "Tools, Skills & MCP" for which one). If calls are
        // flat while CPU climbs, the load is from something background
        // (GC, recurring timer, MCP server churn) — drill into the System tab.
        const sysCallsVals = sysSamples.map((s) => s.telemetry15s?.totalCalls || 0);
        const sysCpuVals = sysSamples.map((s) => s.cpu?.nonIdlePct || 0);
        const peakSample = sysSamples.length
          ? sysSamples.slice().sort((a, b) => (b.cpu?.nonIdlePct || 0) - (a.cpu?.nonIdlePct || 0))[0]
          : null;
        const peakRows = peakSample?.telemetry15s?.topByP95?.length
          ? peakSample.telemetry15s.topByP95.slice(0, 5).map((r) =>
              `<div class="dbg-row"><span class="dbg-k">${escHtml(r.surface)} · ${escHtml(r.name)}</span><span class="dbg-v">${r.calls} calls · p95 ${fmtMs(r.p95Ms)}</span></div>`
            ).join('')
          : '<div class="dbg-empty-inline">(no per-tool/per-route activity recorded during the busiest sample)</div>';
        const samplesNote = samples.length
          ? `<div class="dbg-empty-inline">${samples.length} samples · 15 s spacing · ${fmtMs(samples.length * 15_000)} window</div>`
          : '<div class="dbg-empty-inline">(sampler hasn\'t run yet — wait ~15 s and refresh)</div>';
        const trendBlock = `<div class="dbg-cfg">
          ${samplesNote}
          ${section('CPU %', `<div class="dbg-row"><span class="dbg-k">last 15 min</span><span class="dbg-v">${sparkline(cpuVals, { w: 320, h: 36, max: Math.max(100, ...cpuVals), label: cpuVals.length ? `${cpuVals[cpuVals.length - 1]}%` : '' })}</span></div>`)}
          ${sysCpuVals.length ? section('System CPU (non-idle %)', `<div class="dbg-row"><span class="dbg-k">last 15 min</span><span class="dbg-v">${sparkline(sysCpuVals, { w: 320, h: 36, max: 100, label: sysCpuVals.length ? `${(sysCpuVals[sysCpuVals.length - 1] || 0).toFixed(0)}%` : '' })}</span></div>`) : ''}
          ${sysCallsVals.length ? section('Telemetry calls / 15 s window (overlay vs CPU above)', `<div class="dbg-row"><span class="dbg-k">last 15 min</span><span class="dbg-v">${sparkline(sysCallsVals, { w: 320, h: 36, max: Math.max(5, ...sysCallsVals), color: 'var(--ok, #4a8)', label: sysCallsVals.length ? `${sysCallsVals[sysCallsVals.length - 1] || 0}` : '' })}</span></div>${section('Hot at the busiest sample (top by p95)', peakRows)}`) : ''}
          ${section('Heap used (MB)', `<div class="dbg-row"><span class="dbg-k">last 15 min</span><span class="dbg-v">${sparkline(heapVals, { w: 320, h: 36, label: heapVals.length ? `${heapVals[heapVals.length - 1]} MB` : '' })}</span></div>`)}
          ${section('RSS (MB)', `<div class="dbg-row"><span class="dbg-k">last 15 min</span><span class="dbg-v">${sparkline(rssVals, { w: 320, h: 36, label: rssVals.length ? `${rssVals[rssVals.length - 1]} MB` : '' })}</span></div>`)}
          ${section('Load avg (1 min)', `<div class="dbg-row"><span class="dbg-k">last 15 min</span><span class="dbg-v">${sparkline(load1Vals, { w: 320, h: 36, label: load1Vals.length ? load1Vals[load1Vals.length - 1].toFixed(2) : '' })}</span></div>`)}
        </div>`;
        const summary = `<div class="dbg-cfg">${section('Connection quality (since restart)',
          kv('silent disconnects', t.silentDisconnects) +
          kv('reconnects observed (server-side)', t.reconnectsObserved) +
          kv('GC evictions', t.gcEvictions) +
          kv('peak active streams', t.peakActiveStreams) +
          kv('peak listeners per stream', t.peakListenersPerStream)
        )}</div>`;
        const histRows = hist.length
          ? hist.slice().reverse().map((h: any) => {
              const state = h.status === 'done' ? 'ok' : h.status === 'error' ? 'fail' : 'warn';
              const flags = [
                `<span class="dbg-badge">${escHtml(h.status)}</span>`,
                h.silentClose ? '<span class="dbg-badge dbg-badge-warn">silent close</span>' : '',
                h.reconnectsHere ? `<span class="dbg-badge dbg-badge-warn">${h.reconnectsHere} reconnect${h.reconnectsHere === 1 ? '' : 's'}</span>` : '',
              ].filter(Boolean).join('');
              const idleN = (h.idleGapsMs || []).length;
              const idleMax = idleN ? fmtMs(Math.max(...h.idleGapsMs)) : '—';
              const sparkData = (h.chunkRateBuckets || []).map((b: any) => b.chunks);
              const spark = sparkData.length ? sparkline(sparkData, { w: 200, h: 24, label: `peak ${Math.max(...sparkData)}/min` }) : '';
              return `<div class="dbg-entry">
                <div class="dbg-entry-hdr">${driftPill(state)}<span class="dbg-role">${escHtml(h.id)}</span>${flags}<span class="dbg-chars">${escHtml(h.model || '?')} · ${fmtMs(h.durationMs)}</span></div>
                <div class="dbg-meta">
                  <span class="dbg-meta-kv"><span class="dbg-meta-k">started</span><span class="dbg-meta-v">${fmtTimestamp(h.startedAt)}</span></span>
                  <span class="dbg-meta-kv"><span class="dbg-meta-k">chunks</span><span class="dbg-meta-v">${h.chunkCount}</span></span>
                  <span class="dbg-meta-kv"><span class="dbg-meta-k">bytes out</span><span class="dbg-meta-v">${fmtBytes(h.bytesOut)}</span></span>
                  <span class="dbg-meta-kv"><span class="dbg-meta-k">tokens in/out</span><span class="dbg-meta-v">${h.inputTokens} / ${h.outputTokens}</span></span>
                  <span class="dbg-meta-kv"><span class="dbg-meta-k">cost</span><span class="dbg-meta-v">$${(h.cost || 0).toFixed(4)}</span></span>
                  <span class="dbg-meta-kv"><span class="dbg-meta-k">idle gaps &gt;5 s</span><span class="dbg-meta-v">${idleN}× (max ${idleMax})</span></span>
                </div>
                ${spark ? `<div class="dbg-meta"><span class="dbg-meta-kv"><span class="dbg-meta-k">chunks/min</span><span class="dbg-meta-v">${spark}</span></span></div>` : ''}
              </div>`;
            }).join('')
          : '<p class="dbg-empty">No archived streams yet — finish or detach a stream and this tab will fill up.</p>';
        body.innerHTML = trendBlock + summary +
          `<div class="dbg-cfg-sec">Archived streams (${hist.length})</div>${histRows}`;
      },
    },
  ],
};

// ── toolsmon (Tools, Skills & MCP monitoring) ─────────────────────────────────
// Renders telemetry collected by bridge/server-telemetry.ts. Each tab focuses
// on one surface so the user can see which tools the model is actually
// invoking, where it's wasting time, and (for memory MCPs) whether
// read-after-write ratios suggest write-only memory waste — the metric the
// /debug-modal article in the original brief explicitly missed.

function _fmtAge(ms: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function _ratioBadge(ratio: number | null | undefined, writes: number): string {
  if (ratio == null || writes < 1) return '<span class="dbg-badge">— R/W</span>';
  if (ratio >= 1)   return `<span class="dbg-badge dbg-badge-ok">${ratio.toFixed(2)} R/W</span>`;
  if (ratio >= 0.5) return `<span class="dbg-badge">${ratio.toFixed(2)} R/W</span>`;
  return `<span class="dbg-badge dbg-badge-warn">${ratio.toFixed(2)} R/W</span>`;
}

function _renderSummaryStrip(data: any): string {
  const bs = data?.bySurface || {};
  const lt = data?.lifetime || {};
  const surfaces: Array<{ k: string; label: string }> = [
    { k: 'tool', label: 'Tools' },
    { k: 'skill', label: 'Skills' },
    { k: 'mcp', label: 'MCP' },
    { k: 'route', label: 'Routes' },
    { k: 'memory', label: 'Memory' },
    { k: 'workflow', label: 'Workflows' },
  ];
  const cards = surfaces.map((s) => {
    const w = bs[s.k] || { calls: 0, errors: 0, errorRate: 0 };
    const l = lt[s.k] || { calls: 0, errors: 0 };
    const errCls = w.errorRate > 0.1 ? 'dbg-warn-inline' : '';
    return `<div class="dbg-row">
      <span class="dbg-k">${escHtml(s.label)}</span>
      <span class="dbg-v">
        <strong>${w.calls.toLocaleString()}</strong> in window
        · ${l.calls.toLocaleString()} lifetime
        · <span class="${errCls}">${w.errors} err${w.errors === 1 ? '' : 's'} (${(w.errorRate * 100).toFixed(1)}%)</span>
      </span>
    </div>`;
  }).join('');
  const enabledNote = data?.enabled === false
    ? '<div class="dbg-empty-inline" style="color: var(--accent)">Telemetry is disabled. <button class="dbg-btn" id="dbg-telemetry-enable-btn">Re-enable</button></div>'
    : '';
  return `<div class="dbg-cfg">${enabledNote}${section('Surface activity (last 24h)', cards)}</div>`;
}

function _renderRowsTable(rows: any[], opts: { showMemory?: boolean } = {}): string {
  if (!rows.length) {
    return '<p class="dbg-empty">No calls recorded yet in the current window. Use the model with this surface and the table will fill in.</p>';
  }
  const memoryCols = opts.showMemory
    ? '<th title="reads / writes (R/W ratio). Target ≥ 0.5; values < 0.25 with > 5 writes flag write-only memory.">R/W</th><th>reads</th><th>writes</th>'
    : '';
  const head = `<tr>
    <th>name</th>
    <th>calls</th>
    <th>errors</th>
    <th title="50th and 95th percentile latency in the window">p50 / p95</th>
    <th>last call</th>
    <th title="Total result bytes returned in window">out bytes</th>
    ${memoryCols}
  </tr>`;
  const tbody = rows.map((r) => {
    const errCls = r.errorRate > 0.1 ? 'dbg-warn-inline' : '';
    const ageMs = r.lastCallAt ? Date.now() - r.lastCallAt : 0;
    const memory = opts.showMemory
      ? `<td>${_ratioBadge(r.readWriteRatio, r.writes || 0)}</td>
         <td>${r.reads ?? 0}</td>
         <td>${r.writes ?? 0}</td>`
      : '';
    return `<tr>
      <td title="${escHtml(r.name)}">${escHtml(r.name)}</td>
      <td>${r.calls}</td>
      <td class="${errCls}">${r.errors}</td>
      <td>${fmtMs(r.p50DurationMs)} / ${fmtMs(r.p95DurationMs)}</td>
      <td>${escHtml(_fmtAge(ageMs))}</td>
      <td>${fmtBytes(r.totalResultSize || 0)}</td>
      ${memory}
    </tr>`;
  }).join('');
  return `<table class="dbg-tok-table"><thead>${head}</thead><tbody>${tbody}</tbody></table>`;
}

const toolsmonRenderer: Renderer = {
  label: 'Tools, Skills & MCP',
  tabs: [
    {
      id: 'overview',
      label: 'Overview',
      render: (data, body) => {
        if (!data) {
          body.innerHTML = '<p class="dbg-empty">No telemetry data.</p>';
          return;
        }
        const meta = `<div class="dbg-cfg">${section('Ring buffer', kv('events held', `${data.ringSize} / ${data.ringCap}`) + kv('window', fmtMs(data.windowMs)) + kv('total events in window', data.totalEvents))}</div>`;
        // Memory R/W summary table — the headline metric.
        const memRows = (data.byMemory || []) as any[];
        const memWrites = memRows.reduce((n, r) => n + (r.writes || 0), 0);
        const memReads = memRows.reduce((n, r) => n + (r.reads || 0), 0);
        const memRatio = memWrites > 0 ? memReads / memWrites : null;
        const memCard = `<div class="dbg-cfg">${section(
          'Memory read-after-write (the article\'s actual gap)',
          `<div class="dbg-row"><span class="dbg-k">total writes</span><span class="dbg-v">${memWrites}</span></div>` +
          `<div class="dbg-row"><span class="dbg-k">total reads</span><span class="dbg-v">${memReads}</span></div>` +
          `<div class="dbg-row"><span class="dbg-k">overall R/W ratio</span><span class="dbg-v">${memRatio === null ? '—' : memRatio.toFixed(2)} ${memRatio !== null && memRatio < 0.25 && memWrites > 5 ? '<span class="dbg-warn-inline">(write-only memory suspect)</span>' : ''}</span></div>`
        )}</div>`;
        body.innerHTML = _renderSummaryStrip(data) + memCard + meta;
        const enableBtn = body.querySelector<HTMLButtonElement>('#dbg-telemetry-enable-btn');
        if (enableBtn) {
          enableBtn.addEventListener('click', async () => {
            enableBtn.disabled = true;
            enableBtn.textContent = 'Enabling…';
            try {
              await fetch('/v1/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
            } finally {
              enableBtn.closest('.dbg-empty-inline')?.remove();
            }
          });
        }
      },
    },
    {
      id: 'tools',
      label: 'Tools',
      render: (data, body) => {
        const rows = (data?.byTool || []) as any[];
        // Cross-reference meta tools so we can show "defined but never called"
        // beneath the table.
        const metaTools = (data?.metaTools || []) as any[];
        const unused = metaTools.filter((t) => t.calls === 0 && t.mounted);
        const unusedHtml = unused.length
          ? `<div class="dbg-cfg-sec">Mounted meta-tools never called in window (${unused.length})</div>` +
            unused.map((t) => `<div class="dbg-row"><span class="dbg-k">${escHtml(t.name)}</span><span class="dbg-v dbg-warn-inline">${escHtml(t.runtime || '')} · ${escHtml((t.description || '').slice(0, 80))}</span></div>`).join('')
          : '';
        body.innerHTML = `<div class="dbg-cfg">
          ${section('Bridge + meta tools (per-name)', _renderRowsTable(rows))}
        </div>${unusedHtml}`;
      },
    },
    {
      id: 'skills',
      label: 'Skills',
      render: (data, body) => {
        const meta = (data?.metaSkills || []) as any[];
        if (!meta.length) {
          body.innerHTML = '<p class="dbg-empty">No skills defined under bridge/meta/skills.</p>';
          return;
        }
        // Skills go through meta_invoke_skill (an MCP tool), so we surface
        // each skill's existence + mounted state. Per-skill invocation count
        // requires sniffing args — we expose the aggregate from the MCP table
        // at the top.
        const skillRow = (s: any) => `<div class="dbg-row">
          <span class="dbg-k">${escHtml(s.name)} ${s.mounted ? '<span class="dbg-badge dbg-badge-ok">mounted</span>' : '<span class="dbg-badge">unmounted</span>'}</span>
          <span class="dbg-v">${escHtml((s.description || '').slice(0, 200) || '(no description)')}</span>
        </div>`;
        const totalInvocations = meta[0]?.ringCallsAcrossAllSkills || 0;
        body.innerHTML = `<div class="dbg-cfg">
          ${section(`Skills under bridge/meta/skills (${meta.length})`, meta.map(skillRow).join(''))}
          <div class="dbg-empty-inline">meta_invoke_skill calls in window (across all skills): ${totalInvocations}. Per-skill counts need arg-sniffing — open the live tail to see args.</div>
        </div>`;
      },
    },
    {
      id: 'mcp',
      label: 'MCP',
      render: (data, body) => {
        const servers = (data?.mcpServers || []) as any[];
        if (!servers.length) {
          body.innerHTML = '<p class="dbg-empty">No MCP servers running.</p>';
          return;
        }
        const blocks = servers.map((s) => {
          const status = s.running && s.ok
            ? '<span class="dbg-badge dbg-badge-ok">running</span>'
            : s.running
              ? '<span class="dbg-badge dbg-badge-warn">degraded</span>'
              : '<span class="dbg-badge dbg-badge-warn">stopped</span>';
          const descHashes = (s.toolDescHashes || {}) as Record<string, string>;
          const hashBadge = (t: string) => {
            const h = descHashes[t];
            return h && h !== 'unknown' ? `<span class="dbg-badge" title="description version">v:${escHtml(h)}</span>` : '';
          };
          const perToolRows = Object.keys(s.perTool || {}).sort((a, b) => (s.perTool[b] || 0) - (s.perTool[a] || 0));
          const perToolHtml = perToolRows.length
            ? perToolRows.map((t) => `<div class="dbg-row"><span class="dbg-k">${escHtml(t)} ${hashBadge(t)}</span><span class="dbg-v">${s.perTool[t]} call${s.perTool[t] === 1 ? '' : 's'}</span></div>`).join('')
            : '<div class="dbg-empty-inline">(no calls in window)</div>';
          const unusedHtml = s.unusedTools.length
            ? `<div class="dbg-cfg-sec">Tools advertised but never called (${s.unusedTools.length})</div>` +
              (s.unusedTools as string[]).map((t: string) => `<div class="dbg-row"><span class="dbg-k dbg-warn-inline">${escHtml(t)} ${hashBadge(t)}</span><span class="dbg-v">${escHtml((s.toolDescs[t] || '').slice(0, 140))}</span></div>`).join('')
            : '';
          return `<div class="dbg-entry">
            <div class="dbg-entry-hdr">
              <span class="dbg-role">${escHtml(s.name)}</span>
              ${status}
              <span class="dbg-badge">${s.tools} tools</span>
              <span class="dbg-badge">${s.calls} calls</span>
              ${s.errors > 0 ? `<span class="dbg-badge dbg-badge-warn">${s.errors} err</span>` : ''}
            </div>
            <div class="dbg-cfg">
              ${section('Per-tool calls (window)', perToolHtml)}
              ${unusedHtml}
            </div>
          </div>`;
        }).join('');
        body.innerHTML = blocks;
      },
    },
    {
      id: 'routes',
      label: 'Routes',
      render: (data, body) => {
        const rows = (data?.byRoute || []) as any[];
        body.innerHTML = `<div class="dbg-cfg">${section('HTTP routes (per-method, per-pattern)', _renderRowsTable(rows))}</div>`;
      },
    },
    {
      id: 'memory',
      label: 'Memory',
      render: (data, body) => {
        const rows = (data?.byMemory || []) as any[];
        body.innerHTML = `<div class="dbg-cfg">
          ${section('Per-tool R/W (knowledge-memory · important · todos)', _renderRowsTable(rows, { showMemory: true }))}
          <div class="dbg-empty-inline">A row with R/W &lt; 0.25 and writes &gt; 5 is the article&apos;s &quot;write-only memory&quot; failure mode. The footer-injected <code>important</code> surface should sit at R/W ≥ 1 because every prompt re-reads it.</div>
        </div>`;
      },
    },
    {
      id: 'workflows',
      label: 'Workflows',
      render: (data, body) => {
        const rows = (data?.byWorkflow || []) as any[];
        body.innerHTML = `<div class="dbg-cfg">
          ${section('Workflow runs (per-workflow)', _renderRowsTable(rows))}
        </div>`;
      },
    },
    {
      id: 'server-health',
      label: 'Server Health',
      render: (data, body) => {
        const health = (data?.mcpHealth || {}) as any;
        const servers = (health.servers || []) as any[];
        if (!servers.length) { body.innerHTML = '<p class="dbg-empty">No MCP servers configured.</p>'; return; }
        body.innerHTML = servers.map((s) => {
          const state = !s.configured ? 'fail' : !s.running ? 'warn' : s.error ? 'fail' : 'ok';
          const flags = [
            s.configured ? '' : '<span class="dbg-badge dbg-badge-warn">orphan</span>',
            s.running ? '<span class="dbg-badge">running</span>' : '<span class="dbg-badge dbg-badge-warn">stopped</span>',
            s.ok ? '<span class="dbg-badge">ok</span>' : '',
          ].filter(Boolean).join('');
          const cmdLine = s.command ? `${s.command} ${(s.args || []).join(' ')}` : '(no command)';
          const errBlock = s.error ? `<pre class="dbg-block-content dbg-warn-inline">${escHtml(String(s.error))}</pre>` : '';
          return `<div class="dbg-entry">
            <div class="dbg-entry-hdr">${driftPill(state)}<span class="dbg-role">${escHtml(s.name)}</span>${flags}<span class="dbg-chars">${s.tools} tools • ${s.prompts} prompts • ${s.resources} resources • ${s.pendingRequests} pending</span></div>
            <pre class="dbg-content">${escHtml(cmdLine)}</pre>
            ${errBlock}
          </div>`;
        }).join('');
      },
    },
    {
      id: 'tail',
      label: 'Live Tail',
      render: (data, body) => {
        const events = ((data?.recent || []) as any[]).slice(0, 200);
        if (!events.length) {
          body.innerHTML = '<p class="dbg-empty">No events recorded yet.</p>';
          return;
        }
        const rows = events.map((e) => {
          const okBadge = e.ok
            ? '<span class="dbg-badge dbg-badge-ok">ok</span>'
            : '<span class="dbg-badge dbg-badge-warn">err</span>';
          const surfaceBadge = `<span class="dbg-badge">${escHtml(e.surface)}</span>`;
          const memOp = e.meta?.op ? `<span class="dbg-badge">${escHtml(String(e.meta.op))}</span>` : '';
          const status = e.meta?.status ? `<span class="dbg-badge">${escHtml(String(e.meta.status))}</span>` : '';
          return `<div class="dbg-row">
            <span class="dbg-k">${escHtml(new Date(e.ts).toLocaleTimeString())} ${surfaceBadge} ${memOp} ${status}</span>
            <span class="dbg-v">${okBadge} ${escHtml(e.name)} · ${fmtMs(e.durationMs || 0)} · in ${fmtBytes(e.argsSize || 0)} · out ${fmtBytes(e.resultSize || 0)}</span>
          </div>`;
        }).join('');
        body.innerHTML = `<div class="dbg-cfg">${section('Last 200 events (newest first)', rows)}</div>`;
      },
    },
  ],
};

// ── overview (cards grid) ─────────────────────────────────────────────────────

const overviewRenderer: Renderer = {
  label: 'Overview',
  tabs: [
    {
      id: 'cards',
      label: 'Drift Check',
      render: (data, body) => {
        const cards = (data?.cards || []) as any[];
        const sid = data?.sessionId || '';
        body.innerHTML = `<div class="dbg-overview-grid">${cards.map((c) => `
          <button class="dbg-card dbg-card-${c.drift}" data-debug-type="${escHtml(c.type)}" data-debug-sid="${escHtml(sid)}">
            <div class="dbg-card-hdr">${driftPill(c.drift)}<span class="dbg-card-label">${escHtml(c.label)}</span></div>
            <div class="dbg-card-preview">${escHtml(c.preview)}</div>
            ${c.hint ? `<div class="dbg-card-hint">${escHtml(c.hint)}</div>` : ''}
          </button>
        `).join('')}</div>`;
        body.querySelectorAll<HTMLButtonElement>('.dbg-card[data-debug-type]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const type = btn.dataset['debugType']!;
            const dsid = btn.dataset['debugSid']!;
            try {
              const r = await fetch(`${api.config.baseUrl}/v1/debug/${encodeURIComponent(type)}/${encodeURIComponent(dsid)}`);
              const j = await r.json();
              if (j.success) showDebugModal(type, j.data);
            } catch (e) {
              console.error('debug fetch failed', e);
            }
          });
        });
      },
    },
  ],
};

// ── modeltracker (provider model lifecycle log) ───────────────────────────────
// Surfaces the NDJSON event log written by bridge/modules/model-tracker/.
// Three tabs: Summary (per-provider rollup), Events (recent tail), Snapshot
// (current model set with categories + first/last seen).

function fmtAbsTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString();
}

function fmtRelTime(ts: number): string {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function eventBadge(kind: string): string {
  // Color per lifecycle stage. first_seen = green (new); last_seen = red
  // (gone); category_auto_changed = amber (drift); override_* = blue (user).
  const cls =
    kind === 'first_seen' ? 'dbg-badge-ok'
    : kind === 'last_seen' ? 'dbg-badge-warn'
    : kind === 'category_auto_changed' ? 'dbg-badge-warn'
    : 'dbg-badge';
  return `<span class="dbg-badge ${cls}">${escHtml(kind)}</span>`;
}

const modelTrackerRenderer: Renderer = {
  label: 'Model Tracker',
  tabs: [
    {
      id: 'summary',
      label: 'Summary',
      render: (data, body) => {
        const summary = (data?.summary || []) as Array<{ provider: string; lastFetch: number; modelCount: number; oldestFirstSeen: number; newestFirstSeen: number; recentEvents24h: number }>;
        if (data?.error) {
          body.innerHTML = `<p class="dbg-empty">Tracker module not available: ${escHtml(String(data.error))}</p>`;
          return;
        }
        if (!summary.length) {
          body.innerHTML = '<p class="dbg-empty">No provider fetches recorded yet. The tracker starts emitting events the next time a provider /models call runs.</p>';
          return;
        }
        const totalsRow = data?.totals
          ? section('Totals', `${kv('providers', data.totals.providers)}${kv('models tracked', data.totals.models)}${kv('events (last 24h)', data.totals.events24h)}`)
          : '';
        const rows = summary.map((s) => `<div class="dbg-row">
          <span class="dbg-k">${escHtml(s.provider)}</span>
          <span class="dbg-v">${s.modelCount} models · last fetch ${escHtml(fmtRelTime(s.lastFetch))} · ${s.recentEvents24h} event${s.recentEvents24h === 1 ? '' : 's'} (24h)<br><span style="opacity:.6">oldest first_seen: ${escHtml(fmtAbsTime(s.oldestFirstSeen))} · newest: ${escHtml(fmtAbsTime(s.newestFirstSeen))}</span></span>
        </div>`).join('');
        body.innerHTML = `<div class="dbg-cfg">${totalsRow}${section('Per provider', rows)}</div>`;
      },
    },
    {
      id: 'events',
      label: 'Events',
      render: (data, body) => {
        const events = (data?.events || []) as Array<{ ts: number; provider: string; model: string; event: string; category?: string; categoryFrom?: string; categoryTo?: string }>;
        if (!events.length) {
          body.innerHTML = '<p class="dbg-empty">No tracker events recorded yet.</p>';
          return;
        }
        const rows = events.slice(0, 300).map((e) => {
          let detail = '';
          if (e.event === 'first_seen' || e.event === 'last_seen') {
            detail = e.category ? ` · ${escHtml(e.category)}` : '';
          } else if (e.event === 'category_auto_changed' || e.event === 'override_set' || e.event === 'override_cleared') {
            detail = ` · ${escHtml(e.categoryFrom || '—')} → ${escHtml(e.categoryTo || '—')}`;
          }
          return `<div class="dbg-row">
            <span class="dbg-k">${escHtml(new Date(e.ts).toLocaleString())} ${eventBadge(e.event)}</span>
            <span class="dbg-v"><strong>${escHtml(e.provider)}</strong> · ${escHtml(e.model)}${detail}</span>
          </div>`;
        }).join('');
        body.innerHTML = `<div class="dbg-cfg">${section(`Last ${Math.min(events.length, 300)} events (newest first)`, rows)}</div>`;
      },
    },
    {
      id: 'snapshot',
      label: 'Snapshot',
      render: (data, body) => {
        const providers = (data?.byProvider || []) as Array<{ provider: string; categories: Record<string, number>; models: Array<{ id: string; categoryAuto: string; firstSeen: number; lastSeen: number }> }>;
        if (!providers.length) {
          body.innerHTML = '<p class="dbg-empty">No snapshot yet — waiting for the next /models fetch to populate the tracker.</p>';
          return;
        }
        const blocks = providers.map((p) => {
          const catBadges = Object.entries(p.categories)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, n]) => `<span class="dbg-badge">${escHtml(cat)} ${n}</span>`)
            .join(' ');
          const modelRows = p.models.map((m) => `<div class="dbg-row">
            <span class="dbg-k">${escHtml(m.id)}</span>
            <span class="dbg-v"><span class="dbg-badge">${escHtml(m.categoryAuto)}</span> first ${escHtml(fmtRelTime(m.firstSeen))} · last ${escHtml(fmtRelTime(m.lastSeen))}</span>
          </div>`).join('');
          return section(`${p.provider} (${p.models.length})`, `<div class="dbg-row"><span class="dbg-k">categories</span><span class="dbg-v">${catBadges || '—'}</span></div>${modelRows}`);
        }).join('');
        body.innerHTML = `<div class="dbg-cfg">${blocks}</div>`;
      },
    },
  ],
};

// ── rawlog (structured view over api-inout-log) ───────────────────────────────
// Renders the debug trace log with kind/phase/meta/payload blocks. Two tabs:
// "Entries" for the well-structured per-call cards (the primary view), "Raw Tail"
// for the literal last N lines of the current log file.

const rawlogRenderer: Renderer = {
  label: 'API In/Out Log',
  tabs: [
    {
      id: 'entries',
      label: 'Entries',
      render: (data, body) => {
        const entries = (data?.entries || []) as any[];
        const enabled = data?.enabled !== false;
        if (!enabled) {
          body.innerHTML = `<p class="dbg-empty">API logging is disabled. Enable in Settings → System (advanced) then refresh.</p>`;
          return;
        }
        if (!entries.length) {
          body.innerHTML = '<p class="dbg-empty">No log entries yet (or logging was off for prior turns). A model turn, tool call, or proxy hop will populate this.</p>';
          return;
        }
        const html = entries.map((e: any, i: number) => {
          const ts = e.ts ? escHtml(e.ts) : '';
          const kind = escHtml(String(e.kind || '?'));
          const phase = escHtml(String(e.phase || '?'));
          let metaStr = '';
          if (e.meta != null) {
            metaStr = typeof e.meta === 'object' ? JSON.stringify(e.meta, null, 2) : String(e.meta);
          }
          let payload = String(e.payload || '');
          const origLen = payload.length;
          if (payload.length > 2200) payload = payload.slice(0, 2200) + `\n… [truncated ${origLen - 2200} chars]`;
          const metaHtml = metaStr
            ? `<div class="dbg-meta"><pre class="dbg-content" style="margin:4px 8px;padding:6px;font-size:11px;max-height:140px;overflow:auto;border:1px solid var(--stroke);">${escHtml(metaStr)}</pre></div>`
            : '';
          return `<div class="dbg-entry">
            <div class="dbg-entry-hdr">
              <span class="dbg-role">${kind}</span>
              <span class="dbg-badge">${phase}</span>
              ${ts ? `<span class="dbg-ts">${ts}</span>` : ''}
              <span class="dbg-chars">#${i} • ${origLen} chars</span>
            </div>
            ${metaHtml}
            <pre class="dbg-content">${escHtml(payload)}</pre>
          </div>`;
        }).join('');
        const fileNote = data?.currentFile ? ` from ${escHtml(String(data.currentFile))}` : '';
        const total = (data?.totalParsed || entries.length) as number;
        const countNote = total > entries.length ? ` (last ${entries.length} of ${total})` : '';
        body.innerHTML = `<div class="dbg-cfg"><div class="dbg-cfg-sec">Last ${entries.length} entries${countNote} (newest first${fileNote})</div>${html}</div>`;
      },
    },
    {
      id: 'raw',
      label: 'Raw Tail',
      render: (data, body) => {
        const tail = String(data?.rawTail || '');
        const file = data?.currentFile ? escHtml(String(data.currentFile)) : 'current log';
        if (!tail) {
          body.innerHTML = '<p class="dbg-empty">No raw tail (logging may be off or file empty).</p>';
          return;
        }
        body.innerHTML = `<div class="dbg-cfg"><div class="dbg-cfg-sec">Last ~300 lines of ${file}</div><pre class="dbg-content" style="max-height:520px;overflow:auto;white-space:pre;">${escHtml(tail)}</pre></div>`;
      },
    },
  ],
};

// ── registry + dispatcher ─────────────────────────────────────────────────────

export const RENDERERS: Record<string, Renderer> = {
  chathistory: chathistoryRenderer,
  routing: routingRenderer,
  mcp: mcpRenderer,
  costs: costsRenderer,
  tokens: tokensRenderer,
  overview: overviewRenderer,
  monitoring: monitoringRenderer,
  rawlog: rawlogRenderer,
  toolsmon: toolsmonRenderer,
  modeltracker: modelTrackerRenderer,
};

// Ordered menu — the single source of truth for any UI that lists the debug
// views (the `/` App Command Palette, the CodeView Debug panel, etc.). Labels
// mirror each Renderer.label so the menu, the modal title bar, and the backend
// REGISTRY in bridge/modules/observability-plus/debug.ts stay in lockstep.
// Keep the ordering "health/at-a-glance first, raw drilldowns last".
export const DEBUG_MENU_ENTRIES: Array<{ id: string; label: string }> = [
  'overview',
  'monitoring',
  'rawlog',
  'modeltracker',
  'mcp',
  'toolsmon',
  'costs',
  'tokens',
  'chathistory',
  'routing',
].map((id) => ({ id, label: RENDERERS[id].label }));

// Public entry — fires a CustomEvent that <DebugModal /> (panels/DebugModal.tsx)
// listens for. Modal shell, tabs, drag, refresh, escape are owned by React.
// The renderer functions in this file remain the source of HTML for each tab.
export function showDebugModal(type: string, data: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent('yha:debug-modal', { detail: { type, data } }));
}

export default { showDebugModal };
