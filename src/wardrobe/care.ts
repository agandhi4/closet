/**
 * A garment's care label and its repair log (#23): the value sets of the
 * five care instructions (the five symbol groups of a care label, ISO 3758:
 * washing, bleaching, drying, ironing, professional cleaning), what a
 * garment's materials suggest for four of them, and the kinds of repair log
 * entry. Pure, like properties.ts: src/db/schema.ts builds the check
 * constraints from these lists, so adding a value is a migration.
 *
 * Design: docs/plans/2026-09-26-wardrobe-features.md, section 17.
 */

import { followPreset, type Material } from './properties';

// Each set is listed gentlest last: the order a label reads and the one
// carePresetsFor combines by (the most careful material wins).
export const CARE_WASH = [
  'hot',
  'warm',
  'cold',
  'hand',
  'do_not_wash',
] as const;
export type CareWash = (typeof CARE_WASH)[number];

export const CARE_BLEACH = ['any', 'non_chlorine', 'do_not_bleach'] as const;
export type CareBleach = (typeof CARE_BLEACH)[number];

export const CARE_DRY = [
  'tumble',
  'tumble_low',
  'do_not_tumble',
  'line',
  'flat',
] as const;
export type CareDry = (typeof CARE_DRY)[number];

export const CARE_IRON = ['high', 'medium', 'low', 'do_not_iron'] as const;
export type CareIron = (typeof CARE_IRON)[number];

/** Professional cleaning: never preset (only the label knows "dry clean only"). */
export const CARE_DRY_CLEAN = ['allowed', 'only', 'never'] as const;
export type CareDryClean = (typeof CARE_DRY_CLEAN)[number];

/** The care label as stored: each instruction optional (null: the label does not say). */
export interface CareLabel {
  careWash: CareWash | null;
  careBleach: CareBleach | null;
  careDry: CareDry | null;
  careIron: CareIron | null;
  careDryClean: CareDryClean | null;
}

/** What a garment's materials suggest (never over a value the user set). */
export interface CarePresets {
  careWash?: CareWash;
  careBleach?: CareBleach;
  careDry?: CareDry;
  careIron?: CareIron;
}

/**
 * What each material asks for, the usual label of a garment made of it.
 * `other` asks for nothing. Leather and suede are never washed or ironed and
 * have no drying instruction of their own.
 */
const MATERIAL_CARE: Record<Material, CarePresets> = {
  cotton: {
    careWash: 'warm',
    careBleach: 'non_chlorine',
    careDry: 'tumble',
    careIron: 'high',
  },
  linen: {
    careWash: 'warm',
    careBleach: 'non_chlorine',
    careDry: 'line',
    careIron: 'high',
  },
  wool: {
    careWash: 'hand',
    careBleach: 'do_not_bleach',
    careDry: 'flat',
    careIron: 'low',
  },
  merino: {
    careWash: 'cold',
    careBleach: 'do_not_bleach',
    careDry: 'flat',
    careIron: 'low',
  },
  cashmere: {
    careWash: 'hand',
    careBleach: 'do_not_bleach',
    careDry: 'flat',
    careIron: 'low',
  },
  silk: {
    careWash: 'hand',
    careBleach: 'do_not_bleach',
    careDry: 'flat',
    careIron: 'low',
  },
  denim: {
    careWash: 'cold',
    careBleach: 'do_not_bleach',
    careDry: 'line',
    careIron: 'medium',
  },
  leather: {
    careWash: 'do_not_wash',
    careBleach: 'do_not_bleach',
    careIron: 'do_not_iron',
  },
  suede: {
    careWash: 'do_not_wash',
    careBleach: 'do_not_bleach',
    careIron: 'do_not_iron',
  },
  polyester: {
    careWash: 'warm',
    careBleach: 'non_chlorine',
    careDry: 'tumble_low',
    careIron: 'low',
  },
  nylon: {
    careWash: 'cold',
    careBleach: 'non_chlorine',
    careDry: 'tumble_low',
    careIron: 'low',
  },
  fleece: {
    careWash: 'cold',
    careBleach: 'do_not_bleach',
    careDry: 'tumble_low',
    careIron: 'do_not_iron',
  },
  down: {
    careWash: 'cold',
    careBleach: 'do_not_bleach',
    careDry: 'tumble_low',
    careIron: 'do_not_iron',
  },
  knit: {
    careWash: 'cold',
    careBleach: 'do_not_bleach',
    careDry: 'flat',
    careIron: 'low',
  },
  synthetic: {
    careWash: 'cold',
    careBleach: 'non_chlorine',
    careDry: 'tumble_low',
    careIron: 'low',
  },
  other: {},
};

/** The more careful of two instructions of one set (later in the list). */
function gentler<T extends string>(
  set: readonly T[],
  a: T | undefined,
  b: T | undefined,
): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return set.indexOf(a) >= set.indexOf(b) ? a : b;
}

/**
 * The care a set of materials suggests: for each instruction, the most
 * careful of what the materials ask (a cotton and wool blend is washed as
 * wool). Empty for no materials.
 */
export function carePresetsFor(materials: readonly Material[]): CarePresets {
  return materials.reduce<CarePresets>((presets, material) => {
    const care = MATERIAL_CARE[material];
    return {
      careWash: gentler<CareWash>(CARE_WASH, presets.careWash, care.careWash),
      careBleach: gentler<CareBleach>(
        CARE_BLEACH,
        presets.careBleach,
        care.careBleach,
      ),
      careDry: gentler<CareDry>(CARE_DRY, presets.careDry, care.careDry),
      careIron: gentler<CareIron>(CARE_IRON, presets.careIron, care.careIron),
    };
  }, {});
}

/**
 * The care label after the materials changed from `from` to `to`, keeping
 * every instruction the user chose: properties.ts' applyPresets rule (an
 * instruction unset or still at `from`'s preset takes `to`'s), with the
 * materials in place of the type. `from` is null before any. Professional
 * cleaning is never preset, so it stays.
 */
export function applyCarePresets(
  current: CareLabel,
  from: readonly Material[] | null,
  to: readonly Material[],
): CareLabel {
  const was = from ? carePresetsFor(from) : {};
  const now = carePresetsFor(to);
  return {
    careWash: followPreset(current.careWash, was.careWash, now.careWash),
    careBleach: followPreset(
      current.careBleach,
      was.careBleach,
      now.careBleach,
    ),
    careDry: followPreset(current.careDry, was.careDry, now.careDry),
    careIron: followPreset(current.careIron, was.careIron, now.careIron),
    careDryClean: current.careDryClean,
  };
}

/** A repair log entry's kind: a mend (resoled, a patch) or a change of fit (hemmed, taken in). */
export const REPAIR_KINDS = ['repair', 'alteration'] as const;
export type RepairKind = (typeof REPAIR_KINDS)[number];
