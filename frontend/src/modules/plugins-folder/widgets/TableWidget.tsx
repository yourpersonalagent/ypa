// TableWidget — compact table with explicit column defs.
//
// Props:
//   • title?
//   • dataPath?        — dotted key whose value is an array; defaults to data
//   • columns          — [{ header, valuePath | template, align?, bar? }]
//   • onClick?         — RowAction; templated against the row scope
//   • emptyText?
//
// Each column resolves either via `valuePath` (raw value, displayed
// stringified) or `template` (mustache against the row scope). Use
// `template` when the cell needs concatenation/formatting.
//
// `bar: { valuePath, max? }` overlays a horizontal proportional bar inside
// the cell — width = value / (max || max-in-dataset). Combine with `template`
// or `valuePath` to keep the numeric label alongside the bar.

import { getPath, renderTemplate, toDisplay } from './template.js';
import { isRowAction, runRowAction, type RowAction } from './actions.js';

export interface TableColumn {
  header: string;
  valuePath?: string;
  template?: string;
  align?: 'left' | 'right' | 'center';
  bar?: {
    valuePath: string;
    /** Static max — if omitted, the dataset max is used. */
    max?: number;
  };
}

export interface TableWidgetProps {
  title?: string;
  dataPath?: string;
  columns?: TableColumn[];
  onClick?: RowAction;
  emptyText?: string;
}

function cellText(col: TableColumn, row: unknown): string {
  if (col.template) return renderTemplate(col.template, row);
  if (col.valuePath) return toDisplay(getPath(row, col.valuePath));
  return '';
}

function numericFromPath(row: unknown, path: string): number {
  const v = getPath(row, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function TableWidget({ data, props }: { data: unknown; props: TableWidgetProps }) {
  const raw = props.dataPath ? getPath(data, props.dataPath) : data;
  const rows = Array.isArray(raw) ? raw : [];
  const cols = Array.isArray(props.columns) ? props.columns.filter((c) => c?.header) : [];
  const action = isRowAction(props.onClick) ? props.onClick : null;

  // Precompute per-column max for `bar` columns whose max isn't fixed.
  const colMaxes = cols.map((c) => {
    if (!c.bar) return 0;
    if (typeof c.bar.max === 'number' && c.bar.max > 0) return c.bar.max;
    let m = 0;
    for (const r of rows) {
      const v = numericFromPath(r, c.bar.valuePath);
      if (v > m) m = v;
    }
    return m;
  });

  return (
    <div className="pw-table">
      {props.title && <div className="pw-table-title">{props.title}</div>}
      {rows.length === 0 && (
        <div className="pw-table-empty">{props.emptyText || 'No rows'}</div>
      )}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} style={{ textAlign: c.align || 'left' }}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => {
              const clickable = !!action;
              const onClick = action ? () => runRowAction(action, row) : undefined;
              return (
                <tr
                  key={ri}
                  className={clickable ? 'is-clickable' : undefined}
                  onClick={onClick}
                >
                  {cols.map((c, ci) => {
                    const text = cellText(c, row);
                    const align = c.align || 'left';
                    if (c.bar) {
                      const max = colMaxes[ci] || 1;
                      const v = numericFromPath(row, c.bar.valuePath);
                      const pct = Math.max(0, Math.min(100, (v / max) * 100));
                      return (
                        <td key={ci} className="pw-table-bar-cell" style={{ textAlign: align }}>
                          <span className="pw-table-bar" aria-hidden="true">
                            <span className="pw-table-bar-fill" style={{ width: `${pct.toFixed(1)}%` }} />
                          </span>
                          <span className="pw-table-bar-label">{text}</span>
                        </td>
                      );
                    }
                    return (
                      <td key={ci} style={{ textAlign: align }}>{text}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
