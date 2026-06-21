// SaveStatusBadge — tiny visual indicator that replaces explicit Save buttons
// in live-autosave forms. Shows "saving…", "✓ saved" (fades), or "⚠ error"
// based on a useLiveForm status.

import type { SaveStatus } from '../util/useLiveForm.js';

export function SaveStatusBadge({ status }: { status: SaveStatus }) {
  if (status === 'idle') return <span className="pers-status" />;
  const text = status === 'saving' ? '…' : status === 'saved' ? '✓ saved' : '⚠ error';
  const color = status === 'error' ? 'var(--danger, #ff5060)' : status === 'saved' ? 'var(--accent)' : 'var(--fg-dim)';
  return (
    <span className="pers-status" style={{ color }}>{text}</span>
  );
}
