// Branding — runtime app-naming rebrand for pre-launch marketing tests.
//
// The bridge reads INTERNAL_APP_NAMING and INTERNAL_APP_SLOGAN from its
// .env and serves them at `/brand.js` as `window.__YHA_BRAND = { name,
// slogan }`. That script is loaded synchronously from both index.html and
// yha.html so the values are available before any other module imports
// this file.
//
// Public API:
//   appName()   → configured name, or 'YHA' if not configured
//   appSlogan() → configured slogan, or the default "Your Home Agent · …"
//   applyBrandToDom() → updates <title>, data-brand-name, data-brand-slogan
//                       at boot. Idempotent; safe to call multiple times.
//
// Components that hardcode "YHA" / "Your Home Agent" can import appName()
// / appSlogan() to stay in sync at render time. Static strings inside the
// landing HTML (which doesn't go through React) are picked up by the DOM
// walker in `applyBrandToDom`.

const DEFAULT_NAME = 'YHA';
const DEFAULT_SLOGAN = 'Your Home Agent · Home is where your agent lives.';

interface BrandPayload {
  name?: string | null;
  slogan?: string | null;
}

function read(): BrandPayload {
  if (typeof window === 'undefined') return {};
  const b = (window as unknown as { __YHA_BRAND?: BrandPayload }).__YHA_BRAND;
  return b || {};
}

export function appName(): string {
  const v = read().name;
  return v && v.trim() ? v.trim() : DEFAULT_NAME;
}

export function appSlogan(): string {
  const v = read().slogan;
  return v && v.trim() ? v.trim() : DEFAULT_SLOGAN;
}

export function isBrandOverridden(): boolean {
  const b = read();
  return !!(b.name && b.name.trim()) || !!(b.slogan && b.slogan.trim());
}

// Boot-time pass: updates the document title, then walks any element marked
// with `data-brand-name` or `data-brand-slogan` and replaces its text. This
// covers the static HTML on the landing page (which is not rendered by
// React); React components should call appName() / appSlogan() directly so
// they stay reactive across re-renders.
export function applyBrandToDom(): void {
  if (typeof document === 'undefined') return;
  if (!isBrandOverridden()) return;
  const name = appName();
  const slogan = appSlogan();

  // <title> — strip the literal "YHA" token and re-prepend the configured
  // name so the rest of the title (e.g. " — Self-hosted AI orchestration")
  // survives.
  try {
    const t = document.title || '';
    document.title = t.replace(/YHA\b/g, name).replace(/Your Home Agent/g, slogan);
  } catch { /* ignore */ }

  // Targeted nodes — opt-in via data attributes. Used by the landing
  // page's masthead and any future hand-marked element.
  document.querySelectorAll<HTMLElement>('[data-brand-name]').forEach((el) => {
    el.textContent = name;
  });
  document.querySelectorAll<HTMLElement>('[data-brand-slogan]').forEach((el) => {
    el.textContent = slogan;
  });
}
