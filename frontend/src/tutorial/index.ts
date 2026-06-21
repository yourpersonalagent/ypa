// Tutorial wiring — registers the `/tutorial` app command (reachable from the
// Ctrl+P global palette and the inline `/` palette) and arms the first-run
// auto-start. The overlay itself is <Tutorial/>, mounted once in App.tsx.

import { registers } from '../host/keys.js';
import { tutorial, shouldAutoStart } from './tutorial-state.js';

let registered = false;

export function registerTutorial(): void {
  if (registered) return;
  registered = true;

  registers.appCommands.add(
    {
      id: 'tutorial.start',
      group: 'help',
      label: 'Start tutorial',
      icon: 'graduation-cap',
      keywords: [
        'tutorial', 'tour', 'help', 'onboarding', 'guide', 'intro',
        'walkthrough', 'getting started', 'learn',
      ],
      core: true,
      run: ({ closePalette }) => {
        closePalette();
        tutorial.start({ source: 'command-palette' });
      },
    },
    '<core>',
  );

  armFirstRun();
}

/** Auto-start once, after the chrome has mounted so spotlight targets exist. */
function armFirstRun(): void {
  if (!shouldAutoStart()) return;
  const tryStart = (attempt: number) => {
    if (!shouldAutoStart() || tutorial.isActive()) return;
    if (document.getElementById('chat-ta')) {
      tutorial.start({ source: 'first-run' });
      return;
    }
    if (attempt > 40) return; // ~8s budget, then give up quietly
    window.setTimeout(() => tryStart(attempt + 1), 200);
  };
  window.setTimeout(() => tryStart(0), 800);
}

export { Tutorial } from './Tutorial.js';
export { useTutorialStore, tutorial, TUTORIAL_VERSION } from './tutorial-state.js';
