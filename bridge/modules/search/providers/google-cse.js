'use strict';

module.exports = {
  name: 'google_cse',
  cap: { window: 'day', limit: 100 },
  envKey: 'GOOGLE_CSE_KEY',
  async search(query, opts, endpoint) {
    const key = process.env.GOOGLE_CSE_KEY;
    const cx  = process.env.GOOGLE_CSE_CX;
    if (!key) throw new Error('GOOGLE_CSE_KEY not set');
    if (!cx)  throw new Error('GOOGLE_CSE_CX not set (programmable search engine id)');
    const base = endpoint || 'https://www.googleapis.com/customsearch/v1';
    const num = Math.min(opts.num || 10, 10); // CSE maxes out at 10 per call
    const u = new URL(base);
    u.searchParams.set('key', key);
    u.searchParams.set('cx', cx);
    u.searchParams.set('q', query);
    u.searchParams.set('num', String(num));
    const res = await fetch(u.toString(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Google CSE HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return (data.items || []).map((r) => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || '',
      source: 'google_cse',
    }));
  },
};
