/**
 * Save-on-change controls (src/web/autosave.tsx, `data-autosave`) never
 * show an answer that a newer edit has overtaken. htmx queues their saves
 * one at a time per form (`hx-sync="closest form:queue last"`), each reading
 * the whole form when it is sent; this drops the answer to a save when the
 * person edited the form while it was in flight. That edit's own save is
 * already queued behind it (every control under `data-autosave` triggers
 * one), reads the form as the person left it, and its answer lands instead.
 * Swapping the older answer in would redraw controls with what they held
 * before the edit, and the queued save would then read those.
 *
 * An answer is also dropped when its control has left the page (another
 * swap, a navigation): it has nowhere to go.
 *
 * Edits are counted per form in the capture phase, before htmx's own
 * listeners on the controls issue the save, so a save counts the edit that
 * triggered it. `input` counts typing too: a stale answer never replaces a
 * note being typed, whose save follows on `change`. Listeners sit on the
 * document once, at module evaluation (the layout loads it on every page).
 */

/** Edits made in each form under its autosave controls. */
const edits = new WeakMap();
/** Each form's edit count when its save in flight read it (one at a time). */
const sentAt = new WeakMap();

function autosaveForm(element) {
  if (!(element instanceof Element)) return null;
  return element.closest('[data-autosave]')?.closest('form') ?? null;
}

function countEdit(event) {
  const form = autosaveForm(event.target);
  if (form) edits.set(form, (edits.get(form) ?? 0) + 1);
}

document.addEventListener('input', countEdit, true);
document.addEventListener('change', countEdit, true);

/** The autosave control that issued an htmx request, if one did. */
function autosaveControl(requestConfig) {
  const { elt } = requestConfig;
  return elt instanceof Element && elt.matches('[data-autosave]') ? elt : null;
}

document.addEventListener('htmx:beforeRequest', (event) => {
  const control = autosaveControl(event.detail.requestConfig);
  const form = control && autosaveForm(control);
  if (form) sentAt.set(form, edits.get(form) ?? 0);
});

// detail.elt is the swap's target here, not the element that asked:
// requestConfig.elt is.
document.addEventListener('htmx:beforeSwap', (event) => {
  const { requestConfig } = event.detail;
  const control = autosaveControl(requestConfig);
  if (!control) return;
  const form = autosaveForm(control);
  if (!control.isConnected || !form) {
    event.detail.shouldSwap = false;
    console.debug(
      `[autosave] ${requestConfig.path}: answer dropped, its form is gone`,
    );
    return;
  }
  if ((edits.get(form) ?? 0) !== sentAt.get(form)) {
    event.detail.shouldSwap = false;
    console.debug(
      `[autosave] ${requestConfig.path}: answer dropped, edited since it was sent`,
    );
  }
});
