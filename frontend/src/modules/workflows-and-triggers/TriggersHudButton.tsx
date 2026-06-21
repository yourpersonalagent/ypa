import { useRef, useState } from 'react';
import { TriggersPicker } from '../../workflows/TriggersPicker.js';

export function TriggersHudButton() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btnRef}
        className={`hud-btn${open ? ' hud-active' : ''}`}
        id="btn-triggers"
        title="Triggers"
        onClick={() => setOpen((v) => !v)}
      >
        ⏱
      </button>
      <TriggersPicker open={open} onClose={() => setOpen(false)} anchorRef={btnRef} />
    </>
  );
}
