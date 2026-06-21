// CategoryTabs — shared tab strip for the Quick-Picker and Hub.
// Phase 1a / Adaption 4 of the ContextGenerator pipeline.
//
// One source of truth so adding a category surfaces in both shells without
// duplicating the list. The order here drives display order in both places.

import { useContextStore } from './contextStore.js';

interface TabSpec {
  slug:  string;       // empty string = "All"
  label: string;
  emoji: string;
}

// Order matches .ContextGenerator.MD §3.2 with the file-based categories
// (notes/mail/calendar) prepended — they're the user's "real-world" stuff
// and most picker uses start there.
const TABS: ReadonlyArray<TabSpec> = Object.freeze([
  { slug: 'notes',         label: 'Notes',          emoji: '📝' },
  { slug: 'keep-notes',    label: 'Keep Notes',     emoji: '🗒️' },
  { slug: 'mail',          label: 'Mail',           emoji: '✉️' },
  { slug: 'calendar',      label: 'Calendar',       emoji: '📅' },
  { slug: 'frontend',      label: 'Frontend',       emoji: '🖥️' },
  { slug: 'backend',       label: 'Backend',        emoji: '⚙️' },
  { slug: 'ai-models',     label: 'AI / Models',    emoji: '🤖' },
  { slug: 'debugging',     label: 'Debugging',      emoji: '🔧' },
  { slug: 'integrations',  label: 'Integrations',   emoji: '🔌' },
  { slug: 'workflows',     label: 'Workflows',      emoji: '📋' },
  { slug: 'data',          label: 'Data',           emoji: '📁' },
  { slug: 'devops',        label: 'DevOps',         emoji: '🚀' },
  { slug: 'documentation', label: 'Documentation',  emoji: '📝' },
  { slug: 'experiments',   label: 'Experiments',    emoji: '🧪' },
  { slug: 'architecture',  label: 'Architecture',   emoji: '🏗️' },
  { slug: 'general',       label: 'General',        emoji: '💬' },
]);

interface Props {
  // Optional: hide tabs not in this set. Quick-Picker may want a slim view
  // with just notes/mail/calendar/<top categorizer slugs>.
  visible?: ReadonlyArray<string>;
  // Compact rendering (smaller font, narrower padding) for the QuickPicker.
  compact?: boolean;
}

export function CategoryTabs({ visible, compact }: Props) {
  const active = useContextStore((s) => s.activeCategory);
  const setActive = useContextStore((s) => s.setActiveCategory);

  const filtered = visible
    ? TABS.filter((t) => visible.includes(t.slug))
    : TABS;

  return (
    <div
      className={`context-tabs${compact ? ' compact' : ''}`}
      style={{
        display:    'flex',
        flexWrap:   'wrap',
        gap:        compact ? 4 : 6,
        padding:    compact ? '6px 8px' : '8px 12px',
        borderBottom: '1px solid var(--border, #333)',
      }}
    >
      {filtered.map((tab) => {
        const isActive = active === tab.slug;
        return (
          <button
            key={tab.slug || '__all__'}
            type="button"
            className={`context-tab${isActive ? ' active' : ''}`}
            onClick={() => setActive(tab.slug)}
            style={{
              padding:       compact ? '3px 8px' : '5px 10px',
              border:        'none',
              borderRadius:  4,
              fontSize:      compact ? '11.5px' : '12.5px',
              cursor:        'pointer',
              background:    isActive ? 'var(--accent, #4a8)' : 'var(--bg-soft, #262626)',
              color:         isActive ? 'white' : 'var(--fg, #eee)',
              userSelect:    'none',
              whiteSpace:    'nowrap',
            }}
            title={tab.label}
          >
            <span style={{ marginRight: 4 }}>{tab.emoji}</span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// Exported so other shells (Hub) can build a custom subset / different order.
export { TABS as CONTEXT_TABS };
