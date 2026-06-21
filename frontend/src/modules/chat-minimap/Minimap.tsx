import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore, useSessionStore } from '../../stores/index.js';

interface Tick {
  key: string;
  role: 'user' | 'agent';
  top: number;
  height: number;
  width: number;
  padY: number;
  color: string;
  msgTop: number;
  msgHeight: number;
}

export function Minimap() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const mapRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const obsRef = useRef<MutationObserver | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number | null>(null);
  const currentId = useSessionStore((s) => s.currentId);
  const messageCount = useChatStore((s) => s.messages.length);
  const isStreaming = useChatStore((s) => Object.keys(s.sessionStreams).length > 0);
  // Ref so the scroll-event handler always sees the latest value without being
  // torn down and re-registered on every streaming state change.
  const streamingRef = useRef(false);
  streamingRef.current = isStreaming;

  useEffect(() => {
    function attach() {
      const map = document.getElementById('chat-minimap');
      const scroll = document.getElementById('chat-scroll');
      if (map && scroll) {
        map.dataset['react'] = '1';
        mapRef.current = map;
        scrollRef.current = scroll;
        if (map !== container) setContainer(map);
      }
    }

    attach();
    if (!container) {
      // Only observe until the map element appears — disconnect once found.
      obsRef.current = new MutationObserver(() => {
        attach();
        if (mapRef.current) obsRef.current?.disconnect();
      });
      obsRef.current.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      obsRef.current?.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [container]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const map = mapRef.current;
    if (!scroll || !map || !window.ResizeObserver) return;

    const schedule = () => {
      // During streaming, the chat auto-scrolls ~20×/s. Each scroll event
      // triggers offsetTop/offsetHeight reads on every message → forced
      // synchronous layout (Layerize spike). Skip here; the streaming-end
      // useEffect fires a single rebuild when the stream completes.
      if (streamingRef.current) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        rebuild();
      });
    };

    resizeRef.current?.disconnect();
    resizeRef.current = new ResizeObserver(schedule);
    resizeRef.current.observe(scroll);
    resizeRef.current.observe(map);
    scroll.addEventListener('scroll', schedule, { passive: true });

    return () => {
      resizeRef.current?.disconnect();
      scroll.removeEventListener('scroll', schedule);
    };
  }, [container]);

  useEffect(() => {
    const id = requestAnimationFrame(() => rebuild());
    return () => cancelAnimationFrame(id);
  }, [container, currentId, messageCount]);

  // When streaming ends, fire one final rebuild so the tick heights reflect
  // the completed message. (The messageCount effect fires at stream START when
  // the placeholder is added, not at end — so without this the last tick stays
  // at whatever height it had when streaming began.)
  //
  // While streaming, the scroll-event path early-returns to avoid forced-layout
  // thrash at ~20 Hz, so we run a coarse 500 ms throttled rebuild instead. That
  // keeps tick positions roughly in sync with the growing scrollHeight without
  // the per-scroll-event spike. (Without this, on long chats the minimap ticks
  // visibly drift further from their messages the longer a reply streams.)
  useEffect(() => {
    if (!isStreaming) {
      const id = requestAnimationFrame(() => rebuild());
      return () => cancelAnimationFrame(id);
    }
    const interval = setInterval(() => rebuild(), 500);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  function rebuild() {
    const map = mapRef.current;
    const scroll = scrollRef.current;
    if (!map || !scroll) {
      setTicks([]);
      return;
    }

    const totalH = scroll.scrollHeight;
    const mapH = map.clientHeight;
    if (!totalH || !mapH) {
      setTicks([]);
      return;
    }

    const next: Tick[] = [];
    const nodes = scroll.querySelectorAll('.msg.user, .msg.agent');
    nodes.forEach((node, idx) => {
      const msgEl = node as HTMLElement;
      const role: 'user' | 'agent' = msgEl.classList.contains('user') ? 'user' : 'agent';
      const msgTop = msgEl.offsetTop;
      const msgHeight = msgEl.offsetHeight;
      const rawH = (msgHeight / totalH) * mapH;
      const height = Math.max(1, rawH);
      // Tiny ticks (< 5px tall) grow wider so they stay visible/clickable.
      // 5px → 4px wide, 1px → 20px wide; right-aligned so the right edge stays put.
      const width = height < 5 ? 4 + (5 - Math.max(1, height)) * 4 : 4;
      // Hidden hit-area extender — ticks under 8px tall get vertical click
      // padding to keep an ~8px tap target without changing the visible size.
      const padY = Math.max(0, (8 - height) / 2);

      const labelEl = msgEl.querySelector('.msg-role-label') as HTMLElement | null;
      let color = '';
      if (role === 'user') {
        color = labelEl?.style.color || '';
      } else if (labelEl?.classList.contains('is-emp')) {
        color = labelEl.style.background || '';
      }

      next.push({
        key: msgEl.dataset['mid'] || `${role}-${idx}`,
        role,
        top: (msgTop / totalH) * mapH,
        height,
        width,
        padY,
        color,
        msgTop,
        msgHeight,
      });
    });
    setTicks(next);
  }

  // Guard against a stale container — can happen if ChatView remounts and
  // creates a new #chat-minimap while the old reference is still in state.
  // Resetting to null lets the discovery useEffect re-find the new element.
  if (!container) return null;
  if (!container.isConnected) {
    mapRef.current = null;
    scrollRef.current = null;
    // Schedule reset outside render (state update during render is unsafe).
    Promise.resolve().then(() => setContainer(null));
    return null;
  }

  return createPortal(
    <>
      {ticks.map((tick) => (
        <div
          key={tick.key}
          className={`cm-tick ${tick.role}`}
          style={{
            top: `${tick.top}px`,
            height: `${tick.height}px`,
            ['--cm-w' as string]: `${tick.width}px`,
            ['--cm-pad-y' as string]: `${tick.padY}px`,
            ...(tick.color ? { background: tick.color } : {}),
          }}
          title={tick.role === 'user' ? 'User message' : 'AI message'}
          // Ticks have pointer-events:all (needed for click), which also
          // means wheel events land on them instead of the chat-scroll
          // beneath. Forward deltaY so wheeling over a tick still scrolls.
          onWheel={(e) => {
            const scroll = scrollRef.current;
            if (!scroll) return;
            scroll.scrollTop += e.deltaY;
          }}
          onClick={(e) => {
            const scroll = scrollRef.current;
            if (!scroll) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const inTop = e.clientY < rect.top + rect.height / 2;
            // Prefer live offsets — the cached msgTop/msgHeight are stale for
            // the currently-streaming message (captured at placeholder time)
            // and clicking "scroll to end" on it would jump to the wrong spot.
            const liveEl = scroll.querySelector<HTMLElement>(
              `[data-mid="${tick.key}"]`
            );
            const msgTop = liveEl?.offsetTop ?? tick.msgTop;
            const msgHeight = liveEl?.offsetHeight ?? tick.msgHeight;
            const target = inTop
              ? msgTop - 8
              : msgTop + msgHeight - scroll.clientHeight + 8;
            scroll.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
          }}
        />
      ))}
    </>,
    container
  );
}
