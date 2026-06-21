// Lightweight GFM-table renderer for the markdown editor.
//
// When the cursor is outside a table block, the whole block is replaced with
// a styled HTML <table>. Move the cursor into any of the table's lines and
// the source comes back so it can be edited as plain text — the same
// Obsidian-style behaviour cm-markdown-live.ts uses for headings / inline
// marks.
//
// Cells containing `[ ]` / `[x]` (or `[X]`) render those markers as real
// checkboxes that flip the underlying source character on click. Clicking
// anywhere else on the rendered table puts the cursor at the start of the
// clicked cell so the user can edit the text directly.

import { syntaxTree } from '@codemirror/language';
import {
  StateEffect, StateField, type Extension, type Range,
} from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, WidgetType,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';

const CHECKBOX_RE = /\[[ xX]\]/g;

interface Cell {
  text: string;
  offset: number; // offset into the table source string
}

interface ParsedTable {
  header: Cell[] | null;
  body: Cell[][];
}

// Any line that, after removing pipes / colons / whitespace, has only dashes.
function isSeparatorLine(line: string): boolean {
  const stripped = line.replace(/[|:\s]/g, '');
  return stripped.length > 0 && /^-+$/.test(stripped);
}

// Split one table row into cells with offsets back into the table source.
// `lineStart` is the offset of the line's first character within the source.
function splitRow(line: string, lineStart: number): Cell[] {
  let start = 0;
  let end = line.length;
  if (line[start] === '|') start += 1;
  if (end > start && line[end - 1] === '|') end -= 1;

  const cells: Cell[] = [];
  let cellStart = start;
  for (let i = start; i < end; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') {
      cells.push({ text: line.slice(cellStart, i), offset: lineStart + cellStart });
      cellStart = i + 1;
    }
  }
  cells.push({ text: line.slice(cellStart, end), offset: lineStart + cellStart });
  return cells;
}

function parseTable(source: string): ParsedTable {
  const lines = source.split('\n');
  const rows: Cell[][] = [];
  let headerIdx = -1;
  let cursor = 0;
  for (const line of lines) {
    if (isSeparatorLine(line)) {
      if (rows.length > 0) headerIdx = rows.length - 1;
    } else if (line.trim().length > 0) {
      rows.push(splitRow(line, cursor));
    }
    cursor += line.length + 1;
  }
  if (headerIdx >= 0) {
    return { header: rows[headerIdx], body: rows.slice(headerIdx + 1) };
  }
  return { header: null, body: rows };
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly tableStart: number) { super(); }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.tableStart === this.tableStart;
  }

  toDOM(view: EditorView): HTMLElement {
    const { header, body } = parseTable(this.source);

    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-table-rendered-wrap';

    const table = document.createElement('table');
    table.className = 'cm-md-table-rendered';

    if (header) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      for (const cell of header) {
        const th = document.createElement('th');
        this.renderCellInto(view, th, cell);
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    const tbody = document.createElement('tbody');
    for (const row of body) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        this.renderCellInto(view, td, cell);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  // Append the cell's text, converting any `[ ]` / `[x]` runs into real
  // checkbox inputs wired to flip the source. Clicking the cell (outside a
  // checkbox) puts the cursor at the cell start so it can be edited.
  private renderCellInto(view: EditorView, parent: HTMLElement, cell: Cell): void {
    const text = cell.text;
    let lastIndex = 0;
    CHECKBOX_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CHECKBOX_RE.exec(text)) !== null) {
      if (m.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      }
      const checked = m[0] === '[x]' || m[0] === '[X]';
      const docPos = this.tableStart + cell.offset + m.index;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.className = 'cm-md-task-checkbox';
      box.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
      box.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch({
          changes: { from: docPos, to: docPos + 3, insert: checked ? '[ ]' : '[x]' },
          userEvent: 'input',
        });
      });
      parent.appendChild(box);
      lastIndex = m.index + m[0].length;
      if (text[lastIndex] === ' ') lastIndex += 1;
    }
    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex).trim()));
    }

    parent.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.cm-md-task-checkbox')) return;
      e.preventDefault();
      const skipLead = text.match(/^\s*/)?.[0].length ?? 0;
      view.dispatch({
        selection: { anchor: this.tableStart + cell.offset + skipLead },
        scrollIntoView: true,
      });
      view.focus();
    });
  }

  ignoreEvent(): boolean { return false; }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter(node) {
        if (node.type.name !== 'Table') return;
        const startLine = doc.lineAt(node.from);
        const endLine = doc.lineAt(Math.min(node.to, doc.length));
        const blockFrom = startLine.from;
        const blockTo = endLine.to;

        for (const r of view.state.selection.ranges) {
          if (r.from <= blockTo && r.to >= blockFrom) return;
        }

        const source = doc.sliceString(blockFrom, blockTo);
        ranges.push(
          Decoration.replace({
            block: true,
            widget: new TableWidget(source, blockFrom),
          }).range(blockFrom, blockTo),
        );
      },
    });
  }

  return Decoration.set(ranges, true);
}

// Block-replace decorations must come from a StateField (CM's rule). The
// view computes them from `visibleRanges` and writes them back through an
// effect — that's what `tableSync` does below.
const setTableDeco = StateEffect.define<DecorationSet>();

const tableDecoField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setTableDeco)) next = e.value;
    }
    return next;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
});

function safeDispatchDeco(view: EditorView, deco: DecorationSet): void {
  queueMicrotask(() => {
    if (!view.dom.isConnected) return;
    try { view.dispatch({ effects: setTableDeco.of(deco) }); } catch { /* view destroyed mid-microtask */ }
  });
}

const tableSync = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      safeDispatchDeco(view, buildDecorations(view));
    }
    update(update: ViewUpdate) {
      if (!update.docChanged && !update.viewportChanged && !update.selectionSet) return;
      safeDispatchDeco(update.view, buildDecorations(update.view));
    }
  },
);

export function markdownTable(): Extension {
  return [tableDecoField, tableSync];
}
