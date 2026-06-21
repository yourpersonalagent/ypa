---
name: ask-grok
category: integrations
description: "Ask grok.com a single question via the visible local Chromium and return Grok's answer. Use to bring a second-opinion model into the current chat without API keys. The user logs in once via the KasmVNC viewer at http://127.0.0.1:3011/ and the Docker container's volume keeps the session."
argument-hint: "<question to ask Grok>"
---

# Ask Grok

Drives `grok.com` via the `web` MCP (Docker Chromium, single Playwright page, persistent profile). Returns the final assistant message as plain text so the calling model can use it inline.

## Procedure

### 1. Navigate

```
web__navigate { url: "https://grok.com/chat", wait_for: "domcontentloaded" }
```

### 2. Check login state

```
web__get_content { format: "text" }
```

If the body contains `Sign in`, `Log in`, `Continue with Google`, or no composer is visible, the user is logged out. Then:

1. `web__screenshot_view {}` — let the user see what Chromium sees.
2. Tell the user: "Grok is logged out. Open http://127.0.0.1:3011/ in your browser, log in to grok.com, then say 'ready' here."
3. Wait for confirmation. Re-run step 1 and re-check.

### 3. Find the composer

Selectors change — discover dynamically:

```
web__evaluate { script: `(() => {
  const candidates = [
    'textarea[placeholder*="Ask" i]',
    'textarea[placeholder*="Grok" i]',
    'textarea[aria-label*="prompt" i]',
    'textarea[aria-label*="message" i]',
    'textarea',
    'div[contenteditable="true"]'
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ block: 'center' });
      return { selector: sel, tag: el.tagName, contentEditable: el.isContentEditable };
    }
  }
  return null;
})()` }
```

If `null`, the page is not where we expect — screenshot_view and ask the user.

### 4. Submit the question

If `tag === "TEXTAREA"`:

```
web__fill { selector: "<sel from step 3>", value: "<question>" }
web__evaluate { script: `(() => {
  const ta = document.querySelector('<sel>');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
})()` }
```

If `contentEditable === true`:

```
web__evaluate { script: `(() => {
  const ce = document.querySelector('<sel>');
  ce.focus();
  document.execCommand('insertText', false, ${JSON.stringify(question)});
})()` }
web__click { selector: 'button[aria-label*="Send" i], button[type="submit"]' }
```

Fallback if Enter doesn't fire the request: `web__click { selector: 'button[aria-label*="Send" i], button[type="submit"]' }`.

### 5. Wait for the answer to stabilise

Grok streams. Poll every 2 s up to 60 s. Stop when the latest assistant block hasn't grown for 2 consecutive polls OR a `Stop` / `Stop generating` button has disappeared.

```
web__evaluate { script: `(() => {
  // Latest assistant message — Grok renders messages in alternating role blocks.
  const blocks = document.querySelectorAll(
    '[data-message-author-role="assistant"], ' +
    '[class*="assistant" i] [class*="message" i], ' +
    'article'
  );
  const last = blocks[blocks.length - 1];
  const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
  return { text: last ? last.innerText : '', streaming: !!stopBtn };
})()` }
```

State machine:

```
prev = ''
stableCount = 0
for i in 1..30:
  sleep 2s
  { text, streaming } = poll()
  if not streaming and text == prev and text.length > 0:
    stableCount += 1
    if stableCount >= 2: break
  else:
    stableCount = 0
  prev = text
```

### 6. Return

Return the final text trimmed of UI noise (`Copy`, `Regenerate`, `Share`, role labels at the top). Format:

```
**Grok says:**

<answer>
```

## Failure modes

- **CAPTCHA / rate limit** — page shows a Cloudflare or reCAPTCHA challenge. Screenshot_view, surface to the user, stop.
- **Session expired silently** — step 5 returns no new text and step 2 didn't catch it. Treat as logged out and re-run step 2's prompt.
- **Composer not found** — page layout changed. Screenshot_view, ask the user, stop.

## Notes

- Single-turn only. Don't paste the current chat context into the prompt — that pollutes Grok's view and wastes tokens. The question should be a self-contained ask.
- The Docker volume persists login across container restarts. If `docker compose down -v` is ever run, the user has to log in again.
- Related: [[ask-google-ai]], [[ask-llms]].
