// knowledge — frontend module.
//
// Owns the build-graph + synthesize cwd-action buttons and the
// KnowledgeButtons side-effect component (renders null but wires click
// handlers + button state). Disappears entirely when the bridge
// `knowledge` module is disabled.

import host from '../../host/index.js';
import { KnowledgeButtons } from '../../panels/KnowledgeButtons.js';

const MODULE_NAME = 'knowledge';

export default {
  activate() {
    // Two buttons share the Actions row with rclone/github. KnowledgeButtons
    // sets text + visibility on each via getElementById; the buttons start
    // visible and the wiring component immediately calls hidden=false to
    // finalize state on mount.
    host.registers.cwdActionButtons.add(
      {
        id: 'knowledge.build',
        order: 30,
        label: 'build graph',
        title: 'Rebuild knowledge graph',
        domId: 'btn-cwd-build',
      },
      MODULE_NAME,
    );
    host.registers.cwdActionButtons.add(
      {
        id: 'knowledge.synthesize',
        order: 40,
        label: 'synthesize',
        title: 'Generate knowledge synthesis',
        domId: 'btn-cwd-synthesize',
      },
      MODULE_NAME,
    );
    host.registers.panels.add(
      { id: 'knowledge.button-wiring', slotId: 'knowledge-wiring', component: KnowledgeButtons },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
