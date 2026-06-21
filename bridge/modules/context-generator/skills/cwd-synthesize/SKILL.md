---
name: cwd-synthesize
category: yha
description: Generate or refresh per-module + per-flow synthesis pages for the current cwd. Pages live in the cwd's synthesis bucket (`bridge/knowledge/dirs/<slug>/synthesis/`) and ARE the editable source of truth. Uses `synth-status.mjs` to identify stale pages so refreshes are targeted, not blanket.
---

The synthesis bucket for each cwd is its own knowledge base: per-module deep-dives, per-flow walkthroughs, a `FINDINGS.md` rolling index, and a `README.md` + `INDEX.md` for navigation. The bridge's knowledge-memory MCP serves these pages to future sessions via `list_synthesis_pages` / `read_synthesis_page` / RAG.

**The bucket pages are the source of truth.** Edit pages in the bucket directly, in place, and rely on the staleness checker to flag which ones need refreshing as the underlying code moves.

## Where the bucket lives

For a cwd `<path>`, the bucket is at:

```
<bridge-root>/bridge/knowledge/dirs/<slug>/synthesis/
```

where `<slug>` is `<path>` with the leading `/` stripped and remaining `/` replaced by `___`. The bridge root is the yha-modular checkout that hosts the knowledge-memory MCP. So the *same bridge* serves synthesis pages for *every cwd* a user works in — the slug keys them apart.

You don't need to compute the slug by hand. `list_synthesis_pages` and `synth-status.mjs` both resolve it automatically.

## Page conventions

Every page carries YAML frontmatter that makes staleness machine-checkable:

```yaml
---
module: <slug-of-this-page>
source_paths:
  - relative/path/to/source-dir/
  - relative/path/to/file.ts
source_sha: <commit-hash-at-time-of-write>
generated_at: YYYY-MM-DD
last_refreshed: YYYY-MM-DD
review_pass: 1
reviewer: <model-id>
status: current      # current | stale | draft | superseded
---
```

`source_paths` are relative to the cwd; `source_sha` is the git commit the page was last verified against. The staleness checker compares each page's `source_sha` against `git log -- <source_paths>` in the cwd. A page is stale iff at least one commit *after* `source_sha` touches its `source_paths`.

Per-module pages follow the structure:

```
# <module-name>

## Purpose
(one paragraph — what this exists for, what changes if you delete it)

## Files
| Path | Role |
|------|------|

## Public surface / entry points
## Internal structure
## Dependencies
## State
## Threading / async model

## Findings
### F-001: short title
- Severity: bug | smell | perf | refactor | question
- Location: <file:line>
- Description / Suggested fix / Status

## Open questions
## Related
- Flow: [[other-page]]
- Module: [[other-module]]
```

Flow pages (`_flows/*.md`) are numbered hop-by-hop walkthroughs of one user-visible action, cross-linking into the module pages. `FINDINGS.md` is a flat rolling index of every open F-### entry across modules — the per-module page is the source of truth for details.

`[[wikilink]]` cross-refs resolve in the Obsidian vault sync (LINK module). Broken links are fine; they mark future pages worth writing.

## Steps

### 1. Find out what already exists.

Call `knowledge_status` for the cwd (or `list_synthesis_pages`) to see the current bucket inventory. An empty bucket means first-time generation; a populated bucket means refresh.

### 2. Check staleness.

```bash
node bridge/modules/context-generator/tools/synth-status.mjs --cwd <cwd>
```

(Omit `--cwd` to check `process.cwd()`.) Output is a punch list of stale pages with the commits that landed since each page's last refresh. Exit code 0 = all current, 1 = at least one stale, 2 = error.

If `graph.json` exists for this cwd (built by the Graph stage of the Context Generator pipeline), call `query_code_graph` to identify load-bearing files — modules whose nodes have the most inbound edges are the candidates for deep-dive pages.

### 3. Refresh stale pages, or generate missing ones.

**Refreshing a stale page:** read the existing page first. Then read the **commits the staleness checker just listed for this page** — `git show <sha>` for each entry under "commits since last refresh". Those commits *are* the delta you need to fold in; the commit messages also carry the *intent* behind each change, which raw source can't tell you. Only fall back to re-reading full source files when a commit message is ambiguous or a finding hinges on surrounding context the diff doesn't show. Rewrite the page: bump `source_sha` to current HEAD, bump `review_pass`, update `last_refreshed`, preserve open `Findings` (mark closed ones `fixed-in <sha>`), update file:line references, add new findings. Then write via `write_synthesis_page`.

**Generating a new page:** decide its scope — one coherent subsystem per page, not one file per page. Read the relevant source files. Write the page in the conventional structure (above). Add a row to `INDEX.md`. If it has findings, add rows to `FINDINGS.md`. Cross-link to related pages via `[[wikilinks]]`.

**First-time bucket generation:** start with `README.md` + `INDEX.md` + `FINDINGS.md`, then write 5 high-signal module pages + 1 cross-cutting flow as a v1 batch. Don't try to cover every module in one pass — the format needs to settle before you grind through dozens of pages. After v1, sit with it, then expand.

### 4. Log the pass.

Append one entry to `synthesis/log.md` via `append_log` describing what changed (`kind: ingest`, `kind: refresh`, or `kind: decision` as appropriate). The log is the audit trail — never overwrite past entries.

## What NOT to do

- **Don't read source code without checking the bucket first.** A page may already exist, with findings the user expects you to preserve. Re-deriving wastes work and loses curated context.
- **Don't write a page for every file.** Aim for ~40–50 module pages per cwd, grouped thematically. One mega-page is also wrong — the unit is *module*, not *project* or *file*.
- **Don't fix bugs while documenting.** Log them as `Findings`. Fixes go in separate commits via the normal workflow.
- **Don't blanket-refresh.** Run `synth-status.mjs` first and only refresh what's actually stale. Refreshing current pages just churns `source_sha` without learning anything.
- **Don't re-read source from scratch on a refresh when the commit list is sitting right there.** The staleness checker prints the exact commits that touched each page's `source_paths` since its last refresh. Read those commits first — they're the delta, and they come with the author's stated intent. Re-reading all source defeats the point of having a sha-tracked corpus.
- **Don't delete `Findings` entries that haven't been closed.** Preserve open findings across refreshes. Mark closed ones `fixed-in <sha>` and move to the `FINDINGS.md` `Closed` section.
