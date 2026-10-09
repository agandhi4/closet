import type { Child } from 'hono/jsx';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
} from '../../wardrobe/care';
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
import { autosaveAttributes } from '../autosave';
import { t } from '../i18n';
import { type LabelledProperty, valueLabel } from './labels';
import type { PropertyFormValues } from './garment-input';

/**
 * The garment form's properties, in two blocks: the main one beside the
 * category (type, warmth, fabric weight) and the rest inside "More
 * details". Only what applies to the category's role is rendered, so a
 * shoe never offers a sleeve.
 *
 * Changing the category or anything in either block posts the whole form
 * to POST /wardrobe/properties-fragment, which answers both blocks'
 * contents: the main one's in place (the target) and the other's out of
 * band. The server fills presets for values the user has not changed
 * (withPresets), so the page needs no script. The triggers are built with
 * `autosaveAttributes` (src/web/autosave.tsx): one queue per form, and an
 * answer overtaken by a tap is dropped, so a warmth tapped while a type's
 * presets load is kept. That holds because every control in the blocks
 * posts on change (the tap's own refresh follows and lands instead), and
 * because the blocks, which carry the triggers, are never replaced, only
 * their contents. Without htmx the form still posts and saves; only the
 * presets and the fields' refresh are missing.
 */

export const PROPS_MAIN_ID = 'garment-props-main';
export const PROPS_MORE_ID = 'garment-props-more';

/** What refreshes the properties: both blocks, and the form's category input. */
export const REFRESH_PROPERTIES = autosaveAttributes(
  '/wardrobe/properties-fragment',
  `#${PROPS_MAIN_ID}`,
);

interface PropertiesProps {
  category: string;
  values: PropertyFormValues;
}

export function PropertiesMain(props: PropertiesProps & { errors?: string[] }) {
  return (
    <div id={PROPS_MAIN_ID} class="flex flex-col gap-4" {...REFRESH_PROPERTIES}>
      <PropertiesMainFields {...props} />
    </div>
  );
}

export function PropertiesMore(props: PropertiesProps) {
  return (
    <div id={PROPS_MORE_ID} class="flex flex-col gap-4" {...REFRESH_PROPERTIES}>
      <PropertiesMoreFields {...props} />
    </div>
  );
}

/** The fragment's answer: the main block's contents (the target) and "More details"' out of band. */
export function PropertiesFragment(props: PropertiesProps) {
  return (
    <>
      <PropertiesMainFields {...props} />
      <div id={PROPS_MORE_ID} hx-swap-oob="innerHTML">
        <PropertiesMoreFields {...props} />
      </div>
    </>
  );
}

function PropertiesMainFields(props: PropertiesProps & { errors?: string[] }) {
  const { category, values } = props;
  const types = typesOf(category);
  return (
    <>
      {/* The save writes properties only when this is posted (see GarmentBody.props). */}
      <input type="hidden" name="props" value="1" />
      {/* Where the presets on screen came from (withPresets' `from`). They
          are redrawn only with the chips they describe, so when autosave.js
          drops an overtaken answer (a category change, then a quick warmth
          tap) they stay a step behind the category and type the form now
          posts: the markers of the chips still on screen. That is what
          applyPresets needs: the next answer moves only the values still
          equal to those presets (so a tap stays, unless it picked the
          preset's own value, as without the lag), fills what is unset, and
          carries markers for the category and type it drew, so the lag
          lasts one answer. test/autosave.spec.ts locks it in. */}
      <input
        type="hidden"
        name="presetCategory"
        value={values.preset.category}
      />
      <input type="hidden" name="presetType" value={values.preset.type} />
      <input type="hidden" name="presetWeight" value={values.preset.weight} />
      {types.length > 0 && (
        <ChipGroup label={t('PROPERTY_TYPE')}>
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
    </>
  );
}

function PropertiesMoreFields(props: PropertiesProps) {
  const { category, values } = props;
  const applies = (property: Parameters<typeof propertyApplies>[0]) =>
    propertyApplies(property, category);
  return (
    <>
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
      <CareLabelFields {...props} />
    </>
  );
}

/**
 * The care label (#23), under the other properties: the washing, bleach,
 * drying, ironing and dry cleaning chips, for a role that has a label. The
 * materials fill it in (withCarePresets) where nothing was chosen. The
 * marker and the materials the presets came from are rendered for every
 * role, so a garment recategorised as shoes has its label cleared.
 */
function CareLabelFields(props: PropertiesProps) {
  const { category, values } = props;
  const groups = [
    { name: 'careWash', label: t('care.WASH'), options: CARE_WASH },
    { name: 'careBleach', label: t('care.BLEACH'), options: CARE_BLEACH },
    { name: 'careDry', label: t('care.DRY'), options: CARE_DRY },
    { name: 'careIron', label: t('care.IRON'), options: CARE_IRON },
    {
      name: 'careDryClean',
      label: t('care.DRY_CLEAN'),
      options: CARE_DRY_CLEAN,
    },
  ] as const;
  return (
    <>
      {/* The save writes the care label only when this is posted (see GarmentBody.careLabel). */}
      <input type="hidden" name="careLabel" value="1" />
      {/* The materials the label's presets came from (withCarePresets'
          `from`), redrawn with the chips they describe, as presetType. */}
      <input
        type="hidden"
        name="presetMaterials"
        value={values.preset.materials}
      />
      {propertyApplies('careWash', category) && (
        <div
          id="garment-care-label"
          role="group"
          aria-labelledby="garment-care-label-title"
          class="flex flex-col gap-4"
        >
          <div>
            <h3 id="garment-care-label-title" class="font-medium">
              {t('care.LABEL')}
            </h3>
            <p class="text-xs text-muted">{t('care.LABEL_HINT')}</p>
          </div>
          {groups.map((group) => (
            <ChipGroup label={group.label}>
              <Chips
                name={group.name}
                property={group.name}
                options={group.options}
                selected={values[group.name]}
              />
            </ChipGroup>
          ))}
        </div>
      )}
    </>
  );
}

/** A labelled row of chips. */
function ChipGroup(props: { label: string; children: Child }) {
  return (
    <div role="group" aria-label={props.label} class="flex flex-col">
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

/** Typed in oz or gsm (stored in gsm); a change refreshes the warmth preset (on blur: `change`). */
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
        />
        <select
          name="fabricWeightUnit"
          class="select select-bordered join-item w-24"
          aria-label={t('PROPERTY_FABRIC_WEIGHT')}
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
