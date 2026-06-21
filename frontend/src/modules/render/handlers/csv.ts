// csv / tsv — normalize to a GFM markdown table, then delegate. Delimiter is
// auto-detected if the caller passes 'csv' but the data is clearly tab-heavy.
// Quoted cells (RFC 4180) are honored only for comma — tsv keeps it simple
// because real-world TSV almost never quotes.

import type { RenderFormat, RenderHandler } from '../types';
import { markdownHandler } from './markdown.js';

function detectDelim(text: string, requested: RenderFormat): ',' | '\t' {
  if (requested === 'tsv') return '\t';
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

// Minimal RFC-4180 row parser for comma-separated. Returns one row as a
// string[]; respects "" quoting and "" → " unescaping. The tab variant
// just splits — quoted tsv is rare and not worth the complexity here.
function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
    } else {
      if (ch === '"' && cur === '') { inQ = true; continue; }
      if (ch === ',') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function escapeCell(s: string): string {
  // markdown table cells: pipe + newline must be escaped/replaced.
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function toMarkdownTable(text: string, delim: ',' | '\t'): string {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  const rows = delim === ','
    ? lines.map(parseCsvRow)
    : lines.map((l) => l.split('\t'));
  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => r.concat(Array(cols - r.length).fill(''));
  const [head, ...body] = rows.map(pad);
  const headLine = '| ' + head.map(escapeCell).join(' | ') + ' |';
  const sepLine = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  const bodyLines = body.map((r) => '| ' + r.map(escapeCell).join(' | ') + ' |');
  return [headLine, sepLine, ...bodyLines].join('\n');
}

export const csvHandler: RenderHandler = (text, opts) => {
  if (opts.raw) {
    return markdownHandler(text, { raw: true, rawLang: 'text' });
  }
  const delim = detectDelim(text, 'csv');
  const table = toMarkdownTable(text, delim);
  const res = markdownHandler(table, {});
  return { ...res, format: delim === '\t' ? 'tsv' : 'csv' };
};

export const tsvHandler: RenderHandler = (text, opts) => {
  if (opts.raw) {
    return markdownHandler(text, { raw: true, rawLang: 'text' });
  }
  const table = toMarkdownTable(text, '\t');
  const res = markdownHandler(table, {});
  return { ...res, format: 'tsv' };
};
