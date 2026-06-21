import { useAppStore } from './stores/index.js';
import { getAppActions, getAppState } from './stores/index.js';
import { save } from './state.js';

const MIN = 0.2;
const MAX = 0.8;

export function Splitter() {
  const orient = useAppStore((s) => s.viewOrient);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const startPos = orient === 'h' ? e.clientX : e.clientY;
    const parent = (e.currentTarget as HTMLElement).parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const total = orient === 'h' ? rect.width : rect.height;
    const startFrac = getAppState().viewSplit;

    function onMove(ev: MouseEvent) {
      const cur = orient === 'h' ? ev.clientX : ev.clientY;
      const delta = (cur - startPos) / total;
      getAppActions().setViewSplit(Math.max(MIN, Math.min(MAX, startFrac + delta)));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      save.view();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    e.preventDefault();
    const t0 = e.touches[0];
    const startPos = orient === 'h' ? t0.clientX : t0.clientY;
    const parent = (e.currentTarget as HTMLElement).parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const total = orient === 'h' ? rect.width : rect.height;
    const startFrac = getAppState().viewSplit;

    function onMove(ev: TouchEvent) {
      const tc = ev.touches[0];
      const cur = orient === 'h' ? tc.clientX : tc.clientY;
      const delta = (cur - startPos) / total;
      getAppActions().setViewSplit(Math.max(MIN, Math.min(MAX, startFrac + delta)));
    }
    function onEnd() {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      save.view();
    }
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  return (
    <div
      id="splitter"
      className="splitter"
      data-dir={orient}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onDoubleClick={() => {
        getAppActions().setViewSplit(0.5);
        save.view();
      }}
    />
  );
}
