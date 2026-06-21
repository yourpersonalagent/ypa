// Manifest builder — turn a hatch-wizard state into the YHA pet manifest
// JSON shape consumed by petStore.installManifest().
//
// The manifest is what the user activates at the end of the wizard. It
// references frame paths under `/pets/<id>/<row>-NN.png`; persistence to
// disk happens via the bridge upload endpoint.

import { ROWS, ROW_TO_MOOD } from './animationRows.js';
import { planRows } from './plans.js';
import type { CharacterSpec, PlanName, RowName, PetMood } from './types.js';
import type { PetProfileId } from '../profiles/types.js';

export interface ManifestPose {
  label: string;
  src: string;
  fallback: string | null;
  frames: { src: string; duration: number }[];
  hotspotAnchor: 'bottom-center';
  effectZone: { width: number; height: number; top: number; left: number };
  /**
   * Strip grid layout used when this pose was generated. Stored so the system
   * knows how to re-slice a strip sheet without re-running the wizard, and to
   * enable provider-agnostic imports (Grok / OpenAI / Google) — each provider
   * may output a different native grid; this field makes the manifest
   * self-describing.
   *
   * Absent in pets hatched before this field was added (backwards-compatible:
   * the runtime reads frame counts from `frames[]` directly and does not
   * depend on this field for playback).
   */
  stripLayout?: { cols: number; rows: number };
  /**
   * Per-row display scale applied at render time, NOT baked into the PNG.
   * All rows now use a uniform 3×3 strip grid (320×320 px cells), so the
   * default value is 1 for newly hatched pets. This field is preserved so
   * manually nudged scales (set via the nudge-modal row-scale slider) survive
   * manifest round-trips. Omit (or 1) = no scaling.
   */
  scale?: number;
}

export interface YhaPetManifest {
  name: string;
  label: string;
  description: string;
  homeSpot: { x: number | null; y: number };
  spriteFormat: 'square-frame-sequence';
  spriteSize: 960;
  poses: Partial<Record<PetMood, ManifestPose>>;
  voiceLines?: Partial<Record<PetMood, string[]>>;
  xpeffectStyle?: string;
  xpeffectInterval?: { min: number; max: number };
  /**
   * Optional metadata persisted by the wizard so future upgrades can re-derive
   * the prompt context without asking the user. Pets hatched before this
   * field existed simply omit it; the upgrade flow falls back to re-entry.
   */
  hatch?: {
    spec: CharacterSpec;
    plan: string;
    archetypeId: string | null;
  };
  /**
   * The PetProfile this pet was designed for. When set, loading the pet
   * auto-applies the profile (unless the user has manually switched away
   * since). Codex pets ship `petV3` (calm Codex-aligned behaviour); /hedge
   * `full`/`brawl` pets ship `petV1` (richer behaviour set matches the
   * richer animation set); `lite` pets ship `petV3` (fewer animations →
   * V3's minimal repertoire is the better fit). Absent on legacy pets.
   */
  preferredProfile?: PetProfileId;
}

const DEFAULT_EFFECT_ZONE = { width: 360, height: 360, top: -100, left: -110 };
const POWERMOVE_EFFECT_ZONE = { width: 560, height: 560, top: -220, left: -210 };
const STREAMING_EFFECT_ZONE = { width: 440, height: 440, top: -145, left: -145 };

function effectZoneFor(mood: PetMood) {
  if (mood === 'powermove') return POWERMOVE_EFFECT_ZONE;
  if (mood === 'streaming' || mood === 'fighting') return STREAMING_EFFECT_ZONE;
  // running uses the same compact zone as idle — no glow or special FX needed
  // while sprinting; the patrol controller owns the visual drama via WAAPI arcs.
  return DEFAULT_EFFECT_ZONE;
}

function moodLabel(mood: PetMood, baseLabel: string): string {
  switch (mood) {
    case 'idle': return 'Ready';
    case 'thinking': return 'Thinking';
    case 'streaming': return 'Working';
    case 'powermove': return 'Power Move!';
    case 'error': return 'Stumbled';
    case 'reconnecting': return 'Recovering';
    case 'fighting': return 'Fighting!';
    case 'happy': return 'Waving!';
    case 'xpeffect': return 'XP!';
    case 'running':     return 'Running!';
    case 'jumping':     return 'Jumping!';
    default: return baseLabel;
  }
}

/** Build a single pose entry from a row name. */
function buildPose(petId: string, rowName: RowName, mood: PetMood, label: string): ManifestPose {
  const row = ROWS[rowName];
  const frames = Array.from({ length: row.frames }, (_, i) => ({
    src: `/pets/${petId}/${rowName}-${String(i + 1).padStart(2, '0')}.png`,
    duration: row.durations[i],
  }));
  return {
    label,
    src: frames[0].src,
    fallback: null,
    frames,
    hotspotAnchor: 'bottom-center',
    effectZone: effectZoneFor(mood),
    stripLayout: row.stripLayout,
  };
}

/**
 * Build a YHA-compatible manifest for the given character + plan.
 *
 * Only rows in the plan get poses. petStore.withPoseFallbacks() takes care
 * of common fallbacks (reconnecting → thinking, happy → idle) at install
 * time, so a `lite` plan still produces a usable pet.
 */
export function buildManifest(
  spec: CharacterSpec,
  planName: string,
  description = '',
  archetypeId: string | null = null,
): YhaPetManifest {
  const rows = planRows(planName);
  const poses: Partial<Record<PetMood, ManifestPose>> = {};
  const seen = new Set<PetMood>();

  // Pre-compute which moods are served as PRIMARY by at least one row in
  // this plan. Aliases are only fallbacks — they must not override a mood
  // that already has its own dedicated row. Without this guard, processing
  // order determines the winner: in the `full` plan `jumping` appears before
  // `xpeffect`, so its alias `['xpeffect']` would claim the xpeffect mood
  // before the real xpeffect row is ever reached, leaving the dedicated
  // xpeffect-01..06.png frames generated and uploaded but never used.
  const primaryMoodsInPlan = new Set<PetMood>();
  for (const rowName of rows) {
    const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
    if (entry) primaryMoodsInPlan.add(entry.primary);
  }

  for (const rowName of rows) {
    const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
    if (!entry) continue;
    if (!seen.has(entry.primary)) {
      poses[entry.primary] = buildPose(spec.id, rowName, entry.primary, moodLabel(entry.primary, spec.name));
      seen.add(entry.primary);
    }
    for (const alias of entry.alias ?? []) {
      // Skip this alias if the mood has a dedicated primary row in the plan —
      // the primary will arrive later (or already arrived) and is always
      // more specific than an alias from a sibling row.
      if (!seen.has(alias) && !primaryMoodsInPlan.has(alias)) {
        poses[alias] = buildPose(spec.id, rowName, alias, moodLabel(alias, spec.name));
        seen.add(alias);
      }
    }
  }

  return {
    name: spec.id,
    label: spec.name,
    description: description || `Hatched pet — ${spec.silhouette || 'custom companion'}.`,
    homeSpot: { x: null, y: 420 },
    spriteFormat: 'square-frame-sequence',
    spriteSize: 960,
    poses,
    xpeffectStyle: 'gold-stars',
    xpeffectInterval: { min: 180, max: 540 },
    hatch: { spec, plan: planName, archetypeId },
    preferredProfile: preferredProfileForPlan(planName),
  };
}

/**
 * Map a /hedge plan to the PetProfile it ships best with.
 *
 *   • `full` / `brawl`   → petV1  (rich animation set matches V1's busier
 *                                  behaviour set: peek-away, button-hop,
 *                                  fight anchor, theatrical jump).
 *   • `lite`             → petV3  (lite ships only 3 rows; V3's minimal
 *                                  wander+perch repertoire is the cleaner fit).
 *   • unknown plan       → undefined (no preference; user's session choice
 *                                  applies).
 */
function preferredProfileForPlan(planName: string): PetProfileId | undefined {
  if (planName === 'full' || planName === 'brawl') return 'petV1';
  if (planName === 'lite') return 'petV3';
  return undefined;
}

/**
 * Merge a freshly built manifest into an existing one, preserving any
 * top-level metadata the user may have edited (homeSpot, voiceLines, …)
 * and keeping pre-existing poses that aren't part of the new plan rows.
 *
 * Used by the upgrade flow: existing pet's manifest + freshly built manifest
 * for the same spec + new plan → merged manifest with the new rows added.
 */
export function mergeManifest(
  existing: YhaPetManifest,
  rebuilt: YhaPetManifest,
): YhaPetManifest {
  return {
    ...existing,
    ...rebuilt,
    // Existing metadata wins for fields the user might have customized.
    homeSpot: existing.homeSpot ?? rebuilt.homeSpot,
    voiceLines: existing.voiceLines ?? rebuilt.voiceLines,
    xpeffectStyle: existing.xpeffectStyle ?? rebuilt.xpeffectStyle,
    xpeffectInterval: existing.xpeffectInterval ?? rebuilt.xpeffectInterval,
    description: existing.description || rebuilt.description,
    // Poses: rebuilt wins for plan rows, existing wins for everything else.
    poses: { ...existing.poses, ...rebuilt.poses },
    // Always carry the latest hatch metadata so subsequent upgrades work.
    hatch: rebuilt.hatch ?? existing.hatch,
  };
}

/**
 * Build a single manifest pose entry for one row name — used when the nudge
 * modal "claims" an orphaned row into the manifest without a full re-hatch.
 *
 * Returns null when the row has no ROW_TO_MOOD entry (truly orphaned with no
 * known mood mapping) so the caller can show an appropriate error.
 */
export function buildRowPose(
  petId: string,
  rowName: RowName,
  petLabel: string,
): ManifestPose | null {
  const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
  if (!entry) return null;
  return buildPose(petId, rowName, entry.primary, moodLabel(entry.primary, petLabel));
}

/**
 * Given a manifest and the full list of animation-frame filenames on disk for
 * that pet, return a patched manifest with any orphaned rows claimed into it.
 *
 * A row is orphaned when:
 *  - Files matching `{rowName}-NN.png` exist on disk
 *  - The row has a ROW_TO_MOOD entry (known mood mapping)
 *  - No existing manifest pose already references `/{rowName}-NN.png` paths
 *
 * This handles frames uploaded via "Replace row" in the nudge modal or via an
 * upgrade that wrote PNGs to disk without updating the manifest poses.
 */
export function claimOrphanedRows(
  manifest: YhaPetManifest,
  onDiskFiles: string[],
): YhaPetManifest {
  const diskRows = new Set<string>();
  for (const filename of onDiskFiles) {
    const m = filename.match(/^([a-z][a-z0-9-]*)-\d{2}\.png$/i);
    if (m) diskRows.add(m[1]);
  }

  // Track which moods are already served by new-style (-NN.png) frame paths.
  const mappedMoods = new Set<PetMood>();
  for (const pose of Object.values(manifest.poses) as (ManifestPose | undefined)[]) {
    if (!pose) continue;
    for (const f of pose.frames) {
      const base = f.src.split('?')[0];
      const m = base.match(/\/([a-z][a-z0-9-]*)-\d{2}\.png$/i);
      if (!m) continue;
      const entry = ROW_TO_MOOD.find((e) => e.row === m[1]);
      if (entry) mappedMoods.add(entry.primary);
    }
  }

  let patched = manifest;
  for (const rowName of diskRows) {
    const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
    if (!entry) continue;
    if (mappedMoods.has(entry.primary)) continue;
    const pose = buildRowPose(manifest.name, rowName as RowName, manifest.label);
    if (!pose) continue;
    patched = {
      ...patched,
      poses: { ...patched.poses, [entry.primary]: pose },
    };
    mappedMoods.add(entry.primary);
  }

  return patched;
}

/** Compute which plan rows the given manifest is missing a primary pose for. */
export function missingPlanRows(
  existing: YhaPetManifest,
  planName: PlanName,
): RowName[] {
  const rows = planRows(planName);
  const missing: RowName[] = [];
  for (const rowName of rows) {
    const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
    if (!entry) continue;
    if (!existing.poses?.[entry.primary]) missing.push(rowName);
  }
  return missing;
}
