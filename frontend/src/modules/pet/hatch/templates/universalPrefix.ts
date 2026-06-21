// Universal style + identity prefix used by every hatch prompt.
//
// Char-agnostic. The character spec is interpolated via `{{character.*}}`
// slots, so this prefix is identical for He-Man, a goblin, or a robot.

export const UNIVERSAL_PREFIX = `Create one square 960×960 PNG sprite frame for the YHA floating desktop pet \`{{character.name}}\`.

Character identity: {{character.silhouette}}, {{character.palette}}, {{character.props}}. {{character.faceLanguage}}. {{character.styleNotes}} Keep the exact same head shape, face, palette, body proportions, prop design, and silhouette across every frame. Treat the attached canonical-base image and any continuity reference as the authoritative visual definition.

Style contract: YHA digital pet sprite style — pixel-art-adjacent, chunky readable silhouette, thick dark 1–2 px outline, visible stepped/pixel edges, limited palette, flat cel shading with at most one small highlight and one shadow step, simple expressive face, tiny limbs. It must read clearly as a small animated app companion, not polished illustration, anime key art, vector mascot, 3D render, glossy app icon, realistic painting, or detailed comic cover.

Canvas and anchor: one centered full-body pose only. Keep the feet anchored near the same bottom-center point in every frame from this row. Keep the character roughly 560–700 px tall inside the 960×960 canvas, with at least 90 px padding on every side. Do not crop the prop, hair, cape, or feet.

Background and cleanup: use a perfectly flat pure #FF00FF chroma-key background across the entire image. The background must be one uniform color with no checkerboard transparency, no texture, no gradient, no shadow, no glow, no floor plane, no lighting variation, and no scenery. Do not use #FF00FF or near-magenta colors anywhere in the character, prop, highlights, shadows, or effects.

Animation rules: this is one frame from a planned animation row. Change only pose, expression, limb position, prop position, and body height. No text, no watermark, no frame numbers, no borders, no UI, no grid. No motion blur, speed lines, motion arcs, afterimages, detached sparks, detached smoke, detached stars, loose particles, speech bubbles, thought bubbles, cast shadows, contact shadows, floor marks, halos, or large aura.`;
