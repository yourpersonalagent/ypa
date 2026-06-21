# Design themes

YHA's *design theme* is the third top-level visual axis — alongside the
two-axis color theme (`data-theme` + `data-variant`) and the layout shell
(`data-layout`). It controls typography, decorative chrome, and the design's
own default accent palette.

| `designTheme` | `data-design` | Stylesheet | Spirit |
|---------------|---------------|------------|--------|
| `console` (default) | `console`  | `console.css`  | Original YHA — terminal-flavoured boutique AI |
| `atelier`           | `atelier`  | `atelier.css`  | Editorial. Bone paper, deep ink, verdigris accent |
| `patchbay`          | `patchbay` | `patchbay.css` | Control surface. Graphite + ember + acid lime |

`<html>` carries the four axis attributes simultaneously:

```html
<html data-theme="ocean" data-variant="dark" data-layout="full" data-design="atelier">
```

## How the axes compose

| Axis | What it controls |
|------|------------------|
| `data-design`  | Fonts (display / body / mono), decorative chrome, native accent fallback, surface treatment (paper grain / grid backdrop), default border-radius, default border weight |
| `data-theme` + `data-variant` | Concrete colour values — `--bg`, `--fg`, `--accent`, `--accent-2`, `--avatar-*` |
| `data-layout`  | Top-level shell — header position, sidebar layout, composer placement |

When colour-theme and design-theme both have an opinion about a value
(e.g. `--accent`), the colour-theme wins because its block runs *after* the
design block in the cascade. Design themes therefore set their native
palette under `html[data-design='…']` only — *without* the variant/family
attributes — which has lower specificity than the colour-theme blocks that
are always combined-selector matches.

## Storage

- localStorage key: `yha.designTheme`
- Server pref: `designTheme`
- Inline boot script in `yha.html` and `index.html` reads localStorage and
  sets `data-design` before any CSS arrives, so the first paint uses the
  user's chosen design.

## Adding a new design

1. Append `{ id, name, icon, description }` to `DESIGN_THEMES` in
   `frontend/src/design-themes-config.ts`.
2. Create `frontend/css/designs/<id>.css` with rules scoped under
   `html[data-design='<id>']`.
3. Link the stylesheet in `frontend/yha.html` and `frontend/index.html` —
   order: after `tokens.css` (so design vars can be overridden by colour
   themes), before layout shells (so design fonts/borders are inherited).
4. No JS wiring needed beyond that — the system picker (Appearance section)
   and the `/` command palette read from `DESIGN_THEMES` automatically.

## Events

When `applyDesignThemeToDom()` changes the value, it dispatches
`yha:design-theme` on `window` with `{ detail: { design } }`. Subscribers
that need to re-read fonts/colours (e.g. canvas-rendered chrome) listen for
this event the same way they already listen for `yha:color-theme`.

## Responsive contract

Every design ships responsive rules that mirror the layout breakpoints
(`max-width: 720px` and `max-width: 480px`). Decorative chrome scales or
collapses on small screens — never overflows. Fonts use `clamp()` so display
sizes adapt continuously between mobile and desktop.
