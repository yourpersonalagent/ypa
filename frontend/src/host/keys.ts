// Frontend register keys + declared singletons.
//
// Lists every register the plan (`YHA-modular-registers.md` §2.2)
// names for the SPA. Each `Slot` component (HeaderIconsSlot,
// PrefsTabsSlot, …) reads one register; each module's `index.ts`
// writes to one or more.
//
// Adding a new register: add a key here, add the entry shape inline,
// add a Slot component under `slots/` that subscribes to it via
// `useRegisterList()`.

import type { ReactNode, MouseEvent, ComponentType } from 'react';
import { declareRegister } from './registers.js';
import type { Register, RegisterEntryMeta } from './registers.js';

// ── Entry shapes ─────────────────────────────────────────────────────────

/**
 * Header icon button — the right-aligned icon row in `Shell.tsx`.
 *
 * Two flavours, exclusive:
 *  - **Component**: pass `component: SomeComponent` for buttons that
 *    own their own state (popovers, badges that read a store,
 *    multi-element layouts). The slot just renders it.
 *  - **Shorthand**: pass `title + icon + onClick` for a simple
 *    `<button class="hm-item">…</button>`. The slot renders a default
 *    `<DefaultHeaderIconButton>` for these.
 *
 * Mixing — providing both `component` and `icon`/`onClick` — picks
 * `component` and ignores the shorthand fields.
 */
export interface HeaderIconButton extends RegisterEntryMeta {
  /**
   * Which row-pair the icon lives in. `primary` = color-theme/bash/file-mgr/
   * remote-browser/prefs row (left of the secondary group). `secondary`
   * = context-gen/pet/user-info row (rightmost).
   */
  group: 'primary' | 'secondary';
  /** Full custom button component. Wins over the shorthand fields. */
  component?: ComponentType;
  /** Shorthand: tooltip / aria-label. */
  title?: string;
  /** Shorthand: inline SVG, emoji, or any ReactNode. */
  icon?: ReactNode | (() => ReactNode);
  /** Shorthand: click handler. */
  onClick?: (e: MouseEvent) => void;
  /** Optional badge function (returns count / dot text or null). */
  badge?: () => string | number | null;
  /** Raw DOM id, for legacy CSS / e2e selectors. */
  domId?: string;
  /** Custom className extras. */
  className?: string;
}

/** Header text-label collapsible (Personnel/Partner/Triggers/...). */
export interface HeaderActionButton extends RegisterEntryMeta {
  /** Section id used for `data-open` and `dispatchEvent('hs:open')`. */
  sectionId: string;
  /** Body element id whose `hs:open` event fires when expanded. */
  bodyId: string;
  /** Button label. */
  label: string;
  /** Tooltip. */
  title?: string;
  /**
   * Optional react component to render in place of the default
   * `<div className="hs-body" />`. Allows panels to own their body.
   */
  body?: ComponentType<{ open: boolean }>;
}

/**
 * Header section — top-level entries in `<header class="header-actions">`.
 * Each section renders one of the chunks between separators (cwd, personnel,
 * partner, global-context, icons, plugins, …). The slot interleaves
 * `<div class="hm-sep" />` between consecutive sections and coordinates
 * mutually-exclusive open state across every section that declares a
 * `sectionId` — opening one closes the others, and an `hs:open` event is
 * dispatched on `bodyId` so panels that lazy-load can fetch on demand.
 *
 * Sections without a `sectionId` (e.g. the icons row) always render with
 * `open=false` and a no-op `onToggle`.
 */
export interface HeaderSectionProps {
  /** True when this section is the currently-open one. */
  open: boolean;
  /** Caller-supplied toggle — no-op for sections without a `sectionId`. */
  onToggle: () => void;
}

export interface HeaderSection extends RegisterEntryMeta {
  /** Section id participating in the open/toggle group (e.g. `'hs-cwd'`). */
  sectionId?: string;
  /** Body element id whose `hs:open` event fires when expanded. */
  bodyId?: string;
  /** Renders the section body. Owns its own DOM (button + body markup). */
  component: ComponentType<HeaderSectionProps>;
  /**
   * Display label when the section is opened as a drawer panel in non-full
   * layouts (messenger / zen). Setting this also opts the section into the
   * `/` command palette auto-wrap as `header.section.<short-id>`, where
   * `<short-id>` is `sectionId` with any leading `hs-` stripped. Sections
   * without a `panelLabel` stay invisible to messenger/zen and the palette.
   */
  panelLabel?: string;
  /**
   * Extra keywords for the auto-generated palette command. The short-id is
   * always included; this list seeds additional synonyms.
   */
  panelKeywords?: string[];
}

/** Chat-input bar button — left or right of the input. */
export interface ChatBarButton extends RegisterEntryMeta {
  side: 'left' | 'right';
  group?: 'send' | 'context' | 'session' | 'voice' | 'capability' | string;
  title: string;
  /**
   * Full custom component. When provided, the slot renders it directly
   * and ignores `icon`, `label`, `onPress`, `domId`, and `variant`.
   * Use for buttons that own their own state (mic recording toggle, etc.).
   */
  component?: ComponentType;
  icon?: ReactNode | (() => ReactNode);
  label?: string;
  /** onPress is required for shorthand buttons (component-less entries). */
  onPress?: (ctx: ChatBarPressCtx) => void;
  variant?: 'default' | 'primary' | 'destructive';
  /** Raw DOM id placed on the rendered <button>. Legacy CSS / e2e / click-wiring. */
  domId?: string;
}
export interface ChatBarPressCtx {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  valueRef: React.MutableRefObject<string>;
  sessionId: string | null;
  cwd: string | null;
}

/** Chat-input submit interceptor — modules can intercept slash commands. */
export interface ChatSubmitInterceptor extends RegisterEntryMeta {
  /**
   * Called before a message is sent. Return `true` to consume the input
   * (cleared + send suppressed); `false` to pass through.
   */
  handle(text: string, ctx: ChatSubmitCtx): boolean;
}
export interface ChatSubmitCtx {
  sessionId: string | null;
  cwd: string | null;
}

/**
 * Visual cluster a prefs tab belongs to in the settings rail. Every tab
 * declares one so the rail can render grouped section headers instead of one
 * long flat list. The four groups map to a user's mental model of the agent:
 *  - `intelligence` — the mind: provider keys, models, runtime harness, prompts.
 *  - `capabilities` — what it can do: tools, skills, MCP, search, partners.
 *  - `workspace`    — how it looks & feels to you: appearance, identity, input.
 *  - `platform`     — the plumbing & admin: modules, deps, updates, usage, API.
 *
 * Rail render order + display labels live in `PREFS_TAB_GROUPS` (below); the
 * rail renders groups in that array's order and sorts tabs within a group by
 * their register `order`.
 */
export type PrefsTabGroupId = 'intelligence' | 'capabilities' | 'workspace' | 'platform';

/** Ordered group metadata for the settings rail — the source of truth for
 *  both which groups exist, the order they render in, and their headers. */
export const PREFS_TAB_GROUPS: ReadonlyArray<{ id: PrefsTabGroupId; label: string }> = [
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'workspace',    label: 'Workspace' },
  { id: 'platform',     label: 'Platform' },
];

/** Prefs modal tab. */
export interface PrefsTab extends RegisterEntryMeta {
  label: string;
  icon?: ReactNode;
  /**
   * Settings-rail cluster this tab lives under. Required — every tab declares
   * its group so the rail can render grouped section headers. See
   * `PrefsTabGroupId` for the four groups and `PREFS_TAB_GROUPS` for their
   * render order + labels.
   */
  group: PrefsTabGroupId;
  /**
   * Visibility under the simple/advanced view toggle.
   *  - `'all'`     — always shown.
   *  - `'partial'` — always shown, but the tab body uses
   *    `body.dataset.prefsView` to hide some inner sections in simple view.
   *  - `null`      — advanced-only.
   */
  simpleMode: 'all' | 'partial' | null;
  /**
   * Tab body component. Receives an optional `close` callback so tabs
   * with explicit "Done"/"Save & close" affordances can dismiss the
   * modal; existing tabs ignore the prop.
   */
  component: ComponentType<{ close?(): void }>;
}

/** View overlay button (view-mode / orient / split). */
export interface ViewMenuButton extends RegisterEntryMeta {
  label: string;
  icon?: ReactNode;
  onClick: (e: MouseEvent) => void;
}

/** Chat minimap marker producer. */
export interface MinimapMarker extends RegisterEntryMeta {
  produce(messages: ReadonlyArray<unknown>): MinimapMarkerDescriptor[];
}
export interface MinimapMarkerDescriptor {
  id: string;
  /** Index of the source message in the chat list. */
  messageIndex: number;
  /** Marker kind for CSS class (`user`, `assistant`, `tool`, `note`, …). */
  kind: string;
  /** Optional title for the marker tooltip. */
  title?: string;
}

/** Welcome-message client renderer. */
export interface WelcomeMessageRenderer extends RegisterEntryMeta {
  /** Matches `welcomeMessages[].id` on the bridge. */
  greetingId: string;
  component: ComponentType<{ payload: unknown }>;
}

/** Session-picker drop-in slot region. */
export type SessionPickerRegion =
  | 'header' | 'belowSessions' | 'aboveTodos' | 'belowTodos'
  | 'aboveServe' | 'belowServe' | 'footer';

export interface SessionPickerSlotEntry extends RegisterEntryMeta {
  region: SessionPickerRegion;
  component: ComponentType<{ cwd: string | null; sessionId: string | null }>;
}

/** Extra rows in the CWD-bound dropdown. */
export interface CwdDropdownEntry extends RegisterEntryMeta {
  component: ComponentType<{ cwd: string }>;
}

/** Compact button entry for the shared "Actions" row in the CWD dropdown.
 *  Modules register a single button (icon/label/onClick); a single shared
 *  cwd-sub header renders ONLY when at least one entry is registered. */
export interface CwdActionButton extends RegisterEntryMeta {
  /** Button label / text content. */
  label: string;
  /** Tooltip. */
  title?: string;
  /** Raw DOM id. Set if legacy code wires clicks via getElementById
   *  (e.g. RcloneModal looks up #btn-cwd-rclone). */
  domId?: string;
  /** Optional click handler. Skip when legacy DOM-id wiring is used. */
  onClick?: (e: MouseEvent) => void;
  /** Hide button without unregistering — e.g. KnowledgeButtons toggles
   *  visibility based on MCP state. Recomputed per render. */
  when?: () => boolean;
}

/** Harness type entry — Claude Code / Codex / Aider / Pi etc. Each is owned
 *  by its own FE module so disabling the bridge module hides the toggle
 *  and config UI in lockstep. */
export interface HarnessTypeEntry extends RegisterEntryMeta {
  type: string;       // unique short id used in localStorage keys + config: 'claude' | 'codex' | 'aider' | 'pi'
  label: string;      // display label, e.g. "Claude Code"
  category: 'subscription' | 'single-account';
  binStorageKey: string;
  configBinKey: string;
  /** Optional short description of the harness/integration route. */
  description?: string;
  /** Optional note about token/cost accounting limitations or fallbacks. */
  tokensNote?: string;
  /** Optional note about resume behavior and streamed event parity. */
  resumeAndEventsNote?: string;
  /** Build the copy-pasteable "log in to this account" command shown in the
   *  Harness prefs UI. `platform` is the bridge SERVER's OS (process.platform):
   *  templates pick the right shell syntax — bash `KEY=val cmd` on
   *  linux/darwin, PowerShell `$env:KEY='val'; & cmd` on win32. */
  authCmdTemplate: (binary: string, isolatedHome: string, configDir: string, platform?: string) => string;
  /** Optional extra config UI rendered between the toggles row and the
   *  standard subscription/single-account section. Use this for harness-specific
   *  config like "Claude Code runtime" or "Codex exec mode". */
  configSection?: ComponentType<{
    config: Record<string, unknown>;
    base: string;
    onRenderAll: () => void;
    enabled: boolean;
  }>;
}

/** Extra buttons in the FilePicker footer (e.g. file-manager "Manage…"). */
export interface FilePickerAction extends RegisterEntryMeta {
  component: ComponentType<{ currentPath: string; closeModal(): void }>;
}

/**
 * Global hotkey binding — registered into the central `<KeyboardShortcuts>`
 * component so modules can add shortcuts without each owning their own
 * `useHotkeys` call. Core hotkeys remain hardcoded in
 * `frontend/src/KeyboardShortcuts.tsx`; this register is for module-owned
 * additions only.
 */
export interface HotkeyBinding extends RegisterEntryMeta {
  /** Comma-separated key combo string accepted by react-hotkeys-hook (e.g. "alt+m", "ctrl+s,meta+s"). */
  keys: string;
  /** Short description for a future "shortcuts cheat sheet" UI. */
  description?: string;
  /** Handler. Receives the KeyboardEvent. */
  handler: (e: KeyboardEvent) => void;
  /** Optional: matches react-hotkeys-hook scope. Default 'global'. */
  scope?: string;
  /** If true, hotkey fires even when an input/textarea has focus. Default false. */
  enableInInputs?: boolean;
}

/**
 * Workflow editor HUD button — rendered in the `<WorkflowHudSlot />` inside
 * the editor canvas. Modules register entries here; the slot renders them in
 * order with `<div class="hud-sep"/>` dividers between different `hudGroup`
 * values. Auto-wrapped as `workflow.*` commands in the App Command Palette.
 *
 * Two flavours (exclusive):
 *  - **Component**: pass `component` for buttons that own their own state
 *    (WorkflowHudButton renders the picker popover, RecordToggle owns its mic).
 *  - **Shorthand**: pass `icon + onClick + domId` for a simple hud-btn.
 */
export interface HudButton extends RegisterEntryMeta {
  /** Display label in the command palette. */
  label: string;
  /** Button tooltip (title attr). Shown on hover. */
  title?: string;
  /** DOM id placed on the rendered <button>. Palette clicks this id. */
  domId?: string;
  /** Symbol / text to render as the button content (shorthand only). */
  icon?: ReactNode;
  /** Click handler (shorthand only). */
  onClick?: () => void;
  /** Full custom component. Wins over shorthand fields. */
  component?: ComponentType;
  /** Extra CSS class names added to the rendered <button>. */
  className?: string;
  /**
   * Visual group name. The slot inserts a separator between buttons whose
   * `hudGroup` differs from the previous button's group.
   */
  hudGroup?: string;
  /** Optional state readback for palette active/value badges. */
  state?: () => AppCommandState;
  /** Extra palette fuzzy-match terms. */
  keywords?: string[];
}

/**
 * Voice-mode submit target — modules can redirect what voice mode does
 * with a finalised user turn. The first registered entry whose `enabled()`
 * returns true wins; if none match (or no modules are registered), voice
 * mode falls back to filling `#chat-ta` + clicking `#chat-send` (the
 * regular chat path).
 *
 * Today this is used by the pet module so that — when the user has opted in
 * via the pet popover — voice mode talks to the pet's dedicated chat lane
 * instead of the currently open chat session. The TTS / sentence-cut /
 * echo-filter / interrupt pipeline in VoiceMode.tsx is unchanged; only the
 * "answer source" is swapped.
 */
export interface VoiceSubmitTarget extends RegisterEntryMeta {
  /** Stable id (used for telemetry / debugging). */
  targetId: string;
  /** Cheap runtime gate. If `false`, this target is skipped and the next
   *  one (or the fallback) is tried. Re-called on every voice turn. */
  enabled?: () => boolean;
  /** Display-name shown in the voice-mode "speaker" label while this target
   *  is the active one. Optional — the speaker label otherwise comes from
   *  the `author` returned by `submit()`. */
  speakerName?: string;
  /** Color hint for the voice-mode avatar / speaker label. Optional. */
  speakerColor?: string;
  /**
   * Handle a finalised user turn. Should resolve with the answer text and
   * (optionally) author metadata so the voice modal's speaker nameplate
   * matches who's talking. Reject (or resolve with empty `answer`) to let
   * VoiceMode fall back to the regular chat path for this turn only.
   */
  submit(text: string, ctx: VoiceSubmitCtx): Promise<VoiceSubmitResult>;
  /**
   * Optional — called when the user interrupts (hard-interrupt keyword,
   * spoken-over the model, ESC, etc.). Targets that own an AbortController
   * should cancel here; others can ignore.
   */
  cancel?: () => void;
}
export interface VoiceSubmitCtx {
  /** Voice mode's current detected language (BCP47 short, e.g. 'en', 'de'). */
  lang: string;
}
export interface VoiceSubmitResult {
  /** The model's response text. Spoken via the existing TTS pipeline. */
  answer: string;
  /** Optional speaker metadata — drives the voice-mode top-of-modal name +
   *  avatar color. When absent the target's `speakerName`/`speakerColor`
   *  fields (or the generic AI fallback) are used. */
  author?: { name: string; color: string };
  /** Optional tools-used annotation for future debug UI; not rendered today. */
  toolsUsed?: string[];
}

/**
 * Text-to-Speech provider entry — voice mode picks one of these to read
 * model output aloud. Each entry implements the same minimal interface as
 * `BrowserTTS` (see `frontend/src/modules/voice/providers.ts`), so adding
 * a new provider (OpenAI, ElevenLabs, …) means dropping a module that
 * registers an entry here. Voice mode consults the user's `voice.tts.provider`
 * pref to pick the active one, falling back to `BrowserTTS` if the chosen
 * entry isn't registered (module disabled).
 */
export interface TtsProviderEntry extends RegisterEntryMeta {
  /** Provider id used in the prefs select (e.g. 'openai'). The built-in
   *  BrowserTTS is implied — it isn't registered here. */
  providerId: string;
  /** Display label shown in the prefs picker. */
  label: string;
  /**
   * Factory returning an object that matches the `TTSProvider` interface in
   * `voice/providers.ts`. Voice mode calls this once per modal open.
   */
  factory: () => {
    available(): boolean;
    speak(text: string, opts?: { lang?: string; onStart?: () => void; onEnd?: () => void; onError?: () => void }): void;
    cancel(): void;
    isSpeaking(): boolean;
  };
}

/**
 * Generic `panels` register — for "named overlay regions" addressed by
 * a slot id (chat-minimap, thoughts, ...). A `<PanelSlot id="…" />`
 * renders every registered entry whose `slotId` matches.
 *
 * This is the contract that minimap, welcome-messages, and other
 * single-component modules use to plug into Shell/ChatView without
 * core having to know they exist.
 */
export interface PanelEntry extends RegisterEntryMeta {
  slotId: string;
  component: ComponentType;
}

/**
 * App Command Palette entry — the `/` palette catalog (NOT the `#` Chat
 * Command Picker). One entry per app action: layout switch, color theme
 * pick, view toggle, prefs entry, module command, etc.
 *
 * Hierarchical addressing via dotted ids (`layout.set.zen`, `view.header.toggle`).
 * In the palette UI the dots translate to spaces — typing `layout set zen`
 * narrows to the matching entry. Users never see the dot form.
 *
 * `state()` is called whenever the palette re-renders so toggle / radio
 * entries can show `✓ active` and `value` badges (e.g. `visible` /
 * `hidden`). It must be cheap — call it sparingly inside.
 *
 * `run()` is the action. `ctx` provides direct handles to the appStore,
 * host (registers + bus), and dispatch helpers so entries don't have to
 * import them individually.
 */
export type AppCommandGroup =
  | 'chat'
  | 'layout'
  | 'color-theme'
  | 'design'
  | 'view'
  | 'model'
  | 'session'
  | 'cwd'
  | 'prefs'
  | 'panel'
  | 'header'
  | 'workflow'
  | 'harness'
  | 'debug'
  | 'rewind'
  | 'help'
  | `module:${string}`;

export interface AppCommandState {
  /** Renders as `✓` prefix in the dropdown — for currently-active toggles. */
  active?: boolean;
  /** Right-aligned badge text — current value (e.g. `visible`, `horizontal`). */
  value?: string;
}

export interface AppCommandCtx {
  /** Direct shortcut — equivalent to `getAppActions()`. */
  closePalette(): void;
}

export interface AppCommand extends RegisterEntryMeta {
  /** Group prefix in the dotted id — drives palette section + filter. */
  group: AppCommandGroup;
  /** Display label (sentence case). */
  label: string;
  /** Extra fuzzy-match terms (synonyms, aliases). */
  keywords?: string[];
  /** Lucide icon name (or any other key the palette renderer understands). */
  icon?: string;
  /** Optional fixed right-aligned badge (overrides `state().value`). */
  badge?: string;
  /** Imperative action. Receives helpers from the palette. */
  run(ctx: AppCommandCtx): void;
  /** Optional current-state readback for ✓ / value badge rendering. */
  state?(): AppCommandState;
}

/**
 * Settings Registry entry — a single setting that renders inside a prefs
 * tab AND auto-generates a matching palette command. Phase 4 of the
 * LayoutPlan: modules contribute *individual settings*, not whole tabs,
 * so the `/` palette can address each one (`/prefs enter-to-send`).
 *
 * Render contract: a `<PrefsEntriesSlot tab="<tabId>" />` placed anywhere
 * inside a prefs tab body renders every entry that declares that tab id.
 * Entries are sorted by `order` ascending, then by `label`.
 *
 * Palette command contract: a `prefs.<id>` AppCommand is auto-generated.
 *   • toggle  → flips the boolean each invocation
 *   • radio   → cycles through `options`
 *   • select  → opens the prefs modal scrolled to this entry
 *   • number / text → opens the prefs modal scrolled to this entry
 *   • action  → calls `set(true)` (the value is ignored)
 *
 * To opt out of the auto-command for a specific entry, set
 * `paletteCommand: false`.
 */
export type PrefsEntryType =
  | 'toggle'
  | 'radio'
  | 'select'
  | 'number'
  | 'text'
  | 'color-theme'
  | 'layout'
  | 'action';

export interface PrefsEntryOption {
  id: string;
  label: string;
}

export interface PrefsEntry extends RegisterEntryMeta {
  /** Which prefs tab id (matches `PrefsTab.id`) this entry renders inside. */
  tab: string;
  /** Display label in both the prefs tab and the palette. */
  label: string;
  /** Optional helper text shown beneath the control. */
  description?: string;
  /** Control type — drives render + palette-command behaviour. */
  type: PrefsEntryType;
  /** Read current value. Called on every render — keep cheap. */
  get(): unknown;
  /** Write a new value. */
  set(v: unknown): void;
  /** For `radio` / `select` — the set of allowed values. */
  options?: PrefsEntryOption[];
  /** Numeric inputs only. */
  min?: number;
  max?: number;
  step?: number;
  /** Extra search terms for the palette command. */
  keywords?: string[];
  /** Sort order within the tab. Default 100. */
  order?: number;
  /** Suppress the auto-generated palette command. Default false. */
  paletteCommand?: boolean;
}

// ── Declared register singletons ────────────────────────────────────────

export const registers = {
  headerIconButtons: declareRegister<HeaderIconButton>('headerIconButtons'),
  headerActionButtons: declareRegister<HeaderActionButton>('headerActionButtons'),
  headerSections: declareRegister<HeaderSection>('headerSections'),
  chatBarButtons: declareRegister<ChatBarButton>('chatBarButtons'),
  chatSubmitInterceptors: declareRegister<ChatSubmitInterceptor>('chatSubmitInterceptors'),
  prefsTabs: declareRegister<PrefsTab>('prefsTabs'),
  viewMenuButtons: declareRegister<ViewMenuButton>('viewMenuButtons'),
  chatMinimapMarkers: declareRegister<MinimapMarker>('chatMinimapMarkers'),
  welcomeMessageRenderers: declareRegister<WelcomeMessageRenderer>('welcomeMessageRenderers'),
  sessionPickerSlots: declareRegister<SessionPickerSlotEntry>('sessionPickerSlots'),
  cwdDropdownEntries: declareRegister<CwdDropdownEntry>('cwdDropdownEntries'),
  cwdActionButtons: declareRegister<CwdActionButton>('cwdActionButtons'),
  harnessTypes: declareRegister<HarnessTypeEntry>('harnessTypes'),
  filePickerActions: declareRegister<FilePickerAction>('filePickerActions'),
  hudButtons: declareRegister<HudButton>('hudButtons'),
  panels: declareRegister<PanelEntry>('panels'),
  hotkeys: declareRegister<HotkeyBinding>('hotkeys'),
  appCommands: declareRegister<AppCommand>('appCommands'),
  prefsEntries: declareRegister<PrefsEntry>('prefsEntries'),
  ttsProviders: declareRegister<TtsProviderEntry>('ttsProviders'),
  voiceSubmitTargets: declareRegister<VoiceSubmitTarget>('voiceSubmitTargets'),
};

export type FrontendRegisters = typeof registers;

// Backwards-typed alias so a slot can write `Register<HeaderIconButton>`
// without re-importing the inner generic.
export type Reg<K extends keyof FrontendRegisters> = FrontendRegisters[K];
// Type-only re-export so `Register` stays a referenced symbol for callers
// that need it via `keys.ts` (avoids the unused-import warning while
// keeping the type discoverable from the canonical entry point).
export type { Register };
