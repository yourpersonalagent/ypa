// xml — minimal pretty-print, then fence + delegate. Pretty-printer is a
// tag-balanced indenter; it does not parse, so malformed XML still renders
// (escaped) instead of erroring. For real validation, the caller should
// pre-validate.

import type { RenderHandler } from '../types';
import { markdownHandler } from './markdown.js';

function prettyXml(text: string): string {
  const tokens = text
    .replace(/>\s+</g, '><')
    .replace(/></g, '>\n<')
    .split('\n');
  let depth = 0;
  const out: string[] = [];
  for (const raw of tokens) {
    const line = raw.trim();
    if (!line) continue;
    const isClose = /^<\//.test(line);
    const isSelfClose = /\/>$/.test(line) || /^<\?/.test(line) || /^<!/.test(line);
    const isOpen = /^<[^/!?]/.test(line) && !isSelfClose;
    if (isClose) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + line);
    if (isOpen) depth += 1;
  }
  return out.join('\n');
}

export const xmlHandler: RenderHandler = (text, opts) => {
  if (opts.raw) {
    return markdownHandler(text, { raw: true, rawLang: 'xml' });
  }
  const pretty = prettyXml(text);
  const fenced = '```xml\n' + pretty + '\n```\n';
  const res = markdownHandler(fenced, {});
  return { ...res, format: 'xml' };
};
