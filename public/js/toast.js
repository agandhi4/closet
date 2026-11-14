/**
 * The page's toasts, all in #toast-host (src/web/layout/app-status.tsx),
 * its one polite status region (#679): a screen reader reads what lands in
 * a live region that was already on the page, not one inserted with its
 * message, so no toast carries a role of its own.
 *
 * Who fills it:
 * - a write's result: the server's STATUS_EVENT (`HX-Trigger`,
 *   src/web/announce.ts) to an htmx write, with an Undo button when the
 *   write is reversible (`undo`: a post of its fields, #686), and SavedToast's inert
 *   `<template data-status-message>` (src/web/layout/parts.tsx) on the page
 *   a native post lands on; both handled here;
 * - a failed request (request-failures.js), the outbox's notices
 *   (outbox.ts), connectivity changes (connectivity.js), service worker
 *   updates (pwa.js) and a newer page (freshness.js), through showToast.
 *
 * The host carries `hx-preserve`: a boosted body swap keeps the same node
 * (and the toasts in it), so a message is added to a region that was already
 * there, and a caller re-showing a toast on htmx:afterSettle checks that its
 * own is still connected. The layout loads this module on every page; the
 * others import the same instance through the import map.
 */

const STATUS_EVENT = 'closet:status';
const SAVED_MESSAGE = 'template[data-status-message]';
const SUCCESS_TOAST_MS = 4_000;
// Long enough to find Undo and tap it (a toast with an action is read, not glanced at).
const UNDO_TOAST_MS = 10_000;

const host = () => document.getElementById('toast-host');

/**
 * @param {{ text: string, kind?: 'info'|'success'|'warning', ttlMs?: number,
 *           action?: { label: string, onClick: () => void } }} options
 * @returns {{ dismiss: () => void, element: HTMLElement, label: HTMLElement,
 *             button: HTMLButtonElement | null }}
 */
export function showToast({ text, kind = 'info', ttlMs, action }) {
  const element = document.createElement('div');
  element.className = `alert alert-${kind} py-2 text-sm shadow-md`;

  const label = document.createElement('span');
  label.textContent = text;
  element.append(label);

  const dismiss = () => element.remove();

  let button = null;
  if (action) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-primary';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
    element.append(button);
  }
  if (ttlMs) setTimeout(dismiss, ttlMs);

  host()?.append(element);
  return { dismiss, element, label, button };
}

/** One result at a time: a quick second tap's replaces the first's. */
let result;

function showResult(text, undo) {
  result?.dismiss();
  result = showToast({
    text,
    kind: 'success',
    ttlMs: undo ? UNDO_TOAST_MS : SUCCESS_TOAST_MS,
    action: undo && {
      label: undo.label,
      // The server's own navigation answer (HX-Location) swaps the page.
      onClick: () =>
        window.htmx.ajax('post', undo.action, {
          source: document.body,
          target: 'body',
          values: undo.fields,
        }),
    },
  });
}

/**
 * Says each SavedToast the page (or a swap) brought, once, a frame later: the
 * region has been rendered and attached by then, and text added to a live
 * region that is already on screen is what a screen reader reads.
 */
function sayLandingMessages() {
  requestAnimationFrame(() => {
    for (const template of document.querySelectorAll(SAVED_MESSAGE)) {
      const text = template.content.textContent?.trim();
      template.remove();
      if (text) showResult(text);
    }
  });
}

document.addEventListener(STATUS_EVENT, (event) => {
  showResult(event.detail.message, event.detail.undo);
});
document.addEventListener('htmx:afterSettle', sayLandingMessages);
sayLandingMessages();
