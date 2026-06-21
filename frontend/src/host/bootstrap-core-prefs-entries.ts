// Core `prefsEntries` seed — intentionally empty.
//
// Every "core" setting (layout, color theme, enter-to-send, header
// visibility/orientation) already has a hand-tuned widget in the prefs
// modal (see frontend/src/prefs/TabSystem.tsx) and a dedicated palette
// command (see bootstrap-core-commands.ts). Auto-rendering them through
// the slot duplicated UI and used a generic <select> that doesn't match
// our `.prefs-select` design.
//
// The register itself is still active — modules contribute their own
// per-setting widgets via `host.registers.prefsEntries.add(...)` from
// each module's `activate(host)`. The `<PrefsEntriesSlot>` returns null
// when no module has contributed, so nothing renders by default.

let registered = false;

export function registerCorePrefsEntries(): void {
  if (registered) return;
  registered = true;
}
