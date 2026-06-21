// Thin React wrapper around the CodeMirror 6 bundle. Mounts a CM EditorView
// inside a host <div>; lazy-loads the bundle so non-code paths don't pay the
// CM cost. Theme tracks the document's `data-variant` attribute so the editor
// flips light/dark when the user toggles the YHA theme.
//
// Uses the same `createCodeHost` + `buildState({mode:'code'})` factory as the
// VS-Code view's EditorRegion, so the highlight stack, theme compartments, and
// flex/min-height/overflow plumbing are identical in both contexts. A
// <CodeMinimap> is rendered alongside the editor host for nav.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { fileExt, shikiLang } from '../../util/file-lang.js';
import { CodeMinimap } from './CodeMinimap.js';
import type { CmCodeHost } from './cm-bundle.js';
import type { EditorView } from '@codemirror/view';

const cmPromise = import('./cm-bundle.js');

export interface CodeEditorPaneHandle {
  getValue: () => string;
}

interface Props {
  value: string;
  fileName: string;
  onSave: () => void;
  onChange?: () => void;
  ref?: Ref<CodeEditorPaneHandle>;
}

function isDarkVariant(): boolean {
  return document.documentElement.getAttribute('data-variant') !== 'bright';
}

export function CodeEditorPane({ value, fileName, onSave, onChange, ref }: Props) {
  const hostElRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<CmCodeHost | null>(null);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Mount once per (fileName). `value` is captured at mount; CM owns the doc
  // afterwards. FileEditor reads back via getValue() on Save.
  useEffect(() => {
    let cancelled = false;
    const lang = shikiLang(fileExt(fileName));
    cmPromise.then(({ createCodeHost }) => {
      if (cancelled || !hostElRef.current) return;
      const host = createCodeHost(hostElRef.current, isDarkVariant());
      hostRef.current = host;
      const state = host.buildState({
        doc: value,
        lang,
        mode: 'code',
        dark: isDarkVariant(),
        onSave: () => onSaveRef.current(),
        onChange: () => { onChangeRef.current?.(); },
      });
      host.setState(state);
      setView(host.view);
    });

    const observer = new MutationObserver(() => {
      hostRef.current?.setTheme(isDarkVariant());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-variant'],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      hostRef.current?.destroy();
      hostRef.current = null;
      setView(null);
    };
    // value is intentionally captured at mount; downstream changes flow
    // through CM internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName]);

  useImperativeHandle(ref, () => ({
    getValue: () => hostRef.current?.view.state.doc.toString() ?? value,
  }), [value]);

  return (
    <div className="cm-host-stage">
      <div ref={hostElRef} className="cm-host" />
      <CodeMinimap view={view} />
    </div>
  );
}
