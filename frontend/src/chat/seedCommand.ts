// Tiny event-bus shim for "seed the chat composer with a command".
//
// Used by the `plugins-folder` `+` button to drive the chat input from
// outside the React tree — same prepend semantics as the existing
// `#chat-cmd` toolbar button (`ChatInput.tsx:openCommandPicker`):
//
//   • Empty composer → replace with `#skill-<name> ` (cursor at end).
//   • Composer already starts with `#` or `/` → leave it alone.
//   • Otherwise → prepend `#skill-<name> ` to the existing draft.
//
// The composer state lives inside ChatInput; instead of plumbing a context
// through every consumer that wants to seed it (and risking subtle
// re-render coupling), the producer dispatches a DOM event and ChatInput
// owns the apply-side. If no ChatInput is mounted (e.g. transient layout
// switch), the dispatch is a no-op — the click is graceful.

export const SEED_SKILL_EVENT = 'yha:seed-skill-command';

export interface SeedSkillDetail {
  /** Skill folder name (matches the `#skill-<name>` slug). */
  skill: string;
  /** Optional trailing arguments — appended after the slug so write-a-skill
   *  sees the typed new-skill name as its argument, etc. */
  args?: string;
}

export function seedSkillCommand(skill: string, args?: string): void {
  document.dispatchEvent(
    new CustomEvent<SeedSkillDetail>(SEED_SKILL_EVENT, { detail: { skill, args } }),
  );
}
