// PluginsDropdown — body of the header popover.
//
// One unified header per plugin: reorder arrows · plugin-wide checkbox ·
// plugin label · TOP badge. When the checkbox is on, every tile in the
// plugin renders underneath. Multi-tile plugins get a small sub-label
// above each tile so they can still be told apart; single-tile plugins
// render the tile directly.

import { usePluginsStore, getOrderedPlugins } from '../store/pluginsStore.js';
import { TileRenderer } from './TileRenderer.js';
import { seedSkillCommand } from '../../../chat/seedCommand.js';
import type { PluginManifest } from '../bridge/api.js';

const CREATOR_SKILL = 'cwd-plugin-creator';

export function PluginsDropdown() {
  const cwd = usePluginsStore((s) => s.cwd);
  const manifest = usePluginsStore((s) => s.manifest);
  const loading = usePluginsStore((s) => s.loading);
  const error = usePluginsStore((s) => s.error);
  const activations = usePluginsStore((s) => s.activations);
  const togglePluginActivation = usePluginsStore((s) => s.togglePluginActivation);
  const trustForCwd = usePluginsStore((s) => (cwd ? s.trust[cwd] : undefined));
  const setTrust = usePluginsStore((s) => s.setTrust);
  const pluginOrder = usePluginsStore((s) => (cwd ? s.pluginOrder[cwd] : undefined));
  const movePlugin = usePluginsStore((s) => s.movePlugin);

  if (!cwd) {
    return <div className="plugins-dropdown-empty">Pick a working directory to load plugins.</div>;
  }
  if (loading && !manifest) {
    return <div className="plugins-dropdown-empty">Loading plugins…</div>;
  }
  if (error) {
    return <div className="plugins-dropdown-error">Failed to load plugins: {error}</div>;
  }
  if (!manifest || manifest.plugins.length === 0) {
    return (
      <div className="plugins-dropdown plugins-dropdown-empty" style={{ padding: 12 }}>
        <p style={{ marginTop: 0, marginBottom: 8, opacity: 0.8 }}>
          No plugins in <code>.yha-plugins/</code> for this working directory.
        </p>
        <CreatePluginButton />
      </div>
    );
  }

  const activePlugins = new Set(activations[cwd] || []);
  const dataTileCount = manifest.plugins.reduce(
    (n, p) => n + p.tiles.filter((t) => !!t.data).length,
    0,
  );
  const needsTrustPrompt = dataTileCount > 0 && trustForCwd === undefined;
  const ordered = getOrderedPlugins(manifest.plugins, pluginOrder);
  const allNames = manifest.plugins.map((p) => p.name);

  return (
    <div className="plugins-dropdown" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 8 }}>
      {needsTrustPrompt && (
        <TrustPrompt
          cwd={cwd}
          dataTileCount={dataTileCount}
          onAllow={() => setTrust(cwd, 'allow')}
          onDeny={() => setTrust(cwd, 'deny')}
        />
      )}
      {ordered.map((p, i) => (
        <PluginGroup
          key={p.name}
          plugin={p}
          cwd={cwd}
          active={activePlugins.has(p.name)}
          onToggle={() => togglePluginActivation(cwd, p.name)}
          isFirst={i === 0}
          isLast={i === ordered.length - 1}
          isTop={i === 0}
          onMove={(dir) => movePlugin(cwd, p.name, dir, allNames)}
        />
      ))}
      <div className="plugins-dropdown-footer" style={{ borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: 8 }}>
        <CreatePluginButton />
      </div>
    </div>
  );
}

interface TrustPromptProps {
  cwd: string;
  dataTileCount: number;
  onAllow: () => void;
  onDeny: () => void;
}

function TrustPrompt({ cwd, dataTileCount, onAllow, onDeny }: TrustPromptProps) {
  return (
    <div className="plugins-trust-prompt" role="alertdialog" aria-labelledby="plugins-trust-headline">
      <div id="plugins-trust-headline" className="plugins-trust-headline">
        Allow {dataTileCount} data loader{dataTileCount === 1 ? '' : 's'} for this CWD?
      </div>
      <div className="plugins-trust-detail">
        Plugins in <code>{cwd}/.yha-plugins/</code> ship server-side <code>data.ts</code> scripts.
        Allowing runs them in the bridge with full host privilege (filesystem, shell). Only allow
        if you wrote or audited the code.
      </div>
      <div className="plugins-trust-actions">
        <button type="button" className="hm-item" onClick={onDeny}>Deny</button>
        <button type="button" className="hm-item" onClick={onAllow}>Allow</button>
      </div>
    </div>
  );
}

function CreatePluginButton() {
  return (
    <button
      type="button"
      className="hm-item plugins-create-btn"
      style={{ width: '100%', justifyContent: 'flex-start' }}
      onClick={() => seedSkillCommand(CREATOR_SKILL)}
      title="Open a chat with the cwd-plugin-creator skill"
    >
      + Create new CWD plugin
    </button>
  );
}

interface PluginGroupProps {
  plugin: PluginManifest;
  cwd: string;
  active: boolean;
  onToggle: () => void;
  isFirst: boolean;
  isLast: boolean;
  /** First in user order — this plugin's tiles feed the header quickinfo. */
  isTop: boolean;
  onMove: (dir: -1 | 1) => void;
}

function PluginGroup({ plugin, cwd, active, onToggle, isFirst, isLast, isTop, onMove }: PluginGroupProps) {
  const showSubLabels = plugin.tiles.length > 1;
  const checkboxId = `plugin-active-${plugin.name}`;
  return (
    <section className="plugins-group" data-plugin={plugin.name}>
      <header className="plugins-group-header">
        <div className="plugins-group-reorder" aria-label="Reorder plugin">
          <button
            type="button"
            className="plugins-reorder-btn"
            disabled={isFirst}
            onClick={() => onMove(-1)}
            title="Move plugin up"
            aria-label={`Move ${plugin.label} up`}
          >▲</button>
          <button
            type="button"
            className="plugins-reorder-btn"
            disabled={isLast}
            onClick={() => onMove(1)}
            title="Move plugin down"
            aria-label={`Move ${plugin.label} down`}
          >▼</button>
        </div>
        <input
          id={checkboxId}
          type="checkbox"
          className="plugins-group-checkbox"
          checked={active}
          onChange={onToggle}
          aria-label={`Activate ${plugin.label}`}
        />
        <label htmlFor={checkboxId} className="plugins-group-label">{plugin.label}</label>
        {isTop && (
          <span
            className="plugins-group-top-badge"
            title="This plugin's first headline tile drives the header button text"
          >TOP</span>
        )}
      </header>
      {active && plugin.tiles.length === 0 && (
        <div className="plugins-group-empty">(no tiles)</div>
      )}
      {active && plugin.tiles.map((t) => (
        <div key={t.id} className="plugins-tile-row" data-tile-id={t.id}>
          {showSubLabels && <div className="plugins-tile-sublabel">{t.label}</div>}
          <TileRenderer cwd={cwd} plugin={plugin.name} tile={t} />
        </div>
      ))}
    </section>
  );
}
