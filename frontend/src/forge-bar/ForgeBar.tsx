// ForgeBar — conditional chrome that materializes when the workshop is
// active or has broken something. Mounted once at App level so it
// survives layout swaps. Position-fixed near the composer (grill plan
// 11.3). At rest renders nothing; on activity flips into a pill; on
// click expands to show details + actions.
//
// Failure path always wins: a module in `state: "failed"` shows the
// emergency red pill with a one-click rewind action, regardless of any
// active recent-edit indicator.

import { useEffect, useState } from 'react';
import {
  useForgeStore,
  startForgePolling,
  restoreEdit,
  RECENT_EDIT_MS,
} from './forge-state.js';

export function ForgeBar() {
  const failedModules = useForgeStore((s) => s.failedModules);
  const recentEdit = useForgeStore((s) => s.recentEdit);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => startForgePolling(), []);
  // Tick a clock so the "recent edit" window closes on its own without
  // waiting for the next poll to flip recentEdit to null.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const editIsRecent =
    recentEdit !== null && now - recentEdit.ts < RECENT_EDIT_MS;
  const hasFailure = failedModules.length > 0;

  if (!hasFailure && !editIsRecent) return null;

  const mode: 'failure' | 'activity' = hasFailure ? 'failure' : 'activity';
  const headline = hasFailure
    ? failedModules.length === 1
      ? `${failedModules[0].name} failed to load`
      : `${failedModules.length} modules failed`
    : `${recentEdit?.module || 'edit'} · ${recentEdit?.fileCount || 0} files`;

  async function onUndoLatest() {
    if (!recentEdit) {
      setMsg('No edit to undo.');
      return;
    }
    setBusy(true);
    try {
      const txt = await restoreEdit(recentEdit.id);
      setMsg(txt);
    } catch (e) {
      setMsg(`Rewind failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const pillStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 90,
    background: mode === 'failure' ? 'rgba(120,30,30,0.95)' : 'rgba(28,32,40,0.92)',
    color: mode === 'failure' ? '#ffd5d5' : '#cde',
    border: '1px solid ' + (mode === 'failure' ? '#7a3a3a' : '#345'),
    borderRadius: expanded ? '8px' : '999px',
    padding: expanded ? '10px 14px' : '6px 14px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    font: '12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
    minWidth: expanded ? '320px' : 'unset',
    maxWidth: '480px',
    transition: 'border-radius 120ms, padding 120ms',
  };

  return (
    <div
      role="status"
      aria-live="polite"
      aria-expanded={expanded}
      style={pillStyle}
      data-forge-mode={mode}
    >
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
        title={expanded ? 'Click to collapse' : 'Click to expand'}
      >
        <span aria-hidden style={{ fontSize: '11px', opacity: 0.85 }}>
          {mode === 'failure' ? '⚠' : '⚙'}
        </span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {headline}
        </span>
        <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: '10px' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {expanded && (
        <div style={{ marginTop: '10px' }}>
          {hasFailure && (
            <div style={{ marginBottom: editIsRecent ? '10px' : 0 }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>Failed modules</div>
              {failedModules.map((m) => (
                <div key={m.name} style={{ marginBottom: '4px' }}>
                  <div style={{ color: '#fdd' }}>{m.name}</div>
                  {m.error && (
                    <div
                      style={{ opacity: 0.75, fontSize: '11px', whiteSpace: 'pre-wrap' }}
                    >
                      {m.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {editIsRecent && recentEdit && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>Latest edit</div>
              <div style={{ opacity: 0.85 }}>
                {recentEdit.trigger} · {recentEdit.module} · {recentEdit.fileCount} files
              </div>
              <div style={{ opacity: 0.6, fontSize: '11px' }}>
                {new Date(recentEdit.ts).toISOString().slice(11, 19)} ·{' '}
                {Math.max(0, Math.round((now - recentEdit.ts) / 1000))}s ago
              </div>
            </div>
          )}

          <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={busy || !recentEdit}
              onClick={onUndoLatest}
              style={{
                padding: '4px 10px',
                borderRadius: '4px',
                border: '1px solid #7a3a3a',
                background: busy ? '#3a1e1e' : 'rgba(120,30,30,0.55)',
                color: '#fdd',
                cursor: busy || !recentEdit ? 'not-allowed' : 'pointer',
                font: 'inherit',
              }}
            >
              {busy ? 'Working…' : '↩ Rewind last edit'}
            </button>
            <a
              href="/__rewind/recover"
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '4px 10px',
                borderRadius: '4px',
                border: '1px solid #345',
                background: 'rgba(40,50,70,0.55)',
                color: '#cde',
                textDecoration: 'none',
              }}
            >
              Open recovery
            </a>
          </div>
          {msg && <div style={{ marginTop: '6px', opacity: 0.85 }}>{msg}</div>}
        </div>
      )}
    </div>
  );
}
