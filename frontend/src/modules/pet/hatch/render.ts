// Mustache-style render engine for hatch prompt templates.
//
// Tiny on purpose — `{{slot}}` placeholders only, no conditionals, no
// loops. Each template lives as a tagged template literal in
// templates/*.ts; render() walks the input string, replaces `{{slot}}`
// occurrences, and lightly cleans whitespace.

export type TemplateSlots = Record<string, string | number | undefined | null>;

const SLOT_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** Replace {{slot}} occurrences. Missing slots become an empty string and
 *  are tracked in a separate array so callers can warn about typos. */
export function render(template: string, slots: TemplateSlots): string {
  const missing: string[] = [];
  const out = template.replace(SLOT_RE, (_, key) => {
    const v = slots[key];
    if (v == null || v === '') {
      missing.push(key);
      return '';
    }
    return String(v);
  });
  // Tidy double blank lines that arise when an empty slot collapses a line.
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Render with explicit reporting of missing slots. Useful for the modal's
 * "spec is incomplete" hint.
 */
export function renderWithReport(template: string, slots: TemplateSlots): {
  text: string;
  missing: string[];
} {
  const missing: string[] = [];
  const text = template.replace(SLOT_RE, (_, key) => {
    const v = slots[key];
    if (v == null || v === '') {
      if (!missing.includes(key)) missing.push(key);
      return '';
    }
    return String(v);
  });
  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim() + '\n',
    missing,
  };
}
