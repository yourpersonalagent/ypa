// Strip-row prompt — generate a whole row of N frames inside one
// 960×960 sheet, arranged on a `cols × rows` grid.
//
// This is the primary path. Strip generation is dramatically more
// identity-consistent than per-frame generation because the model paints
// all frames at once with a shared sense of the character. We slice the
// downloaded PNG into individual frames client-side via canvas.
//
// `{{frame_list}}` is rendered separately by the caller (see render.ts
// helper) because it is a multi-line bullet list that depends on
// per-frame action data.

export const STRIP_ROW_TEMPLATE = `Create one square 960×960 PNG sprite sheet showing {{frame_total}} frames of the YHA digital pet \`{{character.name}}\` performing the \`{{row}}\` animation row.

Character identity: {{character.silhouette}}, {{character.palette}}, {{character.props}}. {{character.faceLanguage}}. {{character.styleNotes}} Keep the exact same head shape, face, palette, body proportions, prop design, and silhouette across every frame on this sheet. Match the canonical base reference exactly — same individual pet, only pose changes.

Layout: arrange the {{frame_total}} frames as a {{cols}}-column × {{rows}}-row grid. Each cell is exactly {{cell_w}} × {{cell_h}} px. Read order is left-to-right, top-to-bottom: cell row 1 left → cell row 1 right, then cell row 2 left → cell row 2 right, and so on. Cells must align to the grid with no offset, no gutter, and no border.

Empty cells: {{empty_cells_note}}

Cell anchoring: inside every cell, place the character centered horizontally with the feet anchored near the bottom of the cell (≈ {{cell_anchor_y}} px from the cell top). Keep at least {{cell_padding}} px padding inside each cell. Body height roughly {{cell_body_h}} px. Do not crop the head, prop, cape, or feet on any cell.

Style contract: YHA digital pet sprite style — pixel-art-adjacent, chunky readable silhouette, thick dark 1–2 px outline, visible stepped/pixel edges, limited palette, flat cel shading with at most one small highlight and one shadow step, simple expressive face, tiny limbs. Read clearly as a small animated app companion. Not polished illustration, anime key art, vector mascot, 3D render, glossy app icon, realistic painting, or detailed comic cover.

Background: perfectly flat pure #FF00FF chroma-key magenta across the entire 960×960 canvas, including the gutters between any visible cell content. No checkerboard transparency, no texture, no gradient, no shadow, no glow, no floor plane, no lighting variation, no scenery, no cell-divider lines.

Forbidden inside any frame: #FF00FF or any near-magenta color in the character, prop, highlights, shadows, or effects.

Forbidden everywhere: text, labels, frame numbers, cell numbers, borders, grid lines, UI panels, speech bubbles, thought bubbles, scenery, ground plane, horizon, motion blur, speed lines, motion arcs, afterimages, detached sparks, detached smoke, detached stars, loose particles, cast shadows, contact shadows, floor marks, halos, large aura.

Row purpose: {{row_purpose}}.

State-specific rules (apply to every frame on this sheet):
{{state_rules}}

Frame-by-frame intent (read top-left to bottom-right):
{{frame_list}}

Output: one PNG, 960×960, with all {{frame_total}} frames laid out on the {{cols}}×{{rows}} grid as described, on a perfectly flat #FF00FF background.`;
