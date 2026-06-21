// Single-frame prompt — re-roll a specific frame at full 960×960.
//
// Used when one frame inside a strip looked off (drift, cropping, wrong
// pose). The user generates a replacement at full resolution; the wizard
// drops it into the row at the chosen index, replacing the sliced cell.

export const SINGLE_FRAME_TEMPLATE = `Create one square 960×960 PNG sprite frame for the YHA digital pet \`{{character.name}}\`.

This is a re-roll of frame {{frame_number}} of {{frame_total}} from the \`{{row}}\` animation row. The other frames already exist; match the canonical base reference and the existing row exactly.

Character identity: {{character.silhouette}}, {{character.palette}}, {{character.props}}. {{character.faceLanguage}}. {{character.styleNotes}} Keep the exact same head shape, face, palette, body proportions, prop design, and silhouette as the canonical base. Treat the attached canonical-base image as the authoritative visual definition.

Frame action: {{frame_action}}

Row purpose: {{row_purpose}}.

State-specific rules:
{{state_rules}}

Style contract: YHA digital pet sprite style — pixel-art-adjacent, chunky readable silhouette, thick dark 1–2 px outline, visible stepped/pixel edges, limited palette, flat cel shading with at most one small highlight and one shadow step, simple expressive face, tiny limbs.

Canvas and anchor: one centered full-body pose only. Feet anchored near y = 770 (≈ 90 px above the bottom edge). Body roughly 560–700 px tall. Side padding ≥ 90 px. Top padding ≥ 90 px. Do not crop the prop, hair, cape, or feet.

Background: perfectly flat pure #FF00FF chroma-key magenta across the entire image. No checkerboard transparency, no texture, no gradient, no shadow, no glow, no floor plane, no lighting variation, no scenery.

Identity lock:
- Do not redesign the pet. Only change pose/action.
- Preserve the exact head shape, face design, palette, outline weight, body proportions, prop design, prop side, and overall silhouette from the canonical base reference.
- This frame must be recognizably the same individual pet as the canonical base.

Transparency and artifact rules:
- Prefer pose, expression, and silhouette changes over decorative effects.
- Effects are allowed only when state-relevant, opaque, hard-edged, pixel-style, fully inside the canvas, and physically touching or overlapping the pet silhouette.
- Do not draw detached effects: floating stars, loose sparkles, floating punctuation, floating icons, falling tear drops, separated smoke clouds, loose dust, disconnected outline bits, or stray pixels.
- Do not draw motion blur, speed lines, motion arcs, action streaks, afterimages, smears, halos, glows, auras, floor patches, cast shadows, contact shadows, drop shadows, oval floor shadows, landing marks, or impact bursts.
- Do not include text, labels, frame numbers, visible grids, guide marks, speech bubbles, thought bubbles, UI panels, code snippets, scenery, checkerboard transparency, white backgrounds, or black backgrounds.
- Do not use #FF00FF or near-magenta colors in the pet, prop, effects, highlights, shadows, or outlines.
- Reject any pose that is cropped, overlaps the canvas edge, or creates a separate disconnected component that is not attached to the pet.

Output: one PNG, 960×960, one centered full-body pose only, on a perfectly flat #FF00FF background.`;
