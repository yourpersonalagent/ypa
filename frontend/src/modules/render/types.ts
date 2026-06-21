export type RenderFormat =
  | 'markdown'
  | 'raw'
  | 'json'
  | 'xml'
  | 'csv'
  | 'tsv';

export interface RenderOpts {
  // ?raw=1 — bypass any handler-specific prettification and return the input
  // wrapped in a syntax-highlighted <pre><code> (so even data formats stay
  // readable but no parsing/normalization runs). One orthogonal flag instead
  // of a separate "raw" handler per format keeps the registry single-headed.
  raw?: boolean;
  // Hint for shiki when raw=true. Ignored for the markdown handler (which
  // picks per fenced code-block) and for raw on a markdown source (uses
  // 'markdown'). Defaults to the format name.
  rawLang?: string;
}

export interface RenderResult {
  html: string;
  // The detected/effective format after auto-detection (csv vs tsv, etc).
  format: RenderFormat;
  // Always 'text/html; charset=utf-8' for now. Reserved so future handlers
  // (svg, mermaid) can return a different mime without breaking callers.
  mime: string;
}

export type RenderHandler = (text: string, opts: RenderOpts) => RenderResult;
