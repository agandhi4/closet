/**
 * Client-side toasts for events the server never sees: connectivity changes
 * (connectivity.js) and service worker updates (pwa.js). Server-driven
 * feedback keeps using hx-swap-oob fragments; this is only for the two
 * scripts that run without a request.
 *
 * Renders into #toast-host (src/web/layout/app-status.tsx). hx-boost body
 * swaps replace the host, so callers that need a toast to persist re-show it
 * on htmx:afterSettle.
 */

const host = () => document.getElementById('toast-host');

/**
 * @param {{ text: string, kind?: 'info'|'success'|'warning', ttlMs?: number,
 *           action?: { label: string, onClick: () => void } }} options
 * @returns {{ dismiss: () => void, element: HTMLElement }}
 */
export function showToast({ text, kind = 'info', ttlMs, action }) {
  const element = document.createElement('div');
  element.className = `alert alert-${kind} py-2 text-sm shadow-md`;
  element.setAttribute('role', 'status');

  const label = document.createElement('span');
  label.textContent = text;
  element.append(label);

  const dismiss = () => element.remove();

  if (action) {
    const button = document.createElement('button');
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
  return { dismiss, element };
}
