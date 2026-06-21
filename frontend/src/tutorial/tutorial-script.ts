// Tutorial script — the ordered tour, generated from the live UI.
//
// Philosophy: describe *sections* and let each one enumerate the real
// registries + DOM at run time. Curated copy gives each area a short
// narrative; the actual targets (and the "…and these other controls"
// round-ups) are resolved from `registers.*` and the rendered DOM, so a
// module that adds a header icon, a prefs tab, or a chat-bar button is
// covered by the tour automatically — and a removed feature simply drops
// out (its step finds no target and is skipped).
//
// Order (LayoutPlan mental model): "use it now" → "control the
// workspace" → "customise it".

import { registers } from '../host/keys.js';
import { getAppActions, getAppState } from '../stores/appStore.js';
import { prefs } from '../preferences.js';
import type { TutorialSection, TutorialStep } from './tutorial-types.js';

// ── Resolver helpers ───────────────────────────────────────────────────────

/** Element is in the DOM and actually rendered (has a box). */
function isVisible(el: Element | null): el is Element {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

const byId = (id: string) => () => document.getElementById(id);
const bySel = (sel: string) => () => document.querySelector(sel);
/** First selector that resolves to a visible element wins. */
const byFirst = (...sels: string[]) => () => {
  for (const s of sels) {
    const el = document.querySelector(s);
    if (isVisible(el)) return el;
  }
  return null;
};
/** All visible matches — used for "highlight this whole row" group steps. */
const allVisible = (sel: string) => () =>
  Array.from(document.querySelectorAll(sel)).filter(isVisible);

/** Human label for a control, best-effort from its accessible attributes. */
function controlLabel(el: Element): string {
  const raw =
    el.getAttribute('title') ||
    el.getAttribute('aria-label') ||
    (el as HTMLElement).innerText ||
    '';
  // Titles often carry a "[Alt+F]" shortcut tail and a " — long help"
  // suffix; keep the leading human name only.
  return raw.split(/[—[\n]/)[0].trim();
}

/** Distinct labels of the visible matches for `sel`, capped at `max`. */
function labelsOf(sel: string, max = 6): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll(sel))) {
    if (!isVisible(el)) continue;
    const label = controlLabel(el);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/** Render a "X, Y and N more" tail from a label list. */
function joinLabels(labels: string[], total: number): string {
  if (!labels.length) return '';
  const more = total - labels.length;
  const list = labels.join(', ');
  return more > 0 ? `${list}, and ${more} more` : list;
}

// ── Section: welcome ────────────────────────────────────────────────────────

const welcome: TutorialSection = {
  id: 'welcome',
  label: 'Welcome',
  build: () => [
    {
      id: 'welcome.intro',
      group: 'welcome',
      groupLabel: 'Welcome',
      title: 'Welcome to YPA',
      body:
        'A quick tour of the places you’ll use most: the chat composer, the view ' +
        'controls, the header actions, and Preferences. You’re in control — skip ' +
        'or step through at your own pace.',
      placement: 'center',
    },
  ],
};

// ── Section: chat composer ──────────────────────────────────────────────────

const composer: TutorialSection = {
  id: 'composer',
  label: 'Chat composer',
  build: () => {
    const steps: TutorialStep[] = [];
    const barSel = '.chat-input-bar';

    steps.push({
      id: 'composer.input',
      group: 'composer',
      groupLabel: 'Chat composer',
      title: 'Type your request',
      body:
        'This is where work begins. Ask a question, describe a task, or paste ' +
        'files and images. Press Enter to send (Shift+Enter for a new line).',
      target: byId('chat-ta'),
      placement: 'top',
    });

    steps.push({
      id: 'composer.commands',
      group: 'composer',
      groupLabel: 'Chat composer',
      title: 'Commands: # and /',
      body:
        'Type # for chat tools (read, bash, MCP, skills) and / for app commands ' +
        '(themes, layouts, views, preferences). You can reopen this tour anytime ' +
        'with /tutorial.',
      target: byFirst('#chat-cmd', '.chat-input-bar .cmd-btn'),
      placement: 'top',
    });

    steps.push({
      id: 'composer.model',
      group: 'composer',
      groupLabel: 'Chat composer',
      title: 'Choose the model',
      body:
        'Pick which model answers, and toggle capabilities like vision or ' +
        'reasoning for the next message.',
      target: byFirst('#chat-model-btn', '.chat-input-bar .model-btn'),
      placement: 'top',
    });

    steps.push({
      id: 'composer.send',
      group: 'composer',
      groupLabel: 'Chat composer',
      title: 'Send or stop',
      body:
        'Send your message here. While a response is streaming this becomes a ' +
        'stop control, and a new message is injected into the running flow.',
      target: byFirst('#chat-send', '#chat-stop'),
      placement: 'top',
    });

    // Dynamic round-up — everything else in the bar that this tour didn't call
    // out by name. Picks up module-added buttons (voice, context, …) for free.
    const covered = new Set(['chat-ta', 'chat-cmd', 'chat-model-btn', 'chat-send', 'chat-stop']);
    const restSel = `${barSel} button`;
    const restEls = () =>
      Array.from(document.querySelectorAll(restSel)).filter(
        (el) => isVisible(el) && !covered.has(el.id),
      );
    const restLabels = restEls()
      .map(controlLabel)
      .filter((l, i, a) => l && a.indexOf(l) === i);
    if (restLabels.length) {
      steps.push({
        id: 'composer.more',
        group: 'composer',
        groupLabel: 'Chat composer',
        title: 'More composer controls',
        body:
          'The rest of the bar covers files, sessions, system prompt, and any ' +
          `tools your modules add: ${joinLabels(restLabels.slice(0, 6), restLabels.length)}.`,
        target: restEls,
        placement: 'top',
      });
    }

    return steps;
  },
};

// ── Section: view overlay ───────────────────────────────────────────────────

const views: TutorialSection = {
  id: 'views',
  label: 'View controls',
  build: () => {
    const steps: TutorialStep[] = [];

    steps.push({
      id: 'views.overlay',
      group: 'views',
      groupLabel: 'View controls',
      title: 'View controls',
      body:
        'This floating cluster controls your workspace layout. Drag the position ' +
        'arrows to move it to any edge of the screen.',
      target: byId('view-overlay'),
      placement: 'auto',
    });

    steps.push({
      id: 'views.layout-cycle',
      group: 'views',
      groupLabel: 'View controls',
      title: 'Switch layouts',
      body:
        'Click to cycle through Full, Messenger, and Zen layouts. Right-click for ' +
        'the previous one; hold to auto-cycle.',
      target: byFirst('#view-overlay [data-action="layout-cycle"]'),
      placement: 'auto',
    });

    steps.push({
      id: 'views.menu',
      group: 'views',
      groupLabel: 'View controls',
      title: 'Show / hide the header',
      body:
        'Toggles the top header bar. Hold it to flip the header between a top bar ' +
        'and a side rail.',
      target: byFirst('#view-overlay [data-action="menu"]'),
      placement: 'auto',
    });

    // Dynamic round-up of whatever else the overlay currently exposes
    // (split, workflow, code view — gated by layout + enabled modules).
    const others = labelsOf('#view-overlay button[title]', 8).filter(
      (l) => !/layout|menu/i.test(l),
    );
    if (others.length) {
      steps.push({
        id: 'views.more',
        group: 'views',
        groupLabel: 'View controls',
        title: 'More view options',
        body: `Depending on your layout and modules you’ll also find: ${others.join(', ')}.`,
        target: allVisible('#view-overlay button'),
        placement: 'auto',
      });
    }

    return steps;
  },
};

// ── Section: header ─────────────────────────────────────────────────────────

const header: TutorialSection = {
  id: 'header',
  label: 'Header actions',
  build: () => {
    const steps: TutorialStep[] = [];

    // The header only exists (and is only visible) in the full layout. Make
    // sure it's open before we point at it; the steps self-skip otherwise.
    const ensureHeaderOpen = () => {
      const st = getAppState();
      if (st.layoutMode === 'full' && !st.headerOpen) {
        getAppActions().setHeaderOpen(true);
      }
    };

    steps.push({
      id: 'header.overview',
      group: 'header',
      groupLabel: 'Header actions',
      title: 'The header',
      body:
        'Session-level controls live up here: your working directory, context, ' +
        'personnel, and quick-action icons.',
      target: byFirst('.header-actions', '#header'),
      placement: 'bottom',
      before: ensureHeaderOpen,
    });

    // Header section dropdowns — enumerated from the live `headerSections`
    // register. Each section that declares a panelLabel renders a `btn-<id>`
    // toggle in the full-layout header.
    const sections = registers.headerSections
      .list()
      .filter((s) => s.sectionId && s.panelLabel)
      .map((s) => ({ short: s.sectionId!.replace(/^hs-/, ''), label: s.panelLabel! }));
    if (sections.length) {
      const ids = sections.map((s) => `#btn-${s.short}`);
      steps.push({
        id: 'header.sections',
        group: 'header',
        groupLabel: 'Header actions',
        title: 'Header panels',
        body:
          'These open drawers for the bigger areas: ' +
          `${sections.map((s) => s.label).join(', ')}. Click one to expand it.`,
        target: () => ids.map((id) => document.querySelector(id)).filter(isVisible),
        placement: 'bottom',
        before: ensureHeaderOpen,
      });
    }

    // Icon buttons row (theme, terminal, file manager, prefs, …) — enumerated
    // live from the `headerIconButtons` register for the body copy.
    const iconLabels = registers.headerIconButtons
      .list()
      .map((b) => (b.title || '').split(/[—[]/)[0].trim())
      .filter(Boolean);
    steps.push({
      id: 'header.icons',
      group: 'header',
      groupLabel: 'Header actions',
      title: 'Quick-action icons',
      body: iconLabels.length
        ? `One-click actions: ${joinLabels(iconLabels.slice(0, 6), iconLabels.length)}.`
        : 'One-click actions for common tasks live in this icon row.',
      target: byFirst('.hm-row-pair-group', '.header-actions'),
      placement: 'bottom',
      before: ensureHeaderOpen,
    });

    steps.push({
      id: 'header.prefs',
      group: 'header',
      groupLabel: 'Header actions',
      title: 'Preferences',
      body: 'Open Settings & Preferences from here — we’ll look inside next.',
      target: byFirst('#btn-prefs'),
      placement: 'bottom',
      before: ensureHeaderOpen,
    });

    // Global command palette — no persistent on-screen anchor, so a centered
    // card. Kept (keepIfNoTarget) because it's a key discoverability message.
    steps.push({
      id: 'header.command-palette',
      group: 'header',
      groupLabel: 'Header actions',
      title: 'The command palette',
      body:
        'Press Ctrl+P (⌘K on Mac) anywhere to search every action, setting, theme, ' +
        'layout, and module command — including this tour (type “tutorial”).',
      placement: 'center',
      keepIfNoTarget: true,
    });

    return steps;
  },
};

// ── Section: preferences ────────────────────────────────────────────────────

const preferences: TutorialSection = {
  id: 'prefs',
  label: 'Preferences',
  build: () => {
    const firstTab = registers.prefsTabs.list()[0]?.id;
    const ensurePrefsOpen = () => { prefs.open(firstTab); };

    const tabLabels = registers.prefsTabs.list().map((t) => t.label);

    return [
      {
        id: 'prefs.modal',
        group: 'prefs',
        groupLabel: 'Preferences',
        title: 'Settings & Preferences',
        body:
          'Everything configurable lives here, grouped by area. Nothing changes ' +
          'during the tour — this is just orientation.',
        target: bySel('.prefs-modal-card'),
        placement: 'auto',
        before: ensurePrefsOpen,
        keepIfNoTarget: true,
      },
      {
        id: 'prefs.tabs',
        group: 'prefs',
        groupLabel: 'Preferences',
        title: 'Settings sections',
        body: tabLabels.length
          ? `Tabs are grouped into Intelligence, Capabilities, Workspace, and ` +
            `Platform — e.g. ${joinLabels(tabLabels.slice(0, 5), tabLabels.length)}.`
          : 'Tabs group settings by area; modules add their own.',
        target: byFirst('.prefs-rail'),
        placement: 'right',
        before: ensurePrefsOpen,
      },
      {
        id: 'prefs.view-toggle',
        group: 'prefs',
        groupLabel: 'Preferences',
        title: 'Simple vs Advanced',
        body:
          'Simple keeps common options visible; Advanced reveals everything. ' +
          'Switch whenever you need more control.',
        target: byFirst('.prefs-view-toggle'),
        placement: 'bottom',
        before: ensurePrefsOpen,
      },
      {
        id: 'prefs.close',
        group: 'prefs',
        groupLabel: 'Preferences',
        title: 'Close when you’re done',
        body: 'Changes apply as you make them. Close Preferences to return to chat.',
        target: byFirst('.prefs-close'),
        placement: 'left',
        before: ensurePrefsOpen,
      },
    ];
  },
};

// ── Section: finish ─────────────────────────────────────────────────────────

const finish: TutorialSection = {
  id: 'finish',
  label: 'Done',
  build: () => [
    {
      id: 'finish.done',
      group: 'finish',
      groupLabel: 'Done',
      title: 'You’re ready',
      body:
        'Start from the composer, press Ctrl+P for commands, and reopen this tour ' +
        'anytime with /tutorial. Enjoy YPA.',
      placement: 'center',
      before: () => { prefs.close(); },
    },
  ],
};

// ── Assembly ────────────────────────────────────────────────────────────────

/** Ordered sections — "use it now" → "control workspace" → "customise". */
export const TUTORIAL_SECTIONS: TutorialSection[] = [
  welcome,
  composer,
  views,
  header,
  preferences,
  finish,
];

/** Build the full ordered step list from every section's live builder. */
export function buildTutorialSteps(): TutorialStep[] {
  const steps: TutorialStep[] = [];
  for (const section of TUTORIAL_SECTIONS) {
    try {
      steps.push(...section.build());
    } catch (err) {
      console.warn(`[tutorial] section "${section.id}" build failed:`, err);
    }
  }
  return steps;
}
