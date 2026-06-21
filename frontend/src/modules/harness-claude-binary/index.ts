// harness-claude-binary — frontend module owning the Claude Code harness type.
//
// Registers the 'claude' entry into the `harnessTypes` register so the
// Harness prefs tab shows the Claude toggle, the Claude-runtime config
// sections (runtime / API model path / commands), and the standard
// subscription instances list. When the bridge module
// `harness-claude-binary` is disabled in modules.json, this FE module
// is skipped at boot and the Claude UI disappears.

import host from '../../host/index.js';
import { ClaudeConfigSection } from './ClaudeConfigSection.js';

const MODULE_NAME = 'harness-claude-binary';

export default {
  activate() {
    host.registers.harnessTypes.add(
      {
        id: 'harness-claude-binary.type',
        order: 10,
        type: 'claude',
        label: 'Claude Code',
        category: 'subscription',
        binStorageKey: 'yha.claudeBin',
        configBinKey: 'claudeBin',
        authCmdTemplate: (bin, home, dir, platform) => {
          const b = bin || 'claude';
          const sh = (s: string) => `'${String(s).replace(/'/g, `'"'"'`)}'`;
          const ps = (s: string) => `'${String(s).replace(/'/g, `''`)}'`;
          if (platform === 'win32') {
            // PowerShell: bash-style `KEY=val cmd` is a parse error. Use
            // $env: assignments + call operator (&), all on one line so
            // copy-paste runs as a single command. Remove ANTHROPIC_API_KEY
            // so login/status tests the subscription OAuth state that YPA's
            // SUB route uses; the runtime deliberately strips API keys for
            // subscription turns.
            return `$env:HOME=${ps(home)}; $env:CLAUDE_CONFIG_DIR=${ps(dir)}; Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; & ${ps(b)} auth login --claudeai`;
          }
          // macOS Claude Code stores OAuth secrets in the login Keychain by
          // default. If YPA/PM2 or a copied command runs while the keychain is
          // locked, login can appear to finish but no readable OAuth token is
          // saved; YPA then gets "Not logged in · Please run /login". Unlock
          // first (no-op when already unlocked), then print the exact auth
          // status YPA will use.
          if (platform === 'darwin') {
            return `security unlock-keychain ~/Library/Keychains/login.keychain-db; env -u ANTHROPIC_API_KEY HOME=${sh(home)} CLAUDE_CONFIG_DIR=${sh(dir)} ${sh(b)} auth login --claudeai; env -u ANTHROPIC_API_KEY HOME=${sh(home)} CLAUDE_CONFIG_DIR=${sh(dir)} ${sh(b)} auth status`;
          }
          return `env -u ANTHROPIC_API_KEY HOME=${sh(home)} CLAUDE_CONFIG_DIR=${sh(dir)} ${sh(b)} auth login --claudeai; env -u ANTHROPIC_API_KEY HOME=${sh(home)} CLAUDE_CONFIG_DIR=${sh(dir)} ${sh(b)} auth status`;
        },
        configSection: ClaudeConfigSection,
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
