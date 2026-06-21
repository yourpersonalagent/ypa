// RenderView — viewer component that uses the render() registry.
//
// Props:
//   text     — source text
//   format   — RenderFormat
//   raw      — controlled raw toggle (optional; if omitted the component
//              owns its own toggle state and shows the button)
//   showToggle — render the raw/pretty button (default true when raw is
//              uncontrolled; default false when raw is controlled)
//
// Rendering goes through dangerouslySetInnerHTML because the registry's
// output is HTML. markdown-it is configured with html:false (see vendor.ts)
// so no user-authored HTML reaches the DOM; data handlers only emit our own
// markup. Safe by construction — DO NOT re-enable html:true on the singleton
// without also adding DOMPurify here.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { render, highlightInElement, type RenderFormat } from './index.js';

interface Props {
  text: string;
  format: RenderFormat;
  raw?: boolean;
  showToggle?: boolean;
  className?: string;
}

export function RenderView({ text, format, raw, showToggle, className }: Props): ReactElement {
  const isControlled = raw !== undefined;
  const [localRaw, setLocalRaw] = useState(false);
  const effRaw = isControlled ? raw! : localRaw;
  const showBtn = showToggle ?? !isControlled;

  const elRef = useRef<HTMLDivElement | null>(null);
  const { html } = render(text, format, { raw: effRaw });

  // Run shiki after every innerHTML swap. Effect re-fires when html changes,
  // so toggling raw/pretty re-highlights without an extra trigger.
  useEffect(() => {
    if (elRef.current) highlightInElement(elRef.current);
  }, [html]);

  return (
    <div className={`render-view ${className ?? ''}`.trim()}>
      {showBtn && (
        <button
          type="button"
          className="render-view__toggle"
          onClick={() => setLocalRaw((v) => !v)}
          title={effRaw ? 'Show rendered' : 'Show raw source'}
        >
          {effRaw ? 'rendered' : 'raw'}
        </button>
      )}
      <div ref={elRef} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export default RenderView;
