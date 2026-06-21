// Built-in widget registry.
//
// Adding a new template (markdown, sparkline, stack, …) is two lines:
// implement the component, then add it to `WIDGETS`. The renderer dispatches
// on the manifest's `template` field; unknown templates render a fallback
// "missing widget" placeholder so the user can see what went wrong.

import type { ComponentType } from 'react';
import { HeadlineWidget } from './HeadlineWidget.js';
import { KvWidget } from './KvWidget.js';
import { ListWidget } from './ListWidget.js';
import { TableWidget } from './TableWidget.js';

export interface WidgetProps {
  data: unknown;
  props: Record<string, unknown>;
}

export const WIDGETS: Record<string, ComponentType<WidgetProps>> = {
  headline: HeadlineWidget as ComponentType<WidgetProps>,
  kv: KvWidget as ComponentType<WidgetProps>,
  list: ListWidget as ComponentType<WidgetProps>,
  table: TableWidget as ComponentType<WidgetProps>,
};

export function getWidget(name: string | undefined): ComponentType<WidgetProps> | null {
  if (!name) return null;
  return WIDGETS[name] || null;
}
