// workflows-and-triggers — frontend module for the bridge module of the same
// name. Registers the workflow editor HUD buttons into the `hudButtons`
// register so they appear both in the editor canvas (via WorkflowHudSlot)
// and in the App Command Palette (auto-wrapped as `workflow.*` commands).

import host from '../../host/index.js';
import { workflow } from '../../workflows/workflow.js';
import { RecordToggle } from '../../RecordToggle.js';
import { WorkflowHudButton } from './WorkflowHudButton.js';
import { TriggersHudButton } from './TriggersHudButton.js';
import { BindSessionHudButton } from './BindSessionHudButton.js';

const MODULE_NAME = 'workflows-and-triggers';

export default {
  activate() {
    // ── Group 1: workflow management ────────────────────────────────────────
    host.registers.hudButtons.add({
      id: 'wf-hud-picker',
      label: 'Workflow Picker',
      title: 'Workflows',
      domId: 'btn-workflows',
      hudGroup: 'workflow',
      component: WorkflowHudButton,
      keywords: ['workflow', 'load', 'save', 'picker', 'select'],
      order: 10,
    }, MODULE_NAME);

    host.registers.hudButtons.add({
      id: 'wf-hud-triggers',
      label: 'Triggers',
      title: 'Triggers',
      domId: 'btn-triggers',
      hudGroup: 'workflow',
      component: TriggersHudButton,
      keywords: ['triggers', 'automation', 'schedule', 'stopwatch'],
      order: 20,
    }, MODULE_NAME);

    host.registers.hudButtons.add({
      id: 'wf-hud-bind',
      label: 'Bind to Session',
      title: 'Bind to session',
      domId: 'btn-bind-session',
      hudGroup: 'workflow',
      component: BindSessionHudButton,
      keywords: ['bind', 'session', 'link', 'attach'],
      order: 30,
    }, MODULE_NAME);

    // ── Group 2: run controls ───────────────────────────────────────────────
    host.registers.hudButtons.add({
      id: 'wf-hud-run',
      label: 'Run Workflow',
      title: 'Run workflow',
      domId: 'btn-run',
      hudGroup: 'run',
      icon: '▶',
      className: 'hud-run',
      onClick: () => workflow.run(),
      keywords: ['run', 'execute', 'play', 'start'],
      order: 40,
    }, MODULE_NAME);

    host.registers.hudButtons.add({
      id: 'wf-hud-record',
      label: 'Record Toggle',
      hudGroup: 'run',
      component: RecordToggle,
      keywords: ['record', 'recording', 'mic'],
      order: 50,
    }, MODULE_NAME);

    // ── Group 3: view controls ──────────────────────────────────────────────
    host.registers.hudButtons.add({
      id: 'wf-hud-zoom-in',
      label: 'Zoom In',
      title: 'Zoom in',
      domId: 'hud-zoom-in',
      hudGroup: 'view',
      icon: '+',
      keywords: ['zoom', 'in', 'larger', 'magnify'],
      order: 60,
    }, MODULE_NAME);

    host.registers.hudButtons.add({
      id: 'wf-hud-zoom-out',
      label: 'Zoom Out',
      title: 'Zoom out',
      domId: 'hud-zoom-out',
      hudGroup: 'view',
      icon: '−',
      keywords: ['zoom', 'out', 'smaller'],
      order: 70,
    }, MODULE_NAME);

    host.registers.hudButtons.add({
      id: 'wf-hud-fit',
      label: 'Fit Graph to View',
      title: 'Fit graph to view',
      domId: 'hud-fit',
      hudGroup: 'view',
      icon: '⤢',
      keywords: ['fit', 'view', 'reset', 'graph', 'center'],
      order: 80,
    }, MODULE_NAME);

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
