import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  ACTIVITY_RATE_DEFAULT,
  ACTIVITY_RATE_MAX,
  ACTIVITY_RATE_MIN,
  ACTIVITY_RATE_STEP,
  GLOBAL_SCALE_DEFAULT,
  GLOBAL_SCALE_MAX,
  GLOBAL_SCALE_MIN,
  GLOBAL_SCALE_STEP,
  GLOW_INTENSITY_DEFAULT,
  GLOW_INTENSITY_MAX,
  GLOW_INTENSITY_MIN,
  GLOW_INTENSITY_STEP,
  SHADOW_OFFSET_DEFAULT_PX,
  SHADOW_OFFSET_MAX_PX,
  SHADOW_OFFSET_MIN_PX,
  usePetStore,
} from '../store/petStore.js';
import type { PetProfileId } from '../store/petStore.js';
import { PET_PROFILES } from '../profiles/index.js';
import { ANIMATION_CATALOG, ANIMATION_ORDER, getAnimationCoverage } from '../animations.js';
import { useHatchStore } from '../store/hatchStore.js';
import { usePetGalleryStore } from '../hatch/PetGalleryModal.js';
import { useAppStore } from '../../../stores/appStore.js';
import { PetQuickChatSection } from './PetQuickChat.js';
import { ProfileDetailCard } from './ProfileDetailCard.js';

const PROFILE_ORDER: PetProfileId[] = ['petV1', 'petV3'];

// Animation chip data (glyph, duration, trigger, ordering) all comes
// from the central catalog at ../animations.ts. The chip GRID below
// filters that catalog against the active pet's manifest so only
// animations the pet actually ships get rendered.

const HOLD_MS = 520;

function downloadText(filename: string, body: string) {
  const blob = new Blob([body], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

export function PetHeaderButton() {
  const isVisible = usePetStore((s) => s.isVisible);
  const pet = usePetStore((s) => s.currentPet);
  const toggle = usePetStore((s) => s.toggle);
  const triggerPowermove = usePetStore((s) => s.triggerPowermove);
  const triggerFight = usePetStore((s) => s.triggerFight);
  const previewMood = usePetStore((s) => s.previewMood);
  const installManifest = usePetStore((s) => s.installManifest);
  const openHatch = useHatchStore((s) => s.openWizard);
  const openGallery = usePetGalleryStore((s) => s.openGallery);
  const mirrorSprite = usePetStore((s) => s.mirrorSprite);
  const flipFacing = usePetStore((s) => s.flipFacing);
  const flipRun = usePetStore((s) => s.flipRun);
  const toggleFlipRun = usePetStore((s) => s.toggleFlipRun);
  const themeTint = usePetStore((s) => s.themeTint);
  const setThemeTint = usePetStore((s) => s.setThemeTint);
  const shadowOffsetPx = usePetStore((s) => s.shadowOffsetPx);
  const setShadowOffsetPx = usePetStore((s) => s.setShadowOffsetPx);
  const globalScale = usePetStore((s) => s.globalScale);
  const setGlobalScale = usePetStore((s) => s.setGlobalScale);
  const glowIntensity = usePetStore((s) => s.glowIntensity);
  const setGlowIntensity = usePetStore((s) => s.setGlowIntensity);
  const xp = usePetStore((s) => s.xp);
  const level = usePetStore((s) => s.level);
  const triggerLevelUp = usePetStore((s) => s.triggerLevelUp);
  // Behind-UI toggle: drops the pet under chat content. The store also
  // promotes #root via a body class; we just bind the toggle and
  // visual state here. Persisted in localStorage by the setter.
  const behindUi = usePetStore((s) => s.behindUi);
  const setBehindUi = usePetStore((s) => s.setBehindUi);
  const playgroundMode = usePetStore((s) => s.playgroundMode);
  const setPlaygroundMode = usePetStore((s) => s.setPlaygroundMode);
  // Activity-rate slider: 0 = never act spontaneously (manual buttons
  // still work), 1 = original cadence, 2 = double-speed/probability
  // for button hops, peek-away, patrol, look-around, tool-call fights,
  // and powermove escalation. Read here just to drive the slider; the
  // long-lived schedulers in FloatingPet read it through a ref.
  const activityRate = usePetStore((s) => s.activityRate);
  const setActivityRate = usePetStore((s) => s.setActivityRate);
  // Behavior profile picker — petV1 is currently the only profile (the
  // frozen wander/peek/hop scheduler). Future profiles plug in via the
  // same registry.
  const activeProfileId = usePetStore((s) => s.activeProfileId);
  const setActiveProfileId = usePetStore((s) => s.setActiveProfileId);
  // Debug overlay — translucent SVG portal that visualizes the pet's
  // hitbox, settle-zone anchors, message-area bounds, and live world
  // model output (nearest button/input, top visible buttons by
  // importance, focused element, active region). Persisted toggle.
  const debugOverlay = usePetStore((s) => s.debugOverlay);
  const setDebugOverlay = usePetStore((s) => s.setDebugOverlay);
  // Header orientation drives which way the popover opens. Reading it
  // from the store (vs. guessing from anchor.top) ensures the popover
  // re-clamps automatically if the user switches between vertical and
  // horizontal header layouts while the popover is open.
  const headerOrient = useAppStore((s) => s.headerOrient);
  const galleryEntries = usePetGalleryStore((s) => s.entries);
  const galleryBusy = usePetGalleryStore((s) => s.busyId);
  const galleryRefresh = usePetGalleryStore((s) => s.refresh);
  const switchPet = usePetGalleryStore((s) => s.switchTo);
  const holdTimer = useRef<number | null>(null);
  const didHold = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const codexInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  /** Bounding rect of the trigger button at open time. We capture it
   *  once and use it to compute viewport-clamped popover coordinates —
   *  same pattern as SessionPicker. The popover lives in a portal on
   *  document.body so it can escape any clipping ancestor (header
   *  overflow:hidden, card border-radius, etc). */
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  /** Actual measured popover width after first paint. Starts at the
   *  CSS-fallback estimate (320 px ≙ max-width) and is updated by a
   *  ResizeObserver on the portal element, so the side-flip math uses
   *  real numbers — not a guess that can disagree with min-width. */
  const [popoverWidth, setPopoverWidth] = useState<number>(320);
  const [codexView, setCodexView] = useState<'idle' | 'paste' | 'importing' | 'done' | 'err'>('idle');
  const [codexInput, setCodexInput] = useState('');
  const [codexMsg, setCodexMsg] = useState('');

  function clearHold() {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function captureAnchor() {
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  }

  function onPointerDown() {
    didHold.current = false;
    clearHold();
      holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        didHold.current = true;
        captureAnchor();
        setOpen(true);
    }, HOLD_MS);
  }

  function onPointerUp() {
    clearHold();
  }

  function onClick(e: MouseEvent<HTMLButtonElement>) {
    if (didHold.current) {
      didHold.current = false;
      e.preventDefault();
      return;
    }
    captureAnchor();
    setOpen((v) => !v);
  }

  function close() {
    setOpen(false);
    setCodexView('idle');
    setCodexMsg('');
  }

  /**
   * Viewport-clamped popover position. Mirrors SessionPicker.tsx — we
   * pick a side based on where the trigger sits (header on top vs.
   * left), then clamp left/top so the popover never extends past the
   * viewport with a small margin. `maxHeight` is recomputed too so the
   * popover internally scrolls if it would otherwise hang off-screen.
   *
   * The header has two layouts: vertical (default, sidebar) and
   * horizontal (`#header[data-orient='h']`, top bar). We read the
   * orientation from `useAppStore` (`headerOrient`) — the store is
   * the source of truth that drives `#header[data-orient]`, and
   * Zustand-subscribing here keeps the popover re-clamping live if
   * the user toggles layout while the menu is open.
   *
   * The earlier implementation guessed orientation from the button's
   * y-coordinate (`anchor.top < vh * 0.25`). That misfired in the
   * common case where the pet button sat near the TOP of a VERTICAL
   * sidebar — the heuristic took the horizontal branch, which set
   * `right: vw - anchor.right` (a huge number when the button is far
   * from the right edge of the viewport). The popover's `left` edge
   * then resolved to roughly `anchor.right − width ≈ −280 px`, hence
   * the "popover is 70 % off-screen left" symptom. The thin bright
   * stripe to its right was the popover's own right border (1 px
   * white in high-contrast themes, plus the box-shadow halo) peeking
   * through at viewport_x ≈ 40 — the rest of the popover body sat
   * offscreen, so all the user saw was the trailing border + shadow.
   *
   * The vertical branch drives position via `left`; the horizontal
   * branch anchors via `right` (= vw - anchor.right) so the popover's
   * right edge stays glued to the trigger's right edge independent of
   * the popover's actual width. Earlier the horizontal branch used
   * `left = anchor.right - width`, which made the popover JUMP
   * horizontally when the ResizeObserver replaced the 320 px width
   * estimate with the real (~236 px) measurement — most visible when
   * the pet button sits at the far right of the bar, since the
   * left-anchor moved by `Δwidth` (~84 px) on the second paint.
   * Both branches explicitly set the OTHER axis to 'auto' so no
   * inherited rule from the base `.pet-menu-popover` (which sets
   * `left: calc(100% + 8px); bottom: 0;` for the inline non-portal
   * variant) can leak in via specificity.
   */
  const popoverStyle: CSSProperties = useMemo(() => {
    if (!anchor) return {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const gap = 6;
    // First render uses the 320 px CSS-max estimate; the ResizeObserver
    // below replaces this with the actual measured width once the
    // portal element is mounted, and useMemo recomputes.
    const width = popoverWidth;
    // Both branches set BOTH `left` and `right` (one to a number,
    // one to 'auto') and BOTH `top` and `bottom` so no inherited rule
    // from the base `.pet-menu-popover` (which sets
    // `left: calc(100% + 8px); bottom: 0;` for the inline non-portal
    // variant) can leak through and contribute a stray render axis.
    if (headerOrient === 'h') {
      // Top bar — drop the popover BELOW the button, right-edge aligned
      // with the trigger. Anchor via `right` so the position is
      // INDEPENDENT of the popover's actual width: a narrower-than-
      // estimated popover no longer shifts horizontally when the
      // ResizeObserver corrects the width state. The outer clamp keeps
      // the popover on-screen when the button is unusually far left in
      // the bar (which would push `right` past `vw - width - margin`,
      // i.e. the popover would extend off the left edge of the viewport).
      const desiredRight = vw - anchor.right;
      const right = Math.max(margin, Math.min(vw - width - margin, desiredRight));
      const top = Math.min(vh - 180 - margin, anchor.bottom + gap);
      const maxHeight = Math.max(180, vh - top - margin);
      return {
        position: 'fixed',
        top,
        right,
        left: 'auto',
        bottom: 'auto',
        maxHeight,
        overflowY: 'auto',
      };
    }
    // Default sidebar — pick the side of the button that has more
    // horizontal room. Left-anchored sidebars open the popover to the
    // RIGHT of the trigger (more room there); right-anchored sidebars
    // open to the LEFT. Falls back to whichever side has more space if
    // neither side comfortably fits the full popover width.
    const spaceRight = vw - anchor.right - gap - margin;
    const spaceLeft = anchor.left - gap - margin;
    let left: number;
    if (spaceRight >= width || spaceRight >= spaceLeft) {
      // Open to the right of the button.
      left = anchor.right + gap;
    } else {
      // Open to the left of the button.
      left = anchor.left - gap - width;
    }
    // Final safety clamp so we never extend past either viewport edge.
    // Without this, an extremely narrow viewport (where neither side
    // has 320 px of room) could push the popover past the edge.
    left = Math.max(margin, Math.min(vw - width - margin, left));
    // Anchor the popover to the button's vertical centre but bias up so
    // long popovers don't push past the bottom edge.
    const desiredTop = anchor.top - 24;
    const top = Math.max(margin, Math.min(vh - 200 - margin, desiredTop));
    const maxHeight = Math.max(200, vh - top - margin);
    return {
      position: 'fixed',
      top,
      left,
      right: 'auto',
      bottom: 'auto',
      maxHeight,
      overflowY: 'auto',
    };
  }, [anchor, headerOrient, popoverWidth]);

  function runAction(fn: () => void) {
    fn();
    close();
  }

  function exportManifest() {
    const manifest = pet.manifest;
    if (!manifest) return;
    downloadText(`${manifest.name || pet.id}.pet.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    close();
  }

  async function importManifest(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    const text = await file.text();
    installManifest(JSON.parse(text));
    close();
  }

  /** Extract the first https?:// URL from a curl command or raw URL string.
   *  Works for the standard petshare curl snippet and plain download links. */
  function parseCodexUrl(text: string): string | null {
    if (!text) return null;
    const m = text.match(/https?:\/\/[^\s"'\\]+/);
    if (!m) return null;
    return m[0].replace(/['">\])\s]+$/, ''); // strip trailing punctuation
  }

  async function runCodexImport(url: string): Promise<void> {
    setCodexView('importing');
    setCodexMsg('');
    try {
      const resp = await fetch('/v1/pets/import-codex', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        credentials: 'include',
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      installManifest(data.manifest);
      setCodexMsg(data.manifest?.label || data.manifest?.name || 'Pet');
      setCodexView('done');
    } catch (e) {
      setCodexMsg((e as Error).message || 'Import failed');
      setCodexView('err');
    }
  }

  async function openCodexImport(): Promise<void> {
    // If clipboard already holds a valid URL/curl snippet — skip the paste
    // dialog and start the import immediately (zero extra clicks).
    try {
      const clip = await navigator.clipboard.readText();
      const url = parseCodexUrl(clip.trim());
      if (url) {
        void runCodexImport(url);
        return;
      }
    } catch {
      // Clipboard access denied or empty — fall through to paste dialog
    }
    setCodexInput('');
    setCodexMsg('');
    setCodexView('paste');
    setTimeout(() => codexInputRef.current?.focus(), 60);
  }

  function startHatch() {
    // The hatch wizard is an in-app modal — no Claude / Grok auth, just
    // prompt code blocks the user copies into Grok manually and PNG drop
    // zones for the resulting downloads.
    openHatch();
    close();
  }

  function manageGallery() {
    openGallery();
    close();
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      // Trigger button + own root → ignore (clicking the button itself
      // handles toggle via its own onClick).
      if (rootRef.current?.contains(e.target as Node)) return;
      // Portal-rendered popover is OUTSIDE rootRef.current. Match it
      // explicitly via the floating-popover class so clicks inside
      // sliders / chips don't dismiss the menu mid-drag. Fast path —
      // the closest() walk stops at the nearest ancestor with that
      // class, so a single up-tree traversal regardless of menu depth.
      const tgt = e.target as HTMLElement | null;
      if (tgt?.closest('.pet-menu-popover-floating')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // Re-clamp the popover position on viewport changes so resizing
    // the window or scrolling the page (the trigger button is in a
    // sticky header that can move on scroll in horizontal layout)
    // doesn't strand the popover off-screen.
    const onResize = () => {
      const r = buttonRef.current?.getBoundingClientRect();
      if (r) setAnchor(r);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [open]);

  // Measure the popover's actual width once the portal node mounts.
  // The CSS clamp `max-width: min(340px, 86vw)` and content-driven
  // intrinsic sizing mean the real width can be 236-340 px, but the
  // initial useMemo in popoverStyle has to GUESS — so on first paint
  // the side-flip math may use a stale 320 px estimate. The
  // ResizeObserver replaces that guess with the real width as soon as
  // layout settles, triggering a re-clamp via the popoverWidth state.
  useEffect(() => {
    if (!open) {
      // Reset to the CSS-fallback estimate so the next open doesn't
      // start with whatever width the previous theme/size produced
      // (safer if max-width changed between opens).
      if (popoverWidth !== 320) setPopoverWidth(320);
      return;
    }
    const el = popoverRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Read once synchronously so React doesn't have to wait for the
    // observer's first invocation (which is microtask-deferred).
    const initial = el.getBoundingClientRect().width;
    if (initial > 0 && Math.abs(initial - popoverWidth) > 0.5) {
      setPopoverWidth(initial);
    }
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === 'number' && next > 0) {
        setPopoverWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
      }
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [open, popoverWidth]);

  useEffect(() => {
    if (open) void galleryRefresh();
  }, [open, galleryRefresh]);

  // The level badge sits on top of the trigger button when the pet has
  // levelled past 1. Stays subtle (small + accent border) so it doesn't
  // shout — but it lets the user see "I am at level X" at a glance
  // without opening the popover.
  const showLevelBadge = level > 1;

  return (
    <div className={`pet-header-menu${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        className={`hm-item pet-hm-btn${isVisible ? ' is-on' : ''}`}
        id="btn-pet"
        title="Pet menu. Hold opens actions; /pet still works in chat."
        aria-pressed={isVisible}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={clearHold}
        onPointerCancel={clearHold}
        onClick={onClick}
      >
        <span className="hm-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v15" />
            <path d="M8 6h8" />
            <path d="M9 17h6" />
            <path d="M10 22h4" />
            <path d="M4 12l3 3" />
            <path d="M20 12l-3 3" />
          </svg>
        </span>
        {showLevelBadge ? (
          <span className="pet-hm-level-badge" aria-label={`Level ${level}`} title={`Level ${level} · ${xp} XP`}>
            {level}
          </span>
        ) : null}
      </button>

      {open ? createPortal(
        <div
          ref={popoverRef}
          className="pet-menu-popover pet-menu-popover-floating"
          role="menu"
          aria-label="Pet actions"
          style={popoverStyle}
          // Click-outside handling lives on the window listener below;
          // stop pointerdown bubbling here so clicks INSIDE the popover
          // don't immediately close it via the document-level handler.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="pet-menu-head">
            <strong>{pet.name}</strong>
            <span>{pet.manifest?.spriteFormat || 'SVG fallback'}</span>
            {/* XP/level summary — purely informational. Sits in the
                header so it's the first thing the user sees on open.
                The numerator is current XP within this level (i.e. has
                already had previous-level thresholds subtracted by
                addXp), the denominator is the threshold to advance.
                Clicking the row triggers a manual level-up animation
                so the user can see the visual without grinding XP. */}
            <button
              type="button"
              className="pet-menu-level-row"
              onClick={() => { triggerLevelUp(); }}
              title="Level up animation preview (does not award XP)"
            >
              <span className="pet-menu-level-num">⭐ Lvl {level}</span>
              <span className="pet-menu-level-bar" aria-hidden="true">
                <span
                  className="pet-menu-level-bar-fill"
                  style={{
                    // Width is the percentage of XP toward next level.
                    // Cap at 100 % so a freshly-levelled pet shows
                    // ~0–4 % until the next burst hits.
                    width: `${Math.max(0, Math.min(100, (xp / Math.max(1, level * 100)) * 100)).toFixed(1)}%`,
                  }}
                />
              </span>
              <span className="pet-menu-level-xp">{xp} / {level * 100} XP</span>
            </button>
          </div>
          <button role="menuitem" onClick={() => runAction(toggle)}>{isVisible ? 'Hide pet' : 'Show pet'}</button>
          {/* Per-pet animation chip grid — derived live from the pet's
              manifest filtered against the central animation catalog. Each
              chip corresponds to a pose the pet actually ships frames for.
              No disabled placeholder chips, no fallback-routed entries.
              Order follows ANIMATION_ORDER (Codex 9 first, YHA-extras after).
              A coverage row above shows how complete this pet is vs the
              canonical Codex 9 + YHA-extras — clicking the "Upgrade pet"
              hint opens the hatch wizard so missing rows can be generated. */}
          <div
            role="group"
            aria-label="Animations"
            className="pet-menu-preview-grid"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const coverage = getAnimationCoverage(pet.manifest);
              return (
                <div className="pet-menu-preview-coverage" data-full={coverage.present === coverage.total}>
                  <span className="pet-menu-preview-label">Animations</span>
                  <span
                    className={
                      'pet-menu-preview-coverage-count'
                      + (coverage.fullCodexCoverage ? ' is-codex-full' : ' is-codex-partial')
                    }
                    title={
                      coverage.missing.length === 0
                        ? 'This pet ships every Codex animation + YHA-extras. Nothing missing.'
                        : `Missing rows (${coverage.missing.length}): ${coverage.missing.join(', ')}. Codex-only missing: ${coverage.missingCodex.join(', ') || 'none'}. YHA-extras missing: ${coverage.missingExtras.join(', ') || 'none'}.`
                    }
                  >
                    {coverage.present}/{coverage.total}
                  </span>
                  {coverage.missing.length > 0 && (
                    <button
                      type="button"
                      className="pet-menu-preview-upgrade"
                      onClick={() => runAction(openHatch)}
                      title={`Open the hatch wizard to generate the ${coverage.missing.length} missing animation row${coverage.missing.length > 1 ? 's' : ''}: ${coverage.missing.join(', ')}.`}
                    >
                      ↻ Upgrade
                    </button>
                  )}
                </div>
              );
            })()}
            <div className="pet-menu-preview-chips">
              {ANIMATION_ORDER
                .filter((mood) => Boolean(pet.manifest?.poses?.[mood]))
                .map((mood) => {
                  const entry = ANIMATION_CATALOG[mood];
                  const pose = pet.manifest?.poses?.[mood];
                  // Manifest pose label wins (per-pet German label like
                  // "Bereit" / "Nachdenklich"); fall back to the mood key
                  // for any pet whose manifest pose lacks a label string.
                  const label = pose?.label || mood;
                  return (
                    <button
                      key={mood}
                      type="button"
                      className={
                        'pet-menu-preview-chip'
                        + (entry.origin === 'yha-extra' ? ' is-yha-extra' : '')
                      }
                      title={
                        entry.trigger
                          ? label
                          : `Preview "${label}"`
                      }
                      onClick={() => {
                        if (entry.trigger === 'powermove') triggerPowermove();
                        else if (entry.trigger === 'fight') triggerFight();
                        else previewMood(mood, entry.durationMs);
                      }}
                    >
                      <span aria-hidden="true">{entry.glyph}</span>
                      {label}
                    </button>
                  );
                })
              }
            </div>
          </div>

          <div className="pet-menu-sep" />
          {/* Four sprite/layer toggles in a 2 × 2 grid — these are all
              quick on/off flips that don't need the full popover width
              each, so pairing them up keeps the menu compact. The Layer
              toggle used to live below the sliders; it sits here now so
              all four "tap to flip" controls cluster together. */}
          <div className="pet-menu-toggle-grid" role="group" aria-label="Sprite toggles">
            <button
              role="menuitem"
              onClick={() => runAction(flipFacing)}
              title="Mirror all sprite directions — use when sprites are drawn facing the wrong way"
            >
              {mirrorSprite ? '↔ Mirrored' : '↔ Mirror'}
            </button>
            <button
              role="menuitem"
              onClick={() => runAction(toggleFlipRun)}
              title="Flip the running direction for this pet only — remembered per pet"
            >
              {flipRun ? '🔄 Run dir: flipped' : '🔄 Flip run dir'}
            </button>
            <button
              role="menuitem"
              onClick={() => { setThemeTint(!themeTint); close(); }}
              title="Tint the sprite with the active theme accent colour"
            >
              {themeTint ? '✨ Tint: on' : '✨ Tint: off'}
            </button>
            {/* Behind-UI toggle — drops the pet under chat content so text /
                buttons / images all sit ABOVE it. Useful when the pet's aura
                + ground glow are too distracting in front of long
                read-heavy responses. The store flips a body class that
                promotes #root into a stacking context; we just bind the
                toggle. Drag interaction is intentionally lost while behind
                UI (clicks land on the UI element above) — flip it off
                briefly to reposition the pet. */}
            <button
              role="menuitem"
              onClick={() => { setBehindUi(!behindUi); close(); }}
              title={
                behindUi
                  ? 'Currently behind chat content — toggle off to bring the pet back to the front'
                  : 'Currently in front of everything — toggle on to put the pet behind chat / text / buttons'
              }
            >
              {behindUi ? '🫥 Behind UI' : '👁 In front'}
            </button>
          </div>
          <div
            role="group"
            aria-label="Shadow distance"
            className="pet-menu-slider-row"
            // Live tuning — close-on-click would interrupt dragging the slider.
            onClick={(e) => e.stopPropagation()}
          >
            <label htmlFor="pet-shadow-offset-slider" title="Vertical offset of the ground shadow from the foot line">
              🌑 Shadow
            </label>
            <input
              id="pet-shadow-offset-slider"
              type="range"
              min={SHADOW_OFFSET_MIN_PX}
              max={SHADOW_OFFSET_MAX_PX}
              step={1}
              value={shadowOffsetPx}
              onChange={(e) => setShadowOffsetPx(Number(e.currentTarget.value))}
            />
            <button
              type="button"
              className="pet-menu-slider-reset"
              title="Reset shadow distance to default"
              onClick={() => setShadowOffsetPx(SHADOW_OFFSET_DEFAULT_PX)}
            >
              ↺
            </button>
            <span className="pet-menu-slider-val" aria-live="polite">{shadowOffsetPx}px</span>
          </div>

          {/* Global scale — applies to .pet-overlay via --pet-global-scale,
              with transform-origin at the foot so the pet stays planted on
              the chat input as it grows or shrinks. Persisted per-user. */}
          <div
            role="group"
            aria-label="Pet size"
            className="pet-menu-slider-row"
            onClick={(e) => e.stopPropagation()}
          >
            <label htmlFor="pet-global-scale-slider" title="Visual size of the entire pet (sprite + aura + shadow)">
              📐 Size
            </label>
            <input
              id="pet-global-scale-slider"
              type="range"
              min={GLOBAL_SCALE_MIN}
              max={GLOBAL_SCALE_MAX}
              step={GLOBAL_SCALE_STEP}
              value={globalScale}
              onChange={(e) => setGlobalScale(Number(e.currentTarget.value))}
            />
            <button
              type="button"
              className="pet-menu-slider-reset"
              title="Reset size to native"
              onClick={() => setGlobalScale(GLOBAL_SCALE_DEFAULT)}
            >
              ↺
            </button>
            <span className="pet-menu-slider-val" aria-live="polite">×{globalScale.toFixed(2)}</span>
          </div>

          {/* Glow intensity — multiplies the .pet-aura opacity (and gold
              drop-shadow) by 0..1. At 0 the aura is fully removed
              (display: none — not transparency 0, that would still cost
              compositor cycles for the blurred radial gradient). */}
          <div
            role="group"
            aria-label="Glow intensity"
            className="pet-menu-slider-row"
            onClick={(e) => e.stopPropagation()}
          >
            <label
              htmlFor="pet-glow-slider"
              title={
                glowIntensity === 0
                  ? 'Glow off — aura hidden completely'
                  : 'Soft glow behind the pet (visible during streaming + powermove)'
              }
            >
              {glowIntensity === 0 ? '🌑 Glow' : '✨ Glow'}
            </label>
            <input
              id="pet-glow-slider"
              type="range"
              min={GLOW_INTENSITY_MIN}
              max={GLOW_INTENSITY_MAX}
              step={GLOW_INTENSITY_STEP}
              value={glowIntensity}
              onChange={(e) => setGlowIntensity(Number(e.currentTarget.value))}
            />
            <button
              type="button"
              className="pet-menu-slider-reset"
              title="Reset glow intensity"
              onClick={() => setGlowIntensity(GLOW_INTENSITY_DEFAULT)}
            >
              ↺
            </button>
            <span className="pet-menu-slider-val" aria-live="polite">
              {glowIntensity === 0 ? 'off' : `${Math.round(glowIntensity * 100)}%`}
            </span>
          </div>

          {/* Activity-rate slider — scales every spontaneous behaviour
              (button-hop, peek-away, idle look-around, patrol cadence,
              tool-call fight probability, powermove escalation on
              concurrent tools). 0 = pet stands still and ignores tool
              calls (manual triggers still work); 1 = original cadence;
              2 = doubled probabilities + halved patrol wait. Live
              schedulers in FloatingPet read through a ref so changes
              take effect on the next tick without resetting timers. */}
          <div
            role="group"
            aria-label="Activity level"
            className="pet-menu-slider-row"
            onClick={(e) => e.stopPropagation()}
          >
            <label
              htmlFor="pet-activity-rate-slider"
              title={
                activityRate <= 0
                  ? 'Calm — no spontaneous actions (manual buttons still work)'
                  : activityRate >= ACTIVITY_RATE_MAX
                  ? 'Hyperactive — doubled probabilities, halved patrol wait'
                  : 'How often the pet hops on buttons, wanders off, fights tool calls, etc.'
              }
            >
              {activityRate <= 0 ? '😴 Activity' : activityRate >= 1.5 ? '🤸 Activity' : '🐾 Activity'}
            </label>
            <input
              id="pet-activity-rate-slider"
              type="range"
              min={ACTIVITY_RATE_MIN}
              max={ACTIVITY_RATE_MAX}
              step={ACTIVITY_RATE_STEP}
              value={activityRate}
              onChange={(e) => setActivityRate(Number(e.currentTarget.value))}
            />
            <button
              type="button"
              className="pet-menu-slider-reset"
              title="Reset activity level to default"
              onClick={() => setActivityRate(ACTIVITY_RATE_DEFAULT)}
            >
              ↺
            </button>
            <span className="pet-menu-slider-val" aria-live="polite">
              {activityRate <= 0 ? 'calm' : `×${activityRate.toFixed(1)}`}
            </span>
          </div>

          <div className="pet-menu-sep" />
          {/* Behavior profile picker — native <select> so the current value
              is unambiguous (the chip variant looked like multi-select). The
              registry's PET_PROFILES drives the option list; new profiles
              slot in by adding a registry entry. */}
          <div
            className="pet-menu-profile-group"
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px' }}
          >
            <label
              htmlFor="pet-menu-profile-select"
              style={{ fontSize: '.76rem', opacity: 0.75 }}
            >
              Behavior profile
            </label>
            <select
              id="pet-menu-profile-select"
              className="prefs-select"
              value={activeProfileId}
              onChange={(e) => {
                const id = e.target.value as PetProfileId;
                if (PET_PROFILES[id]) setActiveProfileId(id);
              }}
              title={PET_PROFILES[activeProfileId]?.tagline ?? ''}
              style={{ width: '100%' }}
            >
              {PROFILE_ORDER.map((id) => {
                const profile = PET_PROFILES[id];
                const available = profile != null;
                return (
                  <option key={id} value={id} disabled={!available}>
                    {available ? profile!.label : `${id} (coming soon)`}
                  </option>
                );
              })}
            </select>
            {PET_PROFILES[activeProfileId] && (
              <ProfileDetailCard profile={PET_PROFILES[activeProfileId]!} />
            )}
          </div>

          {/* Debug overlay — translucent SVG portal that visualizes the
              pet's hitbox, settle-zone anchors, message-area bounds, and
              live world-model output (nearest button/input, top visible
              buttons by importance, focused element, active region). */}
          <button
            role="menuitemcheckbox"
            aria-checked={debugOverlay}
            onClick={() => { setDebugOverlay(!debugOverlay); }}
            title="Toggle the translucent debug overlay showing the pet's world model"
          >
            {debugOverlay ? '🔍 Debug overlay: on' : '🔍 Debug overlay: off'}
          </button>

          {galleryEntries.length > 0 && (
            <>
              <div className="pet-menu-sep" />
              <div className="pet-quick-swap-grid" role="group" aria-label="Switch pet">
                {galleryEntries.map((entry) => {
                  const isActive = pet.id === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitem"
                      className={`pet-quick-swap-item${isActive ? ' is-active' : ''}`}
                      disabled={isActive || galleryBusy === entry.id}
                      onClick={() => { void switchPet(entry.id); close(); }}
                      title={isActive ? `${entry.label} (active)` : `Switch to ${entry.label}`}
                    >
                      <img
                        className="pet-quick-swap-thumb"
                        src={entry.thumb ?? `/pets/${encodeURIComponent(entry.id)}/_base.png`}
                        alt=""
                        loading="lazy"
                        onError={(e) => {
                          const img = e.currentTarget;
                          // If we used the manifest idle thumb and it failed,
                          // try _base.png (native YHA pets have this).
                          // If that also fails, hide the image.
                          if (!img.dataset.fallback && entry.thumb) {
                            img.dataset.fallback = '1';
                            img.src = `/pets/${encodeURIComponent(entry.id)}/_base.png`;
                          } else {
                            img.style.display = 'none';
                          }
                        }}
                      />
                      <span className="pet-quick-swap-label">{entry.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {/* Pet QuickChat — separate session, model + caps for the pet */}
          <PetQuickChatSection />

          <div className="pet-menu-sep" />
          {/* Action buttons — 2-row grid layout */}
          <div className="pet-menu-action-grid">
            {/* Row 1: main pet management */}
            <button role="menuitem" onClick={startHatch} title="Open the sprite-generation wizard to hatch a new pet">
              🥚 Hatch
            </button>
            <button role="menuitem" onClick={manageGallery} title="Browse and switch between your pets">
              🐾 Manage
            </button>
            <button
              role="menuitem"
              title={playgroundMode ? 'Exit WASD playground mode (ESC)' : 'Move pet freely with WASD / arrow keys'}
              onClick={() => { setPlaygroundMode(!playgroundMode); close(); }}
            >
              {playgroundMode ? '✕ Exit play' : '🕹 Play'}
            </button>
            {/* Row 2: import / export */}
            <button role="menuitem" onClick={exportManifest} disabled={!pet.manifest} title="Download the active pet manifest as JSON">
              ↓ Export
            </button>
            <button role="menuitem" onClick={() => fileRef.current?.click()} title="Install a pet from a local manifest JSON">
              ↑ Import
            </button>
            <button role="menuitem" onClick={() => void openCodexImport()} title="Download a pet from Codex Pets (codex-pets.net)">
              🎮 Codex
            </button>
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={importManifest} />
          {codexView !== 'idle' && (
            <div className="pet-codex-import-panel">
              {codexView === 'paste' && (
                <>
                  <p className="pet-codex-import-hint">Paste curl command or download URL:</p>
                  <textarea
                    ref={codexInputRef}
                    className="pet-codex-import-input"
                    value={codexInput}
                    onChange={(e) => setCodexInput(e.currentTarget.value)}
                    placeholder={'curl -L "https://..." -o ...'}
                    rows={3}
                    spellCheck={false}
                  />
                  <div className="pet-codex-import-row">
                    <button
                      className="pet-codex-import-btn"
                      disabled={!codexInput.trim()}
                      onClick={() => {
                        const url = parseCodexUrl(codexInput);
                        if (url) void runCodexImport(url);
                        else setCodexMsg('No URL found in input');
                      }}
                    >
                      Import
                    </button>
                    <button onClick={() => { setCodexView('idle'); setCodexMsg(''); }}>
                      Cancel
                    </button>
                    {codexMsg && <span className="pet-codex-import-err">{codexMsg}</span>}
                  </div>
                </>
              )}
              {codexView === 'importing' && (
                <p className="pet-codex-import-progress">⏳ Downloading &amp; installing…</p>
              )}
              {codexView === 'done' && (
                <div className="pet-codex-import-success">
                  <span>✅ <strong>{codexMsg}</strong> installed!</span>
                  <button onClick={() => { setCodexView('idle'); close(); }}>Close</button>
                </div>
              )}
              {codexView === 'err' && (
                <>
                  <p className="pet-codex-import-err">❌ {codexMsg}</p>
                  <div className="pet-codex-import-row">
                    <button onClick={() => { setCodexView('paste'); setCodexMsg(''); }}>Try again</button>
                    <button onClick={() => { setCodexView('idle'); setCodexMsg(''); }}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
