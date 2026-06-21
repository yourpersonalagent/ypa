// petWorldStore — last-captured snapshot of the pet's spatial surroundings.
//
// Populated by usePetWorldModel (modules/pet/world/usePetWorldModel.ts), which
// debounces snapshot capture until the pet has been still for STILL_DELAY_MS
// after its last move. Consumers (the debug overlay, pet-vision MCP bridge
// route, and any future spatial-aware profile) subscribe via the standard
// Zustand selector hook so they re-render only when the snapshot reference
// changes.
//
// Lazy by design: when the pet is hidden / behindUi the snapshot is `null`
// and the producer is unmounted — no foreground CPU cost.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

/** Plain-object form of DOMRect so the snapshot can be JSON-serialised for
 *  the bridge push (Phase 4) without touching the live element refs. */
export interface PetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type PetActiveRegion =
  | 'chat'
  | 'chat-input'
  | 'command-palette'
  | 'header'
  | 'panel'
  | 'free';

export interface NearbyElement {
  /** Human-readable label (accessible name → text → placeholder → tag). */
  label: string;
  rect: PetRect;
  /** Closest edge-to-edge distance from the pet hitbox in px. */
  distancePx: number;
  /** 0..1 importance score (header / primary / size-weighted). */
  importance: number;
  /** Best-effort selector for traceability (id > data-testid > tag.class). */
  selector: string;
}

export interface NearbyInput extends NearbyElement {
  placeholder: string;
  hasFocus: boolean;
  /** 'textarea' | 'input' | 'contenteditable' */
  kind: 'textarea' | 'input' | 'contenteditable';
}

export interface NearbyPanel {
  label: string;
  rect: PetRect;
  id: string;
}

export interface FocusedElement {
  tag: string;
  label: string;
  rect: PetRect;
}

export interface PetWorldSnapshot {
  /** Top-left of the pet hitbox in viewport coords (matches petRect.left/top). */
  petPos: { x: number; y: number };
  petRect: PetRect;
  nearest: {
    button: NearbyElement | null;
    input: NearbyInput | null;
    panel: NearbyPanel | null;
  };
  /** Top N visible buttons by importance, capped to keep the snapshot small. */
  visibleButtons: NearbyElement[];
  activeRegion: PetActiveRegion;
  focusedElement: FocusedElement | null;
  /** performance.now() at capture — for "is this snapshot still fresh?" checks. */
  capturedAt: number;
}

interface PetWorldStore {
  snapshot: PetWorldSnapshot | null;
  setSnapshot: (s: PetWorldSnapshot | null) => void;
}

export const usePetWorldStore = create<PetWorldStore>()(
  devtools(
    (set) => ({
      snapshot: null,
      setSnapshot: (snapshot) => set({ snapshot }),
    }),
    { name: 'PetWorldStore' },
  ),
);
