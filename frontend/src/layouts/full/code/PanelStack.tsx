// PanelStack — generic tabbed container used by both right + bottom regions
// in the Code view. Reads its panel list from useCodeLayout and re-renders
// when the user drags a tab between regions.
//
// Drag/drop wiring uses native HTML5 DnD with a custom MIME so it doesn't
// collide with the chat-input file-drop or with the FileManager upload
// queue. The data transfer payload is just the PanelId — the layout store
// owns the move logic.

import { useCallback, useState } from 'react';
import { useCodeLayout, type StackId } from './code-view-state.js';
import { PANELS, type PanelId } from './code-panels.js';

const DT_MIME = 'application/x-yha-code-panel';

interface Props {
  stack: StackId;
}

export function PanelStack({ stack }: Props) {
  const order  = useCodeLayout((s) => stack === 'right' ? s.right  : s.bottom);
  const active = useCodeLayout((s) => stack === 'right' ? s.rightActive : s.bottomActive);
  const setActive = useCodeLayout((s) => s.setActive);
  const movePanel = useCodeLayout((s) => s.movePanel);

  const [dropHint, setDropHint] = useState<number | null>(null);

  const onDragStart = (e: React.DragEvent, id: PanelId) => {
    e.dataTransfer.setData(DT_MIME, id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const isOurDrag = (e: React.DragEvent) => {
    // Some browsers don't expose the data list during dragover; fall back to
    // checking the type list which is always available.
    return e.dataTransfer.types.includes(DT_MIME);
  };

  const onTabDragOver = (e: React.DragEvent, idx: number) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropHint(idx);
  };

  const onTabDrop = (e: React.DragEvent, idx: number) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(DT_MIME) as PanelId;
    setDropHint(null);
    if (id) movePanel(id, stack, idx);
  };

  const onStripDragOver = (e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropHint === null) setDropHint(order.length);
  };

  const onStripDrop = (e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(DT_MIME) as PanelId;
    setDropHint(null);
    if (id) movePanel(id, stack);
  };

  const clearHint = useCallback(() => setDropHint(null), []);

  return (
    <div className={`cv-stack cv-${stack}`}>
      <div
        className="cv-stack-tabs"
        role="tablist"
        onDragOver={onStripDragOver}
        onDragLeave={clearHint}
        onDrop={onStripDrop}
      >
        {order.map((id, idx) => {
          const def = PANELS[id];
          if (!def) return null;
          const isActive = id === active;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={isActive}
              draggable
              className={`cv-stack-tab${isActive ? ' is-active' : ''}${dropHint === idx ? ' is-drop-target' : ''}`}
              onClick={() => setActive(stack, id)}
              onDragStart={(e) => onDragStart(e, id)}
              onDragOver={(e) => onTabDragOver(e, idx)}
              onDragLeave={clearHint}
              onDrop={(e) => onTabDrop(e, idx)}
              title={`Drag to move ${def.label} between regions`}
            >
              {def.label}
            </button>
          );
        })}
        {order.length === 0 && (
          <span className="cv-stack-empty">drop a tab here</span>
        )}
      </div>
      <div className="cv-stack-body">
        {order.length === 0 && (
          <div className="cv-pane">
            <div className="cv-pane-status">
              No panels in this region. Drag a tab from the other stack.
            </div>
          </div>
        )}
        {active && order.includes(active) && PANELS[active]?.render()}
      </div>
    </div>
  );
}
