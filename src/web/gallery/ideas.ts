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
import type { Location } from '../../weather/location';
import { type WeatherNeeds, weatherNeeds } from '../../weather/match';
import { normalsOn, typicalDay } from '../../weather/normals';
import type { TemperatureUnit } from '../../weather/temperature';
import { addDays, type IsoDate } from '../calendar/calendar-date';
import {
  type CapsuleDetail,
  capsuleNamesSql,
  type CapsuleRef,
  findCapsule,
} from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import { HttpError } from '../errors';
import { ownerTransaction } from '../auth/queries';
import type { ScheduleOutcome } from '../calendar/queries';
import {
  type CreateResult,
  createOutfit,
  OUTFIT_NAME_MAX,
  reuseOutfit,
} from '../outfits/queries';
import { categoryLabel } from '../wardrobe/garment';
import { type ScalarValues, selectScalars } from '../../db/select-scalars';
import {
  readWeatherWithForecast,
  type WeatherSettings,
  weatherWithForecastSql,
  type WeatherWithForecast,
} from '../weather/queries';
import {
  type UserWeather,
  userWeatherFrom,
  type WeatherService,
} from '../weather/service';
import {
  type BestOutfits,
  bestOutfits,
  goesWith,
  type GoesWith,
  nearDuplicates,
  type OutfitCount,
  outfitCount,
} from '../../wardrobe/goes-with';
import {
  type ClosetGarment,
  generatorMemorySql,
  type GoesWithInputs,
  goesWithInputs,
  ideaPoolSql,
  type ManyGoesWithInputs,
  pickedGarments,
  type PoolGarment,
  readGeneratorMemory,
  readPool,
  styledGarment,
  type WishlistGarment,
} from './queries';

/**
 * Ideas for a person, a day and an occasion: the generator
 * (src/wardrobe/generator.ts) fed from the database and the forecast. The
 * one entry point every surface calls, so none grows its own suggestion
 * logic (docs/plans/2026-09-26-redesign.md, section 1): the gallery's Ideas
 * (routes.tsx), the MCP tool suggest_outfits, Today (#15: its occasions, a
 * page of 3) and Styling's Shuffle (#42: its locked rows are `locked`, the
 * first idea fills the rest). Two siblings below draw from another pool:
 * goesWithCloset ("Goes with my closet", #18b: the whole closet with a
 * wishlist item locked, never in a pool, so ideasFor, Today and pickIdea
 * never see one) and browseIdea (Styling's Shuffle over a shared
 * wardrobe). And pickIdea, the one way an idea becomes an outfit.
 */

/** Cards a gallery page holds: one on screen at phone width, the next few ready. */
export const IDEAS_PAGE_SIZE = 6;

/** The last page a gallery goes to (ideasPage): 50 pages of 6 is more than anyone swipes. */
export const MAX_IDEAS_PAGE = 50;

/** Seeds are non-negative 31-bit integers (they travel in URLs). */
export const MAX_SEED = 2_147_483_647;

/** A seed from a URL or a form (navigation state): undefined when it is not one. */
export function parseSeed(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
  const seed = Number(value);
  return seed <= MAX_SEED ? seed : undefined;
}

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
  /**
   * Where the day's weather is: absent for the person's own (home, or the
   * phone's location while fresh); a trip's located destination (#10); null
   * for a trip whose destination is not located, which has no weather
   * rather than home's.
   */
  place?: Location | null;
  /**
   * The person's own weather, when the caller has read it already (Today
   * reads it with its entries for its line, #158): not read again. Only
   * for the person's own days (`place` absent).
   */
  ownWeather?: UserWeather;
  /** Only this capsule's garments (the owner's own capsule; the route checks). */
  capsuleId?: number;
  /**
   * Also read the owner's capsules for a scope menu (the gallery page's),
   * in the same statement as the pool: IdeasResult.capsules.
   */
  capsuleMenu?: boolean;
  /** In every idea: `?with=`'s garment, Styling's locked rows (styledGarments). */
  locked?: readonly PoolGarment[];
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
  /** From the destination's climate normals (a trip day past the forecast), not a forecast. */
  typical: boolean;
}

export interface IdeasResult {
  ideas: Idea<PoolGarment>[];
  more: boolean;
  /** Null: no weather service, no location, no forecast for the day. */
  weather: IdeasWeather | null;
  /** The owner's capsules by name, with `capsuleMenu`; else undefined. */
  capsules: CapsuleRef[] | undefined;
}

export async function ideasFor(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  now: Date,
): Promise<IdeasResult> {
  const row = await selectScalars(
    deps.db,
    ideasColumns(deps, ownerId, input, now),
  );
  return ideasFrom(deps, input, row, now);
}

/**
 * ideasFor's one statement, as selectScalars columns: for a caller that
 * reads its own columns in the same round trip and answers with ideasFrom
 * (Styling, #163: its rows, and the garments it locks, which it only knows
 * from that statement; so `input.locked` may be filled in between, as it
 * is not read here). Its keys (pool, saved, avoid, weather, capsules) are
 * taken: a caller's own columns need other names.
 */
export function ideasColumns(
  deps: { weather: WeatherService | undefined },
  ownerId: number,
  input: IdeasInput,
  now: Date,
) {
  return {
    pool: ideaPoolSql(ownerId, {
      today: input.today,
      capsuleId: input.capsuleId,
    }),
    ...generatorMemorySql(ownerId),
    weather: readsWeather(deps, input)
      ? weatherWithForecastSql(ownerId, now)
      : undefined,
    capsules: input.capsuleMenu ? capsuleNamesSql(ownerId) : undefined,
  };
}

/** ideasColumns' row, as selectScalars answers it. */
export type IdeasRow = ScalarValues<ReturnType<typeof ideasColumns>>;

/** ideasFor's answer from its statement's row (ideasColumns). */
export async function ideasFrom(
  deps: { weather: WeatherService | undefined },
  input: IdeasInput,
  row: IdeasRow,
  now: Date,
): Promise<IdeasResult> {
  const { saved, avoid } = readGeneratorMemory(row);
  const weather = await dayWeather(
    deps,
    input,
    row.weather === undefined
      ? input.ownWeather && {
          settings: input.ownWeather.settings,
          forecast: null,
        }
      : readWeatherWithForecast(row.weather, now),
    now,
  );
  const page = generateIdeas({
    seed: input.seed,
    pool: readPool(row.pool),
    locked: input.locked ?? [],
    needs: weather?.needs ?? null,
    formality: OCCASION_HINTS[input.occasion].formality,
    avoid,
    saved,
    offset: input.offset,
    limit: input.limit,
  });
  return { ...page, weather, capsules: row.capsules };
}

/**
 * Page `page` (1-based) of `pageSize` ideas, for the surfaces that page
 * (the Ideas strip, suggest_outfits): ideasFor, with `more` false on
 * MAX_IDEAS_PAGE, the last page they go to, so neither offers a page its
 * own input refuses (the strip's sentinel would fetch page 1 again).
 */
export async function ideasPage(
  deps: { db: Db; weather: WeatherService | undefined },
  ownerId: number,
  input: Omit<IdeasInput, 'offset' | 'limit'> & {
    page: number;
    pageSize: number;
  },
  now: Date,
): Promise<IdeasResult> {
  const { page, pageSize, ...rest } = input;
  const result = await ideasFor(
    deps,
    ownerId,
    { ...rest, offset: (page - 1) * pageSize, limit: pageSize },
    now,
  );
  return { ...result, more: result.more && page < MAX_IDEAS_PAGE };
}

/**
 * Whether ideasFor reads the person's weather row (weatherWithForecastSql)
 * with the pool: when dayWeather could use it (the service on, a day from
 * today on) and the caller has not read it already (`ownWeather`). A trip
 * reads it too, for the offset and the unit; one past its forecast without
 * a destination reads it for nothing, a column in a statement it sends
 * anyway.
 */
function readsWeather(
  deps: { weather: WeatherService | undefined },
  input: IdeasInput,
): boolean {
  return (
    deps.weather !== undefined &&
    input.day >= input.today &&
    input.ownWeather === undefined
  );
}

/**
 * What the day's weather asks for the occasion, with the person's offset.
 * The forecast only for days it covers (today to FORECAST_DAYS ahead), so a
 * past day never makes the request wait on Open-Meteo; it is the person's
 * own location's, or `input.place`'s (a trip's destination) through the
 * same cache. Past the forecast, a trip's destination has its typical day
 * (climate normals, src/weather/normals.ts) and nothing else does: the
 * person's own days (the gallery, Today) stay forecast-only. `own` is the
 * person's weather row as ideasFor read it (readsWeather), or the settings
 * of the caller's `ownWeather`; undefined when no weather applies.
 */
async function dayWeather(
  deps: { weather: WeatherService | undefined },
  input: IdeasInput,
  own: WeatherWithForecast | undefined,
  now: Date,
): Promise<IdeasWeather | null> {
  const { weather } = deps;
  if (!weather || !own || input.day < input.today) return null;
  if (input.day <= addDays(input.today, FORECAST_DAYS - 1)) {
    return forecastWeather(weather, input, own, now);
  }
  const { place } = input;
  return place ? typicalWeather(weather, input, own.settings, place) : null;
}

/** A day the forecast covers: the person's own location's, or the trip's. */
async function forecastWeather(
  weather: WeatherService,
  input: IdeasInput,
  own: WeatherWithForecast,
  now: Date,
): Promise<IdeasWeather | null> {
  const { place } = input;
  const { settings, cached } =
    place === undefined
      ? (input.ownWeather ?? (await userWeatherFrom(weather, own, now)))
      : {
          settings: own.settings,
          cached: place && (await weather.forecastFor(place)),
        };
  const forecast = cached && forecastDay(cached.forecast, input.day);
  const needs =
    forecast && weatherNeeds(forecast, input.occasion, settings.offset);
  return needs ? { needs, unit: settings.unit, typical: false } : null;
}

/** A trip day past the forecast: the destination's typical day for it. */
async function typicalWeather(
  weather: WeatherService,
  input: IdeasInput,
  settings: WeatherSettings,
  place: Location,
): Promise<IdeasWeather | null> {
  const cached = await weather.normalsFor(place);
  const normals = cached && normalsOn(cached.normals, input.day);
  const needs =
    normals &&
    weatherNeeds(
      typicalDay(input.day, normals),
      input.occasion,
      settings.offset,
    );
  return needs ? { needs, unit: settings.unit, typical: true } : null;
}

/**
 * Styling's Shuffle over a wardrobe shared with the requester (#42): one
 * idea from the owner's closet with `locked` in it, for nobody's day. Only
 * what the share shows goes in: the closet (closetGarments, so no wash or
 * away state, which are the owner's own records), no rotation (idle days
 * nulled: when a garment was last worn is a wear), and none of the owner's
 * saved outfits, clashes or weather, which are theirs alone. Undefined when
 * nothing fits the locks. Pure: Styling reads the closet
 * (closetGarmentsSql, readCloset) and the locked garments
 * (styledGarmentsSql without a day) in its own statement (#163).
 */
export function browseIdea(input: {
  closet: readonly ClosetGarment[];
  locked: readonly PoolGarment[];
  seed: number;
}): Idea<PoolGarment> | undefined {
  // The closet is never rotated, nor are the locked garments over a share.
  const unworn = (g: PoolGarment): PoolGarment => ({ ...g, idleDays: null });
  const [idea] = generateIdeas<PoolGarment>({
    seed: input.seed,
    pool: input.closet,
    locked: input.locked.map(unworn),
    offset: 0,
    limit: 1,
  }).ideas;
  return idea;
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
  /** That outfit was one of Muse's proposals, which this pick made the owner's (#335). */
  adoptedProposal: boolean;
  /**
   * The person's pick took over what the week planner had made of it: the
   * reused outfit (no longer the planner's to remove) or the entry on the
   * destination's day (now `user`). False for the planner's own picks.
   */
  adopted: boolean;
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
 * (createOutfit, the one writer of new outfits: once per garment set, #219).
 * A person's pick (not `plannedBy: 'auto'`) that reuses an outfit the week
 * planner created takes it over (reuseOutfit's adoptPlannerOutfit, #77):
 * "Already saved" is then true for good, and Undo or the re-plan never
 * delete it; planning it on a day where the planner has it takes that
 * entry over too (insertEntry). All in one transaction under the owner
 * lock, so a double tap, a retried post or a retried pick_outfit never
 * makes a second outfit: the second pick waits for the first to commit and
 * finds its outfit. The garments stay locked (pickedGarments, FOR SHARE)
 * until the outfit is saved, so one archived or deleted meanwhile is
 * either refused here or waits for the pick. Called by the gallery's pick, the MCP tool pick_outfit,
 * Today's "Wear this" and the week planner (#16, src/web/week-plan/plan.ts,
 * inside its own locked transaction); takes a Queryable so a spec can hold
 * a pick's transaction open.
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
  return ownerTransaction(db, ownerId, 'pickIdea', async (tx) => {
    const { garments: found, existing } = await pickedGarments(
      tx,
      ownerId,
      wanted,
    );
    if (found.length !== wanted.length) return 'not-found';
    if (existing)
      return pickResult(await reuseOutfit(tx, ownerId, existing, input.plan));
    const byId = new Map(found.map((g) => [g.id, g]));
    const garments = topToToe(wanted.map((id) => byId.get(id)!));
    const name = input.name ?? ideaName(garments);
    // createOutfit asks again in its insert (a no-op here, under the lock).
    const saved = await createOutfit(tx, ownerId, {
      name,
      notes: null,
      slots: garments.map((g) => ({ category: g.category, garmentId: g.id })),
      plan: input.plan,
    });
    return pickResult(saved);
  });
}

function pickResult(saved: CreateResult): PickResult {
  const { id, name, alreadySaved, adoptedProposal, adopted, schedule } = saved;
  return { id, name, alreadySaved, adoptedProposal, adopted, schedule };
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
 * answers the same. One statement (goesWithInputs) and one search.
 */
export async function goesWithCloset(
  db: Queryable,
  ownerId: number,
  itemId: number,
): Promise<GoesWithCloset | undefined> {
  return judgeGoesWithCloset(await goesWithInputs(db, ownerId, itemId));
}

/**
 * goesWithCloset's search over inputs already read: a wishlist item's page
 * reads them with its other lists (garmentContext,
 * src/web/wardrobe/garment-context.ts).
 */
export function judgeGoesWithCloset({
  item,
  closet,
  avoid,
}: GoesWithInputs): GoesWithCloset | undefined {
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
 * "Unlocks N" for many wishlist items over one closet read
 * (goesWithManyInputsSql): each item's outfitCount, by garment id. The
 * Muse inbox's option thumbs (src/web/wishlist/inbox.ts). One search each,
 * about 3 ms over the demo closet (#333: 120 options in ~360 ms).
 */
export function unlocksOf({
  items,
  closet,
  avoid,
}: ManyGoesWithInputs): Map<number, OutfitCount> {
  return new Map(
    items.map((item) => [
      item.id,
      outfitCount({ item, closet, avoid, seed: item.id }),
    ]),
  );
}

/**
 * Each item's count and best few outfits (bestOutfits) over one closet
 * read, by garment id: a Muse need's options side by side (C,
 * src/web/wishlist/group-page.tsx). The same search and seed as the item's
 * own page, so the counts agree.
 */
export function bestOutfitsOf({
  items,
  closet,
  avoid,
}: ManyGoesWithInputs): Map<number, BestOutfits<ClosetGarment>> {
  return new Map(
    items.map((item) => [
      item.id,
      bestOutfits({ item, closet, avoid, seed: item.id }),
    ]),
  );
}
