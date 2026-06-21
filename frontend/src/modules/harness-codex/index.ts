// harness-codex — frontend module owning the Codex harness type.
//
// Registers the 'codex' entry into the `harnessTypes` register so the
// Harness prefs tab shows the Codex toggle, the Codex-exec-mode config
// section, and the standard subscription instances list. When the
// bridge module `harness-codex` is disabled in modules.json, this FE
// module is skipped at boot and the Codex UI disappears.

import host from '../../host/index.js';
import { CodexConfigSection } from './CodexConfigSection.js';

const MODULE_NAME = 'harness-codex';

export default {
  activate() {
    host.registers.harnessTypes.add(
      {
        id: 'harness-codex.type',
        order: 20,
        type: 'codex',
        label: 'Codex',
        category: 'subscription',
        binStorageKey: 'yha.codexBin',
        configBinKey: 'codexBin',
        authCmdTemplate: (bin, home, dir, platform) => {
          const b = bin || 'codex';
          if (platform === 'win32') {
            return `$env:HOME='${home}'; $env:CODEX_HOME='${dir}'; & '${b}' login`;
          }
          return `HOME=${home} CODEX_HOME=${dir} ${b} login`;
        },
        configSection: CodexConfigSection,
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
