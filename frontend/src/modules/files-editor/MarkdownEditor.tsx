// Markdown editor — single CodeMirror 6 instance with Obsidian-style live
// preview. The source markdown lives in the buffer (file save = exactly what
// was typed) but the view styles rendered text (heading sizes, bold/italic,
// link colour, …) and hides syntax markers on lines the cursor isn't on.
//
// The CM bundle is lazy-imported via cm-bundle.js (same chunk as the code
// editor) so the FileEditor chunk stays small. See cm-markdown-live.ts for
// the decoration plumbing.

import { useEffect, useRef } from 'react';
import type { CmEditor } from './cm-bundle.js';

const cmPromise = import('./cm-bundle.js');

interface Props {
  source: string;
  onChange: (next: string) => void;
}

function isDarkVariant(): boolean {
  return document.documentElement.getAttribute('data-variant') !== 'bright';
}

export function MarkdownEditor({ source, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CmEditor | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Mount once. `source` is captured at mount; later changes flow through the
  // sync effect below so a user edit doesn't reset the cursor.
  useEffect(() => {
    let cancelled = false;
    cmPromise.then(({ createMarkdownEditor }) => {
      if (cancelled || !hostRef.current) return;
      editorRef.current = createMarkdownEditor(
        hostRef.current,
        source,
        isDarkVariant(),
        (next) => onChangeRef.current(next),
      );
    });

    const observer = new MutationObserver(() => {
      editorRef.current?.setTheme(isDarkVariant());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-variant'],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      editorRef.current?.destroy();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external `source` only when it diverges from the editor — avoids the
  // feedback loop where every keystroke would re-set the doc and reset cursor.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const current = ed.getValue();
    if (current === source) return;
    ed.view.dispatch({
      changes: { from: 0, to: current.length, insert: source },
    });
  }, [source]);

  return <div ref={hostRef} className="md-editor md-editor-live" />;
}
