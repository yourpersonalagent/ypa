// SensitivityBadge — tiny visual marker for non-public context items.
// Phase 1a / Adaption 6 of the ContextGenerator pipeline.
//
// public  → renders nothing (cheap, no DOM noise on the common case)
// private → 🔒
// system  → ⚙️🔒
//
// Tooltip on hover is in English to match the rest of the UI (decision recorded
// in .ContextGenerator.MD §8).

import type { Tier } from './contextStore.js';

interface Props {
  tier:   Tier;
  className?: string;
}

const _LABELS: Record<Tier, { icon: string; label: string; tooltip: string }> = {
  public:  { icon: '',     label: 'Public',  tooltip: '' },
  private: { icon: '🔒',   label: 'Private', tooltip: 'Private — confirm before access' },
  system:  { icon: '⚙️🔒', label: 'System',  tooltip: 'System — credentials/config; confirm before access' },
};

export function SensitivityBadge({ tier, className }: Props) {
  if (tier === 'public') return null;
  const meta = _LABELS[tier];
  return (
    <span
      className={`sensitivity-badge sensitivity-${tier}${className ? ' ' + className : ''}`}
      title={meta.tooltip}
      aria-label={meta.label}
      // Inline minimal styling — projects' theme tokens take over via CSS class.
      style={{ marginRight: 6, fontSize: '0.85em', userSelect: 'none' }}
    >
      {meta.icon}
    </span>
  );
}
