// PluginsHeaderSection — header section for the `plugins-folder` module.
// Registered into `headerSections` at order:20 with `sectionId: 'hs-plugins'`,
// so it participates in the mutually-exclusive group alongside cwd /
// personnel / partner / global-context. The shared `.hs-section / .hs-toggle
// / .hs-body` CSS (frontend/css/layout/pet-panel.css) supplies the rotating
// `▾` triangle, max-height animation, and chrome — so the dropdown matches
// the rest of the header surface visually.
//
// Visual states:
//   • No CWD → render nothing.
//   With a CWD set:
//   • Manifest has zero plugins → `+` toggle button. Clicking it seeds the
//     `#skill-cwd-plugin-creator ` composer command — direct entry into the
//     plugin-creator skill flow.
//   • Manifest has plugins → toggle button shows a live `HeaderQuickInfo`
//     readout (the first tile with `headline.from` set), replacing the `+`.
//     Clicking still toggles the section panel open/closed.
//
// Open/closed state is owned by the parent (`HeaderSectionsSlot` via
// FullLayout's `useSections`) and passed through `open` / `onToggle` props.
// The store's `dropdownOpen` field is repurposed here as a one-shot
// "request open" signal — `openTile()` (app-command-palette entry point in
// `index.ts`) flips it to `true` to ask this section to open. We consume
// the flag, fire `onToggle` if currently closed, then reset so subsequent
// user clicks stay in charge.

import { useEffect } from 'react';
import type { HeaderSectionProps } from '../../../host/keys.js';
import { usePluginsStore } from '../store/pluginsStore.js';
import { PluginsDropdown } from './PluginsDropdown.js';
import { HeaderQuickInfo } from './HeaderQuickInfo.js';
import { seedSkillCommand } from '../../../chat/seedCommand.js';

const CREATOR_SKILL = 'cwd-plugin-creator';

export function PluginsHeaderSection({ open, onToggle }: HeaderSectionProps) {
  const cwd = usePluginsStore((s) => s.cwd);
  const manifest = usePluginsStore((s) => s.manifest);
  const activations = usePluginsStore((s) => s.activations);
  const pendingOpen = usePluginsStore((s) => s.dropdownOpen);
  const setPendingOpen = usePluginsStore((s) => s.setDropdownOpen);

  useEffect(() => {
    if (!pendingOpen) return;
    if (!open) onToggle();
    setPendingOpen(false);
  }, [pendingOpen, open, onToggle, setPendingOpen]);

  if (!cwd) return null;

  const pluginCount = manifest?.plugins.length ?? 0;
  const activeCount = (activations[cwd] || []).length;
  const hasPlugins = pluginCount > 0 && !!manifest;

  function onClick() {
    if (!hasPlugins) {
      seedSkillCommand(CREATOR_SKILL);
      return;
    }
    onToggle();
  }

  const title = !hasPlugins
    ? 'Create a new plugin for this working directory'
    : activeCount === 0
      ? `${pluginCount} plugin${pluginCount === 1 ? '' : 's'} available — click to activate`
      : `${activeCount} of ${pluginCount} plugin${pluginCount === 1 ? '' : 's'} active`;

  return (
    <div className={`hs-section hs-section-wide${open ? ' hs-open' : ''}`} id="hs-plugins">
      <button
        className={`hm-item hs-toggle${open ? ' hs-open' : ''}${hasPlugins ? ' has-quickinfo' : ''}`}
        id="btn-plugins"
        title={title}
        onClick={onClick}
      >
        {!hasPlugins && (
          <span className="hm-icon" aria-hidden="true">
            <svg
              width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
        )}
        {hasPlugins && (
          <>
            <span className="hm-icon" aria-hidden="true">
              <svg
                width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
              </svg>
            </span>
            <HeaderQuickInfo
              cwd={cwd}
              manifest={manifest}
              activeCount={activeCount}
              pluginCount={pluginCount}
            />
          </>
        )}
      </button>
      <div className={`hs-body${open ? ' hs-open' : ''}`} id="plugins-panel">
        <PluginsDropdown />
      </div>
    </div>
  );
}
