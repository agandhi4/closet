/**
 * A chosen photo, prepared on the phone before upload (preparePhoto, which
 * the photo inputs' onchange imports: PREPARE_AND_SUBMIT_PHOTO in
 * src/web/layout/parts.tsx, used by the garment page's photo sheet, the
 * add sheet's camera and library, and the outfit selfies); the server
 * removes a garment photo's background.
 */

// The server stores photos at 1080 px (src/web/files/photos.ts); 1600
// leaves it room to downscale well while a 24 MP phone photo (~8 MB, which
// uploads slowly on a phone connection) becomes a few hundred KB.
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
const downscalePhoto = async (file) => {
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
 * Replaces the input's chosen files with their downscaled copies (setting
 * `files` fires no change event) and returns the first file that will be
 * uploaded; undefined when none is chosen. A `multiple` input (the add
 * sheet's library, #200) has each of its photos prepared in turn, one
 * decoded bitmap at a time, in the order they were picked. The name and
 * the single return value are what the handler string in cached pages
 * calls (PREPARE_AND_SUBMIT_PHOTO).
 * @param {HTMLInputElement} input
 * @returns {Promise<File | undefined>}
 */
export const preparePhoto = async (input) => {
  const files = [...(input.files ?? [])];
  if (files.length === 0) return undefined;
  const prepared = [];
  for (const file of files) prepared.push(await downscalePhoto(file));
  if (prepared.some((file, index) => file !== files[index])) {
    const dt = new DataTransfer();
    for (const file of prepared) dt.items.add(file);
    input.files = dt.files;
  }
  if (prepared.length > 1) console.info(`[photo] prepared ${prepared.length} photos`);
  return prepared[0];
};
