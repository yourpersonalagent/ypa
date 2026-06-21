# Color themes

YHA's interface palette is a two-axis system:

| Axis | DOM attribute | Values | Source of truth |
|------|---------------|--------|-----------------|
| Family | `data-theme` | `default`, `minimal`, `ocean`, `sunset`, `contrast`, `kinetic`, `kawaii`, `neural`, `ochre`, `fable`, `prism`, `void`, `smoke`, `shade` | `frontend/src/color-themes-config.ts` → `COLOR_THEME_FAMILIES` |
| Variant | `data-variant` | `dark`, `bright` | same file → `COLOR_THEME_VARIANTS` |

`<html>` carries both attributes simultaneously, e.g.:

```html
<html data-theme="ocean" data-variant="dark" data-layout="classic">
```

Storage uses a combined `family-variant` string under:
- localStorage key `yha.colorTheme`
- server pref key `colorTheme`

Legacy `yha.theme` / pref `theme` are read once on hydrate and migrated to the
new name (see `stores/appStore.ts` and `store.ts`).

## Why kept as `data-theme` (not `data-color-theme`)

Renaming the DOM attribute would touch every CSS rule in `tokens.css` plus
every layout stylesheet for negligible benefit — the attribute is already
scoped to color. The *concept* and *code symbols* are now "color theme" so the
attribute name reads as a shorthand.

## CSS structure (`tokens.css`)

Each family ships two CSS blocks — one per variant. Generic dark/bright
defaults are defined at the top of the file and inherited if a family doesn't
override them.

```css
/* Generic variant defaults */
html[data-variant='dark']  { --bg: #0a0a0a; --fg: #f0f0f0; … }
html[data-variant='bright'] { --bg: #fafafa; --fg: #0a0a0a; … }

/* Family overrides */
html[data-theme='ocean'][data-variant='dark']   { --accent: #5cc8ff; … }
html[data-theme='ocean'][data-variant='bright'] { --accent: #0077c0; … }
```

## Adding a new family

1. Append a `{ id, name, icon }` entry to `COLOR_THEME_FAMILIES` in
   `frontend/src/color-themes-config.ts`.
2. Add two CSS blocks in `frontend/css/tokens.css` (dark + bright variant).
3. No JS wiring needed.

## Events

When `applyColorThemeToDom()` changes the family or variant, it dispatches
`yha:color-theme` on `window` with `{ detail: { family, variant } }`.
Subscribers that need to re-read `--accent` / `--accent-2` (e.g. theme-tinted
pet sprites, custom canvases) listen for this event.

Distinct from `yha:bg-theme`, which fires only when the *background-shader*
theme changes (`frontend/src/bg-themes.ts`).

## Avatar palette

Avatar colors live in the same config file because they're palette-bound:
slots `--avatar-1` … `--avatar-7` are defined per color theme in
`tokens.css`. Stored values use `var(--avatar-N)` so a theme switch
automatically retints existing avatars. Legacy hex values (`#00e08a`, etc.)
are migrated to the corresponding slot via `resolveAvatarColor()`.
