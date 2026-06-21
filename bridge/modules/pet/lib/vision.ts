// ── Pet-Vision — in-memory spatial-snapshot store ───────────────────────────
// Receives a single PetWorldSnapshot from the frontend whenever the pet has
// come to rest (debounced 2 s after its last move, gated on visible + !behindUi).
// The MCP child reads the latest snapshot through /proxy/pet-vision/snapshot
// to surface a natural-language description via the `pet_observe` tool.
//
// Why in-memory and not persisted:
//   • single-user app — one frontend session at a time, no cross-process need
//   • a stale snapshot from yesterday is misleading; we'd rather report "no
//     snapshot yet" on bridge restart than ship outdated coordinates
//
// What the bridge never does:
//   • the bridge does NOT capture the snapshot itself — it has no DOM. The
//     frontend's usePetWorldModel hook is the producer; the bridge is a relay.
//   • the bridge does NOT validate the shape beyond "is an object" — the FE
//     is the only writer, and the writer + reader live in the same release
//     train so shape mismatches surface in dev, not prod.
'use strict';

interface PetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface NearbyElement {
  label: string;
  rect: PetRect;
  distancePx: number;
  importance: number;
  selector: string;
}

interface NearbyInput extends NearbyElement {
  placeholder: string;
  hasFocus: boolean;
  kind: 'textarea' | 'input' | 'contenteditable';
}

interface NearbyPanel {
  label: string;
  rect: PetRect;
  id: string;
}

interface FocusedElement {
  tag: string;
  label: string;
  rect: PetRect;
}

/** Shape mirrors frontend/src/modules/pet/store/petWorldStore.ts.
 *  Single producer (FE) + single consumer (MCP) so the duplication
 *  is acceptable; promoting to a shared package isn't worth the
 *  build-graph cost for one snapshot type. */
export interface PetWorldSnapshot {
  petPos: { x: number; y: number };
  petRect: PetRect;
  nearest: {
    button: NearbyElement | null;
    input: NearbyInput | null;
    panel: NearbyPanel | null;
  };
  visibleButtons: NearbyElement[];
  activeRegion: 'chat' | 'chat-input' | 'command-palette' | 'header' | 'panel' | 'free';
  focusedElement: FocusedElement | null;
  /** performance.now() in the FE — only useful as a freshness delta on the FE. */
  capturedAt: number;
}

interface StoredSnapshot {
  snapshot: PetWorldSnapshot;
  /** Date.now() on the bridge when we received the snapshot. The MCP tool
   *  uses this to surface "snapshot is N s old" rather than relying on the
   *  FE's performance.now() (which is per-tab and meaningless on the bridge). */
  receivedAt: number;
  /** Optional FE viewport dims for prose context — "the pet sits ~30 px
   *  from the right edge of an 1840 px viewport". */
  viewport?: { width: number; height: number };
}

let latest: StoredSnapshot | null = null;

export function setSnapshot(
  snapshot: PetWorldSnapshot,
  viewport?: { width: number; height: number },
): void {
  latest = {
    snapshot,
    receivedAt: Date.now(),
    viewport,
  };
}

export function clearSnapshot(): void {
  latest = null;
}

export function getSnapshot(): StoredSnapshot | null {
  return latest;
}

// ── Command catalog (Phase 5) ───────────────────────────────────────────────
// The frontend's `appCommands` register is the canonical list of everything
// reachable through Ctrl+P / `/` — layout switching, color themes, view
// toggles, prefs entries, panel actions, harness controls, module commands.
// Pushing it here lets `pet_commands` describe the YHA UI surface to agents
// without re-inventing the catalog on the bridge side.
//
// Pushed in full whenever the register fires `change` (debounced 200 ms on
// the FE), so the bridge always holds the same entries the palette would
// show right now.

export interface CatalogCommandState {
  active?: boolean;
  value?: string;
}

export interface CatalogCommand {
  id: string;
  group: string;
  label: string;
  keywords?: string[];
  badge?: string;
  state?: CatalogCommandState;
}

interface StoredCatalog {
  commands: CatalogCommand[];
  receivedAt: number;
}

let latestCatalog: StoredCatalog | null = null;

export function setCatalog(commands: CatalogCommand[]): void {
  latestCatalog = { commands, receivedAt: Date.now() };
}

export function clearCatalog(): void {
  latestCatalog = null;
}

export function getCatalog(): StoredCatalog | null {
  return latestCatalog;
}

/** Sorted list of distinct group names present in the current catalog,
 *  with the count of commands per group. Cheap to compute and small enough
 *  to return as the default "what's available" view from the MCP tool. */
export function listCatalogGroups(): Array<{ group: string; count: number }> {
  if (!latestCatalog) return [];
  const counts = new Map<string, number>();
  for (const c of latestCatalog.commands) {
    counts.set(c.group, (counts.get(c.group) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

/** Render the catalog (or a subset) as agent-readable prose.
 *  - `group` filters to a single group.
 *  - `query` does a case-insensitive substring match across id/label/keywords.
 *  When both are omitted, returns a high-level overview (groups + counts)
 *  rather than the full catalog so a default call doesn't flood the model. */
export function describeCatalog(opts: {
  group?: string;
  query?: string;
} = {}): string {
  if (!latestCatalog) return 'No command catalog has been pushed yet. The frontend may still be booting; try again shortly.';
  const { group, query } = opts;
  const all = latestCatalog.commands;

  // Default — no group, no query: high-level summary.
  if (!group && !query) {
    const groups = listCatalogGroups();
    const lines: string[] = [];
    lines.push(`YHA UI catalog: ${all.length} commands across ${groups.length} groups (UI elements, settings, views, themes, panels, modules).`);
    lines.push('Group overview (call again with `group: "<name>"` to expand):');
    for (const g of groups) {
      lines.push(`  • ${g.group} — ${g.count}`);
    }
    lines.push(`Snapshot age: ${Math.round((Date.now() - latestCatalog.receivedAt) / 1000)} s.`);
    return lines.join('\n');
  }

  // Filter by group + query.
  const q = query ? query.toLowerCase() : '';
  const matched = all.filter((c) => {
    if (group && c.group !== group) return false;
    if (!q) return true;
    if (c.id.toLowerCase().includes(q)) return true;
    if (c.label.toLowerCase().includes(q)) return true;
    if (c.keywords?.some((k) => k.toLowerCase().includes(q))) return true;
    return false;
  });

  if (matched.length === 0) {
    const hint = group
      ? `No commands in group "${group}"${query ? ` matching "${query}"` : ''}.`
      : `No commands match "${query}".`;
    return hint + ' Call without arguments to see the group overview.';
  }

  // Group the matched results so the agent can see structure even when
  // querying across all groups.
  const byGroup = new Map<string, CatalogCommand[]>();
  for (const c of matched) {
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(c);
  }
  const lines: string[] = [];
  const header = group
    ? `Commands in group "${group}"${query ? ` matching "${query}"` : ''} (${matched.length}):`
    : `Commands matching "${query}" (${matched.length}, across ${byGroup.size} groups):`;
  lines.push(header);
  for (const [g, cmds] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!group) lines.push(`\n[${g}]`);
    for (const c of cmds.sort((a, b) => a.label.localeCompare(b.label))) {
      const flags: string[] = [];
      if (c.state?.active) flags.push('active');
      if (c.state?.value) flags.push(c.state.value);
      if (c.badge) flags.push(c.badge);
      const suffix = flags.length ? ` [${flags.join(' · ')}]` : '';
      const kw = c.keywords && c.keywords.length ? `  — ${c.keywords.slice(0, 4).join(', ')}` : '';
      lines.push(`  ${c.id} — ${c.label}${suffix}${kw}`);
    }
  }
  lines.push('\nInvoke a command by its id from the "/" palette (Ctrl+P) or via the matching shortcut.');
  lines.push(`Snapshot age: ${Math.round((Date.now() - latestCatalog.receivedAt) / 1000)} s.`);
  return lines.join('\n');
}

/** Best-effort English summary of the snapshot for the MCP tool. Kept
 *  here so the FE and bridge agree on the wording — if we ever expose
 *  the same prose to the FE we don't drift. */
export function describeSnapshot(stored: StoredSnapshot): string {
  const s = stored.snapshot;
  const ageSec = Math.round((Date.now() - stored.receivedAt) / 1000);
  const lines: string[] = [];
  lines.push(
    `The pet is at (${Math.round(s.petPos.x)}, ${Math.round(s.petPos.y)})`
    + (stored.viewport
      ? ` in a ${stored.viewport.width}×${stored.viewport.height} viewport`
      : '')
    + ` — active region: ${s.activeRegion}.`,
  );

  if (s.nearest.button) {
    const b = s.nearest.button;
    lines.push(`Nearest button: "${b.label}" (${b.distancePx} px away, importance ${b.importance.toFixed(2)}).`);
  } else {
    lines.push('No actionable button is visible nearby.');
  }

  if (s.nearest.input) {
    const i = s.nearest.input;
    const focus = i.hasFocus ? ', focused' : '';
    const placeholder = i.placeholder ? ` with placeholder "${i.placeholder}"` : '';
    lines.push(`Nearest input: ${i.kind} "${i.label}"${placeholder} (${i.distancePx} px away${focus}).`);
  }

  if (s.focusedElement) {
    const f = s.focusedElement;
    lines.push(`Currently focused element: <${f.tag}> "${f.label}".`);
  }

  if (s.nearest.panel) {
    lines.push(`Nearest panel: "${s.nearest.panel.label}".`);
  }

  if (s.visibleButtons.length > 0) {
    const top = s.visibleButtons
      .slice(0, 5)
      .map((b) => `"${b.label}" (${b.importance.toFixed(2)})`)
      .join(', ');
    lines.push(`Top visible buttons by importance: ${top}.`);
  }

  lines.push(`Snapshot age: ${ageSec} s.`);
  return lines.join('\n');
}
