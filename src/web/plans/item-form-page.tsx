import type { Child } from 'hono/jsx';
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
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import { BackLink } from '../layout/parts';
import type { ViewContext } from '../view-context';
import { categoryLabel, orderCategories } from '../wardrobe/garment';
import { valueLabel } from '../wardrobe/labels';
import { PRICE_INPUT_MAX } from '../wardrobe/validation';
import { priorityLabel } from './labels';
import { itemsUrl, itemUrl, planUrl } from './urls';
import {
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  type PlanItemField,
  type PlanItemFormValues,
} from './validation';

export interface ItemFormModel {
  planId: number;
  planName: string;
  /** Absent for a new item. */
  itemId?: number;
  /** Proposed by the owner's agent: saving it here accepts it. */
  proposed?: boolean;
  values: PlanItemFormValues;
  errors?: FieldErrors<PlanItemField>;
  /** The owner's custom categories (their closet's), offered after the built-in ones. */
  customCategories: string[];
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
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-2">
          <BackLink href={back} />
          <div class="min-w-0">
            <h1 class="text-2xl font-bold">{title}</h1>
            <p class="text-sm text-base-content/60 truncate">
              {model.planName}
            </p>
          </div>
        </div>
        {model.proposed && (
          <p role="status" class="alert alert-info alert-soft text-sm my-3">
            {t('plans.PROPOSED_EDIT_HINT')}
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
            customCategories={model.customCategories}
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
            <button type="submit" class="btn btn-primary flex-1">
              {t(model.proposed ? 'plans.SAVE_AND_ACCEPT' : 'SAVE')}
            </button>
            <a href={back} class="btn btn-ghost">
              {t('CANCEL')}
            </a>
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
 * The category and type selects. The type list holds every category's
 * types, grouped; the save refuses one of another category with a message.
 */
function KindFields(props: {
  values: PlanItemFormValues;
  errors: FieldErrors<PlanItemField>;
  customCategories: string[];
}) {
  const { values, errors } = props;
  // The built-in categories, the closet's own, and the item's (a custom
  // category the closet no longer holds).
  const categories = orderCategories([
    ...new Set<string>([
      ...Object.values(GarmentCategory),
      ...props.customCategories,
      ...(values.category ? [values.category] : []),
    ]),
  ]);
  return (
    <>
      <Labelled
        id="item-category"
        label={`${t('CATEGORY')} *`}
        errors={errors.category}
      >
        <select
          id="item-category"
          name="category"
          class={`select select-bordered w-full ${errors.category ? 'select-error' : ''}`}
          required
        >
          <option value="" selected={!values.category}>
            {t('plans.CHOOSE_CATEGORY')}
          </option>
          {categories.map((category) => (
            <option value={category} selected={values.category === category}>
              {categoryLabel(category)}
            </option>
          ))}
        </select>
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
      {props.hint && (
        <p class="text-xs text-base-content/60 mb-1">{props.hint}</p>
      )}
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
