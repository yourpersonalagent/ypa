import chatUtils from './chat-utils.js';
import type { ChatMessage } from './chat-utils.js';
import { getChatActions, useChatStore } from '../stores/chatStore.js';

// Standalone runner — each call gets its own rAF loop, so multiple concurrent
// animations (chat status bar + voice-mode thinking, etc.) don't step on each
// other. Continuous-time animation engine: a sub-character "progress" cursor
// advances every frame at a speed dictated by a sine envelope with pointed
// turning points, so the typing has fast/slow inflections without ever
// jittering between discrete delays.
export function runStatusAnim(el: HTMLElement): { stop: () => void } {
  const seq = ['⌬  starting  ⌬', '⟁  reasoning  ⟁'];
  let seqIdx = 0;
  let pool = [..._STATUS_LIVELY].sort(() => Math.random() - 0.5);
  let poolIdx = 0;

  function getWord(): string {
    if (seqIdx < seq.length) return seq[seqIdx++]!;
    const w = pool[poolIdx % pool.length]!;
    if (++poolIdx >= pool.length) { pool = [..._STATUS_LIVELY].sort(() => Math.random() - 0.5); poolIdx = 0; }
    return w;
  }

  // Animation state. Each cycle "writes" the current word across the previous
  // word position-by-position — newWord[i] replaces oldWord[i] in place. When
  // newWord is shorter than oldWord the trailing old chars get erased as the
  // cursor sweeps past them; when longer the new chars extend past where the
  // old word ended. First cycle starts with prevWord='' so it types from blank.
  let alive = true;
  let raf: number | null = null;
  let prevWord = '';
  let currentWord = getWord();
  let progress = 0;
  let phase: 'writing' | 'hold' = 'writing';
  let phaseStart = performance.now();
  let lastFrame = phaseStart;
  let speedPhase = Math.random() * Math.PI * 2;

  // ── Simple text-content approach — no per-char spans, no JS opacity mutations ──
  // Root cause of the 30% streaming GPU: the old per-char span pool had
  // will-change: transform on the wrapper, creating a compositor-promoted layer
  // that was repainted by JS at 60fps. Combined with the stop-pulse animation
  // (compositor heartbeat) and the pet overlay (another will-change: transform
  // layer), all three layers blended at 60fps = 30% GPU.
  //
  // Fix: one plain <span> with textContent updates (no will-change, no compositor
  // layer). The shimmer effect comes from a CSS ::after gradient (transform:
  // translateX animation) — that is compositor-safe because it's driven by
  // CSS, not by JS opacity mutations that dirty the layer texture each frame.
  // The cursor lives between the new-word prefix and the old-word suffix, so
  // it visually rides the write head as it sweeps across the previous word.
  const fadeWrap = document.createElement('span');
  fadeWrap.className = 'shimmer-fade';
  const prefixSpan = document.createElement('span');
  const cursorSpan = document.createElement('span');
  cursorSpan.className = 'status-cursor';
  cursorSpan.textContent = '▌';
  const suffixSpan = document.createElement('span');
  fadeWrap.appendChild(prefixSpan);
  fadeWrap.appendChild(cursorSpan);
  fadeWrap.appendChild(suffixSpan);
  el.appendChild(fadeWrap);

  let lastCharCount = -1;

  const TARGET_AVG_MS_PER_CHAR = 62;
  const CYCLE_MS = 1450;
  function speedAt(absoluteMs: number): number {
    const t = ((absoluteMs - phaseStart) / CYCLE_MS) + speedPhase;
    const s = Math.sin(t * Math.PI);
    const env = Math.pow(Math.abs(s), 2.6) * Math.sign(s) * 0.5 + 0.5;
    return (0.18 + env * 1.6) / TARGET_AVG_MS_PER_CHAR;
  }

  function render(now: number): void {
    // Cursor blink: driven by rAF (already running) — no CSS animation, no will-change.
    cursorSpan.style.opacity = (0.3 + ((Math.sin(now / 280) + 1) * 0.5) * 0.35).toFixed(2);

    // Sweep by currentWord.length: once the cursor reaches the end of the new
    // word, any remaining tail of the previous (longer) word is dropped in one
    // step rather than slowly erased character-by-character.
    const sweepLen = currentWord.length;
    const c = phase === 'hold' ? sweepLen : Math.min(Math.floor(progress), sweepLen);
    if (c === lastCharCount) return;
    lastCharCount = c;
    prefixSpan.textContent = currentWord.slice(0, c);
    suffixSpan.textContent = c < currentWord.length ? prevWord.slice(c) : '';
  }

  function frame(now: number): void {
    if (!alive) return;
    const dt = Math.min(now - lastFrame, 64);
    lastFrame = now;

    if (phase === 'writing') {
      progress += dt * speedAt(now);
      const sweepLen = currentWord.length;
      if (progress >= sweepLen) { progress = sweepLen; phase = 'hold'; phaseStart = now; }
    } else {
      if (now - phaseStart > 1450) {
        prevWord = currentWord;
        currentWord = getWord();
        progress = 0;
        phase = 'writing';
        phaseStart = now;
        speedPhase = Math.random() * Math.PI * 2;
        lastCharCount = -1;
      }
    }

    render(now);
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
  return {
    stop: () => {
      alive = false;
      if (raf !== null) cancelAnimationFrame(raf);
      el.innerHTML = '';
    },
  };
}
let _minimapRafId: number | null = null;
let _minimapLastBuild = 0;
let scrollEl: HTMLElement | null = null;

// Each entry pairs a verb with an exotic ASCII/Unicode motif chosen to
// visually echo the verb (no parenthesis-eyed smileys). Layout varies between
// prefix, suffix, framed, and inline so the rhythm of the animation never
// settles into one shape.
const _STATUS_LIVELY = [
  // — growth & nature —
  "❀ ✿ ❁   blossoming",
  "blooming   ❀ ✾ ❀",
  "⚘ ⌇ ⚘   germinating",
  "ripening   ◌ ◍ ●",
  "⌅ ⌄ ⌅   unfolding",
  "cultivating   ⚘ ✿ ⚘",
  "nurturing   ⚜ ❀ ⚜",
  "evolving   ◯ ◐ ●",

  // — liquids & fire —
  "⌬ ⏃ ⌬   brewing",
  "marinating   ≋ ∿ ≋",
  "⌒ ≈ ⌒   simmering",
  "infusing   ⥢ ⌇ ⥢",
  "concocting   ⌬ ⏃ ⎈",
  "↻ ↺ ↻   stirring",
  "whisking   ⥁ ⥂ ⥁",
  "baking   ◌ ◍ ●",
  "kneading   ▆ ▅ ▄",

  // — mind & memory —
  "⊜ ⊙ ⊜   pondering",
  "ruminating   ⌬ ⊜ ⌬",
  "⌖ ⊜ ⌖   musing",
  "noodling   ⌑ ⌎ ⌑",
  "puttering   ⌎ ⌑ ⌎",
  "meditating   ⌬ ◯ ⌬",

  // — dream & drift —
  "☾ ✦ ⟡   dreaming",
  "wandering   ⤳ ⥢ ⤳",
  "∿ ⌒ ∿   drifting",
  "unravelling   ⫻ ⫼ ⫽",
  "sifting   ⊟ ⊞ ⊟",

  // — craft & form —
  "⌖ ⊞ ⌖   tinkering",
  "polishing   ⋆ ✦ ⋆",
  "⌑ ⌒ ⌑   honing",
  "finessing   ⊞ ⊟ ⊠",
  "tuning   ♪ ♫ ♪",
  "⌖ ⌗ ⌖   crafting",
  "sculpting   ⬡ ⬢ ⬡",
  "⫻ ⫼ ⫽   weaving",
  "painting   ❀ ✿ ❀",
  "writing   ⌗ ⌖ ⌗",
  "formulating   ⊞ ⊟ ⊠",

  // — music & motion —
  "♪ ♬ ♪   composing",
  "harmonizing   ♭ ♮ ♭",
  "♫ ♪ ♫   singing",
  "dancing   ⤴ ⤵ ⤴",
  "⥁ ⥂ ⥁   twirling",
  "fluttering   ⤳ ⤴ ⤳",
  "swirling   ↻ ↺ ↻",

  // — light & shimmer —
  "✦ ✧ ✦   shimmying",
  "enchanting   ✺ ✶ ✺",
  "✧ ⋆ ✦   sparkling",
  "incubating   ◐ ◑ ●",
  "coaxing   ⌅ ⌄ ⌅",

  // — animal spirits —
  "ᓚᘏᗢ   pouncing",
  "purring   ฅ^•ﻌ•^ฅ",
  "  /ᐠ｡ꞈ｡ᐟ\   scampering",
  "howling   ʕ•ᴥ•ʔ",
  "  ∪･ω･∪   yapping",
  "trilling   ᵔᴥᵔ",
  "  /ᐠ-ꞈ-ᐟ\   leaping",

  // — creative visages —
  "  (´･ᴗ･`)   beaming",
  "gazing   (◕‿◕)",
  "  (￣▽￣)   grinning",
  "chuckling   (´ω｀)",
  "  (◉_◉)   observing",
  "twinkling   (✧ω✧)",

  // — playful critters —
  "  /ᐠ｡ꞈ｡ᐟ\   hopping",
  "grooming   ᓚᘏᗢ",
  "  ʕ•ᴥ•ʔ   lounging",
  "frolicking   ᵔᴥᵔ",
  "  ∪･ω･∪   bounding",
  "nuzzling   (•ᴗ•)",
];

let pendingAttachments: Record<string, unknown>[] = [];

export const chatUI = {
  autoGrow(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = Math.min(300, ta.scrollHeight) + 'px';
  },

  getPendingAttachments(): Record<string, unknown>[] { return useChatStore.getState().pendingAttachments as Record<string, unknown>[]; },
  clearAttachments(): void { pendingAttachments = []; getChatActions().clearAttachments(); this.renderAttachmentStrip(); },

  renderAttachmentStrip(): void {
    const strip = document.getElementById('chat-attachments');
    if (!strip) return;
    if (strip.dataset['react']) return; // React <AttachmentStrip /> owns this container
    if (!pendingAttachments.length) {
      strip.style.display = 'none';
      strip.innerHTML = '';
      return;
    }
    strip.style.display = 'flex';
    strip.innerHTML = pendingAttachments.map((att, i) => {
      if (att['type'] === 'image') {
        return `<div class="chat-att" data-idx="${i}" title="${chatUtils.escHtml(att['name'])}"><img src="${chatUtils.escHtml(att['url'])}" alt="${chatUtils.escHtml(att['name'])}"><button class="chat-att-rm" data-idx="${i}" title="Remove">×</button></div>`;
      }
      return `<div class="chat-att chat-att-file" data-idx="${i}" title="${chatUtils.escHtml(att['name'])}"><span>📎 ${chatUtils.escHtml(att['name'])}</span><button class="chat-att-rm" data-idx="${i}" title="Remove">×</button></div>`;
    }).join('');
    strip.querySelectorAll('.chat-att-rm').forEach((btn) => {
      (btn as HTMLElement).addEventListener('click', (e) => { e.stopPropagation(); chatUI.removeAttachment(+(btn as HTMLElement).dataset['idx']!); });
    });
  },

  addAttachment(att: Record<string, unknown>): void {
    pendingAttachments.push(att);
    getChatActions().addAttachment(att);
    this.renderAttachmentStrip();
  },

  removeAttachment(idx: number): void {
    pendingAttachments.splice(idx, 1);
    getChatActions().removeAttachment(idx);
    this.renderAttachmentStrip();
  },

  scheduleMinimap(force = false): void {
    const map = document.getElementById('chat-minimap');
    if (map?.dataset['react']) return;
    const now = Date.now();
    if (!force && now - _minimapLastBuild < 250) return;
    if (_minimapRafId) return;
    _minimapRafId = requestAnimationFrame(() => {
      _minimapRafId = null;
      this.buildMinimap();
    });
  },

  buildMinimap(): void {
    const map = document.getElementById('chat-minimap');
    if (!map || !scrollEl) return;
    if (map.dataset['react']) return;
    const totalH = scrollEl.scrollHeight;
    const mapH = map.clientHeight;
    if (!totalH || !mapH) return;

    _minimapLastBuild = Date.now();
    map.innerHTML = '';

    scrollEl.querySelectorAll('.msg.user, .msg.agent').forEach((msg) => {
      const msgEl = msg as HTMLElement;
      const role = msgEl.classList.contains('user') ? 'user' : 'agent';
      const msgTop = msgEl.offsetTop;
      const msgH = msgEl.offsetHeight;
      const pxTop = (msgTop / totalH) * mapH;
      const rawH = (msgH / totalH) * mapH;
      const pxH = Math.max(1, rawH);
      // Tiny ticks (< 5px tall) grow wider so they stay visible/clickable.
      // 5px → 4px wide, 1px → 20px wide; right-aligned so the right edge stays put.
      const baseW = 4;
      const grownW = pxH < 5 ? baseW + (5 - Math.max(1, pxH)) * 4 : baseW;
      // Hidden hit-area extender — ticks under 8px tall get vertical click
      // padding to keep an ~8px tap target without changing the visible size.
      const padY = Math.max(0, (8 - pxH) / 2);

      const labelEl = msgEl.querySelector('.msg-role-label') as HTMLElement | null;
      let color = '';
      if (role === 'user') {
        color = labelEl?.style.color || '';
      } else if (labelEl?.classList.contains('is-emp')) {
        color = labelEl.style.background || '';
      }

      const tick = document.createElement('div');
      tick.className = 'cm-tick ' + role;
      tick.style.top = pxTop + 'px';
      tick.style.height = pxH + 'px';
      tick.style.setProperty('--cm-w', grownW + 'px');
      tick.style.setProperty('--cm-pad-y', padY + 'px');
      if (color) tick.style.background = color;
      tick.title = role === 'user' ? 'User message' : 'AI message';
      tick.addEventListener('click', (e) => {
        const rect = tick.getBoundingClientRect();
        const inTop = e.clientY < rect.top + rect.height / 2;
        const target = inTop ? msgTop - 8 : msgTop + msgH - scrollEl!.clientHeight + 8;
        scrollEl!.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      });
      map.appendChild(tick);
    });
  },

  initMinimap(): void {
    const map = document.getElementById('chat-minimap');
    if (map?.dataset['react']) return;
    if (window.ResizeObserver && scrollEl) {
      new ResizeObserver(() => this.scheduleMinimap(true)).observe(scrollEl);
    }
  },

  init(scrollElement: HTMLElement, taElement: HTMLTextAreaElement): void {
    scrollEl = scrollElement;
    // Defer to rAF so the layout reads (scrollHeight) happen after paint,
    // not synchronously in the event handler — was the biggest INP source.
    taElement?.addEventListener('input', () => { requestAnimationFrame(() => this.autoGrow(taElement)); });
    this.initMinimap();
  },

  renderAllMessages(
    scroll: HTMLElement,
    messages: ChatMessage[],
    appendElFn: (msg: ChatMessage) => void,
    appendToolPillFn: (type: string, name: string, detail: unknown) => void,
    buildMinimapFn: () => void,
    msgCounterCallback: (mid: number) => void,
    resetScrollFn: () => void,
    clearToolStripFn: () => void
  ): void {
    scroll.innerHTML = '';
    clearToolStripFn();
    resetScrollFn();
    for (const m of messages) {
      if (m._mid) msgCounterCallback(m._mid);
    }
    for (const m of messages) {
      if (m.role === 'tool') {
        const toolMsg = m as ChatMessage & { type?: string; name?: string; detail?: string };
        appendToolPillFn(toolMsg.type || 'tool-call', toolMsg.name || 'tool', toolMsg.detail || '');
      } else {
        appendElFn(m);
        if (!m.blocks && m.role === 'agent' && m.toolCalls?.length) {
          for (const tc of m.toolCalls) appendToolPillFn(tc.type || 'tool-call', tc.name || 'tool', tc.detail || '');
        }
      }
    }
    requestAnimationFrame(buildMinimapFn);
  }
};

export default chatUI;
