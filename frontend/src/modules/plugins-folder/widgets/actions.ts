// Declarative onClick actions for widget rows.
//
// Widgets accept an `onClick` action object in their props. Two safe shapes
// are supported in v1:
//   • `{ type: 'openUrl', href: '{{templated.url}}' }`     — opens in a new tab
//   • `{ type: 'command', name: 'group.id' }`             — runs an app command
// Templated strings (mustache) are resolved against the row's scope.

import { renderTemplate } from './template.js';
import { registers, type AppCommand } from '../../../host/keys.js';

export type RowAction =
  | { type: 'openUrl'; href: string }
  | { type: 'command'; name: string };

export function isRowAction(v: unknown): v is RowAction {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  if (a.type === 'openUrl' && typeof a.href === 'string') return true;
  if (a.type === 'command' && typeof a.name === 'string') return true;
  return false;
}

export function runRowAction(action: RowAction, scope: unknown): void {
  if (action.type === 'openUrl') {
    const href = renderTemplate(action.href, scope);
    if (!href) return;
    // noopener/noreferrer — declarative widgets are host-trusted, but the
    // target URL was authored by the plugin and we don't want it crossing
    // window.opener to YHA.
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  if (action.type === 'command') {
    const list = registers.appCommands.list() as unknown as AppCommand[];
    const cmd = list.find((c) => c.id === action.name);
    if (!cmd) return;
    cmd.run({ closePalette: () => {} });
  }
}
