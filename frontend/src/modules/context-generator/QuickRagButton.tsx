// QuickRagButton — chat-bar trigger for the context-rag picker.
//
// Click handling is intentionally NOT wired here: QuickRagPicker self-wires
// by `document.getElementById('chat-rag-btn')`, mirroring the
// ChatNotesButton / QuickContextPicker pair. As long as the rendered DOM
// keeps that id the popover stays attached untouched.

import { Zap } from '../../chat/icons.js';

export function QuickRagButton() {
  return (
    <button
      className="chat-bar-btn rag-btn"
      id="chat-rag-btn"
      title="RAG — search vector DBs and attach hits to the next message"
    >
      <Zap size={13} strokeWidth={2} />
    </button>
  );
}
