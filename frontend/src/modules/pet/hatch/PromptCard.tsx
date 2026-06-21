// PromptCard — code block with copy-to-clipboard button and a drop zone
// for uploading the resulting PNG back into the wizard.
//
// This is the primary UI surface of the hatch flow. The user reads the
// prompt, copies it (button or Ctrl+C), pastes it into Grok manually,
// downloads the PNG, drags it onto the drop zone (or uses the file picker)
// and the wizard takes it from there.

import { useCallback, useRef, useState } from 'react';

interface PromptCardProps {
  prompt: string;
  suggestedFilename: string;
  accepted: boolean;
  previewUrl: string | null;
  onFile: (blob: Blob) => void;
  onClear: () => void;
  /** Compact variant for the per-frame re-roll inside the contact sheet. */
  dense?: boolean;
}

export function PromptCard({
  prompt,
  suggestedFilename,
  accepted,
  previewUrl,
  onFile,
  onClear,
  dense,
}: PromptCardProps) {
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Some contexts disallow async clipboard. The user can still
      // select-all and copy manually from the code block.
    }
  }, [prompt]);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image/')) return;
      onFile(file);
    },
    [onFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  return (
    <div className={`hatch-prompt-card${dense ? ' is-dense' : ''}`}>
      <div className="hatch-prompt-toolbar">
        <span className="hatch-prompt-filename">{suggestedFilename}</span>
        <div className="hatch-prompt-tools">
          <button type="button" className="hatch-btn-ghost" onClick={copy}>
            {copied ? '✓ Copied' : 'Copy prompt'}
          </button>
        </div>
      </div>
      <pre className="hatch-prompt-block"><code>{prompt}</code></pre>

      <div
        className={`hatch-drop-zone${dragOver ? ' is-drag' : ''}${accepted ? ' is-accepted' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {previewUrl ? (
          <div className="hatch-drop-preview">
            <img src={previewUrl} alt={suggestedFilename} />
            <div className="hatch-drop-meta">
              <strong>{suggestedFilename}</strong>
              <button type="button" className="hatch-btn-ghost" onClick={() => onClear()}>Replace</button>
            </div>
          </div>
        ) : (
          <div className="hatch-drop-empty">
            <strong>Drop the PNG here</strong>
            <span>or</span>
            <button
              type="button"
              className="hatch-btn-ghost"
              onClick={() => fileRef.current?.click()}
            >
              Select file…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/*"
              hidden
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) handleFile(file);
              }}
            />
            <p className="hatch-drop-hint">
              Tip: download from Grok as PNG, then drop here. Chroma-key + slicing happens locally.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
