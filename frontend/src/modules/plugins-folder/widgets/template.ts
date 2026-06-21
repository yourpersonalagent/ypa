// Tiny templating + path-lookup helpers for declarative widgets.
//
// Path resolver: `getPath(obj, 'a.b.c')` walks dotted keys; numeric segments
// index arrays; missing intermediates return `undefined` silently. This is
// deliberately permissive — widgets render falsy values as blanks rather
// than crashing on shape drift.
//
// Template engine: a mustache subset. `{{name}}` interpolates the result
// of `getPath(scope, 'name')`. There is no `{{#if}}` / `{{#each}}` — the
// widget's structure provides the iteration, and conditionals are a
// signal to use the `markdown` widget instead.

export function getPath(scope: unknown, path: string): unknown {
  if (!path) return scope;
  const segs = path.split('.');
  let cur: any = scope;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const MUSTACHE_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function renderTemplate(tmpl: string, scope: unknown): string {
  if (!tmpl) return '';
  return tmpl.replace(MUSTACHE_RE, (_, key) => {
    const v = getPath(scope, key);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v); } catch { return ''; }
  });
}

// Coerce a value-of-unknown-shape to something we can stick in JSX.
export function toDisplay(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}
