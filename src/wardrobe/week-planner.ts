import { seededRandom } from '../random';
import {
  dayOfWeek,
  daysBetween,
  type IsoDate,
} from '../web/calendar/calendar-date';
import type { DayForecast } from '../weather/forecast';
import {
  assessOutfit,
  type MatchGarment,
  type WeatherNeeds,
  weatherNeeds,
} from '../weather/match';
import {
  type AwayReason,
  cleanCopies,
  isAvailable,
  type WashState,
} from './availability';
import {
  generateIdeas,
  type Idea,
  type IdeaGarment,
  type SavedOutfit,
} from './generator';
import {
  compareOccasions,
  DAY_OCCASIONS,
  OCCASION_HINTS,
  type Occasion,
} from './occasions';
import type { GarmentRole } from './properties';
import type { GarmentStatus } from './status';
import { occasionsOn, type TemplateSlot } from './week';

/**
 * The weekly planner (#16; plan section 12): fills a week's empty template
 * slots with the generator's outfits, and later judges the entries it
 * planned against a newer forecast. Pure and deterministic (the same week,
 * closet and forecast plan the same outfits), so every rule is unit-tested
 * here (week-planner.spec.ts) and the writes live elsewhere
 * (src/web/week-plan/). The rules:
 *
 * - **Slots**: each day's template occasions (week.ts), in day and occasion
 *   order. A slot is empty when the day has no entry for its occasion; a
 *   day occasion (all day, work, daytime) is filled by any of the three,
 *   since one outfit dresses the day. Today's slots whose window
 *   (OCCASION_HINTS) has ended are left alone.
 * - **Ideas come from the generator** (generateIdeas: its colour, clash and
 *   saved-outfit rules, the slot's weather needs and the occasion's
 *   formality), one per slot, seeded by (day, occasion). The best idea is
 *   taken, a near miss included (its problems travel with it); a slot with
 *   no idea at all stays empty and is reported.
 * - **Wash limits across the week**: the week's own future wears count.
 *   Every unworn entry already in the window and every outfit planned so
 *   far adds its garments' wear days (distinct days, as the app counts
 *   wears), and a garment is offered for a slot only while a clean copy is
 *   left after all of them (availability.ts's cleanCopies), so a planned
 *   wear never dirties a copy another planned day relies on. Nothing is
 *   washed in between: a garment dirty today stays out all week. Wearing a
 *   garment twice on one day costs one wear.
 * - **No outfit twice in the week**: an outfit planned for one slot joins
 *   the saved outfits the generator never repeats (entries already in the
 *   week are saved outfits already).
 * - **Rotation**: a garment the week already wears counts as just worn for
 *   later slots, and the rest rest until the slot's day, so the week draws
 *   on the whole closet.
 * - **The re-plan** judges the entries the planner still owns each morning:
 *   an outfit that can no longer be worn on its day (unwearableOn) is
 *   swapped for the slot's best idea; otherwise a changed forecast swaps
 *   one that no longer fits for an idea that fits better.
 */

/** Bump to replan every slot differently on purpose. */
export const PLANNER_VERSION = 1;
/** "Plan my week": today and the six days after it. */
export const PLAN_DAYS = 7;

// The generator's seeds are non-negative 31-bit integers.
const SEED_RANGE = 2_147_483_647;

/** A garment the planner may use: the generator's, with its wash state today. */
export interface PlannerGarment extends IdeaGarment {
  /** Identical copies (garment.quantity). */
  quantity: number;
  /** washLimit(): wears a copy takes; null when it never needs a wash. */
  washLimit: number | null;
  /** Wears since the last wash as of today, today's included. */
  wearsSinceWash: number;
}

/** A garment of an entry already on the calendar: its role (the duplicate rule) and weather. */
export interface EntryGarment {
  id: number;
  role: GarmentRole;
  weather: MatchGarment;
}

/** A calendar entry in the window, as the planner reads it. */
export interface WeekEntry {
  id: number;
  day: IsoDate;
  occasion: Occasion;
  /** Its wears are already the garments' (wearsSinceWash); an unworn one is a future wear. */
  worn: boolean;
  garments: readonly EntryGarment[];
}

/** What a week is planned from. */
export interface WeekContext<G extends PlannerGarment> {
  /** Today in APP_TIMEZONE: the wash state's day and the rotation's. */
  today: IsoDate;
  /** Every entry from today to the last day planned or judged. */
  entries: readonly WeekEntry[];
  /** The owner's garments in the closet and not away, dirty or clean (the planner decides per day). */
  pool: readonly G[];
  /** Forecast days by date; a day without one is planned without weather. */
  forecast: ReadonlyMap<IsoDate, DayForecast>;
  /** The personal temperature offset, °C. */
  offset: number;
  avoid: readonly (readonly [number, number])[];
  /** The owner's saved outfits (the generator's duplicate rule). */
  saved: readonly SavedOutfit[];
}

export interface WeekInput<G extends PlannerGarment> extends WeekContext<G> {
  /** Now's hour in APP_TIMEZONE: today's slots whose window has ended stay empty. */
  hour: number;
  /** The days to fill, in order: today and the six after it ("Plan my week"). */
  days: readonly IsoDate[];
  template: readonly TemplateSlot[];
}

export interface Slot {
  day: IsoDate;
  occasion: Occasion;
}

export interface PlannedSlot<G extends PlannerGarment> extends Slot {
  idea: Idea<G>;
  /** What the slot's forecast asked; null without one. */
  needs: WeatherNeeds | null;
}

export interface WeekPlan<G extends PlannerGarment> {
  planned: PlannedSlot<G>[];
  /** Empty slots no idea could fill (nothing clean left for them). */
  unfilled: Slot[];
}

/** Fills the week's empty template slots, in day and occasion order. */
export function planWeek<G extends PlannerGarment>(
  input: WeekInput<G>,
): WeekPlan<G> {
  const ledger = new WeekLedger(input);
  const plan: WeekPlan<G> = { planned: [], unfilled: [] };
  for (const slot of emptySlots(input)) {
    const needs = needsOf(input, slot);
    const idea = ideaFor(input, ledger, slot, needs);
    if (!idea) {
      plan.unfilled.push(slot);
      continue;
    }
    ledger.wear(slot.day, idea.garments, { asOutfit: true });
    plan.planned.push({ ...slot, idea, needs });
  }
  return plan;
}

/**
 * The template's slots on `days` that no entry fills yet, in day and
 * occasion order; today's are left out once their window has ended.
 */
export function emptySlots(
  input: Pick<WeekInput<PlannerGarment>, 'today' | 'hour' | 'days'> & {
    template: readonly TemplateSlot[];
    entries: readonly Pick<WeekEntry, 'day' | 'occasion'>[];
  },
): Slot[] {
  return input.days.flatMap((day) => {
    const onDay = input.entries.filter((entry) => entry.day === day);
    return occasionsOn(input.template, dayOfWeek(day))
      .filter((occasion) => {
        const ended =
          day === input.today &&
          input.hour >= OCCASION_HINTS[occasion].window.to;
        return !ended && !onDay.some((e) => fills(e.occasion, occasion));
      })
      .map((occasion) => ({ day, occasion }));
  });
}

// An entry fills a slot of its own occasion; a day occasion fills any day
// occasion's slot (one outfit dresses the day).
function fills(entry: Occasion, slot: Occasion): boolean {
  return (
    entry === slot ||
    (DAY_OCCASIONS.includes(entry) && DAY_OCCASIONS.includes(slot))
  );
}

// ---- Whether a planned outfit can still be worn -----------------------------

/** A garment of an auto entry's outfit as it is now: what unwearableOn judges. */
export interface OutfitGarmentState extends WashState {
  id: number;
  status: GarmentStatus;
  away: AwayReason | null;
  /**
   * Worn today already ("Wore today", a worn entry): today's slots may wear
   * it again for no second wear, as the ledger counts it (canWear).
   */
  wornToday: boolean;
}

/** Why an auto entry's outfit cannot be worn on its day, the garment named where there is one. */
export type Unwearable =
  | {
      reason: AwayReason | Exclude<GarmentStatus, 'closet'> | 'dirty';
      garmentId: number;
    }
  | { reason: 'deleted' };

/**
 * Why the outfit of an auto entry on `day` cannot be worn as planned, or
 * null when it can: isAvailable on the planned day's terms. Every day, a
 * garment out of the closet (archived, a wishlist item) or away (lent, at
 * repair), and a garment deleted since (its slot emptied; only telling in
 * an outfit the planner created, whose every slot had a garment: a saved
 * outfit reused may have a slot left empty on purpose). **Dirty counts only
 * on the day itself**: today's wash state is a fact, a later day's is a
 * projection the next load of laundry changes, and the re-plan runs every
 * morning, so a garment still without a clean copy on its day is caught
 * then, before the person dresses. A garment already worn today dresses
 * today's other slots (one wear a day). Garments first, in slot order, so
 * the notice names one when it can.
 */
export function unwearableOn(
  entry: {
    day: IsoDate;
    outfitCreated: boolean;
    /** The outfit's slots, in order: a garment, or null for an empty slot. */
    slots: readonly (OutfitGarmentState | null)[];
  },
  today: IsoDate,
): Unwearable | null {
  for (const garment of entry.slots) {
    if (garment === null) continue;
    if (garment.status !== 'closet') {
      return { reason: garment.status, garmentId: garment.id };
    }
    if (garment.away !== null) {
      return { reason: garment.away, garmentId: garment.id };
    }
    if (entry.day === today && !garment.wornToday && !isAvailable(garment)) {
      return { reason: 'dirty', garmentId: garment.id };
    }
  }
  return entry.outfitCreated && entry.slots.includes(null)
    ? { reason: 'deleted' }
    : null;
}

// ---- Judging planned entries against a newer forecast ----------------------

/** What an auto entry was planned for: the targets the re-plan compares. */
export interface PlannedNeeds {
  torso: number;
  limbs: number;
  layer: boolean;
  rain: boolean;
}

export function plannedNeeds(needs: WeatherNeeds | null): PlannedNeeds | null {
  return (
    needs && {
      torso: needs.torso,
      limbs: needs.limbs,
      layer: needs.layer,
      rain: needs.rain,
    }
  );
}

export function sameNeeds(
  a: PlannedNeeds | null,
  b: PlannedNeeds | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.torso === b.torso &&
    a.limbs === b.limbs &&
    a.layer === b.layer &&
    a.rain === b.rain
  );
}

/** How a slot's weather moved, the most telling first: what the swap's push says. */
export type NeedsChange =
  | 'forecast'
  | 'rain'
  | 'colder'
  | 'warmer'
  | 'dry'
  | 'swing';

export function needsChange(
  before: PlannedNeeds | null,
  after: PlannedNeeds,
): NeedsChange {
  if (before === null) return 'forecast';
  if (after.rain && !before.rain) return 'rain';
  const warmth = after.torso - before.torso || after.limbs - before.limbs;
  if (warmth > 0) return 'colder';
  if (warmth < 0) return 'warmer';
  if (before.rain && !after.rain) return 'dry';
  return 'swing';
}

/** An entry the planner wrote and still owns (planned_by 'auto'). */
export interface AutoEntry {
  /** One of the context's entries. */
  entryId: number;
  /** Null when it was planned without a forecast. */
  plannedFor: PlannedNeeds | null;
  /** unwearableOn's verdict on its outfit. */
  unwearable: Unwearable | null;
}

/** Why the re-plan swapped an entry: what the swap's push says. */
export type SwapCause =
  | { kind: 'weather'; change: NeedsChange }
  | { kind: 'unwearable'; unwearable: Unwearable };

export type Replan<G extends PlannerGarment> =
  /** The targets did not change (or the day has no forecast now). */
  | { entryId: number; kind: 'unchanged' }
  /**
   * The targets changed, but the outfit still fits them or nothing in the
   * closet fits better: kept, with the new targets recorded.
   */
  | { entryId: number; kind: 'kept'; needs: PlannedNeeds }
  /**
   * `idea` takes the entry's place: its outfit cannot be worn, or no longer
   * fits the weather and `idea` fits better. `needs` are the slot's targets
   * now (null without a forecast for its day).
   */
  | {
      entryId: number;
      kind: 'swap';
      slot: Slot;
      idea: Idea<G>;
      needs: PlannedNeeds | null;
      cause: SwapCause;
    };

/**
 * Judges each auto entry, in day and occasion order, planning a slot again
 * under planWeek's rules where it must (the week's other entries and swaps
 * count toward wash limits and duplicates). An outfit that cannot be worn
 * (`unwearable`) is swapped for the slot's best idea, whatever the
 * forecast; with none, it is judged as any other. Otherwise against today's
 * forecast: unchanged targets keep the entry as it is; changed ones keep it
 * when its outfit still fits them, else swap only for an idea that answers
 * the weather better. Never judges an entry that is not in `auto`: a
 * person's own are not the planner's to change.
 */
export function replanWeek<G extends PlannerGarment>(
  input: WeekContext<G> & { auto: readonly AutoEntry[] },
): Replan<G>[] {
  const ledger = new WeekLedger(input);
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  const auto = input.auto
    .flatMap((a) => {
      const entry = byId.get(a.entryId);
      return entry && !entry.worn ? [{ ...a, entry }] : [];
    })
    .sort(
      (a, b) =>
        a.entry.day.localeCompare(b.entry.day) ||
        compareOccasions(a.entry.occasion, b.entry.occasion),
    );
  return auto.map(({ entryId, plannedFor, unwearable, entry }): Replan<G> => {
    const slot = { day: entry.day, occasion: entry.occasion };
    const needs = needsOf(input, entry);
    const now = plannedNeeds(needs);
    if (unwearable) {
      ledger.unwear(entry.day, entry.garments);
      const idea = ideaFor(input, ledger, entry, needs);
      if (idea) {
        ledger.wear(entry.day, idea.garments, { asOutfit: true });
        return {
          entryId,
          kind: 'swap',
          slot,
          idea,
          needs: now,
          cause: { kind: 'unwearable', unwearable },
        };
      }
      // Nothing else dresses the slot: the outfit stays, judged below.
      ledger.wear(entry.day, entry.garments, { asOutfit: false });
    }
    if (!needs || !now || sameNeeds(plannedFor, now)) {
      return { entryId, kind: 'unchanged' };
    }
    const current = weatherScore(needs, entry.garments);
    if (current === 0) return { entryId, kind: 'kept', needs: now };
    ledger.unwear(entry.day, entry.garments);
    const idea = ideaFor(input, ledger, entry, needs);
    if (idea && weatherScore(needs, idea.garments) < current) {
      ledger.wear(entry.day, idea.garments, { asOutfit: true });
      return {
        entryId,
        kind: 'swap',
        slot,
        idea,
        needs: now,
        cause: { kind: 'weather', change: needsChange(plannedFor, now) },
      };
    }
    ledger.wear(entry.day, entry.garments, { asOutfit: false });
    return { entryId, kind: 'kept', needs: now };
  });
}

function weatherScore(
  needs: WeatherNeeds,
  garments: readonly { weather: MatchGarment }[],
): number {
  return assessOutfit(
    needs,
    garments.map((g) => g.weather),
  ).score;
}

// ---- Shared by both --------------------------------------------------------

function needsOf(
  context: Pick<WeekContext<PlannerGarment>, 'forecast' | 'offset'>,
  slot: Slot,
): WeatherNeeds | null {
  const forecast = context.forecast.get(slot.day);
  return forecast
    ? weatherNeeds(forecast, slot.occasion, context.offset)
    : null;
}

/** The slot's seed: the same slot draws the same ideas. */
export function slotSeed(slot: Slot): number {
  return Math.floor(
    seededRandom('week-plan', PLANNER_VERSION, slot.day, slot.occasion).next() *
      SEED_RANGE,
  );
}

/**
 * The generator's best idea for the slot from what the ledger leaves
 * wearable that day, or undefined when there is none.
 */
function ideaFor<G extends PlannerGarment>(
  context: WeekContext<G>,
  ledger: WeekLedger,
  slot: Slot,
  needs: WeatherNeeds | null,
): Idea<G> | undefined {
  const originals = new Map(context.pool.map((g) => [g.id, g]));
  const rested = daysBetween(context.today, slot.day);
  const pool = context.pool
    .filter((g) => ledger.canWear(g, slot.day))
    .map((g) => ({
      ...g,
      idleDays: ledger.wears(g.id)
        ? 0
        : g.idleDays === null
          ? null
          : g.idleDays + rested,
    }));
  const [idea] = generateIdeas({
    seed: slotSeed(slot),
    pool,
    needs,
    formality: OCCASION_HINTS[slot.occasion].formality,
    avoid: context.avoid,
    saved: ledger.outfits,
    offset: 0,
    limit: 1,
  }).ideas;
  // The ideas hold the rotated copies; hand back the caller's own objects.
  return (
    idea && {
      ...idea,
      garments: idea.garments.map((g) => originals.get(g.id)!),
    }
  );
}

/**
 * The week's future wears as the plan grows: per garment, the days an
 * unworn entry or a planned outfit wears it (and how many of them, so an
 * outfit taken back off a day leaves another's wear there), and the
 * outfits the week holds besides the saved ones.
 */
class WeekLedger {
  private readonly days = new Map<number, Map<IsoDate, number>>();
  readonly outfits: SavedOutfit[];
  private readonly today: IsoDate;

  constructor(context: WeekContext<PlannerGarment>) {
    this.today = context.today;
    this.outfits = [...context.saved];
    for (const entry of context.entries) {
      if (!entry.worn) {
        this.wear(entry.day, entry.garments, { asOutfit: false });
      }
    }
  }

  wear(
    day: IsoDate,
    garments: readonly { id: number; role: GarmentRole }[],
    { asOutfit }: { asOutfit: boolean },
  ): void {
    for (const { id } of garments) {
      const days = this.days.get(id) ?? new Map<IsoDate, number>();
      days.set(day, (days.get(day) ?? 0) + 1);
      this.days.set(id, days);
    }
    if (asOutfit) this.outfits.push(garments);
  }

  unwear(day: IsoDate, garments: readonly { id: number }[]): void {
    for (const { id } of garments) {
      const days = this.days.get(id);
      const count = days?.get(day) ?? 0;
      if (count > 1) days!.set(day, count - 1);
      else days?.delete(day);
    }
  }

  /** The week wears it on some day. */
  wears(id: number): boolean {
    return (this.days.get(id)?.size ?? 0) > 0;
  }

  /**
   * Whether `garment` can go into an outfit on `day`: free when the day
   * already wears it (one wear a day), else only while a clean copy is left
   * after every wear the week has committed.
   */
  canWear(garment: PlannerGarment, day: IsoDate): boolean {
    const wornToday = garment.idleDays === 0;
    const days = this.days.get(garment.id);
    if (days?.has(day) || (day === this.today && wornToday)) return true;
    // Today's wear is in wearsSinceWash already; a planned one today is not
    // a second.
    const future = [...(days?.keys() ?? [])].filter(
      (d) => !(d === this.today && wornToday),
    ).length;
    return (
      cleanCopies({
        quantity: garment.quantity,
        limit: garment.washLimit,
        wearsSinceWash: garment.wearsSinceWash + future,
      }) > 0
    );
  }
}
