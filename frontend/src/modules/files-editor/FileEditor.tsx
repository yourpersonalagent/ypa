// FileEditor — moveable window that opens files for editing.
//
// Two body modes, picked from the file extension:
//   • markdown (.md, .markdown) → <MarkdownEditor>: single CodeMirror 6
//     editor with Obsidian-style live preview (headings/bold/italic/links
//     render in place; syntax markers show on the line with the cursor).
//   • code/text → <CodeEditorPane>: CodeMirror 6 editor (lazy-loaded), live
//     syntax highlighting via the bundled CM language packs.
//
// The window frame (drag/resize/fullscreen/close-on-escape/persistence) is
// provided by <MoveableWindow>. The bridge object `fileEditor.open()` stays
// unchanged so vanilla callers (FilePicker.tsx, chat.ts) work as before.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fileEditor } from '../../modals/file-editor.js';
import { codeView } from '../../layouts/full/code/code-view-bridge.js';
import { getAppState } from '../../stores/appStore.js';
import { toast } from '../../toast.js';
import { MoveableWindow } from '../../components/MoveableWindow.js';
import { fileIcon, isMarkdown, isViewable } from '../../util/file-lang.js';
import { MarkdownEditor } from './MarkdownEditor.js';
import { CodeEditorPane, type CodeEditorPaneHandle } from './CodeEditorPane.js';
import { EditorToolbar } from './EditorToolbar.js';
import { useForgeStore } from '../../forge-bar/forge-state.js';

function pathMatches(tabPath: string, relPath: string): boolean {
  if (!relPath) return false;
  if (tabPath === relPath) return true;
  return tabPath.endsWith('/' + relPath);
}

interface FileReadResponse  { success: boolean; content: string; error?: string; }
interface FileWriteResponse { success: boolean; error?: string; }

export function FileEditor() {
  const [isOpen, setIsOpen] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [fileName, setFileName] = useState('');
  const [rawContent, setRawContent] = useState('');
  // Bumped on Discard/Reload so the editor pane (which captures `value` at
  // mount) remounts with the new disk content. Without this, re-reading the
  // file wouldn't refresh the buffer.
  const [bufferRev, setBufferRev] = useState(0);
  // Local-edits dirty flag. CM owns the doc; we mirror onChange / wipe on Save.
  const [dirty, setDirty] = useState(false);
  const [externallyChanged, setExternallyChanged] = useState(false);
  const [, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const codeEditorRef = useRef<CodeEditorPaneHandle | null>(null);
  const baseUrl = window.location.origin;

  const isMd = isMarkdown(fileName);

  const closeFile = useCallback(() => {
    setIsOpen(false);
    setDirty(false);
    setExternallyChanged(false);
  }, []);

  // Read `path` from the bridge and replace the buffer + clear dirty flags.
  // `path` parameter is taken explicitly so reloadFile / openFile share it.
  const loadInto = useCallback(async (path: string) => {
    setLoadError(null);
    setLoadingFile(true);
    try {
      const r = await fetch(`${baseUrl}/v1/files/read?path=${encodeURIComponent(path)}`);
      const d = (await r.json()) as FileReadResponse;
      if (!d.success) throw new Error(d.error || 'Failed to load');
      setRawContent(d.content);
      setDirty(false);
      setExternallyChanged(false);
      setBufferRev((n) => n + 1);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoadingFile(false);
    }
  }, [baseUrl]);

  const openFile = useCallback(async (path: string, name?: string) => {
    // In Code view, route the open to the tabbed editor instead of this modal.
    // Guard on the bridge being filled in case EditorRegion hasn't mounted yet.
    if (getAppState().viewMode === 'code' && codeView.openFile) {
      codeView.openFile(path, name);
      return;
    }
    const fname = name || path.split('/').pop() || '';
    setFilePath(path);
    setFileName(fname);
    setRawContent('');
    setIsOpen(true);
    await loadInto(path);
  }, [loadInto]);

  // Override fileEditor methods on mount so vanilla callers hit the React modal.
  useEffect(() => {
    const fe = fileEditor as unknown as {
      open?: (path: string, name?: string) => void;
      close?: () => void;
      isViewable?: (name: string) => boolean;
    };
    fe.open = openFile;
    fe.close = closeFile;
    fe.isViewable = isViewable;
  }, [openFile, closeFile]);

  const save = useCallback(async () => {
    if (!filePath) return;
    let content = rawContent;
    // For code files, CM6 owns the document — read it back.
    if (!isMd && codeEditorRef.current) {
      content = codeEditorRef.current.getValue();
    }
    setSaving(true);
    try {
      const r = await fetch(`${baseUrl}/v1/files/write`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      });
      const d = (await r.json()) as FileWriteResponse;
      if (!d.success) throw new Error(d.error || 'Save failed');
      toast.show(`Saved ${filePath.split('/').pop()}`, 'success');
      setRawContent(content);
      setDirty(false);
      setExternallyChanged(false);
    } catch (e) {
      toast.show((e as Error).message, 'error', { title: 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, [filePath, rawContent, isMd, baseUrl]);
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  const onMdChange = useCallback((next: string) => {
    setRawContent(next);
    setDirty(true);
  }, []);

  const onCodeChange = useCallback(() => { setDirty(true); }, []);

  const onDiscardClick = useCallback(() => {
    if (!filePath || !dirty) return;
    if (!confirm(`Discard unsaved changes to ${fileName}?`)) return;
    void loadInto(filePath);
  }, [filePath, fileName, dirty, loadInto]);

  const onReloadClick = useCallback(() => {
    if (!filePath) return;
    if (dirty && !confirm(`Reload ${fileName}? Unsaved changes will be lost.`)) return;
    void loadInto(filePath);
  }, [filePath, fileName, dirty, loadInto]);

  // Detect agent writes that touch the open file — flag externallyChanged so
  // the toolbar highlights Reload. Dedupe by edit id so a single edit doesn't
  // re-flag on every poll tick.
  const recentEdit = useForgeStore((s) => s.recentEdit);
  const lastSeenEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !filePath || !recentEdit) return;
    if (lastSeenEditIdRef.current === recentEdit.id) return;
    lastSeenEditIdRef.current = recentEdit.id;
    if (recentEdit.paths.some((p) => pathMatches(filePath, p))) {
      setExternallyChanged(true);
    }
  }, [recentEdit, isOpen, filePath]);

  const title = (
    <>
      <span className="fe-icon">{fileIcon(fileName)}</span>
      <span className="fe-title">{fileName}</span>
      {externallyChanged && (
        <span className="fe-ext-flag" title="File changed on disk by an agent">●</span>
      )}
    </>
  );

  // Action buttons live in the window header (next to fullscreen/close) in
  // moveable-window mode. The VS-Code view keeps them in its tabbar row.
  const headerToolbar = isOpen ? (
    <EditorToolbar
      dirty={dirty}
      loaded={!loadingFile && !loadError}
      externallyChanged={externallyChanged}
      onSave={save}
      onDiscard={onDiscardClick}
      onReload={onReloadClick}
    />
  ) : null;

  return (
    <MoveableWindow
      isOpen={isOpen}
      title={title}
      storageKey="yha.fileEditor.geometry"
      defaultGeometry={{ width: 880, height: 700 }}
      zIndex={1250}
      onClose={closeFile}
      closeOnEscape
      bodyClassName="fe-body"
      headerExtras={headerToolbar}
    >
      {loadingFile && <div style={{ padding: 16 }}>Loading…</div>}
      {loadError && <div style={{ padding: 16, color: 'var(--danger)' }}>Error: {loadError}</div>}
      {!loadingFile && !loadError && isMd && (
        <MarkdownEditor key={`md-${filePath}-${bufferRev}`} source={rawContent} onChange={onMdChange} />
      )}
      {!loadingFile && !loadError && !isMd && (
        <CodeEditorPane
          key={`code-${filePath}-${bufferRev}`}
          ref={codeEditorRef}
          value={rawContent}
          fileName={fileName}
          onSave={() => saveRef.current()}
          onChange={onCodeChange}
        />
      )}
    </MoveableWindow>
  );
}
