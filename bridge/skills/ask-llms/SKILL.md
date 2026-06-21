---
name: ask-llms
category: integrations
description: "Ask the same question to multiple browser-driven LLMs (Grok + Gemini today) and return their answers side-by-side so the calling model can compare them in the current chat. Single-browser MCP, so providers run serially: total wait ≈ T_grok + T_gemini. True parallelism would need a second browser MCP mounted; see the 'Parallelism' section."
argument-hint: "<question> [--providers grok,gemini] [--compare]"
---

# Ask LLMs

Fan-out a single question to multiple browser-driven LLMs, return all answers to the calling model. The comparison happens in the main chat — this skill just gathers the raw answers.

## Defaults

- Providers: `grok, gemini` (in that order).
- `--providers a,b,c` overrides the order/set. Currently supported: `grok`, `gemini`.
- `--compare` is a hint to the calling model that the user wants a side-by-side analysis after the answers are gathered; it does not change this skill's output.

## Parallelism (read before promising the user it's fast)

The `web` MCP exposes a **single Playwright page** — no tab switching primitive. So providers run **serially**: ask Grok → poll until stable → ask Gemini → poll until stable. Total wait ≈ T_grok + T_gemini (typically 30–90 s).

Two routes to real parallelism (the user can pick later):

1. **Mount a second browser MCP** alongside `web` (e.g. re-enable `playwright-mcp` on host port 9222 — its server file is `bridge/mcp/playwright-server.js`). Then ask-grok runs on `web` and ask-gemini runs on `playwright` in parallel. ~10 lines of MCP config; no skill change beyond a parameter for which MCP to target.
2. **Add `open_tab` / `switch_tab` / `close_tab` tools to `desktop-browser-server.js`**. Playwright contexts already support multiple pages; the MCP just needs to expose them.

Neither is in scope for this skill — flag the option to the user if they ask why it's slow.

## Procedure

For each provider in `--providers` (default `grok, gemini`), in order:

1. **Run the provider's flow.** Use the matching skill body inline — do **not** invoke skills from skills (that's not supported by the harness). The flow is:

   - `grok` → follow steps 1–6 from [[ask-grok]].
   - `gemini` → follow steps 1–6 from [[ask-google-ai]].

2. **Capture the answer** as `{ provider, status: "ok" | "fail", text | reason }`.

3. **On failure** (login wall the user can't resolve, CAPTCHA, timeout, composer not found): record `status: "fail"` with a one-line reason. Do **not** abort the whole run — continue to the next provider.

4. **Reset between providers.** After each provider, `web__navigate { url: "about:blank" }` so the next provider starts from a clean page. (Don't restart the container — that's slow and unnecessary.)

## Output format

Return a single markdown block to the calling model:

```
### Grok
<grok's full answer, or "FAIL: <reason>">

### Gemini
<gemini's full answer, or "FAIL: <reason>">
```

If `--compare` was passed, append:

```
---
The user asked for a comparison. As the calling model, you should now:
- highlight where the answers agree
- highlight where they meaningfully disagree (facts, recommendations, tone)
- offer a synthesis if useful
Do this in the main chat — not inside this skill.
```

## Failure-mode policy

- **All providers fail** → return the FAIL block for each plus a one-line summary, and ask the user how to proceed (re-login? skip? wait?).
- **One succeeds, one fails** → return both. The calling model decides whether the single-source answer is enough.
- **User aborts mid-run** → stop politely; return whatever was gathered so far with a "USER ABORTED" marker.

## Notes

- The browser session is shared across providers and across calls — if the user is logged in to grok.com once, every future `ask-llms` (or `ask-grok`) call skips the login dance.
- Don't paste the calling model's chat context into the prompt. Pass the question only. If the user wants providers to see context, they should phrase the question to include it.
- The `web` MCP container is `yha-chromium` (port 9333 CDP, port 3011 KasmVNC). If something looks broken, `web__get_status {}` is the fastest probe.
