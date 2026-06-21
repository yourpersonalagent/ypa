// Ghost-text overlay for the chat textarea.
//
// A native <textarea> can only render one uniform color, so we mimic the
// "inline ghost text" effect by rendering an absolutely-positioned <div>
// on top of the textarea that copies its computed font / padding / wrap
// settings. The user's typed text is rendered with `visibility: hidden`
// so it occupies layout space; the suggested suffix is rendered visibly
// at 50 % opacity. The overlay is `pointer-events: none` so clicks fall
// through to the textarea.
//
// The overlay is portaled to <body> and positioned via the textarea's
// getBoundingClientRect(), so we don't need to wrap the textarea in a
// new DOM ancestor (which would risk breaking existing CSS / layout).

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

interface Args {
  textarea:   HTMLTextAreaElement | null;
  value:      string;
  suggestion: string | null;
}

type MirroredStyles = CSSProperties;

// Walk up from `el` and multiply any CSS `zoom` values we find. On phones,
// prefs-modal.css applies `html { zoom: 0.9 }`, which scales every fixed-
// positioned descendant — including this portal — so we need to divide
// getBoundingClientRect() values (visual pixels) by the chain zoom to get the
// pre-zoom CSS pixels that `position: fixed` interprets as input.
function readZoomChain(el: HTMLElement | null): number {
  let z = 1;
  for (let cur: HTMLElement | null = el; cur; cur = cur.parentElement) {
    const v = window.getComputedStyle(cur).zoom;
    if (!v || v === 'normal') continue;
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) z *= n;
  }
  return z;
}

function rectInLayoutPixels(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  const z = readZoomChain(el);
  if (z === 1) return r;
  return new DOMRect(r.x / z, r.y / z, r.width / z, r.height / z);
}

export function GhostOverlay({ textarea, value, suggestion }: Args) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [styles, setStyles] = useState<MirroredStyles | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!textarea) {
      setRect(null);
      setStyles(null);
      return;
    }

    function readGeometry() {
      if (!textarea) return;
      setRect(rectInLayoutPixels(textarea));
      setScrollTop(textarea.scrollTop);
    }

    function readStyles() {
      if (!textarea) return;
      const c = window.getComputedStyle(textarea);
      setStyles({
        fontFamily:        c.fontFamily,
        fontSize:          c.fontSize,
        fontWeight:        c.fontWeight as CSSProperties['fontWeight'],
        fontStyle:         c.fontStyle  as CSSProperties['fontStyle'],
        lineHeight:        c.lineHeight,
        letterSpacing:     c.letterSpacing,
        textTransform:     c.textTransform as CSSProperties['textTransform'],
        paddingTop:        c.paddingTop,
        paddingRight:      c.paddingRight,
        paddingBottom:     c.paddingBottom,
        paddingLeft:       c.paddingLeft,
        borderTopWidth:    c.borderTopWidth,
        borderRightWidth:  c.borderRightWidth,
        borderBottomWidth: c.borderBottomWidth,
        borderLeftWidth:   c.borderLeftWidth,
        boxSizing:         c.boxSizing as CSSProperties['boxSizing'],
        whiteSpace:        'pre-wrap',
        wordBreak:         c.wordBreak as CSSProperties['wordBreak'],
        overflowWrap:      c.overflowWrap as CSSProperties['overflowWrap'],
        tabSize:           c.tabSize,
      });
    }

    function update() {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        readGeometry();
      });
    }

    readGeometry();
    readStyles();

    const ro = new ResizeObserver(update);
    ro.observe(textarea);

    textarea.addEventListener('scroll', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);

    // The chat-empty layout switch slides the input-area's ancestor via a
    // CSS translateY transition (~400 ms). That moves the textarea without
    // changing its size, so ResizeObserver/scroll/resize never fire. Watch
    // #view-chat's class for the toggle and re-read once the transition
    // settles; also catch transitionend bubbling up from any ancestor as a
    // belt-and-braces fallback for other animated layout shifts.
    const viewChat = document.getElementById('view-chat');
    let classTid: ReturnType<typeof setTimeout> | null = null;
    const mo = viewChat
      ? new MutationObserver(() => {
          if (classTid) clearTimeout(classTid);
          update();
          classTid = setTimeout(() => { update(); classTid = null; }, 450);
        })
      : null;
    mo?.observe(viewChat!, { attributeFilter: ['class'] });

    document.addEventListener('transitionend', update, true);

    return () => {
      ro.disconnect();
      textarea.removeEventListener('scroll', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      mo?.disconnect();
      if (classTid) clearTimeout(classTid);
      document.removeEventListener('transitionend', update, true);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [textarea]);

  // Re-read geometry whenever a suggestion is about to be shown — covers the
  // case where the textarea moved (e.g. chat-empty toggled) while no overlay
  // was visible, so none of the above listeners had reason to fire.
  useEffect(() => {
    if (!textarea || !suggestion) return;
    setRect(rectInLayoutPixels(textarea));
    setScrollTop(textarea.scrollTop);
  }, [textarea, suggestion]);

  if (!rect || !styles || !suggestion) return null;

  return createPortal(
    <div
      aria-hidden="true"
      style={{
        position:      'fixed',
        top:           rect.top,
        left:          rect.left,
        width:         rect.width,
        height:        rect.height,
        pointerEvents: 'none',
        color:         'var(--fg, currentColor)',
        background:    'transparent',
        margin:        0,
        zIndex:        2,
        overflow:      'hidden',
        ...styles,
      }}
    >
      <div
        style={{
          transform:    `translateY(${-scrollTop}px)`,
          willChange:   'transform',
        }}
      >
        <span style={{ visibility: 'hidden' }}>{value}</span>
        <span style={{ opacity: 0.45 }}>{suggestion}</span>
      </div>
    </div>,
    document.body,
  );
}
