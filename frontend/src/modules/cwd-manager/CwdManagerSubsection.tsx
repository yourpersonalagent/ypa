import { useEffect } from 'react';
import { useCwdManagerStore } from './cwdManagerStore.js';
import type { CwdManagerEntry, CwdMode } from './types.js';

const INTERVALS = [30_000, 60_000, 120_000] as const;

function intervalLabel(ms: number): string {
  if (ms === 30_000) return '0.5 min';
  if (ms === 60_000) return '1 min';
  if (ms === 120_000) return '2 min';
  return `${Math.round(ms / 1000)}s`;
}

function ago(ts: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function dotClass(mode: CwdMode | undefined, enabled: boolean | undefined): string {
  if (!enabled) return 'off';
  if (mode === 'active') return 'active';
  if (mode === 'alert') return 'alert';
  if (mode === 'idle') return 'idle';
  return 'off';
}

function statusText(entry: CwdManagerEntry | null): string {
  if (!entry) return 'off';
  if (!entry.enabled) return 'off';
  if (entry.needsAgent) return `${entry.needsAgent}: ${entry.needsAgentReason || 'needs agent'}`;
  if (entry.lastAction === 'all_done') return 'all tasks done';
  return entry.mode;
}

export function CwdManagerSubsection({ cwd }: { cwd: string | null }) {
  const entry = useCwdManagerStore((s) => (cwd ? s.byCwd[cwd] : null));
  const error = useCwdManagerStore((s) => s.error);
  const refreshEntry = useCwdManagerStore((s) => s.refreshEntry);
  const toggle = useCwdManagerStore((s) => s.toggle);
  const configure = useCwdManagerStore((s) => s.configure);
  const setAgentEnabled = useCwdManagerStore((s) => s.setAgentEnabled);
  const setWorkerEnabled = useCwdManagerStore((s) => s.setWorkerEnabled);
  const startWorker = useCwdManagerStore((s) => s.startWorker);
  const tickNow = useCwdManagerStore((s) => s.tickNow);

  useEffect(() => {
    if (cwd) refreshEntry(cwd);
  }, [cwd, refreshEntry]);

  const enabled = !!entry?.enabled;
  const mode = entry?.mode || 'off';

  async function onToggle() {
    if (!cwd) return;
    await toggle(cwd, !enabled);
  }

  async function onInterval(v: string) {
    if (!cwd) return;
    await configure(cwd, Number(v));
  }

  async function onAgentToggle() {
    if (!cwd || !entry?.enabled) return;
    await setAgentEnabled(cwd, !entry.agentEnabled);
  }

  async function onWorkerToggle() {
    if (!cwd || !entry?.enabled) return;
    await setWorkerEnabled(cwd, !entry.workerEnabled);
  }

  async function onStartWorker() {
    if (!cwd || !entry?.enabled) return;
    if (!entry.workerEnabled) await setWorkerEnabled(cwd, true);
    await startWorker(cwd);
  }

  async function onTick() {
    if (!cwd) return;
    if (!entry?.enabled) await toggle(cwd, true);
    await tickNow(cwd);
  }

  return (
    <details className="cwd-sub cwd-sub-collapsible cwd-manager-sub">
      <summary className="cwd-sub-head">
        <span className="cwd-sub-title">CWD Manager</span>
        <span
          className={`cwd-manager-dot ${dotClass(mode, enabled)}`}
          title={statusText(entry || null)}
        />
      </summary>

      {!cwd ? (
        <div className="cwd-empty">no working directory bound</div>
      ) : (
        <>
          <div className="cwd-manager-card">
            <div className="cwd-manager-mainrow">
              <label
                className="cwd-serve-toggle cwd-manager-toggle"
                title="Enable heartbeat monitoring for this working directory."
              >
                <input type="checkbox" checked={enabled} onChange={onToggle} />
                <span className="cwd-switch" aria-hidden="true" />
                <span>
                  <span className="cwd-serve-field-label">
                    {enabled ? 'Monitoring' : 'Monitoring off'}
                  </span>
                  <span className="cwd-serve-field-help">
                    programmatic heartbeat{enabled ? ` · ${mode}` : ''}
                  </span>
                </span>
              </label>
              <label
                className="cwd-serve-field cwd-manager-interval"
                title="Active heartbeat interval. Idle checks stay at 5 min."
              >
                <span>
                  <span className="cwd-serve-field-label">Interval</span>
                  <span className="cwd-serve-field-help">active mode</span>
                </span>
                <span className="cwd-select-wrap cwd-select-wrap-small">
                  <select
                    className="cwd-select"
                    value={entry?.activeIntervalMs || 60_000}
                    onChange={(e) => onInterval(e.target.value)}
                    disabled={!cwd}
                  >
                    {INTERVALS.map((ms) => (
                      <option key={ms} value={ms}>
                        {intervalLabel(ms)}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
            </div>

            <label
              className="cwd-serve-toggle cwd-manager-agent-toggle"
              title="Allow CWD Manager to use an LLM-backed manager session when the heartbeat decides attention is needed."
            >
              <input
                type="checkbox"
                checked={!!entry?.agentEnabled}
                disabled={!enabled}
                onChange={onAgentToggle}
              />
              <span className="cwd-switch" aria-hidden="true" />
              <span>
                <span className="cwd-serve-field-label">Agent checkups</span>
                <span className="cwd-serve-field-help">
                  {entry?.agentEnabled ? 'LLM manager enabled' : 'off · avoids model calls'}
                </span>
              </span>
            </label>


            <label
              className="cwd-serve-toggle cwd-manager-agent-toggle"
              title="Allow CWD Manager to start a focused worker chat for pending work. This can use model calls and may modify files."
            >
              <input
                type="checkbox"
                checked={!!entry?.workerEnabled}
                disabled={!enabled}
                onChange={onWorkerToggle}
              />
              <span className="cwd-switch" aria-hidden="true" />
              <span>
                <span className="cwd-serve-field-label">Worker chats</span>
                <span className="cwd-serve-field-help">
                  {entry?.workerEnabled ? 'auto task chats enabled' : 'off · no autonomous file work'}
                </span>
              </span>
            </label>

            <div className="cwd-manager-meta">
              <span>{entry?.openTodoCount ?? 0} open</span>
              <span>{entry?.inProgressCount ?? 0} in progress</span>
              <span>last check {ago(entry?.lastProgrammaticAt || 0)}</span>
              {entry?.lastAgentAt ? <span>agent {ago(entry.lastAgentAt)}</span> : null}
              {entry?.lastWorkerAt ? <span>worker {ago(entry.lastWorkerAt)}</span> : null}
            </div>

            <div className="cwd-manager-status" title={entry?.needsAgentReason || undefined}>
              {statusText(entry || null)}
              {entry?.managerSessionId ? ` · manager ${entry.managerSessionId}` : ''}
              {entry?.activeCheckupSessionId ? ` · worker ${entry.activeCheckupSessionId}` : ''}
            </div>

            <div className="cwd-actions cwd-manager-actions">
              <button type="button" className="cwd-btn" onClick={onToggle}>
                {enabled ? 'Stop' : 'Start'}
              </button>
              <button type="button" className="cwd-btn" onClick={onStartWorker} disabled={!enabled}>
                Start worker
              </button>
              <button type="button" className="cwd-btn cwd-btn-primary" onClick={onTick}>
                Check now
              </button>
            </div>
          </div>
          {error && <div className="cwd-error">{error}</div>}
        </>
      )}
    </details>
  );
}
