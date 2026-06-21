// Tutorial run-state store (zustand) + first-run / completion persistence.
//
// Navigation lives here because moving between steps is more than an index
// bump: it runs each step's `before`/`after` side effects, skips steps whose
// target has vanished (the graceful path for removed UI), and tears down the
// Preferences modal when the tour leaves that section.

import { create } from 'zustand';
import { prefs } from '../preferences.js';
import { buildTutorialSteps } from './tutorial-script.js';
import type { TutorialStep } from './tutorial-types.js';

// Bump when the tour changes enough that completed users should see it again.
export const TUTORIAL_VERSION = 1;
const LS_KEY = 'yha.tutorial';

interface TutorialRecord {
  version: number;
  completedAt?: number;
  skippedAt?: number;
}

function readRecord(): TutorialRecord | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as TutorialRecord) : null;
  } catch {
    return null;
  }
}

function writeRecord(patch: Partial<TutorialRecord>): void {
  try {
    const prev = readRecord();
    const next: TutorialRecord =
      prev && prev.version === TUTORIAL_VERSION
        ? { ...prev, ...patch, version: TUTORIAL_VERSION }
        : { version: TUTORIAL_VERSION, ...patch };
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* private mode / storage disabled — tour still works, just re-prompts */
  }
}

/** First-run gate: show automatically until completed or skipped for this version. */
export function shouldAutoStart(): boolean {
  const rec = readRecord();
  if (!rec || rec.version !== TUTORIAL_VERSION) return true;
  return !rec.completedAt && !rec.skippedAt;
}

// ── Displayability ──────────────────────────────────────────────────────────

/** A step shows if it has no target (centered), opts to stay, or resolves one. */
function isDisplayable(step: TutorialStep): boolean {
  if (!step.target) return true;
  if (step.keepIfNoTarget) return true;
  try {
    const t = step.target();
    const arr = Array.isArray(t) ? t : t ? [t] : [];
    return arr.length > 0;
  } catch {
    return false;
  }
}

async function runHook(fn?: () => void | Promise<void>): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch (err) {
    console.warn('[tutorial] step hook threw:', err);
  }
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface TutorialState {
  active: boolean;
  steps: TutorialStep[];
  index: number;
  source: string;
  /** Bumps whenever a transition settles — lets the overlay recompute. */
  tick: number;

  start: (opts?: { source?: string }) => Promise<void>;
  next: () => Promise<void>;
  back: () => Promise<void>;
  skip: () => void;
  finish: () => void;
}

export const useTutorialStore = create<TutorialState>((set, get) => {
  /**
   * Move toward `to` in the given direction, running `before` hooks and
   * skipping non-displayable steps. Closes Preferences when crossing out of
   * the prefs section. Returns the resolved index, or -1 if none remain.
   */
  async function advanceFrom(from: number, to: number, dir: 1 | -1): Promise<number> {
    const { steps } = get();
    const fromGroup = steps[from]?.group;
    let i = to;
    while (i >= 0 && i < steps.length) {
      const step = steps[i];
      // Section-boundary teardown: leaving prefs for anything else closes the
      // modal so it doesn't linger over the next spotlight.
      if (fromGroup === 'prefs' && step.group !== 'prefs') {
        try { prefs.close(); } catch { /* overridden lazily by PrefsModal */ }
      }
      await runHook(step.before);
      if (isDisplayable(step)) return i;
      i += dir;
    }
    return -1;
  }

  return {
    active: false,
    steps: [],
    index: 0,
    source: '',
    tick: 0,

    async start(opts) {
      const steps = buildTutorialSteps();
      set({ active: true, steps, index: 0, source: opts?.source ?? 'manual' });
      const first = await advanceFrom(0, 0, 1);
      if (first < 0) {
        set({ active: false });
        return;
      }
      set((s) => ({ index: first, tick: s.tick + 1 }));
    },

    async next() {
      const { active, index, steps } = get();
      if (!active) return;
      await runHook(steps[index]?.after);
      const resolved = await advanceFrom(index, index + 1, 1);
      if (resolved < 0) {
        get().finish();
        return;
      }
      set((s) => ({ index: resolved, tick: s.tick + 1 }));
    },

    async back() {
      const { active, index, steps } = get();
      if (!active || index <= 0) return;
      await runHook(steps[index]?.after);
      const resolved = await advanceFrom(index, index - 1, -1);
      if (resolved < 0) return; // nothing earlier is displayable — stay put
      set((s) => ({ index: resolved, tick: s.tick + 1 }));
    },

    skip() {
      const { active, index, steps } = get();
      if (!active) return;
      void runHook(steps[index]?.after);
      try { prefs.close(); } catch { /* noop */ }
      writeRecord({ skippedAt: Date.now() });
      set({ active: false, steps: [], index: 0 });
    },

    finish() {
      const { active, index, steps } = get();
      if (!active) return;
      void runHook(steps[index]?.after);
      try { prefs.close(); } catch { /* noop */ }
      writeRecord({ completedAt: Date.now() });
      set({ active: false, steps: [], index: 0 });
    },
  };
});

// Imperative handles for non-React callers (the `/tutorial` command, first-run
// arming) without going through a hook.
export const tutorial = {
  start: (opts?: { source?: string }) => void useTutorialStore.getState().start(opts),
  skip: () => useTutorialStore.getState().skip(),
  isActive: () => useTutorialStore.getState().active,
  shouldAutoStart,
};
