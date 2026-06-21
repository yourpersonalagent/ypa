import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/index.js';
import { getSessionState } from '../stores/sessionStore.js';
import { getToastActions } from '../stores/toastStore.js';
import { session } from '../session.js';
import { Breadcrumb } from '../components/Breadcrumb.js';
import { fmtSize, isViewable, shouldOpenInEditor, fileExt } from '../util/file-lang.js';
import { fileEditor } from './file-editor.js';
import { pushEscapeHandler } from '../host/modal-stack.js';
import { filePicker } from './file-picker.js';
import { FilePickerActionsSlot } from '../host/slots/FilePickerActionsSlot.js';
import chatUI from '../chat/chat-ui.js';
import { store } from '../store.js';
import type { YhaNode } from '../modules/yha-net/TabNodes.js';

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
  parent?: string;
  items: FileItem[];
}

interface UploadResult {
  ok: boolean;
  url?: string;
  dataUrl?: string;
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']);

function fileIcon(name: string): string {
  const ext = (name || '').split('.').pop()!.toLowerCase();
  const map: Record<string, string> = {
    js: '📜', ts: '📜', py: '🐍', sh: '⚡', json: '📋',
    md: '📝', txt: '📄', csv: '📊', html: '🌐', css: '🎨',
    sql: '🗄', jpg: '🖼', jpeg: '🖼', png: '🖼', gif: '🖼',
    svg: '🖼', pdf: '📑', zip: '📦', tar: '📦', gz: '📦',
  };
  return map[ext] || '📄';
}

async function uploadFile(file: File, baseUrl: string, sessionId: string): Promise<UploadResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const dataUrl = (evt.target as FileReader).result as string;
      try {
        const r = await fetch(`${baseUrl}/v1/uploads/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, name: file.name, data: dataUrl }),
        });
        const d = (await r.json()) as { success: boolean; url?: string };
        if (d.success) resolve({ ok: true, url: baseUrl + d.url, dataUrl });
        else resolve({ ok: false, dataUrl });
      } catch {
        resolve({ ok: false, dataUrl });
      }
    };
    reader.onerror = () => resolve({ ok: false });
    reader.readAsDataURL(file);
  });
}

export function FilePicker() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [currentPath, setCurrentPath] = useState('~');
  const [listing, setListing] = useState<FileListing | null>(null);
  const lastGoodListingRef = useRef<FileListing | null>(null);
  const [loading, setLoading] = useState(false);
  // Scope roots: standard workingDir first, then additional workingDirs.
  // The leading <select> in the header lets users jump to any of them.
  // Q16.7 / Q16.10 groundwork: net folders later become more entries here,
  // no UI rework needed.
  const [scopeRoots, setScopeRoots] = useState<string[]>([]);
  // Per-modal-instance AbortController. Refreshed on open; aborted on
  // close so an in-flight navigate() doesn't write stale data back into
  // the next-opened instance and so the React unmounted-setState warning
  // stops firing. Each fetch in this modal passes `signal` through.
  const modalAbortRef = useRef<AbortController | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const homeDirRef = useRef<string | null>(null);
  const configuredHomeRef = useRef<string | null>(null);
  const currentPathRef = useRef('~');
  const showHiddenRef = useRef(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listingCacheRef = useRef<Map<string, { ts: number; data: FileListing }>>(new Map());

  // YHA Net multi-node support (Phase 2). null = local/this node (direct /v1/files).
  // string id = proxy via /v1/net/nodes/<id>/files . '__MERGED__' = fan-out to all
  // enabled nodes and render as grouped expandable sections (merged search).
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [netNodes, setNetNodes] = useState<YhaNode[]>([]);
  const [multiListings, setMultiListings] = useState<Array<{ node: YhaNode; listing: FileListing | null; error?: string }>>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const activeNodeIdRef = useRef<string | null>(null);
  const netNodesRef = useRef<YhaNode[]>([]);

  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const currentSession = useAppStore((s) => s.currentSession);
  const cwdHistory = useAppStore((s) => s.cwdHistory);
  const addCwdToHistory = useAppStore((s) => s.addCwdToHistory);
  const baseUrl = window.location.origin;

  showHiddenRef.current = showHidden;
  activeNodeIdRef.current = activeNodeId;
  netNodesRef.current = netNodes;

  function loadNetNodes() {
    const raw = store.get('yhaNetNodes');
    const list: YhaNode[] = Array.isArray(raw) ? (raw as YhaNode[]) : [];
    setNetNodes(list);
  }

  async function loadMergedListings(dirPath: string) {
    setLoading(true);
    setFetchError(null);
    currentPathRef.current = dirPath;
    setCurrentPath(dirPath);
    const hidden = showHiddenRef.current ? '1' : '0';
    const signal = modalAbortRef.current?.signal;
    const enabled = netNodesRef.current.filter((n) => n.enabled !== false);
    if (enabled.length === 0) {
      setMultiListings([]);
      setLoading(false);
      return;
    }
    const results = await Promise.all(
      enabled.map(async (node) => {
        try {
          const prefix = `${baseUrl}/v1/net/nodes/${encodeURIComponent(node.id)}`;
          const r = await fetch(`${prefix}/v1/files/?path=${encodeURIComponent(dirPath)}&hidden=${hidden}`, signal ? { signal } : undefined);
          const d = (await r.json()) as FileListing;
          if (!d.success) return { node, listing: null as FileListing | null, error: d.error || 'server error' };
          return { node, listing: d, error: undefined };
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return { node, listing: null as FileListing | null, error: 'aborted' };
          return { node, listing: null as FileListing | null, error: (e as Error).message };
        }
      })
    );
    // default expand all groups
    const nextExp = new Set<string>(enabled.map((n) => n.id));
    setExpandedGroups(nextExp);
    setMultiListings(results);
    setLoading(false);
  }

  const isMerged = activeNodeId === '__MERGED__';

  const loadScopeConfig = useCallback(async (forNodeId?: string | null): Promise<string | null> => {
    try {
      const nodeId = forNodeId !== undefined ? forNodeId : activeNodeIdRef.current;
      const prefix = (nodeId && nodeId !== '__MERGED__') ? `/v1/net/nodes/${encodeURIComponent(nodeId)}` : '';
      const r = await fetch(`${baseUrl}${prefix}/v1/config/`);
      const d = (await r.json()) as { config?: { defaults?: { workingDir?: string; workingDirs?: string[] }; homeDir?: string } };
      const std = (d.config?.defaults?.workingDir as string) || '';
      const home = (d.config?.homeDir as string) || '';
      const extra = Array.isArray(d.config?.defaults?.workingDirs)
        ? (d.config!.defaults!.workingDirs as string[]).filter((s) => typeof s === 'string' && s)
        : [];
      const seen = new Set<string>();
      const roots: string[] = [];
      for (const p of [std, ...extra]) {
        const key = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (!p || seen.has(key)) continue;
        seen.add(key);
        roots.push(p);
      }
      setScopeRoots(roots);
      const homeBase = std || home || null;
      configuredHomeRef.current = homeBase;
      return homeBase;
    } catch {
      return configuredHomeRef.current;
    }
  }, [baseUrl]);

  const getHomeBase = useCallback((freshConfiguredHome?: string | null) => (
    freshConfiguredHome
    || configuredHomeRef.current
    || sessionWorkingDir
    || homeDirRef.current
    || '~'
  ), [sessionWorkingDir]);

  const getStartBase = useCallback((freshConfiguredHome?: string | null) => (
    sessionWorkingDir
    || freshConfiguredHome
    || configuredHomeRef.current
    || homeDirRef.current
    || '~'
  ), [sessionWorkingDir]);

  const navigate = useCallback(async (dirPath: string, force = false) => {
    setLoading(true);
    setFetchError(null);
    currentPathRef.current = dirPath;
    setCurrentPath(dirPath);

    const cacheKey = dirPath + '|' + (showHiddenRef.current ? 'h' : '');
    const cached = listingCacheRef.current.get(cacheKey);
    const now = Date.now();
    if (!force && cached && (now - cached.ts) < 3000) {
      setListing(cached.data);
      lastGoodListingRef.current = cached.data;
      setLoading(false);
      return;
    }

    try {
      const hidden = showHiddenRef.current ? '1' : '0';
      const signal = modalAbortRef.current?.signal;
      const nodeId = activeNodeIdRef.current;
      const prefix = (nodeId && nodeId !== '__MERGED__') ? `${baseUrl}/v1/net/nodes/${encodeURIComponent(nodeId)}` : baseUrl;
      const r = await fetch(`${prefix}/v1/files/?path=${encodeURIComponent(dirPath)}&hidden=${hidden}`, signal ? { signal } : undefined);
      const d = (await r.json()) as FileListing;
      if (!d.success) throw new Error(d.error || 'Server error');
      currentPathRef.current = d.path;
      setCurrentPath(d.path);
      setListing(d);
      lastGoodListingRef.current = d;
      listingCacheRef.current.set(cacheKey, { ts: now, data: d });
      // crude cap on cache size
      if (listingCacheRef.current.size > 20) {
        const firstKey = listingCacheRef.current.keys().next().value;
        if (firstKey) listingCacheRef.current.delete(firstKey);
      }
    } catch (e) {
      // AbortError lands here when the modal closed mid-fetch — silent.
      if ((e as Error)?.name === 'AbortError') return;
      setFetchError((e as Error).message);
      // Keep previous listing so the picker doesn't go "no files" on transient lag/switch blip.
      // User sees stale-but-usable + error banner + can hit Retry.
      if (lastGoodListingRef.current) setListing(lastGoodListingRef.current);
    } finally {
      // Only flip loading off if the controller is still the current one —
      // a parallel openModal would have rotated it and we don't want to
      // clobber the new instance's loading state.
      if (!modalAbortRef.current?.signal.aborted) setLoading(false);
    }
  }, [baseUrl]);

  const closeModal = useCallback(() => {
    if (modalAbortRef.current) {
      try { modalAbortRef.current.abort(); } catch (_) {}
      modalAbortRef.current = null;
    }
    setAnchor(null);
    setSelected([]);
    setQuery('');
  }, []);

  const openModal = useCallback(() => {
    // Rotate the AbortController for this open. If a previous instance is
    // still in flight (rapid open/close/open), abort it so its setState
    // calls don't land on this fresh instance.
    if (modalAbortRef.current) {
      try { modalAbortRef.current.abort(); } catch (_) {}
    }
    modalAbortRef.current = new AbortController();
    const btn = document.getElementById('chat-file');
    setAnchor(btn?.getBoundingClientRect() ?? null);
    setSelected([]);
    setQuery('');
    setMultiListings([]);
    loadNetNodes();
    // default to local node; user can switch in the node <select>
    setActiveNodeId(null);
    activeNodeIdRef.current = null;
    const start = getStartBase();
    homeDirRef.current = getHomeBase();
    navigate(start);
    void loadScopeConfig().then((freshHome) => {
      const freshStart = getStartBase(freshHome);
      if (!freshStart) return;
      homeDirRef.current = getHomeBase(freshHome);
      if (freshStart !== start && modalAbortRef.current && !modalAbortRef.current.signal.aborted) {
        navigate(freshStart);
      }
    });
  }, [getHomeBase, getStartBase, loadScopeConfig, navigate]);

  // Fetch scope roots once on mount and again on open:
  // [standard workingDir, ...additionalDirs]. The repeat fetch is intentional
  // because Preferences can change the homebase while the FilePicker component
  // stays mounted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const homeBase = await loadScopeConfig();
      if (!cancelled && !homeDirRef.current) homeDirRef.current = homeBase;
    })();
    return () => { cancelled = true; };
  }, [loadScopeConfig]);

  // Wire #chat-file and override app.filePicker.open
  useEffect(() => {
    function wireBtn() {
      const btn = document.getElementById('chat-file');
      if (!btn) return;
      btn.removeEventListener('click', openModal);
      btn.addEventListener('click', openModal);
    }
    wireBtn();
    const obs = new MutationObserver(wireBtn);
    obs.observe(document.body, { childList: true, subtree: true });

    filePicker.open = openModal;

    return () => {
      obs.disconnect();
      const btn = document.getElementById('chat-file');
      if (btn) btn.removeEventListener('click', openModal);
    };
  }, [openModal, currentSession]);

  // Keep #chat-file button showing the current WD as parent/ + name
  useEffect(() => {
    function updateBtn() {
      const btn = document.getElementById('chat-file');
      if (!btn) return;
      btn.querySelector('.fp-wd-display')?.remove();
      if (!sessionWorkingDir) return;
      // Cross-platform: split on both '/' and '\' so Windows paths
      // (C:\Users\<user>\yha) collapse to "<user>\yha" the same way Linux
      // paths (/home/user/proj/yha) collapse to "proj/yha". Otherwise
      // a Windows path has no '/' to split on and the button shows
      // the entire absolute path.
      const parts = sessionWorkingDir.split(/[\\/]+/).filter(Boolean);
      const name = parts[parts.length - 1] || sessionWorkingDir;
      const sep = /^[A-Za-z]:[\\/]/.test(sessionWorkingDir) ? '\\' : '/';
      const parent = parts.length > 1 ? parts[parts.length - 2] + sep : '';
      const wrap = document.createElement('span');
      wrap.className = 'fp-wd-display';
      if (parent) {
        const pEl = document.createElement('span');
        pEl.className = 'fp-wd-parent';
        pEl.textContent = parent;
        wrap.appendChild(pEl);
      }
      const nEl = document.createElement('span');
      nEl.className = 'fp-wd-name';
      nEl.textContent = name;
      wrap.appendChild(nEl);
      btn.appendChild(wrap);
    }

    updateBtn();
    // Re-apply if the button is recreated (chat.init re-runs on boot)
    const obs = new MutationObserver(() => {
      const btn = document.getElementById('chat-file');
      if (btn && !btn.querySelector('.fp-wd-display')) updateBtn();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [sessionWorkingDir]);

  // Re-navigate when showHidden toggles while open
  useEffect(() => {
    if (!anchor) return;
    if (activeNodeIdRef.current === '__MERGED__') {
      void loadMergedListings(currentPathRef.current || '~');
    } else {
      navigate(currentPathRef.current, true);
    }
  }, [showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape key — routed through the shared modal stack so the top-most
  // modal consumes the event and stacked modals don't all close at once.
  useEffect(() => {
    if (!anchor) return;
    return pushEscapeHandler(() => closeModal());
  }, [anchor, closeModal]);

  // Outside-click closes the popover
  useEffect(() => {
    if (!anchor) return;
    function onDown(e: MouseEvent) {
      if (popoverRef.current?.contains(e.target as Node)) return;
      const triggerBtn = document.getElementById('chat-file');
      if (triggerBtn?.contains(e.target as Node)) return;
      closeModal();
    }
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor, closeModal]);

  // Focus search on open
  useEffect(() => {
    if (anchor) setTimeout(() => searchRef.current?.focus(), 0);
  }, [anchor]);

  function toggleSelect(path: string) {
    setSelected((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  }

  async function attachServerFiles() {
    if (!selected.length) return;
    const ta = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
    const insertions: string[] = [];

    for (const p of selected) {
      const name = p.split('/').pop() || p;
      const ext = fileExt(name);
      const isText = isViewable(name);

      if (IMAGE_EXTS.has(ext)) {
        chatUI.addAttachment({ name, url: p, type: 'image' });
      } else if (isText) {
        try {
          const nodeId = activeNodeIdRef.current;
          const prefix = (nodeId && nodeId !== '__MERGED__') ? `${baseUrl}/v1/net/nodes/${encodeURIComponent(nodeId)}` : baseUrl;
          const r = await fetch(`${prefix}/v1/files/read?path=${encodeURIComponent(p)}`);
          const d = (await r.json()) as { success: boolean; content?: string; error?: string };
          if (d.success && typeof d.content === 'string') {
            insertions.push(`\n\`\`\`${ext}\n# File: ${p}\n${d.content}\n\`\`\``);
          } else {
            insertions.push(p);
          }
        } catch {
          insertions.push(p);
        }
      } else {
        chatUI.addAttachment({ name, url: p, type: 'file' });
      }
    }

    const inserted = insertions.join('\n');
    if (inserted && ta) {
      ta.value = (ta.value ? ta.value.trim() + '\n' : '') + inserted;
      ta.dispatchEvent(new Event('input'));
    }
    ta?.focus();
    closeModal();
  }

  async function handleSetWd(folderPath: string) {
    const sid = String(currentSession || getSessionState().currentId || 'default');
    // session.setWorkingDir owns the full sync (server PATCH + _cache update +
    // appStore mirror). Updating only appStore here would race with the
    // 4 s SessionPoller, which copies the stale _cache entry back over the
    // new value within seconds — see session.ts comment for details.
    const d = await session.setWorkingDir(sid, folderPath);
    if (d.success) {
      const wd = d.workingDir || folderPath;
      addCwdToHistory(wd);
    } else {
      getToastActions().show(d.error || 'Failed to set directory', 'error', { title: 'Working dir' });
    }
    closeModal();
  }

  function handleLocalUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const ta = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
    const sid = String(currentSession || getSessionState().currentId || 'default');
    let pending = files.length;

    const finish = () => {
      pending--;
      if (pending === 0) {
        if (ta) ta.dispatchEvent(new Event('input'));
        ta?.focus();
        closeModal();
      }
    };

    for (const file of files) {
      const ext = fileExt(file.name);
      const isImage = IMAGE_EXTS.has(ext);
      const isText = isViewable(file.name) || file.type.startsWith('text/');

      if (isImage) {
        uploadFile(file, baseUrl, sid)
          .then((res) => {
            if (res.ok) chatUI.addAttachment({ name: file.name, url: res.url, type: 'image' });
            else if (res.dataUrl && ta) ta.value = (ta.value || '') + `\n![${file.name}](${res.dataUrl})\n`;
            finish();
          })
          .catch(() => finish());
      } else if (isText) {
        if (file.size > 512 * 1024 && !confirm(`"${file.name}" is ${fmtSize(file.size)} — include full content?`)) {
          finish();
          continue;
        }
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = (evt.target as FileReader).result as string;
          if (ta) ta.value = (ta.value || '') + `\n\`\`\`${ext}\n# File: ${file.name}\n${content}\n\`\`\`\n`;
          finish();
        };
        reader.onerror = () => finish();
        reader.readAsText(file, 'utf-8');
      } else {
        if (file.size > 10 * 1024 * 1024 && !confirm(`"${file.name}" is ${fmtSize(file.size)} — upload to session?`)) {
          finish();
          continue;
        }
        uploadFile(file, baseUrl, sid)
          .then((res) => {
            if (res.ok) chatUI.addAttachment({ name: file.name, url: res.url, type: 'file' });
            else if (ta) ta.value = (ta.value || '') + `\n[Could not upload: ${file.name}]\n`;
            finish();
          })
          .catch(() => finish());
      }
    }
    e.target.value = '';
  }

  void sessionWorkingDir;

  // Popover position: open upward when trigger is in bottom half of screen.
  // Hidden-anchor fallback: zen layout hides #chat-file via display:none so
  // getBoundingClientRect() returns all zeros — center on viewport instead.
  const popoverStyle: React.CSSProperties = useMemo(() => {
    if (!anchor) return {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const gap = 6;
    const width = Math.min(400, vw - margin * 2);
    if (anchor.width === 0 && anchor.height === 0) {
      const left = Math.max(margin, (vw - width) / 2);
      const top = Math.max(margin, vh * 0.15);
      const maxHeight = Math.max(200, vh - top - margin);
      return { top, left, width, maxHeight };
    }
    const left = Math.max(margin, Math.min(vw - width - margin, anchor.left - 4));
    if (anchor.top > vh / 2) {
      const bottom = vh - anchor.top + gap;
      const maxHeight = Math.max(200, anchor.top - margin * 2);
      return { bottom, left, width, maxHeight };
    }
    const top = anchor.bottom + gap;
    const maxHeight = Math.max(200, vh - top - margin);
    return { top, left, width, maxHeight };
  }, [anchor]);

  // Unified navigable list: ".." (parent) + items + recent working dirs as a
  // tail subgroup (mirrors SessionPicker's Running/Todo bands inside ss-scroll).
  // The recent rows live in the same scrolling container so the popover only
  // has to manage one list — no sibling flex/max-height juggling needed.
  type NavItem = { name: string; path: string; type: 'parent' | 'dir' | 'file' | 'recent'; size?: number };
  const navItems = useMemo<NavItem[]>(() => {
    const all: NavItem[] = [];
    if (listing?.parent) all.push({ name: '..', path: listing.parent, type: 'parent' });
    if (listing?.items) {
      for (const it of listing.items) all.push({ name: it.name, path: it.path, type: it.type, size: it.size });
    }
    // Top 3 recents (was 5) — three keeps the tail compact so it doesn't dominate
    // when the listing itself is short, but still useful for jumping back.
    const recents: NavItem[] = cwdHistory.slice(0, 3).map((dir) => {
      const parts = dir.split('/').filter(Boolean);
      const name = parts[parts.length - 1] || dir;
      return { name, path: dir, type: 'recent' };
    });
    if (!query) return [...all, ...recents];
    const q = query.toLowerCase();
    // Filter recents on full path so "/projects/" matches even when the leaf
    // doesn't — the parent prefix is the most useful disambiguator here.
    return [
      ...all.filter((item) => item.name.toLowerCase().includes(q)),
      ...recents.filter((item) => item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)),
    ];
  }, [listing, query, cwdHistory]);

  // Reset / clamp active index whenever the visible list changes.
  useEffect(() => {
    setActiveIndex((i) => (navItems.length === 0 ? 0 : Math.min(i, navItems.length - 1)));
  }, [navItems]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-fp-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const activateItem = useCallback((item: NavItem) => {
    if (item.type === 'parent' || item.type === 'dir' || item.type === 'recent') {
      setQuery('');
      navigate(item.path);
    } else if (shouldOpenInEditor(item.name, item.size)) {
      fileEditor.open?.(item.path, item.name);
      closeModal();
    }
    // else: not viewable file with no auto-action — do nothing
  }, [navigate, closeModal]);

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (navItems.length === 0 ? 0 : Math.min(navItems.length - 1, i + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && (e.ctrlKey || e.altKey || e.metaKey)) {
      e.preventDefault();
      handleSetWd(currentPathRef.current);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = navItems.length === 1 ? navItems[0] : navItems[activeIndex];
      if (target) activateItem(target);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const target = navItems.length === 1 ? navItems[0] : navItems[activeIndex];
      if (target && (target.type !== 'file' || navItems.length === 1)) activateItem(target);
    } else if (e.key === ' ' && navItems.length === 1) {
      e.preventDefault();
      activateItem(navItems[0]);
    }
  }

  if (!anchor) return null;

  return createPortal(
    <div
      id="fp-popover"
      className="popover fp-popover"
      ref={popoverRef}
      style={popoverStyle}
    >
      <div className="fp-header">
        {/* Row 1: scope selects on the left (shrink + ellipsis when tight),
            control icons on the right (never shrink — "icon first" so the
            actionable controls stay reachable no matter how long the path is).
            Row 2 holds the breadcrumb on its own line; long paths scroll
            horizontally instead of wrapping into the icons. */}
        <div className="fp-header-row fp-header-row-top">
          <div className="fp-header-scopes">
            {/* YHA Net node scope (Phase 2). Switches the file listing between
                this device and any enabled nodes from Preferences › YHA Net.
                When multiple are enabled you can also pick the merged view
                (single list with per-node expandable groups + cross-group
                search). */}
            {netNodes.filter((n) => n.enabled !== false).length > 0 && (
              <select
                className="fp-scope"
                title="Browse files on this device or on another node in your YHA Net fleet (enabled in Preferences › YHA Net). Merged = all enabled in one view with groups."
                value={activeNodeId || ''}
                onChange={async (e) => {
                  const val = e.target.value || null;
                  const prev = activeNodeIdRef.current;
                  setActiveNodeId(val);
                  activeNodeIdRef.current = val;
                  setMultiListings([]);
                  if (val === '__MERGED__') {
                    await loadMergedListings(currentPathRef.current || '~');
                  } else {
                    void loadScopeConfig(val).then(() => {
                      navigate('~');
                    });
                  }
                  if (val !== '__MERGED__' && prev === '__MERGED__') {
                    setTimeout(() => navigate(currentPathRef.current || '~'), 0);
                  }
                }}
              >
                <option value="">This device</option>
                {netNodes.filter((n) => n.enabled !== false).map((n) => (
                  <option key={n.id} value={n.id}>{n.label || n.computerName || n.id}</option>
                ))}
                {netNodes.filter((n) => n.enabled !== false).length > 1 && (
                  <option value="__MERGED__">All enabled (merged)</option>
                )}
              </select>
            )}
            {scopeRoots.length > 0 && (
              <select
                className="fp-scope"
                title="Jump to a configured root folder (set in Preferences › System › Working directory)"
                value={(() => {
                  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                  const cur = norm(currentPath);
                  return scopeRoots.find((r) => { const n = norm(r); return cur === n || cur.startsWith(n + '/'); }) || '';
                })()}
                onChange={(e) => { if (e.target.value) navigate(e.target.value); }}
              >
                <option value="">— scope —</option>
                {scopeRoots.map((r) => {
                  const parts = r.split(/[\\/]+/).filter(Boolean);
                  const short = parts[parts.length - 1] || r;
                  return <option key={r} value={r}>{short}</option>;
                })}
              </select>
            )}
          </div>
          <div className="fp-header-btns">
            <label className="fp-hidden-toggle" title="Show hidden files">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              .hid
            </label>
            <button
              className="fp-home-btn"
              title={homeDirRef.current ? `Go to ${homeDirRef.current}` : 'Go to home'}
              onClick={() => navigate(homeDirRef.current || '~')}
            >
              ⌂
            </button>
            <button className="fp-close" onClick={closeModal}>✕</button>
          </div>
        </div>
        <div className="fp-header-row fp-header-row-crumbs">
          <Breadcrumb path={currentPath} onNavigate={navigate} classPrefix="fp" />
        </div>
      </div>

      <div className="fp-search-wrap">
        <input
          ref={searchRef}
          className="fp-search"
          type="search"
          placeholder="Filter / autocomplete…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
      </div>

      {/* Single scroll container: files+folders, then a "recent" subgroup
          appended at the tail (rendered inline with a section header — same
          pattern as SessionPicker's Running/Todo bands inside .ss-scroll). */}
      <div className="fp-list" ref={listRef} role="listbox" aria-label="Files and folders" aria-activedescendant={activeIndex >= 0 ? `fp-item-${activeIndex}` : undefined}>
        {loading && <div className="fp-empty">Loading…</div>}
        {fetchError && (
          <div className="fp-empty" style={{ color: 'var(--danger)' }}>
            {fetchError}
            <button
              style={{ marginLeft: 8, fontSize: '0.85em' }}
              onClick={() => navigate(currentPathRef.current || '~', true)}
            >
              Retry
            </button>
          </div>
        )}
        {/* Merged multi-node groups (when "All enabled (merged)" chosen) */}
        {!loading && !fetchError && isMerged && multiListings.length > 0 && (
          <div className="fp-merged">
            {multiListings.map((ml) => {
              const exp = expandedGroups.has(ml.node.id);
              const baseItems = ml.listing ? ml.listing.items : [];
              const q = query.toLowerCase();
              const vis = q ? baseItems.filter((it) => it.name.toLowerCase().includes(q)) : baseItems;
              const nodeLabel = ml.node.label || ml.node.computerName || ml.node.id;
              return (
                <div key={ml.node.id} className="fp-node-group" style={{ borderBottom: '1px solid var(--stroke)', opacity: ml.error ? 0.65 : 1 }}>
                  <div
                    className="fp-node-group-hdr"
                    style={{ padding: '4px 8px', background: 'var(--bg-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                    onClick={() => {
                      // toggle expand; alt-click or future: focus this node exclusively
                      const next = new Set(expandedGroups);
                      if (next.has(ml.node.id)) next.delete(ml.node.id); else next.add(ml.node.id);
                      setExpandedGroups(next);
                    }}
                    title="Click to expand/collapse this node's tree. Use the node dropdown to switch to single-node view for this machine."
                  >
                    <span>{exp ? '▼' : '▶'}</span>
                    <span style={{ fontWeight: 600 }}>{nodeLabel}</span>
                    {ml.node.isSelf && <span style={{ fontSize: 10, background: 'var(--accent)', color: '#fff', padding: '0 4px', borderRadius: 3 }}>this</span>}
                    {ml.listing && <span style={{ opacity: 0.6 }}>({ml.listing.items.length})</span>}
                    {ml.error && <span style={{ color: 'var(--danger)', marginLeft: 8, fontSize: 11 }}>{ml.error}</span>}
                  </div>
                  {exp && vis.length === 0 && (
                    <div style={{ padding: '4px 22px', fontSize: 12, opacity: 0.6 }}>{q ? 'no match in this node' : 'empty'}</div>
                  )}
                  {exp && vis.map((item) => {
                    const isDir = item.type === 'dir';
                    const canOpen = !isDir && shouldOpenInEditor(item.name, item.size);
                    return (
                      <div
                        key={item.path}
                        className={`fp-item ${isDir ? 'fp-dir' : 'fp-file'}`}
                        style={{ paddingLeft: 22 }}
                        onClick={() => {
                          if (isDir) {
                            // dive into this node + subdir (switches out of merged)
                            setActiveNodeId(ml.node.id);
                            activeNodeIdRef.current = ml.node.id;
                            setMultiListings([]);
                            setQuery('');
                            navigate(item.path);
                          } else {
                            toggleSelect(item.path);
                          }
                        }}
                      >
                        <span className="fp-icon">{isDir ? '📁' : fileIcon(item.name)}</span>
                        <span className="fp-name" title={item.path}>{item.name}</span>
                        {!isDir && item.size != null && <span className="fp-size">{fmtSize(item.size)}</span>}
                        {canOpen && (
                          <button className="fp-cd-btn" title="Open in editor" onClick={(e) => { e.stopPropagation(); fileEditor.open?.(item.path, item.name); closeModal(); }}>edit</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {!loading && !fetchError && listing && !isMerged && (
          <>
            {navItems.length === 0 && (
              <div className="fp-empty">
                {query ? `No matches for "${query}"` : 'Empty directory'}
              </div>
            )}
            {navItems.map((item, i) => {
              const isParent = item.type === 'parent';
              const isRecent = item.type === 'recent';
              const isDir = item.type === 'dir' || isParent || isRecent;
              const isSelected = !isDir && selected.includes(item.path);
              const canOpen = !isDir && shouldOpenInEditor(item.name, item.size);
              const isActive = i === activeIndex;
              const prevType = i > 0 ? navItems[i - 1].type : null;
              const showRecentDivider = isRecent && prevType !== 'recent';

              // Recents show parent dir as a small dim prefix so two folders
              // with the same leaf name (e.g. two ".../src/") stay distinguishable.
              let nameNode: React.ReactNode = item.name;
              if (isRecent) {
                // Cross-platform split — Windows paths use '\'. Join with
                // '/' for compact display either way (we're rendering, not
                // building a server path).
                const parts = item.path.split(/[\\/]+/).filter(Boolean);
                const parent = parts.length > 1 ? parts.slice(0, -1).join('/').replace(/^\//, '') + '/' : '';
                nameNode = (
                  <>
                    {parent && <span className="fp-recent-parent">{parent}</span>}
                    {item.name}
                  </>
                );
              }

              return (
                <Fragment key={isRecent ? `recent:${item.path}` : item.path}>
                  {showRecentDivider && <div className="fp-recent-label" role="separator">recent</div>}
                  <div
                    id={`fp-item-${i}`}
                    data-fp-idx={i}
                    role="option"
                    aria-selected={isSelected || isActive}
                    aria-label={`${isDir ? 'Folder' : 'File'}: ${item.path}`}
                    className={`fp-item ${isDir ? 'fp-dir' : 'fp-file'}${isRecent ? ' fp-recent-row' : ''}${isSelected ? ' selected' : ''}${isActive ? ' fp-active' : ''}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => {
                      if (isDir) { setQuery(''); navigate(item.path); }
                      else toggleSelect(item.path);
                    }}
                  >
                    <span className="fp-icon">{isParent ? '⬆' : isDir ? '📁' : fileIcon(item.name)}</span>
                    <span className="fp-name" title={item.path}>{nameNode}</span>
                    {!isDir && item.size != null && <span className="fp-size">{fmtSize(item.size)}</span>}
                    {isDir && !isParent && (
                      <button
                        className="fp-cd-btn"
                        title="Set as working directory"
                        onClick={(e) => { e.stopPropagation(); handleSetWd(item.path); }}
                      >
                        wd ↵
                      </button>
                    )}
                    {canOpen && (
                      <button
                        className="fp-view-btn"
                        title="Open in editor"
                        onClick={(e) => {
                          e.stopPropagation();
                          fileEditor.open?.(item.path, item.name);
                          closeModal();
                        }}
                      >
                        open
                      </button>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </>
        )}
      </div>

      <footer className="fp-footer">
        <input
          type="file"
          id="fp-file-input-react"
          multiple
          style={{ display: 'none' }}
          onChange={handleLocalUpload}
        />
        <button className="fp-btn" onClick={() => document.getElementById('fp-file-input-react')?.click()}>
          ⬆ Upload
        </button>
        {/* "Manage…" + any other module-supplied actions render here. The
            files-manager module registers the Manage button via
            host.registers.filePickerActions.add(...). */}
        <FilePickerActionsSlot currentPath={currentPath} closeModal={closeModal} />
        <div className="fp-footer-spacer" />
        <button className="fp-btn" onClick={() => handleSetWd(currentPath)}>
          Set WD ↵
        </button>
        <button
          className="fp-btn fp-btn-primary"
          disabled={selected.length === 0}
          onClick={attachServerFiles}
        >
          {selected.length > 0
            ? `Attach ${selected.length} file${selected.length > 1 ? 's' : ''}`
            : 'Attach'}
        </button>
      </footer>
    </div>,
    document.body
  );
}
