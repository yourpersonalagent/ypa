// WorkflowPicker — React popover for workflow save/load/rename/delete/import/export.
// Replaces the vanilla _render/_renderScroll/_attachScrollListeners in workflow.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/appStore.js';
import { getAppActions, getGraphActions, getGraphState } from '../stores/index.js';
import { api } from '../api.js';
import { save as appSave } from '../state.js';
import { workflow } from './workflow.js';
import { toast } from '../toast.js';
import { Save, Plus, Pencil, X, Folder } from '../chat/icons.js';

interface WorkflowEntry {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
}

function base(): string {
  return api.config.baseUrl || window.location.origin;
}

async function fetchList(): Promise<WorkflowEntry[]> {
  const r = await fetch(base() + '/v1/workflows/');
  const d = await r.json();
  return (d.workflows || []) as WorkflowEntry[];
}

async function apiCreate(name: string, graph: unknown): Promise<{ success: boolean; workflow: WorkflowEntry }> {
  const r = await fetch(base() + '/v1/workflows/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, graph }),
  });
  return r.json();
}

async function apiPatch(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(base() + `/v1/workflows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return r.json();
}

async function apiDelete(id: string): Promise<unknown> {
  const r = await fetch(base() + `/v1/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return r.json();
}

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

interface PopoverPos {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
}

function computePos(anchor: HTMLElement, expanded: boolean): PopoverPos {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const margin = 8;
  const target = expanded ? 420 : 340;
  const pw = Math.min(target, vw - 16);
  const left = Math.max(margin, Math.min(vw - pw - margin, r.left));
  if (r.bottom < vh / 2) {
    return { left, top: r.bottom + 6, width: pw };
  } else {
    return { left, bottom: vh - r.top + 6, width: pw };
  }
}

interface RenameRowProps {
  entry: WorkflowEntry;
  onRenamed: (id: string, name: string) => void;
}

function RenameInput({ entry, onRenamed }: RenameRowProps) {
  const [value, setValue] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  async function commit() {
    const newName = value.trim();
    if (newName && newName !== entry.name) {
      await apiPatch(entry.id, { name: newName });
      onRenamed(entry.id, newName);
    } else {
      onRenamed(entry.id, entry.name);
    }
  }

  return (
    <input
      ref={inputRef}
      className="ss-name-input"
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { setValue(entry.name); onRenamed(entry.id, entry.name); }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function WorkflowPicker({ open, onClose, anchorRef }: Props) {
  const wfName = useAppStore((s) => s.workflow.name);
  const wfId   = useAppStore((s) => s.workflow.id);

  const [workflows, setWorkflows] = useState<WorkflowEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [nameErr, setNameErr] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // MD-import panel state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importTaRef = useRef<HTMLTextAreaElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setWorkflows(await fetchList());
    } finally {
      setLoading(false);
    }
  }, []);

  // Sync name input with current workflow when picker opens
  useEffect(() => {
    if (open) {
      setNameInput(wfName || '');
      setSearch('');
      setNameErr(false);
      setRenamingId(null);
      setImportOpen(false);
      setImportText('');
      setImportBusy(false);
      setImportError(null);
    }
  }, [open, wfName]);

  // Reload list when picker opens (separate effect so it doesn't refire on wfName changes)
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Position relative to anchor — recomputes when the import panel toggles since
  // the popover widens to 420px for the textarea.
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    setPos(computePos(anchorRef.current, importOpen));
    function onResize() {
      if (anchorRef.current) setPos(computePos(anchorRef.current, importOpen));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, anchorRef, importOpen]);

  // Autofocus the textarea when the import panel opens
  useEffect(() => {
    if (importOpen) importTaRef.current?.focus();
  }, [importOpen]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Outside click
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, onClose, anchorRef]);

  async function save() {
    const name = nameInput.trim();
    if (!name) { setNameErr(true); return; }
    setNameErr(false);
    const { nodes, links } = getGraphState();
    if (wfId && (!name || name === wfName)) {
      await apiPatch(wfId, { graph: { nodes, links } });
      setWorkflows((ws) => ws.map((w) => w.id === wfId ? { ...w, updatedAt: new Date().toISOString() } : w));
      toast.show(`Saved "${wfName}"`);
    } else if (name) {
      const d = await apiCreate(name, { nodes, links });
      if (d.success) {
        getAppActions().setWorkflow({ id: d.workflow.id, name: d.workflow.name });
        if (d.workflow.id) localStorage.setItem('yha.wfId', d.workflow.id);
        setWorkflows((ws) => [d.workflow, ...ws]);
        setNameInput(d.workflow.name);
        toast.show(`Saved as "${d.workflow.name}"`);
      }
    }
  }

  async function loadWorkflow(id: string) {
    onClose();
    await workflow.load(id);
  }

  async function del(id: string) {
    const wf = workflows.find((w) => w.id === id);
    if (!confirm(`Delete "${wf?.name || id}"?`)) return;
    await apiDelete(id);
    setWorkflows((ws) => ws.filter((w) => w.id !== id));
    if (wfId === id) getAppActions().setWorkflow({ id: null, name: '' });
  }

  function renamed(id: string, newName: string) {
    setRenamingId(null);
    if (newName !== workflows.find((w) => w.id === id)?.name) {
      setWorkflows((ws) => ws.map((w) => w.id === id ? { ...w, name: newName } : w));
      if (wfId === id) {
        getAppActions().setWorkflow({ id, name: newName });
      }
    }
  }

  function newWorkflow() {
    onClose();
    getGraphActions().clear();
    getAppActions().setWorkflow({ id: null, name: '' });
    localStorage.removeItem('yha.wfId');
    appSave.graph();
  }

  function doExportJson() {
    onClose();
    workflow.exportJson();
  }

  function doImportJson() {
    onClose();
    workflow.importJson();
  }

  function doExportMd() {
    onClose();
    workflow.exportMd();
  }

  // MD import flow:
  //   1st click  → open inline panel (textarea + file shortcut)
  //   2nd click with text → run import
  //   2nd click with empty textarea → close panel
  async function handleMdButton() {
    if (importBusy) return;
    if (!importOpen) {
      setImportOpen(true);
      setImportError(null);
      return;
    }
    const txt = importText.trim();
    if (!txt) {
      setImportOpen(false);
      setImportError(null);
      return;
    }
    setImportBusy(true);
    setImportError(null);
    const r = await workflow.importMdFromContent(txt);
    setImportBusy(false);
    if (r.ok) {
      onClose();
      setImportOpen(false);
      setImportText('');
    } else {
      setImportError(r.error || 'Unknown error');
    }
  }

  async function handleFilePick(file: File | null | undefined) {
    if (!file || importBusy) return;
    setImportBusy(true);
    setImportError(null);
    try {
      const content = await file.text();
      const r = await workflow.importMdFromContent(content);
      if (r.ok) {
        onClose();
        setImportOpen(false);
        setImportText('');
      } else {
        setImportError(r.error || 'Unknown error');
      }
    } finally {
      setImportBusy(false);
      if (importFileRef.current) importFileRef.current.value = '';
    }
  }

  function doInjectPrompt() {
    onClose();
    workflow.injectMasterPrompt();
  }

  // Dynamic MD button label/state
  const mdHasText = importText.trim().length > 0;
  let mdLabel = '⤴ MD';
  let mdTitle = 'Import workflow MD (paste or file)';
  let mdPrimary = false;
  if (importBusy) {
    mdLabel = '⏳';
    mdTitle = 'Importing…';
  } else if (importOpen && mdHasText) {
    mdLabel = '✓ Import';
    mdTitle = 'Import workflow MD from textarea';
    mdPrimary = true;
  } else if (importOpen) {
    mdLabel = '✕ Close MD';
    mdTitle = 'Close MD import panel';
  }

  const filtered = search
    ? workflows.filter((w) => w.name.toLowerCase().includes(search.toLowerCase()))
    : workflows;

  if (!open || !pos) return null;

  const popStyle: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    left: pos.left,
    width: pos.width,
    ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
  };

  return createPortal(
    <div
      ref={popRef}
      className="popover"
      style={popStyle}
    >
      <div className="ss-header">
        <div className="wf-save-row">
          <input
            className={`wf-name-inp${nameErr ? ' wf-name-err' : ''}`}
            id="wf-name-inp"
            placeholder="Name this workflow…"
            value={nameInput}
            maxLength={80}
            onChange={(e) => { setNameInput(e.target.value); if (nameErr) setNameErr(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="wf-save-icon"
            title="Save workflow"
            onClick={(e) => { e.stopPropagation(); save(); }}
          >
            <Save size={14} strokeWidth={1.75} />
          </button>
          <button
            className="wf-new-icon"
            title="New — clear canvas"
            onClick={(e) => { e.stopPropagation(); newWorkflow(); }}
          >
            <Plus size={14} strokeWidth={1.75} />
          </button>
        </div>
        <input
          className="ss-search"
          type="search"
          placeholder="Search saved workflows…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <div className="ss-scroll" id="wf-scroll">
        {loading && workflows.length === 0 ? (
          <div className="popover-group" style={{ padding: '8px 12px', opacity: 0.5 }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="popover-group" style={{ padding: '8px 12px', opacity: 0.5 }}>
            {search ? 'No matches' : 'No saved workflows'}
          </div>
        ) : (
          filtered.map((wf) => (
            <div
              key={wf.id}
              className={`ss-item${wf.id === wfId ? ' current' : ''}`}
              onClick={() => { if (renamingId !== wf.id) loadWorkflow(wf.id); }}
            >
              {renamingId === wf.id ? (
                <RenameInput entry={wf} onRenamed={renamed} />
              ) : (
                <span className="ss-name" title={wf.name}>{wf.name}</span>
              )}
              <span className="ss-actions">
                <button
                  className="ss-rename"
                  title="Rename"
                  onClick={(e) => { e.stopPropagation(); setRenamingId(wf.id); }}
                >
                  <Pencil size={13} strokeWidth={1.75} />
                </button>
                <button
                  className="ss-del"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); del(wf.id); }}
                >
                  <X size={13} strokeWidth={1.75} />
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      {importOpen && (
        <div className="wf-import-panel">
          <textarea
            ref={importTaRef}
            className="wf-import-ta"
            placeholder="Paste workflow markdown here…"
            value={importText}
            disabled={importBusy}
            onChange={(e) => { setImportText(e.target.value); if (importError) setImportError(null); }}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="wf-import-row">
            <span className="wf-import-or">or</span>
            <label className={`wf-import-file${importBusy ? ' wf-import-file-disabled' : ''}`}>
              <input
                ref={importFileRef}
                type="file"
                accept=".md,text/markdown,text/plain"
                hidden
                disabled={importBusy}
                onChange={(e) => handleFilePick(e.target.files?.[0])}
              />
              <Folder size={13} strokeWidth={1.75} />
              <span className="wf-import-file-label">Choose file…</span>
            </label>
            {importError && <span className="wf-import-err" title={importError}>⚠ {importError}</span>}
          </div>
        </div>
      )}

      <div className="wf-footer">
        <button className="wf-foot-btn" title="Import JSON" onClick={doImportJson}>↑ JSON</button>
        <button className="wf-foot-btn" title="Export JSON" onClick={doExportJson}>↓ JSON</button>
        <button
          className={`wf-foot-btn${mdPrimary ? ' wf-foot-primary' : ''}`}
          title={mdTitle}
          disabled={importBusy}
          onClick={handleMdButton}
        >
          {mdLabel}
        </button>
        <button className="wf-foot-btn" title="Export session as MD" onClick={doExportMd}>↓ MD</button>
        <button className="wf-foot-btn" title="Insert workflow master prompt into chat" onClick={doInjectPrompt}>🪄 Prompt</button>
      </div>
    </div>,
    document.body
  );
}
