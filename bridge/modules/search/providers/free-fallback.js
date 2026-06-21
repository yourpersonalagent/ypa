// Free fallback: DuckDuckGo Lite (primary) → Brave search scrape (fallback).
// Extracted from bridge/tools/exec.ts WebSearch case so the orchestrator can use
// it as stage 5 after all four paid providers are exhausted or unconfigured.
'use strict';

async function ddgSearch(query, opts) {
  const q = encodeURIComponent(query);
  const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${q}`;
  const res = await fetch(ddgUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const links = [];
  const linkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const cap = opts.num || 10;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (url && title && !url.includes('duckduckgo.com') && links.length < cap) {
      if (!links.some((l) => l.url === url)) {
        links.push({ title, url, snippet: '', source: 'free_fallback' });
      }
    }
  }
  return links;
}

async function braveSearch(query, opts) {
  const q = encodeURIComponent(query);
  const searchUrl = `https://search.brave.com/search?q=${q}&source=web`;
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  const rawHtml = await res.text();
  const blocks = rawHtml.split(/<div[^>]+class="snippet[^"]*"[^>]+data-type="web"/);
  const results = [];
  const cap = opts.num || 10;
  for (const block of blocks.slice(1)) {
    const hrefM = block.match(/href="(https:\/\/[^"]+)"/);
    const titleM = block.match(/class="title[^"]*"[^>]+title="([^"]+)"/);
    if (!hrefM || !titleM) continue;
    const url = hrefM[1];
    const title = titleM[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
      .trim();
    results.push({ title, url, snippet: '', source: 'free_fallback' });
    if (results.length >= cap) break;
  }
  return results;
}

module.exports = {
  name: 'free_fallback',
  cap: null,
  envKey: '',
  async search(query, opts) {
    try {
      const r = await ddgSearch(query, opts);
      if (r.length) return r;
    } catch (_) { /* fall through to Brave */ }
    try { return await braveSearch(query, opts); } catch (_) { return []; }
  },
};
