/**
 * "Use my location" on the profile's weather section
 * (src/web/weather/settings.tsx; #14). Shows the button only where the
 * browser can locate (Geolocation needs a secure context: the https name,
 * the installed app), asks for the position on the tap (a permission prompt
 * needs the gesture), rounds it to 2 decimals (about 1 km) here, so the
 * precise position never leaves the phone, and posts it through the
 * section's hidden htmx form, which answers the section again. The server
 * rounds again; nothing else is sent.
 *
 * Called by the section's inline module each time the section is rendered
 * or swapped in, with the section element: every listener is on an element
 * of the section, never on the document.
 */

const DECIMALS = 2;
// A position the phone found in the last ten minutes is good enough, and
// coarse is all the weather needs (and quicker, and kinder to the battery).
const OPTIONS = { enableHighAccuracy: false, maximumAge: 600_000, timeout: 15_000 };
const PERMISSION_DENIED = 1;

export function initLocate(section) {
  const button = section?.querySelector('[data-locate]');
  const form = section?.querySelector('#weather-here-form');
  const status = section?.querySelector('[data-locate-status]');
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
