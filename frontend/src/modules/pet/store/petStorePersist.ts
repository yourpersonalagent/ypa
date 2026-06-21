// petStorePersist — localStorage load/save/clamp helpers for the pet store.
// Extracted from petStore.ts to keep it focused on state logic.

import type { PetFacing, PetManifest, PetIdentity } from './petStoreTypes.js';
import {
  SHADOW_OFFSET_MIN_PX,
  SHADOW_OFFSET_MAX_PX,
  SHADOW_OFFSET_DEFAULT_PX,
  GLOBAL_SCALE_MIN,
  GLOBAL_SCALE_MAX,
  GLOBAL_SCALE_STEP,
  GLOBAL_SCALE_DEFAULT,
  GLOW_INTENSITY_MIN,
  GLOW_INTENSITY_MAX,
  GLOW_INTENSITY_STEP,
  GLOW_INTENSITY_DEFAULT,
  ACTIVITY_RATE_MIN,
  ACTIVITY_RATE_MAX,
  ACTIVITY_RATE_STEP,
  ACTIVITY_RATE_DEFAULT,
} from './petStoreTypes.js';

// ── localStorage key constants ────────────────────────────────────────────

export const VISIBILITY_KEY = 'yha.pet.visible';
export const PET_MANIFEST_KEY = 'yha.pet.currentManifest';
export const FACING_KEY = 'yha.pet.facing';
export const MIRROR_KEY  = 'yha.pet.mirrorSprite';
export const THEME_TINT_KEY = 'yha.pet.themeTint';
export const SHADOW_OFFSET_KEY = 'yha.pet.shadowOffsetPx';
export const GLOBAL_SCALE_KEY = 'yha.pet.globalScale';
export const GLOW_INTENSITY_KEY = 'yha.pet.glowIntensity';
export const XP_KEY = 'yha.pet.xp';
export const LEVEL_KEY = 'yha.pet.level';
export const BEHIND_UI_KEY = 'yha.pet.behindUi';
export const ACTIVITY_RATE_KEY = 'yha.pet.activityRate';
export const TEXT_REFLOW_KEY = 'yha.pet.textReflow';
export const PROFILE_ID_KEY = 'yha.pet.profileId';
export const DEBUG_OVERLAY_KEY = 'yha.pet.debugOverlay';

/** Per-pet flip-run key prefix. Each pet stores its own setting under
 *  `yha.pet.flipRun.<petId>` so imported pets remember their own state. */
export const FLIP_RUN_PREFIX = 'yha.pet.flipRun.';
export function flipRunKey(petId: string): string { return `${FLIP_RUN_PREFIX}${petId}`; }

// ── Visibility ────────────────────────────────────────────────────────────

export function loadVisibility(): boolean {
  try { return localStorage.getItem(VISIBILITY_KEY) !== '0'; } catch { return true; }
}
export function saveVisibility(v: boolean): void {
  try { localStorage.setItem(VISIBILITY_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Facing ────────────────────────────────────────────────────────────────

export function loadFacing(): PetFacing {
  try {
    const raw = localStorage.getItem(FACING_KEY);
    return raw === 'left' ? 'left' : 'right';
  } catch { return 'right'; }
}
export function saveFacing(f: PetFacing): void {
  try { localStorage.setItem(FACING_KEY, f); } catch { /* ignore */ }
}

// ── Mirror sprite ─────────────────────────────────────────────────────────

export function loadMirrorSprite(): boolean {
  try { return localStorage.getItem(MIRROR_KEY) === '1'; } catch { return false; }
}
export function saveMirrorSprite(v: boolean): void {
  try { localStorage.setItem(MIRROR_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Per-pet flip-run ──────────────────────────────────────────────────────

export function loadFlipRun(petId: string, manifest?: PetManifest | null): boolean {
  try {
    const stored = localStorage.getItem(flipRunKey(petId));
    // User has explicitly set a preference → always honour it.
    if (stored !== null) return stored === '1';
    // No saved preference: fall back to the manifest default (true for
    // Codex pets imported before CODEX_HFLIP was enabled, whose frames
    // face left and therefore need the run direction inverted).
    return manifest?.flipRunDefault === true;
  } catch { return false; }
}
export function saveFlipRun(petId: string, v: boolean): void {
  try { localStorage.setItem(flipRunKey(petId), v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Theme tint ────────────────────────────────────────────────────────────

export function loadThemeTint(): boolean {
  try { return localStorage.getItem(THEME_TINT_KEY) === '1'; } catch { return false; }
}
export function saveThemeTint(v: boolean): void {
  try { localStorage.setItem(THEME_TINT_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Shadow offset ─────────────────────────────────────────────────────────

export function clampShadowOffset(px: number): number {
  if (!Number.isFinite(px)) return SHADOW_OFFSET_DEFAULT_PX;
  return Math.max(SHADOW_OFFSET_MIN_PX, Math.min(SHADOW_OFFSET_MAX_PX, Math.round(px)));
}
export function loadShadowOffset(): number {
  try {
    const raw = localStorage.getItem(SHADOW_OFFSET_KEY);
    if (raw == null) return SHADOW_OFFSET_DEFAULT_PX;
    return clampShadowOffset(Number(raw));
  } catch { return SHADOW_OFFSET_DEFAULT_PX; }
}
export function saveShadowOffset(px: number): void {
  try { localStorage.setItem(SHADOW_OFFSET_KEY, String(px)); } catch { /* ignore */ }
}

// ── Global scale ──────────────────────────────────────────────────────────

export function clampGlobalScale(v: number): number {
  if (!Number.isFinite(v)) return GLOBAL_SCALE_DEFAULT;
  // Round to step granularity so persisted values don't accumulate float drift.
  const stepped = Math.round(v / GLOBAL_SCALE_STEP) * GLOBAL_SCALE_STEP;
  return Math.max(GLOBAL_SCALE_MIN, Math.min(GLOBAL_SCALE_MAX, stepped));
}
export function loadGlobalScale(): number {
  try {
    const raw = localStorage.getItem(GLOBAL_SCALE_KEY);
    if (raw == null) return GLOBAL_SCALE_DEFAULT;
    return clampGlobalScale(Number(raw));
  } catch { return GLOBAL_SCALE_DEFAULT; }
}
export function saveGlobalScale(v: number): void {
  try { localStorage.setItem(GLOBAL_SCALE_KEY, String(v)); } catch { /* ignore */ }
}

// ── Glow intensity ────────────────────────────────────────────────────────

export function clampGlowIntensity(v: number): number {
  if (!Number.isFinite(v)) return GLOW_INTENSITY_DEFAULT;
  const stepped = Math.round(v / GLOW_INTENSITY_STEP) * GLOW_INTENSITY_STEP;
  return Math.max(GLOW_INTENSITY_MIN, Math.min(GLOW_INTENSITY_MAX, stepped));
}
export function loadGlowIntensity(): number {
  try {
    const raw = localStorage.getItem(GLOW_INTENSITY_KEY);
    if (raw == null) return GLOW_INTENSITY_DEFAULT;
    return clampGlowIntensity(Number(raw));
  } catch { return GLOW_INTENSITY_DEFAULT; }
}
export function saveGlowIntensity(v: number): void {
  try { localStorage.setItem(GLOW_INTENSITY_KEY, String(v)); } catch { /* ignore */ }
}

// ── Behind UI ─────────────────────────────────────────────────────────────

export function loadBehindUi(): boolean {
  try { return localStorage.getItem(BEHIND_UI_KEY) === '1'; } catch { return false; }
}
export function saveBehindUi(v: boolean): void {
  try { localStorage.setItem(BEHIND_UI_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Activity rate ─────────────────────────────────────────────────────────

export function clampActivityRate(v: number): number {
  if (!Number.isFinite(v)) return ACTIVITY_RATE_DEFAULT;
  const stepped = Math.round(v / ACTIVITY_RATE_STEP) * ACTIVITY_RATE_STEP;
  return Math.max(ACTIVITY_RATE_MIN, Math.min(ACTIVITY_RATE_MAX, stepped));
}
export function loadActivityRate(): number {
  try {
    const raw = localStorage.getItem(ACTIVITY_RATE_KEY);
    if (raw == null) return ACTIVITY_RATE_DEFAULT;
    return clampActivityRate(Number(raw));
  } catch { return ACTIVITY_RATE_DEFAULT; }
}
export function saveActivityRate(v: number): void {
  try { localStorage.setItem(ACTIVITY_RATE_KEY, String(v)); } catch { /* ignore */ }
}

// ── Text reflow ───────────────────────────────────────────────────────────

export function loadPetTextReflow(): boolean {
  try { return localStorage.getItem(TEXT_REFLOW_KEY) === '1'; } catch { return false; }
}
export function savePetTextReflow(v: boolean): void {
  try { localStorage.setItem(TEXT_REFLOW_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Debug overlay ─────────────────────────────────────────────────────────

export function loadDebugOverlay(): boolean {
  try { return localStorage.getItem(DEBUG_OVERLAY_KEY) === '1'; } catch { return false; }
}
export function saveDebugOverlay(v: boolean): void {
  try { localStorage.setItem(DEBUG_OVERLAY_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Behavior profile id ───────────────────────────────────────────────────

import type { PetProfileId } from '../profiles/types.js';

/** Per-pet profile override key — populated when the user explicitly picks
 *  a profile while a pet is active. Takes precedence over the manifest's
 *  preferredProfile so the user's manual choice always wins. */
export const PROFILE_ID_PET_PREFIX = 'yha.pet.profileId.';
function profileIdPetKey(petId: string): string {
  return `${PROFILE_ID_PET_PREFIX}${petId}`;
}

function isValidProfileId(raw: string | null): raw is PetProfileId {
  return raw === 'petV1' || raw === 'petV3';
}

export function loadProfileId(): PetProfileId {
  try {
    const raw = localStorage.getItem(PROFILE_ID_KEY);
    if (isValidProfileId(raw)) return raw;
    // No persisted value → use the codex-first default. Existing users
    // with their choice already saved keep that choice.
    return 'petV3';
  } catch { return 'petV3'; }
}
export function saveProfileId(id: PetProfileId): void {
  try { localStorage.setItem(PROFILE_ID_KEY, id); } catch { /* ignore */ }
}

/** Read the per-pet profile override, if any. */
export function loadProfileIdForPet(petId: string): PetProfileId | null {
  if (!petId) return null;
  try {
    const raw = localStorage.getItem(profileIdPetKey(petId));
    return isValidProfileId(raw) ? raw : null;
  } catch { return null; }
}

/** Write the per-pet profile override. Persists the user's choice so the
 *  next time this pet loads, their choice wins over the manifest preference. */
export function saveProfileIdForPet(petId: string, id: PetProfileId): void {
  if (!petId) return;
  try { localStorage.setItem(profileIdPetKey(petId), id); } catch { /* ignore */ }
}

/** Clear the per-pet profile override so the manifest's preferredProfile
 *  (or the global default) takes over again. */
export function clearProfileIdForPet(petId: string): void {
  if (!petId) return;
  try { localStorage.removeItem(profileIdPetKey(petId)); } catch { /* ignore */ }
}

// ── XP / Level ────────────────────────────────────────────────────────────

export function loadXp(): number {
  try {
    const raw = localStorage.getItem(XP_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch { return 0; }
}
export function saveXp(v: number): void {
  try { localStorage.setItem(XP_KEY, String(v)); } catch { /* ignore */ }
}
export function loadLevel(): number {
  try {
    const raw = localStorage.getItem(LEVEL_KEY);
    const n = raw == null ? 1 : Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  } catch { return 1; }
}
export function saveLevel(v: number): void {
  try { localStorage.setItem(LEVEL_KEY, String(v)); } catch { /* ignore */ }
}

// ── Current pet (identity only — manifest loaded separately) ──────────────

/** Default PetIdentity used when nothing is persisted or parse fails.
 * The matching sprite folder lives at frontend/public/pets/hail-mary-rocky/;
 * the real manifest (with proper rewardKind, animations, etc.) is loaded
 * asynchronously by setCurrentPet in petStore.ts, so the placeholder
 * rewardKind here is just what shows during the first frame or two. */
const DEFAULT_PET_ID: PetIdentity = { id: 'hail-mary-rocky', name: 'Hail Mary Rocky', rewardKind: 'stars' };

export function loadCurrentPet(): PetIdentity {
  try {
    const raw = localStorage.getItem(PET_MANIFEST_KEY);
    if (!raw) return DEFAULT_PET_ID;
    const parsed = JSON.parse(raw) as Partial<PetIdentity> & { manifest?: unknown };
    const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : DEFAULT_PET_ID.id;
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : DEFAULT_PET_ID.name;
    const rewardKind = parsed.rewardKind === 'coins' || parsed.rewardKind === 'fruit' || parsed.rewardKind === 'sparks'
      ? parsed.rewardKind
      : 'stars';
    return { id, name, rewardKind, manifest: undefined };
  } catch {
    return DEFAULT_PET_ID;
  }
}
