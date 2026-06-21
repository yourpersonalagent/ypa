// KvWidget — two-column key/value list.
//
// Props:
//   • title?           — small heading above the table
//   • dataPath?        — dotted key into the data; defaults to whole data
//   • pairs?           — explicit `[{ key, valuePath }]` for ordered/curated lists
//
// Behavior:
//   • If `pairs` is supplied, render each in order; values are looked up
//     against `dataPath`-resolved scope.
//   • If `pairs` is absent, take all string/number entries of the
//     `dataPath`-resolved object as-is. Nested objects are JSON-stringified.

import { getPath, toDisplay } from './template.js';

export interface KvPair { key: string; valuePath: string; }
export interface KvWidgetProps {
  title?: string;
  dataPath?: string;
  pairs?: KvPair[];
}

export function KvWidget({ data, props }: { data: unknown; props: KvWidgetProps }) {
  const scope = props.dataPath ? getPath(data, props.dataPath) : data;
  const rows: Array<[string, string]> = [];

  if (Array.isArray(props.pairs) && props.pairs.length > 0) {
    for (const pair of props.pairs) {
      if (!pair?.key || !pair?.valuePath) continue;
      rows.push([pair.key, toDisplay(getPath(scope, pair.valuePath))]);
    }
  } else if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    for (const [k, v] of Object.entries(scope as Record<string, unknown>)) {
      rows.push([k, toDisplay(v)]);
    }
  }

  return (
    <div className="pw-kv">
      {props.title && <div className="pw-kv-title">{props.title}</div>}
      <dl className="pw-kv-list">
        {rows.map(([k, v]) => (
          <div className="pw-kv-row" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {rows.length === 0 && <div className="pw-kv-empty">No data</div>}
      </dl>
    </div>
  );
}
