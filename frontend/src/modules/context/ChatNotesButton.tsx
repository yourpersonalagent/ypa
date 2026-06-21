// ChatNotesButton — the notepad-icon "context" button in the chat input bar.
//
// Standalone replica of the inline button that previously lived in
// ChatView.tsx (the `<button id="chat-notes-btn" class="chat-bar-btn notes-btn">`
// block). Click handling is intentionally NOT wired here: QuickContextPicker
// self-wires by `document.getElementById('chat-notes-btn')`, so as long as
// the rendered DOM keeps that id the popover keeps working untouched.
//
// Registered in component mode (not shorthand) so we can keep the
// `notes-btn` class — the shorthand path in ChatBarSlot only emits
// `class="chat-bar-btn"` and doesn't accept className extras.

export function ChatNotesButton() {
  return (
    <button className="chat-bar-btn notes-btn" id="chat-notes-btn" title="Context — pick from notes, mail, calendar, sessions, files">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
        <line x1="6" y1="8" x2="8" y2="8" />
        <line x1="6" y1="12" x2="8" y2="12" />
        <line x1="6" y1="16" x2="8" y2="16" />
        <line x1="11" y1="9" x2="16" y2="9" />
        <line x1="11" y1="13" x2="15" y2="13" />
      </svg>
    </button>
  );
}
