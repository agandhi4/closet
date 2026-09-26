import { randomBytes } from 'node:crypto';
import { Readable, type Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { initialCutoutState } from '../cutout/state';
import type { Db, Queryable } from '../db/client';
import type { SharePermission } from '../db/schema';
import type { Logger } from '../logger';
import {
  readSecretLine,
  type TerminalInput,
} from '../maintenance/set-password';
import { deleteAccount } from '../web/auth/account';
import { hashPassword, passwordProblems } from '../web/auth/passwords';
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
import { createOutfit } from '../web/outfits/queries';
import { markWashed, setAway, setEntryWorn } from '../web/wears/queries';
import {
  acceptInvite,
  createInvite,
  declineInvite,
} from '../web/sharing/queries';
import { splitColors } from '../web/wardrobe/garment';
import { insertGarment, toggleArchived } from '../web/wardrobe/queries';
import { garmentSvg } from './art';
import {
  isPersonaKey,
  loadPersona,
  type Persona,
  PERSONA_KEYS,
  type PersonaKey,
  type SeedGarment,
  slotRank,
} from './persona';
import { type SimulatedLife, simulate } from './simulate';

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
}

export interface SeedReport {
  userId: number;
  garments: number;
  photos: number;
  outfits: number;
  capsules: number;
  entries: number;
  worn: number;
  /** garment_wear rows the worn entries wrote. */
  wears: number;
  /** Laundry Sundays written (last_washed_on). */
  washes: number;
  ms: number;
}

// A worn day was worn by the evening.
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
  try {
    const report = await db.transaction(async (tx) => {
      const { id: userId } = await insertUser(tx, email, passwordHash, {
        firstName: persona.account.firstName,
        lastName: persona.account.lastName,
      });
      const ids = new Map<string, number>();
      for (const garment of persona.garments) {
        const photo = photos.get(garment.id);
        const photoId = photo
          ? await insertPhotoRow(tx, {
              ...photo,
              createdById: userId,
              // The art is its own cutout: nothing to queue.
              ...initialCutoutState('ready'),
            })
          : null;
        const acquiredOn = garment.fields.acquiredOn;
        const id = await insertGarment(
          tx,
          userId,
          {
            ...garment.fields,
            acquiredOn: acquiredOn && addDays(acquiredOn, life.shiftDays),
          },
          photoId,
        );
        if (garment.archivedOn) await toggleArchived(tx, id, userId);
        if (garment.away) await setAway(tx, userId, id, garment.away);
        ids.set(garment.id, id);
      }
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
      const wears = await writeHistory(tx, life, {
        userId,
        outfitIds,
        garmentIds: ids,
        anchor: options.anchor,
        timeZone: deps.timeZone,
      });
      return {
        userId,
        garments: persona.garments.length,
        photos: photos.size,
        outfits: outfitIds.length,
        capsules: persona.capsules.length,
        entries: life.entries.length,
        worn: life.entries.filter((e) => e.worn).length,
        wears,
        washes: life.washes.length,
        ms: Date.now() - startedAt,
      };
    });
    logger.info(
      `Seeded ${persona.key} as user ${report.userId}: ${report.garments} garments, ${report.photos} photos, ${report.outfits} outfits, ${report.capsules} capsules, ${report.entries} calendar entries (${report.worn} worn, ${report.wears} wears), ${report.washes} laundry days in ${report.ms}ms`,
    );
    return report;
  } catch (error) {
    logger.warn(
      `Seeding ${persona.key} failed; removing its ${photos.size} photos`,
    );
    for (const photo of photos.values()) {
      await deps.photos.deleteVariants(photo.fileName);
    }
    throw error;
  }
}

/**
 * The simulated history through the app's writers: every calendar entry
 * (insertEntry), the worn ones marked as the pill does (setEntryWorn, which
 * logs their wears) at 21:00 that day, then the laundry Sundays in order
 * (markWashed), so each garment ends on its last one. Returns the wear rows
 * written.
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
    anchor: IsoDate;
    timeZone: string;
  },
): Promise<number> {
  const { userId } = ids;
  let wears = 0;
  for (const entry of life.entries) {
    const scheduled = await insertEntry(tx, {
      ownerId: userId,
      outfitId: ids.outfitIds[entry.outfit],
      day: entry.day,
    });
    // The simulation plans each (day, outfit) once: always a new entry.
    if (!entry.worn || scheduled.outcome !== 'scheduled') continue;
    const worn = await setEntryWorn(tx, {
      entryId: scheduled.id,
      ownerId: userId,
      worn: true,
      at: instantAt(entry.day, WORN_HOUR, ids.timeZone),
      today: ids.anchor,
    });
    if (typeof worn !== 'string') wears += worn.wears;
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
  const pending = persona.garments.filter((g) => g.photo);
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
  garment: SeedGarment,
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

export function svgOf(garment: SeedGarment): string {
  return garmentSvg({
    category: garment.fields.category,
    type: garment.fields.type ?? null,
    name: garment.fields.name,
    colors: splitColors(garment.fields.color),
    pattern: garment.fields.pattern ?? null,
  });
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
                     [--share-with <email>] [--password-stdin]
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
}

const OPTIONS = {
  persona: { type: 'string', multiple: true },
  reset: { type: 'boolean', default: false },
  remove: { type: 'boolean', default: false },
  anchor: { type: 'string' },
  'share-with': { type: 'string' },
  'password-stdin': { type: 'boolean', default: false },
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
    await seedOne(command, persona, { anchor, password }, grantee);
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
  options: { anchor: IsoDate; password: string },
  grantee: { id: number; email: string } | undefined,
): Promise<void> {
  const { output } = command;
  const report = await seedPersona(command, persona, options);
  output.write(
    report
      ? `${persona.key}: seeded ${report.garments} garments, ${report.photos} photos, ${report.outfits} outfits, ${report.capsules} capsules, ${report.entries} calendar entries in ${(report.ms / 1000).toFixed(1)} s. Sign in as ${persona.account.email} with ${options.password}\n`
      : `${persona.key}: already seeded, left as it is (--reset rebuilds it)\n`,
  );
  if (!grantee) return;
  const account = await findUserByEmail(
    command.db,
    normalizeEmail(persona.account.email),
  );
  await share(command, account!.id, grantee.id, 'VIEW');
  output.write(`${persona.key}: shared (VIEW) with ${grantee.email}\n`);
}

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
