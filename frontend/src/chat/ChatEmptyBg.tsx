// ── WebGL empty-chat backdrop removed ────────────────────────────────────────
// Previously rendered a fullscreen WebGL canvas behind the empty chat state,
// appearing after 6s of idle and running at ~10fps. Removed with the rest of
// the WebGL animation system — CSS filter chains on WebGL canvases force
// Chrome to re-composite at 60fps, costing significant GPU even while idle.
// The chat-empty-bg-on and chat-idle classes on #view-chat are now inert. RIP.

export function ChatEmptyBg() {
  return null;
}
