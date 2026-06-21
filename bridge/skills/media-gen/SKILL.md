---
name: media-gen
category: integrations
composer-mode: auto
description: "Generate images, audio, or video when the user message contains a <media-request> block from YHA's composer mode switcher. The block tells you which MCP tool to call (mcp__media-gen__generate_image / _audio / _video), which provider + model the user picked, the structured params they set in the panel, and whether to enhance the prompt first. Always honour the params block verbatim."
argument-hint: "<media-request> block + user prompt"
---

# Media generation — composer-driven

When you see a fenced `<media-request>` block at the top of the user message, the user is in YHA's image / audio / video composer mode rather than plain chat. Your job is to translate the block into a single MCP tool call and then surface the result.

## Block shape

```
<media-request>
mode: image | audio | video
provider: OpenAI | Google | Grok | ...
model: gpt-image-1.5 | imagen-4.0-generate-002 | ...
tool: mcp__media-gen__generate_image | mcp__media-gen__generate_audio | mcp__media-gen__generate_video
enhance: true | false
params:
  aspect_ratio: "16:9"
  quality: "high"
  n: 1
  ... (whatever the per-model schema declared)
</media-request>

(user prompt follows)
```

The `params` object is whatever the model accepts. The frontend already filtered it against `/v1/media/schema/<provider>/<model>` so every key is valid — don't drop or rename keys.

## Procedure

1. **Read the block.** Extract `mode`, `model`, `tool`, `enhance`, and `params`. The provider name is informational; the `model` id and `params` are what the tool consumes.
2. **Optionally enhance the prompt.** If `enhance: true`, rewrite the user prompt into a richer description suited to the model. Keep it grounded — don't add subjects, settings, or style choices the user didn't imply. One short paragraph. Print the rewritten prompt to the user in a small `**Rewritten prompt:** …` line before calling the tool so they can see what you sent.
3. **Call the tool.** Single call:
   - `mcp__media-gen__generate_image { model, prompt, ...params }`
   - `mcp__media-gen__generate_audio { model, prompt, ...params }`
   - `mcp__media-gen__generate_video { model, prompt, ...params }`
   Do not split the request across multiple calls. Pass `params` keys at the top level of the tool argument (not nested under a `params` key).
4. **Surface the result.** The tool returns the file path(s) — render them in the reply so the chat UI shows the media. Do not paraphrase the model's response or add commentary unless the user asked for it.
5. **On error.** If the tool errors with a deprecation / sunset notice, tell the user which model is dying and on what date (the schema's `deprecation` field is the source of truth). Suggest the replacement listed in the schema.

## Rules

- **Honour the params block.** Never substitute values the user didn't set. If the user picked `aspect_ratio: 9:16`, you may not generate a 1:1 image.
- **Don't second-guess `enhance: false`.** Use the user prompt verbatim.
- **One generation per turn.** If the user wants multiple variations, they raised `n` in the params panel — the tool handles that. Don't loop.
- **No skill chaining.** This is a tool-call skill, not a research skill. If the user wants edits or variations they'll come back through the composer with the next prompt.

## Related

- The composer UI lives in `frontend/src/composer/`. Adding a new param widget means adding it to the schema returned by `/v1/media/schema/<provider>/<model>` (see `bridge/modules/media-schemas/schemas.ts`), then `MediaParamPanel.tsx` renders it automatically.
- Plugin schemas: drop a `media-schemas.json` next to any meta-skill's `SKILL.md` to register custom (provider, model) param sets. See [[cwd-plugin-creator]] for the meta-skill pattern.
