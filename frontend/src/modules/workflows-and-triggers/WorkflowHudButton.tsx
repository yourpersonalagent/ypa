import { useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore.js';
import { WorkflowPicker } from '../../workflows/WorkflowPicker.js';

export function WorkflowHudButton() {
  const wfName = useAppStore((s) => s.workflow.name);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btnRef}
        className="hud-btn hud-wf"
        id="btn-workflows"
        title={wfName ? `Workflows — current: ${wfName}` : 'Workflows'}
        onClick={() => setOpen((v) => !v)}
      >
        {wfName ? `≡ ${wfName}` : '≡'}
      </button>
      <WorkflowPicker open={open} onClose={() => setOpen(false)} anchorRef={btnRef} />
    </>
  );
}
