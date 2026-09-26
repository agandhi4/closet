/**
 * The garment photo form in server mode (CUTOUT_MODE=server): the photo
 * goes up alone and the server removes its background, so no model is ever
 * loaded here. Imported by the garment page's inline module
 * (src/web/wardrobe/garment-page.tsx).
 */

/** The submit button follows the file input: enabled once a photo is chosen. */
export const wirePhotoUpload = () => {
  const photoInput = document.getElementById('photoInput');
  const submitBtn = document.getElementById('photoBtn');
  if (!photoInput || !submitBtn) return;

  photoInput.addEventListener('change', () => {
    submitBtn.disabled = !photoInput.files?.length;
  });
};
