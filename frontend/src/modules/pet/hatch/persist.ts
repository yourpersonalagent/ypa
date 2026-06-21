// Bridge persistence — upload PNG frames + manifest to the YHA bridge so
// they appear under /pets/<id>/ for the running app.
//
// The bridge route is registered in bridge/server-pet-hatch.ts and writes
// directly to frontend/public/pets/<id>/. User authenticates via the
// existing bridge session; no extra credentials.
//
// Wire format is JSON + base64 (the bridge runs without multer). Each
// upload posts ONE file at a time so we stay comfortably under the
// global 5 MB express.json limit even for 79-frame `full` plans.

import type { YhaPetManifest } from './manifest.js';

async function blobToBase64(blob: Blob): Promise<string> {
  // Use a FileReader for max browser compatibility. Returns base64 sans
  // the "data:image/png;base64," prefix so the bridge can decode directly.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf('base64,');
      resolve(idx >= 0 ? result.slice(idx + 7) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/** Upload a single frame PNG. `relativePath` is e.g. "idle-01.png". */
export async function uploadFrame(
  petId: string,
  relativePath: string,
  blob: Blob,
): Promise<void> {
  const base64 = await blobToBase64(blob);
  const resp = await fetch(`/v1/pets/${encodeURIComponent(petId)}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: [{ path: relativePath, base64 }] }),
    credentials: 'include',
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Upload of ${relativePath} failed: ${resp.status} ${text}`);
  }
}

/** Upload the canonical-base reference. Stored as `_base.png`. */
export async function uploadBase(petId: string, blob: Blob): Promise<void> {
  return uploadFrame(petId, '_base.png', blob);
}

/** Persist the final manifest at /pets/<id>.json. */
export async function uploadManifest(manifest: YhaPetManifest): Promise<void> {
  const resp = await fetch(`/v1/pets/${encodeURIComponent(manifest.name)}/manifest`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
    credentials: 'include',
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Manifest write failed: ${resp.status} ${text}`);
  }
}

/** Fetch an existing pet's manifest. Used by the upgrade flow. Always
 *  cache-busted so the upgrade UI sees the most recent on-disk poses, not
 *  whatever the browser remembers from a previous session. */
export async function fetchManifest(petId: string): Promise<YhaPetManifest> {
  const url = `/pets/${encodeURIComponent(petId)}.json?v=${Date.now()}`;
  const resp = await fetch(url, {
    credentials: 'include',
    cache: 'no-cache',
  });
  if (!resp.ok) {
    throw new Error(`Manifest fetch failed: ${resp.status}`);
  }
  return (await resp.json()) as YhaPetManifest;
}

/** List existing pets known to the bridge. Returns ids + optional idle thumb. */
export async function listPets(): Promise<{ id: string; label: string; thumb?: string }[]> {
  const resp = await fetch('/v1/pets', { credentials: 'include' });
  if (!resp.ok) return [];
  const body = await resp.json().catch(() => null);
  if (!body || !Array.isArray(body.pets)) return [];
  return body.pets;
}

/** List all animation-frame PNGs in a pet's directory.
 *  Returns filenames like "idle-01.png", "fighting-05.png", etc.
 *  Useful for the nudge modal to show rows that exist on disk but
 *  may not be referenced in any manifest pose (orphaned rows). */
export async function listPetFrames(petId: string): Promise<string[]> {
  const resp = await fetch(
    `/v1/pets/${encodeURIComponent(petId)}/list-frames`,
    { credentials: 'include' },
  );
  if (!resp.ok) return [];
  const body = await resp.json().catch(() => null);
  if (!body || !Array.isArray(body.files)) return [];
  return body.files as string[];
}

/** Delete a pet (frames + manifest). */
export async function deletePet(petId: string): Promise<void> {
  const resp = await fetch(`/v1/pets/${encodeURIComponent(petId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Delete failed: ${resp.status} ${text}`);
  }
}
