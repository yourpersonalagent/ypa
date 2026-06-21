// multichat-partners — frontend module owning the partner agent surface.
//
// Owns:
//  - The `partner` header section (button + dropdown body) — registered into
//    `headerSections` so the slot and the messenger/zen drawer pick it up.
//  - The "Employees & Partners" prefs tab.
//
// activate() runs only when the bridge `multichat-partners` module is enabled
// in bridge/modules.json (gated by BRIDGE_LINKED in enabled-modules.ts), so
// the section disappears in lockstep with the bridge half — no separate
// `when:` predicate needed.

import host from '../../host/index.js';
import type { HeaderSectionProps } from '../../host/keys.js';
import { TabPartners } from '../../prefs/TabPartners.js';
import { PartnerPanel } from '../../panels/PartnerPanel.js';

const MODULE_NAME = 'multichat-partners';

function PartnerSection({ open, onToggle }: HeaderSectionProps) {
  return <PartnerPanel open={open} onToggle={onToggle} />;
}

export default {
  activate() {
    host.registers.headerSections.add(
      {
        id: 'multichat-partners.section',
        sectionId: 'hs-partner',
        bodyId: 'partner-panel',
        order: 40,
        component: PartnerSection,
        panelLabel: 'Partner',
        panelKeywords: ['partner', 'agents', 'hermes', 'multichat'],
      },
      MODULE_NAME,
    );
    host.registers.prefsTabs.add(
      {
        id: 'partners',
        group: 'capabilities',
        order: 50,
        label: 'Employees & Partners',
        simpleMode: null,
        component: TabPartners,
        icon: '👥',
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
