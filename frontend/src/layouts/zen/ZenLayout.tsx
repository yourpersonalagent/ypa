// ZenLayout — Phase 5b of LayoutPlan.md.
//
// Intent: a single centered column of chat, no chrome, no buttons in view.
// Every function is reachable from the command palette (`/` in the chat
// composer or Ctrl+P globally). If anything *cannot* be done from the
// palette in zen mode, that's the bug to fix — never add a button here.
//
// Owns: a tiny rotating "tip" line at the very bottom of the column that
// teaches palette features ("Try /layout full to go back", etc.) so
// the layout teaches itself. Hides automatically as soon as the user
// sends the first message in the current session.
//
// Respected appStore fields: colorTheme, layoutMode. Ignores everything
// else.
//
// CSS: `frontend/css/layouts/zen.css`, scoped under `[data-layout="zen"]`.

import { useEffect, useMemo, useState } from 'react';
import { ChatView } from '../../chat/ChatView.js';
import { useChatStore } from '../../stores/chatStore.js';

const TIPS: string[] = [
  'Press / to open the command palette.',
  'Try /layout full to return to the default shell.',
  'Type /theme to pick a color theme.',
  'Ctrl+P (Cmd+K on Mac) opens the palette anywhere.',
  'Type /prefs to jump to any setting.',
  'Modules add their own commands under /module …',
  'Group rows in the palette expand on Enter — keyboard or click.',
];

function pickTip(seed: number): string {
  return TIPS[seed % TIPS.length];
}

export function ZenLayout() {
  const messageCount = useChatStore((s) => s.messages.length);
  const [seed] = useState(() => Math.floor(Math.random() * TIPS.length));
  const [showTip, setShowTip] = useState(true);
  const tip = useMemo(() => pickTip(seed), [seed]);

  // Hide the tip line once the user has actually started using the
  // session (a single message means they don't need the prompt anymore).
  useEffect(() => {
    if (messageCount > 0) setShowTip(false);
  }, [messageCount]);

  return (
    <main className="layout-zen">
      <div className="zen-column">
        <ChatView />
      </div>
      {showTip && (
        <footer className="zen-tip" aria-live="polite">
          <span className="zen-tip-text">{tip}</span>
        </footer>
      )}
    </main>
  );
}
