import type { Child } from 'hono/jsx';
import {
  FITS,
  FORMALITIES,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  propertyApplies,
  SLEEVES,
  typesOf,
  WARMTHS,
} from '../../wardrobe/properties';
import { t } from '../i18n';
import { type LabelledProperty, valueLabel } from './labels';
import type { PropertyFormValues } from './validation';

/**
 * The garment form's properties, in two blocks: the main one beside the
 * category (type, warmth, fabric weight) and the rest inside "More
 * details". Only what applies to the category's role is rendered, so a
 * shoe never offers a sleeve.
 *
 * Changing the category, a type chip or the weight posts the form to
 * POST /wardrobe/properties-fragment, which answers with both blocks: the
 * main one in place (the target) and the other out of band. The server
 * fills presets for values the user has not changed (withPresets), so the
 * page needs no script. Without htmx the form still posts and saves; only
 * the presets and the fields' refresh are missing.
 */

export const PROPS_MAIN_ID = 'garment-props-main';
export const PROPS_MORE_ID = 'garment-props-more';

/** What makes an input refresh the properties (also the form's category input). */
export const REFRESH_PROPERTIES = {
  'hx-post': '/wardrobe/properties-fragment',
  'hx-trigger': 'change',
  'hx-include': 'closest form',
  'hx-target': `#${PROPS_MAIN_ID}`,
  'hx-swap': 'outerHTML',
} as const;

export function PropertiesMain(props: {
  category: string;
  values: PropertyFormValues;
  errors?: string[];
}) {
  const { category, values } = props;
  const types = typesOf(category);
  return (
    <div id={PROPS_MAIN_ID} class="flex flex-col gap-4">
      {/* The save writes properties only when this is posted (see GarmentBody.props). */}
      <input type="hidden" name="props" value="1" />
      <input
        type="hidden"
        name="presetCategory"
        value={values.preset.category}
      />
      <input type="hidden" name="presetType" value={values.preset.type} />
      <input type="hidden" name="presetWeight" value={values.preset.weight} />
      {types.length > 0 && (
        <ChipGroup label={t('PROPERTY_TYPE')} refresh>
          <Chips
            name="type"
            property="type"
            options={types.map((type) => type.value)}
            selected={values.type}
          />
        </ChipGroup>
      )}
      {propertyApplies('warmth', category) && (
        <ChipGroup label={t('PROPERTY_WARMTH')}>
          <Chips
            name="warmth"
            property="warmth"
            options={WARMTHS}
            selected={values.warmth}
          />
        </ChipGroup>
      )}
      {propertyApplies('fabricWeight', category) && (
        <FabricWeight values={values} errors={props.errors} />
      )}
    </div>
  );
}

export function PropertiesMore(props: {
  category: string;
  values: PropertyFormValues;
  oob?: boolean;
}) {
  const { category, values } = props;
  const applies = (property: Parameters<typeof propertyApplies>[0]) =>
    propertyApplies(property, category);
  return (
    <div
      id={PROPS_MORE_ID}
      class="flex flex-col gap-4"
      hx-swap-oob={props.oob ? 'true' : undefined}
    >
      {applies('formality') && (
        <ChipGroup label={t('PROPERTY_FORMALITY')}>
          <Chips
            name="formality"
            property="formality"
            options={FORMALITIES}
            selected={values.formality}
          />
        </ChipGroup>
      )}
      {applies('materials') && (
        <ChipGroup label={t('PROPERTY_MATERIALS')}>
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
      )}
      {applies('pattern') && (
        <ChipGroup label={t('PROPERTY_PATTERN')}>
          <Chips
            name="pattern"
            property="pattern"
            options={PATTERNS}
            selected={values.pattern}
          />
        </ChipGroup>
      )}
      {applies('fit') && (
        <ChipGroup label={t('PROPERTY_FIT')}>
          <Chips
            name="fit"
            property="fit"
            options={FITS}
            selected={values.fit}
          />
        </ChipGroup>
      )}
      {applies('sleeve') && (
        <ChipGroup label={t('PROPERTY_SLEEVE')}>
          <Chips
            name="sleeve"
            property="sleeve"
            options={SLEEVES}
            selected={values.sleeve}
          />
        </ChipGroup>
      )}
      {applies('length') && (
        <ChipGroup label={t('PROPERTY_LENGTH')}>
          <Chips
            name="length"
            property="length"
            options={LENGTHS}
            selected={values.length}
          />
        </ChipGroup>
      )}
      {applies('waterResistant') && (
        <label class="label cursor-pointer justify-start gap-3">
          <input
            type="checkbox"
            name="waterResistant"
            value="true"
            class="toggle"
            checked={values.waterResistant}
          />
          <span class="label-text">{t('PROPERTY_WATER_RESISTANT')}</span>
        </label>
      )}
    </div>
  );
}

/** The fragment's answer: the main block (the target) and "More details" out of band. */
export function PropertiesFragment(props: {
  category: string;
  values: PropertyFormValues;
}) {
  return (
    <>
      <PropertiesMain category={props.category} values={props.values} />
      <PropertiesMore category={props.category} values={props.values} oob />
    </>
  );
}

/**
 * A labelled row of chips. `refresh`: a change inside refreshes the
 * properties (the type chips: a new type brings its presets).
 */
function ChipGroup(props: {
  label: string;
  refresh?: boolean;
  children: Child;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      class="flex flex-col"
      {...(props.refresh ? REFRESH_PROPERTIES : {})}
    >
      <span class="label">
        <span class="label-text">{props.label}</span>
      </span>
      <div class="flex flex-wrap gap-2">{props.children}</div>
    </div>
  );
}

/**
 * One choice among `options` as radio chips, and a clear chip (value '')
 * while something is chosen: radios cannot be unchecked, and a property
 * left unset must stay settable back to unset.
 */
function Chips(props: {
  name: string;
  property: LabelledProperty;
  options: readonly (string | number)[];
  selected: string;
}) {
  return (
    <>
      {props.selected && (
        <input
          type="radio"
          name={props.name}
          value=""
          class="btn btn-sm btn-ghost rounded-full"
          aria-label={`× ${t('CLEAR_CHOICE')}`}
        />
      )}
      {props.options.map((option) => (
        <input
          type="radio"
          name={props.name}
          value={String(option)}
          class="btn btn-sm rounded-full"
          aria-label={valueLabel(props.property, option)}
          checked={props.selected === String(option)}
        />
      ))}
    </>
  );
}

/** Typed in oz or gsm (stored in gsm); a change refreshes the warmth preset. */
function FabricWeight(props: {
  values: PropertyFormValues;
  errors?: string[];
}) {
  const { values, errors } = props;
  return (
    <div class="flex flex-col">
      <label class="label" for="garment-fabric-weight">
        <span class="label-text">{t('PROPERTY_FABRIC_WEIGHT')}</span>
      </label>
      <div class="join w-full">
        <input
          id="garment-fabric-weight"
          type="text"
          inputmode="decimal"
          name="fabricWeight"
          class={`input input-bordered join-item flex-1 ${errors ? 'input-error' : ''}`}
          value={values.fabricWeight}
          maxlength={12}
          placeholder={t('FABRIC_WEIGHT_PLACEHOLDER')}
          autocomplete="off"
          {...REFRESH_PROPERTIES}
        />
        <select
          name="fabricWeightUnit"
          class="select select-bordered join-item w-24"
          aria-label={t('PROPERTY_FABRIC_WEIGHT')}
          {...REFRESH_PROPERTIES}
        >
          <option value="oz" selected={values.fabricWeightUnit === 'oz'}>
            {t('UNIT_OZ')}
          </option>
          <option value="gsm" selected={values.fabricWeightUnit === 'gsm'}>
            {t('UNIT_GSM')}
          </option>
        </select>
      </div>
      {errors?.map((message) => (
        <p class="text-error text-sm mt-1" role="alert">
          {message}
        </p>
      ))}
    </div>
  );
}
