// ChatEmptyGreeting — smart status line shown above the YHA hero in the
// empty-chat state. Picks a message from /v1/greetings (loaded from
// bridge/greetings.md at server start) by local hour. Themed dates
// (New Year, Christmas, Halloween, leap day, …) override the generic hour
// bank. Refreshes itself on the next hour boundary so the message stays
// in sync with the wall clock without polling.
//
// Mount strategy mirrors ChatEmptyBg: imperatively insert a single
// `<div class="chat-empty-greeting">` as a sibling above `.chat-empty-hero`
// so the existing chat.ts innerHTML template doesn't need to change.
// In the `full` layout the greeting is moved INSIDE `.chat-empty-hero`
// and takes the YHA brand mark's slot (the brand is hidden via CSS); other
// layouts keep the sibling placement above the hero (messenger hides the
// hero entirely; zen positions it independently).

import { useEffect } from 'react';
import { useAppStore } from '../../stores/appStore.js';

interface HourMap { [hour: string]: string; }
interface GreetingsCatalog {
  generics: HourMap[];
  dates: { [mmdd: string]: HourMap };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function firstName(full: string): string {
  const trimmed = full.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

function interpolate(template: string, name: string): string {
  if (name) return template.replace(/\{name\}/g, name);
  // Drop the placeholder gracefully — also strip leading ", " or trailing
  // " {name}," fragments so sentences read naturally with no name.
  return template
    .replace(/,\s*\{name\}([.!?])/g, '$1')
    .replace(/,\s*\{name\}/g, '')
    .replace(/\{name\},?\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function pickMessage(catalog: GreetingsCatalog, now: Date): string {
  const hour = pad2(now.getHours());
  const mmdd = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const themed = catalog.dates[mmdd]?.[hour];
  if (themed) return themed;
  if (catalog.generics.length === 0) return '';
  const bank = catalog.generics[Math.floor(Math.random() * catalog.generics.length)];
  return bank?.[hour] || '';
}

function splitAtMiddle(text: string): [string, string] {
  const mid = text.length / 2;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      const dist = Math.abs(i - mid);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
  }
  if (best < 0) return [text, ''];
  return [text.slice(0, best), text.slice(best + 1)];
}

function msUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setHours(now.getHours() + 1, 0, 5, 0); // +5s buffer past the boundary
  return next.getTime() - now.getTime();
}

let cachedCatalog: GreetingsCatalog | null = null;
let inflight: Promise<GreetingsCatalog | null> | null = null;

async function loadCatalog(): Promise<GreetingsCatalog | null> {
  if (cachedCatalog) return cachedCatalog;
  if (inflight) return inflight;
  inflight = fetch('/v1/greetings')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || typeof j !== 'object') return null;
      const cat: GreetingsCatalog = {
        generics: Array.isArray(j.generics) ? j.generics : (j.generic ? [j.generic] : []),
        dates: (j.dates && typeof j.dates === 'object') ? j.dates : {},
      };
      cachedCatalog = cat;
      return cat;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

export function ChatEmptyGreeting() {
  useEffect(() => {
    const viewChat = document.getElementById('view-chat');
    if (!viewChat) return;

    let host: HTMLDivElement | null = null;
    let textEl: HTMLSpanElement | null = null;
    let cancelled = false;
    let nextHourTimer: number | null = null;

    function ensureMounted(): boolean {
      const controls = viewChat!.querySelector('.chat-controls-area');
      const hero = viewChat!.querySelector<HTMLElement>('.chat-empty-hero');
      if (!controls || !hero) return false;
      const useHero = useAppStore.getState().layoutMode === 'full';
      const desiredParent: Element = useHero ? hero : controls;
      // If the host exists but is rooted in the wrong parent (layout just
      // toggled), drop it so we re-create cleanly in the new spot.
      if (host && host.parentElement !== desiredParent) {
        host.remove();
        host = null;
        textEl = null;
      }
      if (!host || !desiredParent.contains(host)) {
        const existing = desiredParent.querySelector(':scope > .chat-empty-greeting') as HTMLDivElement | null;
        if (existing) {
          host = existing;
          textEl = existing.querySelector('.chat-empty-greeting-text') as HTMLSpanElement | null;
        } else {
          host = document.createElement('div');
          host.className = 'chat-empty-greeting';
          host.setAttribute('aria-hidden', 'true');
          // Force the off-state inline for the first paint. Without this,
          // a hard refresh while already in empty state inserts the node
          // into a `.chat-empty` parent — the browser computes the active
          // style immediately and the slow blur-in transition never fires.
          // Cleared on the next frame so the transition runs as designed.
          host.style.opacity = '0';
          host.style.filter = 'blur(80px)';
          host.style.transition = 'none';
          textEl = document.createElement('span');
          textEl.className = 'chat-empty-greeting-text';
          host.appendChild(textEl);
          if (useHero) {
            // Prepend so the greeting reads above the YHA brand mark in the
            // hero's column flex; flow handles vertical stacking.
            hero.insertBefore(host, hero.firstChild);
          } else {
            controls.insertBefore(host, hero);
          }
          void host.offsetWidth;
          const mountedHost = host;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              mountedHost.style.opacity = '';
              mountedHost.style.filter = '';
              mountedHost.style.transition = '';
            });
          });
        }
      }
      return !!textEl;
    }

    function getName(): string {
      try {
        const fromStore = useAppStore.getState().userName || '';
        if (fromStore) return firstName(fromStore);
      } catch {
        /* ignore — store may not be ready on first paint */
      }
      const fromWindow = (window as Window & { __yhaSignedInName?: string }).__yhaSignedInName || '';
      return firstName(fromWindow);
    }

    function render(catalog: GreetingsCatalog | null) {
      if (cancelled) return;
      if (!ensureMounted() || !textEl) return;
      if (!catalog) {
        while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
        return;
      }
      const now = new Date();
      const tpl = pickMessage(catalog, now);
      if (!tpl) {
        while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
        return;
      }
      const msg = interpolate(tpl, getName());
      const [line1, line2] = splitAtMiddle(msg);
      while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
      if (line2) {
        const s1 = document.createElement('span');
        s1.textContent = line1;
        textEl.appendChild(s1);
        textEl.appendChild(document.createElement('br'));
        const s2 = document.createElement('span');
        s2.textContent = line2;
        textEl.appendChild(s2);
      } else {
        textEl.textContent = msg;
      }
    }

    function scheduleNextHour() {
      if (nextHourTimer != null) clearTimeout(nextHourTimer);
      nextHourTimer = window.setTimeout(() => {
        render(cachedCatalog);
        scheduleNextHour();
      }, msUntilNextHour(new Date()));
    }

    loadCatalog().then(render);
    scheduleNextHour();

    // Re-render when the user sets their name in prefs and when sign-in
    // data arrives — both are async relative to first paint.
    const onSignedIn = () => render(cachedCatalog);
    window.addEventListener('yha:signedinuser', onSignedIn);
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.userName !== prev.userName) render(cachedCatalog);
      if (state.layoutMode !== prev.layoutMode) render(cachedCatalog);
    });

    // Re-attach if chat.ts re-renders the controls area.
    const reattachObs = new MutationObserver(() => {
      if (!host || !viewChat!.contains(host)) render(cachedCatalog);
    });
    reattachObs.observe(viewChat, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      window.removeEventListener('yha:signedinuser', onSignedIn);
      unsub();
      reattachObs.disconnect();
      if (nextHourTimer != null) clearTimeout(nextHourTimer);
      host?.remove();
      host = null;
      textEl = null;
    };
  }, []);

  return null;
}
