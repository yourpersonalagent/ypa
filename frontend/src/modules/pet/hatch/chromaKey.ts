// Chroma-key — replace the magenta background with alpha.
//
// Runs entirely in the browser canvas. Used by the hatch wizard
// before persisting frames.
//
// Strategy:
//   1. Sample border pixels to derive the actual key color (Grok rarely
//      hits #FF00FF exactly — it might be (252,1,253) or similar).
//   2. For each pixel: distance to key color → alpha ramp.
//      - distance ≤ TRANSPARENT_THRESHOLD  → alpha 0
//      - distance < OPAQUE_THRESHOLD       → soft matte
//      - else                              → keep alpha
//   3. Output a fresh ImageData → Blob (PNG).

const TRANSPARENT_THRESHOLD = 16;
const OPAQUE_THRESHOLD = 220;

interface KeyColor {
  r: number;
  g: number;
  b: number;
}

function deriveBorderKey(data: Uint8ClampedArray, width: number, height: number): KeyColor {
  const bins = new Map<string, number>();
  const sample = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const r = Math.round(data[i] / 8) * 8;
    const g = Math.round(data[i + 1] / 8) * 8;
    const b = Math.round(data[i + 2] / 8) * 8;
    const key = `${r},${g},${b}`;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    sample(width - 1, y);
  }
  let bestKey = '255,0,255';
  let bestCount = -1;
  for (const [k, c] of bins.entries()) {
    if (c > bestCount) {
      bestKey = k;
      bestCount = c;
    }
  }
  const [r, g, b] = bestKey.split(',').map(Number);
  return { r, g, b };
}

/** Apply chroma-key in-place to an ImageData buffer. */
export function chromaKeyImageData(image: ImageData): void {
  const { data, width, height } = image;
  const key = deriveBorderKey(data, width, height);
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - key.r;
    const dg = data[i + 1] - key.g;
    const db = data[i + 2] - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist <= TRANSPARENT_THRESHOLD) {
      data[i + 3] = 0;
    } else if (dist < OPAQUE_THRESHOLD) {
      const alpha = Math.round(
        ((dist - TRANSPARENT_THRESHOLD) / (OPAQUE_THRESHOLD - TRANSPARENT_THRESHOLD)) * 255,
      );
      data[i + 3] = Math.min(data[i + 3], alpha);
    }
  }
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image decode failed'));
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

/** Apply chroma-key to a Blob and return a new PNG Blob with alpha. */
export async function chromaKeyBlob(blob: Blob): Promise<Blob> {
  const img = await blobToImage(blob);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('Image has zero dimensions');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  chromaKeyImageData(imageData);
  ctx.putImageData(imageData, 0, 0);

  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!out) throw new Error('Failed to encode chroma-keyed PNG');
  return out;
}
