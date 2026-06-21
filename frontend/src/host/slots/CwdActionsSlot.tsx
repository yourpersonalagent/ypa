// CwdActionsSlot — renders a single "Actions" sub-section in the CWD
// dropdown that bundles every module-registered button (rclone, github,
// build/synthesize knowledge graph, …). The whole sub-section vanishes
// when no module has registered an entry — so disabling all of them
// removes the row entirely instead of leaving an empty header.
//
// Usage (in CwdPanel.tsx):
//   <CwdActionsSlot />
//
// Modules register via host.registers.cwdActionButtons.add({...}).

import { registers } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';

export function CwdActionsSlot() {
  const entries = useRegisterList(registers.cwdActionButtons);
  // Re-evaluate `when` on each render — the register's filtered list()
  // already does this, but use it to compute visibility for the wrapper
  // header too (hide the whole row if every entry's when() returns false).
  const visible = entries.filter((e) => (e.when ? safeWhen(e.when) : true));
  if (!visible.length) return null;
  return (
    <div className="cwd-sub">
      <div className="cwd-sub-head">
        <span className="cwd-sub-title">Actions</span>
      </div>
      <div className="cwd-actions">
        {visible.map((entry) => (
          <button
            key={entry.id}
            id={entry.domId}
            className="cwd-action"
            title={entry.title}
            onClick={entry.onClick}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function safeWhen(fn: () => boolean): boolean {
  try { return fn() !== false; }
  catch { return false; }
}
