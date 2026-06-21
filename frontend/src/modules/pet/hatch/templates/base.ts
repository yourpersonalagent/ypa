// Canonical base prompt — the identity-lock T-pose.
//
// The wizard's step 2 renders this and asks the user to copy → Grok →
// upload → confirm before any rows are generated. Every later prompt
// references this image as the visual definition.

export const BASE_TEMPLATE = `Create the canonical base reference sprite for the YHA digital pet \`{{character.name}}\`.

This single 960×960 PNG becomes the identity lock for every later frame. Get it right — every animation frame will reference this image.

Character: {{character.silhouette}}, {{character.palette}}, {{character.props}}. {{character.faceLanguage}}. {{character.styleNotes}}

Pose: neutral T-pose. Character stands centered, facing camera, weight even on both feet, arms relaxed at the sides or holding the signature prop in a relaxed grip. Eyes open. Calm friendly expression.

Style contract: YHA digital pet sprite style — pixel-art-adjacent, chunky readable silhouette, thick dark 1–2 px outline, visible stepped/pixel edges, limited palette, flat cel shading with at most one small highlight and one shadow step, simple expressive face, tiny limbs. It must read clearly as a small animated app companion, not polished illustration, anime key art, vector mascot, 3D render, glossy app icon, realistic painting, or detailed comic cover.

Canvas: 960×960 px. The character is roughly 560–700 px tall, with feet anchored near y = 770 (about 90 px above the bottom edge). Side padding ≥ 90 px. Top padding ≥ 90 px. The full body must be visible — no cropping of head, prop, cape, or feet.

Background: perfectly flat pure #FF00FF chroma-key magenta across the entire image. No checkerboard transparency, no texture, no gradient, no shadow, no glow, no floor plane, no lighting variation, and no scenery.

Forbidden inside the character: #FF00FF or any near-magenta color. The chroma-key pass would remove those pixels and leave holes.

Forbidden everywhere: text, labels, watermarks, frame numbers, borders, UI panels, grid lines, speech bubbles, thought bubbles, scenery, ground plane, horizon, motion blur, speed lines, motion arcs, afterimages, detached sparks, detached smoke, detached stars, loose particles, cast shadows, contact shadows, floor marks, halos, large aura.

Output: one PNG, 960×960, one centered full-body pose only.`;
