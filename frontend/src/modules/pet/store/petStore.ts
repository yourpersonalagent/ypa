// petStore — He-Man pet mood + visibility, single global instance.
//
// Mood is *derived* from the active session's stream state (subscribed in
// initPetStore()), with one-shot 'powermove' set explicitly via
// triggerPowermove() and auto-cleared after the animation duration.
//
// Wiring (configured in initPetStore):
//   - useChatStore.sessionStreams + useSessionStore.currentId  → setMood
//   - net-metrics.onReconnectFinish('done') → triggerPowermove
//   - useGraphStore.running-tool-count  → triggerFight (45% chance on new tool start)
//
// /pet is intercepted locally before chat.send(). Position is handled by the
// bare FloatingPet overlay, not by the MoveableWindow component.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useChatStore } from '../../../stores/chatStore.js';
import { useSessionStore } from '../../../stores/sessionStore.js';
import { onReconnectFinish } from '../../../util/net-metrics.js';
import { useGraphStore } from '../../../stores/graphStore.js';

// ── Re-export types and constants so existing imports keep working ─────────
export type { PetMood, SpriteConfig, PetManifest, PetIdentity, PetFacing, PetState, PetActions, PetStore } from './petStoreTypes.js';
export type { PetProfileId } from '../profiles/types.js';
export { XP_PER_LEVEL, XP_GAIN_MIN, XP_GAIN_MAX, LEVEL_STAGE_MS, SHADOW_OFFSET_MIN_PX, SHADOW_OFFSET_MAX_PX, SHADOW_OFFSET_DEFAULT_PX, GLOBAL_SCALE_MIN, GLOBAL_SCALE_MAX, GLOBAL_SCALE_STEP, GLOBAL_SCALE_DEFAULT, GLOW_INTENSITY_MIN, GLOW_INTENSITY_MAX, GLOW_INTENSITY_STEP, GLOW_INTENSITY_DEFAULT, ACTIVITY_RATE_MIN, ACTIVITY_RATE_MAX, ACTIVITY_RATE_STEP, ACTIVITY_RATE_DEFAULT, xpForNextLevel } from './petStoreTypes.js';

import type { PetMood, PetManifest, PetIdentity, PetStore } from './petStoreTypes.js';
import { XP_GAIN_MIN, XP_GAIN_MAX, LEVEL_STAGE_MS, xpForNextLevel } from './petStoreTypes.js';
import {
  loadVisibility, saveVisibility,
  loadFacing, saveFacing,
  loadMirrorSprite, saveMirrorSprite,
  loadFlipRun, saveFlipRun,
  loadThemeTint, saveThemeTint,
  clampShadowOffset, loadShadowOffset, saveShadowOffset,
  clampGlobalScale, loadGlobalScale, saveGlobalScale,
  clampGlowIntensity, loadGlowIntensity, saveGlowIntensity,
  loadBehindUi, saveBehindUi,
  clampActivityRate, loadActivityRate, saveActivityRate,
  loadPetTextReflow, savePetTextReflow,
  loadXp, saveXp,
  loadLevel, saveLevel,
  loadCurrentPet,
  loadProfileId, saveProfileId,
  loadProfileIdForPet, saveProfileIdForPet, clearProfileIdForPet,
  loadDebugOverlay, saveDebugOverlay,
  PET_MANIFEST_KEY,
} from './petStorePersist.js';
import type { PetProfileId } from '../profiles/types.js';
import { getPoseFallbackChain } from '../animations.js';

const POWERMOVE_DURATION_MS = 1600;
const FIGHT_DURATION_MS = 2200;
/** How long to hold the xpeffect mood after a reward burst. Two full cycles
 *  of the 6-frame strip (840 ms each) plus a short settle — long enough to
 *  be clearly visible but short enough to not outlast a level-up animation. */
const XP_EFFECT_DURATION_MS = 1800;
const NOTE_FLASH_DURATION_MS = 1600;

let _powermoveTimer: number | null = null;
let _fightTimer: number | null = null;
let _xpEffectTimer: number | null = null;
/** Active mood-preview timer. While set, the chat-streaming subscription's
 *  `setMood` calls are silently dropped so the user actually gets to *see*
 *  the previewed animation instead of having it stomped by the next chunk. */
let _previewTimer: number | null = null;
/** Level-up animation timers — one per stage (3 grow + 1 settle). Stored
 *  as a list so `triggerLevelUp()` can cancel any in-flight animation
 *  cleanly when called twice in quick succession (e.g. user crosses two
 *  level thresholds in one burst). */
const _levelUpTimers: number[] = [];

function deriveMood(
  ss: { reconnecting?: boolean; status?: string } | undefined,
): PetMood {
  if (!ss) return 'idle';
  if (ss.reconnecting) return 'reconnecting';
  if (ss.status === 'streaming') return 'streaming';
  if (ss.status === 'error') return 'error';
  return 'idle';
}

function persistManifest(manifest: PetManifest): void {
  const rewardKind = rewardKindFromManifest(manifest);
  try {
    localStorage.setItem(PET_MANIFEST_KEY, JSON.stringify({
      id: manifest.name,
      name: manifest.label,
      rewardKind,
    }));
  } catch { /* ignore */ }
}

function rewardKindFromManifest(manifest: PetManifest): PetIdentity['rewardKind'] {
  const style = String(manifest.xpeffectStyle || '').toLowerCase();
  if (style.includes('coin')) return 'coins';
  if (style.includes('fruit')) return 'fruit';
  if (style.includes('spark')) return 'sparks';
  return 'stars';
}

/**
 * Fill in missing pose entries from the closest sibling that DOES have
 * frames. The user complaint that motivated the more aggressive fallback
 * chain: lower-tier upgrade plans are missing `error`, `streaming`,
 * `reconnecting`, `fighting`, `happy` etc. Without a fallback, PetSprite
 * renders the inline He-Man SVG silhouette — even though the user has a
 * fully-themed custom pet for `idle`. The flicker between the user's pet
 * and the generic He-Man reads as broken.
 *
 * Priority order per missing mood is hand-picked so the fallback feels
 * appropriate. e.g. an `error` pet without its own frames gets the
 * `thinking` animation (which already reads as "uncertain" — better than
 * `streaming`'s power-stance). Rule of thumb: pick the closest emotional
 * sibling first, then walk down toward `idle` as the universal fallback.
 *
 * NOTE: every chain MUST eventually terminate at `idle`, otherwise a pet
 * with only `streaming` and no `idle` would still drop to SVG. We assume
 * every manifest has at least an idle pose; if not, we skip the fallback
 * entirely (the user really does want SVG in that case).
 */
// Fallback chain is derived from the central animation catalog so
// runtime sprite resolution, UI hints, and the upgrade-coverage display
// all read the same canonical fallback rules. See ../animations.ts.
const POSE_FALLBACK_CHAIN: Record<PetMood, PetMood[]> = getPoseFallbackChain();

function withPoseFallbacks(manifest: PetManifest): PetManifest {
  const poses: PetManifest['poses'] = { ...(manifest.poses || {}) };
  if (!poses.idle) {
    // No anchor — leave as-is so PetSprite drops to SVG only when there
    // really is no real content to show. Practically this only happens
    // before loadManifest finishes; FloatingPet's SVG_FALLBACK takes over.
    return { ...manifest, poses };
  }
  for (const mood of Object.keys(POSE_FALLBACK_CHAIN) as PetMood[]) {
    if (poses[mood]) continue;
    for (const sibling of POSE_FALLBACK_CHAIN[mood]) {
      if (poses[sibling]) {
        poses[mood] = poses[sibling];
        break;
      }
    }
  }
  return { ...manifest, poses };
}

export const usePetStore = create<PetStore>()(
  devtools(
    (set, get) => ({
      currentPet: loadCurrentPet(),
      isVisible: loadVisibility(),
      mood: 'idle',
      lastJumpMid: null,
      rewardBurstId: 0,
      facing: loadFacing(),
      mirrorSprite: loadMirrorSprite(),
      flipRun: loadFlipRun(loadCurrentPet().id),
      themeTint: loadThemeTint(),
      fightVariantSeed: 0,
      shadowOffsetPx: loadShadowOffset(),
      globalScale: loadGlobalScale(),
      glowIntensity: loadGlowIntensity(),
      xp: loadXp(),
      level: loadLevel(),
      levelUpStage: 0,
      behindUi: loadBehindUi(),
      activityRate: loadActivityRate(),
      petTextReflow: loadPetTextReflow(),
      playgroundMode: false,
      activeProfileId: loadProfileId(),
      debugOverlay: loadDebugOverlay(),

      toggle: () => {
        const next = !get().isVisible;
        saveVisibility(next);
        set({ isVisible: next });
      },

      setVisible: (v) => {
        saveVisibility(v);
        set({ isVisible: v });
      },

      setMood: (m) => {
        if (get().mood === 'powermove') return;
        // While the user is actively previewing a mood from the menu, drop
        // mood updates from the chat-streaming subscription so the preview
        // stays on screen for the full duration. The preview timer's own
        // expiration calls `set({ mood })` directly (bypassing this guard)
        // and clears `_previewTimer`, so normal mood derivation resumes.
        if (_previewTimer != null) return;
        const prev = get().mood;
        if (prev === m) return;
        // Stream-end → briefly wave if the pet has a distinct happy/waving
        // animation. Object-identity check: withPoseFallbacks assigns the
        // same object reference when happy gets its pose from a sibling
        // (xpeffect or idle), so reference inequality means it's its own
        // explicitly uploaded pose — exactly the case where we want to wave.
        if (prev === 'streaming' && m === 'idle' && get().activityRate > 0) {
          const poses = get().currentPet.manifest?.poses;
          if (poses?.happy && poses.happy !== poses.xpeffect && poses.happy !== poses.idle) {
            get().previewMood('happy', 700);
            try { window.dispatchEvent(new CustomEvent('yha:stream-end')); } catch { /* ignore */ }
            return;
          }
        }
        set({ mood: m });
        // Dispatch broad activity boundary events so other subsystems
        // (bg.ts shader fps budget, etc.) can throttle decorative work
        // while the user is actively waiting on output. These fire on the
        // first transition into / out of streaming — no per-chunk noise.
        try {
          if (m === 'streaming' && prev !== 'streaming') {
            window.dispatchEvent(new CustomEvent('yha:stream-begin'));
          } else if (prev === 'streaming' && m !== 'streaming') {
            window.dispatchEvent(new CustomEvent('yha:stream-end'));
          }
        } catch { /* ignore */ }
      },

      previewMood: (m, durationMs = 2600) => {
        if (_previewTimer != null) {
          clearTimeout(_previewTimer);
          _previewTimer = null;
        }
        // Cancel any in-flight powermove/fight too so the preview is the
        // only animation playing — otherwise a half-completed fight would
        // override our preview the moment its timer fires.
        if (_powermoveTimer != null) {
          clearTimeout(_powermoveTimer);
          _powermoveTimer = null;
        }
        if (_fightTimer != null) {
          clearTimeout(_fightTimer);
          _fightTimer = null;
        }
        set({ mood: m });
        // Bump the variant seed for `fighting` previews so FloatingPet
        // re-rolls the side it slides to (left/right of home). Without this
        // bump, repeated fight previews always pick the same side and the
        // user can't see the variation. Cheap (just a number).
        if (m === 'fighting') {
          set((s) => ({ fightVariantSeed: (s.fightVariantSeed + 1) & 0x7fffffff }));
        }
        if (!Number.isFinite(durationMs) || durationMs >= Number.MAX_SAFE_INTEGER) {
          // Lock indefinitely until next previewMood() / triggerPowermove() /
          // triggerFight() call. Useful for "stay on this animation" mode.
          return;
        }
        _previewTimer = window.setTimeout(() => {
          _previewTimer = null;
          const sid = String(useSessionStore.getState().currentId || 'default');
          const ss = useChatStore.getState().sessionStreams[sid];
          set({ mood: deriveMood(ss) });
        }, Math.max(200, durationMs));
      },

      triggerPowermove: () => {
        if (_powermoveTimer != null) {
          clearTimeout(_powermoveTimer);
          _powermoveTimer = null;
        }
        // Cancel any in-flight preview so the user's "Power move" click
        // takes over cleanly. Without this, a still-pending preview timer
        // would fire mid-powermove and stomp the mood back to derived.
        if (_previewTimer != null) {
          clearTimeout(_previewTimer);
          _previewTimer = null;
        }
        set({ mood: 'powermove' });
        _powermoveTimer = window.setTimeout(() => {
          _powermoveTimer = null;
          const sid = String(useSessionStore.getState().currentId || 'default');
          const ss = useChatStore.getState().sessionStreams[sid];
          set({ mood: deriveMood(ss) });
        }, POWERMOVE_DURATION_MS);
      },

      triggerFight: () => {
        if (_fightTimer != null) {
          clearTimeout(_fightTimer);
          _fightTimer = null;
        }
        if (_previewTimer != null) {
          clearTimeout(_previewTimer);
          _previewTimer = null;
        }
        if (get().mood !== 'powermove') set({ mood: 'fighting' });
        // Bump the variant seed so FloatingPet picks a fresh side every
        // time. Wraps freely; only the change matters.
        set((s) => ({ fightVariantSeed: (s.fightVariantSeed + 1) & 0x7fffffff }));
        _fightTimer = window.setTimeout(() => {
          _fightTimer = null;
          const sid = String(useSessionStore.getState().currentId || 'default');
          const ss = useChatStore.getState().sessionStreams[sid];
          set({ mood: deriveMood(ss) });
        }, FIGHT_DURATION_MS);
      },

      triggerRewardBurst: () => {
        set((s) => ({ rewardBurstId: s.rewardBurstId + 1 }));
        // Grant a randomised XP gain on every burst — the burst IS the
        // visual feedback for "you earned XP", so they're naturally
        // coupled here. Callers that want the burst WITHOUT XP (e.g. a
        // pure visual demo) should `set({ rewardBurstId: ... })` directly.
        const gain = XP_GAIN_MIN + Math.floor(Math.random() * (XP_GAIN_MAX - XP_GAIN_MIN + 1));
        get().addXp(gain);
        // Switch the pet to the xpeffect animation for the burst duration.
        // Skip if a higher-priority animation is already playing (powermove /
        // fighting both beat the XP celebrate). The timer guard below ensures
        // that if the mood is changed externally before the timer fires, the
        // revert is a no-op — we never stomp a streaming/fighting mood that
        // started after our burst.
        const curr = get().mood;
        if (curr === 'powermove' || curr === 'fighting') return;
        if (_xpEffectTimer != null) { clearTimeout(_xpEffectTimer); _xpEffectTimer = null; }
        if (_previewTimer != null) { clearTimeout(_previewTimer); _previewTimer = null; }
        set({ mood: 'xpeffect' });
        _xpEffectTimer = window.setTimeout(() => {
          _xpEffectTimer = null;
          if (get().mood !== 'xpeffect') return; // already changed externally
          const sid = String(useSessionStore.getState().currentId || 'default');
          const ss = useChatStore.getState().sessionStreams[sid];
          set({ mood: deriveMood(ss) });
        }, XP_EFFECT_DURATION_MS);
      },

      addXp: (n) => {
        const inc = Math.max(0, Math.floor(n));
        if (inc === 0) return;
        let { xp, level } = get();
        xp += inc;
        let levelsGained = 0;
        while (xp >= xpForNextLevel(level)) {
          xp -= xpForNextLevel(level);
          level += 1;
          levelsGained += 1;
          // Hard cap at level 99 so the UI doesn't have to handle 4-digit
          // numbers and the threshold (level * XP_PER_LEVEL = 9900) stays
          // achievable even for marathon sessions.
          if (level >= 99) {
            xp = 0;
            break;
          }
        }
        saveXp(xp);
        saveLevel(level);
        set({ xp, level });
        if (levelsGained > 0) get().triggerLevelUp();
      },

      triggerLevelUp: () => {
        // Cancel any in-flight animation. Re-triggering during the
        // grow/shrink would otherwise leave the pet stuck mid-scale.
        for (const t of _levelUpTimers.splice(0)) clearTimeout(t);
        // Stage sequence: 1 → 2 → 3 (the three grow steps the user
        // asked for) → 4 (snap-back). Each stage holds for LEVEL_STAGE_MS
        // before advancing, then 0 clears the data attribute so future
        // mood updates don't leak into a stale stage.
        const schedule = (stage: 0 | 1 | 2 | 3 | 4, delay: number): void => {
          const id = window.setTimeout(() => {
            set({ levelUpStage: stage });
          }, delay);
          _levelUpTimers.push(id);
        };
        set({ levelUpStage: 1 });
        schedule(2, LEVEL_STAGE_MS);
        schedule(3, LEVEL_STAGE_MS * 2);
        schedule(4, LEVEL_STAGE_MS * 3);
        schedule(0, LEVEL_STAGE_MS * 4 + 80);
      },

      jumpTo: (mid) => {
        const el = document.querySelector<HTMLElement>(`[data-mid="${mid}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('note-flash');
        window.setTimeout(() => el.classList.remove('note-flash'), NOTE_FLASH_DURATION_MS);
        set({ lastJumpMid: mid });
      },

      // ── Phase 3: Manifest-Load ──────────────────────────────────────────

      loadManifest: async (id) => {
        try {
          // Cache-bust: pets/<id>.json is small and we never want stale poses
          // (e.g. user upgraded to add `fighting`, but browser still serves
          // the old manifest, which collapses fighting → powermove via the
          // withPoseFallbacks safety net).
          const url = `/pets/${encodeURIComponent(id)}.json?v=${Date.now()}`;
          const resp = await fetch(url, { cache: 'no-cache' });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const manifest = withPoseFallbacks(await resp.json() as PetManifest);
          get().installManifest(manifest);
          console.log(`[PetStore] Manifest geladen: ${manifest.label}`);
        } catch (err) {
          console.warn(`[PetStore] Manifest ${id} nicht ladbar, bleibe bei Default:`, err);
          set({
            currentPet: {
              id: 'hail-mary-rocky',
              name: 'Hail Mary Rocky',
              rewardKind: 'stars',
              manifest: undefined,
            },
          });
        }
      },

      installManifest: (manifest) => {
        const normalized = withPoseFallbacks(manifest);
        const petId = normalized.name;
        // Profile resolution order on pet load:
        //   1. User's per-pet override (most explicit — they picked it
        //      while this pet was active).
        //   2. Manifest's preferredProfile (the pet's designer's hint —
        //      Codex pets ship petV3, /hedge full/brawl ship petV1).
        //   3. Current activeProfileId stays (session-level user choice).
        const userOverride = loadProfileIdForPet(petId);
        const manifestPreferred =
          normalized.preferredProfile === 'petV1' || normalized.preferredProfile === 'petV3'
            ? normalized.preferredProfile
            : undefined;
        const resolvedProfile = userOverride ?? manifestPreferred ?? get().activeProfileId;
        const profileChanged = resolvedProfile !== get().activeProfileId;

        set({
          currentPet: {
            id: petId,
            name: normalized.label,
            rewardKind: rewardKindFromManifest(normalized),
            manifest: normalized,
          },
          flipRun: loadFlipRun(petId, normalized),
          ...(profileChanged ? { activeProfileId: resolvedProfile } : {}),
        });
        if (profileChanged) saveProfileId(resolvedProfile);
        persistManifest(normalized);
      },

      setSpriteConfig: (mood, config) => {
        set((s) => {
          const m = s.currentPet.manifest;
          if (!m) return s;
          const updated = { ...m, poses: { ...m.poses, [mood]: config } };
          return {
            currentPet: { ...s.currentPet, manifest: updated },
          };
        });
      },

      setFacing: (f) => {
        if (get().facing === f) return;
        saveFacing(f);
        set({ facing: f });
      },

      flipFacing: () => {
        const next = !get().mirrorSprite;
        saveMirrorSprite(next);
        set({ mirrorSprite: next });
      },

      toggleFlipRun: () => {
        const petId = get().currentPet.id;
        const next = !get().flipRun;
        saveFlipRun(petId, next);
        set({ flipRun: next });
      },

      setThemeTint: (v) => {
        if (get().themeTint === v) return;
        saveThemeTint(v);
        set({ themeTint: v });
      },

      setShadowOffsetPx: (px) => {
        const next = clampShadowOffset(px);
        if (get().shadowOffsetPx === next) return;
        saveShadowOffset(next);
        set({ shadowOffsetPx: next });
      },

      setGlobalScale: (s) => {
        const next = clampGlobalScale(s);
        if (get().globalScale === next) return;
        saveGlobalScale(next);
        set({ globalScale: next });
      },

      setGlowIntensity: (v) => {
        const next = clampGlowIntensity(v);
        if (get().glowIntensity === next) return;
        saveGlowIntensity(next);
        set({ glowIntensity: next });
      },

      setBehindUi: (v) => {
        if (get().behindUi === v) return;
        saveBehindUi(v);
        set({ behindUi: v });
        // Promote/demote #root's stacking context via a body class so a
        // single CSS rule can flip the whole layer order. Done here (not
        // in FloatingPet's render) so the body class survives even when
        // FloatingPet is unmounted (pet hidden) — otherwise toggling
        // visibility off in behind-ui mode would briefly restore the
        // body to "no behind-ui" and the next show would reapply it,
        // causing a one-frame flicker on every show/hide.
        try {
          document.body.classList.toggle('has-pet-behind-ui', v);
        } catch { /* ignore (test/SSR env) */ }
      },

      setActivityRate: (v) => {
        const next = clampActivityRate(v);
        if (get().activityRate === next) return;
        saveActivityRate(next);
        set({ activityRate: next });
      },

      setPetTextReflow: (v) => {
        if (get().petTextReflow === v) return;
        savePetTextReflow(v);
        set({ petTextReflow: v });
      },

      setPlaygroundMode: (v) => {
        if (get().playgroundMode === v) return;
        set({ playgroundMode: v });
      },

      setActiveProfileId: (id: PetProfileId) => {
        if (get().activeProfileId === id) return;
        saveProfileId(id);
        // Persist the user's choice per-pet too, so the next time this
        // pet loads their explicit pick wins over the manifest's
        // preferredProfile. Only writes when a pet is currently loaded.
        const petId = get().currentPet?.id;
        if (petId) saveProfileIdForPet(petId, id);
        set({ activeProfileId: id });
      },

      resetProfileForActivePet: () => {
        // Clear the per-pet override and re-resolve from the manifest's
        // preferredProfile (or the global default). Used by the "Reset to
        // manifest preference" button in the profile picker.
        const pet = get().currentPet;
        if (!pet?.id) return;
        clearProfileIdForPet(pet.id);
        const manifestPreferred =
          pet.manifest?.preferredProfile === 'petV1' || pet.manifest?.preferredProfile === 'petV3'
            ? pet.manifest.preferredProfile
            : undefined;
        const resolved = manifestPreferred ?? loadProfileId();
        if (resolved === get().activeProfileId) return;
        saveProfileId(resolved);
        set({ activeProfileId: resolved });
      },

      setDebugOverlay: (v) => {
        if (get().debugOverlay === v) return;
        saveDebugOverlay(v);
        set({ debugOverlay: v });
      },
    }),
    { name: 'PetStore' },
  ),
);

// ── Wiring ────────────────────────────────────────────────────────────────

let _wired = false;

export function initPetStore(): void {
  if (_wired) return;
  _wired = true;

  const recompute = (): void => {
    const sid = String(useSessionStore.getState().currentId || 'default');
    const ss = useChatStore.getState().sessionStreams[sid];
    usePetStore.getState().setMood(deriveMood(ss));
  };

  useChatStore.subscribe((s, prev) => {
    if (s.sessionStreams !== prev.sessionStreams) recompute();
  });
  useSessionStore.subscribe((s, prev) => {
    if (s.currentId !== prev.currentId) recompute();
  });

  // Tool-call → fight wiring.
  //
  // We listen to TWO independent signals so the pet still battles tool-calls
  // when one of them is muted:
  //
  //   1. `yha:tool-call-started` window event — dispatched by chat-streaming
  //      on every toolUse chunk, REGARDLESS of recordChat mode. This is the
  //      reliable path: even with recordChat=`no-tools`/`off` (which suppress
  //      the graph-node creation below), the event still fires and the pet
  //      still fights. This was the bug: previously the only trigger was the
  //      graph subscription below, so users on `no-tools` saw zero fights.
  //
  //   2. `useGraphStore` subscription — kept as a secondary signal so the
  //      "many concurrent tools = upgrade to powermove" heuristic still
  //      works (it needs to know the *count* of running tools, which only
  //      exists in graphStore, not in the per-event signal). Skips the
  //      regular fight trigger to avoid double-firing.
  //
  // Both paths gate on `isVisible` and apply Math.random() probability
  // independently. The `_fightTimer` inside triggerFight() debounces
  // overlapping calls so two near-simultaneous events from both paths can't
  // produce two stacked fight animations.
  window.addEventListener('yha:tool-call-started', () => {
    const store = usePetStore.getState();
    if (!store.isVisible) return;
    // activityRate gates spontaneous behaviour — at 0 the pet ignores
    // tool-call events entirely (manual Fight button still works). At
    // 2 the gate doubles to 1.76, effectively "always fight on every
    // tool call during streaming". Clamped at 1.
    const rate = store.activityRate;
    if (rate <= 0) return;
    // When the session is actively streaming (model is responding and calling
    // tools) raise the base probability so the pet is visibly engaged for
    // every tool call, not just 60 % of them. At idle activityRate (1.0) this
    // gives an 88 % fight rate during streaming vs. 60 % in a quiet session.
    const sid = String(useSessionStore.getState().currentId || 'default');
    const ss = useChatStore.getState().sessionStreams[sid];
    const isStreaming = ss?.status === 'streaming';
    const base = isStreaming ? 0.88 : 0.6;
    if (Math.random() < Math.min(1, base * rate)) store.triggerFight();
  });

  let runningToolCount = 0;
  useGraphStore.subscribe((s) => {
    const next = s.nodes.filter((n) => n.type === 'tool' && n.status === 'running').length;
    if (next > runningToolCount && next > 0) {
      const store = usePetStore.getState();
      if (store.isVisible) {
        // Many concurrent tool-calls = bigger battle = upgrade to a powermove
        // so the user gets a more dramatic visual that matches the workload.
        // Probability raised to 0.85 (was 0.6) so the spectacular animation
        // fires reliably when 3+ tools are churning in parallel.
        //
        // After the powermove we also chain a fight — the sequence reads as
        // "power-up → battle" which is a better narrative than the powermove
        // just vanishing back to idle. The 150 ms slack lets the powermove
        // settle before the fight starts so the two don't visually collide.
        const rate = store.activityRate;
        if (rate > 0 && next >= 3 && Math.random() < Math.min(1, 0.85 * rate)) {
          store.triggerPowermove();
          window.setTimeout(() => {
            const s2 = usePetStore.getState();
            if (s2.isVisible) s2.triggerFight();
          }, POWERMOVE_DURATION_MS + 150);
        }
      }
    }
    runningToolCount = next;
  });

  onReconnectFinish((_attempt, outcome) => {
    if (outcome !== 'done') return;
    const store = usePetStore.getState();
    if (!store.isVisible) return;
    store.triggerPowermove();
    // Don't jumpTo(lastUserMid) here — it fights MessageList's autoscroll
    // watcher. When a stream finalizes through the reconnect path (silence
    // watchdog, StreamTimeoutError, or session-switch-back), the watcher's
    // segments subscriber already re-sticks to the bottom for at-bottom users
    // and stays put for scrolled-up users. Forcing scrollIntoView on the last
    // user message overrode both, producing the "sometimes jumps to parent
    // prompt at end of stream" behavior.
  });

  // Manifest-update broadcast → re-fetch from disk so the live pet picks
  // up sprite-editor edits, row replacements, and upgrade unlocks WITHOUT
  // requiring a hard reload. The event payload carries the petId; we only
  // refetch if it matches the active pet (avoids triggering reloads when
  // the user edits a non-active pet in the gallery).
  //
  // Dispatchers:
  //   - FrameNudgeModal.bumpLivePet() (sprite editor saves + apply-to-row)
  //   - hatchStore upgrade-finalize path (after uploadManifest)
  //   - Any future external editor that writes to /pets/<id>.json
  //
  // The `cache: 'no-cache'` + `?v=<ts>` cache-bust inside loadManifest()
  // guarantees the fresh manifest is fetched, not whatever the browser
  // remembers. The manifest's frame URLs themselves carry their own
  // `?nudge=<ts>` stamps from the editor, so individual sprite PNGs also
  // bypass the browser cache.
  window.addEventListener('yha:pet-manifest-updated', (e: Event) => {
    const detail = (e as CustomEvent<{ petId?: string }>).detail || {};
    const store = usePetStore.getState();
    const activeId = store.currentPet.id;
    // No petId in payload = "any pet I might have just edited" — accept it
    // and reload the active manifest. Mirrors the existing `loadManifest`
    // race-tolerance: extra refetches are cheap (304 from bridge no-cache).
    if (detail.petId && detail.petId !== activeId) return;
    void store.loadManifest(activeId);
  });

  // Apply persisted behind-UI state to body class on init so a reload
  // doesn't show the pet briefly in front before the user opens the
  // menu. Mirrors the setBehindUi() side-effect, idempotent.
  try {
    if (usePetStore.getState().behindUi) {
      document.body.classList.add('has-pet-behind-ui');
    }
  } catch { /* ignore */ }

  void usePetStore.getState().loadManifest(loadCurrentPet().id);
  recompute();
}
