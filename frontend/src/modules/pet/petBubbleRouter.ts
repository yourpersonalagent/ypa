// petBubbleRouter — routes app toasts to the pet-bubble when the pet is
// visible (Phase 1.5b of the ContextGenerator pipeline / Adaption 5b).
//
// Why this exists
// ───────────────
// The doc says:
//   • pet.visible === true  → toasts appear as bubbles AT the pet (4s, queued)
//   • pet.visible === false → classic toaster as before
//
// We do that without changing any existing call site. The toastStore exposes
// `show` as part of its state — we wrap it once at boot. If the pet is
// visible at the moment a toast is shown, we redirect it to the pet console
// bubble queue instead of pushing it onto the global stack. The user-facing
// surface is `useToastStore.show(...)` (or `app.toast.show`); both flow
// through the same patched function.
//
// Edge cases handled
// ──────────────────
//   • Pet visibility flips mid-toast: per requirement, toasts that are
//     ALREADY in the global stack stay there until they expire — we don't
//     migrate them. New toasts honour the live visibility flag.
//   • `running` → `done` updates use an explicit `id` to replace the
//     previous toast. The bubble queue honours the same id-replace logic in
//     `pushToastBubble` so a running spinner becomes a "done" line in
//     place, just like the classic stack.
//   • Toast-store events that the user has DISABLED in localStorage stay
//     disabled — we keep the original `enabled` gate intact by checking
//     get().enabled before forwarding (mirrors original behaviour).
//
// Initialisation order
// ────────────────────
// Must run AFTER the toastStore module has been instantiated (i.e. after
// the first `import` of stores/toastStore.js anywhere). Calling
// `installPetBubbleRouter()` from main-react.tsx (or App's effect) covers
// this — Vite always evaluates module imports before our entry runs.

import { useToastStore, type ToastType } from '../../stores/toastStore.js';
import { usePetStore } from './store/petStore.js';
import { usePetConsoleStore, type PetToastBubbleType } from './store/petConsoleStore.js';

let _installed = false;

const DEFAULT_DURATION: Record<PetToastBubbleType, number> = {
  error:   6000,
  warning: 5000,
  running: 0,    // persistent until the next id-replace dismisses it
  info:    4000, // doc spec is 4 s for routed toasts
  success: 4000,
};

function _normalize(t: string | undefined): PetToastBubbleType {
  if (t === 'ok') return 'success';
  if (t === 'err') return 'error';
  if (t === 'success' || t === 'error' || t === 'warning' || t === 'running' || t === 'info') {
    return t;
  }
  return 'info';
}

export function installPetBubbleRouter(): void {
  if (_installed) return;
  _installed = true;

  const toastApi = useToastStore.getState();
  const origShow = toastApi.show;

  // Replace `show` in the store. The action lives on the store state, so
  // setState replaces it for ALL future callers (vanilla JS via
  // getToastActions() and React via useToastStore selectors alike).
  useToastStore.setState({
    show: (message, type, opts) => {
      const isVisible = usePetStore.getState().isVisible;

      // Pet hidden OR toasts globally disabled OR caller hits a code path
      // we shouldn't intercept — defer to the original implementation.
      if (!isVisible) return origShow(message as string, type, opts);

      // Mirror the disabled-gate; if toasts are globally off, show()
      // returns '' regardless of pet visibility. We must respect that or
      // we'd start showing bubbles for a user who explicitly disabled
      // notifications.
      if (!useToastStore.getState().enabled) return '';

      // Resolve duration / title / id with the same precedence the
      // toastStore uses internally.
      const resolvedType = _normalize(typeof type === 'string' ? type : undefined);
      let duration = DEFAULT_DURATION[resolvedType];
      let title: string | undefined;
      let id: string | undefined;
      if (typeof opts === 'number') {
        duration = opts;
      } else if (opts) {
        if (typeof opts.duration === 'number') duration = opts.duration;
        if (opts.title) title = opts.title;
        if (opts.id) id = opts.id;
      }

      const bubbleId = usePetConsoleStore.getState().pushToastBubble({
        id,
        message: String(message),
        title,
        type:    resolvedType,
        duration,
      });
      return bubbleId;
    },
  });

  // Side-effect: when the pet becomes hidden, drain any leftover bubbles
  // back into the classic stack so a user who hides the pet doesn't lose
  // a "running" toast that was in the bubble queue. Inverse migration is
  // intentionally NOT done — see the doc note above.
  let _prevVisible = usePetStore.getState().isVisible;
  usePetStore.subscribe((state) => {
    const next = state.isVisible;
    if (next === _prevVisible) return;
    _prevVisible = next;
    if (next) return; // becoming visible — nothing to migrate
    const bubbles = usePetConsoleStore.getState().toastBubbles;
    if (!bubbles.length) return;
    for (const b of bubbles) {
      // Use the original show so we don't recurse back into the bubble
      // route while the migration is in flight.
      origShow(b.message, b.type as ToastType, {
        title:    b.title,
        duration: b.duration,
        id:       b.id,
      });
    }
    usePetConsoleStore.getState().clearToastBubbles();
  });
}
