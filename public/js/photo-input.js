/**
 * The garment photo form's file, prepared on the phone before upload, in
 * both background-removal modes: background-removal.js (client mode) and
 * the garment page's inline module (server mode, wirePhotoUpload) call it.
 */

// The server stores photos at 1080 px (src/web/files/photos.ts); 1600
// leaves it room to downscale well while a 24 MP phone photo (~8 MB, which
// uploads slowly and made in-browser removal fail on iPhones) becomes a few
// hundred KB.
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.9;

const jpegName = (name) => `${name.replace(/\.[^.]*$/, '') || 'photo'}.jpg`;

/**
 * `file` downscaled to MAX_SIDE on its long side as a JPEG, or `file`
 * itself when it is already that small or the browser cannot decode it
 * (HEIC on Chrome/Android: the server decodes it). EXIF rotation is applied
 * by the decode, so the JPEG is upright without it.
 * @param {File} file
 * @returns {Promise<File>}
 */
export const downscalePhoto = async (file) => {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    console.info('[photo] the browser cannot decode this photo; uploading it as it is:', err);
    return file;
  }
  try {
    const scale = MAX_SIDE / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    // No 2D canvas (disabled or unsupported): upload the photo as it is
    // rather than leave the upload button disabled.
    if (!ctx) return file;
    // JPEG has no alpha: a transparent PNG would turn black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob) return file;
    console.info(
      `[photo] downscaled ${bitmap.width}x${bitmap.height} (${file.size} B) to ${canvas.width}x${canvas.height} (${blob.size} B)`,
    );
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
};

/**
 * Replaces the input's chosen file with its downscaled copy (setting
 * `files` fires no change event) and returns the file that will be
 * uploaded; undefined when none is chosen.
 * @param {HTMLInputElement} input
 * @returns {Promise<File | undefined>}
 */
export const preparePhoto = async (input) => {
  const file = input.files?.[0];
  if (!file) return undefined;
  const prepared = await downscalePhoto(file);
  if (prepared !== file) {
    const dt = new DataTransfer();
    dt.items.add(prepared);
    input.files = dt.files;
  }
  return prepared;
};

/**
 * Server mode (CUTOUT_MODE=server): the photo goes up alone and the server
 * removes its background, so no model is ever loaded here. The submit
 * button waits for the prepared photo.
 */
export const wirePhotoUpload = () => {
  const photoInput = document.getElementById('photoInput');
  const submitBtn = document.getElementById('photoBtn');
  if (!photoInput || !submitBtn) return;

  photoInput.addEventListener('change', async () => {
    submitBtn.disabled = true;
    const file = await preparePhoto(photoInput);
    submitBtn.disabled = !file;
  });
};
