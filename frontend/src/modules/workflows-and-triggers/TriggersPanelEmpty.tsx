// TriggersPanelEmpty — portal hosts for the left-sidebar Triggers
// section. Provides the two DOM ids that
// `frontend/src/panels/TriggersPanel.tsx` portals React content into.
//
// History: this file used to render a static "No triggers yet" empty
// state + "+ New Trigger" button. TriggersPanel.tsx tried to wipe that
// content via replaceChildren() on mount, but React kept re-rendering
// it, so the empty-state ended up visible IN FRONT OF the functional
// portal'd ListPane (which renders the same controls). End result: a
// non-functional duplicate "+ New Trigger" button sitting on top of
// the real one. Solution: render only the empty container hosts here
// and let TriggersPanel.tsx own all the inner content. Disabling the
// bridge module still drops the panes entirely because Shell.tsx
// gates the whole section on wfEnabled.

export function TriggersListPaneHost() {
  return <div className="trigger-list-pane" id="trigger-list-pane" />;
}

export function TriggersFormPaneHost() {
  return <div className="trigger-form-pane" id="trigger-form-pane" />;
}
