// petV1 — the original autonomous pet behavior, frozen as a profile.
//
// Owns its own scheduler hooks (usePetPatrol + usePetIdleBehaviors) and
// cadence constants under `profiles/petV1/` so the profile boundary is
// real: nothing about V1's timing or motion shape leaks back into the
// parent module. Behavior metadata below mirrors what the schedulers
// actually do — the picker UI renders each entry as a visible chip.

import type { PetProfile } from '../types.js';
import { usePetPatrol } from './usePetPatrol.js';
import { usePetIdleBehaviors } from './usePetIdleBehaviors.js';

export const petV1Profile: PetProfile = {
  id: 'petV1',
  label: 'petV1 (classic)',
  tagline: 'Original wander/peek/hop scheduler — busy, theatrical, V1-flavoured.',
  behaviors: [
    {
      id: 'patrol',
      label: 'Patrol',
      summary: 'Random left/right walk with three rolls: full cross-side, fidget within zone, free-wander through centre.',
    },
    {
      id: 'theatrical-jump',
      label: 'Theatrical jump',
      summary: 'Long cross-side patrols play as a 3-hop arc instead of a flat slide.',
    },
    {
      id: 'vertical-wander',
      label: 'Vertical wander',
      summary: 'Occasionally drifts upward on the side strip, biased toward the home line.',
    },
    {
      id: 'peek-away',
      label: 'Peek away',
      summary: 'Pet shrinks and drops behind UI for a few seconds — reads as wandering into the background.',
    },
    {
      id: 'look-around',
      label: 'Look around',
      summary: 'Rare brief facing flip to the opposite direction while idle.',
    },
    {
      id: 'button-hop',
      label: 'Button hop',
      summary: 'Picks a random visible button, slides over, optionally fires a few press-bounces, slides home.',
    },
    {
      id: 'fight-anchor',
      label: 'Fight anchor',
      summary: 'Picks a fight position offset when mood escalates to fighting/powermove, returns when it clears.',
    },
    {
      id: 'walk-facing',
      label: 'Walk-facing tracker',
      summary: 'Locks the sprite’s facing to its travel direction during any motion transition.',
    },
  ],
  usesMoods: ['running', 'jumping', 'fighting', 'powermove'],
  hooks: {
    useScheduler: (args) => {
      usePetPatrol(args);
      usePetIdleBehaviors(args);
    },
  },
};
