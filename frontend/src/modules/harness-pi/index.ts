// harness-pi — frontend-only module owning the Pi harness type.
//
// FE-only: there is no `harness-pi` bridge module yet, so this
// activates unconditionally. Register an entry under that name in
// bridge/modules.json later if you want to gate it bridge-side.

import host from '../../host/index.js';

const MODULE_NAME = 'harness-pi';

export default {
  activate() {
    host.registers.harnessTypes.add(
      {
        id: 'harness-pi.type',
        order: 40,
        type: 'pi',
        label: 'Pi',
        category: 'single-account',
        binStorageKey: 'yha.piBin',
        configBinKey: 'piBin',
        authCmdTemplate: (bin) => `${bin || 'pi'} --help`,
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
