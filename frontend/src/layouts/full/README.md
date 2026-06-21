# `full` layout

**Design intent:** The original YHA layout. Header bar at top (or vertical
side), collapsible sections (projects / personnel / partner / triggers /
thoughts) plus a row of icon buttons, a chat / workflow split-view below,
the menu ViewOverlay floating bottom-or-top.

## Chrome inventory

- `#header` — collapsible, vertical or horizontal (`headerOrient`)
- Collapsible sections: projects, personnel, partner, triggers, thoughts
- `HeaderIconsSlot` — primary + secondary icon button rows
- `#main` → `#main-views` (chat + optional workflow split)
- `Splitter` between panes
- `WorkflowPicker` popover (when workflows-and-triggers module enabled)
- `ViewOverlay` — menu / view-mode toggle floating panel

## Respected appStore fields

| Field | Effect |
|-------|--------|
| `viewMode` | `'split' \| 'chat' \| 'workflow'` selects which pane is shown |
| `viewSplit` | 0..1 fraction of split between chat / workflow |
| `viewOrient` | `'h' \| 'v'` horizontal vs vertical split |
| `viewSwap` | swap which side chat lives on |
| `headerOpen` | header collapsed flag |
| `headerOrient` | `'h' \| 'v'` header orientation |
| `colorTheme` | inherited from <html> data-theme/data-variant |

These are *full-only* concepts. Other layouts read them only if they
make sense (typically none of them do).

## Palette-only features

None yet — Phase 3 introduces the command palette. After Phase 3, this
layout's palette will additionally expose every header button and prefs
entry through `/`.
