// json — pretty-print + delegate to the markdown handler as a fenced block.
// Wrapping in a markdown fence (instead of producing the <pre> directly)
// keeps the single-rendering-head property: shiki highlighting and any
// future markdown-it plugin (admonitions, etc) apply uniformly.

import type { RenderHandler } from '../types';
import { markdownHandler } from './markdown.js';

function tryPretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not valid JSON — render the input as-is so the user sees their bytes,
    // not an error.
    return text;
  }
}

export const jsonHandler: RenderHandler = (text, opts) => {
  if (opts.raw) {
    return markdownHandler(text, { raw: true, rawLang: 'json' });
  }
  const pretty = tryPretty(text);
  const fenced = '```json\n' + pretty + '\n```\n';
  const res = markdownHandler(fenced, {});
  return { ...res, format: 'json' };
};
