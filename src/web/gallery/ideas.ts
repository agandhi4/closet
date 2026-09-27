import type { Db, Queryable } from '../../db/client';
import { seededRandom } from '../../random';
import {
  generateIdeas,
  type Idea,
  OUTFIT_ORDER,
} from '../../wardrobe/generator';
import { OCCASION_HINTS, type Occasion } from '../../wardrobe/occasions';
import type { PlannedBy } from '../../wardrobe/week';
import { categoryRole } from '../../wardrobe/properties';
import { FORECAST_DAYS, forecastDay } from '../../weather/forecast';
import { type WeatherNeeds, weatherNeeds } from '../../weather/match';
import type { TemperatureUnit } from '../../weather/temperature';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import { type CapsuleDetail, findCapsule } from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import { HttpError } from '../errors';
import { OUTFIT_NAME_MAX } from '../outfits/form-page';
import { lockOwner } from '../auth/queries';
import { insertEntry, type ScheduleOutcome } from '../calendar/queries';
import { createOutfit } from '../outfits/queries';
import { categoryLabel } from '../wardrobe/garment';
import { userWeather, type WeatherService } from '../weather/service';
import {
  goesWith,
  type GoesWith,
  nearDuplicates,
  type OutfitCount,
  outfitCount,
} from '../../wardrobe/goes-with';
import {
  avoidedPairs,
  type ClosetGarment,
  closetGarments,
  ideaPool,
  outfitOfGarments,
  pickedGarments,
  type PoolGarment,
  savedOutfits,
  styledGarment,
  type WishlistGarment,
  wishlistGarments,
} from './queries';

/**
 * Ideas for a person, a day and an occasion: the generator
 * (src/wardrobe/generator.ts) fed from the database and the forecast. The
 * one entry point every surface calls, so none grows its own suggestion
 * logic (docs/plans/2026-09-26-redesign.md, section 1): the gallery's Ideas
 * (routes.tsx), the MCP tool suggest_outfits, and next Today (#15: its
 * occasions, a page of 3) and Styling's Shuffle (#42: `styled` becomes its
 * locked rows). "Goes with my closet" (#18b) is its sibling below,
 * goesWithCloset: the whole closet with a wishlist item locked the way
 * `styled` locks a closet garment, never in a pool, so ideasFor, Today and
 * pickIdea never see one. And pickIdea, the one way an idea becomes an
 * outfit.
 */

/** Cards a gallery page holds: one on screen at phone width, the next few ready. */
export const IDEAS_PAGE_SIZE = 6;

/** Seeds are non-negative 31-bit integers (they travel in URLs). */
export const MAX_SEED = 2_147_483_647;

/** The seed a gallery opens with: one a day, so the ideas change daily and a reload keeps them. */
export function dailySeed(today: IsoDate): number {
  return Math.floor(seededRandom('gallery-day', today).next() * MAX_SEED);
}

/** "Shuffle": the next seed after `seed`, deterministic like everything else. */
export function shuffledSeed(seed: number): number {
  return Math.floor(seededRandom('gallery-shuffle', seed).next() * MAX_SEED);
}

export interface IdeasInput {
  /** Today in APP_TIMEZONE: how long each garment has rested. */
  today: IsoDate;
  /** The day and occasion dressed for (the weather's window, the formality). */
  day: IsoDate;
  occasion: Occasion;
  /** Only this capsule's garments (the owner's own capsule; the route checks). */
  capsuleId?: number;
  /** `?with=`: in every idea (styledGarment). */
  styled?: PoolGarment;
  seed: number;
  offset: number;
  limit: number;
}

/** A gallery's scope, resolved: the capsule it draws from and the garment in every idea. */
export interface IdeasScope {
  capsule: CapsuleDetail | undefined;
  styled: PoolGarment | undefined;
}

/**
 * `?capsule=` and `?with=` (the page, suggest_outfits) as rows: the owner's
 * own capsule, the owner's garment in the closet. Either named and not
 * found is a 404 like an unknown id (outfits are private, so another
 * person's capsule or garment is never one).
 */
export async function ideasScope(
  db: Db,
  ownerId: number,
  asked: { capsuleId?: number; withId?: number; today: IsoDate },
): Promise<IdeasScope> {
  const [capsule, styled] = await Promise.all([
    asked.capsuleId === undefined
      ? undefined
      : findCapsule(db, asked.capsuleId, ownerId),
    asked.withId === undefined
      ? undefined
      : styledGarment(db, ownerId, asked.withId, asked.today),
  ]);
  if (asked.capsuleId !== undefined && !capsule) throw capsuleNotFound();
  if (asked.withId !== undefined && !styled) {
    throw new HttpError(404, 'Garment not found');
  }
  return { capsule, styled };
}

/** The weather an ideas page was matched to, for its header and the "too warm" buttons. */
export interface IdeasWeather {
  needs: WeatherNeeds;
  unit: TemperatureUnit;
}

export interface IdeasResult {
  ideas: Idea<PoolGarment>[];
  more: boolean;
  /** Null: no weather service, no location, no forecast for the day. */
  weather: IdeasWeather | null;
}

export async function ideasFor(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  now: Date,
): Promise<IdeasResult> {
  const { db } = deps;
  const [pool, saved, avoid, weather] = await Promise.all([
    ideaPool(db, ownerId, { today: input.today, capsuleId: input.capsuleId }),
    savedOutfits(db, ownerId),
    avoidedPairs(db, ownerId),
    dayWeather(deps, ownerId, input, now),
  ]);
  const page = generateIdeas({
    seed: input.seed,
    pool,
    locked: input.styled ? [input.styled] : [],
    needs: weather?.needs ?? null,
    formality: OCCASION_HINTS[input.occasion].formality,
    avoid,
    saved,
    offset: input.offset,
    limit: input.limit,
  });
  return { ...page, weather };
}

/**
 * What the day's forecast asks for the occasion, with the person's offset:
 * only for days the forecast covers (today to FORECAST_DAYS ahead), so a
 * past or far day never makes the request wait on Open-Meteo.
 */
async function dayWeather(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  now: Date,
): Promise<IdeasWeather | null> {
  if (!deps.weather) return null;
  if (
    input.day < input.today ||
    input.day > addDays(input.today, FORECAST_DAYS - 1)
  ) {
    return null;
  }
  const { settings, cached } = await userWeather(
    deps.db,
    deps.weather,
    ownerId,
    now,
  );
  const forecast = cached && forecastDay(cached.forecast, input.day);
  const needs =
    forecast && weatherNeeds(forecast, input.occasion, settings.offset);
  return needs ? { needs, unit: settings.unit } : null;
}

/** Garments as an outfit's slots and name list them: top to toe (OUTFIT_ORDER), the given order among equals. */
function topToToe<G extends { category: string }>(garments: readonly G[]): G[] {
  const rank = (g: G) => OUTFIT_ORDER.indexOf(categoryRole(g.category));
  return [...garments].sort((a, b) => rank(a) - rank(b));
}

/**
 * The name a picked idea is saved with, changeable later: its garments top
 * to toe, by name or else their category ("Olive chore coat, White tee,
 * Raw jeans, Boots"), within the outfit form's cap.
 */
export function ideaName(
  garments: readonly { name: string | null; category: string }[],
): string {
  const name = topToToe(garments)
    .map((g) => g.name ?? categoryLabel(g.category))
    .join(', ');
  return name.length <= OUTFIT_NAME_MAX
    ? name
    : `${name.slice(0, OUTFIT_NAME_MAX - 1)}…`;
}

export interface PickResult {
  id: number;
  name: string | null;
  /** The garments were already an outfit of the owner's: it was reused, nothing was created. */
  alreadySaved: boolean;
  /** With a destination: whether the entry is new or was already on the day. */
  schedule?: ScheduleOutcome;
}

/**
 * Picks an idea, once: the garments must all be the owner's and in the
 * closet (else 'not-found' and nothing is written: a card from before a
 * garment was archived or deleted). If an outfit of the owner's already has
 * exactly these garments, it is the answer (`alreadySaved`), planned on the
 * destination's day when given (an outfit is on a day once, so a second
 * plan changes nothing); otherwise the outfit (named by ideaName unless
 * `name` is given), its slots top to toe and the calendar entry are created
 * (createOutfit). All in one transaction under lockOwner, so a double tap,
 * a retried post or a retried pick_outfit never makes a second outfit: the
 * second pick waits for the first to commit and finds its outfit. Called by
 * the gallery's pick, the MCP tool pick_outfit, Today's "Wear this" and the
 * week planner (#16, src/web/week-plan/plan.ts, inside its own locked
 * transaction); takes a Queryable so a spec can hold a pick's transaction
 * open.
 */
export function pickIdea(
  db: Queryable,
  ownerId: number,
  input: {
    garmentIds: readonly number[];
    /** plannedBy 'auto': the week planner's pick (#16); the person's otherwise. */
    plan?: { day: IsoDate; occasion: Occasion; plannedBy?: PlannedBy };
    name?: string;
  },
): Promise<PickResult | 'not-found'> {
  const wanted = [...new Set(input.garmentIds)];
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId);
    const found = await pickedGarments(tx, ownerId, wanted);
    if (found.length !== wanted.length) return 'not-found';
    const existing = await outfitOfGarments(tx, ownerId, wanted);
    if (existing) {
      const schedule = input.plan
        ? (
            await insertEntry(tx, {
              ownerId,
              outfitId: existing.id,
              ...input.plan,
            })
          ).outcome
        : undefined;
      return { ...existing, alreadySaved: true, schedule };
    }
    const byId = new Map(found.map((g) => [g.id, g]));
    const garments = topToToe(wanted.map((id) => byId.get(id)!));
    const name = input.name ?? ideaName(garments);
    const saved = await createOutfit(tx, ownerId, {
      name,
      notes: null,
      slots: garments.map((g) => ({ category: g.category, garmentId: g.id })),
      plan: input.plan,
    });
    return {
      id: saved.id,
      name,
      alreadySaved: false,
      schedule: saved.schedule,
    };
  });
}

/** A closet garment near-identical to a wishlist item (nearDuplicates). */
export interface NearDuplicate extends ClosetGarment {
  /** The garment the item is on the wishlist to replace: like for like, not a second one. */
  replaced: boolean;
}

/** "Goes with my closet" for one wishlist item: what the page and goes_with_closet show. */
export interface GoesWithCloset extends GoesWith<ClosetGarment> {
  item: WishlistGarment;
  nearDuplicates: NearDuplicate[];
}

/**
 * "Goes with my closet" (#18b): the owner's wishlist item `itemId` judged
 * against their whole closet (closetGarments: dirty and away included) and
 * their avoided pairs, by the generator with the item locked
 * (src/wardrobe/goes-with.ts says what is judged: no weather, the item's
 * own formality, no rotation), and the closet garments near-identical to
 * it. Undefined when `itemId` is not one of the owner's wishlist items.
 * The owner's own, like ideas: a grantee who can see the wishlist never
 * gets this, as it reads the owner's closet and clashes. Display only: an
 * outfit with the item cannot be picked (pickIdea takes closet garments),
 * which "Bought it" changes. Seeded by the item's id, so the same closet
 * answers the same.
 */
export async function goesWithCloset(
  db: Db,
  ownerId: number,
  itemId: number,
  today: IsoDate,
): Promise<GoesWithCloset | undefined> {
  const [[item], closet, avoid] = await Promise.all([
    wishlistGarments(db, ownerId, [itemId], today),
    closetGarments(db, ownerId, today),
    avoidedPairs(db, ownerId),
  ]);
  if (!item) return undefined;
  return {
    item,
    ...goesWith({ item, closet, avoid, seed: item.id }),
    nearDuplicates: nearDuplicates(item, closet).map((garment) => ({
      ...garment,
      replaced: garment.id === item.replacesGarmentId,
    })),
  };
}

/**
 * How many outfits the owner's wishlist item `itemId` makes with the closet
 * (goesWithCloset's count, from the same search): the shopping list's
 * candidate chip, GET /wardrobe/:id/outfit-count. Undefined when it is not
 * one of the owner's wishlist items. Three statements and one search.
 */
export async function goesWithCount(
  db: Db,
  ownerId: number,
  itemId: number,
  today: IsoDate,
): Promise<OutfitCount | undefined> {
  const [[item], closet, avoid] = await Promise.all([
    wishlistGarments(db, ownerId, [itemId], today),
    closetGarments(db, ownerId, today),
    avoidedPairs(db, ownerId),
  ]);
  return item && outfitCount({ item, closet, avoid, seed: item.id });
}
