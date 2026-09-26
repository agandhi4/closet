/**
 * Client-side background removal for garment photo uploads.
 *
 * Runs @imgly/background-removal in a Web Worker (ONNX + WASM) before the
 * form submits, injecting the processed webp into a hidden nobgPhoto field.
 * On any failure the form submits unchanged and the nobg variant falls back
 * to the original photo when served.
 *
 * Models are served from /bg-removal-models/ (@imgly/background-removal-data
 * installed from the IMG.LY CDN tarball, no runtime CDN required).
 *
 * Nothing heavy happens at import: the runtime module and the 42 MB model
 * are fetched on the first sign of intent (the photo input or camera button
 * is touched) and only while the bgRemovalEnabled toggle is on. Opening a
 * garment page costs the size of this file and mask-editor.js, nothing more.
 * The module specifier resolves through the importmap in the layout
 * (src/web/layout/layout.tsx).
 */

import { openMaskEditor, squarePadBlob } from 'mask-editor';

let activeProgressHandler = null;

export const isBgRemovalEnabled = () =>
  localStorage.getItem('bgRemovalEnabled') !== 'false';

const config = {
  publicPath: location.origin + '/bg-removal-models/',
  debug: true,
  // @imgly/background-removal handles graceful degradation to WASM if navigator.gpu WebGPU is unavailable
  // when set to 'gpu'.
  device: 'gpu',
  proxyToWorker: true,
  // Note when webgpu is used the 'isnet_quint8' 8bit floating point model gets converted at
  // runtime to fp16. Some overhead is incurred in this conversion step.
  model: 'isnet_quint8',
  // Can output to a given format. Notably though webp incurs
  // a compute burden on the client to convert in `imageEncode`.
  // Leave to the default 'image/png' to bypass this.
  // output: { format: 'image/webp', quality: 0.9 },
  // Stable callback required because init() is memoized by config shape.
  progress: (key, current, total) => {
    activeProgressHandler?.(key, current, total);
  },
};

let modulePromise = null;
/** The runtime (ONNX + WASM glue), fetched once. */
const loadModule = () =>
  (modulePromise ??= import('@imgly/background-removal'));

let warmed = false;
/**
 * Fetches the runtime and the model so they are ready by the time a photo is
 * picked. Called on intent only; a no-op while the toggle is off (the change
 * handler loads on demand if it is switched on later).
 */
export const warmUp = () => {
  if (warmed || !isBgRemovalEnabled()) return;
  warmed = true;
  console.info('[bg-removal] warming up runtime and model');
  loadModule()
    .then((mod) => mod.preload(config))
    .then(() => console.info('[bg-removal] assets preloaded'))
    .catch((err) => {
      // Old browser, no ES module support, offline: the form still works and
      // the server fallback handles the photo.
      warmed = false;
      console.warn('[bg-removal] preload failed:', err);
    });
};

const updateStatusText = (bgStatus, bgStatusText, key) => {
  if (!bgStatus || !bgStatusText) return;

  if (key.startsWith('fetch:') && bgStatus.dataset.textDownloading) {
    bgStatusText.textContent = bgStatus.dataset.textDownloading;
    return;
  }
  if (key === 'compute:decode' && bgStatus.dataset.textDecoding) {
    bgStatusText.textContent = bgStatus.dataset.textDecoding;
    return;
  }
  if (key === 'compute:inference' && bgStatus.dataset.textInference) {
    bgStatusText.textContent = bgStatus.dataset.textInference;
    return;
  }
  if (key === 'compute:mask' && bgStatus.dataset.textMask) {
    bgStatusText.textContent = bgStatus.dataset.textMask;
    return;
  }
  if (key === 'compute:encode' && bgStatus.dataset.textEncoding) {
    bgStatusText.textContent = bgStatus.dataset.textEncoding;
  }
};

export const wireUpPhotoInput = () => {
  const photoInput = document.getElementById('photoInput');
  const nobgInput = document.getElementById('nobgPhotoInput');
  const submitBtn = document.getElementById('photoBtn');
  const bgStatus = document.getElementById('bgStatus');
  const bgStatusText = document.getElementById('bgStatusText');
  const bgStatusHint = document.getElementById('bgStatusHint');
  const bgUnsupported = document.getElementById('bgUnsupported');
  const photoCaptureBtn = document.getElementById('photoCaptureBtn');

  if (!photoInput || !nobgInput) return;

  // Intent: the chooser or camera is about to open, so the download can
  // overlap with the user picking a photo.
  photoInput.addEventListener('focus', warmUp);
  photoInput.addEventListener('click', warmUp);
  photoCaptureBtn?.addEventListener('click', warmUp);

  photoInput.addEventListener('change', async function () {
    // Re-enable submit for the "no file" case; it will be gated by html required
    nobgInput.value = '';
    bgUnsupported?.classList.add('hidden');

    const file = photoInput.files?.[0];
    if (!file) return;

    if (!isBgRemovalEnabled()) {
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    let squareFile;
    try {
      squareFile = await squarePadBlob(file);
    } catch (err) {
      // The browser cannot decode this file (HEIC on Chrome/Android). The
      // server can, so the original goes up as-is and no cutout is made.
      console.info('[bg-removal] browser cannot decode this photo, skipping cutout:', err);
      bgUnsupported?.classList.remove('hidden');
      if (submitBtn) submitBtn.disabled = false;
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (bgStatus) bgStatus.classList.remove('hidden');

    if (bgStatusText && bgStatus?.dataset.textDefault) {
      bgStatusText.textContent = bgStatus.dataset.textDefault;
    }
    if (bgStatusHint && bgStatus?.dataset.textHintTypical) {
      bgStatusHint.textContent = bgStatus.dataset.textHintTypical;
    }

    const stillWorkingTimer = setTimeout(() => {
      if (bgStatusHint && bgStatus?.dataset.textHintSlow) {
        bgStatusHint.textContent = bgStatus.dataset.textHintSlow;
      }
    }, 5000);

    // Fallback timeline when progress events are sparse.
    const fallbackStages = [
      { delayMs: 700, textKey: 'textDownloading' },
      { delayMs: 1800, textKey: 'textDecoding' },
      { delayMs: 3200, textKey: 'textInference' },
      { delayMs: 5600, textKey: 'textMask' },
      { delayMs: 7600, textKey: 'textEncoding' },
    ];
    let latestProgressEventAt = Date.now();
    const fallbackTimers = fallbackStages.map(({ delayMs, textKey }) =>
      setTimeout(() => {
        if (Date.now() - latestProgressEventAt < 1500) return;
        const stageText = bgStatus?.dataset[textKey];
        if (stageText && bgStatusText) bgStatusText.textContent = stageText;
      }, delayMs),
    );

    activeProgressHandler = (key) => {
      latestProgressEventAt = Date.now();
      updateStatusText(bgStatus, bgStatusText, key);
    };

    try {
      const { removeBackground } = await loadModule();
      const rawBlob = await removeBackground(squareFile, config);
      const blob = await openMaskEditor(squareFile, rawBlob);

      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'nobg.webp', { type: 'image/webp' }));
      nobgInput.files = dt.files;
    } catch (err) {
      // Processing failed: clear any partial result and let server fallback run
      console.warn(
        '[bg-removal] Processing failed, using server fallback:',
        err,
      );
      nobgInput.value = '';
    } finally {
      clearTimeout(stillWorkingTimer);
      fallbackTimers.forEach(clearTimeout);
      activeProgressHandler = null;
      if (bgStatus) bgStatus.classList.add('hidden');
      if (submitBtn) submitBtn.disabled = false;
    }
  });
};

export default {
  isBgRemovalEnabled,
  warmUp,
  wireUpPhotoInput,
};
