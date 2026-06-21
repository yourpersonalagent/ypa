// ── Model type / capability detection + small string utils ────────────────────
'use strict';

const os = require('os');
const path = require('path');

// Canonical category set used by the picker, composer, and tracker.
// 'audio' is a legacy coarse type kept only by detectModelType() for back-compat.
const CATEGORIES = [
  'llm',
  'image',
  'video',
  'tts',
  'stt',
  'music',
  'realtime',
  'embedding',
  'code-embedding',
  'rerank',
  'moderation',
  'unknown',
];

// Returns one of CATEGORIES. Order matters: more specific patterns first.
function detectModelCategory(modelId) {
  const id = (modelId || '').toLowerCase().trim();
  if (!id) return 'unknown';

  // Video first — veo / sora / grok-imagine-video are unambiguous.
  if (/sora|veo|grok-imagine-video/.test(id)) return 'video';

  // Image — covers OpenAI gpt-image-*, Google nano-banana/gemini-*-image, Imagen, Grok image.
  if (/dall-e|gpt-image|chatgpt-image|imagen|nano-banana|gemini[^/]*-image|gemini[^/]*-flash-image|grok-imagine-image|aurora|janus/.test(id))
    return 'image';

  // Music — Lyria (Google) is the only public one right now.
  if (/lyria|music/.test(id)) return 'music';

  // Realtime / live duplex (voice-assistant land — not file output).
  if (/realtime|gpt-realtime|gemini[^/]*-live/.test(id)) return 'realtime';

  // TTS — file-producing speech synthesis. gpt-4o-mini-tts, gemini-*-tts, etc.
  if (/-tts\b|tts-|gemini[^/]*-tts/.test(id)) return 'tts';

  // STT — whisper, gemini-*-transcribe, future stt-* families.
  if (/whisper|transcrib|-stt\b|stt-/.test(id)) return 'stt';

  // Embeddings — split code-embeddings out where the name says so.
  if (/code[-_]?embed/.test(id)) return 'code-embedding';
  if (/embed|embedding|text-embedding/.test(id)) return 'embedding';

  // Rerank + moderation are niche but worth surfacing.
  if (/rerank/.test(id)) return 'rerank';
  if (/moderation|guard|safety/.test(id)) return 'moderation';

  // Default to llm — keeping legacy behaviour where unmatched chat models
  // bucket into llm rather than unknown. Use the picker override to fix
  // anything that genuinely doesn't fit.
  return 'llm';
}

// Legacy coarse type. Maps the new categories down to the original 4-value set
// so existing call sites (chat routing, MCP filtering) keep working unchanged.
function detectModelType(modelId) {
  const cat = detectModelCategory(modelId);
  if (cat === 'image') return 'image';
  if (cat === 'video') return 'video';
  if (cat === 'tts' || cat === 'stt' || cat === 'music' || cat === 'realtime') return 'audio';
  if (cat === 'embedding' || cat === 'code-embedding' || cat === 'rerank' || cat === 'moderation') {
    // These weren't surfaced as a distinct type before — keep them out of
    // chat by reporting 'llm'-not-quite. Callers that care can read
    // `category` from the model entry instead.
    return 'llm';
  }
  return 'llm';
}

function detectCapabilities(modelId, meta) {
  const id = (modelId || '').toLowerCase();
  const type = detectModelType(modelId);
  if (type !== 'llm') return { vision: false, reasoning: false, tools: false };

  // meta.vision/reasoning/tools may be set by config or a live API response (e.g. OpenRouter).
  // Config/live data always wins over the regex heuristic.
  const vision =
    meta?.vision !== undefined
      ? !!meta.vision
      : /gpt-4[vo]|gpt-4-turbo|gpt-4\.1|gpt-5|o1|o3|o4|gemini|claude-|grok.*vision|grok-4/.test(id);

  const reasoning =
    meta?.reasoning !== undefined
      ? !!meta.reasoning
      : /^o1|^o3|^o4|deepseek-r1|deepseek-reasoner|deepseek-thinking|deepseek-v4|qwq|gemini-2\.[05].*thinking|gemini-2\.5|claude-3-7|claude-[a-z]+-[4-9]|grok.*reasoning/.test(
          id
        );

  // Conservative regex fallback — only flag known tool-capable families.
  // Open-source/free models (Gemma, Llama base, etc.) don't reliably support function calling.
  const tools =
    meta?.tools !== undefined
      ? !!meta.tools
      : /gpt-3\.5-turbo|gpt-4|gpt-5|o1|o3|o4|claude-|gemini-1\.[5-9]|gemini-2|grok-[2-9]|grok-4|deepseek-(v3|v4|chat|r1|reasoner|thinking)|mistral-(large|medium|small|nemo|pixtral)|mixtral|qwen.*-(max|plus|turbo)|qwen2\.5.*instruct|qwen3|llama-3\.[123].*instruct|command-r/.test(
          id
        );

  return { vision, reasoning, tools };
}

function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(keyFn(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

module.exports = {
  CATEGORIES,
  detectModelCategory,
  detectModelType,
  detectCapabilities,
  expandHome,
  stripAnsi,
  uniqBy,
};
