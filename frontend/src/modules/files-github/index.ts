// files-github — frontend module.
//
// Owns the github cwd-action button + GithubModal. Disappears entirely when
// the bridge `files-github` module is disabled.

import { lazy } from 'react';
import host from '../../host/index.js';

const GithubModal = lazy(() => import('../../panels/GithubModal.js').then(m => ({ default: m.GithubModal })));

const MODULE_NAME = 'files-github';

export default {
  activate() {
    // GithubModal toggles the button hidden/visible based on whether the
    // current cwd is a git repo, via getElementById('btn-cwd-github').
    // onClick dispatches a document event rather than relying on the modal
    // to addEventListener on this node — the button is recreated on every
    // layout switch, so React must re-own the binding here.
    host.registers.cwdActionButtons.add(
      {
        id: 'files-github.cwd-action',
        order: 20,
        label: 'github',
        title: 'GitHub',
        domId: 'btn-cwd-github',
        onClick: () => document.dispatchEvent(new Event('github:open')),
      },
      MODULE_NAME,
    );
    host.registers.panels.add(
      { id: 'files-github.modal', slotId: 'files-github-modal', component: GithubModal },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
