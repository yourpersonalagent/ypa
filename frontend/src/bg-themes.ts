// ── WebGL background animations removed ──────────────────────────────────────
// Previously held 13 GLSL shader themes: YHA plasma globe, matrix glyph rain,
// stars, grid, console, pixel, black-hole, accretion disc, jet, nebula,
// saturn rings, diamond facets, solar-storm. Removed because even with the
// canvas hidden the CSS filter chain (contrast, blur, mix-blend-mode) forced
// Chrome to re-composite at 60fps on every vsync, costing 33-35% GPU
// constantly — even while idle, even with "No animation" selected. RIP.

export interface BgTheme {
  id: string;
  name: string;
  description: string;
  frag: string;
}

export interface BgColors {
  accent:  [number, number, number];
  accent2: [number, number, number];
  accent3: [number, number, number];
  bg:      [number, number, number];
  fg:      [number, number, number];
}

export const BG_VERT = '';
export const DEFAULT_BG_THEME = 'none';

export const BG_THEMES: BgTheme[] = [
  { id: 'none', name: '⊘ No animation', description: 'Animations removed due to GPU overhead.', frag: '' },
];

export function getBgTheme(_id: string): BgTheme {
  return BG_THEMES[0];
}

export function readBgColors(): BgColors {
  return {
    accent:  [0, 0, 0],
    accent2: [0, 0, 0],
    accent3: [0, 0, 0],
    bg:      [0, 0, 0],
    fg:      [0, 0, 0],
  };
}
