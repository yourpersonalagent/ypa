// Tutorial type contracts.
//
// The tour is *data*, not hard-coded JSX (see tutorial-script.ts). Every
// step resolves its highlight target lazily at display time so the tour
// stays correct as the UI changes: a step whose target has vanished is
// skipped automatically, and steps that enumerate live registries
// (header icons, prefs tabs, chat-bar buttons) pick up new module
// features with zero tutorial edits.

/** Where the explanation card sits relative to the spotlighted target. */
export type TutorialPlacement = 'top' | 'right' | 'bottom' | 'left' | 'center' | 'auto';

export interface TutorialStep {
  /** Stable id, unique across the whole tour. */
  id: string;
  /** Section id (welcome | composer | views | header | prefs | finish | …)
   *  — drives the grouped progress readout. */
  group: string;
  /** Section display label for the progress readout. */
  groupLabel: string;
  title: string;
  /** One or two sentences. Plain text; rendered as-is. */
  body: string;
  /**
   * Resolve the element(s) to spotlight, called every time the step is
   * shown (after `before` runs). Return `null`/`[]` for a centered card
   * with no spotlight. Multiple elements are highlighted by their union
   * bounding box — used for "tour this whole row" group steps.
   */
  target?: () => Element | Element[] | null;
  placement?: TutorialPlacement;
  /**
   * Side effect run before the step renders — open a panel, switch a
   * layout, focus the composer. May be async; the overlay awaits it.
   */
  before?: () => void | Promise<void>;
  /**
   * Side effect run when leaving the step in *either* direction (next or
   * back). Use to undo a `before` (e.g. close the panel it opened) only
   * when the neighbouring step doesn't need it — keep these idempotent.
   */
  after?: () => void | Promise<void>;
  /**
   * When the target resolves empty, keep the step as a centered card
   * instead of skipping it. Default false (skip — the graceful path for
   * removed features).
   */
  keepIfNoTarget?: boolean;
}

export interface TutorialSection {
  id: string;
  label: string;
  /**
   * Build this section's steps from the live registries + DOM. Called
   * once when the tour starts; individual step targets are still resolved
   * lazily at display time.
   */
  build: () => TutorialStep[];
}
