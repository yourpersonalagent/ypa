// render — generic render-handler registry.
//
// Public API:
//   render(text, format, opts) → { html, format, mime }
//   highlightInElement(el)     → run shiki on rendered code blocks (lazy)
//
// Handlers are pure functions. Data handlers (json, xml, csv, tsv) normalize
// their input to markdown and re-enter the markdown handler — there is
// exactly one rendering head, so markdown-it plugin changes and the raw
// toggle propagate to every format for free.
//
// Not wired into chat (intentional). Consumers:
//   • <RenderView text=… format=… raw=… />  — React viewer with raw toggle
//   • directly: const { html } = render(text, 'json'); el.innerHTML = html;
//     then highlightInElement(el).

import type { RenderFormat, RenderHandler, RenderOpts, RenderResult } from './types.js';
import { markdownHandler, highlightMarkdownInElement } from './handlers/markdown.js';
import { rawHandler, highlightRawInElement } from './handlers/raw.js';
import { jsonHandler } from './handlers/json.js';
import { xmlHandler } from './handlers/xml.js';
import { csvHandler, tsvHandler } from './handlers/csv.js';

const HANDLERS: Record<RenderFormat, RenderHandler> = {
  markdown: markdownHandler,
  raw:      rawHandler,
  json:     jsonHandler,
  xml:      xmlHandler,
  csv:      csvHandler,
  tsv:      tsvHandler,
};

export function render(
  text: string,
  format: RenderFormat,
  opts: RenderOpts = {},
): RenderResult {
  const handler = HANDLERS[format];
  if (!handler) {
    // Unknown format → raw. Beats throwing; keeps the registry forgiving for
    // future formats added by callers before the handler ships.
    return rawHandler(text, { ...opts, rawLang: format });
  }
  return handler(text, opts);
}

// Apply shiki to any rendered code in the element. Safe to call after
// every render() → innerHTML cycle. Idempotent on already-highlighted nodes.
export function highlightInElement(el: HTMLElement): void {
  highlightMarkdownInElement(el);
  highlightRawInElement(el);
}

// Resolve a format from a filename extension. Returns null if unknown — the
// caller decides whether to default to 'markdown' (for unknown text-like
// files) or 'raw' (for safety).
export function formatFromExt(filename: string): RenderFormat | null {
  const m = /\.([^.]+)$/.exec(filename.toLowerCase());
  if (!m) return null;
  switch (m[1]) {
    case 'md': case 'markdown': case 'mdx': return 'markdown';
    case 'json': case 'json5':              return 'json';
    case 'xml': case 'svg': case 'xhtml':   return 'xml';
    case 'csv':                             return 'csv';
    case 'tsv':                             return 'tsv';
    default:                                return null;
  }
}

export type { RenderFormat, RenderHandler, RenderOpts, RenderResult } from './types.js';

const MODULE_NAME = 'render';

export default {
  activate() {
    return { name: MODULE_NAME };
  },
  deactivate() {
    // No-op — registry is pure, no resources to release.
  },
};
