// hatchStore — zustand state for the pet-hatching wizard.
//
// The wizard lives in <HatchModal> and walks the user through:
//   1. Describe the pet (name, archetype, free-form details, plan)
//   2. Generate the canonical-base reference (one Grok prompt → upload)
//   3. Generate each animation row as a strip (N Grok prompts → upload + slice)
//   4. Activate (write manifest, install via petStore)
//
// Closing and re-opening the modal must preserve progress, so the state
// lives in a store rather than React-local state.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  ARCHETYPES,
  PLANS,
  ROW_TO_MOOD,
  ROWS,
  buildManifest,
  chromaKeyBlob,
  claimOrphanedRows,
  fetchManifest,
  listPetFrames,
  mergeManifest,
  missingPlanRows,
  planRows,
  sliceStrip,
  slugifyId,
  specFromArchetype,
  uploadBase,
  uploadFrame,
  uploadManifest,
} from '../hatch/index.js';
import type {
  CharacterSpec,
  PlanName,
  RowName,
  RowSlot,
  YhaPetManifest,
} from '../hatch/index.js';
import { usePetStore } from './petStore.js';

export type HatchStep = 1 | 2 | 3 | 4;

export interface HatchState {
  open: boolean;
  step: HatchStep;
  petId: string;
  petName: string;
  archetypeId: string | null;
  spec: CharacterSpec;
  plan: PlanName;
  description: string;

  baseBlob: Blob | null;
  basePreviewUrl: string | null;
  baseUploaded: boolean;

  rows: Partial<Record<RowName, RowSlot>>;
  busy: boolean;
  error: string | null;
  finalizing: boolean;

  /**
   * Upgrade mode: when set, the wizard is editing an existing pet rather
   * than hatching a new one. Step 2 (canonical base) is skipped; Step 3
   * only shows rows missing from the existing manifest; Step 4 merges
   * the rebuilt manifest into the existing one.
   */
  upgradeMode: boolean;
  existingManifest: YhaPetManifest | null;

  /**
   * When openUpgrade is called with a specific row, the wizard scrolls to
   * that row's card in Step 3 and highlights it. Used by the nudge modal's
   * ghost-row "Generate" buttons so clicking a missing animation lands you
   * directly on its upload card. Cleared once the wizard is closed or the
   * user has navigated past Step 3.
   */
  targetRow: RowName | null;
}

export interface HatchActions {
  openWizard: () => void;
  openUpgrade: (petId: string, targetRow?: RowName) => Promise<void>;
  /** Clear the scroll-target row (called when the user moves past Step 3). */
  clearTargetRow: () => void;
  closeWizard: () => void;
  reset: () => void;
  setStep: (step: HatchStep) => void;
  setName: (name: string) => void;
  setArchetype: (id: string | null) => void;
  setSpecField: <K extends keyof CharacterSpec>(field: K, value: CharacterSpec[K]) => void;
  setPlan: (plan: PlanName) => void;
  setDescription: (text: string) => void;

  setBaseBlob: (blob: Blob | null) => Promise<void>;
  uploadBaseToBridge: () => Promise<void>;

  setRowStrip: (row: RowName, blob: Blob) => Promise<void>;
  replaceRowFrame: (row: RowName, frameIndex: number, blob: Blob) => Promise<void>;
  uploadRowFramesToBridge: (row: RowName) => Promise<void>;

  finalizeAndActivate: () => Promise<void>;
}

export type HatchStore = HatchState & HatchActions;

const DEFAULT_PLAN: PlanName = 'lite';

function emptyRows(): Partial<Record<RowName, RowSlot>> {
  return {};
}

function makeInitialSpec(): CharacterSpec {
  return specFromArchetype(null, '', '');
}

function buildInitialState(): HatchState {
  return {
    open: false,
    step: 1,
    petId: '',
    petName: '',
    archetypeId: null,
    spec: makeInitialSpec(),
    plan: DEFAULT_PLAN,
    description: '',
    baseBlob: null,
    basePreviewUrl: null,
    baseUploaded: false,
    rows: emptyRows(),
    busy: false,
    error: null,
    finalizing: false,
    upgradeMode: false,
    existingManifest: null,
    targetRow: null,
  };
}

function disposePreviewUrls(state: HatchState): void {
  if (state.basePreviewUrl) URL.revokeObjectURL(state.basePreviewUrl);
  for (const slot of Object.values(state.rows)) {
    if (!slot) continue;
    if (slot.stripPreviewUrl) URL.revokeObjectURL(slot.stripPreviewUrl);
    for (const url of slot.framePreviewUrls ?? []) URL.revokeObjectURL(url);
  }
}

export const useHatchStore = create<HatchStore>()(
  devtools(
    (set, get) => ({
      ...buildInitialState(),

      openWizard: () => set({ open: true }),

      openUpgrade: async (petId, targetRow) => {
        // Reset first so we don't carry over half-state from a prior hatch.
        disposePreviewUrls(get());
        set({ ...buildInitialState(), open: true, busy: true, error: null });
        try {
          const manifest = await fetchManifest(petId);
          // Re-derive spec: prefer manifest.hatch (new pets), fall back to a
          // blank spec keyed by the manifest name (old pets — user re-enters
          // archetype in Step 1).
          const persistedSpec = manifest.hatch?.spec;
          const persistedPlan = (manifest.hatch?.plan as PlanName | undefined) ?? DEFAULT_PLAN;
          const persistedArchetype = manifest.hatch?.archetypeId ?? null;
          const seededSpec: CharacterSpec = persistedSpec
            ? { ...persistedSpec, id: manifest.name, name: manifest.label }
            : specFromArchetype(null, manifest.name, manifest.label);

          // `missing` drives the initial-step decision: if the persisted plan
          // has gaps, land on step 3 (or step 1 if no spec), otherwise jump
          // straight to step 4 (confirm + activate).
          const missing = missingPlanRows(manifest, persistedPlan);
          // Pre-fill every row whose primary mood already exists in the
          // manifest, regardless of which plan it belongs to. This means
          // upgrading from lite → full only asks for rows the manifest
          // truly lacks — codex content and earlier uploads are not
          // re-requested even when the target plan is wider.
          const filledRows: Partial<Record<RowName, RowSlot>> = {};
          for (const entry of ROW_TO_MOOD) {
            if (manifest.poses?.[entry.primary]) {
              filledRows[entry.row] = { row: entry.row, uploaded: true };
            }
          }

          // Land on Step 1 if we don't have a persisted spec (user must pick
          // the archetype or fill slots) — otherwise jump straight to row
          // generation. If nothing is missing, jump to Step 4 to confirm.
          const initialStep: HatchStep = missing.length === 0
            ? 4
            : persistedSpec
              ? 3
              : 1;

          set({
            open: true,
            step: initialStep,
            petId: manifest.name,
            petName: manifest.label,
            archetypeId: persistedArchetype,
            spec: seededSpec,
            plan: persistedPlan,
            description: manifest.description ?? '',
            baseBlob: null,
            basePreviewUrl: null,
            baseUploaded: true, // existing pet already has a base
            rows: filledRows,
            busy: false,
            error: null,
            upgradeMode: true,
            existingManifest: manifest,
            // Forward the caller's target row so Step 3 can scroll to it.
            // Only set when the row is actually missing from the manifest —
            // otherwise scrolling would land on nothing.
            targetRow: targetRow && missing.includes(targetRow) ? targetRow : null,
          });
        } catch (e) {
          set({
            busy: false,
            error: `Could not load existing pet for upgrade: ${(e as Error).message}`,
          });
        }
      },

      closeWizard: () => set({ open: false, targetRow: null }),

      clearTargetRow: () => set({ targetRow: null }),

      reset: () => {
        disposePreviewUrls(get());
        set(buildInitialState());
      },

      setStep: (step) => set({ step }),

      setName: (name) => {
        const trimmed = name.trim();
        const id = slugifyId(trimmed);
        set((s) => ({
          petName: name,
          petId: id,
          spec: { ...s.spec, id, name: trimmed },
        }));
      },

      setArchetype: (id) => {
        const current = get();
        const seeded = specFromArchetype(id, current.petId, current.petName.trim());
        set({
          archetypeId: id,
          spec: {
            // Keep user-edited fields if they're non-empty, otherwise use the
            // archetype values. id/name always come from the wizard fields.
            ...seeded,
            styleNotes: current.spec.styleNotes || seeded.styleNotes,
          },
        });
      },

      setSpecField: (field, value) => {
        set((s) => ({ spec: { ...s.spec, [field]: value } }));
      },

      setPlan: (plan) => {
        if (!PLANS[plan]) return;
        set({ plan });
      },

      setDescription: (text) => set({ description: text }),

      // ── Step 2: canonical base ───────────────────────────────────────

      setBaseBlob: async (blob) => {
        const old = get().basePreviewUrl;
        if (old) URL.revokeObjectURL(old);
        if (!blob) {
          set({ baseBlob: null, basePreviewUrl: null, baseUploaded: false });
          return;
        }
        // Apply chroma-key client-side so the preview matches what petStore
        // ultimately renders.
        try {
          const keyed = await chromaKeyBlob(blob);
          const url = URL.createObjectURL(keyed);
          set({ baseBlob: keyed, basePreviewUrl: url, baseUploaded: false, error: null });
        } catch (e) {
          set({ error: `Chroma-key failed: ${(e as Error).message}` });
        }
      },

      uploadBaseToBridge: async () => {
        const { baseBlob, petId } = get();
        if (!baseBlob) {
          set({ error: 'No base image selected.' });
          return;
        }
        if (!petId) {
          set({ error: 'Pet id is empty — pick a name first.' });
          return;
        }
        set({ busy: true, error: null });
        try {
          await uploadBase(petId, baseBlob);
          set({ baseUploaded: true, busy: false });
        } catch (e) {
          set({ busy: false, error: (e as Error).message });
        }
      },

      // ── Step 3: row strips ────────────────────────────────────────────

      setRowStrip: async (row, blob) => {
        const def = ROWS[row];
        if (!def) {
          set({ error: `Unknown row: ${row}` });
          return;
        }
        set({ busy: true, error: null });
        try {
          // Slice the strip into individual cell blobs, then chroma-key each.
          const sliced = await sliceStrip(row, blob);
          const keyed: Blob[] = [];
          const urls: string[] = [];
          for (const cell of sliced) {
            const k = await chromaKeyBlob(cell);
            keyed.push(k);
            urls.push(URL.createObjectURL(k));
          }
          const previousUrls = get().rows[row]?.framePreviewUrls ?? [];
          for (const url of previousUrls) URL.revokeObjectURL(url);
          const previousStripUrl = get().rows[row]?.stripPreviewUrl;
          if (previousStripUrl) URL.revokeObjectURL(previousStripUrl);
          const stripUrl = URL.createObjectURL(blob);
          set((s) => ({
            busy: false,
            rows: {
              ...s.rows,
              [row]: {
                row,
                stripBlob: blob,
                stripPreviewUrl: stripUrl,
                frameBlobs: keyed,
                framePreviewUrls: urls,
                uploaded: false,
                frameOverrides: undefined,
              },
            },
          }));
        } catch (e) {
          set({ busy: false, error: (e as Error).message });
        }
      },

      replaceRowFrame: async (row, frameIndex, blob) => {
        const def = ROWS[row];
        if (!def || frameIndex < 1 || frameIndex > def.frames) {
          set({ error: `Invalid frame index ${frameIndex} for ${row}` });
          return;
        }
        set({ busy: true, error: null });
        try {
          const keyed = await chromaKeyBlob(blob);
          const newUrl = URL.createObjectURL(keyed);
          set((s) => {
            const slot = s.rows[row];
            if (!slot || !slot.frameBlobs || !slot.framePreviewUrls) {
              return { ...s, busy: false };
            }
            const oldUrl = slot.framePreviewUrls[frameIndex - 1];
            if (oldUrl) URL.revokeObjectURL(oldUrl);
            const blobs = slot.frameBlobs.slice();
            const urls = slot.framePreviewUrls.slice();
            blobs[frameIndex - 1] = keyed;
            urls[frameIndex - 1] = newUrl;
            return {
              busy: false,
              rows: {
                ...s.rows,
                [row]: {
                  ...slot,
                  frameBlobs: blobs,
                  framePreviewUrls: urls,
                  uploaded: false,
                },
              },
            };
          });
        } catch (e) {
          set({ busy: false, error: (e as Error).message });
        }
      },

      uploadRowFramesToBridge: async (row) => {
        const slot = get().rows[row];
        if (!slot?.frameBlobs?.length) {
          set({ error: `Row ${row} has no frames yet.` });
          return;
        }
        const { petId } = get();
        if (!petId) {
          set({ error: 'Pet id is empty.' });
          return;
        }
        set({ busy: true, error: null });
        try {
          for (let i = 0; i < slot.frameBlobs.length; i++) {
            const fname = `${row}-${String(i + 1).padStart(2, '0')}.png`;
            await uploadFrame(petId, fname, slot.frameBlobs[i]);
          }
          set((s) => ({
            busy: false,
            rows: { ...s.rows, [row]: { ...s.rows[row]!, uploaded: true } },
          }));
        } catch (e) {
          set({ busy: false, error: (e as Error).message });
        }
      },

      // ── Step 4: finalize ──────────────────────────────────────────────

      finalizeAndActivate: async () => {
        const state = get();
        const required = planRows(state.plan);
        for (const row of required) {
          const slot = state.rows[row];
          if (!slot?.uploaded) {
            set({ error: `Row "${row}" is not yet uploaded.` });
            return;
          }
        }
        if (!state.baseUploaded) {
          set({ error: 'Canonical base is not uploaded.' });
          return;
        }
        set({ finalizing: true, error: null });
        try {
          const rebuilt = buildManifest(
            state.spec,
            state.plan,
            state.description,
            state.archetypeId,
          );
          const merged =
            state.upgradeMode && state.existingManifest
              ? mergeManifest(state.existingManifest, rebuilt)
              : rebuilt;
          // Claim any rows already on disk but not yet referenced in the
          // merged manifest. Covers frames uploaded via nudge "Replace row"
          // or a previous upgrade that wrote PNGs without updating poses.
          const onDiskFiles = await listPetFrames(state.petId);
          const finalManifest = claimOrphanedRows(merged, onDiskFiles);
          await uploadManifest(finalManifest);
          // Tell petStore to use the new/upgraded pet immediately. We
          // ALSO broadcast so any open editor windows (FrameNudgeModal,
          // PetGalleryModal) that hold their own stale copies of the
          // manifest re-fetch from disk. Without the broadcast the live
          // pet was correct (installManifest above) but the editor grids
          // showed pre-upgrade frames until the user closed and re-opened
          // the modal — exact match for the "needs hard refresh" bug.
          usePetStore.getState().installManifest(finalManifest);
          try {
            window.dispatchEvent(new CustomEvent('yha:pet-manifest-updated', {
              detail: { petId: finalManifest.name },
            }));
          } catch { /* ignore */ }
          set({ finalizing: false });
        } catch (e) {
          set({ finalizing: false, error: (e as Error).message });
        }
      },
    }),
    { name: 'HatchStore' },
  ),
);

/** Convenience: rows the active plan needs the user to upload. */
export function planRowsFromStore(): RowName[] {
  return planRows(useHatchStore.getState().plan);
}

export { ARCHETYPES };
