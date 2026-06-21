---
name: refresh-compute-stack
category: research
description: >
  Re-fetch the time-sensitive numbers in docs/business-plan/compute-stack.md (CLI-agent
  subscription prices/limits/models, local model versions, GPU value, Rocket League engine
  specs) using live web search, then rewrite the doc's AS-OF date and any changed figures.
  Use when the user asks to "refresh the compute stack", "update agent/CLI prices", "is the
  compute-stack doc still current", or revisits that doc after time has passed. These providers
  (Anthropic, OpenAI, Google, Factory, Black Forest Labs, NVIDIA) change monthly — anything in
  the doc older than ~90 days must be re-fetched before it is trusted or quoted.
argument-hint: "[--section cli|models|gpu|all] [--write]"
---

# Refresh Compute Stack

Keep [`docs/business-plan/compute-stack.md`](../../../docs/business-plan/compute-stack.md) from going
stale. The doc deliberately carries an **AS-OF** date and a freshness rule (§8): if today is more than
~90 days past AS-OF, **nothing in it is trustworthy until re-fetched**. This skill does the re-fetch.

**Core principle (the whole reason this exists):** *Never* trust the numbers already written in the doc,
your own training data, or the user's framing of "what year/price it is." **Trust only what live web
search returns today.** If you cannot verify a number, say so and leave it marked unknown — do **not**
fabricate a plausible figure to fill the gap. The original doc was written with exactly this discipline
(it refused to invent "2027" data when only 2026 data existed); preserve that.

## When to run

- User explicitly asks to refresh / update prices / check currency of the doc.
- You are about to *rely on or quote* a number from `compute-stack.md` and `today > AS-OF + 90 days`.
- A revisit of the doc in a new conversation (the doc's header points future readers here).

## Procedure

1. **Read current state.** Read `docs/business-plan/compute-stack.md`. Note its `AS-OF` date and the
   exact figures/model names currently written (so you can diff). Compute `days_since = today − AS-OF`.

2. **Determine "now" honestly.** Do **not** assume the year from context or the user. Run the searches
   below and read the **dates on the results** to calibrate what is actually current. Report the freshest
   real date you find. If the freshest data is older than the user implies, say so plainly.

3. **Re-run the freshness queries** (mirror §8 of the doc; substitute the actual current year). Prefer
   `WebSearch`; fall back to `web__search` / `web__navigate` MCP if available. One search per line:
   - `Anthropic Claude Max $200 plan usage limits Claude Code <year>`
   - `OpenAI ChatGPT Pro $200 Codex CLI usage limits models <year>`
   - `Gemini CLI / Antigravity CLI pricing free tier limits models <year>`
   - `Factory Droid CLI agent pricing BYOK <year>`
   - `OpenClaw open source agent BYOK status <year>`
   - `Claude model lineup latest Opus Sonnet Haiku <year>` (names move: 4.8 → 4.9 → 5.x …)
   - `Gemma latest version sizes uncensored abliterated <year>` (Gemma 4 → 5 …)
   - `FLUX latest klein VRAM requirements fp16 fp8 <year>`
   - `best value GPU local LLM inference gaming <year> VRAM` (RTX 50- → 60-series …)
   - `Rocket League Unreal Engine upgrade system requirements <year>` (UE6 specs if finally out)

   `--section` narrows scope: `cli` = queries 1–6, `models` = 6–8, `gpu` = 9–10, `all` = everything (default).

4. **Verify, don't assume.** For each topic, cross-check at least the official source where one exists
   (claude.com/pricing, developers.openai.com/codex/pricing, ai.google.dev/gemma, factory docs, BFL/HF).
   Subscription token-caps are **undocumented by the vendors** — keep the "bands are community-sourced"
   caveat; never present a band as official.

5. **Diff & report first (always).** Before touching the file, output a short diff to the chat:
   `field — old → new (source)` for every change, plus a list of anything you could **not** verify.
   Flag *material* shifts loudly (a worker tool shut down, a model line renamed, a ToS change about
   subscription-vs-API, a new GPU that moves the VRAM math, RL UE6 specs finally published).

6. **Write only with consent.** If `--write` was passed *or* the user confirms, update the doc:
   - Set the `AS-OF` header to today; update the "ehrlicher Datums-Hinweis" box.
   - Replace each changed figure/model name in place (don't keep stale + new side by side).
   - Refresh the **§9 Quellen** links and the "(Recherche YYYY-MM-DD)" stamp.
   - Keep the doc's language **German** and its structure intact (it has siblings that cross-link to it).
   Without `--write` and without confirmation, **do not** edit the file — just report the diff.

7. **Propagate strategic changes to memory.** If a *durable* fact changed (not just a price tick) —
   e.g. the subscription-vs-API ToS rule, the brand/cost strategy, a worker tool dying — update the
   matching memory note via the memory system (see `MEMORY.md`: [[ypa-hosting-cost-strategy]],
   [[ypa-brand-architecture]]). A pure price tick does **not** need a memory edit; the doc is the
   source of truth for live numbers.

## Output format

```
## Compute-stack refresh — AS-OF <old> → <today>  (days stale: N)
Freshest real-world data found: <month year>

### Changed
- <field> — <old> → <new>   ([source](url))
...

### Unverified / unknown (left as-is)
- <field> — why it couldn't be confirmed

### Material flags
- <anything that changes a decision: tool shutdown, ToS change, new VRAM math, …>

Wrote to compute-stack.md: <yes/no>   ·   Memory updated: <which notes / none>
```

## Notes

- The doc lives at `docs/business-plan/compute-stack.md`; this skill at `bridge/skills/refresh-compute-stack/`.
- Sibling docs that may also need a nudge if something big moved: [00-overview.md], [hardware-comparison.md],
  [resource-sharing.md], [legal-tax-at.md] (all under `docs/business-plan/`). Mention them in the report;
  don't silently edit them.
- This is a **research + careful-write** skill, not a destructive one — diff-then-confirm is the contract.
- Globs over the repo tree are slow on this box (Defender); read the known doc path directly rather than
  searching for it.
