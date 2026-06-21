// Central animation catalog — the single source of truth for everything
// the pet UI needs to know about each mood:
//
//   • Display metadata     (glyph emoji + preview duration + trigger flag)
//   • Fallback chain       (which moods to try when the pet lacks the frames
//                           for this one — drives both runtime sprite
//                           resolution and the "missing animation" hints)
//   • Functional category  (state / locomotion / action) for UI grouping
//   • Origin tag           (codex-canonical vs yha-extra) for upgrade hints
//
// Every UI surface that lists or filters moods (chip grid in the pet menu,
// SVG silhouette fallbacks, the runtime pose-fallback chain in petStore,
// the nudge-frame modal, the upgrade-pet hint) reads from this catalog.
// Adding or renaming a mood means one entry here — and nothing else.
//
// IMPORTANT: keep `PetMood` (in store/petStoreTypes.ts) and this catalog
// in sync. TypeScript enforces this via `Record<PetMood, AnimationEntry>` —
// adding a PetMood without a catalog entry fails the typecheck.

import type { PetMood } from './store/petStore.js';
import type { PetManifest } from './store/petStoreTypes.js';

/** Where this mood comes from in the conceptual model:
 *   • `codex`     — one of the 9 canonical Codex rows. Every full pet
 *                   should ship these.
 *   • `yha-extra` — extra moods YHA adds beyond Codex (currently:
 *                   reconnecting, fighting). Falls back into the Codex 9
 *                   for pets that don't bother generating the extra rows. */
export type AnimationOrigin = 'codex' | 'yha-extra';

/** What the mood is *used for* in the runtime — drives UI grouping and
 *  scheduler decisions:
 *   • `state`      — a chat/system-driven status (streaming, thinking,
 *                    error, …). Sprite plays in place; profile schedulers
 *                    DON'T override these (see active-state-moods rule).
 *   • `locomotion` — a movement-driven mood (running, jumping). Schedulers
 *                    set this temporarily via setLocomotionMood.
 *   • `action`     — a one-shot spectacular (powermove, xpeffect, fighting).
 *                    Triggered by store actions or chat events. */
export type AnimationCategory = 'state' | 'locomotion' | 'action';

export interface AnimationEntry {
  mood: PetMood;
  /** UI glyph (emoji) for chips, badges, hint pills. */
  glyph: string;
  /** Default preview duration when the user clicks a preview chip. Ignored
   *  for moods with a `trigger` flag (the triggered action picks duration). */
  durationMs?: number;
  /** When set, the chip in the pet menu fires the real store action
   *  instead of a visual preview (used for fight + powermove). */
  trigger?: 'powermove' | 'fight';
  /** Ordered fallback chain. When the active pet's manifest has no frames
   *  for `mood`, the runtime walks this chain and uses the first present
   *  pose. ALWAYS ends with a path to `idle` so the chain terminates. */
  fallbackChain: PetMood[];
  /** Functional category for UI grouping (currently informational). */
  category: AnimationCategory;
  /** Conceptual origin — codex-canonical vs YHA-extra. The upgrade hint
   *  uses this to encourage filling in the canonical 9 first. */
  origin: AnimationOrigin;
}

// ── Catalog (raw object — typed Record export follows below) ──────────────

const CATALOG_RAW = {
  // ── Codex 9 ────────────────────────────────────────────────────────────
  idle: {
    mood: 'idle' as const,
    glyph: '🛏',
    durationMs: 4000,
    fallbackChain: [] as PetMood[],
    category: 'state' as const,
    origin: 'codex' as const,
  },
  running: {
    mood: 'running' as const,
    glyph: '🏃',
    durationMs: 2400,
    // Locomotion fallback: pets without a walk cycle just slide visually.
    fallbackChain: ['idle'] as PetMood[],
    category: 'locomotion' as const,
    origin: 'codex' as const,
  },
  streaming: {
    mood: 'streaming' as const,
    glyph: '⚡',
    durationMs: 3200,
    fallbackChain: ['thinking', 'idle'] as PetMood[],
    category: 'state' as const,
    origin: 'codex' as const,
  },
  happy: {
    mood: 'happy' as const,
    glyph: '👋',
    durationMs: 1800,
    fallbackChain: ['xpeffect', 'idle'] as PetMood[],
    category: 'state' as const,
    origin: 'codex' as const,
  },
  error: {
    mood: 'error' as const,
    glyph: '⚠️',
    durationMs: 2600,
    fallbackChain: ['thinking', 'idle'] as PetMood[],
    category: 'state' as const,
    origin: 'codex' as const,
  },
  thinking: {
    mood: 'thinking' as const,
    glyph: '🤔',
    durationMs: 3200,
    fallbackChain: ['idle'] as PetMood[],
    category: 'state' as const,
    origin: 'codex' as const,
  },
  jumping: {
    mood: 'jumping' as const,
    glyph: '🦘',
    durationMs: 1500,
    // Hop fallback: pets without a jump row use happy (bounce-like) before idle.
    fallbackChain: ['happy', 'idle'] as PetMood[],
    category: 'locomotion' as const,
    origin: 'codex' as const,
  },
  powermove: {
    mood: 'powermove' as const,
    glyph: '💥',
    trigger: 'powermove' as const,
    fallbackChain: ['streaming', 'happy', 'idle'] as PetMood[],
    category: 'action' as const,
    origin: 'codex' as const,
  },
  xpeffect: {
    mood: 'xpeffect' as const,
    glyph: '✨',
    durationMs: 2000,
    fallbackChain: ['happy', 'idle'] as PetMood[],
    category: 'action' as const,
    origin: 'codex' as const,
  },
  // ── YHA-extras ─────────────────────────────────────────────────────────
  fighting: {
    mood: 'fighting' as const,
    glyph: '🥊',
    trigger: 'fight' as const,
    // YHA-extra: falls back to powermove (closest big-action) then streaming.
    fallbackChain: ['powermove', 'streaming', 'idle'] as PetMood[],
    category: 'action' as const,
    origin: 'yha-extra' as const,
  },
  reconnecting: {
    mood: 'reconnecting' as const,
    glyph: '🔄',
    durationMs: 3200,
    // YHA-extra: falls back to thinking (the "waiting in thought" feel).
    fallbackChain: ['thinking', 'idle'] as PetMood[],
    category: 'state' as const,
    origin: 'yha-extra' as const,
  },
};

/** Strictly-typed catalog. TypeScript requires every PetMood to have an
 *  entry — adding a new mood to the union without a catalog entry fails
 *  the typecheck. */
export const ANIMATION_CATALOG: Record<PetMood, AnimationEntry> = CATALOG_RAW;

/**
 * Display order — Codex 9 in their canonical sequence first, then
 * YHA-extras. Used by the chip grid + coverage display so the order is
 * predictable across surfaces.
 */
export const ANIMATION_ORDER: PetMood[] = [
  // ── Codex 9 (canonical) ────────────────────────────────────────────────
  'idle', 'running', 'streaming', 'happy', 'error', 'thinking',
  'jumping', 'powermove', 'xpeffect',
  // ── YHA-extras ─────────────────────────────────────────────────────────
  'fighting', 'reconnecting',
];

/** The Codex 9 list — used for the upgrade hint ("complete Codex coverage"). */
export const CODEX_9: PetMood[] = ANIMATION_ORDER.filter(
  (m) => ANIMATION_CATALOG[m].origin === 'codex',
);

// ── Helpers (catalog-driven; UI surfaces should NEVER re-derive these) ────

/** Walk the fallback chain for `mood` and return the first mood whose
 *  frames exist in the manifest. If nothing in the chain hits, returns
 *  the input mood (caller can branch on whether `result === mood &&
 *  !manifest.poses[mood]` to detect "no frames at all"). */
export function resolveMoodPose(
  mood: PetMood,
  manifest: PetManifest | undefined | null,
): { mood: PetMood; isFallback: boolean; missing: boolean } {
  const poses = manifest?.poses;
  if (poses?.[mood]) return { mood, isFallback: false, missing: false };
  const chain = ANIMATION_CATALOG[mood]?.fallbackChain ?? [];
  for (const candidate of chain) {
    if (poses?.[candidate]) {
      return { mood: candidate, isFallback: true, missing: false };
    }
  }
  // Nothing in the chain has frames either.
  return { mood, isFallback: false, missing: true };
}

/** List of catalog moods the manifest is missing frames for. Used by the
 *  "upgrade pet" hint in the pet menu so the user can see exactly what's
 *  short of full Codex + YHA-extras coverage. */
export function getMissingMoods(manifest: PetManifest | undefined | null): PetMood[] {
  const poses = manifest?.poses;
  return ANIMATION_ORDER.filter((m) => !poses?.[m]);
}

/** Coverage stats — { present: N, total: M, missingCodex, missingExtras }. */
export function getAnimationCoverage(
  manifest: PetManifest | undefined | null,
): {
  total: number;
  present: number;
  missing: PetMood[];
  missingCodex: PetMood[];
  missingExtras: PetMood[];
  fullCodexCoverage: boolean;
} {
  const missing = getMissingMoods(manifest);
  const missingCodex = missing.filter((m) => ANIMATION_CATALOG[m].origin === 'codex');
  const missingExtras = missing.filter((m) => ANIMATION_CATALOG[m].origin === 'yha-extra');
  const total = ANIMATION_ORDER.length;
  const present = total - missing.length;
  return {
    total,
    present,
    missing,
    missingCodex,
    missingExtras,
    fullCodexCoverage: missingCodex.length === 0,
  };
}

/** The pose-fallback chain as the petStore expects it — derived from the
 *  catalog so the petStore doesn't duplicate the chain definitions. */
export function getPoseFallbackChain(): Record<PetMood, PetMood[]> {
  const out = {} as Record<PetMood, PetMood[]>;
  for (const mood of ANIMATION_ORDER) {
    out[mood] = ANIMATION_CATALOG[mood].fallbackChain;
  }
  return out;
}
