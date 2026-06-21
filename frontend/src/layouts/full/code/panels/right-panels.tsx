// Right-stack panel renderers. Each panel wraps a real module from the rest
// of the app — FileManager, GithubModal — using their `embedded` modes so
// the same components serve here, the modal trigger, and any other future
// surface. Rewind is the one panel that owns its own list because the
// forge-bar already exposes the underlying store.

import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { useForgeStore, restoreEdit, pollRecentEdit } from '../../../../forge-bar/forge-state.js';
import { toast } from '../../../../toast.js';

// Lazy-load both modules so the panel chunk only pulls them when the user
// actually flips into Code view — keeps the lazy CodeView chunk small.
const FileManager = lazy(() =>
  import('../../../../modals/FileManager.js').then((m) => ({ default: m.FileManager })),
);
const GithubModal = lazy(() =>
  import('../../../../panels/GithubModal.js').then((m) => ({ default: m.GithubModal })),
);

export function FilesPanel() {
  return (
    <div className="cv-pane cv-files-pane">
      <Suspense fallback={<div className="cv-pane-status">Loading file manager…</div>}>
        <FileManager embedded />
      </Suspense>
    </div>
  );
}

export function GithubPanel() {
  return (
    <div className="cv-pane cv-github-pane">
      <Suspense fallback={<div className="cv-pane-status">Loading GitHub panel…</div>}>
        <GithubModal embedded />
      </Suspense>
    </div>
  );
}

interface RewindEntry {
  id: string;
  ts: number;
  module: string;
  trigger: string;
  fileCount: number;
}

export function RewindPanel() {
  const recent = useForgeStore((s) => s.recentEdit);
  const [list, setList] = useState<RewindEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch('/__rewind/api/edits?limit=50');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as {
        edits?: Array<{
          id: string; ts: number; module: string; trigger: string;
          files?: unknown[];
        }>;
      };
      setList(
        (d.edits ?? []).map((e) => ({
          id: e.id,
          ts: e.ts,
          module: e.module,
          trigger: e.trigger,
          fileCount: e.files?.length || 0,
        })),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void pollRecentEdit();
    void refresh();
  }, [refresh]);

  // Refresh the list whenever forge-state announces a new most-recent edit,
  // so the panel mirrors what the toolbar shows without a manual reload.
  useEffect(() => { if (recent) void refresh(); }, [recent, refresh]);

  const onRestore = useCallback(async (id: string) => {
    setRestoringId(id);
    try {
      const msg = await restoreEdit(id);
      toast.show(msg, 'success', { title: 'Rewind' });
      void refresh();
    } catch (e) {
      toast.show((e as Error).message, 'error', { title: 'Rewind failed' });
    } finally {
      setRestoringId(null);
    }
  }, [refresh]);

  return (
    <div className="cv-pane cv-rewind-pane">
      <div className="cv-rewind-toolbar">
        <span className="cv-rewind-title">Recent agent edits</span>
        <button
          className="cv-files-up"
          onClick={() => void refresh()}
          title="Refresh"
          aria-label="Refresh"
        >↻</button>
      </div>
      <div className="cv-rewind-list">
        {loading && <div className="cv-pane-status">Loading…</div>}
        {err && <div className="cv-pane-status cv-pane-status--error">{err}</div>}
        {!loading && !err && list.length === 0 && (
          <div className="cv-pane-status">No agent edits recorded yet.</div>
        )}
        {!loading && !err && list.map((e) => (
          <div key={e.id} className="cv-rewind-row">
            <div className="cv-rewind-line">
              <strong>{e.module}</strong>
              <span className="cv-rewind-trigger">{e.trigger}</span>
            </div>
            <div className="cv-rewind-line cv-rewind-meta">
              {e.fileCount} file{e.fileCount === 1 ? '' : 's'} ·{' '}
              {new Date(e.ts).toLocaleTimeString()}
            </div>
            <button
              className="fp-btn fp-btn-primary cv-rewind-restore"
              onClick={() => void onRestore(e.id)}
              disabled={restoringId !== null}
            >
              {restoringId === e.id ? 'Restoring…' : '↩ Rewind'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
