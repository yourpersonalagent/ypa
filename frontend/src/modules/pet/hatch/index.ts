// Public surface of the hatch feature.
//
// Importers should pull from this barrel rather than reach into the
// individual modules — keeps the wizard UI decoupled from the prompt
// engine internals.

export * from './types.js';
export { ROWS, ROW_TO_MOOD, rowMood } from './animationRows.js';
export { ARCHETYPES, specFromArchetype, slugifyId } from './archetypes.js';
export type { Archetype } from './archetypes.js';
export { PLANS, PLAN_NAMES, planFrameTotal, planRoundCount, planRows } from './plans.js';
export {
  buildBasePrompt,
  buildStripPrompt,
  buildSinglePrompt,
  buildRowPrompt,
  buildUniversalPrefix,
  suggestFilename,
} from './prompt.js';
export { sliceStrip } from './slice.js';
export { chromaKeyBlob, chromaKeyImageData } from './chromaKey.js';
export { buildManifest, buildRowPose, claimOrphanedRows, mergeManifest, missingPlanRows } from './manifest.js';
export type { YhaPetManifest, ManifestPose } from './manifest.js';
export {
  recalibrateFeet,
  fetchImageData,
  shiftImageData,
  scaleImageData,
  imageDataToPngBlob,
} from './recalibrate.js';
export type {
  RecalibrateProgress,
  RecalibrateResult,
  RecalibrateRowDetail,
} from './recalibrate.js';
export {
  uploadFrame,
  uploadBase,
  uploadManifest,
  fetchManifest,
  listPetFrames,
  listPets,
  deletePet,
} from './persist.js';
