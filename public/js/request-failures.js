/**
 * A failed htmx request says so (#642). htmx swaps no 4xx or 5xx (its
 * default `responseHandling`), so before this a tap whose answer was a
 * refusal left the screen as it was. The root error handler decides the
 * answer by the kind of request (src/web/errors.tsx); this module shows it:
 *
 * - A boosted tap (a link or form swapping the body) answered with one of
 *   this app's error pages is swapped in like any page, its status and
 *   request id included (a tile whose garment was deleted on another
 *   device opens "Garment not found"). htmx's `responseHandling` cannot say
 *   this: its rules match the status alone, never whether the request was
 *   boosted, and swapping every 4xx would empty a fragment's target with
 *   the bodiless answer below. An error page that is not ours (a proxy's
 *   502 while the app restarts) is never swapped over the app's shell.
 * - A fragment request's failure arrives as the `closet:request-failed`
 *   event (REQUEST_FAILED_EVENT, the server's `HX-Trigger`): a toast with
 *   the server's message and the request id. No swap, so an autosave form
 *   and its queued saves stay.
 * - Any other failed answer (not ours, so no message), and a request past
 *   htmx's `timeout` (HTMX_CONFIG, the outbox's REPLAY_TIMEOUT_MS), toast a
 *   fixed message. A queueable form's timeout is the outbox's instead
 *   (views/assets/outbox.ts queues it, as it does a send error: it may have
 *   landed, and its replay is idempotent).
 *
 * One failure toast at a time: a poll failing every 2 s replaces its own.
 * Strings come from `#app-status` (src/web/layout/app-status.tsx). The
 * other htmx error listeners stay theirs: connectivity.js probes the
 * server, submit-once.js releases its buttons. Listeners sit on the
 * document once, at module evaluation (the layout loads it on every page).
 */
import { showToast } from 'toast';

const FAILED_EVENT = 'closet:request-failed';
const QUEUE_FORM = 'form[data-offline-queue]';
const FAILURE_TOAST_MS = 6_000;

const text = (name) => document.getElementById('app-status')?.dataset[name];

/** Every answer of this app names its request (src/request-context.ts). */
const isOurs = (xhr) => xhr.getResponseHeader('X-Request-ID') !== null;

const carriesFailure = (xhr) =>
  xhr.getResponseHeader('HX-Trigger')?.includes(`"${FAILED_EVENT}"`) ?? false;

let shown;

function toastFailure(message, requestId) {
  shown?.dismiss();
  const label = text('textRequestId');
  shown = showToast({
    text: requestId && label ? `${message} (${label} ${requestId})` : message,
    kind: 'warning',
    ttlMs: FAILURE_TOAST_MS,
  });
}

document.addEventListener('htmx:beforeSwap', (event) => {
  const { boosted, xhr } = event.detail;
  if (boosted && xhr.status >= 400 && isOurs(xhr)) {
    event.detail.shouldSwap = true;
  }
});

document.addEventListener(FAILED_EVENT, (event) => {
  const { message, requestId } = event.detail;
  console.warn(`[request-failures] ${requestId}: ${message}`);
  toastFailure(message, requestId);
});

document.addEventListener('htmx:responseError', (event) => {
  const { boosted, xhr } = event.detail;
  if (carriesFailure(xhr) || (boosted && isOurs(xhr))) return;
  console.warn(`[request-failures] a ${xhr.status} that is not this app's`);
  toastFailure(text('textRequestFailed'));
});

document.addEventListener('htmx:timeout', (event) => {
  const { elt } = event.detail;
  if (elt instanceof Element && elt.closest(QUEUE_FORM)) return;
  console.warn('[request-failures] no answer before the timeout');
  toastFailure(text('textRequestTimedOut'));
});
