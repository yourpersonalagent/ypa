// raw — html-escape the input and wrap in <pre><code class="language-…">.
// Used when caller passes opts.raw=true, regardless of source format.
// shiki post-processes the <code> if a known language class is present.

import type { RenderFormat, RenderHandler } from '../types';
import { shikiHighlightElement } from '../../../vendor.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Mapping format → shiki language. csv/tsv have no syntax to highlight, so
// they fall back to 'text'. Keep this table tiny — anything not listed uses
// the format name (shiki silently ignores unknown languages).
const FORMAT_TO_LANG: Partial<Record<RenderFormat, string>> = {
  markdown: 'markdown',
  json: 'json',
  xml: 'xml',
  csv: 'text',
  tsv: 'text',
  raw: 'text',
};

export function renderRawHtml(text: string, format: RenderFormat, rawLang?: string): string {
  const lang = rawLang ?? FORMAT_TO_LANG[format] ?? format;
  return `<pre class="render-raw"><code class="language-${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>`;
}

// Caller mounts the html into an element, then runs this to apply shiki
// in-place. Mirrors the chat-side pattern (shikiHighlightElement after
// markdown-it render).
export function highlightRawInElement(el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>('pre.render-raw > code').forEach(shikiHighlightElement);
}

export const rawHandler: RenderHandler = (text, opts) => ({
  html: renderRawHtml(text, 'raw', opts.rawLang),
  format: 'raw',
  mime: 'text/html; charset=utf-8',
});
