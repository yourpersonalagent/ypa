// FrameNudgeModal — per-frame manual alignment editor.
//
// Opened from PetGalleryModal "✋ Nudge frames" → lists every frame in
// every animation row of the chosen pet. Each frame is shown on a small
// canvas with:
//   • a crosshair at the anchor point (center-X, ~93% down) so the user
//     can eyeball where the feet should be planted
//   • mouse drag to push the sprite content by (dx, dy) inside the cell
//   • a 🔍 zoom slider that scales the sprite content around the foot
//     anchor (so the sprite stays planted on the ground while it grows
//     or shrinks)
//   • save button to upload the edited PNG via the bridge upload route
//   • reset button to drop the in-progress edit
//   • ⇶ Apply to all in row — re-shifts/re-scales every other frame in
//     the same animation row by the SAME (dx, dy, scale) values, using
//     each sibling's existing on-disk pixels as the base. Lets the user
//     correct a row's overall positioning in one click and only tweak
//     per-frame deviations afterwards.
//
// The shift uses the same `shiftImageData` helper that powers the bulk
// `recalibrateFeet` flow; the zoom uses a sister `scaleImageData`
// helper. Both compose via `applyEdits()` (scale-then-shift). Pixels
// that fall off the canvas after either op are dropped — those were
// transparent by construction in normal hatched sprites.

import { create } from 'zustand';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ROWS,
  ROW_TO_MOOD,
  buildRowPose,
  buildStripPrompt,
  chromaKeyBlob,
  chromaKeyImageData,
  fetchImageData,
  fetchManifest,
  listPetFrames,
  imageDataToPngBlob,
  scaleImageData,
  shiftImageData,
  sliceStrip,
  suggestFilename,
  uploadFrame,
  uploadManifest,
} from './index.js';
import type { CharacterSpec, RowName, RowDefinition } from './types.js';
import { PromptCard } from './PromptCard.js';
import type { YhaPetManifest, ManifestPose } from './manifest.js';
import { usePetStore } from '../store/petStore.js';
import type { SpriteConfig, PetMood } from '../store/petStore.js';
import { ANIMATION_CATALOG, getAnimationCoverage, getMissingMoods } from '../animations.js';
import { useHatchStore } from '../store/hatchStore.js';

// ── Row-scale slider constants ─────────────────────────────────────────────
const ROW_SCALE_MIN = 0.5;
const ROW_SCALE_MAX = 2.0;
const ROW_SCALE_STEP = 0.05;

/**
 * Auto-calculate a per-row display scale that normalises the apparent
 * character height across all animation rows.
 *
 * Different strip grid layouts produce different cell heights:
 *   3×2 grid (idle, working, …) → 960/2 = 480 px per cell  ← reference
 *   3×3 grid (fighting)         → 960/3 = 320 px per cell  → needs 1.5×
 *
 * More grid rows = shorter cells = the character Grok drew is smaller in the
 * slice = it looks smaller in the game. We scale up to compensate.
 * Formula: layout.rows / 2  (the reference strips are 2 rows).
 */
function autoScaleForRow(rowName: string): number {
  const def = (ROWS as Record<string, RowDefinition | undefined>)[rowName];
  if (!def?.stripLayout) return 1;
  const raw = def.stripLayout.rows / 2;
  return Math.round(raw * 100) / 100;
}

interface NudgeState {
  open: boolean;
  petId: string | null;
  petLabel: string;
  manifest: YhaPetManifest | null;
  /** All animation-frame filenames found on disk for this pet.
   *  Superset of the manifest's referenced frames — includes rows
   *  that were uploaded but never assigned a manifest pose (orphaned). */
  allFrameFiles: string[];
  loading: boolean;
  error: string | null;
}

interface NudgeActions {
  openFor: (petId: string, petLabel: string) => Promise<void>;
  close: () => void;
  /**
   * Cache-bust every frame URL in the modal's local manifest whose path
   * (sans query string) matches one of `paths`. Without this, the row-grid
   * thumbnails keep showing the pre-edit pixels even after Save — because
   * the `<img src={f.src}>` URLs are unchanged and the browser serves its
   * cached copy. The companion update on petStore.currentPet.manifest (via
   * setSpriteConfig in FrameEditor) fixes the *live pet*; this fixes the
   * *modal grid* — and they need to stay in sync to avoid the user
   * thinking "save didn't work" after looking at the grid.
   */
  bumpFrames: (paths: Set<string>) => void;
}

/** Strip stale `?nudge=`/`?recal=`/`?row=`/`?v=` cache-busts from a URL
 *  before applying a fresh one, so the manifest doesn't accumulate
 *  layered timestamps over many saves. */
function bumpCacheKey(s: string, key: string): string {
  const [base, qs = ''] = s.split('?');
  const stripped = qs
    .split('&')
    .filter((p) => p && !p.startsWith('nudge=') && !p.startsWith('recal=') && !p.startsWith('row=') && !p.startsWith('v='))
    .join('&');
  return `${base}?${stripped ? `${stripped}&` : ''}${key}`;
}

export const useFrameNudgeStore = create<NudgeState & NudgeActions>((set) => ({
  open: false,
  petId: null,
  petLabel: '',
  manifest: null,
  allFrameFiles: [],
  loading: false,
  error: null,

  openFor: async (petId, petLabel) => {
    set({ open: true, petId, petLabel, manifest: null, allFrameFiles: [], loading: true, error: null });
    try {
      // Fetch manifest and file listing in parallel — the file listing lets us
      // show ALL uploaded rows in the grid, including any that were orphaned
      // (uploaded but not assigned a manifest pose, e.g. `jumping` in a full
      // plan where `waving` already claimed the `happy` mood slot).
      const [manifest, allFrameFiles] = await Promise.all([
        fetchManifest(petId),
        listPetFrames(petId),
      ]);
      set({ manifest, allFrameFiles, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
  close: () => set({ open: false, petId: null, manifest: null, allFrameFiles: [] }),

  bumpFrames: (paths) => {
    set((s) => {
      if (!s.manifest) return s;
      const v = `nudge=${Date.now()}`;
      const bump = (url: string): string => bumpCacheKey(url, v);
      let touched = false;
      const nextPoses: typeof s.manifest.poses = { ...s.manifest.poses };
      for (const [moodKey, pose] of Object.entries(s.manifest.poses) as [string, ManifestPose | undefined][]) {
        if (!pose) continue;
        const frames = pose.frames ?? [];
        const matches = frames.some((f) => paths.has(f.src.split('?')[0]));
        if (!matches) continue;
        touched = true;
        nextPoses[moodKey as keyof typeof nextPoses] = {
          ...pose,
          src: pose.src ? bump(pose.src) : pose.src,
          frames: frames.map((f) => ({ ...f, src: bump(f.src) })),
        };
      }
      if (!touched) return s;
      return { ...s, manifest: { ...s.manifest, poses: nextPoses } };
    });
  },
}));

export function FrameNudgeModal() {
  const open = useFrameNudgeStore((s) => s.open);
  if (!open) return null;
  return createPortal(<NudgeInner />, document.body);
}

interface RowGroup {
  row: string;
  /** Mood key this row maps to in the manifest, OR '⚠ orphaned' for rows with
   *  no ROW_TO_MOOD entry. Rows that ARE in ROW_TO_MOOD but missing from the
   *  active manifest carry their primary mood key and `claimable: true`. */
  mood: string;
  /** True when the row has files on disk but no pose in the active manifest.
   *  If the row has a known ROW_TO_MOOD entry the user can add it via
   *  "Add to manifest"; otherwise it is truly orphaned. */
  claimable: boolean;
  frames: { src: string; filename: string }[];
}

/**
 * Build the row-group list for the nudge grid.
 *
 * Two sources are merged:
 *   1. manifest.poses — frames that are actively used by the live pet.
 *   2. allFrameFiles  — every animation PNG on disk for this pet.
 *
 * Source 2 catches "orphaned" rows: frames that were uploaded during
 * hatching but never assigned a manifest pose because their primary mood
 * was already claimed by another row (e.g. `jumping` is orphaned in the
 * full plan when `waving` takes the `happy` slot). Without source 2, those
 * rows are invisible in the nudge UI and impossible to nudge/replace.
 *
 * Rows from the file listing are labelled with a ⚠ orphan flag so the
 * user can see at a glance that they're present on disk but not in use.
 */
function groupRows(manifest: YhaPetManifest, allFrameFiles: string[]): RowGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, RowGroup>();
  const petId = manifest.name;

  // ── Pass 1: manifest poses (used frames) ────────────────────────────────
  for (const [moodKey, pose] of Object.entries(manifest.poses || {}) as [string, ManifestPose | undefined][]) {
    if (!pose) continue;
    for (const f of pose.frames) {
      if (seen.has(f.src)) continue;
      seen.add(f.src);
      const m = f.src.match(/\/pets\/[^/]+\/([a-z][a-z0-9-]*)-\d+\.png$/i);
      const row = m ? m[1] : moodKey;
      const filename = f.src.split('/').pop()?.split('?')[0] || '';
      let group = groups.get(row);
      if (!group) {
        group = { row, mood: moodKey, claimable: false, frames: [] };
        groups.set(row, group);
      }
      group.frames.push({ src: f.src, filename });
    }
  }

  // ── Pass 2: on-disk files (may include orphaned/claimable rows) ─────────
  // Group by the row name extracted from filename ("idle-01.png" → "idle").
  // Skip files already covered by the manifest to avoid duplicates.
  //
  // "claimable" = the row has a ROW_TO_MOOD entry → there is a known primary
  //   mood; the user can add it to the manifest via "Add to manifest".
  // "truly orphaned" = no ROW_TO_MOOD entry → unlabelled extra files.
  const diskRows = new Map<string, string[]>(); // row → sorted filenames
  for (const filename of allFrameFiles) {
    const m = filename.match(/^([a-z][a-z0-9-]*)-\d{2}\.png$/i);
    if (!m) continue;
    const row = m[1];
    if (!diskRows.has(row)) diskRows.set(row, []);
    diskRows.get(row)!.push(filename);
  }
  for (const [row, filenames] of diskRows) {
    if (groups.has(row)) continue; // already covered by manifest pass
    const moodEntry = ROW_TO_MOOD.find((e) => e.row === row);
    const group: RowGroup = {
      row,
      mood: moodEntry ? moodEntry.primary : '⚠ orphaned',
      claimable: true,
      frames: [],
    };
    for (const filename of filenames.sort()) {
      const src = `/pets/${petId}/${filename}`;
      if (seen.has(src)) continue;
      seen.add(src);
      group.frames.push({ src, filename });
    }
    if (group.frames.length) groups.set(row, group);
  }

  return Array.from(groups.values()).sort((a, b) => a.row.localeCompare(b.row));
}

function NudgeInner() {
  const close = useFrameNudgeStore((s) => s.close);
  const petId = useFrameNudgeStore((s) => s.petId);
  const petLabel = useFrameNudgeStore((s) => s.petLabel);
  const manifest = useFrameNudgeStore((s) => s.manifest);
  const allFrameFiles = useFrameNudgeStore((s) => s.allFrameFiles);
  const loading = useFrameNudgeStore((s) => s.loading);
  const error = useFrameNudgeStore((s) => s.error);
  const [editing, setEditing] = useState<{
    row: string;
    src: string;
    filename: string;
    siblings: { src: string; filename: string }[];
  } | null>(null);
  const [rowReplaceStatus, setRowReplaceStatus] = useState<Record<string, string>>({});
  /** Which row's "🔁 Replace row…" PromptCard panel is currently expanded.
   *  Only one row open at a time keeps the modal compact and obvious. */
  const [replaceOpenRow, setReplaceOpenRow] = useState<string | null>(null);
  /** Object-URL preview of the most recently dropped strip per row, so the
   *  PromptCard shows a thumbnail after drop while the slice/upload runs. */
  const [replacePreview, setReplacePreview] = useState<Record<string, string>>({});
  /** Per-row display scale (live slider value — may differ from saved manifest). */
  const [rowScales, setRowScales] = useState<Record<string, number>>({});
  /** Brief status labels shown after each per-row scale save ("saved ✓" / error). */
  const [scaleSaveStatus, setScaleSaveStatus] = useState<Record<string, string>>({});
  /** Status per-row for the "Add to manifest" claim action. */
  const [claimStatus, setClaimStatus] = useState<Record<string, string>>({});
  /** The strip image currently loaded for the re-import panel. Shared across
   *  frame navigations (keyed on `editing.src`) so the user doesn't need to
   *  re-drop the same strip sheet for every individual frame. Cleared when the
   *  user explicitly clicks "Change strip" inside the panel. */
  const [reimportStrip, setReimportStrip] = useState<HTMLImageElement | null>(null);
  const setSpriteConfig = usePetStore((s) => s.setSpriteConfig);
  const currentPet = usePetStore((s) => s.currentPet);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (editing) setEditing(null);
        else close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, editing]);

  // Re-fetch the local manifest copy whenever ANY component reports a
  // manifest update for the pet we're editing. Triggered after upgrade
  // finalize, after row-replace, after sprite-editor save. The petStore
  // already has its own listener that refreshes the live pet's copy; we
  // have a second store (`useFrameNudgeStore`) for the modal's grid
  // because the modal can be opened on a non-active pet (manage-gallery
  // flow).
  useEffect(() => {
    if (!petId) return;
    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent<{ petId?: string }>).detail || {};
      if (detail.petId && detail.petId !== petId) return;
      // Don't reset state.open / editing — just swap the manifest under
      // them so thumbnails refresh transparently. openFor handles the
      // load + state set.
      void useFrameNudgeStore.getState().openFor(petId, petLabel);
    };
    window.addEventListener('yha:pet-manifest-updated', onUpdate);
    return () => window.removeEventListener('yha:pet-manifest-updated', onUpdate);
  }, [petId, petLabel]);

  const rows = useMemo(
    () => (manifest ? groupRows(manifest, allFrameFiles) : []),
    [manifest, allFrameFiles],
  );

  // Sync rowScales from the manifest whenever the manifest (re-)loads.
  // Runs after groupRows so we can look up the mood by row name.
  useEffect(() => {
    if (!manifest) return;
    setRowScales((prev) => {
      const next: Record<string, number> = {};
      for (const g of rows) {
        if (g.mood.startsWith('⚠')) continue;
        const pose = manifest.poses[g.mood as PetMood];
        // Preserve an in-progress slider drag if the user is currently editing
        // that row — the manifest re-fetch from another concurrent save shouldn't
        // snap the slider back. Fall back to the manifest's persisted value.
        next[g.row] = prev[g.row] !== undefined ? prev[g.row] : (pose?.scale ?? 1);
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  /**
   * Instantly push a scale change to the live pet (no disk write) so the user
   * can see the effect while still dragging the slider.
   */
  function previewRowScale(rowName: string, scale: number) {
    if (!petId || currentPet.id !== petId) return;
    const liveManifest = useFrameNudgeStore.getState().manifest;
    if (!liveManifest) return;
    const group = rows.find((g) => g.row === rowName);
    if (!group || group.mood.startsWith('⚠')) return;
    const mood = group.mood as PetMood;
    const pose = liveManifest.poses[mood];
    if (!pose) return;
    setSpriteConfig(mood, { ...pose, scale } as SpriteConfig);
  }

  /**
   * Persist the per-row scale into the manifest JSON on disk and update both
   * the nudge store (modal thumbnails) and the live petStore (live pet).
   * Called on slider release (onPointerUp).
   */
  async function saveRowScale(rowName: string, scale: number) {
    if (!petId) return;
    const liveManifest = useFrameNudgeStore.getState().manifest;
    if (!liveManifest) return;
    const group = rows.find((g) => g.row === rowName);
    if (!group || group.mood.startsWith('⚠')) return;
    const mood = group.mood as PetMood;
    const pose = liveManifest.poses[mood];
    if (!pose) return;

    const cleanScale = scale === 1 ? undefined : scale;
    const updatedPose: ManifestPose = { ...pose, scale: cleanScale };
    const nextManifest: YhaPetManifest = {
      ...liveManifest,
      poses: { ...liveManifest.poses, [mood]: updatedPose },
    };

    // Update the modal's local manifest copy so the slider stays in sync.
    useFrameNudgeStore.setState({ manifest: nextManifest });

    // Push to the live pet immediately (in case preview wasn't called).
    if (currentPet.id === petId) {
      setSpriteConfig(mood, updatedPose as SpriteConfig);
    }

    // Persist to disk.
    try {
      await uploadManifest(nextManifest as unknown as Parameters<typeof uploadManifest>[0]);
      setScaleSaveStatus((prev) => ({ ...prev, [rowName]: 'saved ✓' }));
      window.setTimeout(() => {
        setScaleSaveStatus((prev) => {
          const next = { ...prev };
          delete next[rowName];
          return next;
        });
      }, 2000);
    } catch (e) {
      setScaleSaveStatus((prev) => ({ ...prev, [rowName]: `failed: ${(e as Error).message}` }));
    }
  }

  /**
   * Claim an orphaned row into the manifest. Looks up the ROW_TO_MOOD entry
   * for `rowName`, builds a ManifestPose from the already-uploaded frames on
   * disk, patches the manifest, saves to disk, and fires an update event so
   * the live pet and the modal grid both refresh to show the row as active.
   */
  async function handleClaimRow(rowName: string) {
    if (!petId || !manifest) return;
    const setStatus = (msg: string) =>
      setClaimStatus((s) => ({ ...s, [rowName]: msg }));
    setStatus('adding…');
    try {
      const pose = buildRowPose(petId, rowName as RowName, petLabel);
      if (!pose) throw new Error(`No ROW_TO_MOOD entry for row "${rowName}"`);
      const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
      if (!entry) throw new Error(`No mood entry for row "${rowName}"`);
      const updated: YhaPetManifest = {
        ...manifest,
        poses: { ...manifest.poses, [entry.primary]: pose },
      };
      await uploadManifest(updated);
      window.dispatchEvent(new CustomEvent('yha:pet-manifest-updated', {
        detail: { petId },
      }));
      setStatus('added ✓');
      window.setTimeout(
        () => setClaimStatus((s) => { const n = { ...s }; delete n[rowName]; return n; }),
        3000,
      );
    } catch (e) {
      setStatus(`failed: ${(e as Error).message}`);
    }
  }

  /**
   * Handle a row-level replacement. Accepts EITHER a single strip-sheet PNG
   * (which we slice via `sliceStrip` according to the row's stripLayout) OR
   * N individual PNGs (one per cell, in alphabetical order — must match the
   * frame count of the row exactly).
   *
   * In both cases we chroma-key the input(s) so a magenta background
   * vanishes, then upload over the existing files via the same persistence
   * route the wizard uses. Live pet picks the change up via cache-bust
   * (?row=<ts>) so the user can verify without page reload.
   *
   * `inputs` is a unified Blob[] — callers can pass a single strip as `[blob]`
   * or all N pre-sliced cells as `[...frames]`. (The legacy FileList path
   * goes through this function as well, see `handleRowReplaceFromFiles`.)
   */
  async function handleRowReplace(rowName: string, inputs: Blob[]) {
    if (!inputs.length || !petId) return;
    const setStatus = (msg: string) =>
      setRowReplaceStatus((s) => ({ ...s, [rowName]: msg }));
    setStatus('reading…');

    try {
      const expectedFrames = ROWS[rowName as RowName]?.frames;
      if (!expectedFrames) throw new Error(`Unknown animation row: ${rowName}`);

      // Decide between strip vs. N-frame mode based on file count.
      let blobs: Blob[];
      if (inputs.length === 1) {
        setStatus('slicing strip…');
        blobs = await sliceStrip(rowName as RowName, inputs[0]);
      } else {
        if (inputs.length !== expectedFrames) {
          throw new Error(
            `Selected ${inputs.length} files but row "${rowName}" needs ${expectedFrames}. `
            + 'Either drop one strip sheet OR exactly one PNG per cell.',
          );
        }
        blobs = inputs;
      }

      setStatus('chroma-keying…');
      const keyed = await Promise.all(blobs.map((b) => chromaKeyBlob(b)));

      // Upload as <row>-NN.png to overwrite the existing files. Filenames
      // mirror manifest.ts → buildPose().
      for (let i = 0; i < keyed.length; i++) {
        setStatus(`uploading ${i + 1}/${keyed.length}…`);
        const filename = `${rowName}-${String(i + 1).padStart(2, '0')}.png`;
        await uploadFrame(petId, filename, keyed[i]);
      }

      // If the manifest doesn't already reference this row with new-style
      // (-NN.png) paths, claim it now. This handles codex-imported pets whose
      // manifest still pointed to old _f0N.png paths, and truly new rows that
      // were never in the manifest at all. The updated manifest must land on
      // disk before the broadcast below triggers a re-fetch.
      {
        const latestManifest = useFrameNudgeStore.getState().manifest;
        if (latestManifest) {
          const entry = ROW_TO_MOOD.find((e) => e.row === rowName);
          if (entry) {
            const existingPose = latestManifest.poses[entry.primary as PetMood];
            const alreadyMapped = existingPose?.frames.some(
              (f) => f.src.split('?')[0].includes(`/${rowName}-`),
            );
            if (!alreadyMapped) {
              const newPose = buildRowPose(petId, rowName as RowName, petLabel);
              if (newPose) {
                const nextManifest: YhaPetManifest = {
                  ...latestManifest,
                  poses: { ...latestManifest.poses, [entry.primary]: newPose },
                };
                useFrameNudgeStore.setState({ manifest: nextManifest });
                await uploadManifest(nextManifest);
                if (currentPet.id === petId) {
                  setSpriteConfig(
                    entry.primary as Parameters<typeof setSpriteConfig>[0],
                    newPose as SpriteConfig,
                  );
                }
              }
            }
          }
        }
      }

      // Cache-bust the live pet so the new frames show up without reload.
      if (currentPet.id === petId && currentPet.manifest) {
        const v = `row=${Date.now()}`;
        const bumpUrl = (s: string): string => {
          const [base, qs = ''] = s.split('?');
          const stripped = qs
            .split('&')
            .filter((p) => p && !p.startsWith('row=') && !p.startsWith('nudge=') && !p.startsWith('recal='))
            .join('&');
          return `${base}?${stripped ? `${stripped}&` : ''}${v}`;
        };
        for (const [moodKey, pose] of Object.entries(currentPet.manifest.poses)) {
          if (!pose) continue;
          const frames = pose.frames ?? [];
          const matches = frames.some((f) => f.src.includes(`/${rowName}-`));
          if (!matches) continue;
          setSpriteConfig(moodKey as Parameters<typeof setSpriteConfig>[0], {
            ...pose,
            src: pose.src ? bumpUrl(pose.src) : pose.src,
            frames: frames.map((f) => ({ ...f, src: bumpUrl(f.src) })),
          });
        }
      }

      // Broadcast so petStore (and other editor instances) re-fetch the
      // on-disk manifest. Without this, replacing a row would update the
      // sprite frames on disk but the in-memory manifest in petStore
      // would keep the old `?row=…` cache-bust until next page load.
      try {
        window.dispatchEvent(new CustomEvent('yha:pet-manifest-updated', {
          detail: { petId },
        }));
      } catch { /* ignore */ }

      setStatus(`replaced ${keyed.length} frame${keyed.length > 1 ? 's' : ''}`);
      window.setTimeout(
        () => setRowReplaceStatus((s) => {
          const next = { ...s };
          delete next[rowName];
          return next;
        }),
        4500,
      );
    } catch (e) {
      setStatus(`failed: ${(e as Error).message}`);
    }
  }

  /** Step through the frame strip while staying in editor view.
   *  `FrameEditor` is keyed by `editing.src`, so changing src fully resets
   *  all in-progress dx/dy/zoom — the user navigates to a fresh state for
   *  each frame, same as clicking a thumbnail in the grid. */
  function navigateFrame(offset: -1 | 1) {
    setEditing((e) => {
      if (!e) return e;
      const idx = e.siblings.findIndex((s) => s.src === e.src);
      const next = idx + offset;
      if (next < 0 || next >= e.siblings.length) return e;
      const f = e.siblings[next];
      return { ...e, src: f.src, filename: f.filename };
    });
  }

  return (
    <div className="hatch-backdrop" role="dialog" aria-modal="true" aria-label="Nudge sprite frames">
      <div className="hatch-modal">
        <header className="hatch-head">
          <strong>✋ Nudge frames — {petLabel}</strong>
          <span className="hatch-sub">
            Click a frame to nudge it. Drag the sprite to shift. Saves overwrite the PNG on disk.
          </span>
          {/* Coverage indicator (same data as the chip grid in the pet menu).
              Surfaces "N/M animations · missing: …" so the user can see at a
              glance whether this pet is missing canonical rows. The Codex 9 +
              YHA-extras targets come from the animation catalog. */}
          {manifest ? (() => {
            const coverage = getAnimationCoverage(manifest as unknown as Parameters<typeof getAnimationCoverage>[0]);
            return (
              <div className={'nudge-coverage' + (coverage.fullCodexCoverage ? ' is-full' : ' is-partial')}>
                <span className="nudge-coverage-label">Coverage</span>
                <span className="nudge-coverage-count">{coverage.present}/{coverage.total}</span>
                {coverage.missing.length > 0 ? (
                  <span className="nudge-coverage-missing">
                    missing: {coverage.missing.join(', ')}
                  </span>
                ) : (
                  <span className="nudge-coverage-complete">complete — Codex 9 + YHA-extras</span>
                )}
              </div>
            );
          })() : null}
          <div className="hatch-head-actions">
            {editing ? (
              <button className="hatch-btn-ghost" onClick={() => setEditing(null)}>← Back to grid</button>
            ) : null}
            <button className="hatch-btn-ghost" onClick={close}>Close</button>
          </div>
        </header>
        <main className="hatch-body">
          {loading ? <div className="hatch-intro">Loading manifest…</div> : null}
          {error ? <div className="hatch-error">{error}</div> : null}
          {!loading && !rows.length ? (
            <div className="hatch-intro">No frames found.</div>
          ) : null}

          {!editing ? (
            <div className="nudge-row-list">
              {rows.map((g) => {
                const layout = ROWS[g.row as RowName]?.stripLayout;
                const hint = layout
                  ? `Drop the regenerated ${layout.cols}×${layout.rows} strip sheet here.`
                  : 'Drop the regenerated strip sheet here.';
                const isReplaceOpen = replaceOpenRow === g.row;
                // Pull the spec stored at hatch time so we can rebuild the same
                // strip prompt the original creation flow showed. Older pets
                // (hatched before `manifest.hatch` existed) won't have it; we
                // fall back to a generic note in the panel below.
                const storedSpec: CharacterSpec | null =
                  manifest?.hatch?.spec ?? null;
                const stripPrompt = storedSpec
                  ? buildStripPrompt(storedSpec, g.row as RowName)
                  : '';
                return (
                  <section key={g.row} className="nudge-row">
                    <div className="nudge-row-head">
                      <h4>
                        {(() => {
                          // Decorate the row header from the animation catalog
                          // when the mood is one of ours (glyph + origin badge).
                          // Orphaned/unknown moods get neither — we don't know
                          // what to show. Both surfaces (chip grid in pet menu
                          // + nudge modal here) read the same catalog so the
                          // glyph for "streaming" is the same everywhere.
                          const catalogEntry =
                            g.mood !== '⚠ orphaned' && g.mood in ANIMATION_CATALOG
                              ? ANIMATION_CATALOG[g.mood as PetMood]
                              : null;
                          return (
                            <>
                              {catalogEntry && (
                                <span className="nudge-row-glyph" aria-hidden="true">{catalogEntry.glyph}</span>
                              )}
                              {g.row}
                              {catalogEntry && (
                                <span
                                  className={
                                    'nudge-row-origin '
                                    + (catalogEntry.origin === 'codex' ? 'is-codex' : 'is-yha-extra')
                                  }
                                  title={
                                    catalogEntry.origin === 'codex'
                                      ? 'Part of the canonical Codex 9-row vocabulary.'
                                      : 'YHA-extra row, beyond the Codex 9 canonical animations.'
                                  }
                                >
                                  {catalogEntry.origin === 'codex' ? 'Codex' : 'Extra'}
                                </span>
                              )}
                            </>
                          );
                        })()}
                        {g.claimable && g.mood !== '⚠ orphaned' ? (
                          // Row exists on disk and has a known ROW_TO_MOOD entry
                          // but is missing from the manifest. Offer one-click claim.
                          <span className="nudge-row-orphan nudge-row-claimable" title={`On disk but not in manifest — maps to mood "${g.mood}". Click "+ Add" to register it.`}>
                            {' '}↳ mood: {g.mood}
                          </span>
                        ) : g.mood === '⚠ orphaned' ? (
                          <span className="nudge-row-orphan" title="Uploaded but has no known mood mapping — cannot be claimed automatically.">
                            {' '}⚠ not in manifest
                          </span>
                        ) : null}
                      </h4>
                      <div className="nudge-row-head-actions">
                        {g.claimable && g.mood !== '⚠ orphaned' ? (
                          <button
                            type="button"
                            className="hatch-btn-ghost nudge-claim-btn"
                            title={`Add "${g.row}" to manifest as mood "${g.mood}"`}
                            disabled={Boolean(claimStatus[g.row])}
                            onClick={() => void handleClaimRow(g.row)}
                          >
                            {claimStatus[g.row] ?? '+ Add to manifest'}
                          </button>
                        ) : null}
                        <div className="nudge-row-replace">
                          <button
                            type="button"
                            className="hatch-btn-ghost"
                            aria-expanded={isReplaceOpen}
                            title={hint}
                            onClick={() => {
                              setReplaceOpenRow((prev) => (prev === g.row ? null : g.row));
                            }}
                          >
                            {isReplaceOpen ? '▾ 🔁 Replace row' : '🔁 Replace row…'}
                          </button>
                          {rowReplaceStatus[g.row] ? (
                            <span className="nudge-row-replace-status">
                              {rowReplaceStatus[g.row]}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {isReplaceOpen ? (
                      <div className="nudge-row-replace-panel">
                        {storedSpec ? (
                          <PromptCard
                            prompt={stripPrompt}
                            suggestedFilename={suggestFilename(g.row as RowName)}
                            accepted={Boolean(replacePreview[g.row])}
                            previewUrl={replacePreview[g.row] ?? null}
                            onFile={(blob) => {
                              // Show an instant thumbnail so the user knows the
                              // drop landed; the slice/upload pipeline runs in
                              // parallel and surfaces progress via rowReplaceStatus.
                              setReplacePreview((prev) => {
                                const old = prev[g.row];
                                if (old) URL.revokeObjectURL(old);
                                return { ...prev, [g.row]: URL.createObjectURL(blob) };
                              });
                              void handleRowReplace(g.row, [blob]);
                            }}
                            onClear={() => {
                              setReplacePreview((prev) => {
                                if (prev[g.row]) URL.revokeObjectURL(prev[g.row]);
                                const next = { ...prev };
                                delete next[g.row];
                                return next;
                              });
                            }}
                            dense
                          />
                        ) : (
                          <div className="hatch-prompt-card is-dense">
                            <p className="hatch-drop-hint">
                              This pet was hatched before the wizard saved its
                              creation prompt. Drop a freshly-generated strip
                              sheet below — it will be sliced, chroma-keyed and
                              uploaded over the existing frames.
                            </p>
                            <PromptCard
                              prompt={`Generate a ${layout?.cols ?? '?'}×${layout?.rows ?? '?'} strip sheet for the "${g.row}" animation, matching this pet's existing visual style.`}
                              suggestedFilename={suggestFilename(g.row as RowName)}
                              accepted={Boolean(replacePreview[g.row])}
                              previewUrl={replacePreview[g.row] ?? null}
                              onFile={(blob) => {
                                setReplacePreview((prev) => {
                                  const old = prev[g.row];
                                  if (old) URL.revokeObjectURL(old);
                                  return { ...prev, [g.row]: URL.createObjectURL(blob) };
                                });
                                void handleRowReplace(g.row, [blob]);
                              }}
                              onClear={() => {
                                setReplacePreview((prev) => {
                                  if (prev[g.row]) URL.revokeObjectURL(prev[g.row]);
                                  const next = { ...prev };
                                  delete next[g.row];
                                  return next;
                                });
                              }}
                              dense
                            />
                          </div>
                        )}
                      </div>
                    ) : null}
                    {/* Per-row display-scale control — only for rows that are
                        active in the manifest OR claimable (about to be added).
                        Truly orphaned rows with no mood mapping are skipped. */}
                    {!g.claimable || g.mood !== '⚠ orphaned' ? (
                      <div className="nudge-row-scale">
                        <span className="nudge-row-scale-label">🔍 Scale</span>
                        <input
                          type="range"
                          min={ROW_SCALE_MIN}
                          max={ROW_SCALE_MAX}
                          step={ROW_SCALE_STEP}
                          value={rowScales[g.row] ?? 1}
                          className="nudge-row-scale-slider"
                          aria-label={`Row display scale for ${g.row}`}
                          onChange={(e) => {
                            const v = Number(e.currentTarget.value);
                            setRowScales((prev) => ({ ...prev, [g.row]: v }));
                            previewRowScale(g.row, v);
                          }}
                          onPointerUp={(e) => {
                            const v = Number(e.currentTarget.value);
                            void saveRowScale(g.row, v);
                          }}
                        />
                        <span className="nudge-row-scale-value">
                          ×{(rowScales[g.row] ?? 1).toFixed(2)}
                        </span>
                        <button
                          type="button"
                          className="hatch-btn-ghost nudge-row-scale-auto"
                          title={`Auto-calculate from strip layout (${ROWS[g.row as RowName]?.stripLayout?.cols ?? '?'}×${ROWS[g.row as RowName]?.stripLayout?.rows ?? '?'} grid)`}
                          onClick={() => {
                            const auto = autoScaleForRow(g.row);
                            setRowScales((prev) => ({ ...prev, [g.row]: auto }));
                            previewRowScale(g.row, auto);
                            void saveRowScale(g.row, auto);
                          }}
                        >
                          ⟳ auto
                        </button>
                        {scaleSaveStatus[g.row] ? (
                          <span className="nudge-row-scale-status">{scaleSaveStatus[g.row]}</span>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="nudge-frame-grid">
                      {g.frames.map((f) => (
                        <button
                          key={f.src}
                          className="nudge-frame-thumb"
                          onClick={() => setEditing({
                            row: g.row,
                            src: f.src,
                            filename: f.filename,
                            // Pass every frame in this row (including the
                            // active one) — the editor filters out the
                            // current src when running "apply to all".
                            siblings: g.frames.map((x) => ({ src: x.src, filename: x.filename })),
                          })}
                          title={f.filename}
                        >
                          <img src={f.src} alt={f.filename} draggable={false} />
                          <span>{f.filename}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                );
              })}
              {/* Ghost-row cards for catalog moods this pet doesn't ship yet.
                  Reads the same catalog as the chip grid + coverage hint so
                  every "what's missing" surface stays in sync. The Generate
                  button hands off to the hatch wizard, which knows how to
                  generate one row at a time (missingPlanRows resolution). */}
              {manifest ? (() => {
                const missing = getMissingMoods(manifest as unknown as Parameters<typeof getMissingMoods>[0]);
                if (missing.length === 0) return null;
                return (
                  <section className="nudge-missing">
                    <header className="nudge-missing-head">
                      <h4>Missing animations</h4>
                      <span className="nudge-missing-sub">
                        Catalog moods this pet doesn't ship yet — generate them via the hatch wizard.
                      </span>
                    </header>
                    <div className="nudge-missing-grid">
                      {missing.map((mood) => {
                        const entry = ANIMATION_CATALOG[mood];
                        // A mood has a dedicated row when there's a
                        // ROW_TO_MOOD entry with primary === mood. Moods
                        // that only exist as aliases (e.g. `reconnecting`
                        // is an alias of the `thinking` row) can't be
                        // generated directly — the user generates the
                        // source row and the alias is covered for free.
                        const rowEntry = ROW_TO_MOOD.find((e) => e.primary === mood);
                        const aliasSource = !rowEntry
                          ? ROW_TO_MOOD.find((e) => e.alias?.includes(mood as PetMood))
                          : null;
                        return (
                          <div
                            key={mood}
                            className={
                              'nudge-missing-card '
                              + (entry.origin === 'codex' ? 'is-codex' : 'is-yha-extra')
                            }
                            title={
                              entry.origin === 'codex'
                                ? `${mood} — part of the canonical Codex 9. Add via the hatch wizard.`
                                : `${mood} — YHA-extra row. Add via the hatch wizard.`
                            }
                          >
                            <span className="nudge-missing-glyph" aria-hidden="true">{entry.glyph}</span>
                            <span className="nudge-missing-name">{mood}</span>
                            <span
                              className={
                                'nudge-row-origin '
                                + (entry.origin === 'codex' ? 'is-codex' : 'is-yha-extra')
                              }
                            >
                              {entry.origin === 'codex' ? 'Codex' : 'Extra'}
                            </span>
                            {rowEntry ? (
                              <button
                                type="button"
                                className="hatch-btn-ghost nudge-missing-generate"
                                title={`Open the hatch wizard scrolled to the "${rowEntry.row}" row card.`}
                                onClick={() => {
                                  close();
                                  void useHatchStore.getState().openUpgrade(petId || '', rowEntry.row);
                                }}
                              >
                                ↻ Generate
                              </button>
                            ) : aliasSource ? (
                              <span
                                className="nudge-missing-alias"
                                title={`This mood is covered by the "${aliasSource.row}" row — generate that to fill ${mood} for free.`}
                              >
                                covered by {aliasSource.row}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })() : null}
            </div>
          ) : (
            <FrameEditor
              key={editing.src}
              petId={petId || ''}
              row={editing.row}
              src={editing.src}
              filename={editing.filename}
              siblings={editing.siblings}
              frameIndex={editing.siblings.findIndex((s) => s.src === editing.src)}
              frameCount={editing.siblings.length}
              onPrev={() => navigateFrame(-1)}
              onNext={() => navigateFrame(1)}
              onDone={() => setEditing(null)}
              strip={reimportStrip}
              onStripLoad={setReimportStrip}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// Note: the per-row "🔁 Replace row…" UI used to be a separate
// `RowReplaceButton` (hidden file input + label button). It now lives inline
// in the row head as a toggle that expands a `PromptCard` panel — same UX
// as the original creation flow in `HatchModal`. See `nudge-row-replace`
// + `nudge-row-replace-panel` blocks above.

interface FrameEditorProps {
  petId: string;
  row: string;
  src: string;
  filename: string;
  siblings: { src: string; filename: string }[];
  /** 0-based index of the current frame within `siblings`. */
  frameIndex: number;
  /** Total number of frames in this row (= siblings.length). */
  frameCount: number;
  /** Navigate to the previous frame in the row (no-op when at index 0). */
  onPrev: () => void;
  /** Navigate to the next frame in the row (no-op when at last index). */
  onNext: () => void;
  onDone: () => void;
  /** The original strip image currently loaded in this editing session.
   *  Persisted in the parent (NudgeInner) so it survives frame navigation.
   *  Null until the user first drops/picks a strip file. */
  strip: HTMLImageElement | null;
  /** Called when the user loads a new strip (or clears it). */
  onStripLoad: (img: HTMLImageElement | null) => void;
}

const EDITOR_DISPLAY = 480; // px on screen — sprites are 240×480 cells (or 320×320 for fighting)

// Zoom slider range. 100 % = native size. We allow shrinking down to 30 %
// (often useful for oversized hatched pets) and growth up to 200 %
// (rarely useful — content gets clipped at the canvas edge — but lets the
// user emphasise a single dramatic frame). Step in 1 % increments so the
// keyboard arrows feel precise; the slider rounds to integers internally.
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.01;

/** Apply the user's edits to a base ImageData. Order is intentional:
 *  scale around the foot anchor first (so the sprite stays planted),
 *  THEN apply the (dx, dy) drag offset. The reverse order would move
 *  the anchor, which makes the slider feel chaotic. */
function applyEdits(
  image: ImageData,
  scale: number,
  dx: number,
  dy: number,
): ImageData {
  const anchorX = image.width / 2;
  const anchorY = Math.round(image.height * 0.93);
  let out = image;
  if (scale !== 1) out = scaleImageData(out, scale, anchorX, anchorY);
  if (dx !== 0 || dy !== 0) out = shiftImageData(out, dx, dy);
  return out;
}

function FrameEditor({ petId, row, src, filename, siblings, frameIndex, frameCount, onPrev, onNext, onDone, strip, onStripLoad }: FrameEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [image, setImage] = useState<ImageData | null>(null);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [scale, setScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Whether the re-import-from-strip sub-panel is visible. Collapses on
   *  frame navigation (FrameEditor is keyed by src) — the loaded strip
   *  itself persists in the parent so the user only drops it once. */
  const [showReimport, setShowReimport] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startDx: number; startDy: number } | null>(null);
  /** Cancellation token for the mount-time fetchImageData call.  When
   *  onImported fires (from the reimport panel), we cancel any still-running
   *  mount fetch so it cannot overwrite the freshly-sliced imageData with the
   *  stale on-disk pixels that were current when the editor first opened. */
  const fetchTokenRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const setSpriteConfig = usePetStore((s) => s.setSpriteConfig);
  const currentPet = usePetStore((s) => s.currentPet);

  useEffect(() => {
    setError(null);
    setStatus(null);
    setDx(0);
    setDy(0);
    setScale(1);
    const token = { cancelled: false };
    fetchTokenRef.current = token;
    fetchImageData(src)
      .then((img) => { if (!token.cancelled) setImage(img); })
      .catch((e: Error) => { if (!token.cancelled) setError(e.message); });
    return () => { token.cancelled = true; };
  }, [src]);

  // Re-render the canvas any time dx/dy/scale/image change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dirty = dx !== 0 || dy !== 0 || scale !== 1;
    if (!dirty) {
      ctx.putImageData(image, 0, 0);
    } else {
      ctx.putImageData(applyEdits(image, scale, dx, dy), 0, 0);
    }
  }, [image, dx, dy, scale]);

  // ← / → arrow-key navigation between frames in this row.
  // We skip the shortcut when a range input is focused so the zoom slider
  // still receives its own arrow-key increments.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') return;
      if (busy) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); onPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); onNext(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onPrev, onNext, busy]);

  function startDrag(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startDx: dx, startDy: dy };
  }
  function onDrag(e: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag || !image) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Convert screen-px movement into image-px (canvas is scaled to fit).
    // Local name avoids shadowing the outer `scale` state.
    const pxRatio = image.width / rect.width;
    setDx(Math.round(drag.startDx + (e.clientX - drag.startX) * pxRatio));
    setDy(Math.round(drag.startDy + (e.clientY - drag.startY) * pxRatio));
  }
  function endDrag(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  }

  /** Cache-bust every pose in the active pet's manifest whose frame
   *  paths match `paths`. Stamps a fresh `nudge=<ts>` query so the
   *  FloatingPet picks the file change up without a reload, AND also
   *  persists the bumped manifest to /pets/<id>.json so a subsequent
   *  page-load doesn't fall back to the previously-cached pixels.
   *
   *  Why we persist: express.static doesn't set Cache-Control on PNG
   *  files, so the browser's heuristic-freshness window can serve a
   *  stale image even after we've overwritten it on disk. The query
   *  cache-bust beats the heuristic, and persisting it into the on-disk
   *  manifest is what makes the bust survive a hard reload — the next
   *  `loadManifest()` returns URLs that still carry a unique nudge=…
   *  stamp (the freshest one), so the browser fetches fresh.
   *
   *  Side-effect: manifest URLs slowly accumulate one nudge=<TS> stamp.
   *  bumpCacheKey strips any prior nudge=/recal=/row=/v= queries before
   *  applying the new one, so we never grow more than a single stamp per
   *  URL — the manifest stays clean across many saves. */
  async function bumpLivePet(paths: Set<string>) {
    const v = `nudge=${Date.now()}`;
    const bumpUrl = (s: string): string => bumpCacheKey(s, v);

    // ── Live-pet display update (petStore) ───────────────────────────────────
    // Only possible when the pet being edited is the currently active pet.
    // If the check fails (e.g. editing from gallery while a different pet is
    // live) we still need to persist the manifest to disk (see below) so that
    // the next *soft* reload doesn't serve a stale browser-cached PNG.
    const isActivePet = currentPet.id === petId && !!currentPet.manifest;
    if (isActivePet) {
      const activeMfst = currentPet.manifest!;
      const nextPoses: typeof activeMfst.poses = { ...activeMfst.poses };
      let touched = false;
      for (const [moodKey, pose] of Object.entries(activeMfst.poses)) {
        if (!pose) continue;
        const frames = pose.frames ?? [];
        const matches = frames.some((f) => paths.has(f.src.split('?')[0]));
        if (!matches) continue;
        touched = true;
        const updated = {
          ...pose,
          src: pose.src ? bumpUrl(pose.src) : pose.src,
          frames: frames.map((f) => ({ ...f, src: bumpUrl(f.src) })),
        };
        nextPoses[moodKey as keyof typeof nextPoses] = updated;
        setSpriteConfig(moodKey as Parameters<typeof setSpriteConfig>[0], updated);
      }
      // If none of the active-pet's frames matched there's nothing to bump.
      if (!touched) return;
    }

    // ── Nudge-modal store update ─────────────────────────────────────────────
    // Bump modal-side manifest so the row-grid thumbnails refetch the
    // just-saved pixels instead of the cached pre-edit version.
    useFrameNudgeStore.getState().bumpFrames(paths);

    // ── Disk persist ─────────────────────────────────────────────────────────
    // Always write a bumped manifest to disk — this is what makes the
    // cache-bust stamp survive a browser reload (soft or hard). Without it the
    // browser serves the stale cached PNG at the un-bumped URL.
    //
    // Prefer currentPet.manifest (petStore, already bumped above via
    // setSpriteConfig) when available; fall back to the nudge store's copy
    // for the gallery-editing case where isActivePet is false.
    //
    // Cast: petStore's PetManifest.poses uses SpriteConfig (label?: string)
    // while uploadManifest's YhaPetManifest expects ManifestPose (label: string).
    // In practice every pose loaded from disk carries a label.
    const persistBase = isActivePet
      ? currentPet.manifest
      : (useFrameNudgeStore.getState().manifest as unknown as typeof currentPet.manifest);
    if (persistBase) {
      const nextPosesForDisk: typeof persistBase.poses = { ...persistBase.poses };
      for (const [moodKey, pose] of Object.entries(persistBase.poses)) {
        if (!pose) continue;
        const frames = pose.frames ?? [];
        if (!frames.some((f) => paths.has(f.src.split('?')[0]))) continue;
        nextPosesForDisk[moodKey as keyof typeof nextPosesForDisk] = {
          ...pose,
          src: pose.src ? bumpUrl(pose.src) : pose.src,
          frames: frames.map((f) => ({ ...f, src: bumpUrl(f.src) })),
        };
      }
      try {
        const persisted = {
          ...persistBase,
          poses: nextPosesForDisk,
        } as unknown as Parameters<typeof uploadManifest>[0];
        await uploadManifest(persisted);
      } catch (e) {
        console.warn('[FrameNudgeModal] manifest persist failed:', (e as Error).message);
      }
    }

    // Broadcast so petStore re-fetches the on-disk manifest. This is the
    // belt to the cache-bust suspenders: even if the browser ignores our
    // ?nudge=<ts> stamp on the PNG URL (some Service Workers replace
    // query strings, some CDNs rewrite them), the next loadManifest()
    // from petStore re-fetches with cache: 'no-cache' so the live pet
    // can never be more than one event-loop turn behind disk truth.
    try {
      window.dispatchEvent(new CustomEvent('yha:pet-manifest-updated', {
        detail: { petId },
      }));
    } catch { /* ignore */ }
  }

  async function save() {
    if (!image) return;
    setBusy(true);
    setError(null);
    setStatus('rendering…');
    try {
      const edited = applyEdits(image, scale, dx, dy);
      const blob = await imageDataToPngBlob(edited);
      setStatus('uploading…');
      await uploadFrame(petId, filename, blob);
      await bumpLivePet(new Set([src.split('?')[0]]));
      const zoomLabel = scale !== 1 ? ` ×${scale.toFixed(2)}` : '';
      setStatus(`saved (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})${zoomLabel}`);
      // Stay in editor so the user can verify; click Back to leave.
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  /** Apply the current (dx, dy, scale) to every OTHER frame in the row,
   *  using each frame's own current on-disk pixels as the base. The
   *  current frame is also saved as part of the same batch — that way
   *  the user can press one button and ship the whole row.
   *
   *  Each sibling is fetched fresh (cache-busted via fetchImageData),
   *  re-shifted/scaled by the same amounts, and uploaded. Order matches
   *  the row's frame index so the user can watch the progress count up.
   */
  async function applyToAllInRow() {
    if (!image) return;
    if (siblings.length <= 1) return;
    const dirty = dx !== 0 || dy !== 0 || scale !== 1;
    if (!dirty) {
      setStatus('nothing to copy — adjust dx/dy/zoom first');
      return;
    }
    const ok = window.confirm(
      `Apply this frame's settings (dx=${dx}, dy=${dy}, zoom=${scale.toFixed(2)}×) to all `
      + `${siblings.length} frames of "${row}"? Each frame's existing pixels will be re-shifted `
      + 'and re-scaled — fix per-frame deviations afterwards.',
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    const touched = new Set<string>();
    try {
      for (let i = 0; i < siblings.length; i++) {
        const sib = siblings[i];
        setStatus(`apply ${i + 1}/${siblings.length}: ${sib.filename}`);
        // Reuse the already-loaded ImageData for the active frame to skip
        // a redundant network round-trip.
        const baseImage = sib.src === src
          ? image
          : await fetchImageData(sib.src);
        const edited = applyEdits(baseImage, scale, dx, dy);
        const blob = await imageDataToPngBlob(edited);
        await uploadFrame(petId, sib.filename, blob);
        touched.add(sib.src.split('?')[0]);
      }
      await bumpLivePet(touched);
      setStatus(`applied to ${siblings.length} frames in "${row}"`);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDx(0);
    setDy(0);
    setScale(1);
    setStatus(null);
  }

  if (error) return <div className="hatch-error">{error}</div>;
  if (!image) return <div className="hatch-intro">Loading frame…</div>;

  // Crosshair anchor (image space): centre-X, ground line at ~93% down.
  const anchorX = image.width / 2;
  const anchorY = Math.round(image.height * 0.93);
  const display = EDITOR_DISPLAY;
  const aspect = image.height / image.width;
  const displayH = Math.round(display * aspect);

  const dirty = dx !== 0 || dy !== 0 || scale !== 1;
  const applyAllDisabled = busy || siblings.length <= 1 || !dirty;

  return (
    <div className="nudge-editor">
      <div className="nudge-editor-meta">
        <code>{filename}</code>
        <span className="nudge-editor-delta">
          shift: <strong>dx={dx} dy={dy}</strong>
        </span>
        <span className="nudge-editor-delta">
          zoom: <strong>×{scale.toFixed(2)}</strong>
        </span>
        {status ? <span className="nudge-editor-status">{status}</span> : null}
      </div>
      {/* Frame-strip navigation: prev / counter / next */}
      <div className="nudge-editor-nav">
        <button
          type="button"
          className="hatch-btn-ghost"
          onClick={onPrev}
          disabled={frameIndex <= 0 || busy}
          title="Previous frame (←)"
          aria-label="Previous frame"
        >
          ←
        </button>
        <span className="nudge-editor-nav-counter">
          {frameIndex + 1} / {frameCount}
        </span>
        <button
          type="button"
          className="hatch-btn-ghost"
          onClick={onNext}
          disabled={frameIndex >= frameCount - 1 || busy}
          title="Next frame (→)"
          aria-label="Next frame"
        >
          →
        </button>
      </div>
      <div
        className="nudge-canvas-wrap"
        style={{ width: display, height: displayH }}
      >
        <canvas
          ref={canvasRef}
          width={image.width}
          height={image.height}
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{
            width: display,
            height: displayH,
            cursor: busy ? 'wait' : 'grab',
            touchAction: 'none',
            imageRendering: 'pixelated',
          }}
        />
        {/* Crosshair overlay — purely informational, not interactive. */}
        <svg
          className="nudge-crosshair"
          width={display}
          height={displayH}
          viewBox={`0 0 ${image.width} ${image.height}`}
          aria-hidden="true"
        >
          <line x1={anchorX} y1={0} x2={anchorX} y2={image.height} stroke="#ff4d8a" strokeWidth="2" strokeDasharray="6 6" />
          <line x1={0} y1={anchorY} x2={image.width} y2={anchorY} stroke="#ff4d8a" strokeWidth="2" strokeDasharray="6 6" />
          <circle cx={anchorX} cy={anchorY} r="6" fill="none" stroke="#ff4d8a" strokeWidth="2" />
        </svg>
      </div>
      <div className="nudge-editor-zoom">
        <label className="nudge-editor-zoom-label" htmlFor="nudge-zoom-slider">
          🔍 Zoom
        </label>
        <input
          id="nudge-zoom-slider"
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={scale}
          onChange={(e) => setScale(Number(e.currentTarget.value))}
          disabled={busy}
          className="nudge-editor-zoom-slider"
          aria-label="Zoom (scale around foot anchor)"
        />
        <span className="nudge-editor-zoom-value">×{scale.toFixed(2)}</span>
        <button
          type="button"
          className="hatch-btn-ghost nudge-editor-zoom-reset"
          onClick={() => setScale(1)}
          disabled={busy || scale === 1}
          title="Reset zoom to 1.00×"
        >
          ↺
        </button>
      </div>
      <div className="nudge-editor-actions">
        <button className="hatch-btn-ghost" onClick={reset} disabled={busy || !dirty}>
          Reset
        </button>
        <button className="hatch-btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save frame'}
        </button>
        <button
          type="button"
          className="hatch-btn-ghost nudge-reimport-toggle"
          onClick={() => setShowReimport((v) => !v)}
          disabled={busy}
          title="Re-crop this frame from the original strip at a shifted position — useful when adjacent cells bleed into the cut edge"
        >
          {showReimport ? '↑ Hide re-import' : '↩ Re-import from strip'}
        </button>
        <button
          className="hatch-btn-ghost nudge-editor-apply-all"
          onClick={applyToAllInRow}
          disabled={applyAllDisabled}
          title={
            siblings.length <= 1
              ? 'Only one frame in this row'
              : !dirty
                ? 'Adjust dx/dy/zoom first, then copy to siblings'
                : `Copy these settings to all ${siblings.length} frames in "${row}"`
          }
        >
          ⇶ Apply to all in row
        </button>
        <button className="hatch-btn-ghost" onClick={onDone}>
          Done
        </button>
      </div>
      <p className="nudge-editor-hint">
        Drag the sprite to nudge it; slide 🔍 Zoom to scale it around the
        foot anchor (it stays planted on the ground). Pink crosshair =
        canonical anchor (centre-X, foot line at 93 %). Edge pixels that
        fall off the canvas are dropped. <strong>⇶ Apply to all in row</strong>
        re-shifts &amp; re-scales every other frame in this animation by
        the same amounts — fix per-frame deviations afterwards.
      </p>
      {showReimport && (
        <ReimportFromStrip
          rowName={row}
          frameIndex={frameIndex}
          petId={petId}
          filename={filename}
          src={src}
          siblings={siblings}
          strip={strip}
          onStripLoad={onStripLoad}
          disabled={busy}
          onImported={(imageData) => {
            // Cancel any still-running mount-time fetch so stale on-disk pixels
            // can't overwrite the freshly re-imported imageData after we return.
            fetchTokenRef.current.cancelled = true;
            // Replace the editor's image with the freshly sliced pixels.
            // Reset nudge/zoom — the user can still apply further corrections
            // on top of the re-imported frame.
            setImage(imageData);
            setDx(0);
            setDy(0);
            setScale(1);
            setStatus('re-imported ✓ — nudge/zoom to fine-tune, then save');
          }}
          onSaved={(paths) => { void bumpLivePet(paths); }}
        />
      )}
    </div>
  );
}

// ── Re-import from strip ──────────────────────────────────────────────────────
//
// Embedded sub-panel inside FrameEditor. The user drops the original strip PNG;
// the panel shows a scaled overview with the default cell boundary highlighted.
// Two sliders (X / Y) shift the crop window by ±REIMPORT_MAX_OFFSET px so
// bleeding pixels from adjacent cells (e.g. a neighbouring row's feet poking
// into the bottom of the current cell) can be excluded without touching the
// already-placed nudge/zoom values.
//
// On "Import this frame":
//   1. Slice at the adjusted (sx, sy) position using a canvas drawImage call.
//   2. Apply chromaKeyImageData in-place (removes magenta background).
//   3. Upload the PNG blob via uploadFrame → overwrites the on-disk file.
//   4. Call onSaved(paths) → parent issues cache-bust on the live pet.
//   5. Call onImported(imageData) → parent FrameEditor swaps its canvas.
//
// The loaded strip (HTMLImageElement) is managed by the grandparent
// (NudgeInner) so it survives frame navigations — the user only drops the
// strip once per editing session, then steps through frames adjusting offsets.

interface ReimportFromStripProps {
  rowName: string;
  /** 0-based index of this frame within the row (= siblings array index). */
  frameIndex: number;
  petId: string;
  filename: string;
  /** Current on-disk URL — used to derive the raw file path for cache-busting. */
  src: string;
  /** Strip image shared across frame navigations (null until first load). */
  strip: HTMLImageElement | null;
  /** Notify the parent when the user loads or clears the strip. */
  onStripLoad: (img: HTMLImageElement | null) => void;
  disabled: boolean;
  /** Called with the freshly-sliced, chroma-keyed ImageData after a successful
   *  upload so the parent FrameEditor can refresh its canvas. */
  onImported: (imageData: ImageData) => void;
  /** Called with the set of raw file paths written to disk so the parent can
   *  cache-bust the live pet sprite. */
  onSaved: (paths: Set<string>) => void;
  /** All frames in this row — needed for "Apply to all in row". */
  siblings: { src: string; filename: string }[];
}

/** Maximum crop offset in either axis (px in source image space). */
const REIMPORT_MAX_OFFSET = 120;
/** Display width of the strip overview canvas (CSS px). */
const REIMPORT_STRIP_DISPLAY = 480;

function ReimportFromStrip({
  rowName, frameIndex, petId, filename, src,
  strip, onStripLoad, disabled, onImported, onSaved, siblings,
}: ReimportFromStripProps) {
  const rowDef = (ROWS as Record<string, RowDefinition | undefined>)[rowName];
  const stripLayout = rowDef?.stripLayout ?? null;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stripCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [sliceOffX, setSliceOffX] = useState(0);
  const [sliceOffY, setSliceOffY] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Derived cell geometry — recalculates when strip or frameIndex changes.
  const geometry = useMemo(() => {
    if (!strip || !stripLayout) return null;
    const { cols, rows: rowCount } = stripLayout;
    const stripW = strip.naturalWidth;
    const stripH = strip.naturalHeight;
    const cellW = Math.floor(stripW / cols);
    const cellH = Math.floor(stripH / rowCount);
    const col = frameIndex % cols;
    const rowIdx = Math.floor(frameIndex / cols);
    return {
      cellW, cellH, col, rowIdx, stripW, stripH,
      defaultSx: col * cellW,
      defaultSy: rowIdx * cellH,
    };
  }, [strip, stripLayout, frameIndex]);

  // Clamped actual slice coordinates, recomputed with each slider change.
  const slicePos = useMemo(() => {
    if (!geometry) return null;
    const { defaultSx, defaultSy, cellW, cellH, stripW, stripH } = geometry;
    return {
      sx: Math.max(0, Math.min(defaultSx + sliceOffX, stripW - cellW)),
      sy: Math.max(0, Math.min(defaultSy + sliceOffY, stripH - cellH)),
    };
  }, [geometry, sliceOffX, sliceOffY]);

  // ── Strip overview canvas ────────────────────────────────────────────────
  // Full strip drawn dimmed; the adjusted crop cell is clipped out and drawn
  // at full brightness. Pink solid rect = new crop; yellow dashed = original.
  useEffect(() => {
    const canvas = stripCanvasRef.current;
    if (!canvas || !strip || !geometry || !slicePos) return;
    const { cellW, cellH, defaultSx, defaultSy, stripW, stripH } = geometry;
    const { sx, sy } = slicePos;

    const dW = Math.min(REIMPORT_STRIP_DISPLAY, stripW);
    const dH = Math.round(dW * stripH / stripW);
    canvas.width = dW;
    canvas.height = dH;
    const ctx = canvas.getContext('2d')!;
    const scX = dW / stripW;
    const scY = dH / stripH;

    // Full strip, then dim overlay.
    ctx.drawImage(strip, 0, 0, dW, dH);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, dW, dH);

    // Reveal the adjusted cell at full brightness by clipping.
    ctx.save();
    ctx.beginPath();
    ctx.rect(sx * scX, sy * scY, cellW * scX, cellH * scY);
    ctx.clip();
    ctx.drawImage(strip, 0, 0, dW, dH);
    ctx.restore();

    // Pink solid border = adjusted / new crop position.
    ctx.strokeStyle = '#ff4d8a';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(sx * scX + 1, sy * scY + 1, cellW * scX - 2, cellH * scY - 2);

    // Yellow dashed border = original default crop (only visible when offset ≠ 0).
    if (sliceOffX !== 0 || sliceOffY !== 0) {
      ctx.strokeStyle = 'rgba(255,216,0,0.8)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        defaultSx * scX + 1, defaultSy * scY + 1,
        cellW * scX - 2, cellH * scY - 2,
      );
      ctx.setLineDash([]);
    }
  }, [strip, geometry, slicePos, sliceOffX, sliceOffY]);

  // ── Cell preview canvas ─────────────────────────────────────────────────
  // Shows raw pixels (before chroma-key) from the adjusted crop region.
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !strip || !geometry || !slicePos) return;
    const { cellW, cellH } = geometry;
    const { sx, sy } = slicePos;
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, cellW, cellH);
    ctx.drawImage(strip, sx, sy, cellW, cellH, 0, 0, cellW, cellH);
  }, [strip, geometry, slicePos]);

  async function handleStripFile(file: File) {
    setStatus('loading strip…');
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Image failed to decode'));
      });
      // Revoke lazily — canvas drawImage still needs the element live during renders.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      onStripLoad(img);
      setSliceOffX(0);
      setSliceOffY(0);
      setStatus(null);
    } catch (e) {
      setStatus(`load failed: ${(e as Error).message}`);
    }
  }

  async function handleImport() {
    if (!strip || !geometry || !slicePos) return;
    const { cellW, cellH } = geometry;
    const { sx, sy } = slicePos;

    setBusy(true);
    setStatus('slicing…');
    try {
      // 1. Slice the cell at the (possibly offset) position.
      const canvas = document.createElement('canvas');
      canvas.width = cellW;
      canvas.height = cellH;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(strip, sx, sy, cellW, cellH, 0, 0, cellW, cellH);
      const imageData = ctx.getImageData(0, 0, cellW, cellH);

      // 2. Chroma-key in place — removes the magenta background.
      setStatus('chroma-keying…');
      chromaKeyImageData(imageData);

      // 3. Re-encode to PNG for upload.
      ctx.putImageData(imageData, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
          'image/png',
        ),
      );

      // 4. Upload → overwrites the existing frame on disk.
      setStatus('uploading…');
      await uploadFrame(petId, filename, blob);

      // 5. Notify parent to cache-bust live pet + refresh canvas.
      onSaved(new Set([src.split('?')[0]]));
      onImported(imageData);

      const offLabel = sliceOffX !== 0 || sliceOffY !== 0
        ? `offset ${sliceOffX >= 0 ? '+' : ''}${sliceOffX}, ${sliceOffY >= 0 ? '+' : ''}${sliceOffY}`
        : 'default position';
      setStatus(`imported ✓ (${offLabel})`);
    } catch (e) {
      setStatus(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  /** Re-crop ALL sibling frames in the row at the same (sliceOffX, sliceOffY)
   *  offset. Works through the siblings array in order, deriving each frame's
   *  strip position from its index.  After every upload, refreshes the current
   *  frame's editor canvas via onImported so the user sees the result. */
  async function handleApplyAll() {
    if (!strip || !geometry || !slicePos || !stripLayout) return;
    if (siblings.length <= 1) return;
    const { cols, rows: rowCount } = stripLayout;
    const stripW = strip.naturalWidth;
    const stripH = strip.naturalHeight;
    const cellW = Math.floor(stripW / cols);
    const cellH = Math.floor(stripH / rowCount);

    const offLabel = sliceOffX !== 0 || sliceOffY !== 0
      ? `offset ${sliceOffX >= 0 ? '+' : ''}${sliceOffX}, ${sliceOffY >= 0 ? '+' : ''}${sliceOffY}`
      : 'default position';
    const ok = window.confirm(
      `Apply crop ${offLabel} to ALL ${siblings.length} frames in "${rowName}"?\n` +
      'Every frame will be re-sliced and re-imported from the strip at this offset.',
    );
    if (!ok) return;

    setBusy(true);
    const touched = new Set<string>();
    let currentData: ImageData | null = null;
    try {
      for (let i = 0; i < siblings.length; i++) {
        const sib = siblings[i];
        const sibCol = i % cols;
        const sibRowIdx = Math.floor(i / cols);
        const defaultSx = sibCol * cellW;
        const defaultSy = sibRowIdx * cellH;
        const sx = Math.max(0, Math.min(defaultSx + sliceOffX, stripW - cellW));
        const sy = Math.max(0, Math.min(defaultSy + sliceOffY, stripH - cellH));

        setStatus(`importing ${i + 1} / ${siblings.length}: ${sib.filename}`);
        const canvas = document.createElement('canvas');
        canvas.width = cellW;
        canvas.height = cellH;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(strip, sx, sy, cellW, cellH, 0, 0, cellW, cellH);
        const imageData = ctx.getImageData(0, 0, cellW, cellH);
        chromaKeyImageData(imageData);
        ctx.putImageData(imageData, 0, 0);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
            'image/png',
          ),
        );
        await uploadFrame(petId, sib.filename, blob);
        touched.add(sib.src.split('?')[0]);
        if (sib.filename === filename) currentData = imageData;
      }
      onSaved(touched);
      if (currentData) onImported(currentData);
      setStatus(`all ${siblings.length} frames imported ✓ (${offLabel})`);
    } catch (e) {
      setStatus(`failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  // Row has no strip layout → frames were imported individually; no strip to re-crop from.
  if (!stripLayout) {
    return (
      <div className="reimport-panel">
        <p className="reimport-no-layout">
          Row "{rowName}" has no strip layout — frames were imported as individual files.
        </p>
      </div>
    );
  }

  const { cols, rows: rowCount } = stripLayout;
  const col = frameIndex % cols;
  const rowIdx = Math.floor(frameIndex / cols);

  return (
    <div className="reimport-panel">
      <div className="reimport-panel-head">
        <strong>↩ Re-import from strip</strong>
        <span className="reimport-panel-sub">
          Re-crop frame&nbsp;{frameIndex + 1} (col&nbsp;{col + 1},
          row&nbsp;{rowIdx + 1}) from the original {cols}×{rowCount} strip at a
          shifted position — useful when adjacent cells bleed into the cut edge
          (e.g. feet from the row above poking into the bottom of this cell).
          {strip ? ' Strip loaded — adjust offset or load a different file.' : ''}
        </span>
      </div>

      {!strip ? (
        /* ── Drop zone ──────────────────────────────────────────────────── */
        <div
          className="reimport-dropzone"
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('reimport-dropzone--over'); }}
          onDragLeave={(e) => { e.currentTarget.classList.remove('reimport-dropzone--over'); }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('reimport-dropzone--over');
            const file = e.dataTransfer.files[0];
            if (file) void handleStripFile(file);
          }}
        >
          <p>Drop the original {cols}×{rowCount} strip PNG here</p>
          <button
            type="button"
            className="hatch-btn-ghost"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
          >
            Or pick file…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/webp"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void handleStripFile(f);
              e.currentTarget.value = '';
            }}
          />
          {status ? <span className="reimport-status">{status}</span> : null}
        </div>
      ) : (
        /* ── Strip loaded ─────────────────────────────────────────────── */
        <>
          <div className="reimport-strip-info">
            {strip.naturalWidth}×{strip.naturalHeight}&thinsp;px strip —
            cell ~{geometry?.cellW ?? '?'}×{geometry?.cellH ?? '?'}&thinsp;px
          </div>
          <div className="reimport-canvases">
            <div className="reimport-strip-wrap">
              <canvas ref={stripCanvasRef} className="reimport-strip-canvas" />
              <span className="reimport-canvas-label">
                {sliceOffX !== 0 || sliceOffY !== 0
                  ? 'pink = new crop  ·  yellow dashed = original'
                  : 'pink box = crop region (no offset yet)'}
              </span>
            </div>
            <div className="reimport-preview-wrap">
              <canvas ref={previewCanvasRef} className="reimport-preview-canvas" />
              <span className="reimport-canvas-label">preview (before chroma-key)</span>
            </div>
          </div>
          <div className="reimport-offsets">
            <div className="reimport-offset-row">
              <label htmlFor="reimport-offx" className="reimport-offset-label">←/→&thinsp;X</label>
              <input
                id="reimport-offx"
                type="range"
                min={-REIMPORT_MAX_OFFSET}
                max={REIMPORT_MAX_OFFSET}
                value={sliceOffX}
                step={1}
                disabled={busy || disabled}
                onChange={(e) => setSliceOffX(Number(e.currentTarget.value))}
                className="reimport-slider"
                aria-label="Horizontal crop offset"
              />
              <span className="reimport-offset-value">
                {sliceOffX >= 0 ? '+' : ''}{sliceOffX}&thinsp;px
              </span>
            </div>
            <div className="reimport-offset-row">
              <label htmlFor="reimport-offy" className="reimport-offset-label">↑/↓&thinsp;Y</label>
              <input
                id="reimport-offy"
                type="range"
                min={-REIMPORT_MAX_OFFSET}
                max={REIMPORT_MAX_OFFSET}
                value={sliceOffY}
                step={1}
                disabled={busy || disabled}
                onChange={(e) => setSliceOffY(Number(e.currentTarget.value))}
                className="reimport-slider"
                aria-label="Vertical crop offset"
              />
              <span className="reimport-offset-value">
                {sliceOffY >= 0 ? '+' : ''}{sliceOffY}&thinsp;px
              </span>
            </div>
            {sliceOffX !== 0 || sliceOffY !== 0 ? (
              <button
                type="button"
                className="hatch-btn-ghost reimport-reset-offset"
                onClick={() => { setSliceOffX(0); setSliceOffY(0); }}
                disabled={busy}
              >
                ↺ reset offset
              </button>
            ) : null}
          </div>
          <div className="reimport-actions">
            <button
              type="button"
              className="hatch-btn-ghost"
              disabled={busy}
              onClick={() => { onStripLoad(null); setStatus(null); setSliceOffX(0); setSliceOffY(0); }}
            >
              Change strip
            </button>
            <button
              type="button"
              className="hatch-btn-primary"
              disabled={busy || disabled}
              onClick={() => void handleImport()}
            >
              {busy ? 'Importing…' : 'Import this frame'}
            </button>
            {siblings.length > 1 && (
              <button
                type="button"
                className="hatch-btn-ghost"
                disabled={busy || disabled}
                title={`Re-crop all ${siblings.length} frames in "${rowName}" at the same offset`}
                onClick={() => void handleApplyAll()}
              >
                ⇶ All {siblings.length} frames
              </button>
            )}
            {status ? <span className="reimport-status">{status}</span> : null}
          </div>
          <p className="reimport-hint">
            Pink box = where the cell will be sliced from. Drag sliders to shift
            the crop window (clamped to strip bounds). The preview shows raw pixels —
            chroma-key (magenta removal) runs automatically on import. After importing
            you can still apply nudge&nbsp;/ zoom corrections on top.
          </p>
        </>
      )}
    </div>
  );
}
