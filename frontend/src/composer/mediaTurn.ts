// mediaTurn — builds the prompt text the chat path actually sends when the
// composer is in a non-chat mode.
//
// Output shape:
//   - `displayText` — what the user sees in their own bubble. The raw prompt
//     plus a short "image · gpt-image-1 · 16:9" pill so they remember the
//     context after scrolling back.
//   - `text` — what's sent to the model. A YAML-ish <media-request> block
//     followed by the user prompt. The media-gen meta-skill (if mounted) and
//     a clear instruction tell the model to call the matching MCP tool.

import type { ComposerMode, MediaParams } from '../stores/appStore.js';
import type { ActiveModelInfo } from '../stores/activeModelsStore.js';

interface BuildArgs {
  mode: Exclude<ComposerMode, 'chat'>;
  prompt: string;
  active: ActiveModelInfo | null;
  params: MediaParams;
  enhance: boolean;
}

const TOOL_FOR_MODE: Record<Exclude<ComposerMode, 'chat'>, string> = {
  image: 'mcp__media-gen__generate_image',
  audio: 'mcp__media-gen__generate_audio',
  video: 'mcp__media-gen__generate_video',
};

export function buildMediaTurn({
  mode, prompt, active, params, enhance,
}: BuildArgs): { text: string; displayText: string } {
  const tool = TOOL_FOR_MODE[mode];
  const cleanParams: MediaParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    cleanParams[k] = v;
  }

  const paramYaml = Object.entries(cleanParams)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const enhanceLine = enhance
    ? 'enhance: true   # rewrite the user prompt for better generation, briefly note the rewrite in your reply'
    : 'enhance: false  # use the user prompt verbatim';

  const text = [
    '<media-request>',
    `mode: ${mode}`,
    `provider: ${active?.provider ?? 'unknown'}`,
    `model: ${active?.model ?? 'unknown'}`,
    `tool: ${tool}`,
    enhanceLine,
    paramYaml ? 'params:\n' + paramYaml : 'params: {}',
    '</media-request>',
    '',
    prompt || '(no prompt — use the params alone if possible)',
  ].join('\n');

  const badge = mode + (active?.model ? ` · ${active.model}` : '');
  const aspect = cleanParams.aspect_ratio || cleanParams.aspectRatio;
  const displayBadge = aspect ? `${badge} · ${aspect}` : badge;
  const displayText = `[${displayBadge}]\n${prompt}`.trim();

  return { text, displayText };
}
