/**
 * "Use my location" on the profile's weather section
 * (src/web/weather/settings.tsx; #14). Shows the button only where the
 * browser can locate (Geolocation needs a secure context: the https name,
 * the installed app), asks for the position on the tap (a permission prompt
 * needs the gesture), rounds it to 2 decimals (about 1 km) here, so the
 * precise position never leaves the phone, and posts it through the
 * hidden htmx form of the section's location part, which answers that part
 * again. The server rounds again; nothing else is sent.
 *
 * Called by the location part's inline module each time it is rendered or
 * swapped in, with its element: every listener is on an element inside it,
 * never on the document.
 */

const DECIMALS = 2;
// A position the phone found in the last ten minutes is good enough, and
// coarse is all the weather needs (and quicker, and kinder to the battery).
const OPTIONS = { enableHighAccuracy: false, maximumAge: 600_000, timeout: 15_000 };
const PERMISSION_DENIED = 1;

export function initLocate(part) {
  const button = part?.querySelector('[data-locate]');
  const form = part?.querySelector('#weather-here-form');
  const status = part?.querySelector('[data-locate-status]');
  if (!button || !form || !status) return;
  if (!window.isSecureContext || !('geolocation' in navigator)) return;
  button.hidden = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    status.hidden = true;
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        form.elements.latitude.value = coords.latitude.toFixed(DECIMALS);
        form.elements.longitude.value = coords.longitude.toFixed(DECIMALS);
        form.requestSubmit();
      },
      (error) => {
        button.disabled = false;
        status.textContent =
          error.code === PERMISSION_DENIED
            ? status.dataset.denied
            : status.dataset.failed;
        status.hidden = false;
      },
      OPTIONS,
    );
  });
}
