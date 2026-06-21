// Hatch a YHA pet — shared types.
//
// The hatch feature lives entirely inside the YHA frontend. There is no
// Claude-Code skill, no API auth, no automatic image generation. The user
// copies the rendered prompts into Grok's web UI manually, downloads the
// resulting PNG (or strip), drops it into the wizard, and we slice +
// chroma-key client-side before persisting via the bridge.

// Mirror of the petStore PetMood vocabulary. Codex 9 canonical moods plus
// the two YHA-extras (reconnecting, fighting). Direction variants are
// intentionally absent — the per-pet `flipRun` toggle + CSS scaleX(-1)
// mirror the single `running` row for left-direction motion.
export type PetMood =
  | 'idle'
  | 'running'      // locomotion (also Codex row 1 canonical right walk)
  | 'streaming'    // busy / working
  | 'happy'        // wave / celebrate
  | 'error'        // stumble / failure
  | 'thinking'     // review / meditation
  | 'jumping'      // hop arc (vertical locomotion)
  | 'powermove'    // big-move action
  | 'xpeffect'     // reward burst
  | 'reconnecting' // YHA-extra: chat bridge reconnecting
  | 'fighting';    // YHA-extra: chat tool-call combat

/**
 * Canonical animation row name. The pet manifest's pose names ("idle",
 * "thinking", …) map to a *row* via {@link RowToMoodMap}; one row supplies
 * the frames for one pose.
 */
// RowName aligns 1:1 with the Codex 9-row canonical vocabulary. Row name
// == primary mood name == sprite folder/file prefix on disk. /hedge plans
// pick a subset of these; the prompt for each row lives next to it in
// animationRows.ts. `fighting` stays as a deferred YHA-extra row but is
// not part of the current plans.
export type RowName =
  | 'idle'
  | 'running'    // canonical right-facing locomotion (mirror handles left)
  | 'streaming'  // busy / working pulse
  | 'happy'      // wave / greet
  | 'error'      // stumble / failure reaction
  | 'thinking'   // review / focus
  | 'jumping'    // hop arc
  | 'powermove'  // big-move action
  | 'xpeffect'   // reward burst
  | 'fighting';  // YHA-extra (deferred — not in current plans)

/**
 * Functional category of an animation row.
 *
 *  - `state`      — loops that express the pet's current status (idle,
 *                   thinking, streaming, error, happy). These map directly
 *                   to PetMood values and are shown reactively.
 *  - `action`     — one-shot or looping spectaculars triggered explicitly by
 *                   the app (powermove, xpeffect, plus the deferred fighting
 *                   YHA-extra).
 *  - `locomotion` — movement-driven rows: the patrol controller picks these
 *                   while the pet is physically moving (running, jumping).
 *                   Not mood-driven; overridden at runtime. Left direction
 *                   uses the per-pet flipRun toggle + CSS mirror.
 */
export type RowCategory = 'state' | 'action' | 'locomotion';

export interface RowDefinition {
  /** Canonical row name. */
  name: RowName;
  /** Human-friendly label shown in the wizard's row cards and contact sheet.
   *  Intentionally separate from `name` so the internal file/mood naming
   *  stays stable while the UI wording can be plain English. */
  label: string;
  /** Functional category — controls how the patrol controller uses this row. */
  category: RowCategory;
  /** Frame count, tuned to OpenAI's hatch-pet timings. */
  frames: number;
  /** Per-frame durations in ms. Length must equal `frames`. */
  durations: number[];
  /** One-line summary used inside prompts (`{{row_purpose}}`). */
  purpose: string;
  /** State-specific rules block injected as `{{state_rules}}` bullet list. */
  stateRules: string[];
  /** Per-frame action descriptions, length === frames.
   *  Each description should be purely visual — describe what the pose looks
   *  like, not rendering constraints (those live in stateRules). */
  actions: string[];
  /** Layout for strip-mode generation (cols × rows in a 960×960 sheet). */
  stripLayout: { cols: number; rows: number };
}

/**
 * Character slots filled into prompt templates. The user supplies these
 * via the modal — either by picking an archetype (which seeds the slots)
 * or by free-form input that we lightly parse.
 *
 * Slots match `references/pet-archetypes.md` from the original draft.
 */
export interface CharacterSpec {
  /** Internal id, slug-safe (lowercase, no spaces). Used for paths. */
  id: string;
  /** Display name shown in the dropdown / pet bubble. */
  name: string;
  /** Body proportions phrase. */
  silhouette: string;
  /** Color list. */
  palette: string;
  /** Items the character holds or wears. */
  props: string;
  /** Describes the powermove pose's attached effect / signature beat. */
  signatureMove: string;
  /** Eye/mouth pattern. Default fallback applied if empty. */
  faceLanguage: string;
  /** Free-form extras. */
  styleNotes: string;
  /** Optional species hint ("human", "robot", "goblin", …). */
  species?: string;
}

/**
 * A plan picks which rows are generated for a given pet. The frame counts
 * stay fixed per row (defined in animationRows.ts); a plan only chooses
 * which rows to include.
 */
export type PlanName = 'full' | 'lite' | 'brawl';

export interface PlanDefinition {
  name: PlanName;
  label: string;
  /** Rows in the order the modal shows them. */
  rows: RowName[];
  /** Human-readable description shown in the wizard. */
  description: string;
}

/** Row → pose mapping. The manifest serves a pose; the row provides the frames. */
export interface RowToMoodEntry {
  row: RowName;
  /** Primary mood served by this row. */
  primary: PetMood;
  /** Optional secondary mood that re-uses the same frames as a fallback. */
  alias?: PetMood[];
}

/**
 * Per-frame entry persisted to the manifest. `src` is a path relative to
 * `/pets/<id>/`; `duration` comes from the row's durations array.
 */
export interface ManifestFrame {
  src: string;
  duration: number;
}

/**
 * One slot in the wizard. Tracks whether a row's strip has been uploaded
 * (and processed into individual frames) yet.
 */
export interface RowSlot {
  row: RowName;
  /** Local strip Blob (raw upload). Cleared after slicing. */
  stripBlob?: Blob | null;
  /** Object URL for previewing the raw strip. */
  stripPreviewUrl?: string | null;
  /** Per-frame Blob array, generated by slicing the strip. */
  frameBlobs?: Blob[];
  /** Per-frame object URLs for preview after chroma-key. */
  framePreviewUrls?: string[];
  /** True once frames have been written to the bridge. */
  uploaded?: boolean;
  /** Per-frame override blobs from the "re-roll a single frame" flow. */
  frameOverrides?: (Blob | null)[];
}

/**
 * Full wizard state. Stored in the hatchStore (zustand) so navigation
 * between steps and the chat surface does not destroy partial progress.
 */
export interface HatchState {
  step: 1 | 2 | 3 | 4;
  spec: CharacterSpec;
  plan: PlanName;
  baseBlob?: Blob | null;
  basePreviewUrl?: string | null;
  baseUploaded?: boolean;
  rows: Record<RowName, RowSlot>;
  /** Per-frame "re-roll" mode toggle for users who upload single 960×960 frames. */
  rerolls: Record<string, boolean>;
}

/**
 * Render mode for prompt template selection.
 *  - `strip`  — one 960×960 sheet containing all frames of a row
 *  - `single` — one 960×960 image of one frame (re-roll)
 */
export type RenderMode = 'strip' | 'single';
