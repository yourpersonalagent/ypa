// Shared vendor singletons — import from here instead of accessing window globals.
// @ts-ignore: no bundled types for markdown-it in this resolution path
import markdownit from 'markdown-it';
// @ts-ignore
import markdownItTaskLists from 'markdown-it-task-lists';
import type { Highlighter } from 'shiki';
import { createHighlighter } from 'shiki';

// markdown-it singleton with plugins. Used by chat rendering — keeps
// `breaks: true` so a single newline in a chat message renders as <br>.
export const md = markdownit({ html: false, linkify: true, breaks: true })
  .use(markdownItTaskLists, { enabled: true });
// Disable linkify-it's "fuzzy" matching: bare hostnames without a scheme
// (e.g. `BoutiqueAgents.md`, `claude.md`) would otherwise be auto-linked
// because `.md` is a real ccTLD. Real URLs still linkify when they include
// `http://` / `https://` / `ftp://` / `mailto:` etc.
md.linkify.set({ fuzzyLink: false, fuzzyIP: false });

export { markdownit };

// Shiki singleton — async init via initShiki() at app boot; null before ready.
export let shiki: Highlighter | null = null;

const SHIKI_LANGS = [
  'typescript', 'javascript', 'tsx', 'jsx',
  'python', 'bash', 'shellscript', 'powershell',
  'json', 'json5', 'yaml', 'toml',
  'css', 'scss', 'less', 'html', 'xml',
  'markdown', 'sql', 'go', 'rust', 'ruby', 'php',
  'c', 'cpp', 'java', 'kotlin', 'swift', 'scala',
  'dockerfile', 'hcl', 'graphql', 'lua', 'r', 'dart', 'csharp', 'protobuf',
] as const;

export async function initShiki(): Promise<void> {
  shiki = await createHighlighter({
    themes: ['github-dark', 'github-light'],
    langs: [...SHIKI_LANGS],
  });
}

// Highlight a <code> element in-place (chat rendering, mirrors hljs.highlightElement).
export function shikiHighlightElement(el: HTMLElement): void {
  if (!shiki) return;
  const code = el.textContent ?? '';
  const langClass = [...el.classList].find((c) => c.startsWith('language-'));
  const rawLang = langClass ? langClass.replace('language-', '') : 'text';
  const lang = shiki.getLoadedLanguages().includes(rawLang) ? rawLang : 'text';
  try {
    const html = shiki.codeToHtml(code, {
      lang,
      themes: { dark: 'github-dark', light: 'github-light' },
      defaultColor: 'dark',
    });
    const inner = html.match(/<code[^>]*>([\s\S]*)<\/code>/)?.[1];
    if (inner) {
      el.innerHTML = inner;
      el.classList.add('shiki-highlighted');
    }
  } catch { /* ignore unknown language */ }
}
