// ContextGenButton — 6th header icon, opens the ContextHub modal.
// Phase 1b / Adaption 2 + 4 (Shell #2 trigger).
//
// Lives between the Prefs gear and the PetHeaderButton. Per the
// .ContextGenerator.MD §6: the row order ends in
//   `[Pref] [Theme] [Search] [Sessions] [✨ ContextGen] [Pet] [User]`
// — but the actual primary header row in Shell.tsx today goes
//   `[Theme] [FileMgr] [RemoteBrowser] [Prefs]`
// then the secondary row carries `[Pet] [User]`. So we slot in directly
// before the PetHeaderButton in the secondary row.
//
// Decoupling: this button only dispatches `yha:open-context-hub`. The
// ContextHub component listens for it. That keeps the header agnostic
// of the modal's mount lifecycle and matches how `yha:open-file-manager`
// and `yha:open-browser-window` are wired.
//
// API-busy indicator (added 2026-05-07)
// ─────────────────────────────────────
// Per user request: when ANY module is actively calling the model, the
// button switches to a red "broadcasting" pulse symbol so the user knows
// not to restart the bridge mid-stream. Logic lives in `useApiBusy` —
// covers chat streaming + auto-title / categorizer / sorter / link
// workers. The icon is fully swapped (not just colored) so it's
// recognizable even with the dimmed `--fg-dim` baseline.

import { useApiBusy } from './useApiBusy.js';

interface Props {
  /** Optional title override — defaults to the standard tooltip. */
  title?: string;
}

export function ContextGenButton({ title }: Props) {
  const { busy, reasons } = useApiBusy();

  const liveTitle = busy
    ? `⚠ Model is in use — ${reasons.join(', ')}. Avoid restarting the server.`
    : title ?? 'Context Generator — categorize, sort, and link your sessions [Alt+C]';

  return (
    <button
      type="button"
      className={`hm-item${busy ? ' is-busy' : ''}`}
      id="btn-context-gen"
      title={liveTitle}
      aria-label={busy ? 'Model is in use — context generator' : 'Open Context Generator'}
      aria-busy={busy || undefined}
      onClick={() => window.dispatchEvent(new CustomEvent('yha:open-context-hub'))}
    >
      <span className="hm-icon" aria-hidden="true">
        {busy ? (
          // BUSY symbol — concentric "broadcasting" arcs around a solid
          // dot. Connotes active transmission / the model is talking.
          // (Pulse animation removed 2026-05-07 — coloring + icon swap
          // is enough. CSS keyframes kept commented in layout/core.css
          // for easy restore.)
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Solid core */}
            <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
            {/* Inner arc pair */}
            <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6" />
            <path d="M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
            {/* Outer arc pair */}
            <path d="M5.4 5.4a9.4 9.4 0 0 0 0 13.2" />
            <path d="M18.6 5.4a9.4 9.4 0 0 1 0 13.2" />
          </svg>
        ) : (
          // IDLE symbol — original sparkles + folder hybrid: connotes
          // both "indexed knowledge" and "fresh, generated" without
          // overloading any existing icon's meaning in the header
          // (folder = file-manager, gear = prefs).
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Stack of layers — three offset rectangles to evoke a card
                index / categorized stack. */}
            <rect x="3"  y="6" width="14" height="3" rx="0.6" />
            <rect x="3"  y="11" width="14" height="3" rx="0.6" />
            <rect x="3"  y="16" width="14" height="3" rx="0.6" />
            {/* Sparkle in the upper-right corner = "generator". */}
            <path d="M20 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
          </svg>
        )}
      </span>
    </button>
  );
}
