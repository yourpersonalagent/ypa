// Lucide icon registry for chat content markers.
// Two consumers: JSX (use the React components below) and HTML-string builders
// (use iconSvg(name) — returns an <svg> string with currentColor stroke).
// Icon node data mirrors lucide-react v1.14 exactly so both paths render identically.

import {
  Settings,
  CornerDownRight,
  ArrowUp,
  ArrowDown,
  Bot,
  TriangleAlert,
  CircleHelp,
  Lock,
  Key,
  Image as ImageIcon,
  Folder,
  FileText,
  Hexagon,
  Pin,
  PinOff,
  MessageCircle,
  Music,
  Video,
  Save,
  Plus,
  Zap,
  Pencil,
  RotateCw,
  X,
} from 'lucide-react';

export {
  Settings,
  CornerDownRight,
  ArrowUp,
  ArrowDown,
  Bot,
  TriangleAlert,
  CircleHelp,
  Lock,
  Key,
  ImageIcon,
  Folder,
  FileText,
  Hexagon,
  Pin,
  PinOff,
  MessageCircle,
  Music,
  Video,
  Save,
  Plus,
  Zap,
  Pencil,
  RotateCw,
  X,
};

type IconNodeEntry = [string, Record<string, string | number>];
type IconNode = IconNodeEntry[];

const NODES: Record<string, IconNode> = {
  settings: [
    ['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  'corner-down-right': [
    ['path', { d: 'm15 10 5 5-5 5' }],
    ['path', { d: 'M4 4v7a4 4 0 0 0 4 4h12' }],
  ],
  'arrow-up': [
    ['path', { d: 'm5 12 7-7 7 7' }],
    ['path', { d: 'M12 19V5' }],
  ],
  'arrow-down': [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'm19 12-7 7-7-7' }],
  ],
  bot: [
    ['path', { d: 'M12 8V4H8' }],
    ['rect', { width: '16', height: '12', x: '4', y: '8', rx: '2' }],
    ['path', { d: 'M2 14h2' }],
    ['path', { d: 'M20 14h2' }],
    ['path', { d: 'M15 13v2' }],
    ['path', { d: 'M9 13v2' }],
  ],
  'triangle-alert': [
    ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  'circle-help': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  'circle-alert': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', { x1: '12', x2: '12', y1: '8', y2: '12' }],
    ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16' }],
  ],
  lock: [
    ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }],
  ],
  key: [
    ['path', { d: 'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4' }],
    ['path', { d: 'm21 2-9.6 9.6' }],
    ['circle', { cx: '7.5', cy: '15.5', r: '5.5' }],
  ],
  image: [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2', ry: '2' }],
    ['circle', { cx: '9', cy: '9', r: '2' }],
    ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }],
  ],
  folder: [
    ['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }],
  ],
  'file-text': [
    ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M10 9H8' }],
    ['path', { d: 'M16 13H8' }],
    ['path', { d: 'M16 17H8' }],
  ],
  hexagon: [
    ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z' }],
  ],
  'hexagon-filled': [
    ['path', { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', fill: 'currentColor' }],
  ],
  'circle-dot': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['circle', { cx: '12', cy: '12', r: '4' }],
  ],
  'circle-dot-filled': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['circle', { cx: '12', cy: '12', r: '5', fill: 'currentColor' }],
  ],
  smile: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M8 14s1.5 2 4 2 4-2 4-2' }],
    ['line', { x1: '9', x2: '9.01', y1: '9', y2: '9' }],
    ['line', { x1: '15', x2: '15.01', y1: '9', y2: '9' }],
  ],
  frown: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M16 16s-1.5-2-4-2-4 2-4 2' }],
    ['line', { x1: '9', x2: '9.01', y1: '9', y2: '9' }],
    ['line', { x1: '15', x2: '15.01', y1: '9', y2: '9' }],
  ],
  laugh: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z' }],
    ['line', { x1: '9', x2: '9.01', y1: '9', y2: '9' }],
    ['line', { x1: '15', x2: '15.01', y1: '9', y2: '9' }],
  ],
  angry: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M16 16s-1.5-2-4-2-4 2-4 2' }],
    ['path', { d: 'M7.5 8 10 9' }],
    ['path', { d: 'm14 9 2.5-1' }],
    ['path', { d: 'M9 10h.01' }],
    ['path', { d: 'M15 10h.01' }],
  ],
  meh: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', { x1: '8', x2: '16', y1: '15', y2: '15' }],
    ['line', { x1: '9', x2: '9.01', y1: '9', y2: '9' }],
    ['line', { x1: '15', x2: '15.01', y1: '9', y2: '9' }],
  ],
  'thumbs-up': [
    ['path', { d: 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z' }],
    ['path', { d: 'M7 10v12' }],
  ],
  'thumbs-down': [
    ['path', { d: 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z' }],
    ['path', { d: 'M17 14V2' }],
  ],
  heart: [
    ['path', { d: 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5' }],
  ],
  'heart-crack': [
    ['path', { d: 'M12.409 5.824c-.702.792-1.15 1.496-1.415 2.166l2.153 2.156a.5.5 0 0 1 0 .707l-2.293 2.293a.5.5 0 0 0 0 .707L12 15' }],
    ['path', { d: 'M13.508 20.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5a5.5 5.5 0 0 1 9.591-3.677.6.6 0 0 0 .818.001A5.5 5.5 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5z' }],
  ],
  check: [
    ['path', { d: 'M20 6 9 17l-5-5' }],
  ],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  lightbulb: [
    ['path', { d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' }],
    ['path', { d: 'M9 18h6' }],
    ['path', { d: 'M10 22h4' }],
  ],
  flame: [
    ['path', { d: 'M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4' }],
  ],
  'party-popper': [
    ['path', { d: 'M5.8 11.3 2 22l10.7-3.79' }],
    ['path', { d: 'M4 3h.01' }],
    ['path', { d: 'M22 8h.01' }],
    ['path', { d: 'M15 2h.01' }],
    ['path', { d: 'M22 20h.01' }],
    ['path', { d: 'm22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10' }],
    ['path', { d: 'm22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17' }],
    ['path', { d: 'm11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7' }],
    ['path', { d: 'M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z' }],
  ],
  rocket: [
    ['path', { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' }],
    ['path', { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09' }],
    ['path', { d: 'M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z' }],
    ['path', { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05' }],
  ],
  pin: [
    ['path', { d: 'M12 17v5' }],
    ['path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z' }],
  ],
  // Filled pin — same silhouette as `pin`, with the head/body filled.
  // Convention: YHA uses the filled variant to mark the active/on state of
  // a toggle that shares its inactive silhouette (pin, star, bookmark…).
  'pin-filled': [
    ['path', { d: 'M12 17v5' }],
    ['path', { d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z', fill: 'currentColor' }],
  ],
  // Pin with a diagonal slash — explicit "click-to-unpin" affordance for
  // contexts where the active-state-via-fill convention isn't appropriate.
  'pin-off': [
    ['path', { d: 'M12 17v5' }],
    ['path', { d: 'M15 9.34V6h1a2 2 0 0 0 0-4H7.89' }],
    ['path', { d: 'M9.76 6.34a2 2 0 0 0-.06.43V10c0 .91-.6 1.7-1.46 1.96a3.86 3.86 0 0 0-1.06.55C5.51 13.71 6.18 17 8.74 17H15' }],
    ['path', { d: 'm2 2 20 20' }],
  ],
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
  ],
  star: [
    ['path', { d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' }],
  ],
  bell: [
    ['path', { d: 'M10.268 21a2 2 0 0 0 3.464 0' }],
    ['path', { d: 'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326' }],
  ],
  save: [
    ['path', { d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }],
    ['path', { d: 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7' }],
    ['path', { d: 'M7 3v4a1 1 0 0 0 1 1h7' }],
  ],
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }],
  ],
  zap: [
    ['path', { d: 'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z' }],
  ],
  pencil: [
    ['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }],
    ['path', { d: 'm15 5 4 4' }],
  ],
  'rotate-cw': [
    ['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
  ],
};

export type IconName = keyof typeof NODES;

export function iconSvg(name: IconName, size = 14, strokeWidth = 1.75): string {
  const node = NODES[name];
  if (!node) return '';
  const inner = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${String(v)}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ` +
    `class="lucide lucide-${name}" aria-hidden="true">${inner}</svg>`
  );
}

// ── Emoji → Lucide map (Stage 1) ────────────────────────────────────────────

// Curated map of common chat emojis to Lucide icons. Order matters: longer
// keys (e.g. with skin-tone modifiers or U+FE0F variation selectors) must come
// before shorter ones, so the regex matches them first.
const EMOJI_MAP: Record<string, IconName> = {
  // Faces — happy
  '😀': 'smile', '😃': 'smile', '😄': 'smile', '😁': 'smile',
  '🙂': 'smile', '😊': 'smile', '☺️': 'smile', '☺': 'smile',
  '😉': 'smile', '😎': 'smile',
  // Faces — sad
  '😢': 'frown', '😭': 'frown', '☹️': 'frown', '☹': 'frown',
  '🙁': 'frown', '😞': 'frown',
  // Faces — laughing
  '😂': 'laugh', '🤣': 'laugh', '😆': 'laugh',
  // Faces — angry
  '😡': 'angry', '😠': 'angry', '🤬': 'angry',
  // Faces — neutral
  '😐': 'meh', '😑': 'meh', '🫤': 'meh',
  // Thumbs (with skin tones)
  '👍🏻': 'thumbs-up', '👍🏼': 'thumbs-up', '👍🏽': 'thumbs-up',
  '👍🏾': 'thumbs-up', '👍🏿': 'thumbs-up', '👍': 'thumbs-up',
  '👎🏻': 'thumbs-down', '👎🏼': 'thumbs-down', '👎🏽': 'thumbs-down',
  '👎🏾': 'thumbs-down', '👎🏿': 'thumbs-down', '👎': 'thumbs-down',
  // Hearts
  '❤️': 'heart', '❤': 'heart', '💕': 'heart', '💗': 'heart',
  '💓': 'heart', '💖': 'heart', '💘': 'heart', '♥️': 'heart', '♥': 'heart',
  '💔': 'heart-crack',
  // Status — check / x
  '✅': 'check', '✔️': 'check', '✔': 'check', '☑️': 'check', '☑': 'check',
  '❌': 'x', '✖️': 'x', '✖': 'x', '✗': 'x',
  // Alerts
  '⚠️': 'triangle-alert', '⚠': 'triangle-alert',
  '❓': 'circle-help', '❔': 'circle-help',
  '❗': 'circle-alert', '❕': 'circle-alert', '‼️': 'circle-alert', '‼': 'circle-alert',
  // Misc common
  '💡': 'lightbulb',
  '🔥': 'flame',
  '🎉': 'party-popper', '🎊': 'party-popper',
  '🚀': 'rocket',
  '📌': 'pin', '📍': 'pin',
  '🔗': 'link',
  '⭐': 'star', '🌟': 'star', '✨': 'star',
  '🔔': 'bell',
  '🔒': 'lock', '🔐': 'lock',
  '🔑': 'key',
  '⚙️': 'settings', '⚙': 'settings',
  '🖼️': 'image', '🖼': 'image',
  '📁': 'folder', '📂': 'folder',
  '📄': 'file-text', '📃': 'file-text',
  '⬡': 'hexagon', '⬢': 'hexagon',
};

// Build a regex from EMOJI_MAP keys, longest first so multi-codepoint matches
// (e.g. 👍🏻, ❤️) win over shorter prefixes (👍, ❤).
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const EMOJI_KEYS_SORTED = Object.keys(EMOJI_MAP).sort((a, b) => b.length - a.length);
const EMOJI_MAP_RE = new RegExp(EMOJI_KEYS_SORTED.map(escRe).join('|'), 'g');

// Stage 2 — wrap any remaining pictographic emojis (incl. ZWJ sequences and
// skin-tone modifiers) in a span the CSS grayscales.
const ANY_EMOJI_RE = /\p{Extended_Pictographic}(\p{Emoji_Modifier}|️)*(‍\p{Extended_Pictographic}(\p{Emoji_Modifier}|️)*)*/gu;

// ── Pipeline ────────────────────────────────────────────────────────────────

// Splits HTML into ordered tag/text chunks while tracking <code>/<pre> depth so
// we don't transform code-block contents. Mirrors the text-node-aware pattern
// in chatUtils.injectExchangePreviews but adds code-fence awareness.
function transformTextNodes(html: string, transform: (text: string) => string): string {
  const out: string[] = [];
  const re = /<\/?([a-zA-Z][\w-]*)\b[^>]*>|<[^>]+>|[^<]+/g;
  let inCode = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const chunk = m[0];
    if (chunk[0] === '<') {
      const tagName = m[1]?.toLowerCase();
      if (tagName === 'code' || tagName === 'pre') {
        if (chunk[1] === '/') inCode = Math.max(0, inCode - 1);
        else if (!chunk.endsWith('/>')) inCode++;
      }
      out.push(chunk);
    } else {
      out.push(inCode ? chunk : transform(chunk));
    }
  }
  return out.join('');
}

// Dual-purpose pictographic chars where Unicode's default is text presentation
// (Emoji_Presentation=No) — e.g. ↔ ↕ ™ © ® ↩ ↪. Chromium may still pick a
// color-emoji font for these, which on this Pi renders them as near-black
// glyphs that disappear on dark bubble backgrounds. Appending U+FE0E (VS15)
// forces text presentation, so they paint in currentColor via the text font
// stack (DejaVu Sans via TextSymbolFallback @font-face for arrow ranges).
const TEXT_DEFAULT_PICTO_RE = /(\p{Extended_Pictographic})(?![︎️])/gu;

export function monochromizeEmojis(html: string): string {
  return transformTextNodes(html, (text) => {
    // Stage 1: substitute curated emojis with Lucide SVG icons.
    let s = text.replace(EMOJI_MAP_RE, (e) => {
      const name = EMOJI_MAP[e];
      if (!name) return e;
      // 16px so it sits well next to surrounding text. .lucide-emoji class
      // is for CSS targeting (vertical-align tweak).
      return iconSvg(name, 16).replace('class="lucide ', 'class="lucide lucide-emoji ');
    });
    // Stage 1.5: force text presentation on text-default pictographic chars.
    s = s.replace(TEXT_DEFAULT_PICTO_RE, (char) => {
      // Skip if the char also has emoji presentation by default (genuine
      // color emoji like 🚀 👍 — those should keep emoji rendering).
      if (/\p{Emoji_Presentation}/u.test(char)) return char;
      return char + '︎';
    });
    // Stage 2: wrap any remaining pictographic emojis for CSS grayscale.
    s = s.replace(ANY_EMOJI_RE, (e) => `<span class="emoji-mono">${e}</span>`);
    return s;
  });
}
