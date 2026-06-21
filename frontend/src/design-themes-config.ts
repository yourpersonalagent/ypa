// Design themes — the third top-level visual axis.
//
//   data-theme   → colour *family*  (default | minimal | ocean | …) — see color-themes-config.ts
//   data-variant → dark or bright                                  — see color-themes-config.ts
//   data-layout  → which top-level layout component renders the app — see layouts/index.ts
//   data-design  → overall design language (Console | Atelier | Patchbay)  ← THIS FILE
//
// A design theme controls typography, decorative chrome, default accent
// colour, and surface treatment. It composes with the colour theme + layout:
// pick Atelier with Ocean Bright on Messenger, or Patchbay with Default Dark
// on Full — the three axes are orthogonal.
//
// Each design ships its own native palette (Atelier = paper/ink/verdigris,
// Patchbay = graphite/ember/lime). When a colour-theme family overrides those
// vars, the colour theme wins. The design always wins on fonts, borders, and
// chrome treatment — those have no concept inside the colour-theme axis.
//
// Adding a new design:
//   1. Append a `{ id, name, icon, description }` entry below.
//   2. Add a `html[data-design='<id>'] { … }` block in
//      `frontend/css/designs/<id>.css` (link it in yha.html + index.html).
//   3. No JS wiring needed beyond that.

export interface DesignThemeDef {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export const DESIGN_THEMES: DesignThemeDef[] = [
  {
    id: 'console',
    name: 'Console',
    icon: '▎',
    description: "The original YHA look — terminal-flavoured boutique AI.",
  },
  {
    id: 'atelier',
    name: 'Atelier',
    icon: '◳',
    description: 'Editorial, boutique. Bone paper, deep ink, verdigris accent.',
  },
  {
    id: 'patchbay',
    name: 'Patchbay',
    icon: '◧',
    description: 'Control surface. Warm graphite + ember + acid lime.',
  },
];

// First-time default = Atelier (dark variant — see the inline boot scripts
// in yha.html and index.html for the variant pairing). Users who have
// previously selected a design keep their choice; the localStorage value
// takes precedence over this default everywhere it's read.
export const DEFAULT_DESIGN_THEME = 'atelier';

export function isValidDesignTheme(id: string | null | undefined): boolean {
  if (!id) return false;
  return DESIGN_THEMES.some((t) => t.id === id);
}

export function resolveDesignTheme(id: string | null | undefined): string {
  return isValidDesignTheme(id) ? (id as string) : DEFAULT_DESIGN_THEME;
}

export function designThemeName(id: string): string {
  return DESIGN_THEMES.find((t) => t.id === id)?.name ?? id;
}

export function designThemeIcon(id: string): string {
  return DESIGN_THEMES.find((t) => t.id === id)?.icon ?? '◇';
}

export function nextDesignTheme(current: string): string {
  const i = DESIGN_THEMES.findIndex((t) => t.id === current);
  return DESIGN_THEMES[(i < 0 ? 0 : i + 1) % DESIGN_THEMES.length].id;
}

// Apply a design-theme id to <html data-design="…">. Emits a
// `yha:design-theme` event so subscribers (canvases, pet sprite tinting, etc.)
// can re-read CSS vars after the swap. Idempotent — no event if unchanged.
export function applyDesignThemeToDom(id: string | null | undefined): string {
  const next = resolveDesignTheme(id);
  if (typeof document === 'undefined') return next;
  const root = document.documentElement;
  const prev = root.getAttribute('data-design');
  root.setAttribute('data-design', next);
  if (prev !== next) {
    try {
      window.dispatchEvent(new CustomEvent('yha:design-theme', { detail: { design: next } }));
    } catch { /* ignore (test/SSR env) */ }
  }
  return next;
}
