import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { GARMENT_COLORS } from './garment';
import { garmentUrl, wardrobeUrl } from './urls';
import {
  BRAND_MAX,
  CATEGORY_MAX,
  type GarmentField,
  type GarmentFormValues,
  NAME_MAX,
  SIZE_MAX,
  TEXT_MAX,
} from './validation';

/** Which form: a new garment, an edit, or a clone of `garmentId`. */
export type GarmentFormMode =
  | { kind: 'new' }
  | { kind: 'edit'; garmentId: number }
  | { kind: 'clone'; garmentId: number };

export interface GarmentFormModel {
  mode: GarmentFormMode;
  values: GarmentFormValues;
  /** The category suggestions (built-in, then the wardrobe's own). */
  categories: { value: string; label: string }[];
  /** The shared wardrobe the form was opened in; undefined for one's own. */
  viewOwner: number | undefined;
  errors?: FieldErrors<GarmentField>;
}

const TITLES = {
  new: 'NEW_GARMENT',
  edit: 'EDIT_GARMENT',
  clone: 'CLONE_GARMENT',
} as const;

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
  const { mode, values, viewOwner, errors = {} } = model;
  const back =
    mode.kind === 'new'
      ? wardrobeUrl(viewOwner)
      : garmentUrl(mode.garmentId, viewOwner);
  const title = t(TITLES[mode.kind]);
  return (
    <Layout ctx={ctx} title={title}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-6">
          <BackLink href={back} />
          <h1 class="text-2xl font-bold">{title}</h1>
        </div>
        <PostForm action={formAction(model)} class="flex flex-col gap-4">
          <TextField
            name="name"
            label={t('NAME')}
            value={values.name}
            maxlength={NAME_MAX}
            placeholder={t('NAME_PLACEHOLDER')}
          />
          <div class="form-control">
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
            />
            <datalist id="category-suggestions">
              {model.categories.map((category) => (
                <option value={category.value}>{category.label}</option>
              ))}
            </datalist>
            <Messages messages={errors.category} />
          </div>
          <TextField
            name="brand"
            label={t('BRAND')}
            value={values.brand}
            maxlength={BRAND_MAX}
            placeholder={t('BRAND_PLACEHOLDER')}
          />
          <ColorMultiSelect selected={values.colors} errors={errors.color} />
          <TextField
            name="size"
            label={t('SIZE')}
            value={values.size}
            maxlength={SIZE_MAX}
            placeholder={t('SIZE_PLACEHOLDER')}
          />
          <TextArea
            name="washingDetails"
            label={t('WASHING_DETAILS')}
            value={values.washingDetails}
            placeholder={t('WASHING_DETAILS_PLACEHOLDER')}
          />
          <div class="form-control">
            <label class="label" for="garment-acquired">
              <span class="label-text">{t('DATE_ACQUIRED')}</span>
            </label>
            <input
              id="garment-acquired"
              type="date"
              name="dateAquired"
              class={`input input-bordered ${errors.dateAquired ? 'input-error' : ''}`}
              value={values.dateAquired}
            />
            <Messages messages={errors.dateAquired} />
          </div>
          <TextArea
            name="notes"
            label={t('NOTES')}
            value={values.notes}
            placeholder={t('NOTES_PLACEHOLDER')}
          />
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

function TextField(props: {
  name: string;
  label: string;
  value: string;
  maxlength: number;
  placeholder: string;
}) {
  const id = `garment-${props.name}`;
  return (
    <div class="form-control">
      <label class="label" for={id}>
        <span class="label-text">{props.label}</span>
      </label>
      <input
        id={id}
        type="text"
        name={props.name}
        class="input input-bordered"
        value={props.value}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
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
    <div class="form-control">
      <label class="label" for={id}>
        <span class="label-text">{props.label}</span>
      </label>
      <textarea
        id={id}
        name={props.name}
        class="textarea textarea-bordered"
        rows={3}
        maxlength={TEXT_MAX}
        placeholder={props.placeholder}
      >
        {props.value}
      </textarea>
    </div>
  );
}

function Messages({ messages }: { messages?: string[] }) {
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
    <div class="form-control w-full min-w-0">
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
