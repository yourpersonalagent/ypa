// Central color-theme + avatar palette config.
//
// Color-theme model: each *family* (default, minimal, ocean, sunset, …) has
// both a `dark` and a `bright` variant. The DOM carries both as data
// attributes so a single CSS rule can target either dimension:
//
//     <html data-theme="ocean" data-variant="dark">
//
// (`data-theme` and `data-variant` are kept as-is — they're scoped to color
// already, and renaming them would touch every CSS rule for negligible gain.
// See `frontend/css/COLOR-THEMES.md` for the structure.)
//
// Storage uses a combined `family-variant` string (e.g. `ocean-dark`),
// persisted under localStorage key `yha.colorTheme` and server pref
// `colorTheme`. Legacy `yha.theme` / `theme` are read once on hydrate then
// dropped — see appStore.ts and store.ts for the migration.
//
// Adding a new family:
//   1. Append to COLOR_THEME_FAMILIES below.
//   2. Add CSS blocks for both variants in `frontend/css/tokens.css`:
//        html[data-theme='<id>'][data-variant='dark'] { … }
//        html[data-theme='<id>'][data-variant='bright'] { … }
//      Generic dark/bright defaults are inherited from
//      `html[data-variant='dark|bright']` if a family doesn't override.
//   3. No JS wiring needed beyond that.

export interface ColorThemeFamilyDef {
  id: string;
  name: string;
  icon: string;
}

// Families cycled by the header button (in this order). The first entry is
// the default and inherits the generic dark/bright base from CSS without any
// family-specific overrides.
export const COLOR_THEME_FAMILIES: ColorThemeFamilyDef[] = [
  { id: 'default', name: 'Default', icon: '✦' },
  { id: 'minimal', name: 'Minimal', icon: '◐' },
  { id: 'ocean', name: 'Ocean', icon: '🌊' },
  { id: 'sunset', name: 'Sunset', icon: '🌅' },
  { id: 'contrast', name: 'High contrast', icon: '◑' },
  { id: 'kinetic', name: 'Kinetic', icon: '⚡' },
  { id: 'kawaii', name: 'Kawaii', icon: '❀' },
  { id: 'neural', name: 'Neural', icon: '◈' },
  { id: 'ochre', name: 'Ochre', icon: '◉' },
  { id: 'fable', name: 'Fable', icon: '✶' },
  { id: 'prism', name: 'Prism', icon: '◇' },
  { id: 'void', name: 'Void', icon: '○' },
  { id: 'smoke', name: 'Smoke', icon: '▫' },
  { id: 'shade', name: 'Shade', icon: '◆' },
];

export type ColorThemeVariant = 'dark' | 'bright';
export const COLOR_THEME_VARIANTS: ColorThemeVariant[] = ['dark', 'bright'];

export const DEFAULT_COLOR_THEME_FAMILY = 'default';
export const DEFAULT_COLOR_THEME_VARIANT: ColorThemeVariant = 'dark';
export const DEFAULT_COLOR_THEME = `${DEFAULT_COLOR_THEME_FAMILY}-${DEFAULT_COLOR_THEME_VARIANT}`;

export interface ParsedColorTheme {
  family: string;
  variant: ColorThemeVariant;
}

// Parse any stored value (incl. legacy 'dark'/'bright' from before color
// themes shipped) into family + variant. Unknown families fall back to
// default.
export function parseColorThemeId(id: string | null | undefined): ParsedColorTheme {
  if (!id) return { family: DEFAULT_COLOR_THEME_FAMILY, variant: DEFAULT_COLOR_THEME_VARIANT };
  // Legacy single-segment ids: dark/bright became default-dark/default-bright;
  // a previous iteration of this module used bare family ids — minimal was a
  // light theme, ocean and sunset were dark.
  if (id === 'dark') return { family: 'default', variant: 'dark' };
  if (id === 'bright') return { family: 'default', variant: 'bright' };
  if (id === 'minimal') return { family: 'minimal', variant: 'bright' };
  if (id === 'ocean') return { family: 'ocean', variant: 'dark' };
  if (id === 'sunset') return { family: 'sunset', variant: 'dark' };

  const dash = id.lastIndexOf('-');
  if (dash <= 0) return { family: DEFAULT_COLOR_THEME_FAMILY, variant: DEFAULT_COLOR_THEME_VARIANT };
  const family = id.slice(0, dash);
  const variant = id.slice(dash + 1);
  const validFamily = COLOR_THEME_FAMILIES.some((t) => t.id === family) ? family : DEFAULT_COLOR_THEME_FAMILY;
  const validVariant: ColorThemeVariant = variant === 'bright' ? 'bright' : 'dark';
  return { family: validFamily, variant: validVariant };
}

export function buildColorThemeId(family: string, variant: ColorThemeVariant): string {
  return `${family}-${variant}`;
}

export function isValidColorTheme(id: string | null | undefined): boolean {
  if (!id) return false;
  if (id === 'dark' || id === 'bright' || id === 'minimal' || id === 'ocean' || id === 'sunset') return true;
  const dash = id.lastIndexOf('-');
  if (dash <= 0) return false;
  const family = id.slice(0, dash);
  const variant = id.slice(dash + 1);
  return COLOR_THEME_FAMILIES.some((t) => t.id === family) && (variant === 'dark' || variant === 'bright');
}

export function nextColorThemeFamily(current: string): string {
  const i = COLOR_THEME_FAMILIES.findIndex((t) => t.id === current);
  return COLOR_THEME_FAMILIES[(i < 0 ? 0 : i + 1) % COLOR_THEME_FAMILIES.length].id;
}

export function prevColorThemeFamily(current: string): string {
  const len = COLOR_THEME_FAMILIES.length;
  const i = COLOR_THEME_FAMILIES.findIndex((t) => t.id === current);
  const k = i < 0 ? 0 : (i - 1 + len) % len;
  return COLOR_THEME_FAMILIES[k].id;
}

export function colorThemeFamilyName(id: string): string {
  return COLOR_THEME_FAMILIES.find((t) => t.id === id)?.name ?? id;
}

export function colorThemeFamilyIcon(id: string): string {
  return COLOR_THEME_FAMILIES.find((t) => t.id === id)?.icon ?? '🎨';
}

// Apply a color-theme id to <html>. Sets both data-theme (family) and
// data-variant (dark/bright) so CSS can target either dimension. Returns
// the canonical stored form (post-migration) so callers can persist it.
export function applyColorThemeToDom(id: string | null | undefined): string {
  const parsed = parseColorThemeId(id);
  const root = document.documentElement;
  const prevFamilyAttr = root.getAttribute('data-theme');
  const prevVariantAttr = root.getAttribute('data-variant');
  root.setAttribute('data-theme', parsed.family);
  root.setAttribute('data-variant', parsed.variant);
  // Notify subscribers (FloatingPet's theme-tint, etc.) that the color
  // theme changed so they can re-read --accent / --accent-2 without needing
  // a hard reload. Distinct from `yha:bg-theme` (which fires only when the
  // background-shader theme changes) — color-theme switches don't go
  // through bg.ts at all, which is why theme-tinted pets used to look
  // stale until the next page load. Skips the dispatch if nothing actually
  // changed so callers can call this idempotently.
  if (parsed.family !== prevFamilyAttr || parsed.variant !== prevVariantAttr) {
    try {
      window.dispatchEvent(new CustomEvent('yha:color-theme', {
        detail: { family: parsed.family, variant: parsed.variant },
      }));
    } catch { /* ignore (test/SSR env) */ }
  }
  return buildColorThemeId(parsed.family, parsed.variant);
}

// ── Avatar palette ────────────────────────────────────────────────────────
// 7 slots. Concrete colours live in tokens.css (`--avatar-1` … `--avatar-7`)
// and change per color theme. We store the CSS-var reference as the
// symbolColor value so a theme switch automatically retints existing avatars.

export const AVATAR_SLOTS = [1, 2, 3, 4, 5, 6, 7] as const;
export type AvatarSlot = (typeof AVATAR_SLOTS)[number];

export const AVATAR_LABELS: Record<AvatarSlot, string> = {
  1: 'Green',
  2: 'Blue',
  3: 'Orange',
  4: 'Purple',
  5: 'Coral',
  6: 'Amber',
  7: 'Teal',
};

export const AVATAR_VAR = (slot: AvatarSlot | number): string => `var(--avatar-${slot})`;

export const DEFAULT_AVATAR = AVATAR_VAR(1);

const LEGACY_HEX_TO_SLOT: Record<string, AvatarSlot> = {
  '#00e08a': 1,
  '#5cc8ff': 2,
  '#ff9a3d': 3,
  '#b06aff': 4,
  '#ff5e7a': 5,
  '#ffd87a': 6,
  '#00c8b4': 7,
};

export function resolveAvatarColor(stored: string | undefined | null): string {
  if (!stored) return DEFAULT_AVATAR;
  if (stored.startsWith('var(')) return stored;
  if (stored.startsWith('--')) return `var(${stored})`;
  const slot = LEGACY_HEX_TO_SLOT[stored.toLowerCase()];
  if (slot) return AVATAR_VAR(slot);
  return stored;
}

export interface AvatarChoice {
  slot: AvatarSlot;
  value: string;
  label: string;
  swatchBg: string;
}

export const AVATAR_CHOICES: AvatarChoice[] = AVATAR_SLOTS.map((slot) => ({
  slot,
  value: AVATAR_VAR(slot),
  label: AVATAR_LABELS[slot],
  swatchBg: AVATAR_VAR(slot),
}));

export function avatarColorsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  return resolveAvatarColor(a) === resolveAvatarColor(b);
}
