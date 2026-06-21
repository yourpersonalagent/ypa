// multichat-grid.ts — Network helpers for the inline multichat row design.
//
// History: this module used to render an absolute-positioned overlay grid
// covering .chat-scroll-wrap. That separate-canvas design was removed in
// favour of inline rendering: each user prompt produces a `multichat-turn`
// marker in the host session, and MessageList renders it as a row of
// mini-bubbles via the MultichatRow React component (one bubble per
// slot/agent). Clicking a mini-bubble switches to the agent's full session
// — every slot session is a complete, standalone chat.
//
// What's left here is just the network plumbing the chat input needs to
// post a turn to the group endpoint instead of the regular /v1/stream-direct/.

import { api } from '../api.js';

export const multichatGrid = {
  // True while the host session has an associated multichat group. Read by
  // chat.ts::send() to decide whether to post the user input to the group
  // turn endpoint instead of /v1/stream-direct/.
  isHost(session: { multichatGroupId?: string | null } | undefined): boolean {
    return !!session?.multichatGroupId;
  },

  async submitTurn(groupId: string, text: string): Promise<boolean> {
    if (!groupId || !text.trim()) return false;
    try {
      const r = await fetch(
        `${api.config.baseUrl}/v1/multichat/groups/${encodeURIComponent(groupId)}/turn`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Input: text }),
        }
      );
      if (!r.ok) {
        const errText = await r.text();
        console.error('multichat: turn failed', errText);
        return false;
      }
      return true;
    } catch (e) {
      console.error('multichat: turn error', e);
      return false;
    }
  },
};

export default multichatGrid;
