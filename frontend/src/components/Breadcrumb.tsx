// Path breadcrumb — used by FilePicker (chat-input popover) and FileManager
// (server-file management modal). Splits "/a/b/c" into clickable segments.
//
// Each consumer styles via its own class prefix (`fp-` / `fm-`) so the
// surrounding chrome is independent. The crumb element is a <span> rather
// than a <button> to inherit each consumer's existing crumb styling
// (padding/borders) without requiring a button-reset.

interface Crumb {
  label: string;
  path: string;
}

export interface BreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  /** Class prefix used for the wrapper, segment, and separator (e.g. "fp" → "fp-breadcrumb", "fp-crumb", "fp-crumb-sep"). */
  classPrefix: string;
}

export function Breadcrumb({ path, onNavigate, classPrefix }: BreadcrumbProps) {
  // Cross-platform: split on both '/' and '\' so Windows paths
  // (C:\Users\<user>\foo) crumble into clickable segments just like
  // unix paths (/home/user/foo) do. Detect Windows-style paths
  // (drive letter + separator) and use '\' for accumulation so
  // generated click-targets stay valid on the server.
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(path);
  const sep = isWindowsPath ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const crumbs: Crumb[] = [];
  let acc = '';
  if (isWindowsPath && parts.length > 0 && /^[A-Za-z]:$/.test(parts[0])) {
    // First crumb is the drive root, e.g. "C:\".
    acc = parts[0] + sep;
    crumbs.push({ label: acc, path: acc });
    parts.shift();
  } else {
    acc = '/';
    crumbs.push({ label: '/', path: '/' });
  }
  for (const part of parts) {
    acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
    crumbs.push({ label: part, path: acc });
  }
  return (
    <div className={`${classPrefix}-breadcrumb`}>
      {crumbs.map((c, i) => (
        <span key={c.path}>
          {i > 0 && <span className={`${classPrefix}-crumb-sep`}>›</span>}
          <span
            className={`${classPrefix}-crumb`}
            onClick={() => onNavigate(c.path)}
          >
            {c.label}
          </span>
        </span>
      ))}
    </div>
  );
}
