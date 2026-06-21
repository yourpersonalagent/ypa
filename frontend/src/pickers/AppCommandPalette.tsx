// AppCommandPalette — the `/` App Command Palette (LayoutPlan.md §Phase 3).
//
// Two-surface contract (see LayoutPlan.md §Two-surface design):
//   • `#` Chat Command Picker (CommandPicker.tsx) — commands that
//     produce direct chat output. Tools, MCP, codex, local nodes, YHA
//     skills. Every selection results in a message or tool call that
//     enters the chat stream.
//   • `/` App Command Palette (this file) — interface / settings /
//     internals that never enter the chat stream. Layouts, themes,
//     view options, panel toggles, prefs, module commands.
//
// Distinct from `CommandPicker`. This component reads from the
// `appCommands` register plus auto-wraps three existing registers
// (headerIconButtons → header.*, panels → panel.toggle.*, prefsTabs →
// prefs.open.*) so every clickable / configurable surface in the app
// is reachable from one fuzzy-filterable list.
//
// Mount sites:
//   • Inline picker — opens from the chat textarea on `/` trigger. The
//     chat input passes the textarea ref + query string and dismisses on
//     Enter / Esc / outside-click.
//   • Global overlay — `Ctrl+P` / `Cmd+K` opens this same component as a
//     centered modal that doesn't need the chat textarea. Wired in
//     KeyboardShortcuts.tsx + a separate <GlobalAppCommandPalette /> mount.
//
// Filter model:
//   • Bare text  →  flat fuzzy across all groups.
//   • `<group> <terms>` →  narrows to that group. Recognised group prefixes:
//     `layout`, `theme`, `view`, `model`, `session`, `cwd`, `prefs`,
//     `panel`, `header`, `harness`, plus any `module:<name>`.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { registers } from '../host/keys.js';
import { useRegisterList } from '../host/useRegisterList.js';
import type { AppCommand, AppCommandGroup, AppCommandCtx } from '../host/keys.js';
import { listMruIds } from './appCommandMru.js';
import {
  buildAutoWrappedCommands,
  runAppCommand,
  snapshotAppCommands,
} from '../host/app-command-runtime.js';

export { runAppCommand } from '../host/app-command-runtime.js';

// ── Group display config ───────────────────────────────────────────────────

const GROUP_DISPLAY: Record<string, { label: string; order: number }> = {
  recent:        { label: 'Recently used',     order: 1 },
  chat:          { label: 'Chat Bar',          order: 5 },
  layout:        { label: 'Layout',            order: 10 },
  design:        { label: 'Design Theme',      order: 15 },
  'color-theme': { label: 'Color Theme',       order: 20 },
  view:          { label: 'View',              order: 30 },
  model:         { label: 'Model',             order: 40 },
  session:       { label: 'Session',           order: 50 },
  cwd:           { label: 'Working Directory', order: 60 },
  prefs:         { label: 'Preferences',       order: 70 },
  panel:         { label: 'Panels',            order: 80 },
  header:        { label: 'Header Buttons',    order: 90 },
  workflow:      { label: 'Workflow Editor',   order: 95 },
  harness:       { label: 'Harness',           order: 100 },
  debug:         { label: 'Debug',             order: 110 },
  help:          { label: 'Help',              order: 120 },
};

function groupLabel(group: string): string {
  if (group.startsWith('module:')) return `Module · ${group.slice('module:'.length)}`;
  return GROUP_DISPLAY[group]?.label ?? group;
}

function groupOrder(group: string): number {
  if (group.startsWith('module:')) return 200;
  return GROUP_DISPLAY[group]?.order ?? 300;
}

// Group prefix aliases — what the user types in the input vs the canonical
// group id. `theme` is the friendliest alias for `color-theme`.
const PREFIX_ALIASES: Record<string, AppCommandGroup | undefined> = {
  chat: 'chat',
  bar: 'chat',
  input: 'chat',
  layout: 'layout',
  layouts: 'layout',
  theme: 'color-theme',
  themes: 'color-theme',
  color: 'color-theme',
  colors: 'color-theme',
  design: 'design',
  designs: 'design',
  skin: 'design',
  skins: 'design',
  view: 'view',
  model: 'model',
  models: 'model',
  session: 'session',
  sessions: 'session',
  cwd: 'cwd',
  prefs: 'prefs',
  preferences: 'prefs',
  panel: 'panel',
  panels: 'panel',
  header: 'header',
  workflow: 'workflow',
  workflows: 'workflow',
  editor: 'workflow',
  hud: 'workflow',
  harness: 'harness',
  debug: 'debug',
  debugging: 'debug',
  diagnostics: 'debug',
  inspect: 'debug',
  help: 'help',
  tutorial: 'help',
  tour: 'help',
  onboarding: 'help',
};

interface ParsedQuery {
  group: AppCommandGroup | null;
  /** The remainder after stripping the group prefix. */
  text: string;
}

function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.replace(/^\s*\//, '').trimStart();
  if (!trimmed) return { group: null, text: '' };
  const firstSpace = trimmed.indexOf(' ');
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const tail = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);

  // Module form: `module:pet` or just `module` (matches all module groups).
  if (head === 'module' || head === 'modules') {
    return { group: null, text: tail.toLowerCase() };
  }
  if (head.startsWith('module:')) {
    return { group: head as AppCommandGroup, text: tail.toLowerCase() };
  }
  const aliased = PREFIX_ALIASES[head];
  if (aliased) return { group: aliased, text: tail.toLowerCase() };
  return { group: null, text: trimmed.toLowerCase() };
}

// ── Auto-wrapped registers → synthetic commands ────────────────────────────

function useAutoWrappedCommands(): AppCommand[] {
  const headerIcons    = useRegisterList(registers.headerIconButtons);
  const hudButtons     = useRegisterList(registers.hudButtons);
  const prefsTabs      = useRegisterList(registers.prefsTabs);
  const prefsEntries   = useRegisterList(registers.prefsEntries);
  const headerSections = useRegisterList(registers.headerSections);

  return useMemo(
    () => buildAutoWrappedCommands({
      headerIcons,
      hudButtons,
      prefsTabs,
      prefsEntries,
      headerSections,
    }),
    [headerIcons, hudButtons, prefsTabs, prefsEntries, headerSections],
  );
}

// ?? Ranking ????????????????????????????????????????????????????????????????

function rankCommand(c: AppCommand, q: string): number {
  if (!q) return 50;
  const label = c.label.toLowerCase();
  const id = c.id.toLowerCase();
  const kw = (c.keywords || []).join(' ').toLowerCase();
  if (label === q) return 0;
  if (id === q) return 0;
  if (label.startsWith(q)) return 1;
  if (id.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  if (id.includes(q)) return 3;
  if (kw.includes(q)) return 4;
  // Token-by-token fallback so `theme ocean dark` still matches
  // "Ocean Dark" even if the substring isn't contiguous.
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => label.includes(t) || kw.includes(t))) return 5;
  return 99;
}

/**
 * A row in the rendered popover. Two interactive kinds (`group`, `item`) and
 * one non-interactive kind (`header`, used in flat mode only as a visual
 * label between ranked items). Only `group` + `item` rows participate in
 * keyboard cursor navigation.
 */
interface PaletteRow {
  type: 'header' | 'group' | 'item';
  group: string;
  cmd?: AppCommand;
  label?: string;
  /** Hierarchical mode only: how many commands live in this group. */
  count?: number;
  /** Hierarchical mode only: whether the group is currently expanded. */
  expanded?: boolean;
}

/**
 * Hierarchical builder — used when the query is at rest (no filter text and
 * no explicit group prefix). Shows one row per group; the expanded group
 * (single-expand) renders its items inline beneath it. This keeps the
 * "first-open" view short and lets a mouse user drill in by clicking.
 *
 * A virtual "Recently used" group is prepended (default expanded) whenever
 * the MRU log has entries — Phase 6 polish, so power-typing first-launch
 * users still see something immediately useful when they hit `/` or Ctrl+P.
 */
function buildHierarchical(
  cmds: AppCommand[],
  expandedGroup: string | null,
  mruIds: string[],
): PaletteRow[] {
  const byGroup = new Map<string, AppCommand[]>();
  for (const c of cmds) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(c);
  }
  const groupSeq = Array.from(byGroup.keys()).sort((a, b) => groupOrder(a) - groupOrder(b));

  // Build the MRU command list — preserve mruIds order (newest first).
  const cmdById = new Map(cmds.map((c) => [c.id, c]));
  const mruCmds = mruIds.map((id) => cmdById.get(id)).filter((c): c is AppCommand => !!c);
  const hasMru = mruCmds.length > 0;

  // The MRU group expands by default unless the caller has explicitly
  // expanded another group. Comparing against `expandedGroup === 'recent'`
  // also handles the explicit-collapse case.
  const mruExpanded = expandedGroup === null ? true : expandedGroup === 'recent';

  const out: PaletteRow[] = [];
  if (hasMru) {
    out.push({
      type: 'group',
      group: 'recent',
      label: groupLabel('recent'),
      count: mruCmds.length,
      expanded: mruExpanded,
    });
    if (mruExpanded) {
      for (const cmd of mruCmds) out.push({ type: 'item', group: 'recent', cmd });
    }
  }

  for (const g of groupSeq) {
    const items = byGroup.get(g)!;
    const isExpanded = expandedGroup === g;
    out.push({
      type: 'group',
      group: g,
      label: groupLabel(g),
      count: items.length,
      expanded: isExpanded,
    });
    if (isExpanded) {
      for (const cmd of items) {
        out.push({ type: 'item', group: g, cmd });
      }
    }
  }
  return out;
}

/**
 * Flat builder — used when the user is actively filtering (any text after
 * the `/`, or an explicit group prefix). Shows ranked items grouped by
 * section header. This is the previous default rendering, preserved so
 * power-typing remains fast.
 */
function buildFlat(cmds: AppCommand[], parsed: ParsedQuery): PaletteRow[] {
  const q = parsed.text.trim();
  const pool = parsed.group ? cmds.filter((c) => c.group === parsed.group) : cmds;

  const ranked = pool
    .map((cmd) => ({ cmd, rank: rankCommand(cmd, q) }))
    .filter((r) => r.rank < 99)
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return groupOrder(a.cmd.group) - groupOrder(b.cmd.group);
    });

  const byGroup = new Map<string, AppCommand[]>();
  const groupSeq: string[] = [];
  for (const { cmd } of ranked) {
    const g = cmd.group;
    if (!byGroup.has(g)) { byGroup.set(g, []); groupSeq.push(g); }
    byGroup.get(g)!.push(cmd);
  }
  groupSeq.sort((a, b) => groupOrder(a) - groupOrder(b));

  const out: PaletteRow[] = [];
  for (const g of groupSeq) {
    out.push({ type: 'header', group: g, label: groupLabel(g) });
    for (const cmd of byGroup.get(g)!) {
      out.push({ type: 'item', group: g, cmd });
    }
  }
  return out;
}

/** A query is "at rest" when nothing has been typed past the `/` trigger. */
function isRestQuery(parsed: ParsedQuery): boolean {
  return parsed.group === null && parsed.text.trim() === '';
}

// ── Component ──────────────────────────────────────────────────────────────

export interface AppCommandPaletteProps {
  open: boolean;
  /** Anchor textarea (inline mode). Null → global overlay (centered modal). */
  textarea: HTMLTextAreaElement | null;
  /** Full query string (may include the leading `/`). */
  query: string;
  /** Cursor index across interactive rows (groups + items). */
  selectedIndex: number;
  onSelectedIndexChange: (n: number) => void;
  /**
   * Hierarchical mode — which group is currently expanded (single-expand).
   * Owned by the parent so it survives between renders and is observable by
   * the activation helper. `null` = all collapsed.
   */
  expandedGroup: string | null;
  onExpandedGroupChange: (g: string | null) => void;
  /** Called after a command runs. */
  onClose: () => void;
  /**
   * When true, renders inline in the parent's DOM (no portal, no fixed
   * positioning). The parent wrapper provides the visual frame.
   */
  renderInline?: boolean;
}

/**
 * Compute the rows the palette will render for a given query + state. Pure
 * function so callers (component and parent activation handler) agree on
 * the row layout.
 */
function computeRows(
  cmds: AppCommand[],
  parsed: ParsedQuery,
  expandedGroup: string | null,
  mruIds: string[],
): { rows: PaletteRow[]; interactive: PaletteRow[]; hierarchical: boolean } {
  const hierarchical = isRestQuery(parsed);
  const rows = hierarchical
    ? buildHierarchical(cmds, expandedGroup, mruIds)
    : buildFlat(cmds, parsed);
  const interactive = rows.filter((r) => r.type === 'group' || r.type === 'item');
  return { rows, interactive, hierarchical };
}

/** Stable empty array so useSyncExternalStore doesn't churn. */
const EMPTY_IDS: string[] = [];

function useMruIds(availableIds: Set<string>): string[] {
  // Track a tick that bumps on `yha:app-cmd-mru-changed`. We re-derive the
  // list from localStorage on every render where the tick advanced — cheap
  // (a short JSON parse) and keeps the palette honest if MRU is mutated
  // from another tab.
  const tick = useSyncExternalStore(
    (cb) => {
      window.addEventListener('yha:app-cmd-mru-changed', cb);
      window.addEventListener('storage', cb);
      return () => {
        window.removeEventListener('yha:app-cmd-mru-changed', cb);
        window.removeEventListener('storage', cb);
      };
    },
    () => 0,
    () => 0,
  );
  void tick; // depend on the subscription, even though the value is unused
  return useMemo(
    () => (availableIds.size ? listMruIds(availableIds) : EMPTY_IDS),
    // Re-derive whenever the available command set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableIds],
  );
}

/** Snapshot of the registers used by the palette, including auto-wrapped synthetics. */
function snapshotCommands(): AppCommand[] {
  return snapshotAppCommands();
}

export function AppCommandPalette({
  open,
  textarea,
  query,
  selectedIndex,
  onSelectedIndexChange,
  expandedGroup,
  onExpandedGroupChange,
  onClose,
  renderInline = false,
}: AppCommandPaletteProps) {
  const registered = useRegisterList(registers.appCommands);
  const autoWrapped = useAutoWrappedCommands();
  const parsed = useMemo(() => parseQuery(query), [query]);

  const all = useMemo<AppCommand[]>(() => {
    const fromRegister = registered as unknown as AppCommand[];
    const byId = new Map(fromRegister.map((command) => [command.id, command]));
    for (const command of autoWrapped) {
      if (!byId.has(command.id)) byId.set(command.id, command);
    }
    return [...byId.values()];
  }, [registered, autoWrapped]);

  const availableIds = useMemo(() => new Set(all.map((c) => c.id)), [all]);
  const mruIds = useMruIds(availableIds);

  const { rows, interactive, hierarchical } = useMemo(
    () => computeRows(all, parsed, expandedGroup, mruIds),
    [all, parsed, expandedGroup, mruIds],
  );

  const wrapRef = useRef<HTMLDivElement>(null);

  // Clamp the selection cursor if the row count shrinks (e.g. user collapses
  // a group and the cursor was inside it).
  useEffect(() => {
    if (!open) return;
    if (selectedIndex >= interactive.length) {
      onSelectedIndexChange(Math.max(0, interactive.length - 1));
    }
  }, [open, interactive.length, onSelectedIndexChange, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('#react-app-command-palette')) return;
      if (target === textarea) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, textarea, onClose]);

  if (!open || !interactive.length) return null;

  // Compute mount position. Inline (textarea anchor) — popover above the
  // textarea. Global overlay (no textarea) — centered on the viewport.
  // textareaRect is also used below to cap the list height to the space above
  // the textarea, so the popover never grows past the top of the viewport.
  const textareaRect = textarea ? textarea.getBoundingClientRect() : null;
  const style: React.CSSProperties = textareaRect
    ? {
        left: textareaRect.left,
        bottom: window.innerHeight - textareaRect.top + 8,
        top: 'auto',
        width: Math.max(380, textareaRect.width),
      }
    : {
        left: '50%',
        top: '20%',
        transform: 'translateX(-50%)',
        width: 'min(560px, 92vw)',
      };

  const listMaxHeight = textareaRect
    ? Math.max(140, Math.min(window.innerHeight * 0.5, textareaRect.top - 8 - 12 - 18))
    : window.innerHeight * 0.6;

  const ctx: AppCommandCtx = { closePalette: onClose };

  // `interactive` is the cursor-addressable subset of `rows`. We render the
  // full row list so flat-mode section headers still appear, but only count
  // groups + items for selection.
  let runningInteractiveIdx = -1;
  const listEl = (
    <div
      id="react-app-command-palette"
      className={`popover app-cmd-palette${hierarchical ? ' is-hierarchical' : ' is-flat'}${renderInline ? ' app-cmd-palette--inline' : ''}`}
      ref={wrapRef}
      role="listbox"
      style={renderInline ? undefined : style}
    >
      <div className="popover-list" style={renderInline ? undefined : { maxHeight: listMaxHeight }}>
        {rows.map((row, idx) => {
          if (row.type === 'header') {
            return (
              <div key={`h-${idx}-${row.group}`} className="popover-group-header">
                {row.label}
              </div>
            );
          }
          if (row.type === 'group') {
            runningInteractiveIdx += 1;
            const isSel = runningInteractiveIdx === selectedIndex;
            const isExpanded = !!row.expanded;
            const cursorIdx = runningInteractiveIdx;
            return (
              <div
                key={`g-${row.group}`}
                role="option"
                aria-selected={isSel}
                aria-expanded={isExpanded}
                className={`popover-item app-cmd-group-row${isSel ? ' selected' : ''}${isExpanded ? ' is-expanded' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onExpandedGroupChange(isExpanded ? null : row.group);
                  onSelectedIndexChange(cursorIdx);
                }}
                onMouseEnter={() => onSelectedIndexChange(cursorIdx)}
              >
                <span className="cmd-label">
                  <span className="app-cmd-chevron" aria-hidden>{isExpanded ? '▾' : '▸'}</span>
                  {row.label}
                </span>
                <span className="cmd-badge loc">{row.count}</span>
              </div>
            );
          }
          // type === 'item'
          runningInteractiveIdx += 1;
          const isSel = runningInteractiveIdx === selectedIndex;
          const cmd = row.cmd!;
          const state = (() => { try { return cmd.state?.() || {}; } catch { return {}; } })();
          const badge = cmd.badge ?? state.value ?? '';
          const cursorIdx = runningInteractiveIdx;
          return (
            <div
              key={cmd.id}
              role="option"
              aria-selected={isSel}
              className={`popover-item${isSel ? ' selected' : ''}${state.active ? ' is-active' : ''}${hierarchical ? ' app-cmd-nested' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                runAppCommand(cmd, ctx);
              }}
              onMouseEnter={() => onSelectedIndexChange(cursorIdx)}
            >
              <span className="cmd-label">
                {state.active ? <span className="cmd-active-tick">✓</span> : null}
                {cmd.label}
              </span>
              {badge ? <span className="cmd-badge loc">{badge}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
  return renderInline ? listEl : createPortal(listEl, document.body);
}

/**
 * Resolve what the row at `selectedIndex` represents — used by parents to
 * decide what Enter does without re-implementing the rendering. Returns
 * `null` if the index is out of bounds or the palette would render empty.
 */
export function findSelectedRow(
  query: string,
  selectedIndex: number,
  expandedGroup: string | null,
): { kind: 'group'; group: string; expanded: boolean } | { kind: 'item'; cmd: AppCommand } | null {
  const parsed = parseQuery(query);
  const cmds = snapshotCommands();
  const availableIds = new Set(cmds.map((c) => c.id));
  const mruIds = listMruIds(availableIds);
  const { interactive } = computeRows(cmds, parsed, expandedGroup, mruIds);
  const row = interactive[selectedIndex];
  if (!row) return null;
  if (row.type === 'group') return { kind: 'group', group: row.group, expanded: !!row.expanded };
  return { kind: 'item', cmd: row.cmd! };
}

/**
 * @deprecated Prefer `findSelectedRow` — preserved for any caller that only
 * needs the command at a given index. Returns null on group rows.
 */
export function findSelectedCommand(query: string, selectedIndex: number): AppCommand | null {
  // In hierarchical (rest) mode there's no expanded group by default — Enter
  // is intercepted by `findSelectedRow` and the parent toggles expansion
  // itself, so this helper's `null` return is correct.
  const row = findSelectedRow(query, selectedIndex, null);
  return row && row.kind === 'item' ? row.cmd : null;
}
