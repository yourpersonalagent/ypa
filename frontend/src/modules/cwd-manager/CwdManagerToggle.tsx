import { useEffect } from 'react';
import { useCwdManagerStore } from './cwdManagerStore.js';

export function CwdManagerToggle({ cwd }: { cwd: string | null; sessionId: string | null }) {
  const entry = useCwdManagerStore((s) => (cwd ? s.byCwd[cwd] : null));
  const refreshEntry = useCwdManagerStore((s) => s.refreshEntry);
  const toggle = useCwdManagerStore((s) => s.toggle);
  const tickNow = useCwdManagerStore((s) => s.tickNow);

  useEffect(() => {
    if (cwd) refreshEntry(cwd);
  }, [cwd, refreshEntry]);

  if (!cwd) return null;
  const enabled = !!entry?.enabled;
  const mode = enabled ? entry?.mode || 'active' : 'off';
  const open = entry?.openTodoCount ?? 0;
  const needs = entry?.needsAgent;

  async function onToggle() {
    if (!cwd) return;
    await toggle(cwd, !enabled);
  }

  async function onCheck() {
    if (!cwd) return;
    if (!enabled) await toggle(cwd, true);
    await tickNow(cwd);
  }

  return (
    <div
      className="cwd-manager-strip"
      title="CWD Manager monitors tasks for this working directory."
    >
      <span className={`cwd-manager-dot ${enabled ? mode : 'off'}`} />
      <span className="cwd-manager-strip-label">CWD Manager</span>
      <span className="cwd-manager-strip-state">
        {enabled ? `${mode} · ${open} open${needs ? ` · ${needs}` : ''}` : 'off'}
      </span>
      <button type="button" className="cwd-sub-action" onClick={onToggle}>
        {enabled ? 'stop' : 'start'}
      </button>
      <button type="button" className="cwd-sub-action" onClick={onCheck}>
        check
      </button>
    </div>
  );
}
