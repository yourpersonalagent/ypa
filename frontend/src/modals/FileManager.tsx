// FileManager — server-side file management surface.
//
// Distinct from FilePicker (read-only popover for browse + pick + set-cwd):
// this modal owns mutations — drag-and-drop uploads of files AND folders
// (with a confirmation queue, never auto-uploads), mkdir, rename, move,
// copy, and triple-confirm delete with .trash/<timestamp>/ + undo.
//
// Layout: a single MoveableWindow with a top toolbar (breadcrumb, hidden
// toggle, refresh, mkdir, upload buttons), a multi-select listing in the
// middle, and a footer with batch actions (move, copy, rename, delete).
// Nested overlays handle the upload queue, conflict prompts, and the
// triple-confirm delete flow.
//
// Wires itself up to fileManager.open() / .close() so callers (FilePicker
// footer button, KeyboardShortcuts Ctrl+Shift+F, Shell header button) can
// trigger it without importing the React component directly.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MoveableWindow } from '../components/MoveableWindow.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { fileManager } from './file-manager.js';
import { fileEditor } from './file-editor.js';
import { fileIcon, fmtSize, shouldOpenInEditor } from '../util/file-lang.js';
import { useAppStore } from '../stores/index.js';
import { getToastActions } from '../stores/toastStore.js';
import { store } from '../store.js';
import type { YhaNode } from '../modules/yha-net/TabNodes.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface FileItem {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
}
interface FileListing {
  success: boolean;
  error?: string;
  path: string;
  parent?: string | null;
  items: FileItem[];
}

type ConflictMode = 'skip' | 'overwrite' | 'rename';

interface QueuedItem {
  id: string;
  file: File;
  // Path within the upload, relative to the queue root. Empty for files at
  // the top level; "sub/" for a folder's children. Mirrors the source folder
  // structure on the server.
  relativePath: string;
  size: number;
  status: 'queued' | 'uploading' | 'done' | 'error' | 'skipped';
  uploadedBytes: number;
  error?: string;
}

// ── Limits / hidden defaults ─────────────────────────────────────────────────

const MAX_FILE_BYTES = 500 * 1024 * 1024;       // per-file cap (server enforces too)
const MAX_BATCH_BYTES = 5 * 1024 * 1024 * 1024; // per-queue cap (UI-only soft limit)
const HIDDEN_NAMES = new Set(['node_modules', '.git', '.trash', '.DS_Store']);
const DELETE_CONFIRM_THRESHOLD = 10; // items count above which we require typing the folder name

// ── Helpers ──────────────────────────────────────────────────────────────────

// Walk a webkitGetAsEntry() FileSystemEntry tree, collecting every file with
// its path relative to the drop root. Used for drag-and-drop folder uploads.
async function readEntries(dirReader: any): Promise<any[]> {
  const all: any[] = [];
  let batch: any[] = [];
  do {
    batch = await new Promise<any[]>((resolve, reject) => {
      dirReader.readEntries(resolve, reject);
    });
    all.push(...batch);
  } while (batch.length > 0);
  return all;
}
// Maximum directory nesting allowed during a drag-drop folder walk. webkit's
// recursive entry API doesn't filter symlink loops or pathologically deep
// trees, so without this guard a malicious or unusual filesystem could blow
// the call stack / stall the event loop. 20 levels covers realistic user
// folders by a wide margin; anything deeper is almost certainly a mistake.
const MAX_WALK_DEPTH = 20;

async function walkEntry(
  entry: any,
  prefix: string,
  out: { file: File; relativePath: string }[],
  depth = 0,
  state: { exceeded: boolean } = { exceeded: false },
): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativePath: prefix });
  } else if (entry.isDirectory) {
    if (depth >= MAX_WALK_DEPTH) {
      // First crossing surfaces a toast; subsequent skips stay silent so the
      // user gets one clear signal instead of a flood when the tree is wide.
      if (!state.exceeded) {
        state.exceeded = true;
        try {
          getToastActions().show(
            `Folder nesting exceeded ${MAX_WALK_DEPTH} levels — deeper entries skipped`,
            'warning',
            { title: 'Upload', duration: 6000 },
          );
        } catch (_) { /* toast may not be available during tests */ }
      }
      return;
    }
    const reader = entry.createReader();
    const children = await readEntries(reader);
    for (const child of children) {
      await walkEntry(child, prefix + entry.name + '/', out, depth + 1, state);
    }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface FileManagerProps {
  // Embedded mode: render the body without MoveableWindow chrome, auto-open
  // on mount, and skip the global fileManager.open/close bridge wiring (the
  // singleton modal instance keeps owning that). Used by the Code view's
  // Files panel to reuse this entire surface as a vertical pane.
  embedded?: boolean;
}

export function FileManager({ embedded = false }: FileManagerProps = {}) {
  const [isOpen, setIsOpen] = useState(embedded);
  const [currentPath, setCurrentPath] = useState('~');
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [renaming, setRenaming] = useState<{ path: string; newName: string } | null>(null);
  const [mkdirInput, setMkdirInput] = useState<string | null>(null);

  // Drag overlay
  const [dragOver, setDragOver] = useState(false);

  // Upload queue
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const queueAbortRef = useRef<AbortController | null>(null);

  // YHA Net node scope (same model as FilePicker). null=local; id=remote via proxy;
  // we support single-node remote ops in the manager (merged is picker-oriented).
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [netNodes, setNetNodes] = useState<YhaNode[]>([]);
  const activeNodeIdRef = useRef<string | null>(null);

  function loadNetNodesFM() {
    const raw = store.get('yhaNetNodes');
    const list: YhaNode[] = Array.isArray(raw) ? (raw as YhaNode[]) : [];
    setNetNodes(list);
  }

  function apiPrefix(): string {
    const id = activeNodeIdRef.current;
    const b = window.location.origin;
    if (!id) return b;
    return `${b}/v1/net/nodes/${encodeURIComponent(id)}`;
  }

  // Conflict dialog
  const [conflictPrompt, setConflictPrompt] = useState<{
    name: string;
    onResolve: (mode: ConflictMode | null, applyToAll: boolean) => void;
  } | null>(null);

  // Triple-confirm delete
  const [deletePrompt, setDeletePrompt] = useState<{
    items: string[];
    sizeInfo: string;
    stage: 1 | 2 | 3;
    typed: string;
    folderName?: string;
  } | null>(null);

  // Move dialog (folds destination dir into the same shape so they update together)
  const [moveDialog, setMoveDialog] = useState<{ items: string[]; mode: 'move' | 'copy'; dest: string } | null>(null);

  // Zip dialog. `items` are the absolute paths to include; `archivePath` is
  // the editable destination, `excludeHidden` skips node_modules / .git /
  // .trash / .DS_Store so backups don't bundle gigabytes of build artifacts,
  // `overwrite` lets the user opt in upfront instead of round-tripping a 409.
  const [zipDialog, setZipDialog] = useState<{
    items: string[];
    archivePath: string;
    excludeHidden: boolean;
    overwrite: boolean;
  } | null>(null);

  // Unzip dialog: pre-fills destDir to a sibling folder named after the
  // archive (without `.zip`) — same convention as macOS Finder / 7-Zip's
  // "extract here" flow.
  const [unzipDialog, setUnzipDialog] = useState<{
    archivePath: string;
    destDir: string;
    overwrite: boolean;
  } | null>(null);

  // Set during the in-flight zip/unzip request so the buttons can show a
  // "Working…" label and we can disable the start button. Single flag is
  // fine — only one of these runs at a time from the UI.
  const [zipBusy, setZipBusy] = useState(false);

  // Chain of pending un-trash entries (LIFO). Earlier deletes USED to be
  // dropped the moment a new one arrived; rapid three-folder deletes left
  // only the most recent undoable. Now each commitDelete pushes onto the
  // stack with its own 8 s timer; one shared window keydown listener pops
  // the top entry on Ctrl+Z. close() clears every pending entry.
  interface UndoEntry {
    trashId: string;
    count: number;
    hostDir: string;
    timer: ReturnType<typeof setTimeout>;
  }
  const undoStackRef = useRef<UndoEntry[]>([]);
  const undoKeyListenerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  // ── Working dir ─────────────────────────────────────────────────────────────

  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const baseUrl = window.location.origin;

  // ── Listing fetch ───────────────────────────────────────────────────────────

  const navigate = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      // Always fetch with hidden=1 so we have everything; we filter on the
      // client based on `showHidden` + HIDDEN_NAMES. That way toggling the
      // checkbox is instant.
      const r = await fetch(`${apiPrefix()}/v1/files/?path=${encodeURIComponent(dirPath)}&hidden=1`);
      const d = (await r.json()) as FileListing;
      if (!d.success) throw new Error(d.error || 'Server error');
      setListing(d);
      setCurrentPath(d.path);
    } catch (e) {
      setError((e as Error).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  const refresh = useCallback(() => navigate(currentPath), [navigate, currentPath]);

  // ── Open / close handlers wired into the bridge object ──────────────────────

  const open = useCallback((startPath?: string) => {
    setIsOpen(true);
    loadNetNodesFM();
    setActiveNodeId(null);
    activeNodeIdRef.current = null;
    const start = startPath || sessionWorkingDir || '~';
    navigate(start);
  }, [navigate, sessionWorkingDir]);

  const close = useCallback(() => {
    if (uploading) {
      if (!confirm('An upload is in progress. Cancel and close?')) return;
      queueAbortRef.current?.abort();
    }
    // Clear all pending undo entries: cancel their timers and remove the
    // shared keydown listener if it's installed.
    for (const e of undoStackRef.current) { try { clearTimeout(e.timer); } catch (_) {} }
    undoStackRef.current = [];
    if (undoKeyListenerRef.current) {
      window.removeEventListener('keydown', undoKeyListenerRef.current);
      undoKeyListenerRef.current = null;
    }
    setIsOpen(false);
    setQueue([]);
    setQueueOpen(false);
    setSelected(new Set());
    setRenaming(null);
    setMkdirInput(null);
    setDeletePrompt(null);
    setConflictPrompt(null);
    setMoveDialog(null);
    setZipDialog(null);
    setUnzipDialog(null);
  }, [uploading]);

  useEffect(() => {
    // Skip bridge + custom-event wiring in embedded mode — those belong to
    // the singleton modal instance so external callers always hit the modal.
    if (embedded) return;
    fileManager.open = open;
    fileManager.close = close;
  }, [open, close, embedded]);

  // External event for Shell header button / shortcut keybinding.
  useEffect(() => {
    if (embedded) return;
    function onOpenEvent(e: Event) {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      open(detail?.path);
    }
    window.addEventListener('yha:open-file-manager', onOpenEvent);
    return () => window.removeEventListener('yha:open-file-manager', onOpenEvent);
  }, [open, embedded]);

  // Embedded mode: open on mount + sync with sessionWorkingDir changes so
  // navigating CWD elsewhere refreshes the panel.
  useEffect(() => {
    if (!embedded) return;
    open();
  }, [embedded, open]);

  // ── Filtered items ──────────────────────────────────────────────────────────

  const items = useMemo<FileItem[]>(() => {
    if (!listing?.items) return [];
    return listing.items.filter((it) => {
      if (showHidden) return true;
      if (HIDDEN_NAMES.has(it.name)) return false;
      if (it.name.startsWith('.')) return false;
      return true;
    });
  }, [listing, showHidden]);

  // ── Selection helpers ───────────────────────────────────────────────────────

  const lastClickedRef = useRef<string | null>(null);
  function onItemClick(e: React.MouseEvent, item: FileItem) {
    e.stopPropagation();
    if (e.shiftKey && lastClickedRef.current) {
      // Range select between lastClicked and current
      const all = items.map((i) => i.path);
      const start = all.indexOf(lastClickedRef.current);
      const end = all.indexOf(item.path);
      if (start >= 0 && end >= 0) {
        const [a, b] = start < end ? [start, end] : [end, start];
        const range = all.slice(a, b + 1);
        const next = new Set(selected);
        for (const p of range) next.add(p);
        setSelected(next);
      }
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      setSelected(next);
    } else {
      setSelected(new Set([item.path]));
    }
    lastClickedRef.current = item.path;
  }

  function onItemDoubleClick(item: FileItem) {
    if (item.type === 'dir') {
      navigate(item.path);
    } else if (shouldOpenInEditor(item.name, item.size)) {
      fileEditor.open?.(item.path, item.name);
    }
  }

  // ── Drag-and-drop from OS ───────────────────────────────────────────────────

  // We DO NOT auto-upload. Drops populate the queue panel instead and the
  // user explicitly clicks "Start upload" to commit.
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = Array.from(e.dataTransfer?.items || []);
    if (!items.length) return;
    void enqueueDataTransfer(items);
  }

  async function enqueueDataTransfer(items: DataTransferItem[]) {
    const collected: { file: File; relativePath: string }[] = [];
    for (const item of items) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (!entry) {
        // Older Safari fallback — only files, no folders
        const file = item.getAsFile();
        if (file) collected.push({ file, relativePath: '' });
        continue;
      }
      await walkEntry(entry, '', collected);
    }
    if (!collected.length) return;
    addToQueue(collected);
    setQueueOpen(true);
  }

  function addToQueue(files: { file: File; relativePath: string }[]) {
    let totalAdded = 0;
    let oversized = 0;
    let batchTotal = queue.reduce((s, q) => s + q.size, 0);
    const additions: QueuedItem[] = [];
    for (const { file, relativePath } of files) {
      if (file.size > MAX_FILE_BYTES) { oversized++; continue; }
      if (batchTotal + file.size > MAX_BATCH_BYTES) break;
      additions.push({
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        relativePath,
        size: file.size,
        status: 'queued',
        uploadedBytes: 0,
      });
      batchTotal += file.size;
      totalAdded++;
    }
    if (oversized > 0) {
      getToastActions().show(`${oversized} file(s) exceed the ${fmtSize(MAX_FILE_BYTES)} per-file limit and were skipped`, 'warning', { title: 'Upload' });
    }
    if (totalAdded > 0) {
      setQueue((prev) => [...prev, ...additions]);
    }
  }

  function onPickFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    addToQueue(files.map((f) => ({ file: f, relativePath: '' })));
    setQueueOpen(true);
    e.target.value = '';
  }

  function onPickFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    // webkitRelativePath looks like "topfolder/sub/file.txt" — strip the leaf
    // file name to get the directory portion.
    const out = files.map((f) => {
      const rel = (f as any).webkitRelativePath as string | undefined;
      let prefix = '';
      if (rel && rel.includes('/')) {
        prefix = rel.slice(0, rel.lastIndexOf('/') + 1);
      }
      return { file: f, relativePath: prefix };
    });
    addToQueue(out);
    setQueueOpen(true);
    e.target.value = '';
  }

  // ── Upload runner ──────────────────────────────────────────────────────────

  // Per-id buffer of uploaded-bytes counts. Progress events flow into here
  // and a single rAF drains the buffer into `queue`, so a fast progress
  // stream can't spam React with re-renders (was 60Hz × n active files
  // before). Progress events that arrive after an item left 'uploading'
  // (terminal status, manually removed, queue cleared) used to be applied
  // anyway because the rAF flush only checked existence — that caused a
  // one-frame flicker where a freshly-done item snapped back to its
  // partial byte count. The flush now skips non-'uploading' items, and
  // status transitions out of 'uploading' delete the buffer entry so a
  // late event can't even reach the flush.
  const progressBufferRef = useRef<Map<string, number>>(new Map());
  const progressFlushScheduledRef = useRef(false);
  function recordProgress(id: string, loaded: number) {
    progressBufferRef.current.set(id, loaded);
    if (progressFlushScheduledRef.current) return;
    progressFlushScheduledRef.current = true;
    requestAnimationFrame(() => {
      progressFlushScheduledRef.current = false;
      const buf = progressBufferRef.current;
      if (buf.size === 0) return;
      const snapshot = new Map(buf);
      buf.clear();
      setQueue((prev) =>
        prev.map((x) => (snapshot.has(x.id) && x.status === 'uploading')
          ? { ...x, uploadedBytes: snapshot.get(x.id)! }
          : x,
        ),
      );
    });
  }
  // Drop the buffer entry whenever an item leaves 'uploading' or the queue
  // forgets it. Cheap insurance — callers don't have to remember it.
  function dropProgress(id: string) {
    if (progressBufferRef.current.has(id)) progressBufferRef.current.delete(id);
  }

  // Single XHR upload — used by the initial attempt and the rename-retry
  // path. Resolves when the server returns 2xx, rejects with a status-tagged
  // error otherwise so callers can branch on 409 (conflict) vs other errors.
  function uploadXhr(targetPath: string, overwrite: boolean, file: File, queueId: string, signal: AbortSignal): Promise<void> {
    const url = `${apiPrefix()}/v1/files/upload-binary?path=${encodeURIComponent(targetPath)}&overwrite=${overwrite ? '1' : '0'}`;
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) recordProgress(queueId, ev.loaded); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(Object.assign(new Error(`HTTP ${xhr.status}`), { status: xhr.status, body: xhr.responseText }));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(Object.assign(new Error('Aborted'), { aborted: true }));
      signal.addEventListener('abort', () => xhr.abort());
      xhr.send(file);
    });
  }

  async function startUpload() {
    if (!queue.length || uploading) return;
    setUploading(true);
    queueAbortRef.current = new AbortController();
    const ab = queueAbortRef.current.signal;
    let conflictDefault: { mode: ConflictMode | null; applyToAll: boolean } = { mode: null, applyToAll: false };
    try {
      // Pre-create the unique directory prefixes from the queue. recursive=true
      // makes order irrelevant, so these run in parallel.
      const dirs = new Set<string>();
      for (const q of queue) {
        if (!q.relativePath) continue;
        let acc = '';
        for (const seg of q.relativePath.split('/').filter(Boolean)) {
          acc = acc ? acc + '/' + seg : seg;
          dirs.add(acc);
        }
      }
      await Promise.all([...dirs].map((d) => fetch(`${apiPrefix()}/v1/files/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentPath.replace(/\/$/, '') + '/' + d, recursive: true }),
      })));

      for (const q of queue) {
        if (ab.aborted) break;
        const dirPath = currentPath.replace(/\/$/, '') + '/' + q.relativePath;
        const targetPath = dirPath + q.file.name;
        setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'uploading', uploadedBytes: 0 } : x));

        // Strategy: try without overwrite first; on 409, ask the user (unless
        // an apply-to-all default has already been picked) and either skip /
        // overwrite / pick a server-chosen free name and retry.
        let mode: ConflictMode | 'first' = 'first';
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await uploadXhr(targetPath, mode === 'overwrite', q.file, q.id, ab);
            dropProgress(q.id);
            setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'done', uploadedBytes: q.size } : x));
            break;
          } catch (e: any) {
            if (e?.aborted) {
              dropProgress(q.id);
              setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'error', error: 'Cancelled' } : x));
              throw e;
            }
            if (e?.status !== 409) {
              dropProgress(q.id);
              setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'error', error: e?.message || 'Failed' } : x));
              break;
            }

            // Conflict — resolve mode (re-using a prior apply-to-all choice if any).
            if (conflictDefault.applyToAll && conflictDefault.mode) {
              mode = conflictDefault.mode;
            } else {
              const decision = await new Promise<{ mode: ConflictMode | null; applyToAll: boolean }>((resolve) => {
                setConflictPrompt({ name: q.file.name, onResolve: (mode, applyToAll) => resolve({ mode, applyToAll }) });
              });
              setConflictPrompt(null);
              if (!decision.mode) {
                dropProgress(q.id);
                setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'error', error: 'Cancelled' } : x));
                queueAbortRef.current?.abort();
                throw new Error('Cancelled by user');
              }
              if (decision.applyToAll) conflictDefault = { mode: decision.mode, applyToAll: true };
              mode = decision.mode;
            }

            if (mode === 'skip') {
              dropProgress(q.id);
              setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'skipped' } : x));
              break;
            }
            if (mode === 'rename') {
              const r = await fetch(`${apiPrefix()}/v1/files/find-free-name?dir=${encodeURIComponent(dirPath)}&name=${encodeURIComponent(q.file.name)}`);
              const d = await r.json();
              const renamedTarget = d.success ? d.path : dirPath + `${q.file.name}.${Date.now()}`;
              await uploadXhr(renamedTarget, false, q.file, q.id, ab);
              dropProgress(q.id);
              setQueue((prev) => prev.map((x) => x.id === q.id ? { ...x, status: 'done', uploadedBytes: q.size } : x));
              break;
            }
            // overwrite: continue to attempt #2 with the overwrite flag
          }
        }
      }
    } catch (_) {
      // Aborted / cancelled — per-item state was already updated above
    } finally {
      setUploading(false);
      refresh();
    }
  }

  function clearQueue() {
    if (uploading) return;
    progressBufferRef.current.clear();
    setQueue([]);
    setQueueOpen(false);
  }

  function removeQueueItem(id: string) {
    if (uploading) return;
    dropProgress(id);
    setQueue((prev) => prev.filter((x) => x.id !== id));
  }

  // ── mkdir ──────────────────────────────────────────────────────────────────

  async function commitMkdir() {
    const name = (mkdirInput || '').trim();
    setMkdirInput(null);
    if (!name) return;
    try {
      const target = currentPath.replace(/\/$/, '') + '/' + name;
      const r = await fetch(`${apiPrefix()}/v1/files/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to create folder');
      refresh();
    } catch (e) {
      getToastActions().show((e as Error).message, 'error', { title: 'New folder' });
    }
  }

  // ── rename ─────────────────────────────────────────────────────────────────

  async function commitRename() {
    if (!renaming) return;
    const { path: srcPath, newName } = renaming;
    setRenaming(null);
    if (!newName.trim() || newName === srcPath.split('/').pop()) return;
    try {
      const parent = srcPath.slice(0, srcPath.lastIndexOf('/'));
      const newPath = parent + '/' + newName.trim();
      const r = await fetch(`${apiPrefix()}/v1/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: srcPath, to: newPath }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to rename');
      refresh();
    } catch (e) {
      getToastActions().show((e as Error).message, 'error', { title: 'Rename' });
    }
  }

  // ── move / copy ────────────────────────────────────────────────────────────

  async function commitMove(mode: 'move' | 'copy', destDir: string, conflict: ConflictMode = 'rename') {
    if (!moveDialog) return;
    const items = moveDialog.items;
    setMoveDialog(null);
    if (!items.length || !destDir) return;
    try {
      const r = await fetch(`${apiPrefix()}/v1/files/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, destDir, conflict }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || `Failed to ${mode}`);
      const errors = (d.results || []).filter((x: any) => x.error);
      if (errors.length) {
        getToastActions().show(`${errors.length} item(s) failed: ${errors[0].error}`, 'warning', { title: mode });
      }
      refresh();
    } catch (e) {
      getToastActions().show((e as Error).message, 'error', { title: mode });
    }
  }

  // ── zip / unzip ────────────────────────────────────────────────────────────

  // Pick a sensible default archive name. One item selected → "<name>.zip"
  // next to it; multiple → "archive-YYYYMMDD-HHMMSS.zip" in the current dir.
  function defaultArchivePath(srcs: string[]): string {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
    if (srcs.length === 1) {
      const src = srcs[0];
      const parent = src.slice(0, src.lastIndexOf('/'));
      const base = src.slice(src.lastIndexOf('/') + 1);
      return parent + '/' + base + '.zip';
    }
    return currentPath.replace(/\/$/, '') + `/archive-${ts}.zip`;
  }

  function openZipDialog(srcs: string[]) {
    if (!srcs.length) return;
    setZipDialog({
      items: srcs,
      archivePath: defaultArchivePath(srcs),
      excludeHidden: !showHidden, // honor the user's hidden-toggle intent
      overwrite: false,
    });
  }

  async function commitZip() {
    if (!zipDialog) return;
    const { items, archivePath, excludeHidden, overwrite } = zipDialog;
    setZipDialog(null);
    if (!items.length || !archivePath.trim()) return;
    setZipBusy(true);
    try {
      const r = await fetch(`${apiPrefix()}/v1/files/zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, archivePath: archivePath.trim(), excludeHidden, overwrite }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to create archive');
      getToastActions().show(
        `Created ${d.archivePath.split('/').pop()} (${fmtSize(d.size)})`,
        'success',
        { title: 'Archive' },
      );
      refresh();
    } catch (e) {
      getToastActions().show((e as Error).message, 'error', { title: 'Archive' });
    } finally {
      setZipBusy(false);
    }
  }

  function openUnzipDialog(archivePath: string) {
    // Default dest = sibling folder named after the archive (sans .zip).
    const parent = archivePath.slice(0, archivePath.lastIndexOf('/'));
    const stem = archivePath.slice(archivePath.lastIndexOf('/') + 1).replace(/\.zip$/i, '');
    setUnzipDialog({
      archivePath,
      destDir: parent + '/' + stem,
      overwrite: false,
    });
  }

  async function commitUnzip() {
    if (!unzipDialog) return;
    const { archivePath, destDir, overwrite } = unzipDialog;
    setUnzipDialog(null);
    if (!archivePath || !destDir.trim()) return;
    setZipBusy(true);
    try {
      const r = await fetch(`${apiPrefix()}/v1/files/unzip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archivePath, destDir: destDir.trim(), overwrite }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to extract');
      getToastActions().show(
        `Extracted to ${destDir.split('/').pop()}`,
        'success',
        { title: 'Extract' },
      );
      refresh();
    } catch (e) {
      getToastActions().show((e as Error).message, 'error', { title: 'Extract' });
    } finally {
      setZipBusy(false);
    }
  }

  // ── trash (delete) ─────────────────────────────────────────────────────────

  async function startDelete(itemPaths: string[]) {
    if (!itemPaths.length) return;
    const usages = await Promise.all(itemPaths.map((p) =>
      fetch(`${apiPrefix()}/v1/files/disk-usage?path=${encodeURIComponent(p)}`)
        .then((r) => r.json())
        .catch(() => null)
    ));
    let totalBytes = 0;
    let totalFiles = 0;
    for (const d of usages) {
      if (d?.success) { totalBytes += d.totalBytes || 0; totalFiles += d.fileCount || 0; }
    }
    const sizeInfo = `${totalFiles} file${totalFiles === 1 ? '' : 's'}, ${fmtSize(totalBytes)}`;
    // If any item is a directory and total file count > threshold, require
    // typing the folder name in stage 3.
    const anyHeavy = totalFiles >= DELETE_CONFIRM_THRESHOLD;
    const dirItem = itemPaths.find((p) => listing?.items.some((it) => it.path === p && it.type === 'dir'));
    const folderName = anyHeavy && dirItem ? dirItem.split('/').pop() || '' : '';
    setDeletePrompt({
      items: itemPaths,
      sizeInfo,
      stage: 1,
      typed: '',
      folderName,
    });
  }

  async function commitDelete() {
    if (!deletePrompt) return;
    const items = deletePrompt.items;
    setDeletePrompt(null);
    try {
      const r = await fetch(`${apiPrefix()}/v1/files/trash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, hostDir: currentPath }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || 'Failed to delete');
      refresh();

      const id = d.trashId;
      if (!id) return;

      // Push this delete onto the undo stack. Each entry has its own 8 s
      // expiry timer that removes it (and the shared listener if the stack
      // empties). Ctrl+Z pops the most recent entry and fires its untrash.
      const expiresInMs = 8000;
      const timer = setTimeout(() => {
        const i = undoStackRef.current.findIndex((x) => x.timer === timer);
        if (i >= 0) undoStackRef.current.splice(i, 1);
        if (undoStackRef.current.length === 0 && undoKeyListenerRef.current) {
          window.removeEventListener('keydown', undoKeyListenerRef.current);
          undoKeyListenerRef.current = null;
        }
      }, expiresInMs);
      undoStackRef.current.push({ trashId: id, count: items.length, hostDir: currentPath, timer });

      // Install the shared keydown listener once. Subsequent deletes reuse
      // it — one listener, many stack entries, no leak.
      if (!undoKeyListenerRef.current) {
        const onKey = async (e: KeyboardEvent) => {
          if (!((e.ctrlKey || e.metaKey) && e.key === 'z')) return;
          const top = undoStackRef.current.pop();
          if (!top) return;
          e.preventDefault();
          clearTimeout(top.timer);
          if (undoStackRef.current.length === 0 && undoKeyListenerRef.current) {
            window.removeEventListener('keydown', undoKeyListenerRef.current);
            undoKeyListenerRef.current = null;
          }
          try {
            const ur = await fetch(`${apiPrefix()}/v1/files/untrash`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ trashId: top.trashId, hostDir: top.hostDir }),
            });
            const ud = await ur.json();
            if (!ud.success) throw new Error(ud.error || 'Failed to undo');
            getToastActions().show(`${top.count} item(s) restored`, 'success', { title: 'Trash' });
            refresh();
          } catch (err) {
            getToastActions().show((err as Error).message, 'error', { title: 'Trash' });
          }
        };
        window.addEventListener('keydown', onKey);
        undoKeyListenerRef.current = onKey;
      }

      getToastActions().show(
        `${items.length} item(s) moved to trash. Press Ctrl+Z to undo.`,
        'success',
        { title: 'Trash', duration: expiresInMs },
      );
    } catch (e) {
      getToastActions().show((e as Error).message, 'error', { title: 'Trash' });
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Stable selected list (preserving listing order) for batch ops.
  const selectedArr = useMemo(() => items.filter((it) => selected.has(it.path)).map((it) => it.path), [items, selected]);

  // True iff selection is exactly one .zip file → enables the Extract button.
  // Folder selections never qualify; a single non-zip selection doesn't either.
  const isSingleZipSelection = useMemo(() => {
    if (selectedArr.length !== 1) return false;
    const it = items.find((x) => x.path === selectedArr[0]);
    return !!(it && it.type === 'file' && it.name.toLowerCase().endsWith('.zip'));
  }, [selectedArr, items]);

  const queueTotal = queue.reduce((s, q) => s + q.size, 0);
  const queueDone = queue.reduce((s, q) => s + q.uploadedBytes, 0);
  const queuePct = queueTotal === 0 ? 0 : Math.round((queueDone / queueTotal) * 100);

  const body = (
    <div
      className={`fm-root${dragOver ? ' fm-drag-over' : ''}${embedded ? ' fm-embedded' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDrop}
    >
        {dragOver && (
          <div className="fm-drop-overlay">
            <div className="fm-drop-overlay-inner">
              <div className="fm-drop-icon">⬇</div>
              <div className="fm-drop-title">Drop to queue upload</div>
              <div className="fm-drop-hint">Files will be reviewed before uploading to {currentPath}</div>
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="fm-toolbar">
          {/* YHA Net node selector (single active node for ops; use FilePicker for merged view) */}
          {netNodes.filter((n) => n.enabled !== false).length > 0 && (
            <select
              className="fm-scope"
              title="File ops target node (from YHA Net enabled nodes). This device = local; others proxy over your fleet link."
              value={activeNodeId || ''}
              onChange={(e) => {
                const v = e.target.value || null;
                setActiveNodeId(v);
                activeNodeIdRef.current = v;
                // refresh listing under the new node ( ~ resolves to that node's home)
                setTimeout(() => navigate('~'), 0);
              }}
              style={{ marginRight: 8 }}
            >
              <option value="">This device</option>
              {netNodes.filter((n) => n.enabled !== false).map((n) => (
                <option key={n.id} value={n.id}>{n.label || n.computerName || n.id}</option>
              ))}
            </select>
          )}
          <Breadcrumb path={currentPath} onNavigate={navigate} classPrefix="fm" />
          <div className="fm-toolbar-spacer" />
          <label className="fm-hidden-toggle" title="Show node_modules, .git, .trash, .DS_Store, dotfiles">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            hidden
          </label>
          <button className="fm-btn" onClick={refresh} title="Refresh">↻</button>
          <button className="fm-btn" onClick={() => setMkdirInput('')} title="New folder">+ folder</button>
          <input
            type="file"
            id="fm-pick-files"
            multiple
            style={{ display: 'none' }}
            onChange={onPickFiles}
          />
          <input
            type="file"
            id="fm-pick-folder"
            multiple
            // @ts-expect-error webkitdirectory is non-standard but well-supported
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={onPickFolder}
          />
          <button className="fm-btn" onClick={() => document.getElementById('fm-pick-files')?.click()} title={`Add files to upload queue (max ${fmtSize(MAX_FILE_BYTES)} per file)`}>
            ⬆ files
          </button>
          <button className="fm-btn" onClick={() => document.getElementById('fm-pick-folder')?.click()} title="Add folder (with subfolders) to queue">
            ⬆ folder
          </button>
          <button
            className="fm-btn"
            disabled={zipBusy || selectedArr.length === 0}
            title={selectedArr.length === 0 ? 'Select files/folders to zip' : `Create archive from ${selectedArr.length} item(s)`}
            onClick={() => openZipDialog(selectedArr)}
          >
            🗜 zip
          </button>
          {queue.length > 0 && (
            <button className="fm-btn fm-btn-accent" onClick={() => setQueueOpen((v) => !v)}>
              queue ({queue.length})
            </button>
          )}
        </div>

        {/* mkdir inline input */}
        {mkdirInput !== null && (
          <div className="fm-inline-input">
            <span className="fm-inline-label">Folder name:</span>
            <input
              autoFocus
              value={mkdirInput}
              onChange={(e) => setMkdirInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitMkdir();
                else if (e.key === 'Escape') setMkdirInput(null);
              }}
              placeholder="my-folder"
            />
            <button className="fm-btn" onClick={commitMkdir}>Create</button>
            <button className="fm-btn" onClick={() => setMkdirInput(null)}>Cancel</button>
          </div>
        )}

        {/* Listing */}
        <div className="fm-list" role="listbox" aria-label="Directory contents" aria-multiselectable="true" onClick={() => setSelected(new Set())}>
          {loading && <div className="fm-empty">Loading…</div>}
          {error && <div className="fm-empty fm-error">{error}</div>}
          {!loading && !error && listing && (
            <>
              {listing.parent && (
                <div
                  className="fm-row fm-parent"
                  role="option"
                  aria-selected={false}
                  aria-label="Parent directory"
                  onDoubleClick={() => navigate(listing.parent!)}
                  onClick={(e) => { e.stopPropagation(); navigate(listing.parent!); }}
                >
                  <span className="fm-icon">⬆</span>
                  <span className="fm-name">..</span>
                </div>
              )}
              {items.length === 0 ? (
                <div className="fm-empty">Empty directory{!showHidden && listing.items.length > 0 ? ' (toggle "hidden" to see filtered items)' : ''}</div>
              ) : (
                items.map((it) => {
                  const isSel = selected.has(it.path);
                  const isRenaming = renaming?.path === it.path;
                  return (
                    <div
                      key={it.path}
                      role="option"
                      aria-selected={isSel}
                      aria-label={`${it.type === 'dir' ? 'Folder' : 'File'}: ${it.path}`}
                      className={`fm-row${it.type === 'dir' ? ' fm-dir' : ' fm-file'}${isSel ? ' fm-selected' : ''}`}
                      onClick={(e) => onItemClick(e, it)}
                      onDoubleClick={() => onItemDoubleClick(it)}
                    >
                      <span className="fm-icon">{it.type === 'dir' ? '📁' : fileIcon(it.name)}</span>
                      {isRenaming ? (
                        <input
                          autoFocus
                          className="fm-rename-input"
                          value={renaming!.newName}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenaming({ ...renaming!, newName: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            else if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={commitRename}
                        />
                      ) : (
                        <span className="fm-name" title={it.path}>{it.name}</span>
                      )}
                      {!isRenaming && it.size != null && it.type === 'file' && (
                        <span className="fm-size">{fmtSize(it.size)}</span>
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Footer: batch actions */}
        <div className="fm-footer">
          <div className="fm-sel-info">
            {selectedArr.length === 0 ? 'No items selected' : `${selectedArr.length} selected`}
          </div>
          <button className="fm-btn" disabled={selectedArr.length !== 1} onClick={() => {
            const p = selectedArr[0];
            const name = p.split('/').pop() || '';
            setRenaming({ path: p, newName: name });
          }}>Rename</button>
          <button className="fm-btn" disabled={selectedArr.length === 0} onClick={() => setMoveDialog({ items: selectedArr, mode: 'move', dest: currentPath })}>Move…</button>
          <button className="fm-btn" disabled={selectedArr.length === 0} onClick={() => setMoveDialog({ items: selectedArr, mode: 'copy', dest: currentPath })}>Copy…</button>
          <button
            className="fm-btn"
            disabled={!isSingleZipSelection || zipBusy}
            title={isSingleZipSelection ? 'Extract this archive' : 'Select a single .zip file to extract'}
            onClick={() => openUnzipDialog(selectedArr[0])}
          >
            Extract…
          </button>
          <button className="fm-btn fm-btn-danger" disabled={selectedArr.length === 0} onClick={() => startDelete(selectedArr)}>Delete</button>
        </div>

        {/* Upload queue panel */}
        {queueOpen && queue.length > 0 && (
          <div className="fm-queue">
            <div className="fm-queue-header">
              <strong>Upload queue</strong>
              <span className="fm-queue-summary">
                {queue.length} item(s) · {fmtSize(queueTotal)} → {currentPath}
              </span>
              <div className="fm-queue-spacer" />
              <button className="fm-btn" onClick={() => setQueueOpen(false)}>collapse</button>
            </div>
            <div className="fm-queue-progress">
              <div className="fm-queue-bar" style={{ width: `${queuePct}%` }} />
              <span className="fm-queue-pct">{queuePct}%</span>
            </div>
            <div className="fm-queue-list">
              {queue.map((q) => (
                <div key={q.id} className={`fm-queue-row fm-queue-${q.status}`}>
                  <span className="fm-queue-status">{q.status === 'queued' ? '·' : q.status === 'uploading' ? '↑' : q.status === 'done' ? '✓' : q.status === 'skipped' ? '–' : '✗'}</span>
                  <span className="fm-queue-name" title={q.relativePath + q.file.name}>{q.relativePath}{q.file.name}</span>
                  <span className="fm-queue-size">{fmtSize(q.size)}</span>
                  {q.status === 'uploading' && (
                    <span className="fm-queue-rowpct">{Math.round((q.uploadedBytes / q.size) * 100)}%</span>
                  )}
                  {q.error && <span className="fm-queue-err" title={q.error}>{q.error}</span>}
                  {!uploading && q.status === 'queued' && (
                    <button className="fm-queue-rm" onClick={() => removeQueueItem(q.id)} title="Remove from queue">✕</button>
                  )}
                </div>
              ))}
            </div>
            <div className="fm-queue-footer">
              <button className="fm-btn" disabled={uploading} onClick={clearQueue}>Clear queue</button>
              <div className="fm-queue-spacer" />
              <button className="fm-btn fm-btn-primary" disabled={uploading || queue.length === 0} onClick={startUpload}>
                {uploading ? 'Uploading…' : `Start upload (${queue.filter((q) => q.status === 'queued').length})`}
              </button>
            </div>
          </div>
        )}

        {/* Conflict prompt overlay */}
        {conflictPrompt && (
          <div className="fm-modal-backdrop">
            <div className="fm-modal">
              <h3>File exists</h3>
              <p>A file named <code>{conflictPrompt.name}</code> already exists. What should we do?</p>
              <ConflictChoice
                onChoose={(mode, applyToAll) => {
                  conflictPrompt.onResolve(mode, applyToAll);
                }}
              />
            </div>
          </div>
        )}

        {/* Move/Copy dialog */}
        {moveDialog && (
          <div className="fm-modal-backdrop">
            <div className="fm-modal">
              <h3>{moveDialog.mode === 'move' ? 'Move' : 'Copy'} {moveDialog.items.length} item(s)</h3>
              <p>Destination directory:</p>
              <input
                className="fm-modal-input"
                autoFocus
                value={moveDialog.dest}
                onChange={(e) => setMoveDialog({ ...moveDialog, dest: e.target.value })}
                placeholder="/home/user/somewhere"
              />
              <p className="fm-hint">Conflicts get auto-renamed (foo.txt → foo (1).txt)</p>
              <div className="fm-modal-actions">
                <button className="fm-btn" onClick={() => setMoveDialog(null)}>Cancel</button>
                <button className="fm-btn fm-btn-primary" onClick={() => commitMove(moveDialog.mode, moveDialog.dest, 'rename')}>
                  {moveDialog.mode === 'move' ? 'Move' : 'Copy'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Zip dialog */}
        {zipDialog && (
          <div className="fm-modal-backdrop">
            <div className="fm-modal">
              <h3>Create archive ({zipDialog.items.length} item{zipDialog.items.length === 1 ? '' : 's'})</h3>
              <p>Archive path:</p>
              <input
                className="fm-modal-input"
                autoFocus
                value={zipDialog.archivePath}
                onChange={(e) => setZipDialog({ ...zipDialog, archivePath: e.target.value })}
                placeholder="/home/user/path/to/archive.zip"
              />
              <label className="fm-conflict-apply" style={{ marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={zipDialog.excludeHidden}
                  onChange={(e) => setZipDialog({ ...zipDialog, excludeHidden: e.target.checked })}
                />
                Exclude {[...HIDDEN_NAMES].join(', ')}
              </label>
              <label className="fm-conflict-apply">
                <input
                  type="checkbox"
                  checked={zipDialog.overwrite}
                  onChange={(e) => setZipDialog({ ...zipDialog, overwrite: e.target.checked })}
                />
                Overwrite if archive already exists
              </label>
              <p className="fm-hint">
                Selected items are added at the archive root. Without overwrite, an existing archive at the same path makes the request fail.
              </p>
              <div className="fm-modal-actions">
                <button className="fm-btn" onClick={() => setZipDialog(null)} disabled={zipBusy}>Cancel</button>
                <button
                  className="fm-btn fm-btn-primary"
                  disabled={zipBusy || !zipDialog.archivePath.trim() || !zipDialog.archivePath.toLowerCase().endsWith('.zip')}
                  onClick={commitZip}
                >
                  {zipBusy ? 'Creating…' : 'Create archive'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Unzip dialog */}
        {unzipDialog && (
          <div className="fm-modal-backdrop">
            <div className="fm-modal">
              <h3>Extract archive</h3>
              <p>Archive: <code>{unzipDialog.archivePath.split('/').pop()}</code></p>
              <p>Destination directory:</p>
              <input
                className="fm-modal-input"
                autoFocus
                value={unzipDialog.destDir}
                onChange={(e) => setUnzipDialog({ ...unzipDialog, destDir: e.target.value })}
                placeholder="/home/user/path/to/extracted"
              />
              <label className="fm-conflict-apply" style={{ marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={unzipDialog.overwrite}
                  onChange={(e) => setUnzipDialog({ ...unzipDialog, overwrite: e.target.checked })}
                />
                Overwrite existing files in destination
              </label>
              <p className="fm-hint">
                Destination directory is created if missing. Without overwrite, files that already exist at the destination are kept.
              </p>
              <div className="fm-modal-actions">
                <button className="fm-btn" onClick={() => setUnzipDialog(null)} disabled={zipBusy}>Cancel</button>
                <button
                  className="fm-btn fm-btn-primary"
                  disabled={zipBusy || !unzipDialog.destDir.trim()}
                  onClick={commitUnzip}
                >
                  {zipBusy ? 'Extracting…' : 'Extract'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Triple-confirm delete */}
        {deletePrompt && (
          <div className="fm-modal-backdrop">
            <div className="fm-modal fm-modal-danger">
              {deletePrompt.stage === 1 && (
                <>
                  <h3>Delete {deletePrompt.items.length} item(s)?</h3>
                  <p>{deletePrompt.sizeInfo} will be moved to <code>.trash/</code> in {currentPath}.</p>
                  <ul className="fm-delete-list">
                    {deletePrompt.items.slice(0, 8).map((p) => (
                      <li key={p}><code>{p.split('/').pop()}</code></li>
                    ))}
                    {deletePrompt.items.length > 8 && <li>… and {deletePrompt.items.length - 8} more</li>}
                  </ul>
                  <div className="fm-modal-actions">
                    <button className="fm-btn" onClick={() => setDeletePrompt(null)}>Cancel</button>
                    <button className="fm-btn fm-btn-danger" onClick={() => setDeletePrompt({ ...deletePrompt, stage: 2 })}>Continue</button>
                  </div>
                </>
              )}
              {deletePrompt.stage === 2 && (
                <>
                  <h3>Type DELETE to confirm</h3>
                  <p>You're about to delete {deletePrompt.items.length} item(s) totaling {deletePrompt.sizeInfo}. This will move them to <code>.trash/</code>; the trash retains them until you empty it.</p>
                  <input
                    className="fm-modal-input"
                    autoFocus
                    value={deletePrompt.typed}
                    onChange={(e) => setDeletePrompt({ ...deletePrompt, typed: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && deletePrompt.typed === 'DELETE') {
                        if (deletePrompt.folderName) setDeletePrompt({ ...deletePrompt, stage: 3, typed: '' });
                        else commitDelete();
                      }
                    }}
                    placeholder="DELETE"
                  />
                  <div className="fm-modal-actions">
                    <button className="fm-btn" onClick={() => setDeletePrompt(null)}>Cancel</button>
                    <button
                      className="fm-btn fm-btn-danger"
                      disabled={deletePrompt.typed !== 'DELETE'}
                      onClick={() => {
                        if (deletePrompt.folderName) setDeletePrompt({ ...deletePrompt, stage: 3, typed: '' });
                        else commitDelete();
                      }}
                    >Continue</button>
                  </div>
                </>
              )}
              {deletePrompt.stage === 3 && (
                <>
                  <h3>Heavy delete — confirm folder name</h3>
                  <p>You're about to delete a folder containing many items. Type <code>{deletePrompt.folderName}</code> to confirm.</p>
                  <input
                    className="fm-modal-input"
                    autoFocus
                    value={deletePrompt.typed}
                    onChange={(e) => setDeletePrompt({ ...deletePrompt, typed: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && deletePrompt.typed === deletePrompt.folderName) {
                        commitDelete();
                      }
                    }}
                    placeholder={deletePrompt.folderName}
                  />
                  <div className="fm-modal-actions">
                    <button className="fm-btn" onClick={() => setDeletePrompt(null)}>Cancel</button>
                    <button
                      className="fm-btn fm-btn-danger"
                      disabled={deletePrompt.typed !== deletePrompt.folderName}
                      onClick={commitDelete}
                    >Move to trash</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
    </div>
  );

  if (embedded) {
    // Bare body — caller provides the wrapper (height-bounded, scrollable).
    return isOpen ? body : null;
  }

  return (
    <MoveableWindow
      isOpen={isOpen}
      title={
        <span>
          <span style={{ marginRight: 6 }}>📁</span>
          File Manager
          <span className="fm-title-path">{currentPath}</span>
        </span>
      }
      storageKey="yha.fileManager"
      defaultGeometry={{ width: 980, height: 660 }}
      minWidth={600}
      minHeight={400}
      onClose={close}
      bodyClassName="fm-body"
    >
      {body}
    </MoveableWindow>
  );
}

// ── Conflict choice subcomponent ─────────────────────────────────────────────

function ConflictChoice({ onChoose }: { onChoose: (mode: ConflictMode | null, applyToAll: boolean) => void }) {
  const [applyToAll, setApplyToAll] = useState(false);
  return (
    <div className="fm-conflict">
      <label className="fm-conflict-apply">
        <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
        Apply to all conflicts in this batch
      </label>
      <div className="fm-modal-actions fm-conflict-actions">
        <button className="fm-btn" onClick={() => onChoose(null, false)}>Cancel</button>
        <button className="fm-btn" onClick={() => onChoose('skip', applyToAll)}>Skip</button>
        <button className="fm-btn" onClick={() => onChoose('rename', applyToAll)}>Rename</button>
        <button className="fm-btn fm-btn-danger" onClick={() => onChoose('overwrite', applyToAll)}>Overwrite</button>
      </div>
    </div>
  );
}
