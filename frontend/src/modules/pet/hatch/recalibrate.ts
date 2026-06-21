// Recalibrate-feet — post-hoc alignment fixer for sprite frames.
//
// Grok rarely places the character at the exact same anchor inside every
// cell of a strip sheet. Even after slicing, the foot position drifts by a
// few px between frames, which makes the running animation visibly wobble.
// This module re-aligns each frame within an animation row by:
//
//   1. Scanning the alpha channel to find the bottom-most non-transparent
//      row (the ground line / bottom of the feet).
//   2. Within a small band above the ground line, finding the right-most
//      non-transparent column (the right edge of the right foot).
//   3. Picking the row's per-frame max ground-Y and max foot-right-X as
//      the alignment target. Each frame is then translated by
//      (target - frame) so all frames share the same (right-foot,
//      ground) anchor. The translate is always non-negative so we only
//      ever shift content right and down — guaranteeing we don't crop
//      any pet pixels (the pixels we do clip on the right/bottom edge
//      were transparent by construction).
//
// We work pose-by-pose (= row-by-row), not globally, because different
// rows have different stances. The user explicitly asked for this as an
// after-the-fact bug-fix for Grok-supplied sheets; once the model gets
// better at intra-cell consistency we can retire it.
//
// All work is in-browser via canvas. We re-encode each shifted frame as
// PNG and POST it back through the existing /v1/pets/<id>/files upload
// route, overwriting the original file on disk.

import { uploadFrame } from './persist.js';
import type { YhaPetManifest, ManifestPose } from './manifest.js';

/** Pixels with alpha below this are treated as fully transparent for the
 *  scan. The chroma-key produces a soft matte ramp near edges, so a small
 *  threshold helps us ignore near-magenta haze without losing real foot
 *  pixels. */
const ALPHA_THRESHOLD = 24;

/** Height of the band (above the ground line) to search for the
 *  right-foot edge, expressed as a fraction of cell height. We don't want
 *  to find a hand or sword tip; the foot lives in the bottom slice. */
const FOOT_BAND_FRAC = 0.08;
const FOOT_BAND_MIN_PX = 10;

export interface RecalibrateProgress {
  phase: 'measuring' | 'shifting' | 'uploading' | 'done';
  done: number;
  total: number;
  label: string;
}

export interface RecalibrateRowDetail {
  row: string;
  frames: number;
  targetGroundY: number;
  targetFootRightX: number;
  shiftedFrames: number;
}

export interface RecalibrateResult {
  total: number;
  shifted: number;
  unchanged: number;
  details: RecalibrateRowDetail[];
}

interface FrameMetric {
  filename: string;
  src: string;
  image: ImageData;
  groundY: number;
  footRightX: number;
}

interface RowGroup {
  row: string;
  frames: { src: string }[];
}

function pathToFilename(src: string): string {
  const clean = src.split('?')[0];
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function rowFromSrc(src: string, fallback: string): string {
  const m = src.match(/\/pets\/[^/]+\/([a-z][a-z0-9-]*)-\d+\.png$/i);
  return m ? m[1] : fallback;
}

export async function fetchImageData(src: string): Promise<ImageData> {
  // Cache-bust so we always read the just-written-by-bridge bytes, not
  // whatever the browser remembers.
  const sep = src.includes('?') ? '&' : '?';
  const url = `${src}${sep}recal=${Date.now()}`;
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`Fetch ${src} failed: ${resp.status}`);
  const blob = await resp.blob();
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Decode ${src} failed`));
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally {
    setTimeout(() => URL.revokeObjectURL(objUrl), 1500);
  }
}

/** Scan ImageData and return the foot-anchor metrics. groundY/footRightX
 *  are -1 when the frame contains no opaque pixels. */
function computeMetrics(image: ImageData): { groundY: number; footRightX: number } {
  const { data, width, height } = image;

  // 1. Lowest row containing any opaque pixel.
  let groundY = -1;
  for (let y = height - 1; y >= 0; y--) {
    const rowOff = y * width * 4;
    let any = false;
    for (let x = 0; x < width; x++) {
      if (data[rowOff + x * 4 + 3] >= ALPHA_THRESHOLD) {
        any = true;
        break;
      }
    }
    if (any) {
      groundY = y;
      break;
    }
  }
  if (groundY < 0) return { groundY: -1, footRightX: -1 };

  // 2. Rightmost column with an opaque pixel inside the foot band
  //    [groundY - bandH, groundY]. This avoids picking up the sword tip,
  //    cape, or hair when those happen to extend further right than the
  //    foot.
  const bandH = Math.max(FOOT_BAND_MIN_PX, Math.round(height * FOOT_BAND_FRAC));
  const yLo = Math.max(0, groundY - bandH + 1);
  let footRightX = -1;
  for (let x = width - 1; x >= 0; x--) {
    let any = false;
    for (let y = yLo; y <= groundY; y++) {
      if (data[(y * width + x) * 4 + 3] >= ALPHA_THRESHOLD) {
        any = true;
        break;
      }
    }
    if (any) {
      footRightX = x;
      break;
    }
  }
  return { groundY, footRightX };
}

/** Translate `src` content by (dx, dy) into a fresh ImageData of the
 *  same dimensions. Pixels that fall outside the canvas are dropped;
 *  the rest of the destination is fully transparent. */
export function shiftImageData(src: ImageData, dx: number, dy: number): ImageData {
  const { width, height, data } = src;
  const dst = new ImageData(width, height);
  const dstData = dst.data;
  // Iterate destination pixels and pull from source. Faster than the
  // inverse on hot paths because we skip the bounds-check branch on every
  // out-of-canvas pixel.
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      const sIdx = (sy * width + sx) * 4;
      const dIdx = (y * width + x) * 4;
      dstData[dIdx] = data[sIdx];
      dstData[dIdx + 1] = data[sIdx + 1];
      dstData[dIdx + 2] = data[sIdx + 2];
      dstData[dIdx + 3] = data[sIdx + 3];
    }
  }
  return dst;
}

/** Scale `src` content by `scale` around the anchor point (anchorX,
 *  anchorY) into a fresh ImageData of the same dimensions. The anchor
 *  pixel stays at the same screen position — so scaling around the foot
 *  anchor (centre-X, ~93 % down) keeps the sprite planted on the ground
 *  while it grows or shrinks. Pixels that fall outside the canvas after
 *  scaling are clipped (those margins were transparent by construction
 *  in normal use). Uses nearest-neighbor upscaling to preserve the
 *  pixel-art look that pixelated CSS rendering relies on. */
export function scaleImageData(
  src: ImageData,
  scale: number,
  anchorX: number,
  anchorY: number,
): ImageData {
  if (scale === 1 || !Number.isFinite(scale) || scale <= 0) return src;
  const { width, height } = src;
  // Two-canvas pipeline — putImageData ignores transforms, but drawImage
  // honours them. Stage on `tmp`, transform-render to `dst`.
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tctx = tmp.getContext('2d');
  if (!tctx) throw new Error('Canvas 2D context unavailable');
  tctx.putImageData(src, 0, 0);

  const dst = document.createElement('canvas');
  dst.width = width;
  dst.height = height;
  const dctx = dst.getContext('2d');
  if (!dctx) throw new Error('Canvas 2D context unavailable');
  dctx.imageSmoothingEnabled = false; // pixel-art crispness
  dctx.translate(anchorX, anchorY);
  dctx.scale(scale, scale);
  dctx.translate(-anchorX, -anchorY);
  dctx.drawImage(tmp, 0, 0);
  return dctx.getImageData(0, 0, width, height);
}

export async function imageDataToPngBlob(image: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.putImageData(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('PNG encode failed'));
      resolve(blob);
    }, 'image/png');
  });
}

/** Group the manifest poses by row name (derived from the file path),
 *  deduping shared frame paths so we don't re-process the same file
 *  twice when multiple moods point at the same row. */
function groupFrames(manifest: YhaPetManifest): RowGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, RowGroup>();
  for (const [moodKey, pose] of Object.entries(manifest.poses || {}) as [string, ManifestPose | undefined][]) {
    if (!pose) continue;
    for (const f of pose.frames) {
      if (seen.has(f.src)) continue;
      seen.add(f.src);
      const row = rowFromSrc(f.src, moodKey);
      let group = groups.get(row);
      if (!group) {
        group = { row, frames: [] };
        groups.set(row, group);
      }
      group.frames.push({ src: f.src });
    }
  }
  return Array.from(groups.values());
}

/** Recalibrate every frame in the manifest so all frames inside a given
 *  row share the same right-foot/ground anchor. Frames are uploaded back
 *  to the bridge, overwriting the originals on disk. */
export async function recalibrateFeet(
  petId: string,
  manifest: YhaPetManifest,
  onProgress?: (p: RecalibrateProgress) => void,
): Promise<RecalibrateResult> {
  const groups = groupFrames(manifest);
  const total = groups.reduce((acc, g) => acc + g.frames.length, 0);
  let progress = 0;
  let shifted = 0;
  let unchanged = 0;
  const details: RecalibrateRowDetail[] = [];

  for (const group of groups) {
    onProgress?.({ phase: 'measuring', done: progress, total, label: group.row });

    // ── Phase A: fetch + measure ───────────────────────────────────────
    const measured: FrameMetric[] = [];
    for (const f of group.frames) {
      const image = await fetchImageData(f.src);
      const { groundY, footRightX } = computeMetrics(image);
      measured.push({
        filename: pathToFilename(f.src),
        src: f.src,
        image,
        groundY,
        footRightX,
      });
      progress++;
      onProgress?.({ phase: 'measuring', done: progress, total, label: group.row });
    }

    // Pick targets from frames that actually have measurable content.
    const valid = measured.filter((m) => m.groundY >= 0 && m.footRightX >= 0);
    if (!valid.length) {
      details.push({
        row: group.row,
        frames: measured.length,
        targetGroundY: -1,
        targetFootRightX: -1,
        shiftedFrames: 0,
      });
      unchanged += measured.length;
      continue;
    }
    const targetGroundY = Math.max(...valid.map((m) => m.groundY));
    const targetFootRightX = Math.max(...valid.map((m) => m.footRightX));

    // ── Phase B: shift + upload ─────────────────────────────────────────
    let rowShifted = 0;
    for (const m of measured) {
      if (m.groundY < 0 || m.footRightX < 0) {
        unchanged++;
        continue;
      }
      const dy = targetGroundY - m.groundY;
      const dx = targetFootRightX - m.footRightX;
      if (dx === 0 && dy === 0) {
        unchanged++;
        continue;
      }
      onProgress?.({ phase: 'shifting', done: shifted + unchanged, total, label: m.filename });
      const shiftedImg = shiftImageData(m.image, dx, dy);
      const blob = await imageDataToPngBlob(shiftedImg);
      onProgress?.({ phase: 'uploading', done: shifted + unchanged, total, label: m.filename });
      await uploadFrame(petId, m.filename, blob);
      shifted++;
      rowShifted++;
    }

    details.push({
      row: group.row,
      frames: measured.length,
      targetGroundY,
      targetFootRightX,
      shiftedFrames: rowShifted,
    });
  }

  onProgress?.({ phase: 'done', done: total, total, label: '' });
  return { total, shifted, unchanged, details };
}
