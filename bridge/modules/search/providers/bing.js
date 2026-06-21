'use strict';

module.exports = {
  name: 'bing',
  cap: { window: 'month', limit: 1000 },
  envKey: 'BING_API_KEY',
  async search(query, opts, endpoint) {
    const key = process.env.BING_API_KEY;
    if (!key) throw new Error('BING_API_KEY not set');
    const base = endpoint || 'https://api.bing.microsoft.com/v7.0/search';
    const u = new URL(base);
    u.searchParams.set('q', query);
    u.searchParams.set('count', String(opts.num || 10));
    u.searchParams.set('responseFilter', 'Webpages');
    const res = await fetch(u.toString(), {
      headers: { 'Ocp-Apim-Subscription-Key': key },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Bing HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return ((data.webPages && data.webPages.value) || []).map((r) => ({
      title: r.name || '',
      url: r.url || '',
      snippet: r.snippet || '',
      source: 'bing',
    }));
  },
};
