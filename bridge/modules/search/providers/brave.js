'use strict';

module.exports = {
  name: 'brave',
  cap: { window: 'month', limit: 2000 },
  envKey: 'BRAVE_API_KEY',
  async search(query, opts, endpoint) {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error('BRAVE_API_KEY not set');
    const base = endpoint || 'https://api.search.brave.com/res/v1/web/search';
    const u = new URL(base);
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(opts.num || 10));
    const res = await fetch(u.toString(), {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': key,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Brave HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return ((data.web && data.web.results) || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
      source: 'brave',
    }));
  },
};
