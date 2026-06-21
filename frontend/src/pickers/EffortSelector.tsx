// EffortSelector — 5-dot effort level picker.
// Replaces the imperative DOM code in effort.ts.
// Renders into a React portal targeting the existing #ef-inline-wrap span
// already present in the chat bar HTML, so no layout change is needed.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/index.js';
import { store } from '../store.js';

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Level = (typeof LEVELS)[number];

const LABELS: Record<Level, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

function EffortSelectorInner() {
  const effort = useAppStore((s) => s.effort) as Level | null;
  const [flashLabel, setFlashLabel] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentIdx = effort ? LEVELS.indexOf(effort as Level) : -1;

  function handleClick(level: Level, idx: number) {
    const next = idx === currentIdx ? null : level; // deselect if already active
    store.set('effort', next);
    if (next) {
      setFlashLabel(LABELS[next]);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashLabel(null), 2500);
    }
  }

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  return (
    <>
      <span
        id="ef-inline-label"
        className={`ef-inline-label${flashLabel ? ' show' : ''}`}
      >
        {flashLabel ?? ''}
      </span>
      {LEVELS.map((level, idx) => (
        <button
          key={level}
          className={`ef-dot-btn${idx <= currentIdx ? ' on' : ''}`}
          data-idx={idx}
          title={`Effort: ${LABELS[level]}`}
          onClick={() => handleClick(level, idx)}
        />
      ))}
    </>
  );
}

// Render into the existing #ef-inline-wrap span that chat.ts creates.
// Falls back to null if the element isn't mounted yet.
export function EffortSelector() {
  const [container, setContainer] = useState<Element | null>(null);
  const containerRef = useRef<Element | null>(null);

  useEffect(() => {
    function find() {
      const el = document.querySelector('.ef-inline-wrap');
      if (el && el !== containerRef.current) {
        el.innerHTML = ''; // clear vanilla-rendered dots
        containerRef.current = el;
        setContainer(el);
      }
    }
    find();
    // chat.ts re-creates the chat bar on each session switch — watch for it
    const obs = new MutationObserver(find);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  if (!container) return null;
  return createPortal(<EffortSelectorInner />, container);
}
