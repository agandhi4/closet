/**
 * The app's own confirmation, in place of the browser's confirm() box
 * (#686: the box is titled with the server host and unstyled; guards.conf
 * `@native-confirm` refuses a new one). One `<dialog id="confirm-sheet">`
 * (src/web/layout/confirm-sheet.tsx) serves every ask:
 *
 * - htmx's `hx-confirm` (`htmx:confirm`): the request is issued only once
 *   the sheet says yes;
 * - `PostForm`'s `data-confirm` (`submit`): a native post, so password
 *   saving and the no-boost rules stay; the submit is held and sent again,
 *   as it was, once confirmed;
 * - `confirmAction()`, for a script (the outbox's sign-out discard), which
 *   imports this module through the import map.
 *
 * The destructive button is labelled with the trigger's own words ("Delete",
 * "Archive"). Keyboard: Cancel takes focus (autofocus), Escape and a tap
 * outside cancel, and focus returns to the trigger. The listeners sit on the
 * document once, at module evaluation.
 */

const sheet = () => document.getElementById('confirm-sheet');

let asking = null;

/**
 * @param {{ question: string, label?: string, trigger?: Element | null }} ask
 * @returns {Promise<boolean>} true when confirmed
 */
export function confirmAction({ question, label, trigger }) {
  const dialog = sheet();
  // No sheet on the page (an error page without the layout): decline rather
  // than act without asking.
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(false);
  // One ask at a time: a second tap while the sheet is open is declined.
  if (asking) return Promise.resolve(false);

  const accept = dialog.querySelector('[data-confirm-accept]');
  dialog.querySelector('[data-confirm-question]').textContent = question;
  accept.dataset.defaultLabel ??= accept.textContent;
  accept.textContent = label || accept.dataset.defaultLabel;

  let confirmed = false;
  asking = new Promise((resolve) => {
    accept.onclick = () => {
      confirmed = true;
      dialog.close();
    };
    dialog.querySelector('[data-confirm-cancel]').onclick = () =>
      dialog.close();
    dialog.addEventListener(
      'close',
      () => {
        asking = null;
        if (trigger?.isConnected) trigger.focus();
        resolve(confirmed);
      },
      { once: true },
    );
  });
  const result = asking;
  dialog.showModal();
  return result;
}

const labelOf = (element) => element?.textContent?.trim() || undefined;

document.addEventListener('htmx:confirm', (event) => {
  const { question, elt, issueRequest } = event.detail;
  if (!question) return;
  event.preventDefault();
  void confirmAction({ question, label: labelOf(elt), trigger: elt }).then(
    (confirmed) => {
      if (confirmed) issueRequest(true);
    },
  );
});

/** Forms already confirmed, released once through the held submit's resend. */
const confirmedForms = new WeakSet();

// Bubble phase, like the inline handler this replaced: after the outbox's
// capture-phase holds (a deletion drains its queue before it is asked), and
// registered before submit-once.js (the layout loads this module first),
// which skips a submit that is already prevented.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.confirm) return;
  if (confirmedForms.delete(form)) return;
  event.preventDefault();
  const submitter = event.submitter;
  void confirmAction({
    question: form.dataset.confirm,
    label: labelOf(submitter),
    trigger: submitter ?? form,
  }).then((confirmed) => {
    if (!confirmed) return;
    confirmedForms.add(form);
    form.requestSubmit(submitter);
  });
});
