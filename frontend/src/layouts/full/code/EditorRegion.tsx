// EditorRegion — the centre of the Code view.
//
// One CodeMirror EditorView, many tabs. Each tab owns its own EditorState
// (and therefore its own doc, history, scroll, cursor); switching tabs is a
// `view.setState()` call, NOT a remount. This is what keeps the editor cheap
// even with several files open.
//
// LRU eviction: at most 6 tabs keep an in-memory EditorState. Beyond that,
// the LRU tab's state is dropped but the tab descriptor (id/path/name) stays
// — re-activating it re-reads the file from disk.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fileExt, fileIcon, shikiLang } from '../../../util/file-lang.js';
import { toast } from '../../../toast.js';
import { codeView } from './code-view-bridge.js';
import { CodeMinimap } from '../../../modules/files-editor/CodeMinimap.js';
import { EditorToolbar } from '../../../modules/files-editor/EditorToolbar.js';
import { useForgeStore } from '../../../forge-bar/forge-state.js';
import { useCodeLayout } from './code-view-state.js';
import type { CmCodeHost } from '../../../modules/files-editor/cm-bundle.js';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

const cmPromise = import('../../../modules/files-editor/cm-bundle.js');

const LRU_LIMIT = 6;

interface Tab {
  id: string;
  path: string;
  name: string;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  mode: 'code' | 'markdown';
  // True after a forge-state.recentEdit announced a write to this path while
  // the tab was open. Cleared on save or reload. Used to highlight the reload
  // button so the user knows the disk diverged from the buffer.
  externallyChanged: boolean;
}

// Rewind records store paths relative to the YHA install root; the editor
// stores absolute paths. A suffix match with `/` boundary is a robust check.
function pathMatches(tabPath: string, relPath: string): boolean {
  if (!relPath) return false;
  if (tabPath === relPath) return true;
  return tabPath.endsWith('/' + relPath);
}

function tabMode(name: string): 'code' | 'markdown' {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return (ext === 'md' || ext === 'markdown' || ext === 'mdx') ? 'markdown' : 'code';
}

interface FileReadResponse  { success: boolean; content: string; error?: string; }
interface FileWriteResponse { success: boolean; error?: string; }

function isDarkVariant(): boolean {
  return document.documentElement.getAttribute('data-variant') !== 'bright';
}

export function EditorRegion() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cmRef = useRef<CmCodeHost | null>(null);
  const cmReadyRef = useRef<Promise<CmCodeHost> | null>(null);
  // States are kept outside React because EditorState is heavy and mutates
  // via CM's transaction model — putting it in setState would tear it down.
  const statesRef = useRef<Map<string, EditorState>>(new Map());
  // LRU order: most-recently-active at the end.
  const lruRef = useRef<string[]>([]);
  const baseUrl = window.location.origin;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const saveActiveRef = useRef<() => Promise<void>>(async () => {});
  // Don't save back to the bridge while the initial load is still rehydrating.
  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const setTabsSynced = useCallback((next: Tab[] | ((prev: Tab[]) => Tab[])) => {
    const value = typeof next === 'function' ? next(tabsRef.current) : next;
    tabsRef.current = value;
    setTabs(value);
  }, []);

  const setActiveIdSynced = useCallback((next: string | null) => {
    activeIdRef.current = next;
    setActiveId(next);
  }, []);

  // Mount the CodeMirror host exactly once.
  useEffect(() => {
    let cancelled = false;
    cmReadyRef.current = cmPromise.then(({ createCodeHost }) => {
      if (cancelled || !hostRef.current) {
        throw new Error('unmounted');
      }
      const host = createCodeHost(hostRef.current, isDarkVariant());
      cmRef.current = host;
      setEditorView(host.view);
      return host;
    });

    const observer = new MutationObserver(() => {
      cmRef.current?.setTheme(isDarkVariant());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-variant'],
    });

    return () => {
      cancelled = true;
      observer.disconnect();
      cmRef.current?.destroy();
      cmRef.current = null;
      setEditorView(null);
      statesRef.current.clear();
      lruRef.current = [];
    };
  }, []);

  // Touch a tab as most-recently-used and evict LRU beyond LIMIT.
  const touchLRU = useCallback((id: string) => {
    const lru = lruRef.current;
    const idx = lru.indexOf(id);
    if (idx !== -1) lru.splice(idx, 1);
    lru.push(id);
    while (lru.length > LRU_LIMIT) {
      const evictId = lru.shift()!;
      // Don't evict the active tab.
      if (evictId === id) { lru.push(evictId); break; }
      statesRef.current.delete(evictId);
    }
  }, []);

  const activateTab = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (!tab) return;
    setActiveIdSynced(tabId);

    const host = cmRef.current ?? await cmReadyRef.current;
    if (!host) return;

    let state = statesRef.current.get(tabId);
    if (!state) {
      // Load (or reload after LRU eviction).
      setTabsSynced(prev => prev.map(t => t.id === tabId ? { ...t, loading: true, error: null } : t));
      try {
        const r = await fetch(`${baseUrl}/v1/files/read?path=${encodeURIComponent(tab.path)}`);
        const d = (await r.json()) as FileReadResponse;
        if (!d.success) throw new Error(d.error || 'Failed to load');
        state = host.buildState({
          doc: d.content,
          lang: shikiLang(fileExt(tab.name)),
          mode: tab.mode,
          dark: isDarkVariant(),
          onSave: () => { void saveActiveRef.current(); },
          onChange: () => {
            setTabsSynced(prev => prev.map(t => t.id === tabId ? { ...t, dirty: true } : t));
          },
        });
        statesRef.current.set(tabId, state);
        setTabsSynced(prev => prev.map(t => t.id === tabId ? { ...t, loading: false, error: null, dirty: false, externallyChanged: false } : t));
      } catch (e) {
        const msg = (e as Error).message;
        setTabsSynced(prev => prev.map(t => t.id === tabId ? { ...t, loading: false, error: msg } : t));
        return;
      }
    }

    if (activeIdRef.current !== tabId) return;
    host.setState(state);
    touchLRU(tabId);
  }, [baseUrl, setActiveIdSynced, setTabsSynced, touchLRU]);

  // Drop the cached state for `tabId` and re-activate so it re-reads from
  // disk. Used by both the Discard button (throw away local edits) and the
  // Reload button (pick up an external/agent write). Functionally identical;
  // the two buttons only differ in tooltip + when they're highlighted.
  const revertTab = useCallback(async (tabId: string) => {
    statesRef.current.delete(tabId);
    setTabsSynced(prev => prev.map(t => t.id === tabId ? { ...t, dirty: false, externallyChanged: false } : t));
    await activateTab(tabId);
  }, [activateTab, setTabsSynced]);

  const saveActive = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    const tab = tabsRef.current.find(t => t.id === id);
    const host = cmRef.current;
    if (!tab || !host) return;
    const content = host.view.state.doc.toString();
    try {
      const r = await fetch(`${baseUrl}/v1/files/write`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tab.path, content }),
      });
      const d = (await r.json()) as FileWriteResponse;
      if (!d.success) throw new Error(d.error || 'Save failed');
      toast.show(`Saved ${tab.name}`, 'success');
      setTabsSynced(prev => prev.map(t => t.id === id ? { ...t, dirty: false, externallyChanged: false } : t));
    } catch (e) {
      toast.show((e as Error).message, 'error', { title: 'Save failed' });
    }
  }, [baseUrl, setTabsSynced]);
  saveActiveRef.current = saveActive;

  const openFile = useCallback((path: string, name?: string) => {
    const fname = name || path.split('/').pop() || path;
    const id = path; // path is unique per workspace; collisions just refocus
    setTabsSynced(prev => {
      if (prev.some(t => t.id === id)) return prev;
      return [...prev, { id, path, name: fname, loading: false, error: null, dirty: false, mode: tabMode(fname), externallyChanged: false }];
    });
    void activateTab(id);
  }, [activateTab, setTabsSynced]);

  const closeTab = useCallback((id: string) => {
    statesRef.current.delete(id);
    lruRef.current = lruRef.current.filter(x => x !== id);
    setTabsSynced(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeIdRef.current === id) {
        const fallback = next[next.length - 1];
        if (fallback) setTimeout(() => { void activateTab(fallback.id); }, 0);
        else setActiveIdSynced(null);
      }
      return next;
    });
  }, [activateTab, setActiveIdSynced, setTabsSynced]);

  // Publish the bridge so other components can open files in the code view.
  useEffect(() => {
    codeView.openFile = openFile;
    codeView.closeFile = closeTab;
    codeView.listTabs = () => tabs.map(t => t.path);
    return () => {
      if (codeView.openFile === openFile) delete codeView.openFile;
      if (codeView.closeFile === closeTab) delete codeView.closeFile;
      if (codeView.listTabs) delete codeView.listTabs;
    };
  }, [openFile, closeTab, tabs]);

  // Subscribe to layout (panel arrangement) so its changes also trigger the
  // debounced save below. We read the whole layout in serialize() at save
  // time, but we need a re-run signal — useCodeLayout's `right`/`bottom`/
  // active fields shaped via individual selectors give us that.
  const layoutRight  = useCodeLayout((s) => s.right);
  const layoutBottom = useCodeLayout((s) => s.bottom);
  const layoutRightActive  = useCodeLayout((s) => s.rightActive);
  const layoutBottomActive = useCodeLayout((s) => s.bottomActive);
  const hydrateLayout = useCodeLayout((s) => s.hydrate);

  // Rehydrate persisted state once on mount: load tabs[] from bridge,
  // open them as descriptors, and re-activate the previously active one.
  // Files load lazily through the existing activateTab() flow — no batch
  // reads, so an offline file won't block the other tabs from rendering.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${baseUrl}/v1/code-view/state`);
        if (!r.ok) return;
        const d = (await r.json()) as {
          success?: boolean;
          state?: {
            tabs: { path: string; name?: string }[];
            activeTab: string | null;
            layout?: { right?: string[]; bottom?: string[]; rightActive?: string | null; bottomActive?: string | null };
          };
        };
        if (cancelled || !d.success || !d.state) return;
        const st = d.state;
        const restored: Tab[] = st.tabs.map((t) => {
          const name = t.name || t.path.split('/').pop() || t.path;
          return {
            id: t.path,
            path: t.path,
            name,
            loading: false,
            error: null,
            dirty: false,
            mode: tabMode(name),
            externallyChanged: false,
          };
        });
        if (restored.length) {
          setTabsSynced(restored);
          const activate = st.activeTab && restored.find((t) => t.id === st.activeTab)
            ? st.activeTab
            : restored[restored.length - 1].id;
          void activateTab(activate);
        }
        if (st.layout) {
          hydrateLayout({
            right:        st.layout.right  as never,
            bottom:       st.layout.bottom as never,
            rightActive:  st.layout.rightActive  as never,
            bottomActive: st.layout.bottomActive as never,
          });
        } else {
          hydrateLayout({});
        }
      } catch {
        hydrateLayout({});
      } finally {
        hydratedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [activateTab, baseUrl, hydrateLayout, setTabsSynced]);

  // Persist tabs + activeId + panel layout to the bridge. Debounced 400 ms.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const payload = {
        tabs: tabs.map((t) => ({ path: t.path, name: t.name })),
        activeTab: activeId,
        layout: {
          right:        layoutRight,
          bottom:       layoutBottom,
          rightActive:  layoutRightActive,
          bottomActive: layoutBottomActive,
        },
      };
      fetch(`${baseUrl}/v1/code-view/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => { /* best-effort — last-write-wins, no toast spam */ });
    }, 400);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [tabs, activeId, layoutRight, layoutBottom, layoutRightActive, layoutBottomActive, baseUrl]);

  // Watch forge-state for agent-driven file edits. When the recent edit
  // touches a path matching any open tab, flag that tab as externally
  // changed — the toolbar highlights its Reload button. We use the edit id
  // as the dedupe key so a single edit doesn't re-flag on every poll.
  const recentEdit = useForgeStore((s) => s.recentEdit);
  const lastSeenEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!recentEdit) return;
    if (lastSeenEditIdRef.current === recentEdit.id) return;
    lastSeenEditIdRef.current = recentEdit.id;
    if (!recentEdit.paths.length) return;
    setTabsSynced(prev => prev.map(t => {
      const hit = recentEdit.paths.some(p => pathMatches(t.path, p));
      return hit ? { ...t, externallyChanged: true } : t;
    }));
  }, [recentEdit, setTabsSynced]);

  const activeTab = tabs.find(t => t.id === activeId) || null;
  const showEmpty = tabs.length === 0;

  const onSaveClick    = useCallback(() => { void saveActive(); }, [saveActive]);
  const onDiscardClick = useCallback(() => {
    if (!activeTab) return;
    if (!confirm(`Discard unsaved changes to ${activeTab.name}?`)) return;
    void revertTab(activeTab.id);
  }, [activeTab, revertTab]);
  const onReloadClick = useCallback(() => {
    if (!activeTab) return;
    if (activeTab.dirty && !confirm(`Reload ${activeTab.name}? Unsaved changes will be lost.`)) return;
    void revertTab(activeTab.id);
  }, [activeTab, revertTab]);

  return (
    <div className="cv-editor">
      <div className="cv-tabbar">
        <EditorToolbar
          dirty={!!activeTab?.dirty}
          loaded={!!activeTab && !activeTab.loading && !activeTab.error}
          externallyChanged={!!activeTab?.externallyChanged}
          onSave={onSaveClick}
          onDiscard={onDiscardClick}
          onReload={onReloadClick}
        />
        <div className="cv-tabstrip" role="tablist">
          {tabs.map(t => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              className={`cv-tab${t.id === activeId ? ' is-active' : ''}${t.dirty ? ' is-dirty' : ''}${t.externallyChanged ? ' is-ext-changed' : ''}`}
              onClick={() => { void activateTab(t.id); }}
              onAuxClick={(e) => { if (e.button === 1) closeTab(t.id); }}
              title={t.externallyChanged ? `${t.path}\n(changed on disk — reload to see new version)` : t.path}
            >
              <span className="cv-tab-icon">{fileIcon(t.name)}</span>
              <span className="cv-tab-name">{t.name}</span>
              {t.dirty && <span className="cv-tab-dot" aria-label="unsaved">●</span>}
              <button
                className="cv-tab-close"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                aria-label={`Close ${t.name}`}
              >×</button>
            </div>
          ))}
          <button
            className="cv-tab-add"
            onClick={() => {
              const path = window.prompt('Open file path:');
              if (path) openFile(path.trim());
            }}
            aria-label="Open file"
            title="Open file"
          >+</button>
        </div>
      </div>

      <div className="cv-editor-body">
        {showEmpty && (
          <div className="cv-editor-empty">
            <p>No file open.</p>
            <p style={{ opacity: 0.6, fontSize: 11 }}>
              Files opened via the right Files tab, chat citations, or the&nbsp;+
              &nbsp;button will appear here as tabs.
            </p>
          </div>
        )}
        {activeTab?.loading && (
          <div className="cv-editor-status">Loading {activeTab.name}…</div>
        )}
        {activeTab?.error && (
          <div className="cv-editor-status cv-editor-status--error">
            Error loading {activeTab.name}: {activeTab.error}
          </div>
        )}
        <div className="cv-editor-stage">
          <div
            ref={hostRef}
            className={`cv-cm-host${activeTab?.mode === 'markdown' ? ' md-editor md-editor-live' : ''}`}
            data-active={activeTab && !activeTab.loading && !activeTab.error ? 'true' : 'false'}
            data-mode={activeTab?.mode ?? 'code'}
          />
          {activeTab && !activeTab.loading && !activeTab.error && activeTab.mode !== 'markdown' && (
            <CodeMinimap view={editorView} />
          )}
        </div>
      </div>
    </div>
  );
}
