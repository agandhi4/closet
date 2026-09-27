import {
  NEVER_WASH,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../../wardrobe/availability';
import { CONDITIONS } from '../../wardrobe/properties';
import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { ViewContext } from '../view-context';
import { GARMENT_COLORS } from '../../wardrobe/properties';
import { categoryLabel, normalizeCategory } from './garment';
import { valueLabel } from './labels';
import {
  LinkImportSection,
  type LinkImportView,
} from './link-import/photo-choice';
import {
  PropertiesMain,
  PropertiesMore,
  REFRESH_PROPERTIES,
} from './property-fields';
import type { ReplaceableGarment } from '../wishlist/queries';
import type { CandidateFor } from './destination';
import {
  type Destination,
  destinationParams,
  garmentUrl,
  LINK_IMPORT_PATH,
  wardrobeUrl,
  WISHLIST_PATH,
} from './urls';
import {
  BRAND_MAX,
  CARE_NOTE_MAX,
  type CareFormValues,
  CATEGORY_MAX,
  type GarmentField,
  type GarmentFormValues,
  NAME_MAX,
  PRICE_INPUT_MAX,
  SIZE_MAX,
  SOURCE_URL_MAX,
  TEXT_MAX,
} from './validation';

/**
 * Which form: a new garment (to the closet or the wishlist), an edit (of a
 * wishlist item, or not), or a clone of `garmentId`.
 */
export type GarmentFormMode =
  | { kind: 'new'; destination: Destination }
  | { kind: 'edit'; garmentId: number; wishlist: boolean }
  | { kind: 'clone'; garmentId: number };

/** A form for a wishlist item: a new one, or an edit of one. */
export function isWishlistForm(mode: GarmentFormMode): boolean {
  return (
    (mode.kind === 'new' && mode.destination.to === 'wishlist') ||
    (mode.kind === 'edit' && mode.wishlist)
  );
}

export interface GarmentFormModel {
  mode: GarmentFormMode;
  values: GarmentFormValues;
  /** The category suggestions (built-in, then the wardrobe's own). */
  categories: { value: string; label: string }[];
  /** The shared wardrobe the form was opened in; undefined for one's own. */
  viewOwner: number | undefined;
  errors?: FieldErrors<GarmentField>;
  /** A new garment's form prefilled from a link (link-import/routes.tsx). */
  link?: LinkImportView;
  /** A wishlist form's "Replaces" choices (renderGarmentForm reads them). */
  replaceable?: ReplaceableGarment[];
  /** The owner's plan item a new wishlist item is a candidate for (34b; its destination's planItem). */
  candidateFor?: CandidateFor;
}

const TITLES = {
  new: 'NEW_GARMENT',
  edit: 'EDIT_GARMENT',
  clone: 'CLONE_GARMENT',
} as const;

function formTitle(mode: GarmentFormMode): string {
  return mode.kind === 'new' && mode.destination.to === 'wishlist'
    ? t('wishlist.ADD_TITLE')
    : t(TITLES[mode.kind]);
}

/** Where Cancel and the back arrow go. */
function backUrl({ mode, viewOwner }: GarmentFormModel): string {
  if (mode.kind !== 'new') return garmentUrl(mode.garmentId, viewOwner);
  return mode.destination.to === 'wishlist'
    ? wardrobeUrl(viewOwner, {}, WISHLIST_PATH)
    : wardrobeUrl(viewOwner);
}

function formAction({ mode, viewOwner }: GarmentFormModel): string {
  switch (mode.kind) {
    case 'new':
      return wardrobeUrl(viewOwner);
    case 'edit':
      return garmentUrl(mode.garmentId, viewOwner);
    case 'clone':
      return garmentUrl(mode.garmentId, viewOwner, '/clone');
  }
}

/**
 * GET /wardrobe/new, /wardrobe/:id/edit and /wardrobe/:id/clone, and their
 * re-render with the messages when a post is refused (400). A native post
 * (PostForm): htmx drops a boosted 4xx, so a refused save would show nothing.
 * Field names are the ones the form has always posted (cached pages of the
 * installed app still send them), dateAquired included.
 */
export function GarmentFormPage(props: {
  ctx: ViewContext;
  model: GarmentFormModel;
}) {
  const { ctx, model } = props;
  const { mode, values, viewOwner, link, errors = {} } = model;
  const back = backUrl(model);
  const wishlist = isWishlistForm(mode);
  const title = formTitle(mode);
  const category = normalizeCategory(values.category);
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={back} />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        {mode.kind === 'new' && !link && (
          <a
            href={wardrobeUrl(
              viewOwner,
              destinationParams(mode.destination),
              LINK_IMPORT_PATH,
            )}
            class="btn btn-outline btn-sm w-full mb-4"
          >
            {t('linkImport.ADD_FROM_LINK')}
          </a>
        )}
        <PostForm action={formAction(model)} class="flex flex-col gap-4">
          {link && (
            <LinkImportSection
              link={link}
              viewOwner={viewOwner}
              errors={errors.linkPhoto}
            />
          )}
          <TextField
            name="name"
            label={t('NAME')}
            value={values.name}
            maxlength={NAME_MAX}
            placeholder={t('NAME_PLACEHOLDER')}
          />
          <div class="flex flex-col">
            <label class="label" for="garment-category">
              <span class="label-text">{t('CATEGORY')} *</span>
            </label>
            <input
              id="garment-category"
              type="text"
              name="category"
              list="category-suggestions"
              class={`input input-bordered w-full ${errors.category ? 'input-error' : ''}`}
              value={values.category}
              maxlength={CATEGORY_MAX}
              required
              placeholder={t('TYPE_OR_SELECT_CATEGORY')}
              autocomplete="off"
              {...REFRESH_PROPERTIES}
            />
            <datalist id="category-suggestions">
              {model.categories.map((category) => (
                <option value={category.value}>{category.label}</option>
              ))}
            </datalist>
            <Messages messages={errors.category} />
          </div>
          <PropertiesMain
            category={category}
            values={values.properties}
            errors={errors.fabricWeight}
          />
          <ColorMultiSelect selected={values.colors} errors={errors.color} />
          <TextField
            name="brand"
            label={t('BRAND')}
            value={values.brand}
            maxlength={BRAND_MAX}
            placeholder={t('BRAND_PLACEHOLDER')}
          />
          <TextField
            name="size"
            label={t('SIZE')}
            value={values.size}
            maxlength={SIZE_MAX}
            placeholder={t('SIZE_PLACEHOLDER')}
          />
          <OwnershipFields model={model} wishlist={wishlist} />
          <MoreDetails model={model} wishlist={wishlist} category={category} />
          <div class="flex gap-2 mt-2">
            <a href={back} class="btn btn-ghost flex-1">
              {t('CANCEL')}
            </a>
            <button type="submit" class="btn btn-primary flex-1">
              {t('SAVE')}
            </button>
          </div>
        </PostForm>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * What depends on whether the garment is owned: copies for the closet's
 * form, what it replaces for a wishlist form.
 */
function OwnershipFields(props: {
  model: GarmentFormModel;
  wishlist: boolean;
}) {
  const { model, wishlist } = props;
  const { values, mode, errors = {} } = model;
  if (wishlist) {
    return (
      <WishlistFields
        mode={mode}
        replaces={values.replaces}
        choices={model.replaceable ?? []}
        candidateFor={model.candidateFor}
      />
    );
  }
  return (
    <>
      {/* The save writes the care fields only when this is posted (see GarmentBody.care). */}
      <input type="hidden" name="care" value="1" />
      <QuantityField value={values.care.quantity} errors={errors.quantity} />
    </>
  );
}

/**
 * The collapsed "More details": the other properties, washing, and the
 * closet's care, condition and acquired date (not on a wishlist form: those
 * come with "Bought it"), then the product link, price and notes.
 */
function MoreDetails(props: {
  model: GarmentFormModel;
  wishlist: boolean;
  category: string;
}) {
  const { model, wishlist, category } = props;
  const { values, errors = {} } = model;
  return (
    <details
      class="collapse collapse-arrow bg-base-200"
      open={moreDetailsOpen(model, wishlist)}
    >
      <summary class="collapse-title font-medium">{t('MORE_DETAILS')}</summary>
      <div class="collapse-content flex flex-col gap-4">
        <PropertiesMore category={category} values={values.properties} />
        {/* A wishlist item is not worn, washed or acquired yet: those
              fields come with "Bought it" and the closet's form. */}
        {!wishlist && <WashAfterField value={values.care.washAfterWears} />}
        <TextArea
          name="washingDetails"
          label={t('WASHING_DETAILS')}
          value={values.washingDetails}
          placeholder={t('WASHING_DETAILS_PLACEHOLDER')}
        />
        {!wishlist && <ConditionFields care={values.care} />}
        {!wishlist && (
          <div class="flex flex-col">
            <label class="label" for="garment-acquired">
              <span class="label-text">{t('DATE_ACQUIRED')}</span>
            </label>
            <input
              id="garment-acquired"
              type="date"
              name="dateAquired"
              class={`input input-bordered w-full ${errors.dateAquired ? 'input-error' : ''}`}
              value={values.dateAquired}
            />
            <Messages messages={errors.dateAquired} />
          </div>
        )}
        {/* The save writes the two below only when this is posted (see GarmentBody.product). */}
        <input type="hidden" name="product" value="1" />
        <TextField
          name="sourceUrl"
          label={t('PRODUCT_LINK')}
          value={values.sourceUrl}
          maxlength={SOURCE_URL_MAX}
          placeholder={t('PRODUCT_LINK_PLACEHOLDER')}
          type="url"
          errors={errors.sourceUrl}
        />
        <TextField
          name="price"
          label={t('PRICE')}
          value={values.price}
          maxlength={PRICE_INPUT_MAX}
          placeholder={t('PRICE_PLACEHOLDER')}
          inputmode="decimal"
          errors={errors.price}
        />
        <TextArea
          name="notes"
          label={t('NOTES')}
          value={values.notes}
          placeholder={t('NOTES_PLACEHOLDER')}
        />
      </div>
    </details>
  );
}

/**
 * "More details" opens by default only when something inside needs
 * attention: a message, or what a link filled in there (materials, the
 * link, the price) for review; and always on a wishlist form, where the
 * product link and price are what the item is.
 */
function moreDetailsOpen(
  { errors = {}, link, values }: GarmentFormModel,
  wishlist: boolean,
): boolean {
  return (
    wishlist ||
    errors.dateAquired !== undefined ||
    errors.sourceUrl !== undefined ||
    errors.price !== undefined ||
    (link !== undefined && values.sourceUrl !== '')
  );
}

/**
 * A wishlist form's own fields: its destination (a new one, with the plan
 * item it is a candidate for, 34b), and what it replaces, with the marker
 * the save reads it by (GarmentBody.wishlist). The choices are the closet's
 * garments, those that need replacing first.
 */
function WishlistFields(props: {
  mode: GarmentFormMode;
  replaces: string;
  choices: ReplaceableGarment[];
  candidateFor: CandidateFor | undefined;
}) {
  const { candidateFor } = props;
  const attention = props.choices.filter((g) => g.condition !== 'good');
  const rest = props.choices.filter((g) => g.condition === 'good');
  const option = (garment: ReplaceableGarment) => (
    <option
      value={String(garment.id)}
      selected={props.replaces === String(garment.id)}
    >
      {garment.name ?? categoryLabel(garment.category)}
      {garment.condition !== 'good' &&
        ` (${valueLabel('condition', garment.condition)})`}
    </option>
  );
  return (
    <>
      {props.mode.kind === 'new' && (
        <input type="hidden" name="to" value="wishlist" />
      )}
      {props.mode.kind === 'new' && candidateFor && (
        <>
          <input
            type="hidden"
            name="planItem"
            value={String(candidateFor.id)}
          />
          <p class="alert alert-info text-sm" id="garment-candidate-for">
            {t('shopping.CANDIDATE_FOR', {
              item: candidateFor.title,
              plan: candidateFor.planName,
            })}
          </p>
        </>
      )}
      <input type="hidden" name="wishlist" value="1" />
      <div class="flex flex-col">
        <label class="label" for="garment-replaces">
          <span class="label-text">{t('wishlist.REPLACES_LABEL')}</span>
        </label>
        <select
          id="garment-replaces"
          name="replaces"
          class="select select-bordered w-full"
        >
          <option value="" selected={props.replaces === ''}>
            {t('wishlist.REPLACES_NOTHING')}
          </option>
          {attention.length > 0 && (
            <optgroup label={t('wishlist.REPLACES_ATTENTION')}>
              {attention.map(option)}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label={t('wishlist.REPLACES_OTHERS')}>
              {rest.map(option)}
            </optgroup>
          )}
        </select>
      </div>
    </>
  );
}

function TextField(props: {
  name: string;
  label: string;
  value: string;
  maxlength: number;
  placeholder: string;
  type?: 'text' | 'url';
  inputmode?: 'decimal';
  errors?: string[];
}) {
  const id = `garment-${props.name}`;
  return (
    <div class="flex flex-col">
      <label class="label" for={id}>
        <span class="label-text">{props.label}</span>
      </label>
      <input
        id={id}
        type={props.type ?? 'text'}
        inputmode={props.inputmode}
        name={props.name}
        class={`input input-bordered w-full ${props.errors ? 'input-error' : ''}`}
        value={props.value}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
      />
      <Messages messages={props.errors} />
    </div>
  );
}

/** Identical copies (three white tees): a number stepper, 1 to QUANTITY_MAX. */
function QuantityField(props: { value: string; errors?: string[] }) {
  return (
    <div class="flex flex-col">
      <label class="label" for="garment-quantity">
        <span class="label-text">{t('QUANTITY')}</span>
      </label>
      <input
        id="garment-quantity"
        type="number"
        name="quantity"
        min="1"
        max={QUANTITY_MAX}
        step="1"
        inputmode="numeric"
        class={`input input-bordered w-28 ${props.errors ? 'input-error' : ''}`}
        value={props.value}
      />
      <span class="text-xs text-muted mt-1">{t('QUANTITY_HINT')}</span>
      <Messages messages={props.errors} />
    </div>
  );
}

/** Wears before a wash: the category's default, a count, or never. */
function WashAfterField(props: { value: string }) {
  const options: { value: string; label: string }[] = [
    { value: '', label: t('WASH_AFTER_DEFAULT') },
    ...WASH_AFTER_CHOICES.map((wears) => ({
      value: String(wears),
      label:
        wears === 1
          ? t('WASH_AFTER_EVERY')
          : t('WASH_AFTER_WEARS', { count: wears }),
    })),
    { value: String(NEVER_WASH), label: t('WASH_AFTER_NEVER') },
  ];
  return (
    <div class="flex flex-col">
      <label class="label" for="garment-wash-after">
        <span class="label-text">{t('WASH_AFTER')}</span>
      </label>
      <select
        id="garment-wash-after"
        name="washAfterWears"
        class="select select-bordered w-full"
      >
        {options.map((option) => (
          <option value={option.value} selected={option.value === props.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The condition chips and what is wrong (kept only with a problem). */
function ConditionFields({ care }: { care: CareFormValues }) {
  return (
    <div class="flex flex-col gap-2">
      <span class="label">
        <span class="label-text">{t('CONDITION')}</span>
      </span>
      <div class="flex flex-wrap gap-2">
        {CONDITIONS.map((condition) => (
          <input
            type="radio"
            name="condition"
            value={condition}
            class="btn btn-sm rounded-full"
            aria-label={valueLabel('condition', condition)}
            checked={condition === care.condition}
          />
        ))}
      </div>
      <input
        type="text"
        name="conditionNote"
        value={care.conditionNote}
        maxlength={CARE_NOTE_MAX}
        placeholder={t('CONDITION_NOTE_PLACEHOLDER')}
        aria-label={t('CONDITION_NOTE')}
        class="input input-bordered w-full"
      />
    </div>
  );
}

function TextArea(props: {
  name: string;
  label: string;
  value: string;
  placeholder: string;
}) {
  const id = `garment-${props.name}`;
  return (
    <div class="flex flex-col">
      <label class="label" for={id}>
        <span class="label-text">{props.label}</span>
      </label>
      <textarea
        id={id}
        name={props.name}
        class="textarea textarea-bordered w-full"
        rows={3}
        maxlength={TEXT_MAX}
        placeholder={props.placeholder}
      >
        {props.value}
      </textarea>
    </div>
  );
}

/** A field's messages under it (the garment form's and "Bought it"'s). */
export function Messages({ messages }: { messages?: string[] }) {
  return (
    <>
      {messages?.map((message) => (
        <p class="text-error text-sm mt-1" role="alert">
          {message}
        </p>
      ))}
    </>
  );
}

/**
 * One checkbox per built-in colour (the form's `color` fields), inside a
 * searchable dropdown that public/js/color-multiselect.js enhances with
 * pills. Without the script it is still a working list of checkboxes. A
 * posted value outside the list (a hand-made request) is refused by the
 * server and named in the message, never rendered as an option.
 */
function ColorMultiSelect(props: { selected: string[]; errors?: string[] }) {
  const selected = new Set(props.selected);
  const count = GARMENT_COLORS.filter((color) => selected.has(color)).length;
  return (
    <div class="flex flex-col w-full min-w-0">
      <span class="label">
        <span class="label-text">{t('COLOR')}</span>
      </span>
      <details
        class="color-ms w-full min-w-0"
        data-placeholder={t('SELECT_COLOR')}
        data-selected-label={t('SELECTED')}
      >
        <summary>
          <span class="ms-pills">
            <span class="ms-placeholder">{t('SELECT_COLOR')}</span>
          </span>
          <svg
            class="ms-chevron"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>
        <div class="ms-dropdown-anchor">
          <div class="ms-dropdown">
            <div class="ms-search">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                class="ms-search-input"
                placeholder={t('SEARCH_COLORS')}
                aria-label={t('SEARCH_COLORS')}
                autocomplete="off"
              />
            </div>
            <div class="ms-options">
              {GARMENT_COLORS.map((color) => (
                <label class="ms-option">
                  <input
                    type="checkbox"
                    name="color"
                    value={color}
                    checked={selected.has(color)}
                  />
                  <span class={`ms-swatch ms-swatch--${color}`}></span>
                  <span class="capitalize">{color}</span>
                </label>
              ))}
            </div>
            <div class="ms-empty" hidden>
              {t('NO_MATCHES')}
            </div>
            <div class="ms-footer">
              <span class="ms-count">
                {count} {t('SELECTED')}
              </span>
              <button type="button" class="ms-clear">
                {t('CLEAR_ALL')}
              </button>
            </div>
          </div>
        </div>
      </details>
      <Messages messages={props.errors} />
    </div>
  );
}
