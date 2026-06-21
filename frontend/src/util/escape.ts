const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);
}

/** Identical to escHtml — provided as alias for call sites where the intent is attribute quoting. */
export const escAttr = escHtml;
