import { buffer } from 'node:stream/consumers';
import { QUANTITY_MAX } from '../../../wardrobe/availability';
import * as z from 'zod/v4';
import {
  categoryRole,
  CONDITIONS,
  FITS,
  FORMALITIES,
  findType,
  GARMENT_COLORS,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  type GarmentProperty,
  propertyApplies,
  SLEEVES,
  typesOf,
  WARMTHS,
} from '../../../wardrobe/properties';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
} from '../../../wardrobe/care';
import { perWearCost, totalCost } from '../../../wardrobe/insights';
import { todayIn } from '../../calendar/calendar-date';
import { capsulesOfGarment, findCapsule } from '../../capsules/queries';
import { HttpError } from '../../errors';
import { t } from '../../i18n';
import { publicPhoto } from '../../files/references';
import { normalizeCategory, normalizeSize } from '../../wardrobe/garment';
import {
  findGarment,
  type GarmentDetail,
  type GarmentSummary,
  garmentSummaries,
  gridCount,
  GRID_PAGE_SIZE,
  type GridFilters,
  setCondition,
  updateGarmentProperties,
} from '../../wardrobe/queries';
import { addCopies, closetLookalikes } from '../../wardrobe/lookalikes';
import { repairLog } from '../../wardrobe/repairs';
import {
  CATEGORY_MAX,
  NAME_MAX,
  CARE_NOTE_MAX,
  type PropertyFormValues,
  readCareLabel,
  readCondition,
  readProperties,
  storedPropertyValues,
  withCarePresets,
  withPresets,
} from '../../wardrobe/validation';
import { wearSummary } from '../../wears/queries';
import { wishlistItems } from '../../wishlist/queries';
import {
  defineTool,
  ImageAnswer,
  type ToolContext,
  wardrobeFor,
} from '../tool';
import { ownerIdInput, rowId } from './common';
import { addGarmentFromLink } from './link-import';

const GARMENT_NOT_FOUND = 'Garment not found';

/** A search or capsule hit, as the tools answer it. */
export function summaryOut(garment: GarmentSummary) {
  return {
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: categoryRole(garment.category),
    type: garment.type,
    brand: garment.brand,
    colors: garment.colors ?? [],
    size: garment.size,
    warmth: garment.warmth,
    formality: garment.formality,
    quantity: garment.quantity,
    condition: garment.condition,
    price: garment.price,
    status: garment.status,
  };
}

/**
 * A garment in full, as its page shows it, without the photo. The owner's
 * own records (wears, washes, away, cost per wear, the repair log) only on
 * their own wardrobe, as the page: a grantee gets the price alone, never a
 * cost that holds the owner's repairs.
 */
async function garmentOut(
  ctx: ToolContext,
  garment: GarmentDetail,
  ownerId: number,
  isOwner: boolean,
) {
  const [capsules, wears, repairs] = await Promise.all([
    capsulesOfGarment(ctx.db, ownerId, garment.id),
    isOwner
      ? wearSummary(ctx.db, garment.id, todayIn(ctx.timeZone, new Date()))
      : undefined,
    isOwner && garment.status !== 'wishlist'
      ? repairLog(ctx.db, garment.id)
      : undefined,
  ]);
  const cost = wears
    ? totalCost({
        price: garment.price,
        quantity: garment.quantity,
        repairCost: wears.repairCost,
      })
    : null;
  return {
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: categoryRole(garment.category),
    brand: garment.brand,
    colors: garment.colors ?? [],
    size: garment.size,
    notes: garment.notes,
    washingDetails: garment.washingDetails,
    acquiredOn: garment.acquiredOn,
    status: garment.status,
    replacesGarmentId: garment.replacesGarmentId,
    hasPhoto: garment.photo !== null,
    properties: {
      type: garment.type,
      warmth: garment.warmth,
      formality: garment.formality,
      materials: garment.materials ?? [],
      pattern: garment.pattern,
      fit: garment.fit,
      sleeve: garment.sleeve,
      length: garment.length,
      fabricWeightGsm: garment.fabricWeight,
      waterResistant: garment.waterResistant,
    },
    careLabel: {
      wash: garment.careWash,
      bleach: garment.careBleach,
      dry: garment.careDry,
      iron: garment.careIron,
      dryClean: garment.careDryClean,
      notes: garment.washingDetails,
    },
    sourceUrl: garment.sourceUrl,
    price: garment.price,
    quantity: garment.quantity,
    condition: garment.condition,
    conditionNote: garment.conditionNote,
    capsules: capsules
      .filter((capsule) => capsule.member)
      .map(({ id, name }) => ({ id, name })),
    ...(wears && {
      care: {
        washAfterWears: garment.washAfterWears,
        lastWashedOn: garment.lastWashedOn,
        away: garment.away,
        awayNote: garment.awayNote,
        worn: wears.worn,
        wornSinceWash: wears.sinceWash,
        lastWorn: wears.lastWorn,
        cost,
        costPerWear: cost === null ? null : perWearCost(cost, wears.worn),
      },
    }),
    ...(repairs && { repairs }),
  };
}

async function garmentIn(ctx: ToolContext, id: number, ownerId: number) {
  const garment = await findGarment(ctx.db, id, ownerId);
  if (!garment) throw new HttpError(404, GARMENT_NOT_FOUND);
  return garment;
}

/** A type only with its own category, as the grid (gridSearch) allows it. */
function checkedType(category: string, type: string): string {
  const found = findType(category, type);
  if (!found) {
    const types = typesOf(category).map((t) => t.value);
    throw new HttpError(
      400,
      types.length > 0
        ? `${type} is not a type of ${category}: ${types.join(', ')}`
        : `${category} has no types`,
    );
  }
  return found.value;
}

const property = <T extends z.ZodType>(schema: T, description: string) =>
  schema.nullable().optional().describe(`${description} null clears it.`);

/** update_garment's property fields; absent leaves a value as stored. */
const PropertyInput = {
  type: property(
    z.string().max(40),
    "A type of the garment's category (e.g. t-shirt, jeans, overshirt); presets for warmth, formality, sleeve and length follow it where they were unset or still at the old type's.",
  ),
  warmth: property(
    z.union(WARMTHS.map((w) => z.literal(w))),
    '1 very light to 5 very warm.',
  ),
  formality: property(
    z.union(FORMALITIES.map((f) => z.literal(f))),
    '1 lounge, 2 casual, 3 smart casual, 4 dressy.',
  ),
  materials: property(
    z.array(z.enum(MATERIALS)).max(MATERIALS.length),
    'The whole set of materials.',
  ),
  pattern: property(z.enum(PATTERNS), 'Pattern.'),
  fit: property(z.enum(FITS), 'Fit.'),
  sleeve: property(z.enum(SLEEVES), 'Sleeve length (tops, one-pieces).'),
  length: property(z.enum(LENGTHS), 'Length (bottoms, one-pieces).'),
  fabricWeightGsm: property(
    z.number().int().min(1).max(10_000),
    'Fabric weight in grams per square metre.',
  ),
  waterResistant: z
    .boolean()
    .optional()
    .describe('Water resistant (layers, footwear, accessories).'),
  careWash: property(
    z.enum(CARE_WASH),
    "The care label's washing: machine hot (60 °C), warm (40 °C) or cold (30 °C), hand, or do not wash. Changing `materials` fills the label's washing, bleach, drying and ironing where they were unset or still at the old materials' usual care.",
  ),
  careBleach: property(z.enum(CARE_BLEACH), "The care label's bleach."),
  careDry: property(z.enum(CARE_DRY), "The care label's drying."),
  careIron: property(z.enum(CARE_IRON), "The care label's ironing."),
  careDryClean: property(
    z.enum(CARE_DRY_CLEAN),
    "The care label's dry cleaning: allowed, only, never.",
  ),
};

type PropertyChanges = {
  [K in keyof typeof PropertyInput]?: z.output<(typeof PropertyInput)[K]>;
};

/** The input's property names as the garment model names them. */
const PROPERTY_OF: Record<keyof typeof PropertyInput, GarmentProperty> = {
  type: 'type',
  warmth: 'warmth',
  formality: 'formality',
  materials: 'materials',
  pattern: 'pattern',
  fit: 'fit',
  sleeve: 'sleeve',
  length: 'length',
  fabricWeightGsm: 'fabricWeight',
  waterResistant: 'waterResistant',
  careWash: 'careWash',
  careBleach: 'careBleach',
  careDry: 'careDry',
  careIron: 'careIron',
  careDryClean: 'careDryClean',
};

/**
 * The stored properties with the changes, through the form's own readers:
 * a new type first brings its presets (withPresets, as the form's type
 * chip), new materials the care label's (withCarePresets, as the form's
 * material chips), then the explicit values win, then readProperties and
 * readCareLabel store what the garment's role has. Returns the fields and
 * the names the role ignored.
 */
function changedProperties(garment: GarmentDetail, changes: PropertyChanges) {
  const { category } = garment;
  let values: PropertyFormValues = storedPropertyValues(garment);
  if (changes.type !== undefined) {
    values = withPresets(
      {
        ...values,
        type: changes.type === null ? '' : checkedType(category, changes.type),
      },
      category,
    );
  }
  if (changes.materials !== undefined) {
    values = withCarePresets(
      { ...values, materials: changes.materials ?? [] },
      category,
    );
  }
  const changed = { ...values, ...explicitValues(changes) };
  const read = readProperties(changed, category);
  if (!read.ok) throw new HttpError(400, read.error);
  const ignored = (Object.keys(changes) as (keyof PropertyChanges)[]).filter(
    (name) =>
      changes[name] !== undefined &&
      name !== 'type' &&
      !propertyApplies(PROPERTY_OF[name], category),
  );
  return {
    fields: { ...read.fields, ...readCareLabel(changed, category) },
    ignored,
  };
}

/** The single-choice properties, posted as text like the form's chips. */
const CHOICES = [
  'warmth',
  'formality',
  'pattern',
  'fit',
  'sleeve',
  'length',
  'careWash',
  'careBleach',
  'careDry',
  'careIron',
  'careDryClean',
] as const;

/** The given changes but the type, as the form's values; null is the reset chip. */
function explicitValues(changes: PropertyChanges): Partial<PropertyFormValues> {
  const values: Partial<PropertyFormValues> = {};
  for (const name of CHOICES) {
    const value = changes[name];
    if (value !== undefined) values[name] = value === null ? '' : String(value);
  }
  if (changes.materials !== undefined) {
    values.materials = changes.materials ?? [];
  }
  if (changes.fabricWeightGsm !== undefined) {
    values.fabricWeight = String(changes.fabricWeightGsm ?? '');
    values.fabricWeightUnit = 'gsm';
  }
  if (changes.waterResistant !== undefined) {
    values.waterResistant = changes.waterResistant;
  }
  return values;
}

const SearchInput = z.object({
  ownerId: ownerIdInput,
  keyword: z
    .string()
    .max(NAME_MAX)
    .optional()
    .describe('Matches the name, brand and notes.'),
  category: z
    .string()
    .max(CATEGORY_MAX)
    .optional()
    .describe(
      'tops, bottoms, dresses, outerwear, footwear, accessories, bags, other, or a custom one.',
    ),
  type: z
    .string()
    .max(40)
    .optional()
    .describe('A type of `category` (needs it).'),
  color: z.enum(GARMENT_COLORS).optional(),
  size: z.string().max(40).optional(),
  warmth: z.union(WARMTHS.map((w) => z.literal(w))).optional(),
  formality: z.union(FORMALITIES.map((f) => z.literal(f))).optional(),
  material: z.enum(MATERIALS).optional(),
  wash: z
    .enum(CARE_WASH)
    .optional()
    .describe('Only garments whose care label says to wash them this way.'),
  capsuleId: rowId().optional().describe('Members of this capsule only.'),
  needsWash: z
    .boolean()
    .default(false)
    .describe(
      'Only garments with a copy that needs a wash (your own wardrobe only).',
    ),
  needsAttention: z
    .boolean()
    .default(false)
    .describe('Only garments that need repair or replacing soon.'),
  needsTagging: z
    .boolean()
    .default(false)
    .describe(
      "Only closet garments still missing their type (where the category has types), warmth (where the role has one) or formality: the app's tagging queue. get_garment_photo shows each; update_garment tags it.",
    ),
  includeArchived: z
    .boolean()
    .default(false)
    .describe(
      'Also garments no longer in the closet (archived). The wishlist is list_wishlist.',
    ),
  before: rowId().optional().describe('The previous page’s `next`.'),
});
type SearchArgs = z.output<typeof SearchInput>;

/**
 * search_garments' arguments as the grid's filters (gridSearch's rules: a
 * category normalized, a type only of its category, a size normalized),
 * after refuseSearch.
 */
function searchFilters(args: SearchArgs): GridFilters {
  const category = args.category ? normalizeCategory(args.category) : '';
  return {
    keyword: args.keyword?.trim() || undefined,
    category: category || undefined,
    type: args.type ? checkedType(category, args.type) : undefined,
    color: args.color,
    size: normalizeSize(args.size ?? '') ?? undefined,
    warmth: args.warmth,
    formality: args.formality,
    material: args.material,
    wash: args.wash,
    capsule: args.capsuleId,
    scope: args.includeArchived ? 'owned' : 'closet',
    needsWash: args.needsWash,
    attention: args.needsAttention,
    needsTags: args.needsTagging,
  };
}

/**
 * What search_garments refuses where the grid would quietly drop or 404: a
 * type without its category, needs-wash on a shared wardrobe (it reads the
 * owner's wears; an unfiltered answer would be misread), a capsule outside
 * the wardrobe.
 */
async function refuseSearch(
  ctx: ToolContext,
  args: SearchArgs,
  access: { ownerId: number; isOwner: boolean },
): Promise<void> {
  if (args.type && !args.category) {
    throw new HttpError(400, 'A type needs its category');
  }
  if (args.needsWash && !access.isOwner) {
    throw new HttpError(403, 'needsWash reads your own wears only');
  }
  if (
    args.capsuleId !== undefined &&
    !(await findCapsule(ctx.db, args.capsuleId, access.ownerId))
  ) {
    throw new HttpError(404, 'Capsule not found');
  }
}

export const garmentTools = [
  defineTool({
    name: 'search_garments',
    title: 'Search garments',
    description: `Searches a wardrobe's closet like its grid (never the wishlist: list_wishlist): every filter optional, newest first, ${GRID_PAGE_SIZE} a page (pass the answer's \`next\` as \`before\` for the next). Answers each garment's id, name, category, role, type, brand, colours, size, warmth, formality, quantity, condition, price and status; get_garment has the rest.`,
    input: SearchInput,
    writes: false,
    async run(args, ctx) {
      const access = await wardrobeFor(ctx, args.ownerId, 'view');
      await refuseSearch(ctx, args, access);
      const filters = searchFilters(args);
      const [page, total] = await Promise.all([
        garmentSummaries(ctx.db, access.ownerId, filters, {
          before: args.before,
          limit: GRID_PAGE_SIZE,
        }),
        gridCount(ctx.db, access.ownerId, filters),
      ]);
      return {
        total,
        garments: page.garments.map(summaryOut),
        next: page.before ?? null,
      };
    },
  }),

  defineTool({
    name: 'get_garment',
    title: 'Get a garment',
    description:
      'One garment in full: its status (closet, archived, or wishlist: not bought yet) and fields, every property, its care label, product link and price, what it replaces (a wishlist item), quantity and condition, the capsules it is in, and on your own wardrobe your wears and washes, what it cost (price per piece × copies plus what its repairs cost; null without a price) and its cost per wear (that over the days worn; null until worn), and its repair and alteration log (each with its day, kind, note and cost). No photo: get_garment_photo has it.',
    input: z.object({ id: rowId(), ownerId: ownerIdInput }),
    writes: false,
    async run({ id, ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const garment = await garmentIn(ctx, id, access.ownerId);
      return garmentOut(ctx, garment, access.ownerId, access.isOwner);
    },
  }),

  defineTool({
    name: 'get_garment_photo',
    title: "Get a garment's photo",
    description:
      "A garment's photo as an image: its 400px thumbnail (the background removed when the app has done so), to see what it is and tag it (search_garments with needsTagging lists what needs tags, update_garment writes them). Your own garments and a wardrobe shared with you. A garment without a photo is refused.",
    input: z.object({ id: rowId(), ownerId: ownerIdInput }),
    writes: false,
    async run({ id, ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const garment = await garmentIn(ctx, id, access.ownerId);
      if (!garment.photo) throw new HttpError(404, 'Garment has no photo');
      // A garment's photo is never a selfie (each has its own file row),
      // but the rule that no selfie leaves through anything but its owner's
      // session is checked here as on the public /file routes.
      const photo = await publicPhoto(ctx.db, garment.photo.fileName);
      if (!photo) {
        ctx.webLogger.warn(
          `Refused a selfie as garment ${id}'s photo to user ${ctx.userId} (MCP)`,
        );
        throw new HttpError(404, GARMENT_NOT_FOUND);
      }
      const thumb = await buffer(await ctx.photos.getVariant(photo, 'thumb'));
      return new ImageAnswer(
        { id: garment.id, name: garment.name, category: garment.category },
        thumb,
        'image/webp',
      );
    },
  }),

  defineTool({
    name: 'update_garment',
    title: 'Update a garment',
    description:
      "WRITES: changes a garment's properties, care label and condition; anything not given stays as stored. Properties the garment's role does not have (a sleeve on shoes) are ignored and named in the answer. Needs your own wardrobe or a MANAGE share. Does not archive or delete.",
    input: z.object({
      id: rowId(),
      ownerId: ownerIdInput,
      ...PropertyInput,
      condition: z
        .enum(CONDITIONS)
        .optional()
        .describe('good, needs_repair or replace_soon.'),
      conditionNote: z
        .string()
        .max(CARE_NOTE_MAX)
        .optional()
        .describe('What is wrong (kept only with a problem).'),
    }),
    writes: true,
    idempotent: true,
    async run(args, ctx) {
      const { id, ownerId, condition, conditionNote, ...changes } = args;
      const access = await wardrobeFor(ctx, ownerId, 'manage');
      const garment = await garmentIn(ctx, id, access.ownerId);
      const { fields, ignored } = changedProperties(garment, changes);
      const changed = Object.values(changes).some((v) => v !== undefined);
      if (changed) {
        await updateGarmentProperties(ctx.db, id, access.ownerId, fields);
      }
      if (condition !== undefined) {
        await setCondition(
          ctx.db,
          id,
          access.ownerId,
          readCondition({ condition, conditionNote }),
        );
      }
      ctx.webLogger.info(
        `Garment ${id} updated by user ${ctx.userId} (MCP): ${[
          ...Object.keys(changes).filter(
            (name) => changes[name as keyof typeof changes] !== undefined,
          ),
          ...(condition === undefined ? [] : ['condition']),
        ].join(', ')}`,
      );
      const saved = await garmentIn(ctx, id, access.ownerId);
      return {
        garment: await garmentOut(ctx, saved, access.ownerId, access.isOwner),
        ignored,
      };
    },
  }),

  defineTool({
    name: 'add_garment_copy',
    title: 'Add copies of a garment',
    description: `WRITES: counts more identical copies of a closet garment (its quantity: three of the same white tee are one garment with 3 copies) instead of adding a new garment. The garment's photo, wears, washes and repairs stay as they are; new copies start clean. At most ${QUANTITY_MAX} copies a garment. Needs your own wardrobe or a MANAGE share. Not for a wishlist item (not bought yet) or an archived garment.`,
    input: z.object({
      id: rowId(),
      ownerId: ownerIdInput,
      copies: z
        .number()
        .int()
        .min(1)
        .max(QUANTITY_MAX - 1)
        .default(1)
        .describe('How many more (default 1).'),
    }),
    writes: true,
    idempotent: false,
    async run(args, ctx) {
      const access = await wardrobeFor(ctx, args.ownerId, 'manage');
      const outcome = await addCopies(
        ctx.db,
        access.ownerId,
        args.id,
        args.copies,
      );
      if (!outcome.ok) {
        ctx.webLogger.info(
          `Copies of garment ${args.id} refused for user ${ctx.userId} (MCP): ${outcome.reason}`,
        );
        if (outcome.reason === 'not-found') {
          throw new HttpError(404, GARMENT_NOT_FOUND);
        }
        throw new HttpError(
          409,
          outcome.reason === 'too-many'
            ? t('lookalikes.TOO_MANY', { max: QUANTITY_MAX })
            : t('lookalikes.NOT_IN_CLOSET'),
        );
      }
      ctx.webLogger.info(
        `Garment ${args.id} copies added by user ${ctx.userId} in wardrobe ${access.ownerId} (MCP): quantity ${outcome.from} -> ${outcome.to}`,
      );
      const saved = await garmentIn(ctx, args.id, access.ownerId);
      return {
        garment: await garmentOut(ctx, saved, access.ownerId, access.isOwner),
      };
    },
  }),

  defineTool({
    name: 'list_wishlist',
    title: 'List the wishlist',
    description:
      "A wardrobe's wishlist: what its owner is thinking of buying, newest first, each with its brand, category, price, product link and the closet garment it would replace. None of it is in the closet (search_garments never lists it).",
    input: z.object({ ownerId: ownerIdInput }),
    writes: false,
    async run({ ownerId }, ctx) {
      const access = await wardrobeFor(ctx, ownerId, 'view');
      const items = await wishlistItems(ctx.db, access.ownerId);
      return {
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          brand: item.brand,
          category: item.category,
          price: item.price,
          sourceUrl: item.sourceUrl,
          replaces: item.replaces && {
            id: item.replaces.id,
            name: item.replaces.name,
            status: item.replaces.status,
          },
        })),
      };
    },
  }),

  defineTool({
    name: 'add_garment_from_link',
    title: 'Add a garment from a product link',
    description:
      "WRITES: fetches a product page (or an image link), extracts the name, brand, colours, category, type, materials, price and first photo as the app's link import does, and saves the garment (the photo's background removal follows). Lands on the wishlist unless `destination` is `closet`: a product link is usually something being considered, and the owner moves it to the closet with \"Bought it\" in the app. Say `closet` only for something already owned. Give `category` when the page does not make it clear; any field given overrides the extraction. Saved to the closet, the answer's `lookalikes` are closet garments that look like the same product (same category, type and colours, no other brand): if there are any, ask the owner whether it is another copy of one; if so they delete the new garment in the app, and add_garment_copy counts the copy. Needs your own wardrobe or a MANAGE share. Rate limited: 10 imports a minute.",
    input: z.object({
      url: z.url({ protocol: /^https?$/ }).max(2048),
      ownerId: ownerIdInput,
      destination: z
        .enum(['wishlist', 'closet'])
        .default('wishlist')
        .describe('wishlist (considering it; the default) or closet (owned).'),
      replacesGarmentId: rowId()
        .optional()
        .describe(
          "A wishlist item's closet garment it would replace (search_garments with needsAttention finds the worn-out ones).",
        ),
      name: z.string().max(NAME_MAX).optional(),
      category: z.string().max(CATEGORY_MAX).optional(),
      type: z.string().max(40).optional(),
      size: z.string().max(40).optional(),
      notes: z.string().max(4000).optional(),
    }),
    writes: true,
    idempotent: false,
    openWorld: true,
    async run(args, ctx) {
      const access = await wardrobeFor(ctx, args.ownerId, 'manage');
      if (!(await ctx.allowLinkImport())) {
        throw new HttpError(
          429,
          'Too many link imports: try again in a minute',
        );
      }
      const saved = await addGarmentFromLink(ctx, access, args);
      const garment = await garmentIn(ctx, saved.id, access.ownerId);
      // The garment form's duplicate check (#20), after the fact: a tool
      // call has no form to ask on before saving.
      const lookalikes =
        garment.status === 'closet'
          ? await closetLookalikes(
              ctx.db,
              access.ownerId,
              {
                category: garment.category,
                type: garment.type ?? '',
                colors: garment.colors ?? [],
                brand: garment.brand ?? '',
              },
              { exceptId: garment.id },
            )
          : [];
      return {
        garment: await garmentOut(ctx, garment, access.ownerId, access.isOwner),
        notices: saved.notices,
        ...(garment.status === 'closet' && {
          lookalikes: lookalikes.map(({ id, name, category, quantity }) => ({
            id,
            name,
            category,
            quantity,
          })),
        }),
      };
    },
  }),
];
