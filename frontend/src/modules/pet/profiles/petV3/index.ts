// petV3 — fresh-start companion behavior.
//
// Built from scratch around the Codex 9-row mood vocabulary (idle,
// running, streaming, happy, error, thinking, jumping, powermove,
// xpeffect). Shares no code with petV1 — no patrol scheduler, no
// peek-away, no button-hop, no theatrical jumps. Behavior metadata
// below is the user-facing declaration of what V3 actually does;
// keep it in sync with usePetV3Scheduler.ts.

import type { PetProfile } from '../types.js';
import { usePetV3Scheduler } from './usePetV3Scheduler.js';

export const petV3Profile: PetProfile = {
  id: 'petV3',
  label: 'petV3 (fresh)',
  tagline: 'Calm Codex-aligned companion — focused on observing, with occasional motion.',
  behaviors: [
    {
      id: 'wander',
      label: 'Wander',
      summary: 'Every 22-50 s the pet rolls a slide: usually horizontal (60-220 px), sometimes a small upward drift (40-140 px).',
    },
    {
      id: 'perch',
      label: 'Perch',
      summary: 'When an input or textarea holds focus for ~0.8 s, the pet walks to a spot just above-and-to-the-side and stays until blur.',
    },
    {
      id: 'walk-facing',
      label: 'Walk-facing',
      summary: 'Horizontal slides flip the sprite to face travel direction (left motion uses the per-pet flipRun toggle + CSS mirror); pure-vertical slides keep the current facing.',
    },
    {
      id: 'pose-by-direction',
      label: 'Pose-by-direction',
      summary: 'Running animation only plays when actually moving left/right; pure vertical drift uses the jumping pose if the pet has one, else slides silently.',
    },
  ],
  usesMoods: ['running', 'jumping'],
  hooks: {
    useScheduler: usePetV3Scheduler,
  },
};
