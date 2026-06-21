// PetDebugOverlay — transparent visualization layer for the pet's
// spatial state. Toggled from PetPrefsSection ("Show debug overlay").
//
// Renders:
//   • Live pet hitbox rectangle (green)            — rAF-tracked via petRef
//   • Both settle-zone targets (orange dashed)     — left + right home anchors
//   • Message-area horizontal bounds (cyan)        — patrol range
//   • Last world snapshot — nearest button (magenta), nearest input (yellow),
//     focused element (red), top visible buttons (faint magenta).
//
// Mounted at document.body (portal) with pointer-events: none so it never
// intercepts clicks. The layer is hidden when debugOverlay is false; when
// the pet is hidden / behindUi the snapshot panel disappears but the
// "where home would be" boxes still render so the user can see the
// geometry even before showing the pet.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type React from 'react';
import { usePetStore } from '../store/petStore.js';
import { usePetWorldStore, type PetRect } from '../store/petWorldStore.js';
import { msgAreaBounds } from '../petOverlayGeometry.js';
import { PET_W, SIDE_ZONE_DEPTH } from '../petOverlayConstants.js';

interface Props {
  petElRef: React.RefObject<HTMLElement | null>;
}

interface LiveRects {
  pet: PetRect | null;
  msgBounds: { left: number; right: number } | null;
  zones: { left: number | null; right: number | null };
}

const EMPTY_LIVE: LiveRects = {
  pet: null,
  msgBounds: null,
  zones: { left: null, right: null },
};

/** Mirrors FloatingPet.sideZoneCenter without coupling to the gSettledSide
 *  module variable so the overlay can show BOTH zones at once. */
function computeZones(): LiveRects['zones'] {
  const b = msgAreaBounds();
  if (!b) return { left: null, right: null };
  return {
    left: b.left - 2 * 56 + SIDE_ZONE_DEPTH / 2,
    right: b.right - PET_W - SIDE_ZONE_DEPTH / 2,
  };
}

export function PetDebugOverlay({ petElRef }: Props) {
  const enabled = usePetStore((s) => s.debugOverlay);
  const isVisible = usePetStore((s) => s.isVisible);
  const snapshot = usePetWorldStore((s) => s.snapshot);
  const [live, setLive] = useState<LiveRects>(EMPTY_LIVE);
  const rafRef = useRef<number | null>(null);
  const lastSig = useRef<string>('');

  // rAF tracking for the live hitbox + zones. Reads bounding rects every
  // frame while the overlay is on — comparable cost to the chatReflow loop,
  // and only runs when the user explicitly enables debug mode.
  useEffect(() => {
    if (!enabled) {
      setLive(EMPTY_LIVE);
      return;
    }
    let cancelled = false;

    function tick() {
      if (cancelled) return;
      rafRef.current = requestAnimationFrame(tick);

      const petEl = petElRef.current;
      const hitboxEl = petEl?.querySelector<HTMLElement>('.pet-hitbox');
      const petRect = (hitboxEl ?? petEl)?.getBoundingClientRect() ?? null;
      const msgBounds = msgAreaBounds();
      const zones = computeZones();

      // Cheap signature so we only re-render on actual change.
      const sig = [
        petRect ? `${Math.round(petRect.left)},${Math.round(petRect.top)},${Math.round(petRect.width)},${Math.round(petRect.height)}` : 'n',
        msgBounds ? `${Math.round(msgBounds.left)},${Math.round(msgBounds.right)}` : 'n',
        zones.left != null ? Math.round(zones.left) : 'n',
        zones.right != null ? Math.round(zones.right) : 'n',
      ].join('|');
      if (sig === lastSig.current) return;
      lastSig.current = sig;

      setLive({
        pet: petRect ? {
          left: petRect.left,
          top: petRect.top,
          right: petRect.right,
          bottom: petRect.bottom,
          width: petRect.width,
          height: petRect.height,
        } : null,
        msgBounds,
        zones,
      });
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [enabled, petElRef]);

  if (!enabled) return null;

  const w = window.innerWidth;
  const h = window.innerHeight;

  return createPortal(
    <svg
      aria-hidden="true"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483646,             // just below the pet overlay
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      {/* Message-area horizontal bounds — the patrol corridor. */}
      {live.msgBounds && (
        <g stroke="#19f0ff" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="4 4">
          <line x1={live.msgBounds.left} y1={0} x2={live.msgBounds.left} y2={h} />
          <line x1={live.msgBounds.right} y1={0} x2={live.msgBounds.right} y2={h} />
        </g>
      )}

      {/* Settle-zone targets (where the pet rests on its left/right home). */}
      {live.zones.left != null && (
        <ZoneMarker x={live.zones.left} label="home L" color="#ff9a3c" />
      )}
      {live.zones.right != null && (
        <ZoneMarker x={live.zones.right} label="home R" color="#ff9a3c" />
      )}

      {/* Top visible buttons — faint background context. */}
      {isVisible && snapshot?.visibleButtons.map((b, i) => (
        <BoxLabel
          key={`vb-${i}`}
          rect={b.rect}
          color="#ff5cf2"
          opacity={0.25}
          label={`${b.label} · imp ${(b.importance * 100).toFixed(0)}`}
          labelOpacity={0.55}
        />
      ))}

      {/* Nearest button. */}
      {isVisible && snapshot?.nearest.button && (
        <BoxLabel
          rect={snapshot.nearest.button.rect}
          color="#ff5cf2"
          opacity={1}
          label={`nearest btn · ${snapshot.nearest.button.label} · ${snapshot.nearest.button.distancePx}px`}
        />
      )}

      {/* Nearest input. */}
      {isVisible && snapshot?.nearest.input && (
        <BoxLabel
          rect={snapshot.nearest.input.rect}
          color="#ffd84d"
          opacity={1}
          label={`nearest input · ${snapshot.nearest.input.placeholder || snapshot.nearest.input.label} · ${snapshot.nearest.input.distancePx}px${snapshot.nearest.input.hasFocus ? ' · focused' : ''}`}
        />
      )}

      {/* Focused element. */}
      {isVisible && snapshot?.focusedElement && (
        <BoxLabel
          rect={snapshot.focusedElement.rect}
          color="#ff4d6d"
          opacity={1}
          label={`focus · ${snapshot.focusedElement.tag} · ${snapshot.focusedElement.label}`}
        />
      )}

      {/* Live pet hitbox — green, drawn last so it's on top. */}
      {live.pet && (
        <BoxLabel
          rect={live.pet}
          color="#3cff8a"
          opacity={1}
          label={`pet · ${Math.round(live.pet.left)},${Math.round(live.pet.top)} · ${Math.round(live.pet.width)}×${Math.round(live.pet.height)}`}
        />
      )}

      {/* Active-region tag in the corner. */}
      {isVisible && snapshot && (
        <RegionTag region={snapshot.activeRegion} capturedAt={snapshot.capturedAt} />
      )}
    </svg>,
    document.body,
  );
}

// ── Sub-elements ───────────────────────────────────────────────────────────

interface BoxLabelProps {
  rect: PetRect;
  color: string;
  opacity: number;
  label: string;
  labelOpacity?: number;
}
function BoxLabel({ rect, color, opacity, label, labelOpacity }: BoxLabelProps) {
  return (
    <g opacity={opacity}>
      <rect
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
      />
      <text
        x={rect.left}
        y={Math.max(10, rect.top - 4)}
        fill={color}
        opacity={labelOpacity ?? 1}
        fontSize={10}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        style={{ paintOrder: 'stroke', stroke: '#0009', strokeWidth: 2 }}
      >
        {label}
      </text>
    </g>
  );
}

function ZoneMarker({ x, label, color }: { x: number; label: string; color: string }) {
  // Mark the X anchor with a vertical line + a small "ground" tick at the
  // typical foot-line Y (window.innerHeight - 200 is a fair default; the
  // actual home Y depends on .chat-input-wrapper rect which is itself in
  // the snapshot via panel detection — we just hint the X here).
  const groundY = window.innerHeight - 140;
  return (
    <g stroke={color} strokeOpacity={0.85} strokeDasharray="3 3" fill="none">
      <line x1={x} y1={0} x2={x} y2={window.innerHeight} strokeWidth={1} />
      <circle cx={x} cy={groundY} r={5} strokeOpacity={1} />
      <text
        x={x + 8}
        y={groundY + 4}
        fill={color}
        fontSize={10}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        style={{ paintOrder: 'stroke', stroke: '#0009', strokeWidth: 2 }}
      >
        {label} · x={Math.round(x)}
      </text>
    </g>
  );
}

function RegionTag({ region, capturedAt }: { region: string; capturedAt: number }) {
  const ageS = Math.max(0, (performance.now() - capturedAt) / 1000);
  return (
    <g>
      <rect x={8} y={8} width={210} height={22} fill="#000c" rx={4} />
      <text
        x={14}
        y={23}
        fill="#cfd6e4"
        fontSize={11}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        region: {region} · snap age {ageS.toFixed(1)}s
      </text>
    </g>
  );
}
