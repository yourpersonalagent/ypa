# `zen` layout

**Design intent:** Absolute minimum. One centered column of chat,
`max-width: 720px`. No header, no rail, no buttons in view. Borderless,
sticky-bottom composer. Timeless and elegant.

## Chrome inventory

- A single `ChatPane`. Nothing else.

## Respected appStore fields

| Field | Effect |
|-------|--------|
| `colorTheme` | inherited from <html> |
| `layoutMode` | drives `[data-layout="zen"]` |

**Ignored**: everything else.

## Palette-only features

**All of them.** Zen layout is the test case for the palette being
sufficient. If anything *cannot* be done from `/` (in-chat) or `Ctrl+P`
(global) here, that's the bug to fix — not a reason to add a button.

Examples of what must be palette-reachable in zen:
- Layout switch back to full / messenger
- Color theme picker
- Model picker, CWD, session picker
- Every prefs entry, every module setting
- New session, rename, delete, export, import

## Status

Phase 2 scaffold. Composer styling, "did you know?" rotating palette tip
footer, and the proofed-by-zen palette audit happen in Phase 5b
(LayoutPlan.md).
