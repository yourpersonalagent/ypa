// BashConsoleHeaderButton — header icon for opening the shared bash-console
// moveable window. Visibility is gated on whether the bash-console MCP server
// is up; click dispatches `yha:open-bash-console` for the MoveableWindow in
// modals/BashConsole.tsx to handle.
//
// Why this is its own component (not inline in Shell.tsx):
//   • It needs to subscribe to the centralised mcpStore so it can render
//     `null` (instead of a stray inline `display:none` div) when the MCP
//     server is offline. Returning `null` lets the surrounding flexbox layout
//     skip the slot entirely — no separator orphans, no zero-width gaps.
//   • The previous design wired a vanilla addEventListener('click') from
//     panels/BashConsole.tsx to a hard-coded `#btn-bash-console` element in
//     Shell.tsx. That coupling is gone — the header button now dispatches a
//     plain custom event and BashConsole.tsx listens for it (mirrors the
//     ServePreview / BrowserWindow open-event pattern).

import { useMcpRunning } from '../stores/mcpStore.js';

export function BashConsoleHeaderButton() {
  const mcpUp = useMcpRunning('bash-console');
  if (!mcpUp) return null;

  return (
    <button
      className="hm-item"
      id="btn-bash-console"
      title="Shared terminal — same persistent session used by LLM models"
      onClick={() => window.dispatchEvent(new CustomEvent('yha:open-bash-console'))}
    >
      <span className="hm-icon" aria-hidden="true">
        {/* Terminal prompt icon — a chevron + cursor underline, sized to
            match the file-manager / browser / prefs icons (14px, stroke 1.75).
            Picked the chevron-and-line motif rather than a full window frame
            so the icon reads as "shell" at icon-button size. */}
        <svg
          width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor"
          strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M4 6l5 6-5 6" />
          <path d="M12 18h8" />
        </svg>
      </span>
    </button>
  );
}
