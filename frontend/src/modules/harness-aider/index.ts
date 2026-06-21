// harness-aider — frontend-only module owning the Aider harness type.
//
// FE-only: there is no `harness-aider` bridge module yet, so this
// activates unconditionally. Register an entry under that name in
// bridge/modules.json later if you want to gate it bridge-side.

import host from '../../host/index.js';

const MODULE_NAME = 'harness-aider';

export default {
  activate() {
    host.registers.harnessTypes.add(
      {
        id: 'harness-aider.type',
        order: 30,
        type: 'aider',
        label: 'Aider',
        category: 'single-account',
        binStorageKey: 'yha.aiderBin',
        configBinKey: 'aiderBin',
        authCmdTemplate: (bin) =>
          `${bin || 'aider'} --help    # Aider uses API keys from the API Keys tab`,
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
