// Live-preview decorations for markdown — Obsidian-style.
//
// Mounts on top of @codemirror/lang-markdown's syntax tree. Source markdown
// stays in the buffer (so file save = exactly what was typed), but the view
// styles rendered content (heading sizes, bold/italic, link colour, …) and
// hides syntax markers (`#`, `**`, `_`, backticks, `[]()`) on lines the
// cursor isn't on. Move the cursor onto a styled line and the markers
// re-appear so the user can edit them.

import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

const hideDeco = Decoration.replace({});

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  for (const r of view.state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

// Push a hide-decoration, clamping to the line containing `from`. ViewPlugins
// can't replace ranges that contain a newline — that's only legal in state
// fields — so we drop the range if it would cross a line boundary.
function pushHide(
  ranges: Range<Decoration>[],
  doc: EditorView['state']['doc'],
  from: number,
  to: number,
): void {
  if (from >= to) return;
  const line = doc.lineAt(from);
  const safeTo = Math.min(to, line.to);
  if (safeTo <= from) return;
  ranges.push(hideDeco.range(from, safeTo));
}

function decorate(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        const name = node.type.name;

        // ── ATX heading: `# Heading` ─────────────────────────────────
        const hm = /^ATXHeading([1-6])$/.exec(name);
        if (hm) {
          const level = parseInt(hm[1], 10);
          const line = doc.lineAt(node.from);
          ranges.push(Decoration.line({ class: `cm-md-h cm-md-h${level}` }).range(line.from));
          if (!selectionTouches(view, line.from, line.to)) {
            const mark = node.node.getChild('HeaderMark');
            if (mark) {
              let end = mark.to;
              if (doc.sliceString(end, end + 1) === ' ') end += 1;
              pushHide(ranges, doc, mark.from, end);
            }
          }
          return;
        }

        // ── Setext heading title lines (underline stays visible — a
        // hide-decoration crossing the newline isn't allowed in a plugin) ──
        if (name === 'SetextHeading1' || name === 'SetextHeading2') {
          const level = name === 'SetextHeading1' ? 1 : 2;
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(node.to);
          for (let i = startLine.number; i < endLine.number; i++) {
            ranges.push(Decoration.line({ class: `cm-md-h cm-md-h${level}` }).range(doc.line(i).from));
          }
          return;
        }

        // ── Bold **x** ───────────────────────────────────────────────
        if (name === 'StrongEmphasis') {
          ranges.push(Decoration.mark({ class: 'cm-md-strong' }).range(node.from, node.to));
          if (!selectionTouches(view, node.from, node.to)) {
            node.node.getChildren('EmphasisMark').forEach((c) => {
              pushHide(ranges, doc, c.from, c.to);
            });
          }
          return;
        }

        // ── Italic *x* / _x_ ─────────────────────────────────────────
        if (name === 'Emphasis') {
          ranges.push(Decoration.mark({ class: 'cm-md-em' }).range(node.from, node.to));
          if (!selectionTouches(view, node.from, node.to)) {
            node.node.getChildren('EmphasisMark').forEach((c) => {
              pushHide(ranges, doc, c.from, c.to);
            });
          }
          return;
        }

        // ── Strikethrough ~~x~~ (GFM) ───────────────────────────────
        if (name === 'Strikethrough') {
          ranges.push(Decoration.mark({ class: 'cm-md-strike' }).range(node.from, node.to));
          if (!selectionTouches(view, node.from, node.to)) {
            node.node.getChildren('StrikethroughMark').forEach((c) => {
              pushHide(ranges, doc, c.from, c.to);
            });
          }
          return;
        }

        // ── Inline code `x` ──────────────────────────────────────────
        if (name === 'InlineCode') {
          ranges.push(Decoration.mark({ class: 'cm-md-code-inline' }).range(node.from, node.to));
          if (!selectionTouches(view, node.from, node.to)) {
            node.node.getChildren('CodeMark').forEach((c) => {
              pushHide(ranges, doc, c.from, c.to);
            });
          }
          return;
        }

        // ── Link [text](url) ─────────────────────────────────────────
        if (name === 'Link') {
          ranges.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to));
          const line = doc.lineAt(node.from);
          if (!selectionTouches(view, line.from, line.to)) {
            const marks = node.node.getChildren('LinkMark'); // [ ] ( )
            if (marks.length >= 1) {
              pushHide(ranges, doc, marks[0].from, marks[0].to);
            }
            if (marks.length >= 2) {
              pushHide(ranges, doc, marks[1].from, node.to);
            }
          }
          return;
        }

        // ── Image ![alt](url) ────────────────────────────────────────
        if (name === 'Image') {
          ranges.push(Decoration.mark({ class: 'cm-md-image' }).range(node.from, node.to));
          const line = doc.lineAt(node.from);
          if (!selectionTouches(view, line.from, line.to)) {
            const marks = node.node.getChildren('LinkMark');
            if (marks.length >= 2) {
              pushHide(ranges, doc, marks[1].from, node.to);
            }
            // hide the leading `![` (image opens with a `!` plus `[`)
            pushHide(ranges, doc, node.from, node.from + 2);
          }
          return;
        }

        // ── Blockquote ───────────────────────────────────────────────
        if (name === 'Blockquote') {
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(node.to);
          for (let i = startLine.number; i <= endLine.number; i++) {
            ranges.push(Decoration.line({ class: 'cm-md-blockquote' }).range(doc.line(i).from));
          }
          return;
        }

        // ── Fenced code block ────────────────────────────────────────
        if (name === 'FencedCode') {
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(node.to);
          for (let i = startLine.number; i <= endLine.number; i++) {
            let cls = 'cm-md-code-block';
            if (i === startLine.number) cls += ' cm-md-code-block-start';
            if (i === endLine.number)   cls += ' cm-md-code-block-end';
            ranges.push(Decoration.line({ class: cls }).range(doc.line(i).from));
          }
          return;
        }

        // ── Horizontal rule ─────────────────────────────────────────
        if (name === 'HorizontalRule') {
          const line = doc.lineAt(node.from);
          ranges.push(Decoration.line({ class: 'cm-md-hr' }).range(line.from));
          if (!selectionTouches(view, line.from, line.to) && line.from < line.to) {
            pushHide(ranges, doc, line.from, line.to);
          }
          return;
        }

        // ── List item (bullet/numbered) ─────────────────────────────
        if (name === 'ListItem') {
          const line = doc.lineAt(node.from);
          ranges.push(Decoration.line({ class: 'cm-md-list-item' }).range(line.from));
          return;
        }

        // ── Table (GFM) ─────────────────────────────────────────────
        if (name === 'Table') {
          const startLine = doc.lineAt(node.from);
          const endLine = doc.lineAt(node.to);
          for (let i = startLine.number; i <= endLine.number; i++) {
            ranges.push(Decoration.line({ class: 'cm-md-table' }).range(doc.line(i).from));
          }
          return;
        }
      },
    });
  }

  return Decoration.set(ranges, true);
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// Layout-only theme. All decoration colours, sizes and box styling live in
// frontend/css/markdown-editor.css so they can be tweaked without rebuilding
// TS, and so CSS `!important` can override the github theme's syntax
// highlight (which otherwise paints headings/bold/etc. in pink).
const livePreviewTheme = EditorView.theme({
  '&':           { fontFamily: 'var(--font-sans, system-ui)', fontSize: '14px' },
  '.cm-content': { fontFamily: 'inherit', padding: '14px 0', lineHeight: '1.6' },
  '.cm-line':    { padding: '0 24px' },
});

export function markdownLivePreview(): Extension {
  return [
    markdown({ base: markdownLanguage }),
    livePreviewPlugin,
    livePreviewTheme,
  ];
}
