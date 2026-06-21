import { useEffect, useState } from 'react';
import { loadCosts, clearCosts } from './costs.js';
import type { CostsData } from './costs.js';
import { fmt$ } from './format.js';
import { useAppStore } from '../stores/index.js';

export function TabStats() {
  const [costs, setCosts] = useState<CostsData | null>(null);
  const models = useAppStore((s) => s.models) as { name: string; provider?: string }[];

  async function fetch_() {
    setCosts(await loadCosts());
  }

  useEffect(() => { void fetch_(); }, []);

  if (!costs) {
    return <div className="prefs-loading">Loading stats…</div>;
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayData = costs.daily?.[today] || { total: 0, byModel: {}, byProvider: {} };
  const modelEntries = Object.entries(costs.allTime.byModel || {}).sort((a, b) => b[1] - a[1]);
  const provEntries = Object.entries(costs.allTime.byProvider || {}).sort((a, b) => b[1] - a[1]);
  const dailyEntries = Object.entries(costs.daily || {})
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 30);

  function handleClear() {
    if (!confirm('Clear all cost tracking data? This cannot be undone.')) return;
    clearCosts().then(() => fetch_());
  }

  return (
    <>
      <div className="prefs-stat-grid">
        <div className="prefs-stat-card">
          <div className="prefs-stat-num">{fmt$(costs.allTime.total)}</div>
          <div className="prefs-stat-lbl">All-time total</div>
        </div>
        <div className="prefs-stat-card">
          <div className="prefs-stat-num">{fmt$(todayData.total)}</div>
          <div className="prefs-stat-lbl">Today ({today})</div>
        </div>
        <div className="prefs-stat-card">
          <div className="prefs-stat-num">{modelEntries.length}</div>
          <div className="prefs-stat-lbl">Models used</div>
        </div>
      </div>

      <h4 className="prefs-sec">All-time by model</h4>
      <table className="prefs-table">
        <thead><tr><th>Model</th><th>Provider</th><th>Cost</th></tr></thead>
        <tbody>
          {modelEntries.length === 0
            ? <tr><td colSpan={3} className="dim" style={{ textAlign: 'center', padding: '10px' }}>No data yet</td></tr>
            : modelEntries.map(([model, cost]) => {
                const info = models.find((m) => m.name === model);
                return (
                  <tr key={model}>
                    <td>{model}</td>
                    <td className="dim">{info?.provider || ''}</td>
                    <td className="cost-val">{fmt$(cost)}</td>
                  </tr>
                );
              })
          }
        </tbody>
      </table>

      <h4 className="prefs-sec">All-time by provider</h4>
      <table className="prefs-table">
        <thead><tr><th>Provider</th><th>Cost</th></tr></thead>
        <tbody>
          {provEntries.length === 0
            ? <tr><td colSpan={2} className="dim" style={{ textAlign: 'center', padding: '10px' }}>No data yet</td></tr>
            : provEntries.map(([prov, cost]) => (
                <tr key={prov}>
                  <td>{prov}</td>
                  <td className="cost-val">{fmt$(cost)}</td>
                </tr>
              ))
          }
        </tbody>
      </table>

      <h4 className="prefs-sec">Daily history</h4>
      <table className="prefs-table">
        <thead><tr><th>Date</th><th>Top model</th><th>Provider</th><th>Cost</th></tr></thead>
        <tbody>
          {dailyEntries.length === 0
            ? <tr><td colSpan={4} className="dim" style={{ textAlign: 'center', padding: '10px' }}>No data yet</td></tr>
            : dailyEntries.map(([date, d]) => {
                const topModel = Object.entries(d.byModel || {}).sort((a, b) => b[1] - a[1])[0];
                const prov = Object.entries(d.byProvider || {}).sort((a, b) => b[1] - a[1])[0];
                return (
                  <tr key={date}>
                    <td>{date}</td>
                    <td className="dim">{topModel ? topModel[0] : '—'}</td>
                    <td className="dim">{prov ? prov[0] : '—'}</td>
                    <td className="cost-val">{fmt$(d.total)}</td>
                  </tr>
                );
              })
          }
        </tbody>
      </table>

      <div style={{ marginTop: '18px' }}>
        <button className="prefs-btn-danger" onClick={handleClear}>Clear all cost data</button>
      </div>
    </>
  );
}
