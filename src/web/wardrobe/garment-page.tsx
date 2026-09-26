import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import { imageUrl } from '../files/image-url';
import { jsonForScript } from '../html';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, HangerIcon } from '../layout/parts';
import { ShareLinkButton } from '../share/share-button';
import type { ViewContext } from '../view-context';
import { categoryLabel, splitColors } from './garment';
import type { GarmentDetail } from './queries';
import { garmentUrl, wardrobeUrl } from './urls';

export interface GarmentPageModel {
  garment: GarmentDetail;
  /** The shared wardrobe it is in; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Edit, photo and mask: the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** Archive and delete: the owner only. */
  canDelete: boolean;
  justCreated: boolean;
  justSavedPhoto: boolean;
  /** CUTOUT_MODE: who removes the background, and so what the photo form does. */
  cutoutMode: 'client' | 'server';
}

const PHOTO_ACCEPT =
  'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif';

/**
 * The photo form's client side, as an inline module so it runs again after
 * a boosted navigation back here; the only values in it go through
 * jsonForScript. Both modes: the camera button and the mask editor's pencil
 * (mask-editor.js, delegated on #garment-photo-slot because the cutout
 * polling swaps the photo). Client mode also runs background removal before
 * upload (background-removal.js, which downloads nothing until the photo
 * input or camera is touched); server mode only prepares the photo
 * (photo-input.js) and never loads the model.
 */
function photoScript(
  appVersion: string,
  cutoutMode: 'client' | 'server',
): string {
  // Not in the importmap: only client mode's page imports it.
  const removal = jsonForScript(`/js/background-removal.js?v=${appVersion}`);
  const common = `import { wireUpEditMask } from 'mask-editor';

// Some Chrome/Android versions drop the Camera option from the gallery
// input's chooser depending on its accept value (upstream issue 99): a
// dedicated capture input launches the camera, and its file goes through
// the same path as a picked one.
const photoCaptureBtn = document.getElementById('photoCaptureBtn');
const photoCaptureInput = document.getElementById('photoCaptureInput');
const photoInputEl = document.getElementById('photoInput');
photoCaptureBtn?.addEventListener('click', () => photoCaptureInput?.click());
photoCaptureInput?.addEventListener('change', () => {
  const file = photoCaptureInput.files?.[0];
  if (!file || !photoInputEl) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  photoInputEl.files = dt.files;
  photoInputEl.dispatchEvent(new Event('change'));
});

wireUpEditMask(document.getElementById('garment-photo-slot'));
`;
  if (cutoutMode === 'server') {
    return `import { wirePhotoUpload } from 'photo-input';
${common}
wirePhotoUpload();`;
  }
  return `import { wireUpPhotoInput, isBgRemovalEnabled } from ${removal};
${common}
const toggle = document.getElementById('bgRemovalToggle');
const stored = localStorage.getItem('bgRemovalEnabled');
toggle.checked = stored === null ? true : stored !== 'false';
localStorage.setItem('bgRemovalEnabled', toggle.checked);
toggle.addEventListener('change', () => {
  localStorage.setItem('bgRemovalEnabled', toggle.checked);
  const editBtn = document.getElementById('editMaskBtn');
  if (editBtn) editBtn.style.display = toggle.checked ? '' : 'none';
  if (toggle.checked) {
    const photoInput = document.getElementById('photoInput');
    if (photoInput?.files?.length) photoInput.dispatchEvent(new Event('change'));
  }
});

wireUpPhotoInput();
if (!isBgRemovalEnabled()) {
  document.getElementById('editMaskBtn')?.style.setProperty('display', 'none');
}`;
}

// A fixed string: drops the one-shot flags so a reload or a shared URL does
// not replay the toast.
const STRIP_SAVE_FLAGS = `(() => {
  const url = new URL(window.location.href);
  if (url.searchParams.has('created') || url.searchParams.has('photoSaved')) {
    url.searchParams.delete('created');
    url.searchParams.delete('photoSaved');
    window.history.replaceState({}, '', url);
  }
})();`;

/** GET /wardrobe/:id: the photo (and its upload), the fields, and the actions. */
export function GarmentPage(props: {
  ctx: ViewContext;
  model: GarmentPageModel;
}) {
  const { ctx, model } = props;
  const { garment } = model;
  return (
    <Layout ctx={ctx} title={garment.name ?? categoryLabel(garment.category)}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-6">
          <BackLink href={wardrobeUrl(model.viewOwner)} />
          <h1 class="text-2xl font-bold flex-1">{garment.name}</h1>
        </div>
        <div id="garment-photo-slot">
          <GarmentPhotoView
            garment={garment}
            viewOwner={model.viewOwner}
            canEdit={model.canEdit}
            cutoutMode={model.cutoutMode}
          />
        </div>
        {model.canEdit && <PhotoForm ctx={ctx} model={model} />}
        <GarmentDetails garment={garment} />
        <GarmentActions ctx={ctx} model={model} />
        {model.canEdit && garment.photo && <MaskEditorDialog />}
      </main>
      {model.justCreated && (
        <SavedToast id="garment-saved-toast" text={t('GARMENT_SAVED')} />
      )}
      {model.justSavedPhoto && (
        <SavedToast id="photo-saved-toast" text={t('PHOTO_SAVED')} />
      )}
      <script dangerouslySetInnerHTML={{ __html: STRIP_SAVE_FLAGS }} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The garment's photo: the cutout (the original when there is none), with
 * the mask editor's pencil. In server mode it also shows where the server
 * cutout stands: pending polls GET /wardrobe/:id/cutout every 2 s (this
 * component again, swapped over itself; the answer without the trigger ends
 * the polling), failed offers "Try again". Its own hx-indicator keeps the
 * polls off the navbar spinner.
 */
export function GarmentPhotoView(props: {
  garment: GarmentDetail;
  viewOwner: number | undefined;
  canEdit: boolean;
  cutoutMode: 'client' | 'server';
}) {
  const { garment, viewOwner, canEdit } = props;
  const photo = garment.photo;
  if (!photo) {
    return (
      <div
        id="garment-photo"
        class="rounded-box bg-base-200 aspect-square w-full max-w-sm mx-auto flex items-center justify-center text-base-content/30 mb-6"
      >
        <HangerIcon class="size-20" strokeWidth="1" />
      </div>
    );
  }
  const status = props.cutoutMode === 'server' ? photo.cutoutStatus : 'none';
  const pending = status === 'pending';
  const polling = pending
    ? {
        'hx-get': garmentUrl(garment.id, viewOwner, '/cutout'),
        'hx-trigger': 'every 2s',
        'hx-swap': 'outerHTML',
        'hx-indicator': '#garment-photo-status',
      }
    : {};
  return (
    <div id="garment-photo" class="mb-6" {...polling}>
      <figure class="relative rounded-box overflow-hidden bg-base-200 aspect-square w-full max-w-sm mx-auto">
        <img
          src={imageUrl(photo, 'nobg')}
          alt={garment.name ?? ''}
          class="object-cover w-full h-full"
        />
        {pending && (
          <div
            id="garment-photo-status"
            role="status"
            class="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-base-100/80 p-2 text-sm"
          >
            <span class="loading loading-spinner loading-xs"></span>
            {t('REMOVING_BACKGROUND')}
          </div>
        )}
        {canEdit && !pending && (
          <EditMaskButton
            garment={garment}
            photo={photo}
            viewOwner={viewOwner}
          />
        )}
      </figure>
      {status === 'failed' && (
        <CutoutFailed
          retryUrl={
            canEdit
              ? garmentUrl(garment.id, viewOwner, '/cutout/retry')
              : undefined
          }
        />
      )}
    </div>
  );
}

/** A failed server cutout, and "Try again" for whoever may change the photo. */
function CutoutFailed(props: { retryUrl: string | undefined }) {
  return (
    <div
      role="alert"
      class="alert alert-warning alert-soft mt-2 w-full max-w-sm mx-auto flex justify-between"
    >
      <span>{t('CUTOUT_FAILED')}</span>
      {props.retryUrl && (
        <PostForm action={props.retryUrl}>
          <button type="submit" class="btn btn-sm">
            {t('CUTOUT_RETRY')}
          </button>
        </PostForm>
      )}
    </div>
  );
}

/**
 * The pencil: mask-editor.js reads what it edits and where it saves from
 * the data attributes at the tap (the button is swapped with the photo),
 * and writes the new version back into them after a save.
 */
function EditMaskButton(props: {
  garment: GarmentDetail;
  photo: NonNullable<GarmentDetail['photo']>;
  viewOwner: number | undefined;
}) {
  return (
    <button
      id="editMaskBtn"
      type="button"
      class="btn btn-circle btn-sm absolute top-2 right-2 btn-neutral opacity-80 hover:opacity-100"
      title={t('MASK_EDITOR_TITLE')}
      aria-label={t('MASK_EDITOR_TITLE')}
      data-original-url={imageUrl(props.photo, 'original')}
      data-nobg-url={imageUrl(props.photo, 'nobg')}
      data-save-url={garmentUrl(props.garment.id, props.viewOwner, '/nobg')}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        class="size-4"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
        />
      </svg>
    </button>
  );
}

/** The fields: category always, the rest when set. */
function GarmentDetails({ garment }: { garment: GarmentDetail }) {
  const colors = splitColors(garment.color);
  return (
    <div class="card bg-base-100 shadow-sm mb-4">
      <div class="card-body gap-3">
        <Detail label={t('CATEGORY')}>
          <span class="capitalize font-medium">
            {categoryLabel(garment.category)}
          </span>
        </Detail>
        {garment.brand && (
          <Detail label={t('BRAND')}>
            <span class="font-medium">{garment.brand}</span>
          </Detail>
        )}
        {garment.size && (
          <Detail label={t('SIZE')}>
            <span class="font-medium">{garment.size}</span>
          </Detail>
        )}
        {colors.length > 0 && (
          <Detail label={t('COLOR')}>
            <span class="capitalize font-medium">{colors.join(', ')}</span>
          </Detail>
        )}
        {garment.washingDetails && (
          <Detail label={t('WASHING_DETAILS')} block>
            <p class="text-sm whitespace-pre-line">{garment.washingDetails}</p>
          </Detail>
        )}
        {garment.acquiredOn && (
          <Detail label={t('DATE_ACQUIRED')}>
            <span class="font-medium">{garment.acquiredOn}</span>
          </Detail>
        )}
        {garment.notes && (
          <Detail label={t('NOTES')} block>
            <p class="text-sm whitespace-pre-line">{garment.notes}</p>
          </Detail>
        )}
      </div>
    </div>
  );
}

/**
 * What the requester may do, and nothing else: edit and share for the owner
 * and a MANAGE grantee, archive and delete for the owner, and clone for
 * anyone who can see the garment (the copy lands in their own wardrobe and
 * only reads this one).
 */
function GarmentActions({
  ctx,
  model,
}: {
  ctx: ViewContext;
  model: GarmentPageModel;
}) {
  const { garment, viewOwner } = model;
  return (
    <>
      <div class="flex flex-col gap-2 mb-6">
        {model.canEdit && (
          <a
            href={garmentUrl(garment.id, viewOwner, '/edit')}
            class="btn btn-outline btn-sm"
          >
            {t('EDIT')}
          </a>
        )}
        <a
          href={garmentUrl(garment.id, viewOwner, '/clone')}
          class="btn btn-outline btn-sm"
        >
          {t('CLONE_GARMENT')}
        </a>
        {model.canEdit && (
          <ShareLinkButton
            siteUrl={ctx.siteUrl}
            type="garment"
            shareableId={garment.shareableId}
          />
        )}
      </div>
      {model.canDelete && (
        <div class="flex flex-col gap-2">
          <button
            type="button"
            class="btn btn-outline btn-sm w-full"
            hx-post={garmentUrl(garment.id, viewOwner, '/archive')}
            hx-confirm={t(
              garment.archived ? 'CONFIRM_UNARCHIVE' : 'CONFIRM_ARCHIVE',
            )}
          >
            {t(garment.archived ? 'UNARCHIVE' : 'ARCHIVE')}
          </button>
          <button
            type="button"
            class="btn btn-error btn-outline btn-sm w-full"
            hx-delete={garmentUrl(garment.id, viewOwner)}
            hx-confirm={t('CONFIRM_DELETE')}
          >
            {t('DELETE')}
          </button>
        </div>
      )}
    </>
  );
}

function Detail(props: { label: string; block?: boolean; children: Child }) {
  return (
    <div class={props.block ? 'flex flex-col gap-1' : 'flex justify-between'}>
      <span class="text-base-content/60 text-sm">{props.label}</span>
      {props.children}
    </div>
  );
}

/**
 * Photo upload: the chosen file and, in client mode when background removal
 * made one, its cutout (nobgPhoto) in one multipart post; the server answers
 * HX-Redirect to this page with ?photoSaved=1. In server mode only the
 * photo goes up and the page then shows its cutout pending.
 */
function PhotoForm({
  ctx,
  model,
}: {
  ctx: ViewContext;
  model: GarmentPageModel;
}) {
  const { garment, viewOwner, cutoutMode } = model;
  return (
    <>
      <form
        hx-post={garmentUrl(garment.id, viewOwner, '/photo')}
        hx-encoding="multipart/form-data"
        hx-indicator="#photo-loading"
        hx-target="main"
        hx-select="main"
        hx-swap="outerHTML"
        class="flex flex-col gap-2 mb-6"
      >
        {cutoutMode === 'client' && (
          <input
            type="file"
            id="nobgPhotoInput"
            name="nobgPhoto"
            class="hidden"
            accept="image/webp"
          />
        )}
        <div class="flex gap-2 items-center">
          <input
            type="file"
            id="photoInput"
            name="photo"
            class="file-input file-input-sm flex-1"
            accept={PHOTO_ACCEPT}
          />
          <input
            type="file"
            id="photoCaptureInput"
            class="hidden"
            accept={PHOTO_ACCEPT}
            capture="environment"
          />
          <button
            id="photoCaptureBtn"
            type="button"
            class="btn btn-neutral btn-sm btn-square"
            title={t('TAKE_PHOTO')}
            aria-label={t('TAKE_PHOTO')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.174C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-6.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z"
              />
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z"
              />
            </svg>
          </button>
          <button id="photoBtn" class="btn btn-neutral btn-sm" disabled>
            {t(garment.photo ? 'UPDATE_PHOTO' : 'ADD_PHOTO')}
          </button>
          <span
            id="photo-loading"
            class="htmx-indicator loading loading-ring loading-sm"
          ></span>
        </div>
        {cutoutMode === 'client' && <ClientCutoutStatus />}
      </form>
      <script
        type="module"
        dangerouslySetInnerHTML={{
          __html: photoScript(ctx.appVersion, cutoutMode),
        }}
      />
    </>
  );
}

/** Client mode's toggle and progress for the in-browser model (background-removal.js). */
function ClientCutoutStatus() {
  return (
    <>
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          id="bgRemovalToggle"
          class="toggle toggle-sm"
          checked
        />
        <span class="text-sm">{t('BG_REMOVAL_TOGGLE')}</span>
      </label>
      <div
        id="bgStatus"
        class="hidden flex flex-col gap-1 text-sm text-base-content/60"
        data-text-default={t('REMOVING_BACKGROUND')}
        data-text-downloading={t('BG_STAGE_DOWNLOADING')}
        data-text-decoding={t('BG_STAGE_DECODING')}
        data-text-inference={t('BG_STAGE_INFERENCE')}
        data-text-mask={t('BG_STAGE_MASK')}
        data-text-encoding={t('BG_STAGE_ENCODING')}
        data-text-hint-typical={t('BG_HINT_TYPICAL_DURATION')}
        data-text-hint-slow={t('BG_HINT_STILL_WORKING')}
      >
        <div class="flex items-center gap-2">
          <span class="loading loading-spinner loading-xs"></span>
          <span id="bgStatusText">{t('REMOVING_BACKGROUND')}</span>
        </div>
        <span id="bgStatusHint" class="text-xs opacity-80">
          {t('BG_HINT_TYPICAL_DURATION')}
        </span>
      </div>
      {/* Shown by background-removal.js when the browser cannot decode the
          chosen file (HEIC on Chrome/Android); the server still stores it. */}
      <p id="bgUnsupported" class="hidden text-sm text-base-content/60">
        {t('BG_UNSUPPORTED_PHOTO')}
      </p>
    </>
  );
}

function SavedToast(props: { id: string; text: string }) {
  return (
    <div
      id={props.id}
      class="toast toast-top toast-center z-20 top-36 toast-auto-hide"
      aria-live="polite"
    >
      <div class="alert alert-success shadow-md">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="size-5 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>{props.text}</span>
      </div>
    </div>
  );
}

// The canvas's checkerboard shows through erased pixels; its colours are
// the editor's, not the theme's.
const CHECKERBOARD = [
  'background-image: linear-gradient(45deg, #cccccc 25%, transparent 25%), linear-gradient(-45deg, #cccccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #cccccc 75%), linear-gradient(-45deg, transparent 75%, #cccccc 75%)',
  'background-size: 16px 16px',
  'background-position: 0 0, 0 8px, 8px -8px, -8px 0px',
  'background-color: #ffffff',
].join('; ');

/** The mask editor (public/js/mask-editor.js), opened by the pencil on the photo. */
function MaskEditorDialog() {
  return (
    <dialog id="maskEditorDialog" class="modal">
      <div class="modal-box w-full max-w-lg p-4 flex flex-col gap-4">
        <h3 class="font-bold text-lg">{t('MASK_EDITOR_TITLE')}</h3>
        <div class="flex flex-wrap items-center gap-3">
          <div class="join">
            <button id="maskBrushErase" class="btn btn-sm join-item">
              {t('MASK_BRUSH_ERASE')}
            </button>
            <button id="maskBrushRestore" class="btn btn-sm join-item">
              {t('MASK_BRUSH_RESTORE')}
            </button>
          </div>
          <div class="flex items-center gap-2 flex-1 min-w-32">
            <span class="text-xs text-base-content/60 shrink-0">
              {t('MASK_BRUSH_SIZE')}
            </span>
            <input
              id="maskBrushSize"
              type="range"
              min="4"
              max="80"
              value="20"
              class="range range-xs flex-1"
            />
          </div>
        </div>
        <div class="overflow-auto rounded-box border border-base-300 bg-base-200">
          <canvas
            id="maskEditorCanvas"
            class="block max-w-full mx-auto cursor-crosshair"
            style={CHECKERBOARD}
          ></canvas>
        </div>
        <div class="modal-action mt-0">
          <button id="maskEditorSkip" class="btn btn-ghost btn-sm">
            {t('MASK_EDITOR_SKIP')}
          </button>
          <button id="maskEditorAccept" class="btn btn-primary btn-sm">
            {t('MASK_EDITOR_ACCEPT')}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>{t('CLOSE')}</button>
      </form>
    </dialog>
  );
}
