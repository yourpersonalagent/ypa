'use strict';

module.exports = {
  name: 'exa',
  cap: { window: 'month', limit: 1000 },
  envKey: 'EXA_API_KEY',
  async search(query, opts, endpoint) {
    const key = process.env.EXA_API_KEY;
    if (!key) throw new Error('EXA_API_KEY not set');
    const url = endpoint || 'https://api.exa.ai/search';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
      },
      body: JSON.stringify({
        query,
        numResults: opts.num || 10,
        contents: { text: { maxCharacters: 1000 } },
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Exa HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.text || '').slice(0, 300),
      content: r.text || undefined,
      source: 'exa',
    }));
  },
};
