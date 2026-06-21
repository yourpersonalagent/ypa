// Standalone clipboard-image upload. ChatInput.handlePaste and the legacy
// chat.ts paste listener both call into here, so the path no longer waits
// for the lazy-loaded FilePicker chunk to mount before pastes work.

import { getSessionState } from '../stores/sessionStore.js';
import { api } from '../api.js';
import chatUI from './chat-ui.js';

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']);

interface UploadResult {
  ok: boolean;
  url?: string;
  dataUrl?: string;
}

function uploadFile(file: File, baseUrl: string, sessionId: string): Promise<UploadResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const dataUrl = (evt.target as FileReader).result as string;
      try {
        const r = await fetch(`${baseUrl}/v1/uploads/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, name: file.name, data: dataUrl }),
        });
        const d = (await r.json()) as { success: boolean; url?: string };
        if (d.success && d.url) resolve({ ok: true, url: baseUrl + d.url, dataUrl });
        else resolve({ ok: false, dataUrl });
      } catch {
        resolve({ ok: false, dataUrl });
      }
    };
    reader.onerror = () => resolve({ ok: false });
    reader.readAsDataURL(file);
  });
}

// Pulls image files out of a ClipboardEvent's data. Prefers `items` (modern
// API, populated by all current browsers) and only falls back to `files` when
// items has nothing — both sources usually mirror the same clipboard payload,
// and File objects accessed from each have distinct lastModified timestamps,
// so reading both and deduping by metadata would still double-count.
// Returns at most one image per paste: Ctrl+V semantics is "the thing on the
// clipboard", which is a single screenshot — multi-image attach happens via
// the file picker instead.
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items || [])
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
  const picked = fromItems.length
    ? fromItems[0]
    : Array.from(data.files || []).find((f) => f.type.startsWith('image/')) ?? null;
  if (!picked) return [];
  if (!picked.name || picked.name === 'image.png') {
    const ext = picked.type.split('/')[1] || 'png';
    return [new File([picked], `paste-${Date.now()}.${ext}`, { type: picked.type })];
  }
  return [picked];
}

export async function uploadPastedFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  const ta = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
  const sid = String(getSessionState().currentId || 'default');
  const baseUrl = api.config.baseUrl || window.location.origin;
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !file.type.startsWith('image/')) continue;
    const res = await uploadFile(file, baseUrl, sid);
    if (res.ok && res.url) {
      // Route through chatUI (not the chatStore directly) so the legacy
      // module-level `pendingAttachments` array stays in sync with Zustand —
      // send() / clearAttachments() both depend on the two being aligned.
      chatUI.addAttachment({ name: file.name, url: res.url, type: 'image' });
    } else if (res.dataUrl && ta) {
      ta.value = (ta.value || '') + `\n![${file.name}](${res.dataUrl})\n`;
    }
  }
  if (ta) ta.dispatchEvent(new Event('input'));
}
