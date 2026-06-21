const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c] ?? c);
}

export function fmt$(n: number | null | undefined): string {
  return '$' + (n || 0).toFixed(5);
}
