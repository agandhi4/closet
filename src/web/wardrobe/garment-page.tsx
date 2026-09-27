import type { Child } from 'hono/jsx';
import { PostForm } from '../auth/form';
import { GarmentCapsules } from '../capsules/garment-capsules';
import type { GarmentCapsule } from '../capsules/queries';
import { imageUrl } from '../files/image-url';
import { AvoidedPartners } from '../gallery/avoided';
import { GoesWithSection } from '../gallery/goes-with';
import type { GoesWithCloset } from '../gallery/ideas';
import type { AvoidedPartner } from '../gallery/queries';
import { ideasUrl } from '../gallery/urls';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink, HangerIcon, SavedToast, StripFlags } from '../layout/parts';
import { ShareLinkButton } from '../share/share-button';
import type { ViewContext } from '../view-context';
import { type WearPanel, WearSection } from '../wears/wear-section';
import type { GarmentRef } from '../wishlist/queries';
import { categoryLabel, priceLabel, splitColors } from './garment';
import { GarmentCondition } from './garment-condition';
import { fabricWeightLabel, valueLabel } from './labels';
import type { GarmentDetail } from './queries';
import {
  destinationParams,
  garmentUrl,
  wardrobeUrl,
  WISHLIST_PATH,
} from './urls';

export interface GarmentPageModel {
  garment: GarmentDetail;
  /** The wardrobe's capsules, and whether the garment is in each. */
  capsules: GarmentCapsule[];
  /** The shared wardrobe it is in; undefined for the requester's own. */
  viewOwner: number | undefined;
  /** Wears, washes and away: the owner's alone, never a grantee's. */
  wear: WearPanel | undefined;
  /** The garment this one replaces (a wishlist item's, or a bought one's). */
  replaces: GarmentRef | undefined;
  /** Wishlist items that would replace this closet garment. */
  replacedBy: { id: number; name: string | null; category: string }[];
  /**
   * The outfit gallery's side of the garment (#9), the owner's alone like
   * outfits: "Style this" for a closet garment, and the garments it is
   * never paired with. Nothing for a grantee or a wishlist item.
   */
  styling: { canStyle: boolean; avoided: AvoidedPartner[] };
  /**
   * "Goes with my closet" (#18b): a wishlist item against the closet, the
   * owner's alone for the same reason. Undefined for a grantee and for
   * anything not on the wishlist.
   */
  goesWith: GoesWithCloset | undefined;
  /** Edit, photo, mask, condition and "Bought it": the owner and a MANAGE grantee. */
  canEdit: boolean;
  /** Archive, restore and delete: the owner only. */
  canDelete: boolean;
  justCreated: boolean;
  justSavedPhoto: boolean;
  justBought: boolean;
}

const PHOTO_ACCEPT =
  'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif';

/**
 * The photo form's client side, as an inline module so it runs again after
 * a boosted navigation back here (a fixed string): the photo is prepared on
 * the phone before upload (photo-input.js; the server removes its
 * background), the camera button, and the mask editor's pencil
 * (mask-editor.js, delegated on #garment-photo-slot because the cutout
 * polling swaps the photo).
 */
const PHOTO_SCRIPT = `import { wirePhotoUpload } from 'photo-input';
import { wireUpEditMask } from 'mask-editor';

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
wirePhotoUpload();`;

/** The one-shot flags the garment page's toasts read (GarmentPageQuery). */
const GARMENT_PAGE_FLAGS = ['created', 'photoSaved', 'bought'] as const;

/** GET /wardrobe/:id: the photo (and its upload), the fields, and the actions. */
export function GarmentPage(props: {
  ctx: ViewContext;
  model: GarmentPageModel;
}) {
  const { ctx, model } = props;
  const { garment } = model;
  const wishlist = garment.status === 'wishlist';
  return (
    <Layout ctx={ctx} title={garment.name ?? categoryLabel(garment.category)}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <GarmentHeading garment={garment} viewOwner={model.viewOwner} />
        <div id="garment-photo-slot">
          <GarmentPhotoView
            garment={garment}
            viewOwner={model.viewOwner}
            canEdit={model.canEdit}
          />
        </div>
        {model.canEdit && <PhotoForm model={model} />}
        <GarmentDetails garment={garment} />
        <Replacement model={model} />
        {/* A wishlist item is not in the closet: it has no condition, wears
            or capsules until "Bought it"; what it has is how it would go
            with the closet. */}
        <GoesWithSection goesWith={model.goesWith} />
        {!wishlist && (
          <>
            <GarmentCondition
              garment={garment}
              viewOwner={model.viewOwner}
              canEdit={model.canEdit}
            />
            {model.wear && <WearSection garment={garment} panel={model.wear} />}
            <GarmentCapsules
              garmentId={garment.id}
              capsules={model.capsules}
              viewOwner={model.viewOwner}
              canEdit={model.canEdit}
            />
            <AvoidedPartners
              garmentId={garment.id}
              partners={model.styling.avoided}
            />
          </>
        )}
        <GarmentActions ctx={ctx} model={model} />
        {model.canEdit && garment.photo && <MaskEditorDialog />}
      </main>
      {model.justCreated && (
        <SavedToast id="garment-saved-toast" text={t('GARMENT_SAVED')} />
      )}
      {model.justSavedPhoto && (
        <SavedToast id="photo-saved-toast" text={t('PHOTO_SAVED')} />
      )}
      {model.justBought && (
        <SavedToast id="bought-toast" text={t('wishlist.BOUGHT_TOAST')} />
      )}
      <StripFlags names={GARMENT_PAGE_FLAGS} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The back arrow (to the wishlist for a wishlist item, else the grid), the
 * name, and where the garment is when it is not the closet.
 */
function GarmentHeading(props: {
  garment: GarmentDetail;
  viewOwner: number | undefined;
}) {
  const { garment } = props;
  const wishlist = garment.status === 'wishlist';
  return (
    <div class="flex items-center gap-3 mb-6">
      <BackLink
        href={wardrobeUrl(
          props.viewOwner,
          {},
          wishlist ? WISHLIST_PATH : '/wardrobe',
        )}
      />
      <h1 class="text-2xl font-bold flex-1">{garment.name}</h1>
      {garment.status !== 'closet' && (
        <span class="badge badge-soft badge-primary">
          {t(wishlist ? 'wishlist.ON_WISHLIST' : 'ARCHIVED')}
        </span>
      )}
    </div>
  );
}

/**
 * The garment's photo: the cutout (the original when there is none), with
 * the mask editor's pencil, and where the cutout stands: pending polls GET /wardrobe/:id/cutout every 2 s (this
 * component again, swapped over itself; the answer without the trigger ends
 * the polling), failed offers "Try again". Its own hx-indicator keeps the
 * polls off the navbar spinner.
 */
export function GarmentPhotoView(props: {
  garment: GarmentDetail;
  viewOwner: number | undefined;
  canEdit: boolean;
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
  const status = photo.cutoutStatus;
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

/** A failed cutout, and "Try again" for whoever may change the photo. */
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

/**
 * The set properties as one row of chips ("Light · Casual · 6 oz · 203 gsm
 * · Cotton · Short sleeve"); nothing when none is set.
 */
function PropertyChips({ garment }: { garment: GarmentDetail }) {
  const words = (
    [
      ['formality', garment.formality],
      ['pattern', garment.pattern],
      ['fit', garment.fit],
      ['sleeve', garment.sleeve],
      ['length', garment.length],
    ] as const
  ).flatMap(([property, value]) =>
    value === null ? [] : [valueLabel(property, value)],
  );
  const chips = [
    ...(garment.warmth === null
      ? []
      : [`${t('PROPERTY_WARMTH')}: ${valueLabel('warmth', garment.warmth)}`]),
    ...words,
    ...(garment.fabricWeight === null
      ? []
      : [fabricWeightLabel(garment.fabricWeight)]),
    ...(garment.materials ?? []).map((material) =>
      valueLabel('materials', material),
    ),
    ...(garment.waterResistant ? [t('WATER_RESISTANT_YES')] : []),
  ];
  if (chips.length === 0) return null;
  return (
    <ul class="flex flex-wrap gap-2" aria-label={t('MORE_DETAILS')}>
      {chips.map((chip) => (
        <li class="badge badge-outline">{chip}</li>
      ))}
    </ul>
  );
}

/** The fields: category always, the rest when set. */
function GarmentDetails({ garment }: { garment: GarmentDetail }) {
  const colors = splitColors(garment.color);
  return (
    <div class="card bg-base-100 shadow-sm mb-4">
      <div class="card-body gap-3">
        <Detail label={t('CATEGORY')}>
          <span class="font-medium">
            {/* capitalize is for a custom category stored lower case; a
                type's label is already written as it should read. */}
            <span class="capitalize">{categoryLabel(garment.category)}</span>
            {garment.type && ` · ${valueLabel('type', garment.type)}`}
          </span>
        </Detail>
        <PropertyChips garment={garment} />
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
        <QuantityDetail quantity={garment.quantity} />
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
        {garment.price && (
          <Detail label={t('PRICE')}>
            <span class="font-medium">{priceLabel(garment.price)}</span>
          </Detail>
        )}
        {garment.sourceUrl && (
          // Only ever http(s) (readSourceUrl, and the column's check). A new
          // tab, so the app stays where it was; noopener keeps the shop's page
          // from reaching back into this one, noreferrer from learning its URL.
          <a
            href={garment.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="link link-primary text-sm self-start"
          >
            {t('VIEW_PRODUCT')}
          </a>
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
 * The replacement links: what this garment replaces, the wishlist items that
 * would replace it, and on a garment marked "replace soon", for whoever may
 * add to the wishlist, "Find a replacement" (the wishlist's new form,
 * prefilled from this garment).
 */
function Replacement({ model }: { model: GarmentPageModel }) {
  const { garment, viewOwner, replaces, replacedBy } = model;
  const findable =
    model.canEdit &&
    garment.status === 'closet' &&
    garment.condition === 'replace_soon';
  if (!replaces && replacedBy.length === 0 && !findable) return null;
  const link = (ref: { id: number; name: string | null; category: string }) => (
    <a href={garmentUrl(ref.id, viewOwner)} class="link link-primary">
      {ref.name ?? categoryLabel(ref.category)}
    </a>
  );
  return (
    <section
      id="garment-replacement"
      class="card bg-base-100 shadow-sm mb-4"
      aria-label={t('wishlist.REPLACEMENT')}
    >
      <div class="card-body gap-2 text-sm">
        {replaces && (
          <p>
            {t('wishlist.REPLACEMENT_FOR')} {link(replaces)}
          </p>
        )}
        {replacedBy.length > 0 && (
          <p>
            {t('wishlist.ON_WISHLIST_TO_REPLACE')}{' '}
            {replacedBy.map((item, index) => (
              <>
                {index > 0 && ', '}
                {link(item)}
              </>
            ))}
          </p>
        )}
        {findable && (
          <a
            href={wardrobeUrl(
              viewOwner,
              destinationParams({ to: 'wishlist', replaces: garment.id }),
              '/wardrobe/new',
            )}
            class="btn btn-sm btn-outline self-start"
          >
            {t('wishlist.FIND_REPLACEMENT')}
          </a>
        )}
      </div>
    </section>
  );
}

/**
 * What the requester may do, and nothing else: edit, share and a wishlist
 * item's "Bought it" for the owner and a MANAGE grantee; archive (a closet
 * garment), restore (an archived one) and delete for the owner; and clone
 * for anyone who can see the garment (the copy lands in their own wardrobe
 * and only reads this one).
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
        <StyleThis garmentId={garment.id} shown={model.styling.canStyle} />
        {model.canEdit && garment.status === 'wishlist' && (
          <a
            href={garmentUrl(garment.id, viewOwner, '/bought')}
            class="btn btn-primary btn-sm"
          >
            {t('wishlist.BOUGHT_IT')}
          </a>
        )}
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
          {garment.status === 'closet' && (
            <button
              type="button"
              class="btn btn-outline btn-sm w-full"
              hx-post={garmentUrl(garment.id, viewOwner, '/archive')}
              hx-confirm={t('CONFIRM_ARCHIVE')}
            >
              {t('ARCHIVE')}
            </button>
          )}
          {garment.status === 'archived' && (
            <button
              type="button"
              class="btn btn-outline btn-sm w-full"
              hx-post={garmentUrl(garment.id, viewOwner, '/restore')}
              hx-confirm={t('CONFIRM_RESTORE')}
            >
              {t('RESTORE')}
            </button>
          )}
          <button
            type="button"
            class="btn btn-error btn-outline btn-sm w-full"
            hx-delete={garmentUrl(garment.id, viewOwner)}
            hx-confirm={t(
              garment.status === 'wishlist'
                ? 'wishlist.CONFIRM_REMOVE'
                : 'CONFIRM_DELETE',
            )}
          >
            {t(garment.status === 'wishlist' ? 'wishlist.REMOVE' : 'DELETE')}
          </button>
        </div>
      )}
    </>
  );
}

/** The gallery's ideas that all hold this garment (`?with=`). */
function StyleThis({
  garmentId,
  shown,
}: {
  garmentId: number;
  shown: boolean;
}) {
  if (!shown) return null;
  return (
    <a
      href={ideasUrl({ destination: { kind: 'none' }, withId: garmentId })}
      class="btn btn-primary btn-sm"
    >
      {t('gallery.STYLE_THIS')}
    </a>
  );
}

/** "3 identical", for multiples only. */
function QuantityDetail({ quantity }: { quantity: number }) {
  if (quantity === 1) return null;
  return (
    <Detail label={t('QUANTITY')}>
      <span class="font-medium">{t('QUANTITY_VALUE', { quantity })}</span>
    </Detail>
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
 * Photo upload: the chosen file, downscaled on the phone, in a multipart
 * post; the server answers HX-Redirect to this page with ?photoSaved=1,
 * which then shows its cutout pending.
 */
function PhotoForm({ model }: { model: GarmentPageModel }) {
  const { garment, viewOwner } = model;
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
      </form>
      <script
        type="module"
        dangerouslySetInnerHTML={{ __html: PHOTO_SCRIPT }}
      />
    </>
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
