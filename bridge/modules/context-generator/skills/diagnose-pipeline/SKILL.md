---
name: diagnose-pipeline
category: yha
description: "Diagnose the Context Generator pipeline. Walks every worker (auto-title → categorizer → file-categorizer → sorter → LINK → RAG → synthesis), clusters abandoned/skipped sessions by failure class, then reports two layers of fix per worker: (a) what the user can do right now, and (b) what we should change in the context-generator code so this failure mode surfaces a real next step. Cross-cutting pass also flags abnormalities — runaway debug-row counts, stale workers, oversized synthesis bucket."
---

# Diagnose the Context Generator pipeline

You are diagnosing the ContextGenerator pipeline for the user. The pipeline already exposes machine-readable state through `/v1/config/<worker>/status` and `/v1/config/<worker>/debug` endpoints. Your job is to **pull that state, cluster failures by class, and produce two specific, actionable fix layers per worker** — not generic "check the logs" advice.

The user is reading your output in the chat composer right after closing the Context Hub. Be concrete. Name file paths, ports, row counts. Don't paraphrase what the UI already says ("⚠ Adapter not reachable") — explain *why* the failure happens and *what to do about it*.

## What the user expects from each worker

For every worker covered below, your report should answer **all four** of these:

1. **State** — running / idle / disabled. Last run timestamp. Pending vs. abandoned vs. processed counts (lifetime).
2. **Failure class** — if there are abandoned rows, cluster them by `skipReason` and name the actual cause (e.g. "model returned empty string", "session has zero user messages", "session text > 64 KB context cap"). One bullet per distinct reason, with the row count.
3. **User fix (now)** — concrete next click. Examples: "Open Obsidian — the LINK adapter is dialing `<obsidianHost>` but nothing is listening on port 27123. Once Obsidian + Local REST API plugin are running, hit `🔁 LINK sync now` in the Generator tab.", "Click `Force retry abandoned` on TitleGenerator to re-queue 4 rows.", "519 keep-notes files are stuck because no topics exist yet — run the session categorizer first; file-categorizer reuses its slug list."
4. **Code fix (suggestion only — do NOT implement)** — what should change in the context-generator codebase so this failure surfaces a real next step instead of dying silently. Be specific about file + reason. Examples: "LINK status surfaces `adapterError` but the Generator tab's hint string truncates it to 'Adapter not reachable' — surface `status.obsidianHost` so the user knows which host:port failed.", "auto-title's skipReason is stored per-row but the Inspect panel doesn't group by reason — add a `GROUP BY skipReason` rollup so 127 'no user messages' rows show as one cluster instead of 127 unreviewable rows.", "categorizer treats transient model 429s and malformed sessions identically (both → abandoned after 3 retries). Split the abandonment paths so 429s back off and retry, malformed sessions are marked dead-on-arrival."

**Do not auto-fix.** This skill is diagnostic + advisory. The user clicks through code suggestions deliberately.

## Endpoints to call

All endpoints assume the bridge default port `8442` (or `8443` if `YHA_USE_DIST` is unset — check `.env`). Use `curl -s` and pipe through `jq` for clean output. The `MCP-Tools__bash-console` MCP works well here, or `curl` via the bash tool.

### Per-worker

| Worker | Status | Debug | Run-now | Force-retry |
|---|---|---|---|---|
| TitleGenerator | `/v1/config/auto-title/status` | `/v1/config/auto-title/debug` | POST `/v1/config/auto-title/run-now` | POST `/v1/config/auto-title/force-retry` |
| Categorizer (sessions) | `/v1/config/categorizer/status` | `/v1/config/categorizer/debug` | POST `/v1/config/categorizer/run-now` | POST `/v1/config/categorizer/force-retry` |
| File-Categorizer | `/v1/config/file-categorizer/status` | `/v1/config/file-categorizer/debug` | POST `/v1/config/file-categorizer/run-now` | POST `/v1/config/file-categorizer/force-retry` |
| Sorter (wiki render) | `/v1/config/sorter/status` | `/v1/config/sorter/debug` | POST `/v1/config/sorter/run-now` | POST `/v1/config/sorter/force-retry` |
| LINK (Obsidian sync) | `/v1/config/link/status` | — | POST `/v1/config/link/run-now` | POST `/v1/config/link/test-ping` |
| RAG (vector ingest) | `/v1/context-rag/status` | — | POST `/v1/context-rag/run-now` | — |

### Cross-cutting

| Concern | Where |
|---|---|
| Synthesis bucket size & page count | `/v1/knowledge/status?workingDir=<cwd>` and `node bridge/modules/context-generator/tools/synth-status.mjs --cwd <cwd>` |
| Code graph | `/v1/knowledge/status` (`graphExists`, `nodeCount`) |
| Bridge mode + sensitivity policy | `/v1/config/categorizer/status` (`bridgeMode`, `sensitivityPolicy`, `whitelistSize`) |
| Global pipeline activity | `pm2 logs yha-bridge --lines 200 --nostream` for the last few worker ticks |

## Failure classes you should already recognize

These are the patterns that show up repeatedly. When you see them, name them — don't make the user re-discover them.

### LINK adapter unreachable

Symptom: `link.status.adapterReachable === false`, `adapterError: "sync-timeout after 60000ms (adapter unreachable?)"`, `adapterError: "ECONNREFUSED"`, or `"no-adapter-configured (api key missing?)"`.

- **User fix**: read `status.obsidianHost` and `status.adapterKind` from the response. Tell the user **which host:port** the adapter is dialing and what's missing — the Obsidian app, the Local REST API plugin, the API key (`status.apiKeyMasked === ''`), or the SSH tunnel (if `obsidianHost` is `127.0.0.1` and they're on a different machine).
- **Code fix suggestion**: `frontend/src/context/HubGeneratorTab.tsx` LINK card hint only shows the raw `adapterError`. Append `obsidianHost` and `adapterKind` so the user sees `Adapter not reachable: <host>:27123 (sync-timeout after 60000ms — is Obsidian's Local REST API plugin running on <host>?)`.

### "n sessions abandoned after 3 failed retries"

Symptom: `pendingCount > 0`, lifetime processed roughly stable, debug rows show `attempts === 3` and `status === 'abandoned'`.

- **User fix**: open Inspect, sort by `skipReason`. Hit `Force retry abandoned` if the reason looks transient (`model-error`, `timeout`, `rate-limited`). Hit `Skip all stuck` only if the cluster reason is `no-user-messages` or `empty-session` — those will never succeed.
- **Code fix suggestion**: the worker treats *every* failure the same — 3 retries then abandon. Categorize transient (HTTP 5xx, 429, timeout) vs. terminal (empty session, model returned empty, content > context window) and only abandon on terminal. Source: `bridge/modules/context-generator/auto-title.ts` (and the sibling categorizer/file-categorizer/sorter modules).

### 519 keep-notes files auto-skipped

Symptom: `file-categorizer.status.lifetimeProcessed === 0`, `lifetimeSkipped` huge, `lastRunAt === null`. The classic cause is "the session categorizer hasn't produced any topic slugs yet, so file-categorizer has no slug-list to classify against and skips everything."

- **User fix**: run the session Categorizer first (`Run now` on the 🗂 card). Wait for `categorizer.lifetimeCategorized` to climb. Then `Force retry abandoned` on file-categorizer.
- **Code fix suggestion**: file-categorizer doesn't surface the *dependency* — its `hint` should explicitly say "no topic slugs available — run the session categorizer first". Check `bridge/modules/context-generator/file-categorizer.ts` for how it decides to skip vs. enqueue.

### Title quality looks fine but lifetime count is 1

Symptom: `lifetimeTitled === 1`, `pendingCount === 0`. Means: only one session has ever gone through the worker.

- **User fix**: this is usually correct — the worker only fires when new sessions land. If the user expected more, check that sessions are actually being imported (`sessions/sessions.json` count vs. `lifetimeTitled`).
- **Code fix suggestion**: status panel should show `pending + abandoned + lifetimeTitled` as a sum so the user can see "out of N total sessions, M have titles."

### Synthesis bucket vs. graph drift

Symptom: `knowledge.graphExists === true` but `knowledge.synthCount === 0`, or `synthCount > 50` while `graphExists === false`.

- **User fix**: click `Synthesize (knowledge pages)` to bootstrap, or `Build now` (Graph) if it's missing.
- **Code fix suggestion**: nothing critical. The two are deliberately decoupled (synth pages are editable, graph is rebuilt mechanically). Only flag if the user wants tighter coupling.

## Cross-cutting abnormalities to flag

After the per-worker pass, sweep for these:

- **Runaway debug rows** — `debug.rows.length > 500` for any worker means the failure cluster is growing faster than the user is reviewing it. Recommend `Skip all stuck` after Inspect.
- **Stale worker** — `lastRunAt` more than 24 h old while `pendingCount > 0`. Worker is starved or the tick interval is broken.
- **Synthesis bucket size** — `du -sh bridge/knowledge/dirs/<slug>/synthesis/` over 5 MB suggests over-generation. Spot-check page count via `find ... -name '*.md' | wc -l`.
- **Bridge mode mismatch** — `categorizer.bridgeMode === 'cheap-model-only'` while the user expects sensitivity-aware classification. The whitelist size + sensitivity policy should match the user's intent.
- **MCP knowledge-memory not running** — `knowledge` endpoints return `mcpKnowledgeRunning: false`. Synthesis-related diagnostics will be blocked until the user starts the MCP in Prefs → MCPs.

## Reporting format

Open with a one-paragraph headline ("3 workers idle, 4 abandoned titles + 127 abandoned categories + 519 abandoned keep-notes + LINK unreachable — full breakdown below").

Then one block per worker that has anything to report:

```
### TitleGenerator
- State: idle, last run 1 h ago, lifetime 1, pending 0, abandoned 4
- Failure cluster: 4 × "model-returned-empty" (LLM produced empty title string)
- User fix (now): click "Force retry abandoned" — the cheap model occasionally returns whitespace, retries usually succeed.
- Code fix (suggestion): bridge/modules/context-generator/auto-title.ts treats "" as a valid response and counts the attempt — add a non-empty guard and don't increment `attempts` on empty responses.
```

End with the cross-cutting abnormalities block, then a **one-line summary of the highest-impact code change** to consider. If the user wants to proceed with any suggestion, they'll ask — don't open Edit tools.

## Hard rules

- **Do not modify code in this skill.** Diagnosis only. The user will request fixes after reading.
- **Do not run destructive endpoints.** No `force-retry`, no `skip-stuck`, no `force-rebuild` calls — those have user-facing confirms in the UI for a reason. Read-only: `/status`, `/debug`, `/knowledge/status`, `synth-status.mjs`.
- **Do not echo raw JSON dumps.** Summarize. The user can hit the inspect buttons themselves for row-level detail.
- **Do not invent failure classes.** If a worker's debug rows show a `skipReason` you don't recognize, name it verbatim and say "unfamiliar — open Inspect to investigate."
- **Don't say "everything looks fine" if any worker has pending or abandoned > 0.** Even a clean idle pipeline can be hiding 519 abandoned rows.

## Where the code lives

For follow-up changes the user may request:

- Worker libraries: `bridge/modules/context-generator/{auto-title,categorizer,file-categorizer,sorter}.ts`
- Route registrations: `bridge/config/handler.ts` (search for `/v1/config/<worker>/`)
- LINK adapter + watchdog: `bridge/modules/link/vault/sync-runner.ts`, `bridge/modules/link/routes.ts`
- RAG ingest: `bridge/routes/context-rag.ts`
- Synthesis bucket + staleness: `bridge/modules/context-generator/tools/synth-status.mjs`, `bridge/knowledge/dirs/<slug>/synthesis/`
- Generator tab UI (where this skill is invoked from): `frontend/src/context/HubGeneratorTab.tsx`
