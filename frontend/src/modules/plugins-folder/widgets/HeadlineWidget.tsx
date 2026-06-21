// HeadlineWidget — big number/label + optional trend arrow.
//
// Props:
//   • title?           — small label above the value
//   • valuePath        — dotted key into the data object
//   • labelPath?       — dotted key for the unit/suffix shown next to the value
//   • trendPath?       — dotted key for a number; positive → ▲, negative → ▼
//   • placeholder?     — shown when the value resolves to null/undefined
//
// Inline-friendly (≤ 80 px) — also reused inside the header rotator (cut 5).

import { getPath, toDisplay } from './template.js';

export interface HeadlineWidgetProps {
  title?: string;
  valuePath?: string;
  labelPath?: string;
  trendPath?: string;
  placeholder?: string;
}

export function HeadlineWidget({ data, props }: { data: unknown; props: HeadlineWidgetProps }) {
  const value = props.valuePath ? getPath(data, props.valuePath) : data;
  const label = props.labelPath ? toDisplay(getPath(data, props.labelPath)) : '';
  const trendRaw = props.trendPath ? getPath(data, props.trendPath) : null;
  const trend = typeof trendRaw === 'number' ? trendRaw : null;
  const valStr = value == null ? (props.placeholder || '—') : toDisplay(value);

  return (
    <div className="pw-headline">
      {props.title && <div className="pw-headline-title">{props.title}</div>}
      <div className="pw-headline-row">
        <span className="pw-headline-value">{valStr}</span>
        {label && <span className="pw-headline-label">{label}</span>}
        {trend != null && (
          <span className={`pw-headline-trend ${trend > 0 ? 'is-up' : trend < 0 ? 'is-down' : 'is-flat'}`}>
            {trend > 0 ? '▲' : trend < 0 ? '▼' : '·'}
          </span>
        )}
      </div>
    </div>
  );
}
