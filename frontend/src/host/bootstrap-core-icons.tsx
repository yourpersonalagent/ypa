// Register the core (non-module) header icon buttons.
//
// These were inline JSX in Shell.tsx:200-279 before the
// headerIconButtons-register migration. They live in core because at
// least one of each category is load-bearing (color-theme, prefs,
// user-info-logout). When a module like `pet` or `files-manager` is
// later extracted, the corresponding entry below moves into that
// module's `activate(host)` and the remaining ones stay here.
//
// Called once from `App.tsx` (or `main-react.tsx`) before mount.

import { registers } from './keys.js';
import { ColorThemeButton } from '../ColorThemeButton.js';
import { BashConsoleHeaderButton } from '../components/BashConsoleHeaderButton.js';
import { UserInfoHeaderButton } from '../components/UserInfoHeaderButton.js';
import { prefs } from '../preferences.js';

let registered = false;

export function registerCoreHeaderIconButtons() {
  if (registered) return;
  registered = true;

  // ── primary row-pair ────────────────────────────────────────────────────
  registers.headerIconButtons.add({
    id: 'core.color-theme',
    group: 'primary',
    order: 10,
    component: ColorThemeButton,
    core: true,
  }, '<core>');

  registers.headerIconButtons.add({
    id: 'core.bash-console',
    group: 'primary',
    order: 20,
    domId: 'btn-bash-console',
    title: 'Shared YPA terminal [Alt+Shift+P]',
    component: BashConsoleHeaderButton,
    core: true,
  }, '<core>');

  // file-manager → owned by `files-manager` module (frontend/src/modules/files-manager/index.ts)
  // remote-browser → owned by `remote-browser` module (frontend/src/modules/remote-browser/index.ts)

  registers.headerIconButtons.add({
    id: 'core.prefs',
    group: 'primary',
    order: 50,
    domId: 'btn-prefs',
    title: 'Preferences & settings [Alt+P]',
    icon: (
      <svg
        width="14" height="14" viewBox="0 0 24 24"
        fill="none" stroke="currentColor"
        strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
    onClick: () => prefs.open(),
    core: true,
  }, '<core>');

  // ── secondary row-pair ──────────────────────────────────────────────────
  // context-gen (order 10) → owned by `context-generator` module
  // (frontend/src/modules/context-generator/index.ts)

  // The pet header icon (order 20) is owned by the `pet` module —
  // see `frontend/src/modules/pet/index.ts:activate()`. With the
  // pet module disabled the button disappears from the secondary row.

  registers.headerIconButtons.add({
    id: 'core.user-info',
    group: 'secondary',
    order: 30,
    component: UserInfoHeaderButton,
    core: true,
  }, '<core>');
}
