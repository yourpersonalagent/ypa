// modeIcons — Lucide React components for the four composer modes.
// One source of truth shared by the composer mode switcher, the model
// picker's active-strip cards, and any future status surface. Matches the
// monocolor convention from docs/YHA-icon-design.md (currentColor stroke,
// 1.75 width via lucide-react defaults).

import { MessageCircle, ImageIcon, Music, Video } from '../chat/icons.js';
import type { ComposerMode } from '../stores/appStore.js';
import type { ModelCategory } from '../models/categories.js';

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function ComposerModeIcon({
  mode,
  size = 14,
  strokeWidth = 1.75,
  className,
}: { mode: ComposerMode } & IconProps) {
  const props = { size, strokeWidth, className };
  switch (mode) {
    case 'chat':  return <MessageCircle {...props} />;
    case 'image': return <ImageIcon     {...props} />;
    case 'audio': return <Music         {...props} />;
    case 'video': return <Video         {...props} />;
  }
}

// Map a model category to the composer mode it belongs to.
// Audio sub-categories (tts/stt/music/realtime) collapse into 'audio' so the
// shared icon set covers them without growing.
export function modeForCategory(category: ModelCategory | string | undefined): ComposerMode | null {
  switch (category) {
    case 'llm': return 'chat';
    case 'image': return 'image';
    case 'video': return 'video';
    case 'tts':
    case 'stt':
    case 'music':
    case 'realtime':
    case 'audio': return 'audio';
    default: return null;
  }
}

export function CategoryIcon({
  category,
  size = 14,
  strokeWidth = 1.75,
  className,
}: { category: ModelCategory | string | undefined } & IconProps) {
  const mode = modeForCategory(category);
  if (!mode) return null;
  return <ComposerModeIcon mode={mode} size={size} strokeWidth={strokeWidth} className={className} />;
}
