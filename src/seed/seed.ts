import { randomBytes } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { initialCutoutState } from '../cutout/state';
import type { Db, Queryable } from '../db/client';
import type { SharePermission } from '../db/schema';
import type { Logger } from '../logger';
import { OCCASION_HINTS } from '../wardrobe/occasions';
import {
  readSecretLine,
  type TerminalInput,
} from '../maintenance/set-password';
import { deleteAccount } from '../web/auth/account';
import { hashPassword, passwordProblems } from '../web/auth/passwords';
import { createToken } from '../web/auth/personal-tokens';
import {
  findUserByEmail,
  insertUser,
  normalizeEmail,
} from '../web/auth/queries';
import { insertEntry } from '../web/calendar/queries';
import { changeMembership, createCapsule } from '../web/capsules/queries';
import {
  addDays,
  instantAt,
  type IsoDate,
  parseIsoDate,
  todayIn,
} from '../web/calendar/calendar-date';
import type { Photos } from '../web/files/photos';
import { insertPhotoRow, type NewPhotoRow } from '../web/files/queries';
import { t } from '../web/i18n';
import { avoidPair } from '../web/gallery/queries';
import { createOutfit } from '../web/outfits/queries';
import {
  createPlan,
  insertItems,
  saveStyleProfile,
  setActivePlan,
} from '../web/plans/queries';
import { changeCandidates } from '../web/plans/candidates';
import { setEntrySelfie } from '../web/selfies/queries';
import { markWashed, setAway, setEntryWorn } from '../web/wears/queries';
import {
  acceptInvite,
  createInvite,
  declineInvite,
} from '../web/sharing/queries';
import { splitColors } from '../web/wardrobe/garment';
import { insertGarment } from '../web/wardrobe/queries';
import { setGarmentStatus } from '../web/wardrobe/status';
import { setHome, setTemperatureUnit } from '../web/weather/queries';
import {
  NO_FORECAST,
  planMyWeek,
  type WeekForecast,
} from '../web/week-plan/plan';
import { saveWeekTemplate } from '../web/week-plan/template';
import { type ArtSubject, garmentSvg } from './art';
import {
  isPersonaKey,
  loadPersona,
  type Persona,
  PERSONA_KEYS,
  type PersonaKey,
  type PersonaWeather,
  type SeedGarment,
  type SeedWishlistItem,
  slotRank,
} from './persona';
import { mirrorSelfieSvg, SELFIE_ROOMS } from './selfie-art';
import { PLANNED_DAYS, type SimulatedLife, simulate } from './simulate';
import { forecastDayOf } from './weather';

/**
 * `npm run seed`: writes the personas (src/seed/personas/*.md) through the
 * app's own writers and Photos, so a seeded wardrobe is exactly what the app
 * would have stored. A persona is written in one transaction (its user
 * existing means it is complete), which is what makes seeding idempotent:
 * an existing persona is left alone, `--reset` removes and rewrites it.
 */

export interface SeedDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
  /** APP_TIMEZONE: "today" for the default anchor, and when a day was worn. */
  timeZone: string;
  /** WEATHER_ENABLED: off, no persona's location is stored (as for anyone). */
  weatherEnabled: boolean;
}

export interface SeedReport {
  userId: number;
  garments: number;
  wishlist: number;
  photos: number;
  outfits: number;
  capsules: number;
  /** Wardrobe plans (#34), with the style profile when the bible has one. */
  plans: number;
  /** generator_avoid pairs (the bible's Clashes). */
  avoided: number;
  entries: number;
  worn: number;
  /** garment_wear rows the worn entries wrote. */
  wears: number;
  /** Outfit selfies taken (#19). */
  selfies: number;
  /** Laundry Sundays written (last_washed_on). */
  washes: number;
  /** The planned week's outfits "Plan my week" wrote (#16). */
  autoPlanned: number;
  ms: number;
}

// A worn day was worn by the evening. The anchor is today, half lived:
// what is worn on it (the morning's workout) was worn by the end of its
// occasion's window (OCCASION_HINTS), not tonight.
const WORN_HOUR = 21;

/**
 * Writes `persona` as it lives up to `anchor`; undefined when its user
 * already exists (nothing is changed). Photo bytes are written first and
 * the rows in one transaction, whose failure deletes the bytes again (the
 * commit contract, CLAUDE.md Gotchas).
 */
export async function seedPersona(
  deps: SeedDeps,
  persona: Persona,
  options: { anchor: IsoDate; password: string },
): Promise<SeedReport | undefined> {
  const { db, logger } = deps;
  const email = normalizeEmail(persona.account.email);
  if (await findUserByEmail(db, email)) return undefined;
  const startedAt = Date.now();
  logger.info(`Seeding ${persona.key} (anchor ${options.anchor})`);
  const life = simulate(persona, options.anchor);
  const passwordHash = await hashPassword(options.password);
  const photos = await storeArt(deps, persona);
  const selfies = await storeSelfies(deps, persona, life).catch(
    async (error: unknown) => {
      await removeStored(deps, photos.values());
      throw error;
    },
  );
  try {
    const report = await db.transaction(async (tx) => {
      const { id: userId } = await insertUser(tx, email, passwordHash, {
        firstName: persona.account.firstName,
        lastName: persona.account.lastName,
      });
      if (deps.weatherEnabled) await writeWeather(tx, userId, persona.weather);
      const { owned: ids, wishlist: wishlistIds } = await writeGarments(
        tx,
        userId,
        persona,
        { photos, shiftDays: life.shiftDays },
      );
      const byId = new Map(persona.garments.map((g) => [g.id, g]));
      const outfitIds: number[] = [];
      for (const outfit of persona.outfits) {
        const garments = outfit.garmentIds
          .map((id) => byId.get(id)!)
          .sort(
            (a, b) => slotRank(a.fields.category) - slotRank(b.fields.category),
          );
        const saved = await createOutfit(tx, userId, {
          name: outfit.name,
          notes: null,
          slots: garments.map((g) => ({
            category: g.fields.category,
            garmentId: ids.get(g.id)!,
          })),
        });
        outfitIds.push(saved.id);
      }
      for (const capsule of persona.capsules) {
        const capsuleId = await createCapsule(tx, userId, capsule.fields);
        // The bible's names are checked unique (persona.ts): unreachable.
        if (capsuleId === 'name-taken') {
          throw new Error(`Capsule "${capsule.fields.name}" twice`);
        }
        await changeMembership(tx, userId, {
          add: {
            capsuleIds: [capsuleId],
            garmentIds: capsule.garmentIds.map((id) => ids.get(id)!),
          },
        });
      }
      await writePlans(tx, userId, persona, wishlistIds);
      await writeClashes(tx, userId, persona, ids);
      const wears = await writeHistory(tx, life, {
        userId,
        outfitIds,
        garmentIds: ids,
        selfies,
        anchor: options.anchor,
        timeZone: deps.timeZone,
      });
      const autoPlanned = await writePlannedWeek(tx, userId, persona, life, {
        anchor: options.anchor,
        weatherEnabled: deps.weatherEnabled,
      });
      return {
        userId,
        garments: persona.garments.length,
        wishlist: persona.wishlist.length,
        photos: photos.size,
        outfits: outfitIds.length,
        capsules: persona.capsules.length,
        plans: persona.plans.length,
        avoided: persona.avoid.length,
        entries: life.entries.length,
        worn: life.entries.filter((e) => e.worn).length,
        wears,
        selfies: selfies.size,
        washes: life.washes.length,
        autoPlanned,
        ms: Date.now() - startedAt,
      };
    });
    logger.info(
      `Seeded ${persona.key} as user ${report.userId}: ${report.garments} garments, ${report.wishlist} wishlist items, ${report.photos} photos, ${report.outfits} outfits, ${report.capsules} capsules, ${report.plans} plans, ${report.avoided} clashes, ${report.entries} calendar entries (${report.worn} worn, ${report.wears} wears, ${report.selfies} selfies), ${report.autoPlanned} planned by Plan my week, ${report.washes} laundry days in ${report.ms}ms`,
    );
    return report;
  } catch (error) {
    logger.warn(
      `Seeding ${persona.key} failed; removing its ${photos.size} photos and ${selfies.size} selfies`,
    );
    await removeStored(deps, [...photos.values(), ...selfies.values()]);
    throw error;
  }
}

// Bytes stored ahead of a transaction that did not commit (the commit
// contract): nothing references them.
async function removeStored(
  { photos }: SeedDeps,
  stored: Iterable<NewPhotoRow>,
): Promise<void> {
  for (const photo of stored) await photos.deleteVariants(photo.fileName);
}

/**
 * The planned week (#16): the persona's week template (the week table's
 * Calendar and Workout columns, through the template form) and "Plan my
 * week" (planMyWeek, the app's own planner and writes) over the seven days
 * after the anchor, with the forecast the tests' Open-Meteo stand-in
 * serves for them (forecastDayOf) when the weather is on. The simulation
 * planned only what the template does not hold (date nights, nights out,
 * an Event's outfit), so the planner fills the rest, marked Auto, as it
 * would for Theo on a Saturday evening. Its wash state is the anchor's (the
 * Sunday laundry is not written yet), which it respects. Returns the
 * entries it planned.
 */
async function writePlannedWeek(
  tx: Queryable,
  userId: number,
  persona: Persona,
  life: SimulatedLife,
  options: { anchor: IsoDate; weatherEnabled: boolean },
): Promise<number> {
  if (!persona.weekTemplate) return 0;
  await saveWeekTemplate(tx, userId, persona.weekTemplate);
  const days = Array.from({ length: PLANNED_DAYS }, (_, i) =>
    addDays(options.anchor, i + 1),
  );
  const forecast: WeekForecast = options.weatherEnabled
    ? {
        days: new Map(
          life.weather
            .filter((weather) => days.includes(weather.day))
            .map((weather) => [
              weather.day,
              forecastDayOf(persona.key, weather),
            ]),
        ),
        offset: 0,
      }
    : NO_FORECAST;
  const planned = await planMyWeek(tx, userId, {
    today: options.anchor,
    // Only today's slots read the hour, and the anchor is not planned.
    hour: 0,
    days,
    forecast,
  });
  return planned.planned.length;
}

/**
 * The bible's style profile and wardrobe plans (#34), through the app's
 * writers: saveStyleProfile, createPlan (the first plan is active by the
 * app's rule), its items (insertItems) with their candidate products
 * (changeCandidates, 34b: the wishlist's garments by bible id), then
 * setActivePlan for the one marked `(active)`.
 */
async function writePlans(
  tx: Queryable,
  userId: number,
  persona: Persona,
  wishlistIds: Map<string, number>,
): Promise<void> {
  if (persona.styleProfile) {
    await saveStyleProfile(tx, userId, persona.styleProfile);
  }
  for (const plan of persona.plans) {
    const id = await createPlan(tx, userId, plan.fields);
    // The bible's names are checked unique (persona.ts): unreachable.
    if (id === 'name-taken')
      throw new Error(`Plan "${plan.fields.name}" twice`);
    const itemIds = await insertItems(
      tx,
      id,
      plan.items.map((item) => item.fields),
      { proposed: false },
    );
    for (const [index, item] of plan.items.entries()) {
      if (item.candidates.length === 0) continue;
      await changeCandidates(tx, userId, {
        add: {
          itemIds: [itemIds[index]],
          garmentIds: item.candidates.map(
            (bibleId) => wishlistIds.get(bibleId)!,
          ),
        },
      });
    }
    if (plan.active) await setActivePlan(tx, id, userId);
  }
}

/**
 * The persona's garments with their photo rows (the art stored before the
 * transaction), archive and away, then the wishlist, which names the owned
 * garment each item replaces. The ids by bible id: the owned garments', and
 * the wishlist's apart (plan candidates name them; the history must not).
 */
async function writeGarments(
  tx: Queryable,
  userId: number,
  persona: Persona,
  art: { photos: Map<string, NewPhotoRow>; shiftDays: number },
): Promise<{ owned: Map<string, number>; wishlist: Map<string, number> }> {
  const photoIdOf = async (bibleId: string) => {
    const photo = art.photos.get(bibleId);
    return photo
      ? insertPhotoRow(tx, {
          ...photo,
          createdById: userId,
          // The art is its own cutout: nothing to queue.
          ...initialCutoutState('ready'),
        })
      : null;
  };
  const ids = new Map<string, number>();
  for (const garment of persona.garments) {
    const acquiredOn = garment.fields.acquiredOn;
    const id = await insertGarment(
      tx,
      userId,
      {
        ...garment.fields,
        acquiredOn: acquiredOn && addDays(acquiredOn, art.shiftDays),
      },
      await photoIdOf(garment.id),
      'closet',
    );
    if (garment.archivedOn) await archive(tx, id, userId, garment.id);
    if (garment.away) await setAway(tx, userId, id, garment.away);
    ids.set(garment.id, id);
  }
  // After the owned garments: an item names the one it replaces.
  const wishlist = new Map<string, number>();
  for (const item of persona.wishlist) {
    const id = await insertGarment(
      tx,
      userId,
      {
        ...item.fields,
        replacesGarmentId:
          item.replaces === null ? null : ids.get(item.replaces)!,
      },
      await photoIdOf(item.id),
      'wishlist',
    );
    wishlist.set(item.id, id);
  }
  return { owned: ids, wishlist };
}

/**
 * The Clashes table as the gallery's "Not this" writes it (avoidPair); the
 * bible checked both garments are owned and never in one saved outfit.
 */
async function writeClashes(
  tx: Queryable,
  userId: number,
  persona: Persona,
  ids: Map<string, number>,
): Promise<void> {
  for (const [a, b] of persona.avoid) {
    const outcome = await avoidPair(tx, userId, ids.get(a)!, ids.get(b)!);
    if (outcome !== 'added') throw new Error(`Clash ${a} + ${b}: ${outcome}`);
  }
}

/** An archived garment of the bible, archived as the garment page does. */
async function archive(
  tx: Queryable,
  id: number,
  userId: number,
  bibleId: string,
): Promise<void> {
  const archived = await setGarmentStatus(tx, id, userId, {
    event: 'archive',
  });
  // Inserted in the closet a moment ago: anything else is a bug.
  if (!archived.ok) throw new Error(`Could not archive ${bibleId}`);
}

/** The Account table's weather rows through the profile's writers (#14). */
async function writeWeather(
  tx: Queryable,
  userId: number,
  weather: PersonaWeather | null,
): Promise<void> {
  if (!weather) return;
  await setHome(tx, userId, weather.home);
  await setTemperatureUnit(tx, userId, weather.unit);
}

/**
 * The simulated history through the app's writers: every calendar entry
 * (insertEntry, with its occasion), the worn ones marked as the pill does
 * (setEntryWorn, which logs their wears; a day's workout and evening count
 * as the one wear the day is) at 21:00 that day, when he logs it (the
 * anchor's morning workout by the end of its window), an entry with a
 * selfie through the selfie's own writer instead (setEntrySelfie, which
 * marks it worn the same way: the photo stored before the transaction by
 * storeSelfies), then the laundry Sundays in order (markWashed), so each
 * garment ends on its last one. Returns the wear rows written.
 */
async function writeHistory(
  tx: Queryable,
  life: SimulatedLife,
  ids: {
    userId: number;
    /** By the bible's outfit index. */
    outfitIds: number[];
    /** By the bible's garment id. */
    garmentIds: Map<string, number>;
    /** The selfies' stored photos, by index into life.entries. */
    selfies: Map<number, NewPhotoRow>;
    anchor: IsoDate;
    timeZone: string;
  },
): Promise<number> {
  const { userId } = ids;
  let wears = 0;
  for (const [index, entry] of life.entries.entries()) {
    const scheduled = await insertEntry(tx, {
      ownerId: userId,
      outfitId: ids.outfitIds[entry.outfit],
      day: entry.day,
      occasion: entry.occasion,
    });
    // The simulation plans each (day, outfit) once: always a new entry.
    if (!entry.worn || scheduled.outcome !== 'scheduled') continue;
    const worn = {
      entryId: scheduled.id,
      ownerId: userId,
      at: instantAt(
        entry.day,
        entry.day === ids.anchor
          ? OCCASION_HINTS[entry.occasion].window.to
          : WORN_HOUR,
        ids.timeZone,
      ),
      today: ids.anchor,
    };
    const photo = ids.selfies.get(index);
    const outcome = photo
      ? await setEntrySelfie(tx, {
          ...worn,
          photo: { ...photo, createdById: userId },
        })
      : await setEntryWorn(tx, { ...worn, worn: true });
    if (typeof outcome === 'string') {
      throw new Error(`Entry ${scheduled.id} on ${entry.day}: ${outcome}`);
    }
    wears += 'selfieId' in outcome ? outcome.worn.wears : outcome.wears;
  }
  for (const wash of life.washes) {
    await markWashed(
      tx,
      userId,
      wash.garmentIds.map((id) => ids.garmentIds.get(id)!),
      wash.day,
    );
  }
  return wears;
}

// Garments drawn at once: sharp works on its own threads, so a few in
// flight keep the cores busy without holding every image in memory.
const ART_CONCURRENCY = 4;

// Every garment's art, drawn and stored before any row exists. The rows'
// owner does not exist yet: seedPersona sets createdById on insert.
async function storeArt(
  { photos, logger }: SeedDeps,
  persona: Persona,
): Promise<Map<string, NewPhotoRow>> {
  const stored = new Map<string, NewPhotoRow>();
  const pending = [...persona.garments, ...persona.wishlist].filter(
    (g) => g.photo,
  );
  const failures: unknown[] = [];
  for (
    let i = 0;
    i < pending.length && !failures.length;
    i += ART_CONCURRENCY
  ) {
    const batch = pending.slice(i, i + ART_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((garment) => storeGarmentArt(photos, persona, garment)),
    );
    results.forEach((result, n) => {
      if (result.status === 'fulfilled') stored.set(batch[n].id, result.value);
      else failures.push(result.reason);
    });
  }
  if (failures.length > 0) {
    logger.warn(`Drawing ${persona.key}'s photos failed; removing them`);
    for (const photo of stored.values()) {
      await photos.deleteVariants(photo.fileName);
    }
    throw new AggregateError(
      failures,
      `Drawing ${persona.key}'s photos failed`,
    );
  }
  return stored;
}

async function storeGarmentArt(
  photos: Photos,
  persona: Persona,
  garment: SeedGarment | SeedWishlistItem,
): Promise<NewPhotoRow> {
  const png = await sharp(Buffer.from(svgOf(garment)))
    .png()
    .toBuffer();
  return photos.storeImage(
    {
      stream: Readable.from(png),
      mimetype: 'image/png',
      filename: `${persona.key}-${garment.id}.png`,
    },
    0,
    { alphaIsCutout: true },
  );
}

export function svgOf(garment: SeedGarment | SeedWishlistItem): string {
  return garmentSvg(artSubject(garment));
}

function artSubject(garment: SeedGarment | SeedWishlistItem): ArtSubject {
  return {
    category: garment.fields.category,
    type: garment.fields.type ?? null,
    name: garment.fields.name,
    colors: splitColors(garment.fields.color),
    pattern: garment.fields.pattern ?? null,
  };
}

/**
 * The simulation's outfit selfies (#19), drawn and stored before any row
 * exists, like the garment art: each a mirror photo of the entry's outfit
 * (selfie-art.ts), stored as a photo (no cutout: it keeps its background),
 * by index into life.entries. Their rooms take turns. On a failure the ones
 * stored are removed.
 */
async function storeSelfies(
  { photos, logger }: SeedDeps,
  persona: Persona,
  life: SimulatedLife,
): Promise<Map<number, NewPhotoRow>> {
  const byId = new Map(persona.garments.map((g) => [g.id, g]));
  const stored = new Map<number, NewPhotoRow>();
  try {
    for (const [index, entry] of life.entries.entries()) {
      if (!entry.selfie) continue;
      const garments = persona.outfits[entry.outfit].garmentIds.map((id) =>
        artSubject(byId.get(id)!),
      );
      const png = await sharp(
        Buffer.from(mirrorSelfieSvg(garments, stored.size % SELFIE_ROOMS)),
      )
        .png()
        .toBuffer();
      const photo = await photos.storeImage(
        {
          stream: Readable.from(png),
          mimetype: 'image/png',
          filename: `${persona.key}-selfie-${entry.day}.png`,
        },
        0,
      );
      stored.set(index, photo);
    }
  } catch (error) {
    logger.warn(`Drawing ${persona.key}'s selfies failed; removing them`);
    for (const photo of stored.values()) {
      await photos.deleteVariants(photo.fileName);
    }
    throw error;
  }
  return stored;
}

/**
 * Deletes the persona's account through the profile's own deletion (rows
 * cascade, photo files unlinked through Photos); false when it does not
 * exist. Only a persona's own address can be named, never an arbitrary
 * account.
 */
export async function removePersona(
  deps: SeedDeps,
  persona: Persona,
): Promise<boolean> {
  const account = await findUserByEmail(
    deps.db,
    normalizeEmail(persona.account.email),
  );
  if (!account) return false;
  const removed = await deleteAccount(deps, account.id);
  deps.logger.info(
    `Removed ${persona.key} (user ${account.id}, ${removed} photos)`,
  );
  return true;
}

/**
 * Shares `grantorId`'s wardrobe with `granteeId` through the app's own
 * invite and accept, so the row is exactly what the invite link makes. An
 * existing share is kept (accepting folds into it); true when one exists
 * after.
 */
export async function share(
  { db, logger }: SeedDeps,
  grantorId: number,
  granteeId: number,
  permission: SharePermission,
): Promise<boolean> {
  const invite = await createInvite(db, grantorId, permission);
  const result = await acceptInvite(db, invite.inviteToken, granteeId);
  if (!result.accepted) {
    // Nothing to accept into (it is the grantor's own account): no stray invite.
    await declineInvite(db, invite.inviteToken, grantorId);
    logger.warn(
      `Share of user ${grantorId}'s wardrobe with user ${granteeId} refused: ${result.reason}`,
    );
    return false;
  }
  logger.info(
    `Shared user ${grantorId}'s wardrobe with user ${granteeId} (${permission})`,
  );
  return true;
}

/** The personas' shares with each other (sparse to demo), wherever both exist. */
export async function linkPersonas(
  deps: SeedDeps,
  personas: Persona[],
): Promise<void> {
  const idOf = async (key: PersonaKey) => {
    const persona = personas.find((p) => p.key === key)!;
    return (
      await findUserByEmail(deps.db, normalizeEmail(persona.account.email))
    )?.id;
  };
  for (const persona of personas) {
    for (const { persona: other, permission } of persona.sharesWith) {
      const [grantor, grantee] = [await idOf(persona.key), await idOf(other)];
      if (grantor && grantee) await share(deps, grantor, grantee, permission);
    }
  }
}

// ---- The command -------------------------------------------------------------

export interface SeedCommand extends SeedDeps {
  /** The arguments after the script name. */
  args: string[];
  input: TerminalInput;
  output: Writable;
  errors: Writable;
  now: Date;
}

const USAGE = `Usage: npm run seed -- --persona <${PERSONA_KEYS.join('|')}|all> [--persona ...]
                     [--reset | --remove] [--anchor YYYY-MM-DD]
                     [--share-with <email>] [--password-stdin] [--token]
`;

/** A refusal with its message for the operator; exit status 1. */
class SeedRefused extends Error {}

/** The whole command; resolves to the exit status (0 done, 1 refused, 2 usage). */
export async function runSeed(command: SeedCommand): Promise<number> {
  const options = readOptions(command.args);
  if (!options) {
    command.errors.write(USAGE);
    return 2;
  }
  try {
    await seedCommand(command, options);
    return 0;
  } catch (error) {
    if (!(error instanceof SeedRefused)) throw error;
    command.errors.write(`${error.message}\n`);
    return 1;
  }
}

interface SeedOptions {
  personas: PersonaKey[];
  mode: 'seed' | 'reset' | 'remove';
  anchor?: IsoDate;
  shareWith?: string;
  passwordStdin: boolean;
  /** Also print a personal access token (the MCP endpoint's) per persona. */
  token: boolean;
}

const OPTIONS = {
  persona: { type: 'string', multiple: true },
  reset: { type: 'boolean', default: false },
  remove: { type: 'boolean', default: false },
  anchor: { type: 'string' },
  'share-with': { type: 'string' },
  'password-stdin': { type: 'boolean', default: false },
  token: { type: 'boolean', default: false },
} as const;

function parseOptions(args: string[]) {
  try {
    return parseArgs({ args, strict: true, options: OPTIONS }).values;
  } catch {
    return undefined;
  }
}

function readOptions(args: string[]): SeedOptions | undefined {
  const values = parseOptions(args);
  if (!values || (values.reset && values.remove)) return undefined;
  const personas = readPersonas(values.persona ?? []);
  // null: not given (today); undefined: not a date.
  const anchor =
    values.anchor === undefined ? null : parseIsoDate(values.anchor);
  if (!personas || anchor === undefined) return undefined;
  return {
    personas,
    mode: modeOf(values),
    anchor: anchor ?? undefined,
    shareWith: values['share-with'],
    passwordStdin: values['password-stdin'],
    token: values.token,
  };
}

function modeOf(values: {
  reset: boolean;
  remove: boolean;
}): SeedOptions['mode'] {
  if (values.remove) return 'remove';
  return values.reset ? 'reset' : 'seed';
}

// The --persona values as keys (`all` is every one); undefined for none or
// a name that is not a persona.
function readPersonas(named: string[]): PersonaKey[] | undefined {
  if (named.includes('all')) return [...PERSONA_KEYS];
  const keys = [...new Set(named.filter(isPersonaKey))];
  return keys.length > 0 && keys.length === new Set(named).size
    ? keys
    : undefined;
}

async function seedCommand(
  command: SeedCommand,
  options: SeedOptions,
): Promise<void> {
  // Every bible is read (and checked) first: a broken one writes nothing.
  const personas = PERSONA_KEYS.map(loadPersona);
  const chosen = personas.filter((p) => options.personas.includes(p.key));
  const grantee = await shareTarget(command, options.shareWith);
  if (options.mode !== 'seed') {
    for (const persona of chosen) {
      const removed = await removePersona(command, persona);
      command.output.write(
        `${persona.key}: ${removed ? 'removed' : 'not seeded, nothing to remove'}\n`,
      );
    }
    if (options.mode === 'remove') return;
  }
  const anchor = options.anchor ?? todayIn(command.timeZone, command.now);
  const password = await newPassword(command, options.passwordStdin);
  for (const persona of chosen) {
    await seedOne(
      command,
      persona,
      { anchor, password, token: options.token },
      grantee,
    );
  }
  await linkPersonas(command, personas);
}

// The --share-with account, which must exist before anything is written.
async function shareTarget(
  { db }: SeedCommand,
  email: string | undefined,
): Promise<{ id: number; email: string } | undefined> {
  if (email === undefined) return undefined;
  const account = await findUserByEmail(db, normalizeEmail(email));
  if (!account) throw new SeedRefused(`No account uses ${email}`);
  return { id: account.id, email };
}

async function seedOne(
  command: SeedCommand,
  persona: Persona,
  options: { anchor: IsoDate; password: string; token: boolean },
  grantee: { id: number; email: string } | undefined,
): Promise<void> {
  const { output } = command;
  const report = await seedPersona(command, persona, options);
  output.write(
    report
      ? `${persona.key}: seeded ${report.garments} garments, ${report.wishlist} wishlist items, ${report.photos} photos, ${report.outfits} outfits, ${report.capsules} capsules, ${report.plans} plans, ${report.entries} calendar entries in ${(report.ms / 1000).toFixed(1)} s. Sign in as ${persona.account.email} with ${options.password}\n`
      : `${persona.key}: already seeded, left as it is (--reset rebuilds it)\n`,
  );
  const account = await findUserByEmail(
    command.db,
    normalizeEmail(persona.account.email),
  );
  if (options.token) {
    // Like the password: printed once, never logged. Outside the persona's
    // transaction, so an existing persona gets one too; --reset and
    // --remove take it with the account.
    const created = await createToken(command.db, account!.id, SEED_TOKEN_NAME);
    output.write(
      created.created
        ? `${persona.key}: MCP token ${created.token} (shown once; revoke it at /auth/tokens)\n`
        : `${persona.key}: no MCP token, the account holds too many\n`,
    );
  }
  if (!grantee) return;
  await share(command, account!.id, grantee.id, 'VIEW');
  output.write(`${persona.key}: shared (VIEW) with ${grantee.email}\n`);
}

/** The seed's tokens, by name on the persona's Agent access page. */
const SEED_TOKEN_NAME = 'npm run seed';

// The personas' password: from stdin when asked (the known one development
// and CI use), else a random one, printed once with the logins.
async function newPassword(
  command: SeedCommand,
  fromStdin: boolean,
): Promise<string> {
  if (!fromStdin) return `${randomBytes(12).toString('base64url')}aA1`;
  const password = await readSecretLine(
    command.input,
    command.output,
    'Password for the personas: ',
  );
  const problems = passwordProblems(password);
  if (problems.length > 0) {
    throw new SeedRefused(problems.map((key) => t(key)).join('. '));
  }
  return password;
}
