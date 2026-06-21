---
name: ask-google-ai
category: integrations
description: "Ask Google Gemini (gemini.google.com) a single question via the visible local Chromium and return Gemini's answer. Use to bring Google's model into the current chat without API keys. User logs in once via the KasmVNC viewer at http://127.0.0.1:3011/; the Docker volume keeps the Google session."
argument-hint: "<question to ask Gemini>"
---

# Ask Google Gemini

Drives `gemini.google.com` via the `web` MCP. Same shape as [[ask-grok]]; different DOM and a contenteditable composer.

## Why Gemini, not AI Studio or AI Mode

- **`gemini.google.com/app`** — consumer chat. Friendliest to driven Chromium when logged in. Default target for this skill.
- **`aistudio.google.com`** — developer playground. More aggressive bot detection; selectors churn. Use only if the user explicitly asks for AI Studio.
- **`google.com/search?udm=50` (AI Mode)** — serves degraded results or CAPTCHAs to non-human-flagged Chromium. Avoid.

## Procedure

### 1. Navigate

```
web__navigate { url: "https://gemini.google.com/app", wait_for: "domcontentloaded" }
```

### 2. Check login state

```
web__get_content { format: "text" }
```

If the URL redirected to `accounts.google.com`, or the text contains `Sign in to Gemini` / `Choose an account`:

1. `web__screenshot_view {}`.
2. Tell the user: "Gemini is logged out. Open http://127.0.0.1:3011/ and sign in to your Google account, then say 'ready'."
3. Wait, retry step 1.

### 3. Find the composer

Gemini uses a contenteditable inside a `rich-textarea`:

```
web__evaluate { script: `(() => {
  const candidates = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div[contenteditable="true"][aria-label*="message" i]',
    'div[contenteditable="true"]'
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ block: 'center' });
      return { selector: sel, aria: el.getAttribute('aria-label') };
    }
  }
  return null;
})()` }
```

### 4. Submit

`web__fill` doesn't drive contenteditable reliably — use `execCommand('insertText')` to trigger the framework's input listeners:

```
web__evaluate { script: `(() => {
  const ce = document.querySelector('<sel>');
  ce.focus();
  document.execCommand('insertText', false, ${JSON.stringify(question)});
})()` }
```

Then click Send. Gemini's send button is the right-most icon button in the composer toolbar; it becomes enabled once the composer has text:

```
web__click { selector: 'button[aria-label*="Send message" i], button[aria-label="Send"], button.send-button' }
```

If Send is still disabled, the insertText probably didn't fire input — fall back to:

```
web__evaluate { script: `(() => {
  const ce = document.querySelector('<sel>');
  ce.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(question)} }));
})()` }
```

### 5. Poll for response

Gemini streams into `model-response` / `message-content` elements. Same stabilise-on-no-growth pattern as ask-grok:

```
web__evaluate { script: `(() => {
  const blocks = document.querySelectorAll(
    'model-response message-content, ' +
    '[data-test-id="response"], ' +
    'div[class*="response" i] div[class*="content" i]'
  );
  const last = blocks[blocks.length - 1];
  const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
  return { text: last ? last.innerText : '', streaming: !!stopBtn };
})()` }
```

Poll every 2 s up to 60 s; stop when text stops growing for 2 polls and no Stop button is visible.

### 6. Return

```
**Gemini says:**

<answer>
```

## Failure modes

- **Model picker / consent modal** on first use of a new account — surface to the user via screenshot_view and ask them to dismiss it once.
- **"You've reached your limit"** — surface and stop. Free tier has daily caps.
- **Composer not found** — Gemini A/B tests its UI heavily. Screenshot_view and ask.

## Notes

- Single-turn only.
- Gemini will sometimes silently switch models mid-conversation (Flash vs Pro). If model identity matters, the user should pick it in the UI first; this skill doesn't drive the model picker.
- Related: [[ask-grok]], [[ask-llms]].
