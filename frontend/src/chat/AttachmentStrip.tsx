// AttachmentStrip — shows pending attachments from chatStore.
// Portals into the existing #chat-attachments div created by chat.ts.
// chatUI.addAttachment/removeAttachment/clearAttachments now bridge to chatStore,
// so this component stays in sync with the vanilla attachment management.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '../stores/index.js';
import { Folder, FileText } from './icons.js';
import chatUI from './chat-ui.js';

type Attachment = Record<string, unknown>;

function AttachmentStripInner() {
  const attachments = useChatStore((s) => s.pendingAttachments);
  // { url, name } of the image currently shown in the click-preview lightbox,
  // or null when nothing is open. Lives in component state so it survives
  // re-renders triggered by add/remove.
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  function remove(idx: number) {
    // Route through chatUI so both the legacy pendingAttachments array (used by
    // the send pipeline) and the Zustand store stay in sync. The previous
    // implementation tried (window as any).app.chat.removeAttachment, but
    // window.app is never assigned in the TS codebase — so the X did nothing.
    chatUI.removeAttachment(idx);
  }

  // Close the lightbox on Escape — mounted only while a preview is open.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [preview]);

  function label(att: Attachment): string {
    if (att.name) return String(att.name);
    if (att.path) return String(att.path).split('/').pop() ?? String(att.path);
    if (att.type === 'image') return 'Image';
    return 'Attachment';
  }

  function icon(att: Attachment) {
    if (att.type === 'folder') return <Folder size={14} strokeWidth={1.75} />;
    return <FileText size={14} strokeWidth={1.75} />;
  }

  function isImage(att: Attachment): boolean {
    if (att.type === 'image') return true;
    if (String(att.mimeType ?? '').startsWith('image/')) return true;
    const url = String(att.url ?? '');
    if (url.startsWith('data:image/')) return true;
    return false;
  }

  if (!attachments.length) return null;

  return (
    <>
      {attachments.map((att, i) => {
        const name = label(att);
        const title = String(att.path ?? att.name ?? '');
        if (isImage(att) && att.url) {
          const url = String(att.url);
          return (
            <div key={i} className="chat-att" data-idx={i} title={name}>
              <img
                src={url}
                alt={name}
                style={{ cursor: 'zoom-in' }}
                onClick={(e) => { e.stopPropagation(); setPreview({ url, name }); }}
              />
              <button
                className="chat-att-rm"
                data-idx={i}
                title="Remove attachment"
                onClick={(e) => { e.stopPropagation(); remove(i); }}
              >
                ×
              </button>
            </div>
          );
        }
        return (
          <div key={i} className="chat-att chat-att-file" data-idx={i} title={title}>
            <span className="chat-att-icon" style={{ display: 'inline-flex', alignItems: 'center', marginRight: 4 }}>{icon(att)}</span>
            <span className="chat-att-name">{name}</span>
            <button
              className="chat-att-rm"
              data-idx={i}
              title="Remove attachment"
              onClick={(e) => { e.stopPropagation(); remove(i); }}
            >
              ×
            </button>
          </div>
        );
      })}
      {preview && createPortal(
        // Click-on-thumb lightbox — portaled to <body> so it escapes the
        // #chat-attachments flex container and centers over the page. Click
        // outside the image (or the × / Escape) closes it. Reuses the existing
        // .exchange-preview-popup styling for visual parity with the in-message
        // file-chip popup.
        <div
          className="exchange-preview-popup"
          role="dialog"
          aria-label={`Preview ${preview.name}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(80vw, 640px)',
          }}
        >
          <div className="exchange-preview-header">
            <span className="exchange-preview-name" title={preview.name}>{preview.name}</span>
            <button
              className="exchange-preview-close"
              title="Close"
              onClick={() => setPreview(null)}
            >
              ✕
            </button>
          </div>
          <div className="exchange-preview-body" style={{ maxHeight: '70vh' }}>
            <img
              src={preview.url}
              alt={preview.name}
              style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block' }}
            />
          </div>
        </div>,
        document.body,
      )}
      {preview && createPortal(
        // Backdrop — separate portal so the dialog above sits on top in DOM
        // order without needing an explicit z-index dance. Click anywhere on
        // the dim layer to dismiss.
        <div
          onClick={() => setPreview(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 9998,
          }}
        />,
        document.body,
      )}
    </>
  );
}

export function AttachmentStrip() {
  const [container, setContainer] = useState<Element | null>(null);
  const obsRef = useRef<MutationObserver | null>(null);
  const containerRef = useRef<Element | null>(null);

  useEffect(() => {
    function find() {
      const el = document.getElementById('chat-attachments');
      if (el && el !== containerRef.current) {
        el.innerHTML = '';
        el.dataset['react'] = '1';
        containerRef.current = el;
        setContainer(el);
      }
    }
    find();
    obsRef.current = new MutationObserver(find);
    obsRef.current.observe(document.body, { childList: true, subtree: true });
    return () => obsRef.current?.disconnect();
  }, []);

  const attachmentCount = useChatStore((s) => s.pendingAttachments.length);
  useEffect(() => {
    if (!container) return;
    (container as HTMLElement).style.display = attachmentCount ? 'flex' : 'none';
  }, [container, attachmentCount]);

  if (!container) return null;
  return createPortal(<AttachmentStripInner />, container);
}
