// HeaderSectionsSlot — renders entries from the `headerSections` register
// into the `<header class="header-actions">` row. Interleaves `<hm-sep />`
// dividers between consecutive sections.
//
// The slot is "controlled" — open-state ownership stays in the parent
// (currently `FullLayout`) so its horizontal-bar clamping `useEffect` can
// still react to open transitions. Sections with a `sectionId` participate
// in the mutually-exclusive group; sections without one (icons row) render
// with `open=false` and a no-op toggle.
//
// External-state reactivity: a section's `when:` predicate may read the
// bridge-modules store (Personnel/Partner are gated this way). The register
// caches its filtered snapshot per mutation, so to re-evaluate predicates
// on bridge-modules transitions we subscribe to that store and re-filter
// `listAll()` here. That keeps the slot in lockstep with both registers and
// bridge state without poking the register's cache.

import { Fragment } from 'react';
import { registers } from '../keys.js';
import type { HeaderSection } from '../keys.js';
import { useRegisterListAll } from '../useRegisterList.js';
import { useBridgeModulesStore } from '../bridge-modules.js';

export interface HeaderSectionsSlotProps {
  openSection: string | null;
  toggleSection: (sectionId: string, bodyId?: string) => void;
}

export function HeaderSectionsSlot({ openSection, toggleSection }: HeaderSectionsSlotProps) {
  const all = useRegisterListAll(registers.headerSections);
  // Force re-render when bridge-module enablement transitions so `when:`
  // predicates that read `isBridgeModuleEnabledStrict(...)` re-evaluate.
  // The selectors return references that change on `setLoaded` / `setError`.
  useBridgeModulesStore((s) => s.loadState);
  useBridgeModulesStore((s) => s.byName);

  const entries = all.filter((e) => safeWhen(e));

  return (
    <>
      {entries.map((entry, i) => {
        const C = entry.component;
        const open = !!entry.sectionId && openSection === entry.sectionId;
        const onToggle = entry.sectionId
          ? () => toggleSection(entry.sectionId!, entry.bodyId)
          : noop;
        return (
          <Fragment key={entry.id}>
            {i > 0 && <div className="hm-sep" />}
            <C open={open} onToggle={onToggle} />
          </Fragment>
        );
      })}
    </>
  );
}

function safeWhen(e: HeaderSection): boolean {
  if (!e.when) return true;
  try { return e.when() !== false; }
  catch (err) { console.warn(`[headerSections] when() of ${e.id} threw:`, err); return false; }
}

function noop() { /* sections without a sectionId don't toggle */ }
