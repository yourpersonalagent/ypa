// Plans — which rows to generate for a pet.
//
// `full` and `brawl` both include the `fighting` YHA-extra row (row 10
// beyond the Codex 9 canonical vocabulary). YHA's chat triggers the
// `fighting` mood on tool-calls; if a pet doesn't include this row, the
// mood falls back through powermove → streaming → idle, which works but
// loses the combat-specific animation. `lite` skips fighting (and most
// of the Codex 9) to stay genuinely minimal.

import { ROWS } from './animationRows.js';
import type { PlanDefinition, RowName } from './types.js';

export const PLANS: Record<string, PlanDefinition> = {
  full: {
    name: 'full',
    label: 'Full',
    description:
      'Canonical complete pet — all 9 Codex moods plus the YHA-extra fighting row. Single right-facing run row; left-direction motion uses the per-pet flipRun toggle + CSS mirror. 10 animations + 1 base.',
    rows: [
      'idle',
      'thinking',
      'streaming',
      'error',
      'happy',
      'jumping',
      'running',
      'powermove',
      'xpeffect',
      'fighting',
    ],
  },

  lite: {
    name: 'lite',
    label: 'Lite',
    description:
      'Minimal viable pet — three essential state animations. Everything else falls back via the pose chain. 3 animations + 1 base.',
    rows: ['idle', 'streaming', 'error'],
  },

  brawl: {
    name: 'brawl',
    label: 'Brawl',
    description:
      'Combat-leaning subset. Includes the YHA-extra fighting row plus the Codex action moods and core state rows. 7 animations + 1 base.',
    rows: ['idle', 'thinking', 'streaming', 'running', 'powermove', 'xpeffect', 'fighting'],
  },
};

export const PLAN_NAMES = Object.keys(PLANS) as Array<keyof typeof PLANS>;

/** Total frame count produced by a plan (sum of row frame counts). */
export function planFrameTotal(planName: string): number {
  const plan = PLANS[planName];
  if (!plan) return 0;
  return plan.rows.reduce((sum, row) => sum + (ROWS[row]?.frames ?? 0), 0);
}

/** Number of animation strips to generate (rows only — base is always +1 on top). */
export function planRoundCount(planName: string): number {
  const plan = PLANS[planName];
  if (!plan) return 0;
  return plan.rows.length;
}

/** Get the rows a plan generates, in the wizard's display order. */
export function planRows(planName: string): RowName[] {
  return PLANS[planName]?.rows ?? [];
}
