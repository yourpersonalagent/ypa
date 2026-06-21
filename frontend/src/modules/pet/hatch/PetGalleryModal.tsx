// PetGalleryModal — list, switch, and delete pets that exist on the bridge.
//
// Surfaced from PetHeaderButton's "Manage pets…" item. Displays a flat
// list of pet entries returned by GET /v1/pets. Switching activates the
// chosen pet via petStore.loadManifest(). Deleting removes the pet's
// directory + manifest from frontend/public/pets/.

import { create } from 'zustand';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  deletePet,
  fetchManifest,
  listPets,
  recalibrateFeet,
  type RecalibrateProgress,
} from './index.js';
import { useHatchStore } from '../store/hatchStore.js';
import { usePetStore } from '../store/petStore.js';
import { useFrameNudgeStore } from './FrameNudgeModal.js';

interface GalleryEntry {
  id: string;
  label: string;
  /** First idle frame path from the manifest — used as thumbnail fallback. */
  thumb?: string;
}

interface GalleryState {
  open: boolean;
  loading: boolean;
  error: string | null;
  entries: GalleryEntry[];
  busyId: string | null;
  /** Per-pet status string shown while recalibration is running. */
  status: Record<string, string>;
}

interface GalleryActions {
  openGallery: () => void;
  closeGallery: () => void;
  refresh: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  recalibrate: (id: string) => Promise<void>;
}

export const usePetGalleryStore = create<GalleryState & GalleryActions>((set, get) => ({
  open: false,
  loading: false,
  error: null,
  entries: [],
  busyId: null,
  status: {},

  openGallery: () => {
    set({ open: true });
    void get().refresh();
  },
  closeGallery: () => set({ open: false }),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const entries = await listPets();
      set({ loading: false, entries });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  switchTo: async (id) => {
    set({ busyId: id, error: null });
    try {
      await usePetStore.getState().loadManifest(id);
      set({ busyId: null });
    } catch (e) {
      set({ busyId: null, error: (e as Error).message });
    }
  },

  remove: async (id) => {
    set({ busyId: id, error: null });
    try {
      await deletePet(id);
      // Refresh the list so the removed entry disappears.
      const entries = await listPets();
      set({ busyId: null, entries });
    } catch (e) {
      set({ busyId: null, error: (e as Error).message });
    }
  },

  recalibrate: async (id) => {
    set((s) => ({
      busyId: id,
      error: null,
      status: { ...s.status, [id]: 'reading manifest…' },
    }));
    const setStatus = (msg: string) => set((s) => ({ status: { ...s.status, [id]: msg } }));
    const formatProgress = (p: RecalibrateProgress) => {
      if (p.phase === 'done') return 'done';
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      const label = p.label ? ` ${p.label}` : '';
      return `${p.phase}${label} (${p.done}/${p.total} · ${pct}%)`;
    };
    try {
      const manifest = await fetchManifest(id);
      const result = await recalibrateFeet(id, manifest, (p) => {
        setStatus(formatProgress(p));
      });
      // If we just recalibrated the active pet, force the running sprite
      // viewers to re-fetch each frame by bumping the src URLs in the
      // in-memory pose configs. The manifest on disk stays unbumped.
      const petStore = usePetStore.getState();
      if (petStore.currentPet.id === id) {
        const v = `recal=${Date.now()}`;
        const bumpUrl = (s: string): string => {
          const [base, qs = ''] = s.split('?');
          const stripped = qs
            .split('&')
            .filter((p) => p && !p.startsWith('recal='))
            .join('&');
          return `${base}?${stripped ? `${stripped}&` : ''}${v}`;
        };
        const m = petStore.currentPet.manifest;
        if (m) {
          for (const [moodKey, pose] of Object.entries(m.poses)) {
            if (!pose) continue;
            petStore.setSpriteConfig(moodKey as Parameters<typeof petStore.setSpriteConfig>[0], {
              ...pose,
              src: pose.src ? bumpUrl(pose.src) : pose.src,
              frames: pose.frames ? pose.frames.map((f) => ({ ...f, src: bumpUrl(f.src) })) : pose.frames,
            });
          }
        }
      }
      const ok = `${result.shifted} shifted · ${result.unchanged} kept · ${result.total} total`;
      setStatus(ok);
      set({ busyId: null });
      // Auto-clear the status after a few seconds.
      window.setTimeout(() => {
        set((s) => {
          if (s.status[id] !== ok) return s;
          const next = { ...s.status };
          delete next[id];
          return { status: next };
        });
      }, 6000);
    } catch (e) {
      set((s) => ({
        busyId: null,
        error: (e as Error).message,
        status: { ...s.status, [id]: `failed: ${(e as Error).message}` },
      }));
    }
  },
}));

export function PetGalleryModal() {
  const open = usePetGalleryStore((s) => s.open);
  if (!open) return null;
  return createPortal(<GalleryInner />, document.body);
}

function GalleryInner() {
  const close = usePetGalleryStore((s) => s.closeGallery);
  const loading = usePetGalleryStore((s) => s.loading);
  const error = usePetGalleryStore((s) => s.error);
  const entries = usePetGalleryStore((s) => s.entries);
  const busyId = usePetGalleryStore((s) => s.busyId);
  const status = usePetGalleryStore((s) => s.status);
  const switchTo = usePetGalleryStore((s) => s.switchTo);
  const remove = usePetGalleryStore((s) => s.remove);
  const recalibrate = usePetGalleryStore((s) => s.recalibrate);
  const refresh = usePetGalleryStore((s) => s.refresh);
  const currentId = usePetStore((s) => s.currentPet.id);
  const openUpgrade = useHatchStore((s) => s.openUpgrade);
  const openNudge = useFrameNudgeStore((s) => s.openFor);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="hatch-backdrop" role="dialog" aria-modal="true" aria-label="Manage YHA pets">
      <div className="hatch-modal hatch-modal-narrow">
        <header className="hatch-head">
          <strong>🐾 Manage pets</strong>
          <span className="hatch-sub">Existing pets stored under <code>/pets/</code></span>
          <div className="hatch-head-actions">
            <button className="hatch-btn-ghost" onClick={() => void refresh()}>Refresh</button>
            <button className="hatch-btn-ghost" onClick={close}>Close</button>
          </div>
        </header>
        <main className="hatch-body">
          {loading ? <div className="hatch-intro">Loading…</div> : null}
          {error ? <div className="hatch-error">{error}</div> : null}
          {!loading && !entries.length ? (
            <div className="hatch-intro">
              No pets yet. Use “Hatch new pet…” from the pet menu to make one.
            </div>
          ) : null}
          <ul className="hatch-pet-list">
            {entries.map((p) => (
              <li key={p.id} className={`hatch-pet-row${p.id === currentId ? ' is-active' : ''}`}>
                <div className="hatch-pet-meta">
                  <strong>{p.label}</strong>
                  <code>{p.id}</code>
                  {status[p.id] ? (
                    <span className="hatch-pet-status">{status[p.id]}</span>
                  ) : null}
                </div>
                <div className="hatch-pet-actions">
                  <button
                    className="hatch-btn-ghost"
                    disabled={busyId === p.id || p.id === currentId}
                    onClick={() => void switchTo(p.id)}
                  >
                    {p.id === currentId ? 'Active' : busyId === p.id ? 'Switching…' : 'Switch'}
                  </button>
                  <button
                    className="hatch-btn-ghost"
                    disabled={busyId === p.id}
                    onClick={() => {
                      close();
                      void openUpgrade(p.id);
                    }}
                    title="Add missing rows (e.g. fighting) using the same spec"
                  >
                    🔧 Upgrade
                  </button>
                  <button
                    className="hatch-btn-ghost"
                    disabled={busyId === p.id}
                    onClick={() => {
                      if (window.confirm(
                        `Recalibrate bottom-of-feet for "${p.label}"?\n\n`
                        + 'Aligns every frame in each animation row to a common '
                        + 'right-foot/ground anchor by scanning the alpha channel. '
                        + 'Overwrites the PNG files on disk; cannot be undone (only '
                        + 'a re-hatch).',
                      )) {
                        void recalibrate(p.id);
                      }
                    }}
                    title="Scan alpha channel and align all frames to the same right-foot/ground anchor"
                  >
                    🎯 Recalibrate feet
                  </button>
                  <button
                    className="hatch-btn-ghost"
                    disabled={busyId === p.id}
                    onClick={() => {
                      close();
                      void openNudge(p.id, p.label);
                    }}
                    title="Manually nudge individual frames with a crosshair + drag"
                  >
                    ✋ Nudge frames
                  </button>
                  <button
                    className="hatch-btn-danger"
                    disabled={busyId === p.id}
                    onClick={() => {
                      if (window.confirm(`Delete pet "${p.label}"? Frames + manifest are removed.`)) {
                        void remove(p.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </main>
      </div>
    </div>
  );
}
