// ── Media param schemas — resolver for `/v1/media/schema/:provider/:model` ────
//
// A media schema is a small, declarative description of the knobs the
// composer should render for a given (provider, model) combination. The
// frontend pulls the schema, renders one widget per field, collects values,
// and hands them back to the `media-gen` meta-skill which translates them
// into the right MCP tool call.
//
// Resolution order — first match wins:
//   1. Plugin schemas — any meta-skill at
//      bridge/modules/skills-editor/skills/<name>/media-schemas.json may
//      register one or more schemas. Cached for the process lifetime;
//      scanned lazily on first request.
//   2. Built-in schemas — the BUILT_INS table below. Patterns are matched
//      most-specific-first (literal id > glob > provider-default).
//
// Schemas are intentionally tiny — only the params that media-server.js
// actually consumes today. Adding a new knob is two lines here + one line
// in media-server.js to translate it.
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../core/logger');

// ── Types (used for documentation; this is a CJS module) ──────────────────────
//
// type Widget =
//   | 'select'        — values: { value, label }[]
//   | 'aspect-ratio'  — same shape, rendered as visual ratio tiles
//   | 'range'         — min/max/step, numeric slider
//   | 'number'        — bare number input
//   | 'text'          — single-line text
//   | 'multiline'     — textarea
//   | 'bool'          — checkbox
//
// type ParamField = {
//   key: string;            // sent to media-server as { [key]: value }
//   label: string;          // shown next to the widget
//   widget: Widget;
//   default?: any;
//   values?: { value: string; label: string }[];
//   min?: number; max?: number; step?: number;
//   help?: string;
// };
//
// type MediaSchema = {
//   provider: string;
//   model: string;          // exact id or glob, e.g. "gpt-image-*"
//   category: 'image' | 'tts' | 'music' | 'video' | 'stt';
//   fields: ParamField[];
//   deprecation?: { date: string; message: string };
// };

const ASPECT_VALUES = [
  { value: '1:1',  label: 'Square (1:1)' },
  { value: '9:16', label: 'Portrait (9:16)' },
  { value: '3:4',  label: 'Portrait (3:4)' },
  { value: '16:9', label: 'Landscape (16:9)' },
  { value: '4:3',  label: 'Landscape (4:3)' },
];

const TTS_VOICES = [
  { value: 'alloy',   label: 'Alloy — neutral, versatile' },
  { value: 'ash',     label: 'Ash — clear, precise' },
  { value: 'coral',   label: 'Coral — warm, conversational' },
  { value: 'echo',    label: 'Echo — clear male' },
  { value: 'fable',   label: 'Fable — expressive, storytelling' },
  { value: 'nova',    label: 'Nova — bright, energetic female' },
  { value: 'onyx',    label: 'Onyx — deep, authoritative male' },
  { value: 'sage',    label: 'Sage — calm, measured' },
  { value: 'shimmer', label: 'Shimmer — gentle, warm female' },
];

const GEMINI_TTS_VOICES = [
  { value: 'Aoede',    label: 'Aoede — warm, lyrical' },
  { value: 'Charon',   label: 'Charon — deep, calm' },
  { value: 'Fenrir',   label: 'Fenrir — bold, expressive' },
  { value: 'Kore',     label: 'Kore — neutral, precise' },
  { value: 'Leda',     label: 'Leda — bright, engaging' },
  { value: 'Orus',     label: 'Orus — authoritative' },
  { value: 'Puck',     label: 'Puck — light, playful' },
  { value: 'Umbriel',  label: 'Umbriel — smooth, warm' },
  { value: 'Zephyr',   label: 'Zephyr — airy, conversational' },
];

const VEO_ASPECT_VALUES = [
  { value: '16:9', label: 'Landscape (16:9)' },
  { value: '9:16', label: 'Portrait (9:16)' },
  { value: '1:1',  label: 'Square (1:1)' },
];

const TTS_SPEED = { key: 'speed', label: 'Speed', widget: 'range', default: 1.0, min: 0.5, max: 2.0, step: 0.05, help: '0.5× (slow) — 2.0× (fast).' };
const TTS_FORMAT = {
  key: 'format', label: 'Format', widget: 'select', default: 'mp3',
  values: [
    { value: 'mp3',  label: 'MP3 (universal)' },
    { value: 'opus', label: 'Opus (best compression)' },
    { value: 'aac',  label: 'AAC' },
    { value: 'flac', label: 'FLAC (lossless)' },
    { value: 'wav',  label: 'WAV (uncompressed)' },
  ],
};

const BUILT_INS = [
  // ── OpenAI image ────────────────────────────────────────────────────────────
  // chatgpt-image-latest — alias for the current flagship; no background transparency
  {
    provider: 'OpenAI',
    model: 'chatgpt-image-latest',
    category: 'image',
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES },
      {
        key: 'quality', label: 'Quality', widget: 'select', default: 'auto',
        values: [
          { value: 'auto',   label: 'Auto (model picks best)' },
          { value: 'low',    label: 'Low — fastest & cheapest' },
          { value: 'medium', label: 'Medium' },
          { value: 'high',   label: 'High — best quality' },
        ],
      },
      {
        key: 'output_format', label: 'Format', widget: 'select', default: 'png',
        values: [
          { value: 'png',  label: 'PNG' },
          { value: 'jpeg', label: 'JPEG (smaller file)' },
          { value: 'webp', label: 'WebP' },
        ],
      },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 4, step: 1 },
    ],
  },
  // gpt-image-2 — does NOT support transparent background (unlike gpt-image-1/1.5)
  {
    provider: 'OpenAI',
    model: 'gpt-image-2',
    category: 'image',
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES },
      {
        key: 'quality', label: 'Quality', widget: 'select', default: 'auto',
        values: [
          { value: 'auto',   label: 'Auto (model picks best)' },
          { value: 'low',    label: 'Low — fastest & cheapest' },
          { value: 'medium', label: 'Medium' },
          { value: 'high',   label: 'High — best quality' },
        ],
      },
      {
        key: 'output_format', label: 'Format', widget: 'select', default: 'png',
        values: [
          { value: 'png',  label: 'PNG' },
          { value: 'jpeg', label: 'JPEG (smaller file)' },
          { value: 'webp', label: 'WebP' },
        ],
      },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 10, step: 1 },
    ],
  },
  // Literal match for gpt-image-1-mini (no quality param; simpler than full schema)
  {
    provider: 'OpenAI',
    model: 'gpt-image-1-mini',
    category: 'image',
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES },
      {
        key: 'output_format', label: 'Format', widget: 'select', default: 'png',
        values: [
          { value: 'png',  label: 'PNG' },
          { value: 'jpeg', label: 'JPEG (smaller file)' },
          { value: 'webp', label: 'WebP' },
        ],
      },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 4, step: 1 },
    ],
  },
  // General gpt-image-* (1, 1.5, 2) — full param set
  {
    provider: 'OpenAI',
    model: 'gpt-image-*',
    category: 'image',
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES },
      {
        key: 'quality', label: 'Quality', widget: 'select', default: 'auto',
        values: [
          { value: 'auto',   label: 'Auto (model picks best)' },
          { value: 'low',    label: 'Low — fastest & cheapest' },
          { value: 'medium', label: 'Medium' },
          { value: 'high',   label: 'High — best quality' },
        ],
      },
      {
        key: 'output_format', label: 'Format', widget: 'select', default: 'png',
        values: [
          { value: 'png',  label: 'PNG' },
          { value: 'jpeg', label: 'JPEG (smaller file)' },
          { value: 'webp', label: 'WebP' },
        ],
      },
      {
        key: 'background', label: 'Transparent background', widget: 'bool', default: false,
        help: 'PNG/WebP only. Supported on gpt-image-1 and gpt-image-1.5; ignored on gpt-image-2.',
      },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 10, step: 1 },
    ],
  },
  {
    provider: 'OpenAI',
    model: 'dall-e-*',
    category: 'image',
    deprecation: {
      date: '2026-05-12',
      message: 'DALL-E models were retired on 2026-05-12. Switch to gpt-image-* for new work.',
    },
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 4, step: 1 },
    ],
  },
  // ── Google Imagen ───────────────────────────────────────────────────────────
  {
    provider: 'Google',
    model: 'imagen-*',
    category: 'image',
    deprecation: {
      date: '2026-06-24',
      message: 'Imagen 3/4 are slated for sunset on 2026-06-24. Switch to gemini-3-pro-image-preview for new work.',
    },
    fields: [
      { key: 'aspectRatio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES },
      { key: 'sampleCount', label: 'Sample count', widget: 'range', default: 1, min: 1, max: 4, step: 1 },
      { key: 'negativePrompt', label: 'Negative prompt', widget: 'multiline', help: 'What the image should avoid.' },
    ],
  },
  // ── Google Gemini image ─────────────────────────────────────────────────────
  // Matches gemini-2.5-flash-image, gemini-3-pro-image-preview, gemini-3.1-flash-image-preview, etc.
  {
    provider: 'Google',
    model: 'gemini-*-image*',
    category: 'image',
    fields: [
      {
        key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '1:1', values: ASPECT_VALUES,
        help: 'Gemini has no dedicated aspect param — the composer encodes this into the prompt.',
      },
      {
        key: 'style_hint', label: 'Style', widget: 'select', default: '',
        values: [
          { value: '',               label: 'Default' },
          { value: 'photorealistic', label: 'Photorealistic' },
          { value: 'oil painting',   label: 'Oil painting' },
          { value: 'watercolor',     label: 'Watercolor' },
          { value: 'digital art',    label: 'Digital art' },
          { value: 'anime',          label: 'Anime / illustration' },
          { value: 'cinematic',      label: 'Cinematic' },
          { value: 'sketch',         label: 'Pencil sketch' },
        ],
        help: 'Appended to your prompt as a style instruction.',
      },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 4, step: 1 },
    ],
  },
  // ── Grok image ──────────────────────────────────────────────────────────────
  {
    provider: 'Grok',
    model: 'grok-*-image*',
    category: 'image',
    fields: [
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 4, step: 1 },
    ],
  },
  // ── Grok video (grok-imagine-video, …) ──────────────────────────────────────
  {
    provider: 'Grok',
    model: 'grok-*-video*',
    category: 'video',
    fields: [
      { key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '16:9', values: VEO_ASPECT_VALUES },
      {
        key: 'duration_secs', label: 'Duration', widget: 'select', default: '6',
        values: [
          { value: '4',  label: '4 s' },
          { value: '6',  label: '6 s' },
          { value: '8',  label: '8 s' },
          { value: '12', label: '12 s' },
        ],
        help: 'Grok Imagine generates short clips. Exact supported durations may vary by tier.',
      },
      { key: 'n', label: 'Count', widget: 'range', default: 1, min: 1, max: 2, step: 1 },
    ],
  },
  // ── Google Veo video ─────────────────────────────────────────────────────────
  {
    provider: 'Google',
    model: 'veo-*',
    category: 'video',
    fields: [
      {
        key: 'aspect_ratio', label: 'Aspect ratio', widget: 'aspect-ratio', default: '16:9', values: VEO_ASPECT_VALUES,
      },
      {
        key: 'duration_secs', label: 'Duration', widget: 'select', default: '8',
        values: [
          { value: '5', label: '5 s' },
          { value: '6', label: '6 s' },
          { value: '7', label: '7 s' },
          { value: '8', label: '8 s (Veo 3 default)' },
        ],
        help: 'Veo 3 generates 8-second clips. Veo 2 accepts 5–8 s.',
      },
      { key: 'negative_prompt', label: 'Avoid', widget: 'text', help: 'Elements to exclude from the video.' },
    ],
  },
  // ── OpenAI TTS ──────────────────────────────────────────────────────────────
  // Literal match for gpt-4o-mini-tts — supports instructions param
  {
    provider: 'OpenAI',
    model: 'gpt-4o-mini-tts',
    category: 'tts',
    fields: [
      { key: 'voice', label: 'Voice', widget: 'select', default: 'alloy', values: TTS_VOICES },
      {
        key: 'instructions', label: 'Voice instructions', widget: 'multiline',
        help: 'Guide delivery: tone, pace, emotion, persona (e.g. "speak slowly and warmly, like a bedtime story narrator").',
      },
      TTS_SPEED,
      TTS_FORMAT,
    ],
  },
  // General tts-* (tts-1, tts-1-hd)
  {
    provider: 'OpenAI',
    model: 'tts-*',
    category: 'tts',
    fields: [
      { key: 'voice', label: 'Voice', widget: 'select', default: 'alloy', values: TTS_VOICES },
      TTS_SPEED,
      TTS_FORMAT,
    ],
  },
  // ── Google Gemini TTS ───────────────────────────────────────────────────────
  // Matches gemini-2.5-flash-preview-tts, gemini-2.5-pro-preview-tts, gemini-3.1-flash-tts-preview
  {
    provider: 'Google',
    model: 'gemini-*tts*',
    category: 'tts',
    fields: [
      { key: 'voice', label: 'Voice', widget: 'select', default: 'Aoede', values: GEMINI_TTS_VOICES },
      {
        key: 'output_format', label: 'Format', widget: 'select', default: 'mp3',
        values: [
          { value: 'mp3',  label: 'MP3' },
          { value: 'wav',  label: 'WAV (lossless)' },
          { value: 'aac',  label: 'AAC' },
          { value: 'flac', label: 'FLAC' },
          { value: 'opus', label: 'Opus' },
        ],
      },
    ],
  },
  // ── Google Lyria music generation ───────────────────────────────────────────
  {
    provider: 'Google',
    model: 'lyria-*',
    category: 'music',
    fields: [
      {
        key: 'style', label: 'Style & genre', widget: 'multiline',
        help: 'Describe the musical style, mood, and instruments (e.g. "upbeat jazz, acoustic piano and upright bass, late night lounge").',
      },
      {
        key: 'negative_style', label: 'Avoid', widget: 'text',
        help: 'Elements to exclude (e.g. "drums, vocals, distortion").',
      },
      { key: 'bpm', label: 'BPM', widget: 'range', default: 120, min: 60, max: 200, step: 1, help: 'Tempo in beats per minute. Lyria may deviate slightly.' },
      { key: 'duration_secs', label: 'Duration (s)', widget: 'range', default: 30, min: 10, max: 120, step: 5 },
    ],
  },
];

// ── Glob match (simple, no escapes — only `*` wildcard) ───────────────────────
function _globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

// Schemas are ranked by specificity: literal > glob count (fewer * is more
// specific). Equal specificity falls back to insertion order.
function _specificity(pattern: string): number {
  if (!pattern.includes('*')) return 1000;
  return 100 - (pattern.match(/\*/g)?.length || 0);
}

// ── Plugin schema discovery (cached) ──────────────────────────────────────────
let _pluginCache: { mtime: number; schemas: any[] } | null = null;

function _skillsDir(): string {
  // Skills now live at bridge/skills/ (shared) — the old in-module path
  // `bridge/modules/skills-editor/skills` was removed. Delegate to the
  // skills-editor lib so the env-var-aware shared root is used.
  try {
    const lib = require('../skills-editor/lib');
    if (typeof lib.metaSkillsDir === 'function') return lib.metaSkillsDir();
  } catch (_) {}
  return path.join(__dirname, '..', '..', 'skills');
}

function _loadPluginSchemas(): any[] {
  const dir = _skillsDir();
  let dirMtime = 0;
  try {
    dirMtime = fs.statSync(dir).mtimeMs;
  } catch (_) {
    return [];
  }
  if (_pluginCache && _pluginCache.mtime === dirMtime) return _pluginCache.schemas;
  const out: any[] = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const schemaFile = path.join(dir, name, 'media-schemas.json');
      if (!fs.existsSync(schemaFile)) continue;
      try {
        const raw = fs.readFileSync(schemaFile, 'utf8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.schemas) ? parsed.schemas : [parsed];
        for (const s of list) {
          if (!s || typeof s !== 'object' || !s.provider || !s.model || !Array.isArray(s.fields)) continue;
          out.push({ ...s, source: 'plugin', pluginName: name });
        }
      } catch (e) {
        logger.warn('media-schemas.plugin-parse-failed', {
          plugin: name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    logger.warn('media-schemas.plugin-scan-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  _pluginCache = { mtime: dirMtime, schemas: out };
  return out;
}

// ── Public surface ────────────────────────────────────────────────────────────

// Map synthetic subscription providers back to the base provider so a single
// schema row covers both API and SUB billing variants of the same model. The
// only thing that changes between them is the auth token; the model id and
// param surface are identical.
function _canonicalProvider(provider: string): string {
  if (!provider) return provider;
  if (provider === 'Anthropic API' || /^Anthropic-SUB\d*$/.test(provider)) return 'Anthropic';
  if (/^OpenAI-SUB\d*$/.test(provider)) return 'OpenAI';
  if (/^Grok-SUB\d*$/.test(provider)) return 'Grok';
  return provider;
}

function resolveSchema(provider: string, model: string): any | null {
  const canon = _canonicalProvider(provider);
  const plugins = _loadPluginSchemas();
  const candidates = [...plugins, ...BUILT_INS.map((s) => ({ ...s, source: 'builtin' }))]
    .filter((s) => s.provider === canon && _globMatch(s.model, model))
    .sort((a, b) => _specificity(b.model) - _specificity(a.model));
  return candidates[0] || null;
}

function listSchemas(): any[] {
  const plugins = _loadPluginSchemas();
  return [
    ...plugins,
    ...BUILT_INS.map((s) => ({ ...s, source: 'builtin' })),
  ];
}

module.exports = {
  resolveSchema,
  listSchemas,
};
