import { type Static, Type } from '@sinclair/typebox';
import { CUTOUT_STATUSES, showsCutout } from '../../cutout/state';
import { AWAY_REASONS } from '../../wardrobe/availability';
import {
  CARE_BLEACH,
  CARE_DRY,
  CARE_DRY_CLEAN,
  CARE_IRON,
  CARE_WASH,
  REPAIR_KINDS,
} from '../../wardrobe/care';
import { perWearCost, totalCost } from '../../wardrobe/insights';
import {
  categoryRole,
  CONDITIONS,
  FITS,
  FORMALITIES,
  GARMENT_COLORS,
  GARMENT_ROLES,
  LENGTHS,
  MATERIALS,
  PATTERNS,
  SLEEVES,
  WARMTHS,
} from '../../wardrobe/properties';
import { GARMENT_STATUSES } from '../../wardrobe/status';
import { literals, withoutNulls } from '../api/resource';
import { imageUrl } from '../files/image-url';
import { IsoDateSchema } from '../schemas';
import type { GarmentContext } from './garment-context';
import type { GarmentDetail, GarmentPhoto, GarmentSummary } from './queries';

/**
 * The API's garment resources (#192a; docs/plans/2026-11-12-json-api.md
 * section 2), mapped from what the pages read: a list's summary
 * (searchGarments) and the garment in full (requireGarment and
 * garmentContext, the garment page's own reads). camelCase, null fields left
 * out, money a decimal string, a day `YYYY-MM-DD`. MCP's get_garment answers
 * the same facts in its own shape (nulls kept: an agent reads "null").
 */

const Money = Type.String({
  pattern: '^\\d+\\.\\d{2}$',
  description: 'A decimal amount in the household currency',
});

const GarmentPhotoResource = Type.Object(
  {
    cutoutStatus: literals(CUTOUT_STATUSES),
    /** Bumped by every new photo set; the URLs carry it. */
    version: Type.Integer(),
    originalUrl: Type.String(),
    /** 400 px, from the cutout when it shows. */
    thumbUrl: Type.String(),
    /** Only while the cutout shows (showsCutout): pending, failed and unwanted have none. */
    cutoutUrl: Type.Optional(Type.String()),
  },
  {
    title: 'GarmentPhoto',
    description:
      "A garment's photo: signed /file URLs, relative to the server, immutable (a new photo, cutout or turn is a new URL). Never build or edit one",
  },
);

function photoResource(
  photo: GarmentPhoto,
): Static<typeof GarmentPhotoResource> {
  return {
    cutoutStatus: photo.cutoutStatus,
    version: photo.version,
    originalUrl: imageUrl(photo, 'original'),
    thumbUrl: imageUrl(photo, 'thumb'),
    ...(showsCutout(photo.cutoutStatus) && {
      cutoutUrl: imageUrl(photo, 'nobg'),
    }),
  };
}

/** What every garment resource says it is. */
const identity = {
  id: Type.Integer(),
  name: Type.Optional(Type.String()),
  category: Type.String(),
  role: literals(GARMENT_ROLES),
  status: literals(GARMENT_STATUSES),
  brand: Type.Optional(Type.String()),
  colors: Type.Array(literals(GARMENT_COLORS)),
  size: Type.Optional(Type.String()),
  price: Type.Optional(Money),
  quantity: Type.Integer({ minimum: 1 }),
  condition: literals(CONDITIONS),
  photo: Type.Optional(GarmentPhotoResource),
};

export const GarmentListItem = Type.Object(
  {
    ...identity,
    type: Type.Optional(Type.String()),
    warmth: Type.Optional(literals(WARMTHS)),
    formality: Type.Optional(literals(FORMALITIES)),
  },
  {
    title: 'GarmentListItem',
    description:
      'A garment as a list shows it: GET /garments/{id} has the rest',
  },
);
type GarmentListItem = Static<typeof GarmentListItem>;

export function toGarmentListItem(summary: GarmentSummary): GarmentListItem {
  return withoutNulls({
    id: summary.id,
    name: summary.name,
    category: summary.category,
    role: categoryRole(summary.category),
    status: summary.status,
    brand: summary.brand,
    colors: summary.colors ?? [],
    size: summary.size,
    price: summary.price,
    quantity: summary.quantity,
    condition: summary.condition,
    photo: summary.photo && photoResource(summary.photo),
    type: summary.type,
    warmth: summary.warmth,
    formality: summary.formality,
  });
}

const Properties = Type.Object(
  {
    type: Type.Optional(Type.String()),
    warmth: Type.Optional(literals(WARMTHS)),
    formality: Type.Optional(literals(FORMALITIES)),
    materials: Type.Array(literals(MATERIALS)),
    pattern: Type.Optional(literals(PATTERNS)),
    fit: Type.Optional(literals(FITS)),
    sleeve: Type.Optional(literals(SLEEVES)),
    length: Type.Optional(literals(LENGTHS)),
    fabricWeightGsm: Type.Optional(Type.Integer()),
    waterResistant: Type.Boolean(),
  },
  { title: 'GarmentProperties' },
);

const CareLabel = Type.Object(
  {
    wash: Type.Optional(literals(CARE_WASH)),
    bleach: Type.Optional(literals(CARE_BLEACH)),
    dry: Type.Optional(literals(CARE_DRY)),
    iron: Type.Optional(literals(CARE_IRON)),
    dryClean: Type.Optional(literals(CARE_DRY_CLEAN)),
    notes: Type.Optional(Type.String()),
  },
  { title: 'CareLabel' },
);

const OwnerCare = Type.Object(
  {
    /** Absent: the role's default; 0: never washed. */
    washAfterWears: Type.Optional(Type.Integer({ minimum: 0 })),
    lastWashedOn: Type.Optional(IsoDateSchema),
    away: Type.Optional(literals(AWAY_REASONS)),
    awayNote: Type.Optional(Type.String()),
    worn: Type.Integer({ minimum: 0 }),
    wornSinceWash: Type.Integer({ minimum: 0 }),
    lastWorn: Type.Optional(IsoDateSchema),
    /** Price per piece × copies, plus its repairs; absent without a price. */
    cost: Type.Optional(Money),
    /** `cost` over the days worn; absent until worn. */
    costPerWear: Type.Optional(Money),
  },
  {
    title: 'GarmentCare',
    description:
      "The owner's own records of how it is worn: only on their own wardrobe",
  },
);

const Repair = Type.Object(
  {
    id: Type.Integer(),
    day: IsoDateSchema,
    kind: literals(REPAIR_KINDS),
    note: Type.String(),
    cost: Type.Optional(Money),
  },
  { title: 'Repair' },
);

export const Garment = Type.Object(
  {
    ...identity,
    notes: Type.Optional(Type.String()),
    acquiredOn: Type.Optional(IsoDateSchema),
    /** A wishlist item's (or a bought one's) garment it replaces. */
    replacesGarmentId: Type.Optional(Type.Integer()),
    sourceUrl: Type.Optional(Type.String()),
    conditionNote: Type.Optional(Type.String()),
    properties: Properties,
    careLabel: CareLabel,
    capsules: Type.Array(
      Type.Object(
        { id: Type.Integer(), name: Type.String() },
        { title: 'CapsuleRef' },
      ),
    ),
    care: Type.Optional(OwnerCare),
    /** The owner's repair and alteration log: only on their own wardrobe. */
    repairs: Type.Optional(Type.Array(Repair)),
  },
  {
    title: 'Garment',
    description:
      "A garment in full, as its page shows it. `care` and `repairs` are the owner's own records, never a grantee's to read",
  },
);
type Garment = Static<typeof Garment>;

/**
 * The garment in full, from its page's reads: the owner's records only
 * where garmentContext read them (`own`: the owner of an owned garment),
 * so a grantee's answer cannot hold them.
 */
export function toGarmentResource(
  garment: GarmentDetail,
  context: GarmentContext,
): Garment {
  const { own } = context;
  return withoutNulls({
    id: garment.id,
    name: garment.name,
    category: garment.category,
    role: categoryRole(garment.category),
    status: garment.status,
    brand: garment.brand,
    colors: garment.colors ?? [],
    size: garment.size,
    price: garment.price,
    quantity: garment.quantity,
    condition: garment.condition,
    photo: garment.photo && photoResource(garment.photo),
    notes: garment.notes,
    acquiredOn: garment.acquiredOn,
    replacesGarmentId: garment.replacesGarmentId,
    sourceUrl: garment.sourceUrl,
    conditionNote: garment.conditionNote,
    properties: withoutNulls({
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
    }),
    careLabel: withoutNulls({
      wash: garment.careWash,
      bleach: garment.careBleach,
      dry: garment.careDry,
      iron: garment.careIron,
      dryClean: garment.careDryClean,
      notes: garment.washingDetails,
    }),
    capsules: context.capsules
      .filter((capsule) => capsule.member)
      .map(({ id, name }) => ({ id, name })),
    care: own && ownerCare(garment, own.wear),
    repairs:
      own && own.repairs.entries.map((entry) => withoutNulls({ ...entry })),
  });
}

function ownerCare(
  garment: GarmentDetail,
  wear: NonNullable<GarmentContext['own']>['wear'],
): Static<typeof OwnerCare> {
  const cost = totalCost({
    price: garment.price,
    quantity: garment.quantity,
    repairCost: wear.repairCost,
  });
  return withoutNulls({
    washAfterWears: garment.washAfterWears,
    lastWashedOn: garment.lastWashedOn,
    away: garment.away,
    awayNote: garment.awayNote,
    worn: wear.worn,
    wornSinceWash: wear.sinceWash,
    lastWorn: wear.lastWorn,
    cost,
    costPerWear: cost === null ? null : perWearCost(cost, wear.worn),
  });
}
