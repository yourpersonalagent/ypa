'use strict';

module.exports = {
  name: 'tavily',
  cap: { window: 'month', limit: 1000 },
  envKey: 'TAVILY_API_KEY',
  async search(query, opts, endpoint) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error('TAVILY_API_KEY not set');
    const url = endpoint || 'https://api.tavily.com/search';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: opts.num || 10,
        search_depth: 'basic',
        include_answer: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Tavily HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.content || '').slice(0, 300),
      content: r.content || undefined,
      source: 'tavily',
    }));
  },
};
