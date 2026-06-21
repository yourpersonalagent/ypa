// Shared category metadata for the model picker, prefs UI, and any future
// surface that needs to display or override a model's category.
//
// Categories mirror bridge/models/detect.ts:detectModelCategory(). Keep the
// list in sync — bridge is authoritative for detection, this module is the
// frontend-side display + override vocabulary.

export type ModelCategory =
  | 'llm'
  | 'image'
  | 'video'
  | 'tts'
  | 'stt'
  | 'music'
  | 'realtime'
  | 'embedding'
  | 'code-embedding'
  | 'rerank'
  | 'moderation'
  | 'unknown';

export const MODEL_CATEGORIES: ModelCategory[] = [
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

export const CATEGORY_LABELS: Record<ModelCategory, string> = {
  'llm': 'Chat / LLM',
  'image': 'Image generation',
  'video': 'Video generation',
  'tts': 'Text-to-speech',
  'stt': 'Speech-to-text',
  'music': 'Music generation',
  'realtime': 'Realtime voice',
  'embedding': 'Embedding',
  'code-embedding': 'Code embedding',
  'rerank': 'Reranker',
  'moderation': 'Moderation',
  'unknown': 'Unknown',
};

export interface CategoryBadge {
  label: string;
  // Bucket maps to a CSS class suffix (.ms-chip-badge.<bucket>).
  // 'llm' returns null — chat models stay unbadged to keep the picker dense.
  bucket: 'img' | 'vid' | 'aud' | 'util' | 'unk';
}

export function categoryBadge(category: string | undefined): CategoryBadge | null {
  switch (category) {
    case 'image': return { label: 'IMG', bucket: 'img' };
    case 'video': return { label: 'VID', bucket: 'vid' };
    case 'tts': return { label: 'TTS', bucket: 'aud' };
    case 'stt': return { label: 'STT', bucket: 'aud' };
    case 'music': return { label: 'MUS', bucket: 'aud' };
    case 'realtime': return { label: 'RT', bucket: 'aud' };
    case 'embedding': return { label: 'EMB', bucket: 'util' };
    case 'code-embedding': return { label: 'CDE', bucket: 'util' };
    case 'rerank': return { label: 'RNK', bucket: 'util' };
    case 'moderation': return { label: 'MOD', bucket: 'util' };
    case 'unknown': return { label: '?', bucket: 'unk' };
    default: return null;
  }
}
