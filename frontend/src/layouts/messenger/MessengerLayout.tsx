// MessengerLayout — persistent left rail of sessions (~280px) + chat pane
// on the right. No top header bar; header actions live in the command
// palette and a compact icon strip in the rail.
//
// Respected appStore fields: colorTheme, layoutMode. Ignores viewMode,
// viewSplit, viewSwap, viewOrient — those are full-only and writes to
// them by other layouts would clobber the full user's split state.
//
// Mobile (≤600px): WhatsApp-style single-pane navigation. The layout
// shows either the rail or the chat (never both) and the `msg-mobile-back`
// button inside chat returns to the list. The class on the root element
// toggles which pane is visible; the media query in messenger.css does the
// actual hiding so resizing back to desktop instantly restores both panes.
//
// CSS: `frontend/css/layouts/messenger.css`, scoped under
// `[data-layout="messenger"]`.

import { useState } from 'react';
import { ChatView } from '../../chat/ChatView.js';
import { SessionRail } from '../shared/SessionRail.js';
import { useSessionStore } from '../../stores/index.js';

export function MessengerLayout() {
  // Start in chat view when a session is already active (URL/localStorage); start
  // in list view when none is — matches the WhatsApp pattern of opening straight
  // into a conversation if one was already selected.
  const [mobileView, setMobileView] = useState<'list' | 'chat'>(
    () => (useSessionStore.getState().currentId ? 'chat' : 'list')
  );
  const currentId = useSessionStore((s) => s.currentId);
  const sessions  = useSessionStore((s) => s.sessions);
  const currentName = sessions.find((s) => String(s.id) === String(currentId))?.name || 'Untitled';
  return (
    <div className={`layout-messenger msg-mobile-${mobileView}`}>
      <aside className="msg-rail">
        <SessionRail onPickSession={() => setMobileView('chat')} />
      </aside>
      <main className="msg-chat">
        <button
          type="button"
          className="msg-mobile-back"
          aria-label="Back to sessions"
          title={currentName}
          onClick={() => setMobileView('list')}
        >
          <span className="msg-mobile-back-arrow" aria-hidden="true">←</span>
          <span className="msg-mobile-back-name">{currentName}</span>
        </button>
        <ChatView />
      </main>
    </div>
  );
}
