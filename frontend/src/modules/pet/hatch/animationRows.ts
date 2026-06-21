// Animation rows — the single source of truth for frame counts, timings,
// purpose, state-specific prompt rules, and per-frame actions.
//
// Frame *counts* are now uniform: every row uses exactly 9 frames on a
// 3×3 grid (320×320 px per cell inside a 960×960 sheet). Total animation
// *durations* are preserved from the original OpenAI hatch-pet tuning
// (192×208 atlas era); per-frame timings were redistributed across the new
// 9-frame count. See inline `// ≈ N ms total` comments.
//
// BACKWARD COMPATIBILITY — existing pets saved before this change have their
// own frame counts (4–9 frames) stored in their manifests and sliced PNGs on
// disk. The runtime reads frame counts from `manifest.poses[mood].frames`,
// so those pets continue to play unchanged. The 9-frame standard applies to
// *new* /hetch operations only.
//
// `actions[i]` is the i-th frame's beat description (length === frames = 9).
// The wording is intentionally terse — the universal prefix carries
// style/character; each action just describes the new pose. `stateRules` are
// bullet lines injected as `{{state_rules}}` to keep Grok from drawing speed
// lines, halos, and similar artifacts.
//
// `stripLayout` is `{ cols: 3, rows: 3 }` for every row — uniform 320×320
// cells. The wizard composes each row prompt around this layout so Grok
// produces all 9 frames at once. Because all rows share the same cell
// dimensions, no per-row scale compensation is needed at playback time.

import type { PetMood, RowDefinition, RowName, RowToMoodEntry } from './types.js';

export const ROWS: Record<RowName, RowDefinition> = {
  idle: {
    name: 'idle',
    label: 'Idle',
    category: 'state',
    frames: 9,
    durations: [200, 100, 100, 100, 110, 110, 100, 100, 180], // ≈ 1100 ms total
    purpose: 'neutral breathing/blinking loop',
    stateRules: [
      'Show the loop through breath, blink, and tiny pose-step changes only.',
      'Feet stay anchored at the same y across all nine frames.',
    ],
    actions: [
      'Neutral pose, signature prop at rest, eyes open, calm expression.',
      'Same pose, chest lifts slightly as if breathing in, feet anchored.',
      'Shoulders and chest at full breath-in height, gaze steady forward.',
      'Same pose, eyes half-blink, tiny head dip begins.',
      'Eyes closed blink, chest neutral, body still centered.',
      'Eyes open again, head returns level, chest begins to settle.',
      'Signature prop shifts one pixel-step, arm relaxes slightly.',
      'Prop settled, feet anchored, full exhale in posture.',
      'Relaxed return frame matching frame 01 for a seamless loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  thinking: {
    name: 'thinking',
    label: 'Thinking',
    category: 'state',
    frames: 9,
    durations: [120, 100, 100, 110, 110, 100, 100, 100, 190], // ≈ 1030 ms total
    purpose: 'focused inspecting / thinking loop',
    stateRules: [
      'Show focus through lean, blink, narrowed eyes, head tilt, or paw position.',
      'Do not add magnifying glasses, papers, code, UI, punctuation, or new symbols. Focus must read from pose alone.',
    ],
    actions: [
      'Signature prop at rest, one fist near chin, focused eyes.',
      'Head tilts slightly left, prop still planted, feet anchored.',
      'Eyes narrow, torso leans forward slightly.',
      'Tiny blink while keeping the same silhouette.',
      'Eyes open, head holds the left tilt, expression intent.',
      'Gaze shifts forward, slight posture reset, prop steady.',
      'Head tilts slightly right, prop barely shifts.',
      'Eyes narrow slightly, brow furrows.',
      'Return to frame 01 posture for a seamless loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  streaming: {
    name: 'streaming',
    label: 'Streaming',
    category: 'state',
    frames: 9,
    durations: [80, 90, 90, 90, 90, 90, 80, 80, 130], // ≈ 820 ms total
    purpose: 'in-place busy-streaming pulse',
    stateRules: [
      'Show busy work through prop motion and body lean only.',
      'Allowed: small attached opaque highlight on the signature prop in frames 2–7, hard-edged, pixel-style. No detached glow.',
    ],
    actions: [
      'Both hands engage signature prop at chest height, focused expression.',
      'Prop raised a little, tiny hard-edged highlight attached to the prop.',
      'Torso leans into the work, highlight slightly brighter, still attached.',
      'Eyes narrow, character leans forward, highlight builds.',
      'Prop fully engaged, highlight at peak intensity, body at furthest lean.',
      'Prop lowers slightly, highlight shrinks, body starts to ease back.',
      'Torso returns toward neutral, prop descends further.',
      'Highlight gone, hands still on prop at middle height.',
      'Return to frame 01 posture for a seamless loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  error: {
    name: 'error',
    label: 'Error',
    category: 'state',
    frames: 9,
    durations: [120, 130, 130, 130, 130, 120, 120, 120, 240], // ≈ 1240 ms total
    purpose: 'sad or deflated reaction loop',
    stateRules: [
      'Show failure through slumped pose, drooping limbs, closed or sad eyes, lower body position.',
      'One small attached smoke puff or tear is allowed at frame 5 only — must touch or overlap the body, hard-edged, opaque.',
      'Do not draw red X marks, floating symbols, detached stars, separated smoke clouds, falling tear drops, dust, or other loose effects.',
    ],
    actions: [
      'Confident stance interrupted, eyes widen.',
      'Slight backward stumble, prop drops a little but stays in hand.',
      'Off-balance pose, body tilts.',
      'Sad deflated face, shoulders lower.',
      'One tiny attached smoke puff or tear touching the body, hard-edged.',
      'Blink with sad eyes, body partially regains balance.',
      'Prop returns toward safer position, still drooping.',
      'Shoulders recovering, eyes open but mildly embarrassed.',
      'Near-neutral return pose for a seamless loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  happy: {
    name: 'happy',
    label: 'Happy',
    category: 'state',
    frames: 9,
    durations: [60, 70, 70, 70, 80, 80, 70, 70, 130], // ≈ 700 ms total
    purpose: 'greeting gesture with raised wave and return',
    stateRules: [
      'Show the wave through paw pose only.',
      'Do not draw wave marks, motion arcs, lines, sparkles, or symbols around the paw.',
    ],
    actions: [
      'Neutral friendly stance, prop safely at side.',
      'Free hand begins to lift from the side.',
      'Hand rises to shoulder height, friendly expression.',
      'Hand lifts into a clear wave pose, elbow bent.',
      'Hand reaches highest friendly wave, smiling face.',
      'Hand holds peak wave, eyes bright.',
      'Hand begins to lower from peak.',
      'Hand returns halfway down, still friendly.',
      'Hand fully down, back near neutral, ready to loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  jumping: {
    name: 'jumping',
    label: 'Jumping',
    category: 'locomotion',
    frames: 9,
    durations: [80, 90, 80, 80, 80, 80, 90, 80, 180], // ≈ 840 ms total
    purpose: 'anticipation, lift, peak, descent, settle',
    stateRules: [
      'Show vertical motion through body position only.',
      'Do not draw shadows, dust, landing marks, impact bursts, bounce pads, or floor cues.',
    ],
    actions: [
      'Anticipation crouch, knees bent, prop close to body.',
      'Deeper crouch, knees fully bent, energy coiling.',
      'Lift-off pose, body begins to rise, feet leaving ground.',
      'Rising pose, feet compact, body still climbing.',
      'Peak pose, happy face, feet highest, body centered.',
      'Descent begins, knees prepare to absorb landing.',
      'Descending pose, body lowers, feet extending toward ground.',
      'Near-landing, knees flexed, arms adjusting balance.',
      'Settled happy stance, no dust or shadow.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  // running: the SINGLE canonical horizontal locomotion row (right-facing).
  // Left motion uses the per-pet flipRun toggle + CSS scaleX(-1) on these
  // same frames. No running-left / running-front variants in the Codex 9.
  running: {
    name: 'running',
    label: 'Running',
    category: 'locomotion',
    frames: 9,
    durations: [110, 110, 110, 110, 110, 110, 100, 100, 200], // ≈ 1060 ms total
    purpose: 'rightward locomotion loop',
    stateRules: [
      'Show locomotion through body, limb, and prop movement only.',
      'Do not draw speed lines, dust clouds, floor shadows, or motion trails.',
      'All frames face right; the cape/hair/effects trail leftward.',
    ],
    actions: [
      'Right-facing ready run pose, prop held compactly.',
      'First step forward, front foot extends, body leans right.',
      'Passing step, torso compressed slightly.',
      'Second stride, back foot pushes off.',
      'Stretched stride, prop remains inside the body silhouette.',
      'Recovery step, head and torso bob slightly.',
      'Third stride, front foot forward again.',
      'Recovery passing pose, body compresses.',
      'Loop bridge matching frame 01.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  powermove: {
    name: 'powermove',
    label: 'Power Move',
    category: 'action',
    frames: 9,
    durations: [100, 110, 120, 130, 130, 170, 160, 140, 200], // ≈ 1260 ms total
    purpose: 'YHA signature big-move loop',
    stateRules: [
      'Big heroic move using the signature prop. Allowed: attached charge or signature glyph touching the prop tip from frame 4 onward, opaque, hard-edged, pixel-style.',
      'Do not draw detached lightning bolts, floating sparks, halos, lens flares, ground impact, dust, or speedlines.',
      'The attached charge color must contrast with the prop and the character, and may not be #FF00FF or near-magenta.',
    ],
    actions: [
      'Anticipation, feet planted, prop gripped at chest height.',
      'Prop rising diagonally upward, body leans back.',
      'Prop above shoulder height, eyes determined, feet widen.',
      'Prop fully overhead, cape lifts slightly.',
      'Small hard-edged charge highlight touching the prop tip only.',
      'Prop fully overhead, brighter attached charge along the prop.',
      'Heroic peak pose, tiny attached signature glyph touches the prop only, no separated effect.',
      'Charge fades while prop stays high, cape settling.',
      'Triumphant recovery pose, prop still raised but calm.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  fighting: {
    name: 'fighting',
    label: 'Fighting',
    category: 'action',
    frames: 9,
    // 9 beats: anticipate, lunge in, big horizontal arc, recovery, loop.
    // Slightly longer hold on the strike apex (frame 5) so the impact reads.
    durations: [120, 110, 110, 110, 160, 120, 120, 130, 220], // ≈ 1200 ms total
    purpose: 'tool-call combat loop',
    stateRules: [
      'Full horizontal combat sequence with the signature prop. The strike sweeps left-to-right across the cell; the square 320×320 cell gives room for the arc.',
      'Allowed: one attached impact highlight on the prop at frame 5 only (the apex), hard-edged, opaque, pixel-style.',
      'No motion arcs, no speed lines, no impact stars, no opponent, no scenery, no afterimages.',
    ],
    actions: [
      'Ready stance, weight centered, prop held compactly at the side, focused eyes.',
      'Wind-up: weight shifts to back foot, prop draws back across the body, shoulder coiled.',
      'Lunge: front foot lands forward, torso starts to rotate, prop begins its horizontal travel.',
      'Mid-arc: prop sweeps across in front of the chest, cape trails, both feet planted wide.',
      'Strike apex: prop fully extended horizontally to the strong side, hard-edged impact highlight attached to the prop tip, eyes intense.',
      'Follow-through: prop continues past the apex, torso fully rotated, cape billows behind, no detached effect.',
      'Recovery: prop trails downward, weight starts shifting back to center, eyes still focused.',
      'Guard return: prop pulled back to a defensive ready, feet realigned, breathing pose.',
      'Loop bridge matching frame 01 for a seamless loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },

  xpeffect: {
    name: 'xpeffect',
    label: 'XP Effect',
    category: 'action',
    frames: 9,
    durations: [80, 80, 90, 90, 90, 90, 80, 80, 160], // ≈ 840 ms total
    purpose: 'reward burst / happy bounce loop',
    stateRules: [
      'Happy heroic bounce. Allowed: tiny attached stars overlapping the body in frames 2–6 only. Hard-edged, pixel-style.',
      'Stars must touch the body, not float around it. No glow, no halo.',
    ],
    actions: [
      'Happy stance, eyes bright, prop at side.',
      'Small bounce begins, cape lifts slightly.',
      'Rising bounce, one tiny attached star on the shoulder.',
      'Highest bounce, smiling face, two attached stars on cheeks/shoulders.',
      'At peak, stars at maximum brightness.',
      'Descending, knees bend slightly, one attached star fading.',
      'Near landing, last star fading.',
      'Lands softly, no shadow or dust, stars gone.',
      'Return to happy stance for a seamless loop.',
    ],
    stripLayout: { cols: 3, rows: 3 },
  },
};

/**
 * Map row → primary pose mood + optional aliases. The pet manifest serves
 * a pose; the row provides the frames. After the Codex-9 vocabulary
 * cleanup the row name == primary mood name, so most entries are 1:1.
 * Aliases keep the YHA-extras (reconnecting, fighting) covered via
 * fallback when a pet doesn't ship the deferred extra rows.
 */
export const ROW_TO_MOOD: RowToMoodEntry[] = [
  // ── State rows ─────────────────────────────────────────────────────────
  { row: 'idle',     primary: 'idle' },
  { row: 'thinking', primary: 'thinking', alias: ['reconnecting'] },
  { row: 'streaming', primary: 'streaming' },
  { row: 'error',    primary: 'error' },
  { row: 'happy',    primary: 'happy' },
  // ── Action rows ────────────────────────────────────────────────────────
  { row: 'powermove', primary: 'powermove', alias: ['fighting'] },
  { row: 'xpeffect',  primary: 'xpeffect' },
  // ── Locomotion rows ────────────────────────────────────────────────────
  // jumping → own 'jumping' locomotion mood. Alias keeps the bounce-like
  // fallback path for happy/xpeffect pets without a dedicated jumping row.
  { row: 'jumping', primary: 'jumping', alias: ['happy', 'xpeffect'] },
  // running: the SINGLE canonical horizontal locomotion sheet. Left-direction
  // motion uses the per-pet flipRun toggle + CSS scaleX(-1) on these frames.
  { row: 'running', primary: 'running' },
  // ── YHA-extras (deferred, in ROWS but not in current plans) ────────────
  { row: 'fighting', primary: 'fighting' },
];

/** Compute the primary mood served by a row. Returns null when the row
 * is not directly mood-bound (e.g. front-facing running locomotion). */
export function rowMood(row: RowName): PetMood | null {
  const entry = ROW_TO_MOOD.find((e) => e.row === row);
  return entry ? entry.primary : null;
}
