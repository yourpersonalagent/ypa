import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

// Live external-dependency status from the bridge scanner (GET /v1/system/deps),
// which reads the repo-root dependencies.json manifest and probes THIS box. The
// same detection path backs the MCP/core `assertDep()` guard, so what's shown
// here is exactly what the runtime sees.

type DepStatus = 'present' | 'missing' | 'na' | 'unknown';

type DepRow = {
  id: string;
  label: string;
  category: string;
  optional: boolean;
  requiredBy: string[];
  installHint: string;
  status: DepStatus;
  detail: string | null;
  version: string | null;
};

type Summary = {
  total: number;
  present: number;
  missingRequired: number;
  missingOptional: number;
  na: number;
  unknown: number;
};

type DepScan = {
  generatedAt: string;
  platform: string;
  summary: Summary;
  deps: DepRow[];
};

const DOT: Record<DepStatus, { glyph: string; color: string }> = {
  present: { glyph: '●', color: 'var(--ok, #6c6)' },
  missing: { glyph: '●', color: 'var(--err, #f66)' },
  na: { glyph: '–', color: 'var(--fg-mute)' },
  unknown: { glyph: '?', color: 'var(--fg-mute)' },
};

function DepItem({ dep }: { dep: DepRow }) {
  // Optional-but-missing reads as a warning, not an error.
  const color =
    dep.status === 'missing' && dep.optional ? 'var(--warn, #e6b450)' : DOT[dep.status].color;
  const glyph = dep.status === 'missing' && dep.optional ? '○' : DOT[dep.status].glyph;
  const showHint = dep.status === 'missing' && !!dep.installHint;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 'var(--radius-xs)',
        background: 'var(--bg)',
        border: '1px solid var(--stroke)',
      }}
    >
      <span style={{ color, fontSize: 12, lineHeight: '16px', width: 12, textAlign: 'center', flexShrink: 0 }}>
        {glyph}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--fg)' }}>{dep.label}</span>
          <span
            style={{
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: '.06em',
              padding: '1px 5px',
              borderRadius: 8,
              background: 'var(--bg-2)',
              color: 'var(--fg-mute)',
            }}
          >
            {dep.category}
          </span>
          {dep.version && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>{dep.version}</span>
          )}
        </div>
        {dep.detail && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--fg-mute)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={dep.detail}
          >
            {dep.detail}
          </div>
        )}
        {dep.requiredBy.length > 0 && (
          <div style={{ fontSize: 10, color: 'var(--fg-mute)' }}>needed by: {dep.requiredBy.join(' · ')}</div>
        )}
        {showHint && (
          <div style={{ fontSize: 10, color: 'var(--warn, #e6b450)', marginTop: 2 }}>{dep.installHint}</div>
        )}
      </div>
    </div>
  );
}

function DepGroup({ title, deps }: { title: string; deps: DepRow[] }) {
  if (deps.length === 0) return null;
  return (
    <>
      <div
        className="prefs-hint"
        style={{ marginTop: 12, textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 10, color: 'var(--fg-mute)' }}
      >
        {title} ({deps.length})
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          marginTop: 4,
          border: '1px solid var(--stroke)',
          borderRadius: 'var(--radius-sm)',
          padding: 6,
          background: 'var(--bg-2)',
        }}
      >
        {deps.map((d) => (
          <DepItem key={d.id} dep={d} />
        ))}
      </div>
    </>
  );
}

export function TabDependencies() {
  const apiBase = api.config.baseUrl;
  const [scan, setScan] = useState<DepScan | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (force: boolean) => {
      setLoading(true);
      try {
        const r = await fetch(apiBase + '/v1/system/deps' + (force ? '?refresh=1' : ''));
        const d = (await r.json()) as DepScan & { success?: boolean; error?: string };
        if (!d.success) throw new Error(d.error || 'scan failed');
        setScan(d);
        setErr('');
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [apiBase],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const deps = scan?.deps || [];
  const requiredMissing = deps.filter((d) => d.status === 'missing' && !d.optional);
  const optionalMissing = deps.filter((d) => d.status === 'missing' && d.optional);
  const present = deps.filter((d) => d.status === 'present');
  const inactive = deps.filter((d) => d.status === 'na' || d.status === 'unknown');
  const sum = scan?.summary;

  return (
    <>
      <section className="prefs-section" data-view="advanced">
        <h4 className="prefs-sec">External dependencies</h4>
        <div className="prefs-hint" style={{ marginBottom: 8 }}>
          Live status of the system dependencies outside the bun/go package trees — the container
          runtime, CLI binaries, API keys, and Python venvs tracked in <code>dependencies.json</code>.
          The bridge probes this box directly; the same check backs the runtime guards, so a green
          row means the feature that needs it will actually run.
        </div>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="prefs-btn" disabled={loading} onClick={() => { void load(true); }}>
            {loading ? 'Scanning…' : 'Re-scan'}
          </button>
          {sum && (
            <span className="prefs-hint" style={{ margin: 0 }}>
              <span style={{ color: 'var(--ok, #6c6)' }}>{sum.present} present</span>
              {sum.missingRequired > 0 && (
                <> · <span style={{ color: 'var(--err, #f66)' }}>{sum.missingRequired} required missing</span></>
              )}
              {sum.missingOptional > 0 && (
                <> · <span style={{ color: 'var(--warn, #e6b450)' }}>{sum.missingOptional} optional missing</span></>
              )}
              {sum.na > 0 && <> · {sum.na} n/a</>}
            </span>
          )}
        </div>
        {err && (
          <div className="prefs-hint" style={{ color: 'var(--err, #f66)' }}>✗ {err}</div>
        )}
        {!scan && !err && <div className="prefs-hint">Loading…</div>}
        {scan && (
          <div className="prefs-hint" style={{ fontSize: 10, color: 'var(--fg-mute)' }}>
            Scanned {new Date(scan.generatedAt).toLocaleString()} · platform {scan.platform}
          </div>
        )}
      </section>

      {scan && (
        <section className="prefs-section" data-view="advanced">
          <DepGroup title="Missing — required" deps={requiredMissing} />
          <DepGroup title="Missing — optional" deps={optionalMissing} />
          <DepGroup title="Present" deps={present} />
          <DepGroup title="Not applicable" deps={inactive} />
        </section>
      )}
    </>
  );
}
