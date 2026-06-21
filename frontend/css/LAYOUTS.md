# Layouts

YHA renders one of several top-level **layouts** based on `appStore.layoutMode`.
Each layout owns its own chrome (header, rails, composer position, etc.) and
its own stylesheet.

## Sandboxing rule

Every layout's CSS file is wrapped in `[data-layout="<name>"] { … }`. The
`<html>` element carries `data-layout` alongside `data-theme` and
`data-variant`:

```html
<html data-theme="ocean" data-variant="dark" data-layout="full">
```

No cross-bleed possible — a rule under `[data-layout="zen"]` cannot leak
into `messenger`, even if the selectors collide.

## Registered layouts

| `layoutMode` | Component | Stylesheet | Status |
|--------------|-----------|------------|--------|
| `full` | `frontend/src/layouts/full/FullLayout.tsx` | `css/layouts/full.css` | shipped — today's chrome verbatim |
| `messenger` | `frontend/src/layouts/messenger/MessengerLayout.tsx` | `css/layouts/messenger.css` | Phase 5a (Phase 2 scaffold) |
| `zen` | `frontend/src/layouts/zen/ZenLayout.tsx` | `css/layouts/zen.css` | Phase 5b (Phase 2 scaffold) |

## Adding a layout

1. Append the new id to the `LayoutMode` union in
   `frontend/src/stores/appStore.ts`.
2. Create `frontend/src/layouts/<name>/<Name>Layout.tsx` with the component.
3. Create `frontend/css/layouts/<name>.css` — wrap all rules in
   `[data-layout="<name>"] { … }`.
4. Link the stylesheet in `frontend/yha.html` alongside the others.
5. Register the component in `frontend/src/layouts/index.ts`.
6. Drop a `README.md` next to the component covering: design intent, chrome
   inventory, respected store fields, palette-only features.

## Store-field ownership

`viewMode`, `viewSplit`, `viewSwap`, `viewOrient`, `headerOpen`, and
`headerOrient` are **full-only**. Other layouts read these only if they
make sense (typically none of them do) and **never write to them** — that
way, switching back to full restores the user's previous split state.

`colorTheme`, `layoutMode`, model, session, CWD, and module-owned prefs
are layout-agnostic.

## Switching layouts

After Phase 3, layout switching is palette-only (`/` → `layout` group). No
header button is added for layout switching — that's the point of the
palette. The decision is documented in `LayoutPlan.md` open question #2.
