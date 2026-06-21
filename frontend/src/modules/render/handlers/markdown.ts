// markdown — uses the vendor.ts markdown-it singleton so parser config
// (breaks, linkify, task-lists) stays in lockstep with the chat renderer.
// Post-render highlighting via shiki is applied lazily by the caller after
// mount (see highlightMarkdownInElement) — same pattern MessageList uses.

import type { RenderHandler } from '../types';
import { md, shikiHighlightElement } from '../../../vendor.js';
import { renderRawHtml } from './raw.js';

export const markdownHandler: RenderHandler = (text, opts) => {
  if (opts.raw) {
    return {
      html: renderRawHtml(text, 'markdown', opts.rawLang),
      format: 'markdown',
      mime: 'text/html; charset=utf-8',
    };
  }
  const inner = md.render(text);
  return {
    html: `<div class="markdown-body render-markdown">${inner}</div>`,
    format: 'markdown',
    mime: 'text/html; charset=utf-8',
  };
};

// Run shiki on every <code class="language-…"> the markdown produced.
// Idempotent — re-running it on already-highlighted code is a no-op because
// shikiHighlightElement looks for 'language-…' on the live element and the
// shiki output strips that class via .shiki-highlighted marker.
export function highlightMarkdownInElement(el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>('pre > code[class*="language-"]').forEach((node) => {
    if (node.classList.contains('shiki-highlighted')) return;
    shikiHighlightElement(node);
  });
}
