# Frontend for Agents

YPA exposes a browser-local automation API at `window.__ypa_agent` and a
bridge-native `Frontend` tool that routes requests to the visible tab of the
active chat session. Together they form an intentional command and inspection
layer: agents should use it instead of guessing coordinates, simulating mouse
movement, or depending on visual CSS.

The important boundary is: **Frontend controls the YPA app the user already
has open. It never launches YPA in a second remote-browser window.** Remote
browser automation remains useful only for external QA and screenshots.

## Quick use

```js
window.__ypa_agent.listCommands()
window.__ypa_agent.runCommand('prefs.open.models')
window.__ypa_agent.openTerminal()
window.__ypa_agent.getState()
window.__ypa_agent.listSurfaces()
window.__ypa_agent.listManifest()
```

From a YPA chat agent, use the `Frontend` tool:

```json
{ "action": "list_commands" }
{ "action": "run_command", "command_id": "prefs.open.models" }
{ "action": "open_terminal" }
{ "action": "get_state" }
```

The visible tab keeps a dedicated session-scoped control SSE open at
`/v1/sessions/:id/frontend-agent-events`. Tool requests travel over that
channel, run against the live registers, and return to the same model tool
call through `/v1/sessions/:id/frontend-agent-response`. This control path is
independent of the model-output stream, so it works whether Go or Node owns a
turn and while the chat is idle. Hidden duplicate tabs do not execute
requests. Requests time out cleanly when no visible app tab is attached.

The API is installed before React mounts and emits `ypa:agent-ready`. Its
`apiVersion` is currently `1`. Every list/manifest call takes a fresh snapshot;
commands and register entries added later by hot-loaded modules appear without
reinstalling the API or maintaining a second catalog.

The command palette action **Download Frontend Agent Manifest** exports the
same live manifest as JSON.

## Dynamic discovery

`frontend/src/host/app-command-runtime.ts` is the single command runtime used
by both the palette and agent API. It combines:

- explicit `registers.appCommands` entries;
- header icon buttons;
- header sections that expose a panel label;
- workflow HUD buttons;
- preferences tabs;
- preferences entries that did not opt out with `paletteCommand: false`.

Do not rebuild that list in another component. Use `snapshotAppCommands()`,
`findAppCommand()` or `runAppCommandById()`.

## Adding a feature

### An action

Register a stable semantic command in `registers.appCommands`:

```ts
host.registers.appCommands.add({
  id: 'module.example.open',
  group: 'module:example',
  label: 'Open Example',
  keywords: ['example'],
  run: ({ closePalette }) => {
    window.dispatchEvent(new CustomEvent('yha:open-example'));
    closePalette();
  },
}, 'example');
```

Use dotted, stable IDs. Commands must perform the real action directly. A DOM
click is only a compatibility fallback for old header controls.

### A visible modal, picker, panel, overlay or window

Register it while the component is mounted and keep its open state current:

```ts
const controller = host.agentSurfaces.register({
  id: 'example-window',
  label: 'Example window',
  kind: 'window',
  module: 'example',
  openCommand: 'module.example.open',
  close: () => setOpen(false),
});

controller.setOpen(open);
// controller.dispose() on unmount
```

This makes state readable through `listSurfaces()` and `getState()` without
DOM inspection. IDs must be stable and globally unique.

### Preferences and module UI

Prefer existing registers. New prefs tabs, prefs entries, module hotkeys,
header buttons, panels and app commands are reflected in the manifest
automatically. A new register belongs in `host/keys.ts` only if no existing
register expresses the capability.

### Core keyboard shortcuts

Module shortcuts are dynamic through `registers.hotkeys`. Core shortcuts still
have specialized handlers in `KeyboardShortcuts.tsx`; add their discoverability
metadata to `host/core-shortcuts.ts`. The shortcuts modal and agent manifest
both consume that one metadata source.

## Shared terminal

- Command: `terminal.open`
- Close command: `terminal.close`
- Hotkey: `Alt+Shift+P`
- Surface ID: `shared-terminal`
- Existing backend: `/v1/bash-console/history` and `/v1/bash-console/run`

The terminal is the same persistent shell surface visible to users and used by
model tooling. Agents should still prefer purpose-built commands/APIs when one
exists; use the terminal when shared command visibility is valuable.

## In-app agent workflow

1. Call `Frontend({ action: "list_commands" })` when the command id is not
   already known.
2. Call `run_command`, `open_terminal`, `focus_surface`, or `close_surface`.
3. Verify with `get_state` or `list_surfaces`.
4. Explain the visible change to the user when useful.

Because discovery reads the same live registers as the command palette, new
module features become available without adding another backend tool schema.
Feature authors only need to register semantic commands/surfaces as described
above.

## External browser QA workflow

1. Wait for `window.__ypa_agent` or the `ypa:agent-ready` event.
2. Inspect `listManifest()` or `listCommands()`.
3. Execute a stable command ID.
4. Wait until `listSurfaces()` reports the expected state.
5. Use browser automation only to inspect pixels, verify layout, or capture a
   screenshot—not to discover how to operate the feature.

## Security boundary

Execution remains browser-local and acts with the identity of the already
authenticated tab. The bridge route only completes a pending, unguessable
request for the same session; it is not a general remote-control endpoint.
Hidden tabs and tabs showing another session ignore the request. This surface
does not expose the privileged `tuid` socket or replace the operator API.
