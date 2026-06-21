// ── Context Categorizer constants ─────────────────────────────────────────────
// Pure constants + types, shared by extract / llm / runner / admin. No state,
// no imports of internal modules — keeps the dependency tree acyclic.
'use strict';

const BATCH_SIZE        = 10;
const POLL_INTERVAL_MS  = 3 * 60 * 1_000;   // watchdog cadence: 3 minutes
// Per-request abort threshold. Bumped from 6 s to 15 s when the default
// model went from 8B → 70B (Llama-3.3-70B on NVIDIA NIM is typically
// 2–5 s but can spike to 10+ s under provider load). Watchdog cadence is
// 3 minutes so even a slow first request still finishes well inside it.
const CATEGORIZE_TIMEOUT_MS = 15_000;

// ── Stuck-session escape hatch (Phase 5.1, mirrors auto-title.ts) ─────────────
// Without a retry cap the categorizer can re-attempt the same deterministic
// failure (malformed model output, rate-limited provider, etc.) on every
// 3-minute watchdog tick, blocking the sorter forever. After
// MAX_CATEGORIZE_ATTEMPTS consecutive failures we promote the session to
// `category = 'general'` + `_categorySource = 'auto-skipped'` so the queue
// drains. The user can manually re-classify via /v1/config/categorizer/manual
// or wipe the marker via /force-retry to ask the model again.
const MAX_CATEGORIZE_ATTEMPTS = 3;
// The set of valid categories — must match section 3.2 of .ContextGenerator.MD.
const VALID_CATEGORIES: ReadonlyArray<string> = Object.freeze([
  'notes',           // ← Phase 1.10 — sessions containing inline #note messages or
                     //   user-typed `#note <text>` hashtags. Also assigned by the
                     //   deterministic pre-classifier (see _classifyNotesShortcut).
  'keep-notes',      // ← Phase 3.4d — file-based category, populated by the
                     //   "Import vault folder" workflow in the LINK tab. Sessions
                     //   are not auto-classified into this slug; it's reserved
                     //   for `docs/keep-notes/*.md` items surfaced via the
                     //   FILE_CATS path in `routes/context-items.ts`.
  'architecture',
  'frontend',
  'backend',
  'ai-models',
  'debugging',
  'integrations',
  'workflows',
  'data',
  'devops',
  'documentation',
  'experiments',
  'general',
]);
const CATEGORY_SET = new Set(VALID_CATEGORIES);

// Confidence threshold above which an auto-detected sensitivity is persisted.
// The doc explicitly forbids auto-promotion to user-visible without confirmation,
// so the only thing we write here is the *suggestion* — the actual confirm-gate
// lives in the route layer and frontend.
const SENSITIVITY_CONF_THRESHOLD = 0.8;

// ── Types ─────────────────────────────────────────────────────────────────────

interface CategorizerDebugRow {
  sid:               string;
  name:              string;
  category:          string | null;
  categorySource:    string | null;
  attempts:          number;
  skipReason:        string | null;
  skippedAt:         number | null;
  messageCount:      number;
  userPreview:       string;
  assistantPreview:  string;
  state:             'pending' | 'abandoned';
}

export {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  CATEGORIZE_TIMEOUT_MS,
  MAX_CATEGORIZE_ATTEMPTS,
  VALID_CATEGORIES,
  CATEGORY_SET,
  SENSITIVITY_CONF_THRESHOLD,
};

// Type-only export so other files can `import type` if needed.
export type { CategorizerDebugRow };
