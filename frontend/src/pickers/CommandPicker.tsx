// CommandPicker — the `#` Chat Command Picker.
//
// This is the picker for commands that produce **direct chat output**:
// built-in tools (#read, #bash, …), MCP tools, Codex tools, local nodes
// (#note, #if, #session, …), YHA skills (#skill-<name>), and the
// claudeOnly group of Claude Code passthrough commands. Every entry here
// either becomes a tool call inside the chat stream or expands into a
// user message that is sent through the chat pipeline.
//
// The sibling `/` App Command Palette (AppCommandPalette.tsx) is the
// opposite surface — it drives interface/settings/internals (layouts,
// themes, prefs, module toggles) and never enters the chat stream.
// See LayoutPlan.md §Two-surface design for the contract.
//
// Render model — mirrors AppCommandPalette so both surfaces feel the
// same:
//   • At rest (query is bare `#`): hierarchical view with one row per
//     group, collapsed by default. Single-expand — clicking a group
//     opens it in place and collapses any other.
//   • Filtering (user typed past the `#`, e.g. `#fil`): flat ranked
//     view. Items are ranked by exact / startsWith / contains / desc
//     match and re-bucketed under their group header.
//
// The parent (ChatInput) owns `expandedGroup` so it survives renders and
// so `findSelectedPickerRow` can agree with what's on screen when Enter
// is pressed.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/index.js';
import { bus } from '../state.js';
import { commands } from '../commands.js';

type CommandItem = {
  cmd: string;
  desc: string;
  toolName?: string;
  /** Source MCP server name — present on items in the `claude-mcp` group;
   *  used to sub-categorize the otherwise-flat MCP tool list by parent
   *  server (agent-multichat, bash-console, meta-bridge, …). */
  server?: string;
  /** Author-declared category from SKILL.md frontmatter — present on items
   *  in the `yha-skills` group; used to bucket skills by domain
   *  (engineering, writing, productivity, …). */
  category?: string;
};

type CommandGroup = {
  id: string;
  label: string;
  claudeOnly: boolean;
  items: CommandItem[];
};

/**
 * A row in the rendered popover. Three interactive kinds (`group`,
 * `subgroup`, `item`) and one non-interactive kind (`header`, used in
 * flat mode only as a visual label between ranked items). Only `group`
 * + `subgroup` + `item` rows participate in keyboard cursor navigation.
 *
 * `subgroup` is currently used to break the MCP Tools group into one
 * sub-collapsible per parent MCP server, but the mechanism is general —
 * any group whose items carry distinct `server` values gets the same
 * treatment in hierarchical mode.
 */
interface PickerRow {
  type: 'header' | 'group' | 'subgroup' | 'item';
  groupId: string;
  claudeOnly: boolean;
  cmd?: string;
  desc?: string;
  toolName?: string;
  label?: string;
  /** Hierarchical mode only: how many commands live in this group/subgroup. */
  count?: number;
  /** Hierarchical mode only: whether the group/subgroup is currently expanded. */
  expanded?: boolean;
  /** For `subgroup` rows: the subgroup key (e.g. MCP server name). */
  subgroupKey?: string;
  /** For `item` rows nested under an expanded subgroup. */
  nestingLevel?: 1 | 2;
  /** Flat (search) mode only: the subgroup this item belongs to — MCP
   *  server name or skill category. Rendered as a small inline hint so
   *  the user can tell related items apart once the hierarchy is gone. */
  subgroupHint?: string;
}

function esc(s: unknown): string {
  return String(s ?? '');
}

function groupBadge(groupId: string): string {
  return (
    ({
      'claude-commands': 'CC',
      'claude-tools': 'Tool',
      'codex-tools': 'OC',
      'claude-mcp': 'MCP',
      local: 'Local',
      'yha-skills': 'Skill',
    } as Record<string, string>)[groupId] || ''
  );
}

function badgeClass(groupId: string): string {
  return (
    ({
      'claude-commands': 'cc',
      'claude-tools': 'ct',
      'codex-tools': 'oc',
      'claude-mcp': 'mcp',
      local: 'loc',
      'yha-skills': 'loc',
    } as Record<string, string>)[groupId] || 'loc'
  );
}

/** A query is "at rest" when nothing has been typed past the `#` trigger. */
function isRestQuery(query: string): boolean {
  return query.replace(/^[#/]/, '').trim() === '';
}

/**
 * Strip the leading `[serverName] ` prefix that discovery.ts attaches to
 * MCP item descriptions. Once items live under a per-server subgroup,
 * the server name is already implied by the subgroup header — repeating
 * it inline is just visual noise.
 */
function stripServerPrefix(desc: string, server: string): string {
  const prefix = `[${server}] `;
  return desc.startsWith(prefix) ? desc.slice(prefix.length) : desc;
}

/**
 * Group items by `item.server` (MCP tools) or `item.category` (YHA skills).
 * Returns null if items either don't carry the sub-group field or all share
 * the same one (single bucket adds a useless layer). The per-group choice
 * is uniform: every item in a group must use the same field, so MCP
 * results bucket by server and skills bucket by author-declared category
 * without the two pools cross-contaminating.
 */
function partitionBySubgroup(items: CommandItem[]): { key: string; items: CommandItem[] }[] | null {
  if (!items.length) return null;
  const buckets = new Map<string, CommandItem[]>();
  for (const it of items) {
    const key = it.server || it.category;
    if (!key) return null;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(it);
  }
  if (buckets.size < 2) return null;
  return Array.from(buckets.entries())
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Hierarchical builder — at-rest view. One row per group with item count;
 * the expanded group (single-expand) renders its items inline beneath it.
 * If an expanded group's items can be sub-categorized (currently MCP
 * Tools by parent server), the items themselves render as a second tier
 * of collapsibles instead of a flat list.
 */
function buildHierarchical(
  groups: CommandGroup[],
  expandedGroup: string | null,
  expandedSubgroup: string | null,
): PickerRow[] {
  const out: PickerRow[] = [];
  for (const g of groups) {
    if (!g.items.length) continue;
    const isExpanded = expandedGroup === g.id;
    out.push({
      type: 'group',
      groupId: g.id,
      claudeOnly: !!g.claudeOnly,
      label: g.label,
      count: g.items.length,
      expanded: isExpanded,
    });
    if (!isExpanded) continue;

    const subs = partitionBySubgroup(g.items);
    if (subs) {
      for (const sub of subs) {
        const subExpanded = expandedSubgroup === sub.key;
        out.push({
          type: 'subgroup',
          groupId: g.id,
          claudeOnly: !!g.claudeOnly,
          label: sub.key,
          count: sub.items.length,
          expanded: subExpanded,
          subgroupKey: sub.key,
        });
        if (subExpanded) {
          for (const it of sub.items) {
            out.push({
              type: 'item',
              groupId: g.id,
              claudeOnly: !!g.claudeOnly,
              cmd: it.cmd,
              desc: stripServerPrefix(it.desc, sub.key),
              toolName: it.toolName,
              subgroupKey: sub.key,
              nestingLevel: 2,
            });
          }
        }
      }
      continue;
    }

    for (const it of g.items) {
      out.push({
        type: 'item',
        groupId: g.id,
        claudeOnly: !!g.claudeOnly,
        cmd: it.cmd,
        desc: it.desc,
        toolName: it.toolName,
        nestingLevel: 1,
      });
    }
  }
  return out;
}

/**
 * Flat builder — filtering view. Ranks each item against the query and
 * re-buckets the survivors under their group header so the result still
 * reads as grouped, but power-typing surfaces the best match at the top.
 *
 * Ranking tiers (lower is better):
 *   0 — full query is the exact command
 *   1 — full query is a prefix of the command
 *   2 — full query is a substring of the command
 *   3 — full query is a substring of the description
 *   4 — every space-separated token hits somewhere in
 *       cmd / desc / server / category (out-of-order, multi-field)
 *
 * Direct one-shot typing (#fil → #file-read) stays at tiers 1–2, so the
 * snappy substring path is unchanged. Tier 4 is the "random word" path
 * the user asked for: typing `read file` or `agent slot` still finds
 * matches even though those phrases don't appear contiguously anywhere.
 */
function buildFlat(groups: CommandGroup[], query: string): PickerRow[] {
  const q = query.toLowerCase().replace(/^[#/]/, '').trim();
  const tokens = q.split(/\s+/).filter(Boolean);

  function rank(i: CommandItem): number {
    const cmd = i.cmd.toLowerCase().replace(/^[#/]/, '');
    const desc = i.desc.toLowerCase();
    if (cmd === q) return 0;
    if (cmd.startsWith(q)) return 1;
    if (cmd.includes(q)) return 2;
    if (desc.includes(q)) return 3;
    if (tokens.length > 1) {
      const server = (i.server || '').toLowerCase();
      const category = (i.category || '').toLowerCase();
      const fields = [cmd, desc, server, category];
      if (tokens.every((t) => fields.some((f) => f.includes(t)))) return 4;
    }
    return 99;
  }

  const allHits: { item: CommandItem; group: CommandGroup; rank: number }[] = [];
  for (const g of groups) {
    for (const i of g.items) {
      const r = rank(i);
      if (r < 99) allHits.push({ item: i, group: g, rank: r });
    }
  }
  allHits.sort((a, b) => a.rank - b.rank);

  const seen = new Map<string, CommandItem[]>();
  const groupOrder: CommandGroup[] = [];
  for (const { item, group } of allHits) {
    if (!seen.has(group.id)) {
      seen.set(group.id, []);
      groupOrder.push(group);
    }
    seen.get(group.id)!.push(item);
  }

  const out: PickerRow[] = [];
  for (const g of groupOrder) {
    out.push({ type: 'header', groupId: g.id, claudeOnly: !!g.claudeOnly, label: g.label });
    for (const h of seen.get(g.id) || []) {
      const subgroupHint = h.server || h.category || undefined;
      out.push({
        type: 'item',
        groupId: g.id,
        claudeOnly: !!g.claudeOnly,
        cmd: h.cmd,
        desc: subgroupHint ? stripServerPrefix(h.desc, subgroupHint) : h.desc,
        toolName: h.toolName,
        subgroupHint,
      });
    }
  }
  return out;
}

/**
 * Compute the rows the picker will render for a given query + state.
 * Pure function so callers (component + parent activation helper) agree
 * on the row layout.
 */
function computeRows(
  groups: CommandGroup[],
  query: string,
  expandedGroup: string | null,
  expandedSubgroup: string | null,
): { rows: PickerRow[]; interactive: PickerRow[]; hierarchical: boolean } {
  const hierarchical = isRestQuery(query);
  const rows = hierarchical
    ? buildHierarchical(groups, expandedGroup, expandedSubgroup)
    : buildFlat(groups, query);
  const interactive = rows.filter(
    (r) => r.type === 'group' || r.type === 'subgroup' || r.type === 'item',
  );
  return { rows, interactive, hierarchical };
}

/**
 * Resolve what the row at `selectedIndex` represents — used by ChatInput
 * to decide what Enter does without re-implementing the rendering.
 */
export function findSelectedPickerRow(
  query: string,
  selectedIndex: number,
  expandedGroup: string | null,
  expandedSubgroup: string | null,
):
  | { kind: 'group'; group: string; expanded: boolean }
  | { kind: 'subgroup'; group: string; subgroup: string; expanded: boolean }
  | { kind: 'item'; cmd: string }
  | null {
  const groups = (commands.getCommandGroups() as CommandGroup[]) || [];
  const { interactive } = computeRows(groups, query, expandedGroup, expandedSubgroup);
  const row = interactive[selectedIndex];
  if (!row) return null;
  if (row.type === 'group') return { kind: 'group', group: row.groupId, expanded: !!row.expanded };
  if (row.type === 'subgroup' && row.subgroupKey) {
    return { kind: 'subgroup', group: row.groupId, subgroup: row.subgroupKey, expanded: !!row.expanded };
  }
  if (row.type === 'item' && row.cmd) return { kind: 'item', cmd: row.cmd };
  return null;
}

export function CommandPicker({
  open,
  textarea,
  query,
  selectedIndex,
  onSelectedIndexChange,
  expandedGroup,
  onExpandedGroupChange,
  expandedSubgroup,
  onExpandedSubgroupChange,
  onPick,
  onClose,
}: {
  open: boolean;
  textarea: HTMLTextAreaElement | null;
  query: string;
  selectedIndex: number;
  onSelectedIndexChange: (n: number) => void;
  /** Hierarchical mode — id of the currently expanded group (single-expand). */
  expandedGroup: string | null;
  onExpandedGroupChange: (g: string | null) => void;
  /** Hierarchical mode — key of the currently expanded subgroup inside the
   *  expanded group (single-expand within a tier). Used by the MCP Tools
   *  group to drill into one parent-server bucket at a time. */
  expandedSubgroup: string | null;
  onExpandedSubgroupChange: (s: string | null) => void;
  onPick: (cmd: string) => void;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<CommandGroup[]>([]);
  const currentModel = useAppStore((s) => s.currentModel.name);
  const claudeActive = /^claude-/i.test(String(currentModel || ''));

  useEffect(() => {
    const sync = () => setGroups([...(commands.getCommandGroups() as CommandGroup[])]);
    sync();
    const handler = () => sync();
    bus.on('commands:loaded', handler);
    return () => bus.off('commands:loaded', handler);
  }, []);

  const { rows, interactive, hierarchical } = useMemo(
    () => computeRows(groups, query, expandedGroup, expandedSubgroup),
    [groups, query, expandedGroup, expandedSubgroup],
  );

  // Clamp the cursor if the row count shrinks (e.g. user collapses a
  // group while the cursor was inside it).
  useEffect(() => {
    if (!open) return;
    if (selectedIndex >= interactive.length) {
      onSelectedIndexChange(Math.max(0, interactive.length - 1));
    }
  }, [open, interactive.length, onSelectedIndexChange, selectedIndex]);

  // Keep the keyboard cursor visible — without this, ArrowDown past the
  // visible viewport leaves the selection invisible until the user
  // scrolls manually. `block: 'nearest'` avoids re-centering rows that
  // are already in view, which would feel twitchy.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const target = list.querySelector('.popover-item.selected');
    if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
      (target as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [open, selectedIndex, rows]);

  useEffect(() => {
    if (!open || !textarea) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('#react-command-picker')) return;
      if (target === textarea) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, textarea, onClose]);

  if (!open || !textarea || !interactive.length) return null;

  const rect = textarea.getBoundingClientRect();

  // Available vertical space above the textarea, minus a gap, viewport padding,
  // and the popover's own chrome (padding + border). Without this cap the
  // popover can grow past the top of the viewport when the textarea sits in the
  // middle of the screen (e.g. empty chat state).
  const listMaxHeight = Math.max(
    140,
    Math.min(window.innerHeight * 0.5, rect.top - 8 - 12 - 18)
  );

  let cursor = -1;
  return createPortal(
    <div
      id="react-command-picker"
      className={`popover chat-cmd-picker ${hierarchical ? 'is-hierarchical' : 'is-flat'}`}
      style={{
        left: rect.left,
        bottom: window.innerHeight - rect.top + 8,
        top: 'auto',
        width: Math.max(340, rect.width),
      }}
    >
      <div ref={listRef} className="popover-list" style={{ maxHeight: listMaxHeight }}>
        {rows.map((row, idx) => {
          if (row.type === 'header') {
            return (
              <div key={`h-${idx}-${row.groupId}`} className="popover-group-header">
                {esc(row.label)}
                {row.claudeOnly && !claudeActive ? <span className="cmd-badge-dim">Claude only</span> : null}
              </div>
            );
          }
          if (row.type === 'group') {
            cursor += 1;
            const isSel = cursor === selectedIndex;
            const isExpanded = !!row.expanded;
            const cursorIdx = cursor;
            return (
              <div
                key={`g-${row.groupId}`}
                role="option"
                aria-selected={isSel}
                aria-expanded={isExpanded}
                className={`popover-item app-cmd-group-row${isSel ? ' selected' : ''}${isExpanded ? ' is-expanded' : ''}${row.claudeOnly && !claudeActive ? ' cmd-item-dim' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onExpandedGroupChange(isExpanded ? null : row.groupId);
                  onSelectedIndexChange(cursorIdx);
                }}
                onMouseEnter={() => onSelectedIndexChange(cursorIdx)}
              >
                <span className="cmd-label">
                  <span className="app-cmd-chevron" aria-hidden>{isExpanded ? '▾' : '▸'}</span>
                  {esc(row.label)}
                </span>
                <span className={`cmd-badge ${badgeClass(row.groupId)}`}>{row.count}</span>
                {row.claudeOnly && !claudeActive ? <span className="cmd-badge-dim">Claude only</span> : null}
              </div>
            );
          }
          if (row.type === 'subgroup') {
            cursor += 1;
            const isSel = cursor === selectedIndex;
            const isExpanded = !!row.expanded;
            const cursorIdx = cursor;
            const subKey = row.subgroupKey || '';
            return (
              <div
                key={`sg-${row.groupId}-${subKey}`}
                role="option"
                aria-selected={isSel}
                aria-expanded={isExpanded}
                className={`popover-item app-cmd-group-row app-cmd-subgroup-row${isSel ? ' selected' : ''}${isExpanded ? ' is-expanded' : ''}${row.claudeOnly && !claudeActive ? ' cmd-item-dim' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onExpandedSubgroupChange(isExpanded ? null : subKey);
                  onSelectedIndexChange(cursorIdx);
                }}
                onMouseEnter={() => onSelectedIndexChange(cursorIdx)}
              >
                <span className="cmd-label">
                  <span className="app-cmd-chevron" aria-hidden>{isExpanded ? '▾' : '▸'}</span>
                  {esc(row.label)}
                </span>
                <span className={`cmd-badge ${badgeClass(row.groupId)}`}>{row.count}</span>
              </div>
            );
          }
          // type === 'item'
          cursor += 1;
          const isSel = cursor === selectedIndex;
          const cursorIdx = cursor;
          const nestClass = hierarchical
            ? row.nestingLevel === 2
              ? ' app-cmd-nested app-cmd-nested-2'
              : ' app-cmd-nested'
            : '';
          return (
            <div
              key={row.cmd}
              role="option"
              aria-selected={isSel}
              className={`popover-item${isSel ? ' selected' : ''}${row.claudeOnly && !claudeActive ? ' cmd-item-dim' : ''}${nestClass}`}
              onMouseDown={(e) => {
                e.preventDefault();
                if (row.cmd) onPick(row.cmd);
              }}
              onMouseEnter={() => onSelectedIndexChange(cursorIdx)}
            >
              <span className="cmd-label">{esc(row.cmd)}</span>
              <span className={`cmd-badge ${badgeClass(row.groupId)}`}>{groupBadge(row.groupId)}</span>
              {row.subgroupHint ? (
                <span className="cmd-subgroup-hint">{esc(row.subgroupHint)}</span>
              ) : null}
              <span className="dim">{esc(row.desc)}</span>
            </div>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
