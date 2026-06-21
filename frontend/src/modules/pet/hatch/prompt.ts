// Prompt builders — turn a CharacterSpec + plan + row choice into the
// final text the user copies into Grok.
//
// The build* functions here are pure: they consume data, return a string,
// and never touch the DOM, fetch, or stores. The wizard wraps them with
// state; the unit tests can import them directly.

import { ROWS } from './animationRows.js';
import { render } from './render.js';
import {
  BASE_TEMPLATE,
  SINGLE_FRAME_TEMPLATE,
  STRIP_ROW_TEMPLATE,
  UNIVERSAL_PREFIX,
} from './templates/index.js';
import type { CharacterSpec, RenderMode, RowName } from './types.js';

const SHEET_PX = 960;
const CELL_PADDING = 24;

/** Slot map for `{{character.*}}` placeholders. */
function characterSlots(spec: CharacterSpec): Record<string, string> {
  return {
    'character.id': spec.id,
    'character.name': spec.name,
    'character.silhouette': spec.silhouette,
    'character.palette': spec.palette,
    'character.props': spec.props,
    'character.signatureMove': spec.signatureMove,
    'character.faceLanguage': spec.faceLanguage || 'simple readable face, expressive eyes, tiny mouth',
    'character.styleNotes': spec.styleNotes || '',
    'character.species': spec.species || '',
  };
}

/** Universal prefix string, populated with the character spec. */
export function buildUniversalPrefix(spec: CharacterSpec): string {
  return render(UNIVERSAL_PREFIX, characterSlots(spec));
}

/** Base / canonical T-pose prompt. */
export function buildBasePrompt(spec: CharacterSpec): string {
  return render(BASE_TEMPLATE, characterSlots(spec));
}

/** Strip-row prompt: produces one prompt that asks Grok for an entire
 *  row of frames laid out on a grid inside one 960×960 sheet. */
export function buildStripPrompt(spec: CharacterSpec, rowName: RowName): string {
  const row = ROWS[rowName];
  if (!row) throw new Error(`Unknown row: ${rowName}`);

  const { cols, rows } = row.stripLayout;
  const totalCells = cols * rows;
  const emptyCount = totalCells - row.frames;
  const cellW = Math.floor(SHEET_PX / cols);
  const cellH = Math.floor(SHEET_PX / rows);
  const cellAnchorY = cellH - Math.floor(cellH * 0.18);
  const cellBodyH = Math.floor(cellH * 0.7);

  const emptyCellsNote = emptyCount === 0
    ? 'all cells contain a frame.'
    : `the last ${emptyCount} cell${emptyCount > 1 ? 's' : ''} (bottom-right) must be left as flat #FF00FF magenta with no character or props in them.`;

  const stateRules = row.stateRules.map((r) => `- ${r}`).join('\n');
  const frameList = row.actions
    .map((a, i) => `- Frame ${i + 1} of ${row.frames}: ${a}`)
    .join('\n');

  return render(STRIP_ROW_TEMPLATE, {
    ...characterSlots(spec),
    row: row.name,
    row_purpose: row.purpose,
    frame_total: row.frames,
    cols,
    rows,
    cell_w: cellW,
    cell_h: cellH,
    cell_anchor_y: cellAnchorY,
    cell_body_h: cellBodyH,
    cell_padding: CELL_PADDING,
    state_rules: stateRules,
    frame_list: frameList,
    empty_cells_note: emptyCellsNote,
  });
}

/** Single-frame re-roll prompt. `frameIndex` is 1-based to match the
 *  wording inside the prompt. */
export function buildSinglePrompt(
  spec: CharacterSpec,
  rowName: RowName,
  frameIndex: number,
): string {
  const row = ROWS[rowName];
  if (!row) throw new Error(`Unknown row: ${rowName}`);
  if (frameIndex < 1 || frameIndex > row.frames) {
    throw new Error(`Frame index ${frameIndex} out of range 1..${row.frames}`);
  }

  const stateRules = row.stateRules.map((r) => `- ${r}`).join('\n');

  return render(SINGLE_FRAME_TEMPLATE, {
    ...characterSlots(spec),
    row: row.name,
    row_purpose: row.purpose,
    frame_number: frameIndex,
    frame_total: row.frames,
    frame_action: row.actions[frameIndex - 1],
    state_rules: stateRules,
  });
}

/** Friendly filename suggestion shown to the user next to a prompt. */
export function suggestFilename(rowName: RowName | 'base', frameIndex?: number): string {
  if (rowName === 'base') return 'canonical-base.png';
  if (frameIndex && frameIndex > 0) {
    return `${rowName}-${String(frameIndex).padStart(2, '0')}.png`;
  }
  return `${rowName}-strip.png`;
}

/** Helper used by tests + UI to dispatch the right builder. */
export function buildRowPrompt(
  spec: CharacterSpec,
  rowName: RowName,
  mode: RenderMode,
  frameIndex?: number,
): string {
  if (mode === 'strip') return buildStripPrompt(spec, rowName);
  if (frameIndex == null) {
    throw new Error('Single-frame mode requires a frameIndex');
  }
  return buildSinglePrompt(spec, rowName, frameIndex);
}
