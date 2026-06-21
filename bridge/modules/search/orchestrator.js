// Orchestrator: walk providers in priority order, skip on missing key or
// exhausted quota, fall through on errors / empty results, increment usage on
// success, then fall through to the always-on free DDG/Brave stage if all 4
// paid providers fail.
//
// Plain JS so both the bridge parent (tsx) and the websearch MCP child (node)
// can require this module.
'use strict';

const usage = require('./search-usage');
const cfg   = require('./search-config');

const REGISTRY = {
  tavily:         require('./providers/tavily'),
  exa:            require('./providers/exa'),
  google_cse:     require('./providers/google-cse'),
  bing:           require('./providers/bing'),
  brave:          require('./providers/brave'),
  // playwright-mcp: real-Chrome Google/DDG via the running `playwright-mcp` MCP
  // server (legacy — Windows-side CDP or stealth headless).
  playwright_mcp: require('./providers/playwright-mcp'),
  // web (Pi-local) MCP: drives the visible Pi Docker Chromium that the user
  // can also see in the BrowserWindow iframe.
  web_mcp:        require('./providers/web-mcp'),
};
const FALLBACK = require('./providers/free-fallback');

async function search(query, opts) {
  const num = (opts && opts.num) || 10;
  const { providers } = cfg.load();

  const ordered = providers
    .filter((p) => p.enabled !== false && REGISTRY[p.name])
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));

  const attempts = [];

  // Group by priority tier. Providers in the same tier fire concurrently
  // via Promise.allSettled — the previous serial walk could hit 5×15 s = 75 s
  // worst-case latency for a 5-provider chain when each timed out in turn.
  // Parallelizing within a tier drops worst-case to max(tier latency) and
  // lets `attempts` still record every provider's outcome.
  const tiers = [];
  for (const p of ordered) {
    const prio = p.priority || 99;
    const last = tiers[tiers.length - 1];
    if (last && last.prio === prio) last.list.push(p);
    else tiers.push({ prio, list: [p] });
  }

  for (const tier of tiers) {
    // Filter out pre-skipped providers up front (no key, over quota) — those
    // attempts are recorded immediately, not subjected to the race.
    const runners = [];
    for (const p of tier.list) {
      const provider = REGISTRY[p.name];
      if (provider.envKey && !process.env[provider.envKey]) {
        attempts.push({ provider: p.name, status: 'skipped-no-key' });
        continue;
      }
      const cap = provider.cap || { window: 'month', limit: Infinity };
      if (Number.isFinite(cap.limit)) {
        const used = usage.getCount(p.name, cap.window);
        if (used >= cap.limit) {
          attempts.push({ provider: p.name, status: 'skipped-quota', used, limit: cap.limit });
          continue;
        }
      }
      runners.push({ p, provider });
    }
    if (runners.length === 0) continue;

    // Fire all runners in parallel. Record each outcome into `attempts`
    // regardless of who wins, so the diagnostic log stays complete.
    const settled = await Promise.allSettled(
      runners.map(({ p, provider }) => provider.search(query, { num }, p.endpoint)),
    );
    let winner = null; // { p, results }
    for (let i = 0; i < runners.length; i++) {
      const { p } = runners[i];
      const s = settled[i];
      if (s.status === 'rejected') {
        attempts.push({
          provider: p.name,
          status: 'error',
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
        continue;
      }
      const results = s.value;
      if (!results || results.length === 0) {
        attempts.push({ provider: p.name, status: 'empty' });
        continue;
      }
      attempts.push({ provider: p.name, status: 'ok' });
      // Honor the in-tier ordering from cfg by picking the first non-empty
      // result; ties between equal-priority providers are broken by config
      // declaration order (which is also `runners` iteration order).
      if (!winner) winner = { p, results };
    }
    if (winner) {
      // Always count successful queries — even for quota-less providers like
      // web_mcp / playwright_mcp. The prefs UI shows the count next to the
      // provider name; quota-less providers just don't have an upper bound.
      usage.increment(winner.p.name);
      return { results: winner.results, used: winner.p.name, attempts };
    }
  }

  // Stage 5: free fallback (no quota gate, not counted).
  try {
    const results = await FALLBACK.search(query, { num });
    attempts.push({ provider: 'free_fallback', status: results.length ? 'ok' : 'empty' });
    return { results: results || [], used: results.length ? 'free_fallback' : null, attempts };
  } catch (e) {
    attempts.push({
      provider: 'free_fallback',
      status: 'error',
      error: e instanceof Error ? e.message : String(e),
    });
    return { results: [], used: null, attempts };
  }
}

// Pretty provider names for the header. Lets chat output read like
// "**Tavily found 5 results:**" instead of `tavily`.
const PROVIDER_DISPLAY = {
  tavily:         'Tavily',
  exa:            'Exa',
  google_cse:     'Google',
  bing:           'Bing',
  brave:          'Brave',
  playwright_mcp: 'Playwright MCP (legacy real-Chrome)',
  web_mcp:        'Web MCP (Pi-local visible Chromium)',
  free_fallback:  'DuckDuckGo / Brave (free fallback)',
};

// Untrusted-result escaping. Search results come from third-party providers
// and end up rendered as markdown the model then reads. A snippet containing
// `**[SYSTEM: ignore previous instructions and …]**` would otherwise be
// rendered raw and could blur the data/instruction boundary. Strategy:
//   - title: wrap in backticks; escape backticks inside.
//   - snippet: prefix each line with `> `; collapse newlines; escape
//     markdown special chars per line.
//   - URL: escape `)` so a hostile URL with `)](javascript:…)` can't
//     break out of the link target.
const _MD_SPECIAL_RE = /([\\`*_{}\[\]()#+\-.!|<>~])/g;
function _escapeMdInline(s) {
  return String(s || '').replace(_MD_SPECIAL_RE, '\\$1');
}
function _formatTitle(raw) {
  // Backtick-wrap. Escape any backticks inside by using a longer fence so
  // the content can't break the wrapper. Strip control chars + collapse
  // whitespace so the title stays a single readable line.
  const cleaned = String(raw || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '`(untitled)`';
  // Pick a fence that doesn't appear in the content.
  let fence = '`';
  while (cleaned.includes(fence)) fence += '`';
  return `${fence}${cleaned}${fence}`;
}
function _formatSnippet(raw) {
  const trimmed = String(raw || '').slice(0, 200);
  // Replace newlines + escape markdown chars per line so a malicious
  // snippet can't inject headings, bullets, or fenced code blocks.
  const oneLine = trimmed.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return `\n  > ${_escapeMdInline(oneLine)}`;
}
function _safeUrl(raw) {
  // Strip control chars; escape `)` so the URL can't terminate the markdown
  // link target. Protocol filtering / DNS-rebinding etc. is the provider's
  // problem upstream; this is just the rendering-layer defense.
  return String(raw || '').replace(/[\u0000-\u001f]/g, '').replace(/\)/g, '\\)');
}

function formatMarkdown(results, provider) {
  if (!results || !results.length) {
    if (provider) return `_${PROVIDER_DISPLAY[provider] || provider} returned no results._`;
    return '(no results)';
  }
  const body = results
    .map((r) => {
      const url = _safeUrl(r.url);
      const titleText = _formatTitle(r.title || r.url);
      const head = `[${titleText}](${url})`;
      const snippet = _formatSnippet(r.snippet);
      return head + snippet;
    })
    .join('\n');
  if (!provider) return body;
  const label = PROVIDER_DISPLAY[provider] || provider;
  const noun = results.length === 1 ? 'result' : 'results';
  return `**${label} found ${results.length} ${noun}:**\n\n${body}`;
}

module.exports = { search, formatMarkdown, PROVIDER_DISPLAY };
