// Notion-style task list widget for the markdown editor.
//
// Scans each visible line for a leading `- [ ] ` / `- [x] ` marker and, when
// the cursor isn't on that line, replaces the entire `- [ ] ` run with a real
// `<input type="checkbox">` widget — clicking it dispatches a doc edit that
// toggles the source character. Move the cursor onto the line and the source
// re-appears so it can be edited directly.
//
// Also wires two keymap entries:
//   • Enter on a task line continues the list with `- [ ] ` (or strips an
//     empty task line, mirroring Obsidian/Notion).
//   • Mod-Enter toggles the current line's checkbox without moving the cursor.
//
// No syntax tree dependency — the regex approach composes cleanly with
// `markdownLivePreview` and `markdownTables` without fighting their decoration
// ownership.

import { Prec, type EditorState, type Extension, type Range } from '@codemirror/state';
import {
  Decoration, EditorView, ViewPlugin, WidgetType, keymap,
  type DecorationSet, type ViewUpdate,
} from '@codemirror/view';

const TASK_RE = /^(\s*)([-*+])(\s+)(\[[ xX]\])(\s)/;

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly markerPos: number) { super(); }
  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked && other.markerPos === this.markerPos;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-md-task-checkbox';
    box.setAttribute('aria-label', 'Toggle task');
    box.addEventListener('mousedown', (e) => { e.preventDefault(); });
    box.addEventListener('click', (e) => {
      e.preventDefault();
      const replacement = this.checked ? '[ ]' : '[x]';
      view.dispatch({
        changes: { from: this.markerPos, to: this.markerPos + 3, insert: replacement },
        userEvent: 'input',
      });
    });
    return box;
  }
  ignoreEvent(): boolean { return false; }
}

function selectionTouchesLine(state: EditorState, lineFrom: number, lineTo: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= lineTo && r.to >= lineFrom) return true;
  }
  return false;
}

function decorate(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const m = TASK_RE.exec(line.text);
      if (m) {
        const indentLen = m[1].length;
        const bulletLen = m[2].length;
        const gapLen = m[3].length;
        const markerLen = m[4].length;
        const trailLen = m[5].length;
        const indentEnd = line.from + indentLen;
        const bulletEnd = indentEnd + bulletLen;
        const gapEnd = bulletEnd + gapLen;
        const markerEnd = gapEnd + markerLen;
        const trailEnd = markerEnd + trailLen;
        const checked = m[4] === '[x]' || m[4] === '[X]';

        if (selectionTouchesLine(view.state, line.from, line.to)) {
          ranges.push(Decoration.mark({ class: 'cm-md-task-marker' }).range(gapEnd, markerEnd));
        } else {
          ranges.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(checked, gapEnd),
            }).range(indentEnd, trailEnd),
          );
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }

  return Decoration.set(ranges, true);
}

const taskListPlugin = ViewPlugin.fromClass(
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
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

function continueTaskList(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (from !== to) return false;
  const line = state.doc.lineAt(from);
  const m = /^(\s*)([-*+])(\s+)\[[ xX]\](\s)/.exec(line.text);
  if (!m) return false;
  // Only continue if the cursor is at end of line (Obsidian/Notion behavior).
  if (from !== line.to) return false;

  const indent = m[1];
  const bullet = m[2];
  const headerLen = m[0].length;
  const rest = line.text.slice(headerLen).trim();

  if (rest.length === 0) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      userEvent: 'delete',
    });
    return true;
  }

  const insert = `\n${indent}${bullet} [ ] `;
  view.dispatch({
    changes: { from, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

function toggleCurrentTask(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.from);
  const m = /^(\s*[-*+]\s+)(\[[ xX]\])/.exec(line.text);
  if (!m) return false;
  const markerStart = line.from + m[1].length;
  const current = m[2];
  const checked = current === '[x]' || current === '[X]';
  view.dispatch({
    changes: { from: markerStart, to: markerStart + 3, insert: checked ? '[ ]' : '[x]' },
    userEvent: 'input',
  });
  return true;
}

export function markdownTaskList(): Extension {
  return [
    taskListPlugin,
    Prec.high(keymap.of([
      { key: 'Enter', run: continueTaskList },
      { key: 'Mod-Enter', run: toggleCurrentTask },
    ])),
  ];
}
