// activeModelsStore — tiny shared cache for /v1/active-models/.
//
// Used by anything that needs to know "what's the active model for category X"
// without each subscriber issuing its own fetch. Today this means:
//   - The composer mode switcher (which model name to show under the mode tab)
//   - The MediaParamPanel (which schema to fetch)
//   - Future surfaces (status pills, etc.)
//
// The shape mirrors the bridge response. Categories beyond the legacy
// llm/image/video/audio quartet are accepted via a `byCategory` map for
// futureproofing — the composer already iterates this map so new categories
// added bridge-side surface automatically.

import { create } from 'zustand';
import { api } from '../api.js';

export interface ActiveModelInfo {
  provider: string;
  model: string;
}

export interface ActiveModelsState {
  llm: ActiveModelInfo | null;
  image: ActiveModelInfo | null;
  video: ActiveModelInfo | null;
  audio: ActiveModelInfo | null;
  // Future categories (tts, music, embedding, ...) land here when the bridge
  // returns them. Keeps the store futureproof without a schema migration.
  byCategory: Record<string, ActiveModelInfo>;
  loadedAt: number;
}

interface ActiveModelsActions {
  load: () => Promise<void>;
  setForCategory: (category: string, info: ActiveModelInfo | null) => void;
}

type Store = ActiveModelsState & ActiveModelsActions;

const FRESH_MS = 5000;

export const useActiveModelsStore = create<Store>((set, get) => ({
  llm: null,
  image: null,
  video: null,
  audio: null,
  byCategory: {},
  loadedAt: 0,

  load: async () => {
    const { loadedAt } = get();
    if (loadedAt && Date.now() - loadedAt < FRESH_MS) return;
    try {
      const res = await fetch(api.config.baseUrl + '/v1/active-models/');
      if (!res.ok) return;
      const data = (await res.json()) as {
        success?: boolean;
        llm?: ActiveModelInfo;
        image?: ActiveModelInfo;
        video?: ActiveModelInfo;
        audio?: ActiveModelInfo;
        byCategory?: Record<string, ActiveModelInfo>;
      };
      if (!data || data.success === false) return;
      const byCategory: Record<string, ActiveModelInfo> = { ...(data.byCategory || {}) };
      // Legacy slots feed the map so callers only have to look in one place.
      if (data.llm) byCategory.llm = data.llm;
      if (data.image?.model) byCategory.image = data.image;
      if (data.video?.model) byCategory.video = data.video;
      if (data.audio?.model) byCategory.audio = data.audio;
      set({
        llm: data.llm ?? null,
        image: data.image?.model ? data.image : null,
        video: data.video?.model ? data.video : null,
        audio: data.audio?.model ? data.audio : null,
        byCategory,
        loadedAt: Date.now(),
      });
    } catch (e) {
      console.warn('active-models store load failed', (e as Error).message);
    }
  },

  setForCategory: (category, info) => {
    set((s) => {
      const next = { ...s.byCategory };
      if (info) next[category] = info;
      else delete next[category];
      const patch: Partial<ActiveModelsState> = { byCategory: next };
      if (category === 'llm') patch.llm = info;
      if (category === 'image') patch.image = info;
      if (category === 'video') patch.video = info;
      if (category === 'audio') patch.audio = info;
      return patch;
    });
  },
}));

export function getActiveModel(category: string): ActiveModelInfo | null {
  return useActiveModelsStore.getState().byCategory[category] ?? null;
}
