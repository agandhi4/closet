import { type Static, type TSchema, Type } from '@sinclair/typebox';
import {
  NEVER_WASH,
  QUANTITY_MAX,
  WASH_AFTER_CHOICES,
} from '../../wardrobe/availability';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
} from '../../wardrobe/care';
import {
  CONDITIONS,
  FITS,
  FORMALITIES,
  GARMENT_COLORS,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
  WARMTHS,
} from '../../wardrobe/properties';
import { ENTRY_STATUSES } from '../../wardrobe/status';
import { literals, Nullable } from '../api/resource';
import type { FieldErrors } from '../auth/validation';
import { HttpError } from '../errors';
import { IsoDateSchema, ROW_ID_MAX, RowId } from '../schemas';
import type { GarmentChanges, PropertyChanges } from './garment-changes';
import {
  BRAND_MAX,
  CARE_NOTE_MAX,
  CATEGORY_MAX,
  type GarmentField,
  NAME_MAX,
  SIZE_MAX,
  SOURCE_URL_MAX,
  TEXT_MAX,
} from './garment-input';
import { OWNED_STATUSES } from './garment-actions';
import type { BulkChange, TagBody } from './grid-schemas';

/**
 * The API's garment write bodies (#192b; docs/plans/2026-11-12-json-api.md
 * section 6): JSON shaped as the Garment resource reads
 * (garment-resource.ts: `properties`, `careLabel`, `care`), each mapped to
 * what the page's own writer takes. A garment's fields become
 * GarmentChanges (garment-changes.ts, shared with MCP's update_garment),
 * so they are saved by the garment form's rules; absent leaves a field,
 * null clears it.
 */

const text = (maxLength: number, description?: string) =>
  Nullable(Type.String({ maxLength }), { description });

/** Money as a client sends it: dollars, at most two decimals (numeric(10, 2)). */
const MoneyInput = Type.String({
  pattern: '^\\d{1,8}(\\.\\d{1,2})?$',
  description: 'A decimal amount in the household currency, e.g. "49.90"',
});

const PropertiesInput = Type.Object(
  {
    type: Nullable(Type.String({ maxLength: 40 }), {
      description:
        "A type of the garment's category; a new one presets warmth, formality, sleeve and length where they were unset or still at the old type's",
    }),
    warmth: Nullable(literals(WARMTHS)),
    formality: Nullable(literals(FORMALITIES)),
    materials: Nullable(
      Type.Array(literals(MATERIALS), { maxItems: MATERIALS.length }),
      {
        description:
          "The whole set; new materials preset the care label where it was unset or still at the old materials' care",
      },
    ),
    pattern: Nullable(literals(PATTERNS)),
    fit: Nullable(literals(FITS)),
    sleeve: Nullable(literals(SLEEVES)),
    length: Nullable(literals(LENGTHS)),
    fabricWeightGsm: Nullable(Type.Integer({ minimum: 1, maximum: 10_000 })),
    waterResistant: Type.Optional(Type.Boolean()),
  },
  {
    title: 'GarmentPropertiesInput',
    description:
      "A property the garment's role does not have (a sleeve on shoes) is not kept",
  },
);

const CareLabelInput = Type.Object(
  {
    wash: Nullable(literals(CARE_WASH)),
    bleach: Nullable(literals(CARE_BLEACH)),
    dry: Nullable(literals(CARE_DRY)),
    iron: Nullable(literals(CARE_IRON)),
    dryClean: Nullable(literals(CARE_DRY_CLEAN)),
    notes: text(TEXT_MAX),
  },
  { title: 'CareLabelInput' },
);

const CareInput = Type.Object(
  {
    washAfterWears: Nullable(literals([NEVER_WASH, ...WASH_AFTER_CHOICES]), {
      description: "Wears before a wash; 0 never, null the role's default",
    }),
  },
  {
    title: 'GarmentCareInput',
    description: "The owner's own: ignored on a wardrobe shared with you",
  },
);

/** Every field a garment write may set but the category. */
const fields = {
  name: text(NAME_MAX),
  brand: text(BRAND_MAX),
  colors: Type.Optional(
    Type.Array(literals(GARMENT_COLORS), {
      maxItems: GARMENT_COLORS.length,
      description: 'The whole set; [] clears it',
    }),
  ),
  size: text(SIZE_MAX, 'As on the label (XL is stored as X-Large)'),
  notes: text(TEXT_MAX),
  price: Nullable(MoneyInput, { description: 'What one copy cost' }),
  acquiredOn: Nullable(IsoDateSchema),
  sourceUrl: text(SOURCE_URL_MAX, 'An http(s) link to the product'),
  quantity: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: QUANTITY_MAX,
      description: 'Identical copies',
    }),
  ),
  condition: Type.Optional(literals(CONDITIONS)),
  conditionNote: text(
    CARE_NOTE_MAX,
    'What is wrong: kept only while the condition is not good',
  ),
  properties: Type.Optional(PropertiesInput),
  careLabel: Type.Optional(CareLabelInput),
  care: Type.Optional(CareInput),
};

const Category = (options: { minLength?: number } = {}) =>
  Type.String({
    ...options,
    maxLength: CATEGORY_MAX,
    description:
      'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or your own; a new role drops the properties it does not have',
  });

/** PATCH /garments/{id}: only what changes. */
export const GarmentPatch = Type.Object(
  { category: Type.Optional(Category({ minLength: 1 })), ...fields },
  {
    title: 'GarmentPatch',
    description:
      'Absent leaves a field as stored, null clears it; a category is never cleared',
  },
);
export type GarmentPatch = Static<typeof GarmentPatch>;

/**
 * POST /garments: a new garment without a photo (the photo is its own
 * upload). `clientId` is accepted for the offline create (plan section 2)
 * and logged, but not yet stored (#196a adds the column), so a retry is
 * not yet answered with the first row.
 */
export const NewGarment = Type.Object(
  {
    category: Category(),
    ...fields,
    destination: Type.Optional(literals(ENTRY_STATUSES)),
    replacesGarmentId: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: ROW_ID_MAX,
        description:
          "The garment of this wardrobe a wishlist item would replace: `destination` wishlist only (another wardrobe's is not stored)",
      }),
    ),
    clientId: Type.Optional(
      Type.String({
        format: 'uuid',
        description:
          'Your id for this create, for retrying it offline: accepted, not yet deduplicated',
      }),
    ),
  },
  {
    title: 'NewGarment',
    description:
      "Lands in the closet unless `destination` says the wishlist. Saved by the garment form's rules (a new type brings its presets)",
  },
);
export type NewGarment = Static<typeof NewGarment>;

/** POST /garments/{id}/clones: the source's fields, with these changed. */
export const GarmentClone = Type.Union(
  [
    Type.Null(),
    Type.Object(
      { category: Type.Optional(Category({ minLength: 1 })), ...fields },
      {
        title: 'GarmentClone',
        description:
          'What differs from the source; absent keeps its value, the name "Copy of …"',
      },
    ),
  ],
  { description: 'None: a copy of the source as it is' },
);

/** The body's garment fields as GarmentChanges (garment-changes.ts). */
export function garmentChangesOf(
  body: Omit<GarmentPatch, 'category'> & { category?: string },
): GarmentChanges {
  const { properties = {}, careLabel = {}, care = {} } = body;
  return {
    name: body.name,
    category: body.category,
    brand: body.brand,
    colors: body.colors,
    size: body.size,
    notes: body.notes,
    price: body.price,
    acquiredOn: body.acquiredOn,
    sourceUrl: body.sourceUrl,
    quantity: body.quantity,
    condition: body.condition,
    conditionNote: body.conditionNote,
    washAfterWears: care.washAfterWears,
    careNotes: careLabel.notes,
    type: properties.type,
    warmth: properties.warmth,
    formality: properties.formality,
    materials: properties.materials,
    pattern: properties.pattern,
    fit: properties.fit,
    sleeve: properties.sleeve,
    length: properties.length,
    fabricWeightGsm: properties.fabricWeightGsm,
    waterResistant: properties.waterResistant,
    careWash: careLabel.wash,
    careBleach: careLabel.bleach,
    careDry: careLabel.dry,
    careIron: careLabel.iron,
    careDryClean: careLabel.dryClean,
  };
}

/** A change's property name where the body put it (`properties.sleeve`, `careLabel.wash`). */
const PATH_OF_PROPERTY: Record<keyof PropertyChanges, string> = {
  type: 'properties.type',
  warmth: 'properties.warmth',
  formality: 'properties.formality',
  materials: 'properties.materials',
  pattern: 'properties.pattern',
  fit: 'properties.fit',
  sleeve: 'properties.sleeve',
  length: 'properties.length',
  fabricWeightGsm: 'properties.fabricWeightGsm',
  waterResistant: 'properties.waterResistant',
  careWash: 'careLabel.wash',
  careBleach: 'careLabel.bleach',
  careDry: 'careLabel.dry',
  careIron: 'careLabel.iron',
  careDryClean: 'careLabel.dryClean',
};

export function ignoredPaths(names: (keyof PropertyChanges)[]): string[] {
  return names.map((name) => PATH_OF_PROPERTY[name]);
}

/** A form field readGarmentForm refused, where the JSON body holds it. */
const POINTER_OF_FIELD: Record<GarmentField, string> = {
  category: '/category',
  color: '/colors',
  dateAquired: '/acquiredOn',
  fabricWeight: '/properties/fabricWeightGsm',
  sourceUrl: '/sourceUrl',
  price: '/price',
  // Never posted by the API (a garment's photo is its own upload).
  linkPhoto: '',
  quantity: '/quantity',
};

/**
 * The form's refusal as the API's 400: `errors` names each field as a
 * schema validation does (`body/<pointer>`), with the message the form
 * shows under it; `detail` joins them.
 */
export function refusedGarmentBody(
  errors: FieldErrors<GarmentField>,
): HttpError {
  const validation = (
    Object.entries(errors) as [GarmentField, string[] | undefined][]
  ).flatMap(([field, messages = []]) =>
    messages.map((message) => ({
      path: `body${POINTER_OF_FIELD[field]}`,
      message,
    })),
  );
  return new HttpError(
    400,
    validation.map(({ message }) => message).join(' '),
    {
      validation,
      logDetail: `refused fields: ${Object.keys(errors).join(', ')}`,
    },
  );
}

/** PUT /garments/{id}/status (putGarmentStatus). */
export const StatusInput = Type.Object(
  {
    status: literals(OWNED_STATUSES),
  },
  { title: 'GarmentStatusInput' },
);

/** PUT /garments/{id}/condition: the garment page's condition control. */
export const ConditionInput = Type.Object(
  {
    condition: literals(CONDITIONS),
    conditionNote: text(
      CARE_NOTE_MAX,
      'What is wrong: kept only while the condition is not good',
    ),
  },
  { title: 'GarmentConditionInput' },
);

/** POST /garments/{id}/copies: how many more identical copies. */
export const CopiesInput = Type.Union([
  Type.Null(),
  Type.Object(
    {
      copies: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: QUANTITY_MAX - 1,
          // Not a schema default: ajv ignores one inside anyOf (the handler's `?? 1`).
          description: 'How many more: 1 unless sent',
        }),
      ),
    },
    { title: 'GarmentCopiesInput' },
  ),
]);

/**
 * PATCH /garments/{id}/tags: the tagging card's tap. Only what differs is
 * written; a new type's presets fill what is unset or at the old type's.
 */
export const TagsInput = Type.Object(
  {
    type: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 40,
        description: "A type of the garment's category",
      }),
    ),
    warmth: Nullable(literals(WARMTHS)),
    formality: Nullable(literals(FORMALITIES)),
  },
  { title: 'GarmentTagsInput' },
);

/** A chip as the card posts it: absent untouched, '' the reset chip. */
function chip<T extends number>(
  value: T | null | undefined,
): `${T}` | '' | undefined {
  if (value === undefined) return undefined;
  return value === null ? '' : `${value}`;
}

/** The tap as the tagging card posts it. */
export function tagBodyOf(
  input: Static<typeof TagsInput>,
): Omit<TagBody, 'next'> {
  return {
    type: input.type,
    warmth: chip(input.warmth),
    formality: chip(input.formality),
  };
}

const BulkIds = Type.Array(RowId, {
  maxItems: 2000,
  description:
    'The garments to change; one this wardrobe does not hold, or whose role lacks the property, is skipped',
});

/** One property and its value for every garment named (`property` before `value`: see Nullable). */
const bulk = <P extends string, V extends TSchema>(property: P, value: V) =>
  Type.Object({ ids: BulkIds, property: Type.Literal(property), value });

/** PATCH /garments: select mode's "Set…" (bulkSetProperty). */
export const BulkInput = Type.Union(
  [
    bulk('warmth', Type.Union([Type.Null(), literals(WARMTHS)])),
    bulk('formality', Type.Union([Type.Null(), literals(FORMALITIES)])),
    bulk('materials', literals(MATERIALS)),
    bulk('pattern', Type.Union([Type.Null(), literals(PATTERNS)])),
    bulk('fit', Type.Union([Type.Null(), literals(FITS)])),
    bulk('sleeve', Type.Union([Type.Null(), literals(SLEEVES)])),
    bulk('length', Type.Union([Type.Null(), literals(LENGTHS)])),
    bulk('waterResistant', Type.Boolean()),
    bulk('condition', literals(CONDITIONS)),
  ],
  {
    title: 'GarmentsBulkInput',
    description:
      'Sets one property on many garments: null clears it; materials adds one',
  },
);

/** The body's change (BulkChange: the page's reader answers the same shape). */
export function bulkChangeOf({ ids, ...change }: Static<typeof BulkInput>): {
  ids: number[];
  change: BulkChange;
} {
  return { ids, change };
}
