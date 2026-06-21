# `messenger` layout

**Design intent:** A persistent left rail listing sessions, and a chat
pane on the right. No top header bar; header actions move into the
command palette and a compact icon strip at the top of the rail.

## Chrome inventory

- `SessionRail` (left, ~280 px) — session list + compact action strip
- `ChatPane` (right) — messages + composer

## Respected appStore fields

| Field | Effect |
|-------|--------|
| `colorTheme` | inherited from <html> |
| `layoutMode` | drives `[data-layout="messenger"]` |
| `currentSession`, session list | used by SessionRail |

**Ignored** (full-only fields): `viewMode`, `viewSplit`, `viewSwap`,
`viewOrient`, `headerOpen`, `headerOrient`. Switching back to `full`
must restore the user's split state, so this layout never *writes* to
these fields.

## Chat-bar visibility

Messenger only keeps the essentials on the input bar:

- Left: `#chat-file` (filepicker), voice module's `#chat-mic` +
  `#chat-voicemode` buttons.
- Right: `#chat-model-btn` + `.cap-group` capability badges, and the
  `.cb-right-send` send/stop pair.

Everything else (`#chat-cmd`, `.session-group`, `#chat-notes-btn`,
`#chat-skills-btn`, `#chat-sys-btn`, `.ef-inline-wrap`) is hidden via
`css/layouts/messenger.css`. All of those remain reachable through the
command palette under the `chat` group (see `bootstrap-core-commands.ts`).
