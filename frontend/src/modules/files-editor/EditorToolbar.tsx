// EditorToolbar — three icon buttons (save / discard / reload) used by both
// the VS-Code view's EditorRegion and the modal FileEditor.
//
// Reload highlights (data-attention='true') when the agent has edited the
// file in the background — the parent owns that flag and clears it after
// the user accepts the reload (or saves over it).

interface Props {
  dirty: boolean;
  loaded: boolean;
  externallyChanged: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}

export function EditorToolbar({
  dirty,
  loaded,
  externallyChanged,
  onSave,
  onDiscard,
  onReload,
}: Props) {
  return (
    <div className="ed-toolbar" role="toolbar" aria-label="File actions">
      <button
        type="button"
        className="ed-tb-btn"
        onClick={onSave}
        disabled={!loaded || !dirty}
        title={dirty ? 'Save (Ctrl+S)' : 'No changes to save'}
        aria-label="Save"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2.5 1A1.5 1.5 0 0 0 1 2.5v11A1.5 1.5 0 0 0 2.5 15h11a1.5 1.5 0 0 0 1.5-1.5V5.207a1.5 1.5 0 0 0-.44-1.06L11.854 1.44A1.5 1.5 0 0 0 10.793 1H2.5zM4 2h6v3H4V2zm-1 7h10v5H3V9zm2 1v1h6v-1H5z"
          />
        </svg>
      </button>
      <button
        type="button"
        className="ed-tb-btn"
        onClick={onDiscard}
        disabled={!loaded || !dirty}
        title={dirty ? 'Discard changes (reload from disk)' : 'No changes to discard'}
        aria-label="Discard"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M11.354 4.646a.5.5 0 0 0-.708 0L8 7.293 5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0 0-.708z"
          />
        </svg>
      </button>
      <button
        type="button"
        className="ed-tb-btn"
        data-attention={externallyChanged ? 'true' : 'false'}
        onClick={onReload}
        disabled={!loaded}
        title={
          externallyChanged
            ? 'File changed on disk — reload'
            : 'Reload from disk'
        }
        aria-label="Reload"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 3a5 5 0 0 0-4.546 2.916l-.86-1.43A.5.5 0 0 0 1.74 4.99l1.5 2.5a.5.5 0 0 0 .687.171l2.5-1.5a.5.5 0 0 0-.514-.858L4.6 6.06A4 4 0 1 1 4 8a.5.5 0 0 0-1 0 5 5 0 1 0 5-5z"
          />
        </svg>
        {externallyChanged && <span className="ed-tb-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
