// CodeMinimap — 40 px-wide navigation strip on the right of the editor body.
//
// Same nav-strip pattern as the chat-minimap module: NOT a Shiki/canvas
// thumbnail (those are expensive). Each chunk of source lines is rendered as
// a 1-px-tall bar whose width encodes the chunk's average line length.
// Empty lines compress to a thin notch; long lines stretch wider.
//
// Wire-up: receives the active CodeMirror EditorView via prop. Subscribes to
// view.scrollDOM scroll + view updates. Re-bins on doc/viewport change.
// Clicking the bar scrolls the editor to the corresponding line.

import { useEffect, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';

interface Bin {
  ratio: number; // 0..1 horizontal fill
}

interface Props {
  view: EditorView | null;
}

const STRIP_WIDTH = 40;
const MAX_LINE_LEN_REF = 120;
const PAD_Y = 4; // matches .cv-minimap-bars padding so bins fill the visible track

function computeBins(view: EditorView, targetBins: number): { bins: Bin[]; lineCount: number } {
  const doc = view.state.doc;
  const lineCount = doc.lines;
  if (lineCount === 0 || targetBins <= 0) return { bins: [], lineCount };
  const binSize = Math.max(1, Math.ceil(lineCount / targetBins));
  const out: Bin[] = [];
  let lineNo = 1;
  while (lineNo <= lineCount) {
    let sum = 0;
    let n = 0;
    const end = Math.min(lineNo + binSize - 1, lineCount);
    for (let l = lineNo; l <= end; l++) {
      sum += doc.line(l).length;
      n++;
    }
    const avg = n > 0 ? sum / n : 0;
    out.push({ ratio: Math.min(1, avg / MAX_LINE_LEN_REF) });
    lineNo = end + 1;
  }
  return { bins: out, lineCount };
}

export function CodeMinimap({ view }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bins, setBins] = useState<Bin[]>([]);
  const [lineCount, setLineCount] = useState(0);
  const [viewport, setViewport] = useState<{ top: number; height: number }>({ top: 0, height: 0 });

  // Re-bin on doc change (debounced via rAF) and observe scroll for viewport
  // indicator placement. CM6 has no "doc changed" event the way we want, but
  // EditorView.updateListener fires on every transaction; we attach via the
  // host's compartment in cm-bundle. Here we use a coarser rAF poll on the
  // scrollDOM to keep this module independent of the host's internals.
  useEffect(() => {
    if (!view) {
      setBins([]); setLineCount(0); setViewport({ top: 0, height: 0 });
      return;
    }
    let raf = 0;
    let lastSig = '';

    const refresh = () => {
      raf = 0;
      const dom = view.scrollDOM;
      if (!dom) return;
      const containerH = containerRef.current?.clientHeight ?? 0;
      // One bin per pixel of available track gives a 1:1 nav strip that always
      // fills the container, regardless of editor height or line count. Floor
      // ensures we don't request more bins than we have pixels for.
      const trackH = Math.max(0, containerH - PAD_Y * 2);
      const targetBins = Math.max(1, Math.floor(trackH));
      const sig = `${view.state.doc.length}:${targetBins}`;
      if (sig !== lastSig) {
        lastSig = sig;
        const { bins: b, lineCount: lc } = computeBins(view, targetBins);
        setBins(b);
        setLineCount(lc);
      }
      const total = dom.scrollHeight;
      if (total > 0 && trackH > 0) {
        const top = PAD_Y + (dom.scrollTop / total) * trackH;
        const height = Math.max(8, (dom.clientHeight / total) * trackH);
        setViewport({ top, height });
      }
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(refresh);
    };

    refresh();

    const dom = view.scrollDOM;
    dom.addEventListener('scroll', schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(dom);
    if (containerRef.current) ro.observe(containerRef.current);

    // Light poll for doc changes (the editor mutates internally on typing).
    // 250 ms is plenty for a nav strip — the user isn't reading per-keystroke.
    const poll = setInterval(schedule, 250);

    return () => {
      dom.removeEventListener('scroll', schedule);
      ro.disconnect();
      clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [view]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!view || !lineCount) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Map within the bars track (rect minus top+bottom padding) so the click
    // point lines up with the actual bin that was clicked. Without subtracting
    // padding, a click on the very-top bar would scroll a few lines past it.
    const trackH = Math.max(1, rect.height - PAD_Y * 2);
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top - PAD_Y) / trackH));
    const targetLine = Math.max(1, Math.min(lineCount, Math.round(ratio * lineCount)));
    const block = view.lineBlockAt(view.state.doc.line(targetLine).from);
    const dom = view.scrollDOM;
    dom.scrollTo({ top: Math.max(0, block.top - dom.clientHeight / 2), behavior: 'smooth' });
  };

  // Wheel over the minimap would otherwise be a no-op (nothing to scroll
  // inside the strip) — forward deltaY to the editor's scroller.
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!view) return;
    view.scrollDOM.scrollTop += e.deltaY;
  };

  return (
    <div
      ref={containerRef}
      className="cv-minimap"
      style={{ width: STRIP_WIDTH }}
      onClick={onClick}
      onWheel={onWheel}
      aria-label="Code minimap"
    >
      <div className="cv-minimap-bars">
        {bins.map((b, i) => (
          <div
            key={i}
            className="cv-minimap-bar"
            style={{ width: `${Math.max(2, b.ratio * 100)}%` }}
          />
        ))}
      </div>
      <div
        className="cv-minimap-viewport"
        style={{ top: viewport.top, height: viewport.height }}
        aria-hidden="true"
      />
    </div>
  );
}
