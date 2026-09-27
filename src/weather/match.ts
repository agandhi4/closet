import { OCCASION_HINTS, type Occasion } from '../wardrobe/occasions';
import {
  categoryRole,
  type GarmentRole,
  presetsFor,
  type Warmth,
} from '../wardrobe/properties';
import { type DayForecast, RAIN_CHANCE } from './forecast';

/**
 * Weather matching (#14; plan section 7): what a day's weather asks of an
 * outfit worn for an occasion, and how well an outfit answers it. Pure and
 * the one place the rules live: the outfit generator (#9) ranks and filters
 * with it, Today (#15) explains its picks with it, the MCP tools report it,
 * and the seed's simulated weather is checked against it
 * (src/seed/weather.spec.ts). Availability (isAvailable,
 * src/wardrobe/availability.ts) is a separate question: filter first, then
 * match.
 *
 * The steps:
 * 1. The occasion's window (OCCASION_HINTS: work 8 to 18, evening 18 to
 *    23, ...) picks the day's hours that matter.
 * 2. Their feels-like range, with the user's personal offset added
 *    (src/weather/temperature.ts), is what to dress for.
 * 3. That sets a target warmth: for the torso, the warmths of the top (or
 *    one-piece) and the layer combined (1 a tank ... 9 a sweater under a
 *    parka); for legs and feet, one garment's warmth (1-5).
 * 4. A large swing across the window (its coolest and warmest hours
 *    LAYER_STEPS or more torso steps apart, about 8 °C) asks for a layer that
 *    comes off: the outfit with it is judged by the coolest hours, without it
 *    by the warmest. A swing inside the heat (25 to 33 °C) asks for nothing:
 *    both ends want a tee.
 * 5. Rain in the window (any hour at RAIN_CHANCE or more) asks for a
 *    water-resistant layer, footwear or accessory.
 */

/**
 * Torso steps between the window's coolest and warmest hours from which the
 * outfit wants a layer: one step is inside the torso's tolerance, two are
 * not (about 8 °C).
 */
export const LAYER_STEPS = 2;
/** The combined torso scale: a top's 1-5 plus a layer's 1-5, at most 9 is asked. */
export const TORSO_TARGET_MAX = 9;

/**
 * The torso warmth for a feels-like temperature (°C): one step per 4 °C
 * down from 26 °C and over (a tank or a light tee, 1). A tee (2) at 22 °C
 * and still at 18 °C, a sweater (4) at 14 °C, a tee under a jacket (5) at
 * 10 °C, a sweater under a jacket (7) at 2 °C, under a parka (9) from -6 °C.
 */
export function torsoTarget(feelsLike: number): number {
  return clamp(Math.round((30 - feelsLike) / 4), 1, TORSO_TARGET_MAX);
}

/**
 * Legs and feet (one garment, 1-5): shorts and sandals (1) from about
 * 26 °C, chinos and sneakers (2) around 19 °C, jeans (3) around 12 °C,
 * heavy denim and boots (4) around 5 °C, the warmest (5) below freezing.
 */
export function limbTarget(feelsLike: number): Warmth {
  return clamp(Math.round((33 - feelsLike) / 7), 1, 5) as Warmth;
}

export interface WeatherNeeds {
  occasion: Occasion;
  /** The occasion's hours, `from` inclusive, `to` exclusive (APP_TIMEZONE). */
  window: { from: number; to: number };
  /** The window's feels-like range, °C, the personal offset included. */
  feelsLike: { min: number; max: number };
  /**
   * Torso warmth (top or one-piece plus layer) for the coolest hours when a
   * layer is needed, else for the window's middle.
   */
  torso: number;
  /** Without the layer, for the warmest hours: equals `torso` without a swing. */
  torsoWithoutLayer: number;
  /** Legs and feet, for the window's middle. */
  limbs: Warmth;
  /** The swing is LAYER_STEPS or more: add a layer that comes off. */
  layer: boolean;
  /** An hour of the window reaches RAIN_CHANCE: water resistance wanted. */
  rain: boolean;
}

/**
 * What `day` asks of an outfit for `occasion`, for someone whose personal
 * offset is `offset` (°C, added to every feels-like). Null when the forecast
 * has none of the window's hours (the first day of a forecast fetched late
 * in the evening still has them: Open-Meteo answers whole days).
 */
export function weatherNeeds(
  day: DayForecast,
  occasion: Occasion,
  offset: number,
): WeatherNeeds | null {
  const { window } = OCCASION_HINTS[occasion];
  const hours = day.hours.filter(
    (h) => h.hour >= window.from && h.hour < window.to,
  );
  if (hours.length === 0) return null;
  const feels = hours.map((h) => h.feelsLike + offset);
  const min = Math.min(...feels);
  const max = Math.max(...feels);
  const middle = (min + max) / 2;
  const layer = torsoTarget(min) - torsoTarget(max) >= LAYER_STEPS;
  return {
    occasion,
    window,
    feelsLike: { min, max },
    torso: torsoTarget(layer ? min : middle),
    torsoWithoutLayer: torsoTarget(layer ? max : middle),
    limbs: limbTarget(middle),
    layer,
    rain: hours.some((h) => h.precipitationChance >= RAIN_CHANCE),
  };
}

/** A garment as the matching sees it: its role and the warmth it counts for. */
export interface MatchGarment {
  role: GarmentRole;
  /** 1-5: the garment's own, else its type's preset, else its role's middle. */
  warmth: Warmth;
  waterResistant: boolean;
}

/** The garment columns matchGarment reads (a garment row has them all). */
export interface GarmentWeatherFields {
  category: string;
  type: string | null;
  fabricWeight: number | null;
  warmth: Warmth | null;
  waterResistant: boolean;
}

// An untagged garment of an untyped category counts as its role's usual
// weight: never 1 (a vest) nor 5 (a parka) by accident.
const ROLE_WARMTH: Readonly<Record<GarmentRole, Warmth>> = {
  top: 2,
  bottom: 2,
  'one-piece': 2,
  layer: 3,
  footwear: 2,
  accessory: 1,
  bag: 1,
  none: 1,
};

/**
 * A garment for the matching. Nothing is required (plan section 6): an
 * unknown warmth is the type's preset (with its weight step: a 6 oz tee is
 * 3), else the role's usual.
 */
export function matchGarment(garment: GarmentWeatherFields): MatchGarment {
  const role = categoryRole(garment.category);
  return {
    role,
    warmth: garment.warmth ?? presetsFor(garment).warmth ?? ROLE_WARMTH[role],
    waterResistant: garment.waterResistant,
  };
}

/** What is wrong with an outfit for the weather; none means it fits. */
export const FIT_PROBLEMS = [
  'too-cold',
  'too-warm',
  'needs-layer',
  'legs-too-cold',
  'legs-too-warm',
  'feet-too-cold',
  'feet-too-warm',
  'needs-water-resistance',
] as const;
export type FitProblem = (typeof FIT_PROBLEMS)[number];

export interface OutfitFit {
  fits: boolean;
  problems: FitProblem[];
  /**
   * 0 for a fit; otherwise how far off, in warmth steps (each missing layer
   * or water resistance counts MISSING_PENALTY). The generator sorts on it.
   */
  score: number;
  /** The torso's combined warmth with the layer on, and with it off. */
  torso: { withLayer: number; withoutLayer: number };
}

// How far each part may miss its target before it is a problem. Legs and
// feet may run warmer than the target (jeans in summer are common, shorts
// in the cold are not); the torso has a layer to shed, so with one it may
// start warmer too.
const TOLERANCE = {
  torso: { below: 1, above: 1, aboveWithLayer: 2 },
  limbs: { below: 1, above: 2 },
} as const;
const MISSING_PENALTY = 2;
const TORSO_ROLES: readonly GarmentRole[] = ['top', 'one-piece'];
const LEG_ROLES: readonly GarmentRole[] = ['bottom', 'one-piece'];
// Where water resistance keeps you dry: a bag's does not.
const RAIN_ROLES: readonly GarmentRole[] = ['layer', 'footwear', 'accessory'];

/**
 * How `garments` (an outfit, a candidate combination) answer `needs`. The
 * torso's warmth is its tops and one-piece plus its layers; legs are the
 * warmest bottom or one-piece, feet the footwear. A part the outfit lacks
 * (no footwear chosen yet) is not judged: the generator fills roles, this
 * judges what is there.
 */
export function assessOutfit(
  needs: WeatherNeeds,
  garments: readonly MatchGarment[],
): OutfitFit {
  const warmthOf = (roles: readonly GarmentRole[]) =>
    garments
      .filter((g) => roles.includes(g.role))
      .reduce((sum, g) => sum + g.warmth, 0);
  const withoutLayer = warmthOf(TORSO_ROLES);
  const layers = warmthOf(['layer']);
  const withLayer = withoutLayer + layers;
  const hasLayer = layers > 0;

  const problems: FitProblem[] = [];
  let score = 0;
  const miss = (problem: FitProblem, by: number) => {
    problems.push(problem);
    score += by;
  };

  // Without a top or one-piece there is no torso to judge yet.
  if (garments.some((g) => TORSO_ROLES.includes(g.role))) {
    const cold = needs.torso - TOLERANCE.torso.below - withLayer;
    const aboveLimit = hasLayer
      ? TOLERANCE.torso.aboveWithLayer
      : TOLERANCE.torso.above;
    // Too warm with the layer on at the coolest hours, or with it off at
    // the warmest.
    const warm = Math.max(
      withLayer - (needs.torso + aboveLimit),
      withoutLayer - (needs.torsoWithoutLayer + TOLERANCE.torso.above),
    );
    if (cold > 0) miss('too-cold', cold);
    if (warm > 0) miss('too-warm', warm);
  }
  if (needs.layer && !hasLayer) miss('needs-layer', MISSING_PENALTY);

  const limb = (
    roles: readonly GarmentRole[],
    cold: FitProblem,
    warm: FitProblem,
  ) => {
    const worn = garments.filter((g) => roles.includes(g.role));
    if (worn.length === 0) return;
    const warmth = Math.max(...worn.map((g) => g.warmth));
    const below = needs.limbs - TOLERANCE.limbs.below - warmth;
    const above = warmth - (needs.limbs + TOLERANCE.limbs.above);
    if (below > 0) miss(cold, below);
    if (above > 0) miss(warm, above);
  };
  limb(LEG_ROLES, 'legs-too-cold', 'legs-too-warm');
  limb(['footwear'], 'feet-too-cold', 'feet-too-warm');

  if (
    needs.rain &&
    !garments.some((g) => g.waterResistant && RAIN_ROLES.includes(g.role))
  ) {
    miss('needs-water-resistance', MISSING_PENALTY);
  }

  return {
    fits: problems.length === 0,
    problems,
    score,
    torso: { withLayer, withoutLayer },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
