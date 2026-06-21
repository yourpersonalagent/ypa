// PetRewardBurst — SVG fallback config, sprite-config hook, and reward burst
// particle component. Extracted from FloatingPet.tsx to keep it under the
// 900-line goal.

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { usePetStore } from '../store/petStore.js';
import type { PetMood, SpriteConfig } from '../store/petStore.js';

// Fallback-SpriteConfig für SVG (wenn kein Manifest geladen)
export const SVG_FALLBACK: Record<PetMood, SpriteConfig> = {
  idle:        { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 300, height: 300, top: -80,  left: -60  } },
  thinking:    { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 300, height: 300, top: -80,  left: -60  } },
  streaming:   { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 400, height: 400, top: -140, left: -100 } },
  error:       { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 250, height: 250, top: -60,  left: -50  } },
  reconnecting:{ src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 300, height: 300, top: -80,  left: -60  } },
  powermove:   { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 600, height: 600, top: -240, left: -200 } },
  fighting:    { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 400, height: 400, top: -140, left: -100 } },
  happy:       { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 300, height: 300, top: -80,  left: -60  } },
  xpeffect:    { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 360, height: 360, top: -100, left: -110 } },
  // running: Codex row 1 — single canonical right-facing walk cycle. Left
  // direction handled by the per-pet flipRun toggle + CSS scaleX(-1) on
  // these same frames. Falls back to idle when the manifest lacks running.
  running:     { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 300, height: 300, top: -80,  left: -60  } },
  // jumping: locomotion hop override — falls back through POSE_FALLBACK_CHAIN
  // to happy for pets without a dedicated jumping row.
  jumping:     { src: null, fallback: null, hotspotAnchor: 'bottom-center', effectZone: { width: 300, height: 300, top: -80,  left: -60  } },
};

export function useSpriteConfig(mood: PetMood): SpriteConfig {
  const manifest = usePetStore((s) => s.currentPet?.manifest);
  if (manifest?.poses?.[mood]) return manifest.poses[mood];
  return SVG_FALLBACK[mood] || SVG_FALLBACK.idle;
}

export function RewardBurst() {
  const pet = usePetStore((s) => s.currentPet);
  const particles = useMemo(() => Array.from({ length: 14 }, (_, i) => ({
    id: i,
    x: -46 + Math.random() * 92,
    y: -22 - Math.random() * 96,
    delay: Math.random() * 0.28,
    scale: 0.65 + Math.random() * 0.7,
  })), []);
  const kind = pet?.rewardKind || 'stars';
  return (
    <div className="pet-xp-burst" data-kind={kind} aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="pet-xp-particle"
          style={{
            '--xp-x': `${p.x}px`,
            '--xp-y': `${p.y}px`,
            '--xp-delay': `${p.delay}s`,
            '--xp-scale': String(p.scale),
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
