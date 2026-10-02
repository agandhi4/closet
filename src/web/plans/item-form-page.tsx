import type { Child } from 'hono/jsx';
import type { PlanItemReview } from '../../wardrobe/plan-review';
import { PLAN_PRIORITIES } from '../../wardrobe/plans';
import {
  FORMALITIES,
  GARMENT_COLORS,
  GARMENT_TYPES,
  GarmentCategory,
  MATERIALS,
  WARMTHS,
} from '../../wardrobe/properties';
import { QUANTITY_MAX } from '../../wardrobe/availability';
import { PostForm } from '../auth/form';
import type { FieldErrors } from '../auth/validation';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import type { ViewContext } from '../view-context';
import { categoryLabel } from '../wardrobe/garment';
import { valueLabel } from '../wardrobe/labels';
import { CATEGORY_MAX, PRICE_INPUT_MAX } from '../wardrobe/validation';
import { priorityLabel } from './labels';
import { itemsUrl, itemUrl, planUrl } from './urls';
import {
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  type PlanItemField,
  type PlanItemFormValues,
} from './validation';
import { CancelLink } from '../layout/parts';

const EDIT_HINT = {
  proposed: 'plans.PROPOSED_EDIT_HINT',
  revise: 'plans.REVISE_EDIT_HINT',
  declined: 'plans.DECLINED_EDIT_HINT',
} as const;

export interface ItemFormModel {
  planId: number;
  planName: string;
  /** Absent for a new item. */
  itemId?: number;
  /**
   * Its review (absent for a new item): saving a proposal or an item sent
   * back for a change accepts it; a declined one takes no save until the
   * owner reconsiders it (the plan page).
   */
  review?: PlanItemReview;
  /** The owner's note to the agent, shown with a revise or declined item. */
  ownerNote?: string | null;
  values: PlanItemFormValues;
  errors?: FieldErrors<PlanItemField>;
  /** The category suggestions: the built-in ones, then the owner's closet's own (categorySuggestions). */
  categories: string[];
}

/**
 * GET /wardrobe/plans/:id/items/new and .../items/:itemId/edit, and their
 * re-render with messages (400; a native post). A plan item is a target in
 * the garment model's terms: every field but the category is optional and
 * empty means any. The type list holds every category's types; the save
 * refuses one of another category with a message (no script keeps the two
 * in step).
 */
export function ItemFormPage(props: {
  ctx: ViewContext;
  model: ItemFormModel;
}) {
  const { ctx, model } = props;
  const { planId, itemId, values, errors = {} } = model;
  const editing = itemId !== undefined;
  const title = t(editing ? 'plans.EDIT_ITEM' : 'plans.ADD_ITEM');
  const back = planUrl(planId);
  return (
    <Layout ctx={ctx} title={title}>
      <AppBar ctx={ctx} title={title} back={back} formPage />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        <p class="text-sm text-muted truncate mb-2">{model.planName}</p>
        {model.review !== undefined && model.review !== 'accepted' && (
          <p role="status" class="alert alert-info alert-soft text-sm my-3">
            {t(EDIT_HINT[model.review])}
            {model.ownerNote && (
              <span class="block italic">
                {t('plans.YOUR_NOTE', { note: model.ownerNote })}
              </span>
            )}
          </p>
        )}
        <PostForm
          action={editing ? itemUrl(planId, itemId) : itemsUrl(planId)}
          class="flex flex-col gap-4 mt-4"
          needsNetwork
        >
          <TextField
            id="item-name"
            name="name"
            label={t('NAME')}
            value={values.name}
            maxlength={ITEM_NAME_MAX}
            placeholder={t('plans.ITEM_NAME_PLACEHOLDER')}
          />
          <KindFields
            values={values}
            errors={errors}
            categories={model.categories}
          />
          <ChipGroup label={t('COLOR')} hint={t('plans.COLORS_HINT')}>
            {GARMENT_COLORS.map((color) => (
              <input
                type="checkbox"
                name="colors"
                value={color}
                class="btn btn-sm rounded-full"
                aria-label={color}
                checked={values.colors.includes(color)}
              />
            ))}
          </ChipGroup>
          <ChipGroup
            label={t('PROPERTY_MATERIALS')}
            hint={t('plans.MATERIALS_HINT')}
          >
            {MATERIALS.map((material) => (
              <input
                type="checkbox"
                name="materials"
                value={material}
                class="btn btn-sm rounded-full"
                aria-label={valueLabel('materials', material)}
                checked={values.materials.includes(material)}
              />
            ))}
          </ChipGroup>
          <Range
            property="warmth"
            label={t('PROPERTY_WARMTH')}
            scale={WARMTHS}
            min={values.warmthMin}
            max={values.warmthMax}
            errors={errors.warmth}
          />
          <Range
            property="formality"
            label={t('PROPERTY_FORMALITY')}
            scale={FORMALITIES}
            min={values.formalityMin}
            max={values.formalityMax}
            errors={errors.formality}
          />
          <div class="grid grid-cols-2 gap-3">
            <Labelled
              id="item-quantity"
              label={t('plans.QUANTITY')}
              errors={errors.quantity}
            >
              <input
                id="item-quantity"
                type="number"
                name="quantity"
                min="1"
                max={String(QUANTITY_MAX)}
                inputmode="numeric"
                class={`input input-bordered w-full ${errors.quantity ? 'input-error' : ''}`}
                value={values.quantity}
              />
            </Labelled>
            <Labelled
              id="item-budget"
              label={t('plans.BUDGET')}
              errors={errors.budget}
            >
              <input
                id="item-budget"
                type="text"
                name="budget"
                inputmode="decimal"
                maxlength={PRICE_INPUT_MAX}
                class={`input input-bordered w-full ${errors.budget ? 'input-error' : ''}`}
                value={values.budget}
                placeholder={t('PRICE_PLACEHOLDER')}
              />
            </Labelled>
          </div>
          <ChipGroup label={t('plans.PRIORITY')}>
            {PLAN_PRIORITIES.map((priority) => (
              <input
                type="radio"
                name="priority"
                value={priority}
                class="btn btn-sm rounded-full"
                aria-label={priorityLabel(priority)}
                checked={values.priority === priority}
              />
            ))}
          </ChipGroup>
          <Labelled id="item-note" label={t('plans.WHY')}>
            <textarea
              id="item-note"
              name="note"
              class="textarea textarea-bordered w-full"
              rows={2}
              maxlength={ITEM_NOTE_MAX}
              placeholder={t('plans.WHY_PLACEHOLDER')}
            >
              {values.note}
            </textarea>
          </Labelled>
          <div class="flex gap-2 mt-2">
            {model.review !== 'declined' && (
              <button type="submit" class="btn btn-primary flex-1">
                {t(
                  model.review === 'proposed' || model.review === 'revise'
                    ? 'plans.SAVE_AND_ACCEPT'
                    : 'SAVE',
                )}
              </button>
            )}
            <CancelLink href={back} />
          </div>
        </PostForm>
        {editing && (
          <button
            type="button"
            class="btn btn-error btn-outline btn-sm w-full mt-8"
            hx-delete={itemUrl(planId, itemId)}
            hx-confirm={t('plans.CONFIRM_DELETE_ITEM')}
            data-needs-network
          >
            {t('plans.DELETE_ITEM')}
          </button>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * The category, typed or picked from suggestions as on the garment form
 * (a plan may ask for a custom category the closet does not hold yet: "gym
 * kit"), and the type select. The type list holds every category's types,
 * grouped; the save refuses one of another category with a message.
 */
function KindFields(props: {
  values: PlanItemFormValues;
  errors: FieldErrors<PlanItemField>;
  categories: string[];
}) {
  const { values, errors } = props;
  return (
    <>
      <Labelled
        id="item-category"
        label={`${t('CATEGORY')} *`}
        errors={errors.category}
      >
        <input
          id="item-category"
          type="text"
          name="category"
          list="item-category-suggestions"
          class={`input input-bordered w-full ${errors.category ? 'input-error' : ''}`}
          value={values.category}
          maxlength={CATEGORY_MAX}
          required
          placeholder={t('TYPE_OR_SELECT_CATEGORY')}
          autocomplete="off"
        />
        <datalist id="item-category-suggestions">
          {props.categories.map((category) => (
            <option value={category}>{categoryLabel(category)}</option>
          ))}
        </datalist>
      </Labelled>
      <Labelled id="item-type" label={t('PROPERTY_TYPE')} errors={errors.type}>
        <select
          id="item-type"
          name="type"
          class={`select select-bordered w-full ${errors.type ? 'select-error' : ''}`}
        >
          <option value="" selected={!values.type}>
            {t('plans.ANY_TYPE')}
          </option>
          {Object.values(GarmentCategory)
            .filter((category) => GARMENT_TYPES[category].length > 0)
            .map((category) => (
              <optgroup label={categoryLabel(category)}>
                {GARMENT_TYPES[category].map((type) => (
                  <option
                    value={type.value}
                    selected={values.type === type.value}
                  >
                    {valueLabel('type', type.value)}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </Labelled>
    </>
  );
}

function Labelled(props: {
  id: string;
  label: string;
  errors?: string[];
  children: Child;
}) {
  return (
    <div class="flex flex-col">
      <label class="label" for={props.id}>
        <span class="label-text">{props.label}</span>
      </label>
      {props.children}
      {props.errors?.map((message) => (
        <p class="text-error text-sm mt-1">{message}</p>
      ))}
    </div>
  );
}

function TextField(props: {
  id: string;
  name: string;
  label: string;
  value: string;
  maxlength: number;
  placeholder: string;
}) {
  return (
    <Labelled id={props.id} label={props.label}>
      <input
        id={props.id}
        type="text"
        name={props.name}
        class="input input-bordered w-full"
        value={props.value}
        maxlength={props.maxlength}
        placeholder={props.placeholder}
      />
    </Labelled>
  );
}

function ChipGroup(props: { label: string; hint?: string; children: Child }) {
  return (
    <div role="group" aria-label={props.label} class="flex flex-col">
      <span class="label">
        <span class="label-text">{props.label}</span>
      </span>
      {props.hint && <p class="text-xs text-muted mb-1">{props.hint}</p>}
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}

/** A range on a garment scale as two selects: from (any) and to (any). */
function Range(props: {
  property: 'warmth' | 'formality';
  label: string;
  scale: readonly number[];
  min: string;
  max: string;
  errors?: string[];
}) {
  const select = (end: 'Min' | 'Max', selected: string, label: string) => (
    <select
      name={`${props.property}${end}`}
      class="select select-bordered select-sm w-full"
      aria-label={`${props.label}: ${label}`}
    >
      <option value="" selected={!selected}>
        {label}
      </option>
      {props.scale.map((value) => (
        <option value={String(value)} selected={selected === String(value)}>
          {valueLabel(props.property, value)}
        </option>
      ))}
    </select>
  );
  return (
    <div role="group" aria-label={props.label} class="flex flex-col">
      <span class="label">
        <span class="label-text">{props.label}</span>
      </span>
      <div class="grid grid-cols-2 gap-3">
        {select('Min', props.min, t('plans.RANGE_FROM_ANY'))}
        {select('Max', props.max, t('plans.RANGE_TO_ANY'))}
      </div>
      {props.errors?.map((message) => (
        <p class="text-error text-sm mt-1">{message}</p>
      ))}
    </div>
  );
}
