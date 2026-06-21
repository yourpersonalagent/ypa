// Shared synthesize-prompt builder. Used by both KnowledgeButtons (the
// action-button surface above the chat input) and HubGeneratorTab's
// Synthesize StageCard, so the prompt content stays in one place.

export interface SynthesisPromptOpts {
  cwd:        string;
  hasGraph:   boolean;
  /** When true, the prompt asks the model to update/merge existing pages
   *  rather than create from scratch. */
  isUpdate:   boolean;
}

export function buildSynthesisPrompt(o: SynthesisPromptOpts): string {
  const graphStep = o.hasGraph
    ? `**Step 0 — Freshness check**
Run \`query_code_graph mode=stats\` and compare its built-commit field to the current HEAD (use bash: \`git -C "${o.cwd}" rev-parse HEAD\`).
If stale by more than 1 commit, call \`build_code_graph incremental:true\` before querying. Graphify backend — no API cost, fast rebuild.`
    : `**Step 0 — Build the graph**
Call \`build_code_graph incremental:true\` to index the codebase before querying.`;

  const readStep = o.isUpdate
    ? `**Step 1 — Orient + read existing pages**
Query: \`mode=god_nodes limit:15\`, \`mode=hubs limit:15\`, \`mode=stats\`.
Then read all existing synthesis pages: call \`list_synthesis_pages\`, then \`read_synthesis_page\` for:
\`summaries/architecture.md\`, \`summaries/modules.md\`, \`summaries/patterns.md\`, \`summaries/onboarding.md\`, \`index.md\`.
Identify what is outdated or missing — only rewrite sections that have changed, merge the rest.`
    : `**Step 1 — Orient from the graph**
Query: \`mode=god_nodes limit:15\`, \`mode=hubs limit:15\`, \`mode=stats\`.
These identify the most load-bearing modules — use them to anchor every summary page.`;

  return `${o.isUpdate ? 'Update and expand' : 'Create'} the knowledge synthesis for the codebase at ${o.cwd} using the knowledge-memory MCP tools.

Pass \`workingDir: "${o.cwd}"\` to every knowledge-memory tool call — the bucket is per-directory.

${graphStep}

${readStep}

**Step 2 — Write/update the four core summary pages** (create if missing, merge if existing)
Keep each page 200–400 words. Cross-reference with [[wikilinks]].
- \`summaries/architecture.md\` — overall structure, key layers, end-to-end data flow
- \`summaries/modules.md\` — the 8–12 most-connected modules identified by god_nodes/hubs above; describe what each does and why it matters
- \`summaries/patterns.md\` — recurring conventions, non-obvious decisions, architectural trade-offs
- \`summaries/onboarding.md\` — where to start, key files, how to run the project, main gotchas

**Step 3 — Create/update index.md**
Write a proper master navigation index: one-line description per summary page, plus links to the top god-node deep-dive pages. Not a flat list — make it useful as an Obsidian entry point.

**Step 4 — Deep-dive pages for the most complex modules**
Using the god_nodes results from Step 1, write or update \`code/\` pages for the top 8 files by edge count (currently empty stubs).
Each page: 150–250 words — what the module does, key functions, why it is central, [[wikilinks]] to related pages.
The file names to use are the ones returned by the god_nodes query — do not guess them.

**Step 5 — Update log.md**
Append a short entry: today's date and which pages were created or updated.

Confirm when done: list every page written with its word count.`;
}
