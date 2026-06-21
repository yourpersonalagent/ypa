// ListWidget — vertical list of rows with primary/secondary/trailing slots,
// plus an optional leading "badge" (a colored initial bubble — handy for
// author/owner identity).
//
// Props:
//   • title?
//   • dataPath?        — dotted key whose value is an array; defaults to data
//   • itemTemplate     — { primary, secondary?, trailing?, leading? }
//                        Each slot is a mustache string evaluated against the
//                        row scope. `leading` is rendered inside a small
//                        circular badge whose color is hashed from the same
//                        string, so author "Alice" and "Bob" get stable
//                        distinct colors.
//   • onClick?         — RowAction; templated against the row scope
//   • emptyText?       — fallback when the array is missing/empty

import { getPath, renderTemplate } from './template.js';
import { isRowAction, runRowAction, type RowAction } from './actions.js';

export interface ListWidgetProps {
  title?: string;
  dataPath?: string;
  itemTemplate?: {
    primary?: string;
    secondary?: string;
    trailing?: string;
    leading?: string;
  };
  onClick?: RowAction;
  emptyText?: string;
}

// Deterministic hue from a string — used to color leading badges.
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}

function firstGrapheme(s: string): string {
  if (!s) return '?';
  const trimmed = s.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

export function ListWidget({ data, props }: { data: unknown; props: ListWidgetProps }) {
  const raw = props.dataPath ? getPath(data, props.dataPath) : data;
  const rows = Array.isArray(raw) ? raw : [];
  const t = props.itemTemplate || {};
  const action = isRowAction(props.onClick) ? props.onClick : null;

  return (
    <div className="pw-list">
      {props.title && <div className="pw-list-title">{props.title}</div>}
      {rows.length === 0 && (
        <div className="pw-list-empty">{props.emptyText || 'No items'}</div>
      )}
      <ul className="pw-list-rows">
        {rows.map((row, i) => {
          const primary = t.primary ? renderTemplate(t.primary, row) : '';
          const secondary = t.secondary ? renderTemplate(t.secondary, row) : '';
          const trailing = t.trailing ? renderTemplate(t.trailing, row) : '';
          const leadingText = t.leading ? renderTemplate(t.leading, row) : '';
          const hasLeading = !!leadingText;
          const clickable = !!action;
          const onClick = action ? () => runRowAction(action, row) : undefined;
          return (
            <li
              key={i}
              className={`pw-list-row${clickable ? ' is-clickable' : ''}${hasLeading ? ' has-leading' : ''}`}
              onClick={onClick}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
              } : undefined}
            >
              {hasLeading && (
                <span
                  className="pw-list-leading"
                  style={{ backgroundColor: `hsl(${hueFromString(leadingText)} 55% 38%)` }}
                  title={leadingText}
                  aria-hidden="true"
                >
                  {firstGrapheme(leadingText)}
                </span>
              )}
              <div className="pw-list-primary">{primary}</div>
              {secondary && <div className="pw-list-secondary">{secondary}</div>}
              {trailing && <div className="pw-list-trailing">{trailing}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
