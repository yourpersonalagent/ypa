// CodeMirror 6 bundle. Imported lazily by CodeEditorPane / EditorRegion /
// MarkdownEditor via dynamic import, so the editor only enters the user's
// bundle when they actually open a file. Vite splits this file into its own
// chunk automatically.
//
// Two factories:
//   • createCodeHost   — multi-tab host used by both the VS-Code view's
//                        EditorRegion and the single-tab modal editor.
//                        Build per-tab EditorStates via buildState() and swap
//                        with setState(). Each state has its own theme
//                        compartment, so setTheme() reconfigures the active
//                        state. The 'code' / 'markdown' mode flag picks the
//                        extension stack.
//   • createMarkdownEditor — standalone live-preview editor (kept separate
//                        because the modal's MarkdownEditor lifecycle is
//                        simpler and predates the multi-tab host).
//
// The React wrapper owns mount/unmount; this module owns CM state.

import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightActiveLine, drawSelection, dropCursor, rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  syntaxHighlighting, defaultHighlightStyle, indentOnInput,
  bracketMatching, foldGutter, foldKeymap,
} from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { markdownLivePreview } from './cm-markdown-live.js';
import { markdownTaskList } from './cm-markdown-tasklist.js';
import { markdownTable } from './cm-markdown-table.js';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { php } from '@codemirror/lang-php';
import { xml } from '@codemirror/lang-xml';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';

// Map the shikiLang() output to a CM6 language extension. Languages without
// a CM6 module fall through to plain text — Shiki's view mode still colours
// them, but in edit mode they're unhighlighted.
function languageFor(lang: string): Extension | null {
  switch (lang) {
    case 'javascript': return javascript({ jsx: true });
    case 'typescript': return javascript({ typescript: true, jsx: true });
    case 'python':     return python();
    case 'html':       return html();
    case 'css':
    case 'scss':
    case 'less':       return css();
    case 'json':       return json();
    case 'markdown':   return markdown();
    case 'rust':       return rust();
    case 'c':
    case 'cpp':        return cpp();
    case 'sql':        return sql();
    case 'yaml':       return yaml();
    case 'php':        return php();
    case 'xml':        return xml();
    case 'go':         return go();
    case 'java':       return java();
    default:           return null;
  }
}

export interface CmEditor {
  view: EditorView;
  setTheme: (dark: boolean) => void;
  getValue: () => string;
  destroy: () => void;
}

// Multi-tab host: a single EditorView whose state can be swapped between
// per-tab EditorState objects without unmount/remount. Used by the Code-view
// EditorRegion to keep one CM instance and N doc models (VSCode-style).
export interface CmCodeStateOpts {
  doc: string;
  lang: string;
  dark: boolean;
  onSave: () => void;
  onChange?: (next: string) => void;
  // 'code' = code-editor extensions (gutter, fold, code keymap).
  // 'markdown' = Obsidian-style live preview (no gutter, decorations, wrap).
  // Defaults to 'code' when omitted.
  mode?: 'code' | 'markdown';
}

export interface CmCodeHost {
  view: EditorView;
  buildState: (opts: CmCodeStateOpts) => EditorState;
  setState: (state: EditorState) => void;
  setTheme: (dark: boolean) => void;
  destroy: () => void;
}

function buildCodeExtensions(opts: CmCodeStateOpts, themeCompartment: Compartment): Extension[] {
  if ((opts.mode ?? 'code') === 'markdown') {
    // Markdown live-preview branch — same decoration stack as createMarkdownEditor.
    const mdBaseTheme = EditorView.theme({
      '&':              { height: '100%', fontSize: '13px' },
      '.cm-scroller':   { overflow: 'auto' },
    });
    return [
      history(),
      drawSelection(),
      dropCursor(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      themeCompartment.of(opts.dark ? githubDark : githubLight),
      markdownLivePreview(),
      markdownTaskList(),
      markdownTable(),
      EditorView.updateListener.of((v) => {
        if (v.docChanged && opts.onChange) opts.onChange(v.state.doc.toString());
      }),
      mdBaseTheme,
    ];
  }

  const langExt = languageFor(opts.lang);
  const baseTheme = EditorView.theme({
    '&':              { height: '100%', fontSize: '12.5px' },
    '.cm-scroller':   { fontFamily: 'var(--font-mono, ui-monospace, monospace)', overflow: 'auto' },
    '.cm-content':    { padding: '8px 0' },
    '.cm-gutters':    { backgroundColor: 'transparent', borderRight: '1px solid var(--stroke)' },
  });
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave(); return true; } },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap,
    ]),
    themeCompartment.of(opts.dark ? githubDark : githubLight),
    langExt ?? [],
    EditorView.updateListener.of((v) => {
      if (v.docChanged && opts.onChange) opts.onChange(v.state.doc.toString());
    }),
    baseTheme,
  ];
}

// Mount one EditorView with an empty state; per-tab EditorStates are built
// later via buildState() and swapped via setState(). Each per-tab state has
// its own theme compartment, so setTheme() reconfigures the *current* state.
export function createCodeHost(parent: HTMLElement, initialDark: boolean): CmCodeHost {
  let currentTheme = new Compartment();
  let dark = initialDark;
  const emptyState = EditorState.create({ doc: '' });
  const view = new EditorView({ state: emptyState, parent });

  return {
    view,
    buildState(opts) {
      const themeCompartment = new Compartment();
      const ext = buildCodeExtensions({ ...opts, dark }, themeCompartment);
      const state = EditorState.create({ doc: opts.doc, extensions: ext });
      // Attach the theme compartment so setState() / setTheme() can find it.
      (state as unknown as { __yhaTheme?: Compartment }).__yhaTheme = themeCompartment;
      return state;
    },
    setState(state) {
      const themeCompartment = (state as unknown as { __yhaTheme?: Compartment }).__yhaTheme;
      if (themeCompartment) currentTheme = themeCompartment;
      view.setState(state);
    },
    setTheme(nextDark) {
      dark = nextDark;
      view.dispatch({
        effects: currentTheme.reconfigure(dark ? githubDark : githubLight),
      });
    },
    destroy() { view.destroy(); },
  };
}

// Markdown-specific factory: Obsidian-style live preview. Single CM instance,
// source markdown stays in the buffer, decorations style headings/bold/italic
// /links and hide markers on lines without the cursor. Used by MarkdownEditor.
export function createMarkdownEditor(
  parent: HTMLElement,
  doc: string,
  initialDark: boolean,
  onChange: (next: string) => void,
): CmEditor {
  const themeCompartment = new Compartment();

  // Without an explicit height on `&` the CM editor sizes to content,
  // which on a long doc inside a bounded parent skips the scroll path.
  const baseTheme = EditorView.theme({
    '&':            { height: '100%' },
    '.cm-scroller': { overflow: 'auto' },
  });

  const state = EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      themeCompartment.of(initialDark ? githubDark : githubLight),
      markdownLivePreview(),
      markdownTaskList(),
      markdownTable(),
      EditorView.updateListener.of((v) => {
        if (v.docChanged) onChange(v.state.doc.toString());
      }),
      baseTheme,
    ],
  });

  const view = new EditorView({ state, parent });

  return {
    view,
    setTheme(dark) {
      view.dispatch({
        effects: themeCompartment.reconfigure(dark ? githubDark : githubLight),
      });
    },
    getValue() { return view.state.doc.toString(); },
    destroy() { view.destroy(); },
  };
}

