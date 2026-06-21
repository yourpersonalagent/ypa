// Register the core (non-module) header sections.
//
// Mirrors `bootstrap-core-icons.tsx` for the `headerSections` register. Each
// entry below was inline JSX in `layouts/full/FullLayout.tsx:148-211` before
// the migration. They live in core because every layout that wants a header
// (only `full` today) needs at least cwd / context / icons. As features
// migrate into individual modules, the matching entry below moves into that
// module's `activate(host)` and disappears from here.
//
// `order` values (10, 20, 30, …) preserve the visual order from the previous
// hard-coded `headerGroups` array — with `order: 20` reserved for the
// `plugins-folder` module (`+`-or-headline section).
//
// Gating: Personnel + Partner are gated via `when:` predicates that read
// `isBridgeModuleEnabledStrict('multichat-{personnel,partners}')`. The
// `HeaderSectionsSlot` re-evaluates these on bridge-modules store changes
// (see slot impl) so the sections appear / disappear in lockstep with the
// bridge module enablement state — same behaviour as the strict hook the
// inline JSX used previously.

import { registers } from './keys.js';
import type { HeaderSectionProps } from './keys.js';
import { CwdPanel } from '../panels/CwdPanel.js';
import { GlobalContextPanel } from '../panels/GlobalContextPanel.js';
import { PersonnelPanel } from '../panels/PersonnelPanel.js';
import { HeaderIconsSlot } from './slots/HeaderIconsSlot.js';
import { isBridgeModuleEnabledStrict } from './bridge-modules.js';

let registered = false;

export function registerCoreHeaderSections() {
  if (registered) return;
  registered = true;

  registers.headerSections.add({
    id: 'core.cwd',
    sectionId: 'hs-cwd',
    bodyId: 'cwd-panel',
    order: 10,
    component: CwdSection,
    panelLabel: 'Working Directory',
    panelKeywords: ['cwd', 'current working directory', 'projects', 'sessions', 'serve', 'todos', 'yolo'],
    core: true,
  }, '<core>');

  registers.headerSections.add({
    id: 'core.personnel',
    sectionId: 'hs-personnel',
    bodyId: 'personnel-panel',
    order: 30,
    when: () => isBridgeModuleEnabledStrict('multichat-personnel'),
    component: PersonnelSection,
    panelLabel: 'Personnel',
    panelKeywords: ['personnel', 'employees', 'team'],
    core: true,
  }, '<core>');

  // Partner section now lives in the `multichat-partners` FE module
  // (frontend/src/modules/multichat-partners/index.tsx) — it only activates
  // when the bridge module is enabled, so the section is gated by the
  // module's own lifecycle instead of a `when:` predicate here.

  registers.headerSections.add({
    id: 'core.global-context',
    sectionId: 'hs-global-context',
    bodyId: 'global-context-panel',
    order: 50,
    component: GlobalContextSection,
    panelLabel: 'Global Context',
    panelKeywords: ['global context', 'thoughts', 'important', 'memory', 'system prompt'],
    core: true,
  }, '<core>');

  registers.headerSections.add({
    id: 'core.icons',
    order: 60,
    component: IconsSection,
    core: true,
  }, '<core>');
}

// ── Section components ───────────────────────────────────────────────────

function CwdSection({ open, onToggle }: HeaderSectionProps) {
  return <CwdPanel open={open} onToggle={onToggle} />;
}

function GlobalContextSection({ open, onToggle }: HeaderSectionProps) {
  return <GlobalContextPanel open={open} onToggle={onToggle} />;
}

function PersonnelSection({ open, onToggle }: HeaderSectionProps) {
  return <PersonnelPanel open={open} onToggle={onToggle} />;
}

function IconsSection(_: HeaderSectionProps) {
  return (
    <div className="hm-row-pair-group">
      <HeaderIconsSlot group="primary" />
      <HeaderIconsSlot group="secondary" />
    </div>
  );
}
