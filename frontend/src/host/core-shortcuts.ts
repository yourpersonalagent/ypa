// Discoverability metadata for core shortcuts whose handlers still live in
// KeyboardShortcuts.tsx. Module shortcuts are already dynamic through the
// hotkeys register. Keep this list next to the host runtime so both the
// shortcuts modal and the frontend-agent manifest consume one source.

export interface CoreShortcutHint {
  keys: string;
  description: string;
}

export interface CoreShortcutGroup {
  group: string;
  items: CoreShortcutHint[];
}

export const CORE_SHORTCUT_GROUPS: ReadonlyArray<CoreShortcutGroup> = [
  {
    group: 'Color theme',
    items: [
      { keys: 'Alt + T', description: 'Tap: toggle dark / bright variant' },
      { keys: 'Alt + T (hold)', description: 'Cycle color theme family forward' },
      { keys: 'Alt + Shift + T (hold)', description: 'Cycle color theme family backward' },
    ],
  },
  {
    group: 'Layout',
    items: [
      { keys: 'Alt + H', description: 'Tap: toggle header / menu bar — hold: swap vertical ↔ horizontal bar' },
      { keys: 'Alt + C', description: 'Chat-only view (focuses the input)' },
      { keys: 'Alt + G', description: 'Workflow / graph-only view (switches to full layout if needed)' },
      { keys: 'Alt + X', description: 'Tap: split view / flip H ↔ V — hold: swap chat ↔ workflow sides' },
    ],
  },
  {
    group: 'Chat',
    items: [
      { keys: 'Ctrl + P / ⌘K', description: 'Open the command palette' },
      { keys: 'Alt + N', description: 'Tap: start a new chat — hold: new chat in the same working directory' },
      { keys: 'Alt + S', description: 'Open the session picker' },
      { keys: 'Alt + M', description: 'Open the model picker' },
      { keys: 'Ctrl + Alt + M', description: 'Tap: next composer mode — hold: auto-cycle slowly' },
      { keys: 'Alt + V', description: 'Toggle voice assistant' },
      { keys: 'Alt + B', description: 'Start the remote desktop browser' },
      { keys: 'Alt + F', description: 'Open the file picker' },
      { keys: 'Ctrl + Shift + F', description: 'Open the File Manager' },
      { keys: 'Alt + Shift + P', description: 'Open the shared YPA terminal' },
      { keys: 'Alt + 1 … 5', description: 'Switch working directory to the n-th recent folder' },
      { keys: 'Enter', description: 'Send message' },
      { keys: 'Shift + Enter', description: 'New line in message' },
    ],
  },
  {
    group: 'Navigation',
    items: [
      { keys: 'Alt + ←', description: 'Browser back — previous chat session' },
      { keys: 'Alt + →', description: 'Browser forward — next chat session' },
    ],
  },
  {
    group: 'Session picker (when open)',
    items: [
      { keys: '↑ / ↓', description: 'Move focus through the session list' },
      { keys: 'Enter / Space / →', description: 'Switch to the focused session' },
    ],
  },
  {
    group: 'Misc',
    items: [
      { keys: 'Alt + K', description: 'Show this cheat sheet' },
      { keys: 'Alt + P', description: 'Open Preferences' },
      { keys: 'Alt + Shift + C', description: 'Open the Context Generator hub' },
      { keys: 'Esc', description: 'Close any open overlay / modal / picker' },
    ],
  },
];
