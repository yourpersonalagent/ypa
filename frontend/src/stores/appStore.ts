// appStore — global cross-cutting state (UI prefs, current model, tokens, etc.)
// This is the Zustand replacement for app.state with persist middleware.
// Backed by localStorage for instant paint; server sync is handled separately.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { DEFAULT_COLOR_THEME, applyColorThemeToDom } from '../color-themes-config.js';
import { DEFAULT_DESIGN_THEME, applyDesignThemeToDom } from '../design-themes-config.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CurrentModel {
  id: number;
  name: string;
  provider?: string;
  localOnly?: boolean;
}

export interface SysPromptState {
  mode: 'off' | 'append' | 'replace';
  preset: string;
  presets?: string[];
}

export interface SysPromptData {
  selection: SysPromptState;
  presets: Record<string, string>;
  text: string;
}

export interface ModelCaps {
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
}

export interface UserCaps {
  vision: boolean;
  reasoning: 'enabled' | 'disabled' | null;
  tools: 'on' | 'filter' | false;
}

export interface EditorState {
  pan: { x: number; y: number };
  zoom: number;
}

// Layout mode — which top-level layout component renders the page.
// Registered layouts live in frontend/src/layouts/ (see LayoutPlan.md
// Phase 2). Each layout is sandboxed under its own [data-layout="<name>"]
// CSS scope. Adding a new layout: drop it in frontend/src/layouts/<name>/,
// register it in frontend/src/layouts/index.ts, and append to this union.
export type LayoutMode = 'full' | 'messenger' | 'zen';

// Which header-section panel is currently open in non-full layouts.
// Full layout embeds the panels in its header; messenger/zen open them
// via PanelsDrawer (a fixed overlay) driven by this store field. The id
// is a free-form string — it matches `HeaderSection.sectionId` with any
// leading `hs-` stripped (so `'cwd'`, `'plugins'`, etc.). PanelsDrawer
// looks up the matching `headerSections` register entry to render.
export type PanelSectionId = string;

// Composer mode — which kind of output the chat input is currently aimed at.
// `chat` is the normal LLM path; the others route through the media-gen
// meta-skill with a per-category active model + a schema-driven param panel.
export type ComposerMode = 'chat' | 'image' | 'audio' | 'video';
export const COMPOSER_MODES: ComposerMode[] = ['chat', 'image', 'audio', 'video'];

// Per-mode param values picked up by the composer when Send fires.
// Shape is intentionally loose — schema fields can be any of string|number|boolean.
export type MediaParamValue = string | number | boolean | null;
export type MediaParams = Record<string, MediaParamValue>;

export interface AppState {
  // UI layout — color-theme id in `family-variant` form (e.g. `ocean-dark`).
  // See frontend/src/color-themes-config.ts for the full model.
  colorTheme: string;
  // Design language — Console (default) | Atelier | Patchbay.
  // See frontend/src/design-themes-config.ts for the full model.
  designTheme: string;
  // Which layout component renders the page. See LayoutMode above.
  layoutMode: LayoutMode;
  // Panel open in PanelsDrawer (messenger/zen only). Null = closed.
  openPanel: PanelSectionId | null;
  viewMode: 'split' | 'chat' | 'workflow' | 'code';
  viewSplit: number;
  viewOrient: 'h' | 'v';
  viewSwap: boolean;
  headerOpen: boolean;
  headerOrient: 'h' | 'v';
  overlayPos: string;

  // Model / workflow
  currentModel: CurrentModel;
  currentPreset: number;
  models: unknown[];
  modelsRaw: string;
  effort: string | null;
  recordChat: 'all' | 'no-tools' | 'off';

  // System prompt / skills
  sysPrompt: SysPromptData;
  skillSet: string;
  harnessInstance: string;
  codexInstance: string;

  // Capability flags — what the model supports and what the user has toggled
  modelCaps: ModelCaps;
  caps: UserCaps;
  tokens: { total: number; cost: number };

  // Editor state (pan/zoom)
  editor: EditorState;

  // User identity (your own letter + color in the chat header)
  userName: string;
  userSymbolColor: string;

  // Input behaviour
  enterToSend: boolean;

  // Composer mode + per-mode param values (driven by /v1/media/schema/*).
  composerMode: ComposerMode;
  mediaParams: Record<ComposerMode, MediaParams>;
  // "Enhance prompt" toggle for media modes — when on, the media-gen meta-skill
  // is invited to rewrite the user's prompt before calling the image/audio/
  // video tool. When off, the raw prompt + params are passed straight through.
  composerEnhance: boolean;

  // Legacy graph/chat state placeholders (referenced by modules)
  graph: { nodes: unknown[]; links: unknown[] };
  chat: { messages: unknown[] };
  workflow: { name: string; id: string | null };
  currentSession: number | string;
  sessionWorkingDir: string | null;
  cwdHistory: string[];

  // Bumped when harness/codex instance config changes — used by subscribers
  // that need to refresh their picker contents.
  harnessRevision: number;
}

export interface AppActions {
  setColorTheme: (t: AppState['colorTheme']) => void;
  setDesignTheme: (d: AppState['designTheme']) => void;
  setLayoutMode: (m: LayoutMode) => void;
  setOpenPanel: (p: PanelSectionId | null) => void;
  setViewMode: (m: AppState['viewMode']) => void;
  setViewSplit: (s: number) => void;
  setViewOrient: (o: AppState['viewOrient']) => void;
  setViewSwap: (s: boolean) => void;
  setHeaderOpen: (o: boolean) => void;
  setHeaderOrient: (o: AppState['headerOrient']) => void;
  setOverlayPos: (p: string) => void;
  setCurrentModel: (m: CurrentModel) => void;
  setCurrentPreset: (p: number) => void;
  setEffort: (e: string | null) => void;
  setRecordChat: (r: AppState['recordChat']) => void;
  setSysPrompt: (s: SysPromptState) => void;
  setSysPromptPresets: (presets: Record<string, string>) => void;
  setSkillSet: (s: string) => void;
  setHarnessInstance: (h: string) => void;
  setCodexInstance: (c: string) => void;
  setModelCaps: (c: Partial<ModelCaps>) => void;
  setModels: (models: unknown[], modelsRaw: string) => void;
  setCaps: (c: Partial<UserCaps>) => void;
  setTokens: (t: { total: number; cost: number }) => void;
  setEditor: (e: Partial<EditorState>) => void;
  setUserName: (n: string) => void;
  setUserSymbolColor: (c: string) => void;
  setSessionWorkingDir: (d: string | null) => void;
  addCwdToHistory: (dir: string) => void;
  setCurrentSession: (s: number | string) => void;
  updateGraph: (g: { nodes: unknown[]; links: unknown[] }) => void;
  updateChatMessages: (chat: { messages: unknown[] }) => void;
  setWorkflow: (w: { name: string; id: string | null }) => void;
  setEnterToSend: (v: boolean) => void;
  setComposerMode: (m: ComposerMode) => void;
  setMediaParam: (mode: ComposerMode, key: string, value: MediaParamValue) => void;
  resetMediaParams: (mode: ComposerMode) => void;
  setComposerEnhance: (v: boolean) => void;
  bumpHarnessRevision: () => void;
  hydrateFromLegacy: () => void;
}

type AppStore = AppState & AppActions;

export function normalizeSysPromptSelection(selection: Partial<SysPromptState> | null | undefined): SysPromptState {
  const mode = selection?.mode === 'append' || selection?.mode === 'replace' ? selection.mode : 'off';
  const legacyPreset = typeof selection?.preset === 'string' ? selection.preset : '';
  const presets = Array.isArray(selection?.presets)
    ? selection.presets.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const deduped = Array.from(new Set(presets.map((p) => p.trim())));
  if (!deduped.length && legacyPreset.trim()) deduped.push(legacyPreset.trim());
  return {
    mode,
    preset: deduped[0] || '',
    ...(deduped.length ? { presets: deduped } : {}),
  };
}

export function resolveSysPromptText(selection: SysPromptState, presets: Record<string, string>): string {
  const names = selection.presets?.length ? selection.presets : (selection.preset ? [selection.preset] : []);
  return names
    .map((name) => presets[name] || '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
}

function sameSysPromptSelection(a: SysPromptState, b: SysPromptState): boolean {
  const aNames = a.presets?.length ? a.presets : (a.preset ? [a.preset] : []);
  const bNames = b.presets?.length ? b.presets : (b.preset ? [b.preset] : []);
  return a.mode === b.mode && a.preset === b.preset && aNames.join('\u0000') === bNames.join('\u0000');
}

// ── Defaults (mirror localStorage read from legacy app.ts) ──────────────────

function lsStr(key: string, fallback: string): string {
  return localStorage.getItem(key) || fallback;
}

// localStorage writes can throw on quota-exceeded or when the browser disables
// storage (e.g. Safari private mode). Persistence is best-effort: a failed
// write must never abort the store action that triggered it.
function persistLS(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* best-effort */ }
}

// Legacy migration: layouts were renamed `classic` → `full` and
// `whatsapp` → `messenger`. Users with the old values in localStorage
// get translated on first read; we also write the new value back so
// the inline boot script in yha.html sees the canonical form next load.
function migrateLayoutMode(raw: string): LayoutMode {
  const map: Record<string, LayoutMode> = { classic: 'full', whatsapp: 'messenger' };
  const next = map[raw] ?? (raw as LayoutMode);
  if (map[raw]) {
    try { persistLS('yha.layoutMode', next); } catch {}
  }
  if (next === 'full' || next === 'messenger' || next === 'zen') return next;
  return 'full';
}

function lsParse<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function getDefaults(): AppState {
  return {
    // Legacy migration: `yha.theme` was the pre-rename key. Prefer new key
    // when present; copy the old value if only the legacy key exists. The
    // legacy key is removed in setColorTheme() on the first write.
    colorTheme: lsStr('yha.colorTheme', '') || lsStr('yha.theme', DEFAULT_COLOR_THEME),
    designTheme: lsStr('yha.designTheme', DEFAULT_DESIGN_THEME),
    layoutMode: migrateLayoutMode(lsStr('yha.layoutMode', 'full')),
    openPanel: null,
    viewMode: lsStr('yha.viewMode', 'split') as AppState['viewMode'],
    viewSplit: parseFloat(lsStr('yha.viewSplit', '0.5')),
    viewOrient: lsStr('yha.viewOrient', 'h') as 'h' | 'v',
    viewSwap: localStorage.getItem('yha.viewSwap') === 'true',
    headerOpen: localStorage.getItem('yha.headerOpen') !== 'false',
    headerOrient: lsStr('yha.headerOrient', 'v') as 'h' | 'v',
    overlayPos: lsStr('yha.overlayPos', 'right'),
    currentModel: { id: 0, name: 'gpt-4o-mini' },
    currentPreset: 0,
    models: [],
    modelsRaw: '',
    effort: localStorage.getItem('yha.effort'),
    recordChat: lsStr('yha.recordChat', 'all') as AppState['recordChat'],
    sysPrompt: {
      selection: lsParse('yha.sysPrompt', { mode: 'off' as const, preset: '' }),
      presets: {},
      text: '',
    },
    skillSet: '',
    harnessInstance: lsStr('yha.harnessInstance', ''),
    codexInstance: lsStr('yha.codexInstance', ''),
    modelCaps: { vision: false, reasoning: false, tools: false },
    caps: lsParse<UserCaps>('yha.caps', { vision: false, reasoning: null, tools: false }),
    tokens: { total: 0, cost: 0 },
    editor: { pan: { x: 0, y: 0 }, zoom: 1 },
    userName: lsStr('yha.userName', ''),
    userSymbolColor: lsStr('yha.userSymbolColor', ''),
    graph: { nodes: [], links: [] },
    chat: { messages: [] },
    workflow: { name: '', id: null as string | null },
    currentSession: 0,
    sessionWorkingDir: null,
    cwdHistory: lsParse<string[]>('yha.cwdHistory', []),
    harnessRevision: 0,
    enterToSend: localStorage.getItem('yha.enterToSend') !== 'false',
    composerMode: ((): ComposerMode => {
      const raw = lsStr('yha.composerMode', 'chat');
      return (COMPOSER_MODES as string[]).includes(raw) ? (raw as ComposerMode) : 'chat';
    })(),
    mediaParams: lsParse<Record<ComposerMode, MediaParams>>('yha.mediaParams', {
      chat: {}, image: {}, audio: {}, video: {},
    }),
    composerEnhance: localStorage.getItem('yha.composerEnhance') !== 'false',
  };
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppStore>()(devtools((set) => {
  const defaults = getDefaults();

  return {
    ...defaults,

    // ── Actions ──
    setColorTheme: (colorTheme) => {
      // applyColorThemeToDom both validates and migrates legacy values, then
      // returns the canonical `family-variant` form that we store.
      const canonical = applyColorThemeToDom(colorTheme);
      set({ colorTheme: canonical });
      persistLS('yha.colorTheme', canonical);
      // Legacy key cleanup: once the new key has been written, drop the old
      // one so future hydrates take the canonical path. Safe to call
      // unconditionally — removeItem on a missing key is a no-op.
      localStorage.removeItem('yha.theme');
    },

    setDesignTheme: (designTheme) => {
      const canonical = applyDesignThemeToDom(designTheme);
      set({ designTheme: canonical });
      persistLS('yha.designTheme', canonical);
    },

    setLayoutMode: (layoutMode) => {
      set({ layoutMode, openPanel: null });
      persistLS('yha.layoutMode', layoutMode);
    },
    setOpenPanel: (openPanel) => set({ openPanel }),
    setViewMode: (viewMode) => set({ viewMode }),
    setViewSplit: (viewSplit) => set({ viewSplit }),
    setViewOrient: (viewOrient) => {
      set({ viewOrient });
      persistLS('yha.viewOrient', viewOrient);
    },
    setViewSwap: (viewSwap) => {
      set({ viewSwap });
      persistLS('yha.viewSwap', String(viewSwap));
    },
    setHeaderOpen: (headerOpen) => {
      set({ headerOpen });
      persistLS('yha.headerOpen', String(headerOpen));
    },
    setHeaderOrient: (headerOrient) => {
      set({ headerOrient });
      persistLS('yha.headerOrient', headerOrient);
    },
    setOverlayPos: (overlayPos) => {
      set({ overlayPos });
      persistLS('yha.overlayPos', overlayPos);
    },

    setCurrentModel: (currentModel) => {
      set({ currentModel });
      // DOM sync handled by <ModelBadge /> via MutationObserver + useEffect
    },
    setCurrentPreset: (currentPreset) => set({ currentPreset }),
    setEffort: (effort) => {
      set({ effort });
      if (effort) persistLS('yha.effort', effort);
      else localStorage.removeItem('yha.effort');
    },
    setRecordChat: (recordChat) => {
      set({ recordChat });
      persistLS('yha.recordChat', recordChat);
    },
    setSysPrompt: (selection) => {
      const normalized = normalizeSysPromptSelection(selection);
      set((state) => {
        const text = resolveSysPromptText(normalized, state.sysPrompt.presets);
        if (sameSysPromptSelection(state.sysPrompt.selection, normalized) && state.sysPrompt.text === text) {
          return state;
        }
        return { sysPrompt: { ...state.sysPrompt, selection: normalized, text } };
      });
      persistLS('yha.sysPrompt', JSON.stringify(normalized));
    },
    setSysPromptPresets: (presets) =>
      set((state) => {
        const selection = normalizeSysPromptSelection(state.sysPrompt.selection);
        const text = resolveSysPromptText(selection, presets);
        return { sysPrompt: { ...state.sysPrompt, presets, text } };
      }),
    setSkillSet: (skillSet) => {
      set({ skillSet });
      persistLS('yha.skillSet', skillSet);
    },
    setHarnessInstance: (harnessInstance) => {
      set({ harnessInstance });
      persistLS('yha.harnessInstance', harnessInstance);
    },
    setCodexInstance: (codexInstance) => {
      set({ codexInstance });
      persistLS('yha.codexInstance', codexInstance);
    },
    setModelCaps: (patch) => set((s) => ({ modelCaps: { ...s.modelCaps, ...patch } })),
    setModels: (models, modelsRaw) => set({ models, modelsRaw }),
    setCaps: (patch) => {
      set((s) => {
        const next = { ...s.caps, ...patch } as UserCaps;
        persistLS('yha.caps', JSON.stringify(next));
        return { caps: next };
      });
    },
    setTokens: (tokens) => set({ tokens }),
    setEditor: (patch) => set((s) => ({ editor: { ...s.editor, ...patch } })),
    setUserName: (userName) => {
      set({ userName });
      persistLS('yha.userName', userName);
    },
    setUserSymbolColor: (userSymbolColor) => {
      set({ userSymbolColor });
      persistLS('yha.userSymbolColor', userSymbolColor);
    },
    setSessionWorkingDir: (sessionWorkingDir) => set({ sessionWorkingDir }),
    addCwdToHistory: (dir) => {
      set((s) => {
        const next = [dir, ...s.cwdHistory.filter((d) => d !== dir)].slice(0, 20);
        persistLS('yha.cwdHistory', JSON.stringify(next));
        return { cwdHistory: next };
      });
    },
    setCurrentSession: (currentSession) => set({ currentSession }),
    updateGraph: (graph) => set({ graph }),
    updateChatMessages: (chat) => set({ chat: { messages: chat.messages || [] } }),
    setWorkflow: (workflow) => set({ workflow }),
    setEnterToSend: (enterToSend) => {
      set({ enterToSend });
      persistLS('yha.enterToSend', String(enterToSend));
    },
    setComposerMode: (composerMode) => {
      set({ composerMode });
      persistLS('yha.composerMode', composerMode);
    },
    setMediaParam: (mode, key, value) => {
      set((s) => {
        const next = { ...s.mediaParams, [mode]: { ...s.mediaParams[mode], [key]: value } };
        persistLS('yha.mediaParams', JSON.stringify(next));
        return { mediaParams: next };
      });
    },
    resetMediaParams: (mode) => {
      set((s) => {
        const next = { ...s.mediaParams, [mode]: {} };
        persistLS('yha.mediaParams', JSON.stringify(next));
        return { mediaParams: next };
      });
    },
    setComposerEnhance: (composerEnhance) => {
      set({ composerEnhance });
      persistLS('yha.composerEnhance', String(composerEnhance));
    },
    bumpHarnessRevision: () => set((s) => ({ harnessRevision: s.harnessRevision + 1 })),

    hydrateFromLegacy: () => {
      // Pull all values from the legacy window.app.state into the store
      const win = window as unknown as { app?: { state?: Record<string, unknown> } };
      const legacy = win.app?.state;
      if (!legacy) return;

      const patch: Partial<AppState> = {};
      // Legacy window.app.state.theme → colorTheme (window.app.state predates
      // the rename; hydration is one-shot at boot, then this code is dormant).
      const legacyTheme = (legacy.colorTheme ?? legacy.theme) as string | undefined;
      if (legacyTheme) patch.colorTheme = legacyTheme;
      if (legacy.viewMode) patch.viewMode = legacy.viewMode as AppState['viewMode'];
      if (typeof legacy.viewSplit === 'number') patch.viewSplit = legacy.viewSplit as number;
      if (legacy.viewOrient) patch.viewOrient = legacy.viewOrient as 'h' | 'v';
      if (typeof legacy.headerOpen === 'boolean') patch.headerOpen = legacy.headerOpen as boolean;
      if (legacy.headerOrient) patch.headerOrient = legacy.headerOrient as 'h' | 'v';
      if (legacy.overlayPos) patch.overlayPos = legacy.overlayPos as string;
      if (legacy.currentModel) patch.currentModel = legacy.currentModel as CurrentModel;
      if (typeof legacy.currentPreset === 'number') patch.currentPreset = legacy.currentPreset as number;
      if (legacy.effort !== undefined) patch.effort = legacy.effort as string | null;
      if (legacy.recordChat) patch.recordChat = legacy.recordChat as AppState['recordChat'];
      if (legacy.sysPrompt) {
        patch.sysPrompt = {
          ...getDefaults().sysPrompt,
          selection: normalizeSysPromptSelection(legacy.sysPrompt as SysPromptState),
        };
      }
      if (legacy.skillSet) patch.skillSet = legacy.skillSet as string;
      if (legacy.harnessInstance) patch.harnessInstance = legacy.harnessInstance as string;
      if (legacy.codexInstance) patch.codexInstance = legacy.codexInstance as string;
      if (legacy.caps) patch.caps = legacy.caps as UserCaps;
      if (legacy.tokens) patch.tokens = legacy.tokens as { total: number; cost: number };
      if (legacy.editor) patch.editor = legacy.editor as EditorState;
      if (legacy.graph) patch.graph = legacy.graph as { nodes: unknown[]; links: unknown[] };
      if (legacy.chat) patch.chat = legacy.chat as { messages: unknown[] };
      if (legacy.workflow) patch.workflow = legacy.workflow as { name: string; id: string | null };
      if (legacy.currentSession) patch.currentSession = legacy.currentSession as number | string;
      if (legacy.sessionWorkingDir !== undefined) patch.sessionWorkingDir = legacy.sessionWorkingDir as string | null;

      set(patch);
    },
  };
}, { name: 'AppStore' }));

// ── Convenience getter for non-React code ──────────────────────────────────
export function getAppState(): AppState {
  return useAppStore.getState();
}

export function getAppActions(): AppActions {
  return useAppStore.getState();
}
