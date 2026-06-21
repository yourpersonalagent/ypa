import { useAppStore } from './stores/index.js';
import { parseColorThemeId } from './color-themes-config.js';
import { colorTheme } from './color-theme.js';

// Header button for the color theme. The DOM id `btn-theme` stays as-is for
// URL / shortcut / external-reference stability — only the React component
// and concept were renamed.

export function ColorThemeButton() {
  const id = useAppStore((s) => s.colorTheme);
  const { variant } = parseColorThemeId(id);
  const icon = variant === 'dark' ? '☀' : '🌙';

  return (
    <button
      className="hm-item"
      id="btn-theme"
      title="Click: toggle dark / bright • Hold: cycle color themes (right mouse cycles in reverse) [Alt+T]"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.preventDefault();
        const dir = e.button === 2 ? 'backward' : 'forward';
        colorTheme.holdStart(dir);
        const onUp = () => {
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          colorTheme.holdEnd();
        };
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      }}
    >
      {icon}
    </button>
  );
}
