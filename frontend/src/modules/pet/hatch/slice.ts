// Strip slicing — split a 960×960 strip sheet into individual cell PNGs
// using the browser canvas. Pure DOM, no node deps.
//
// Layout matches stripRow.ts: `cols × rows` grid, read order
// left-to-right, top-to-bottom, frames packed from cell 0 onward and any
// leftover cells (bottom-right) are blank magenta.

import { ROWS } from './animationRows.js';
import type { RowName } from './types.js';

export interface SliceOptions {
  /** Override the loaded image source size. Defaults to image.naturalWidth/Height. */
  sheetWidth?: number;
  sheetHeight?: number;
}

/** Read a Blob as an HTMLImageElement (decoded). */
async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    img.src = url;
    if (!img.complete) {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Image decode failed'));
      });
    }
    return img;
  } finally {
    // Don't revoke yet — caller might still hold the handle.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** Slice a strip sheet into individual frame Blobs (one per cell). */
export async function sliceStrip(
  rowName: RowName,
  blob: Blob,
  options: SliceOptions = {},
): Promise<Blob[]> {
  const row = ROWS[rowName];
  if (!row) throw new Error(`Unknown row: ${rowName}`);

  const img = await blobToImage(blob);
  const sheetW = options.sheetWidth ?? img.naturalWidth;
  const sheetH = options.sheetHeight ?? img.naturalHeight;
  if (!sheetW || !sheetH) throw new Error('Strip image has zero dimensions');

  const { cols, rows } = row.stripLayout;
  const cellW = Math.floor(sheetW / cols);
  const cellH = Math.floor(sheetH / rows);
  const out: Blob[] = [];

  for (let i = 0; i < row.frames; i++) {
    const col = i % cols;
    const r = Math.floor(i / cols);
    const sx = col * cellW;
    const sy = r * cellH;

    const canvas = document.createElement('canvas');
    canvas.width = cellW;
    canvas.height = cellH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(img, sx, sy, cellW, cellH, 0, 0, cellW, cellH);

    const cellBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!cellBlob) throw new Error(`Failed to encode slice ${i + 1}`);
    out.push(cellBlob);
  }

  return out;
}
