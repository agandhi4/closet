import type { Db } from '../../db/client';
import { type ScalarValues, selectScalars } from '../../db/select-scalars';
import type { Idea } from '../../wardrobe/generator';
import type { IsoDate } from '../calendar/calendar-date';
import {
  type CapsuleRef,
  capsuleNamesSql,
  capsuleRefSql,
} from '../capsules/queries';
import type { IdeasAim } from '../gallery/aim';
import {
  browseIdea,
  type IdeasInput,
  ideasColumns,
  ideasFrom,
} from '../gallery/ideas';
import {
  closetGarmentsSql,
  type PoolGarment,
  readCloset,
  readPool,
  styledGarmentsSql,
} from '../gallery/queries';
import { sharedWardrobesSql, toSharedWardrobe } from '../sharing/access';
import type { WeatherService } from '../weather/service';
import {
  type Chosen,
  ownGarmentsSql,
  readGarments,
  readRoleWindows,
  readSavedOutfit,
  readStyledPlan,
  type RoledGarment,
  roleWindowsSql,
  type SavedOutfit,
  savedOutfitSql,
  type StyledPlan,
  styledPlanSql,
} from './queries';
import { type RoleWindow, withCandidates } from './rows';

/**
 * What a Styling request reads, in as few statements as the reads allow
 * (#163): production pays a round trip per statement (#156). Each part is
 * a scalar subquery its module owns (queries.ts, capsules', the
 * gallery's, sharing's), read together through selectScalars, as
 * gridContext does for the wardrobe grid. Two statements at most after
 * the session (and a shared wardrobe's share, and a trip's aim):
 * - stripsReads: the strips' windows and whatever the page needs beside
 *   them. The page without "Style this", "Add row" and a refused Save are
 *   this one statement.
 * - ideaReads: what the generator draws from, and the garments it locks,
 *   with the request's own checks. Shuffle and "Style this" read it
 *   first, since the windows must reach the idea's garments, which only
 *   the generator knows; then stripsReads for the windows.
 * The checks ride in the statement and are judged after it (the routes):
 * the capsule (null when it is not the wardrobe's, whose garments then
 * match nothing: inCapsule), the outfit (the requester's own) and the
 * posted garments (fewer than asked: the rows fall back to "No garment").
 */

/** The wardrobe a request addresses, authorized, and its capsule as asked (unchecked). */
export interface StylingScope {
  userId: number;
  /** The wardrobe's owner: the requester, or a grantor (authorizeWardrobe, view). */
  ownerId: number;
  shared: boolean;
  capsuleId?: number;
  /**
   * `?plan=`: the plan whose candidates join the strips (unchecked, read
   * by stripsReads). Only on the requester's own wardrobe: plans are never
   * shared, so a shared wardrobe's scope has none.
   */
  planId?: number;
}

/** Checks every request may ask of either statement. */
interface Checks {
  /** Whether the scope's capsule is the wardrobe's (CheckedReads.capsule). */
  checkCapsule?: boolean;
  /**
   * The requester's outfit (`?outfit=`, an edit's refused Save): only on
   * their own wardrobe, whose owner is then the requester.
   */
  outfitId?: number;
  /** The posted rows' garments: which of them the wardrobe owns. */
  heldIds?: readonly number[];
}

interface CheckedReads {
  /** Undefined when not asked; null when the capsule is not the wardrobe's. */
  capsule: CapsuleRef | null | undefined;
  /** Undefined when not asked or not the requester's. */
  outfit: SavedOutfit | undefined;
  held: RoledGarment[];
}

function checkColumns(scope: StylingScope, checks: Checks) {
  const { ownerId, capsuleId } = scope;
  const { outfitId, heldIds = [] } = checks;
  return {
    capsule:
      checks.checkCapsule && capsuleId !== undefined
        ? capsuleRefSql(capsuleId, ownerId)
        : undefined,
    outfit:
      outfitId === undefined ? undefined : savedOutfitSql(outfitId, ownerId),
    held: heldIds.length === 0 ? undefined : ownGarmentsSql(ownerId, heldIds),
  };
}

function readChecks(
  row: ScalarValues<ReturnType<typeof checkColumns>>,
): CheckedReads {
  return {
    capsule: row.capsule,
    outfit: row.outfit === undefined ? undefined : readSavedOutfit(row.outfit),
    held: row.held ? readGarments(row.held) : [],
  };
}

export interface StripsReads extends CheckedReads {
  /** The strips' windows, with the plan's candidates on them (`plan`). */
  windows: RoleWindow[];
  /** Undefined when no plan was asked; null when it is not the requester's. */
  plan: StyledPlan | null | undefined;
  /** The capsule menu (`menu`); empty otherwise. */
  capsules: CapsuleRef[];
  /** A shared wardrobe's owner by name (`menu`); undefined for one's own. */
  owner: string | undefined;
}

/**
 * The strips' windows (roleWindowsSql: they reach `chosen`, and with
 * `chosenOutfit` every garment of that outfit, the requester's, whose rows
 * the page opens on), the checks, and with `menu` what a full page shows
 * around the rows (the capsule menu, whose wardrobe a grantee browses).
 * With the scope's `planId`, the plan's name and candidates ride in the
 * same statement (styledPlanSql). One statement.
 */
export async function stripsReads(
  db: Db,
  scope: StylingScope,
  ask: Checks & {
    chosen: readonly Chosen[];
    chosenOutfit?: number;
    menu?: boolean;
  },
): Promise<StripsReads> {
  const { userId, ownerId, shared } = scope;
  const row = await selectScalars(db, {
    ...checkColumns(scope, ask),
    windows: roleWindowsSql(ownerId, {
      capsuleId: scope.capsuleId,
      chosen: ask.chosen,
      outfitId: ask.chosenOutfit,
    }),
    plan:
      scope.planId === undefined
        ? undefined
        : styledPlanSql(scope.planId, ownerId),
    capsules: ask.menu ? capsuleNamesSql(ownerId) : undefined,
    shares: ask.menu && shared ? sharedWardrobesSql(userId) : undefined,
  });
  const plan = row.plan === undefined ? undefined : readStyledPlan(row.plan);
  return {
    ...readChecks(row),
    windows: withCandidates(
      readRoleWindows(row.windows),
      plan?.candidates ?? [],
    ),
    plan,
    capsules: row.capsules ?? [],
    owner: row.shares
      ?.map(toSharedWardrobe)
      .find((share) => share.grantorId === ownerId)?.grantorName,
  };
}

export interface IdeaReads extends CheckedReads {
  /** Those of `lockIds` the generator may lock: the wardrobe's, in its closet. */
  lockable: PoolGarment[];
  /** The first idea with `locked` (of `lockable`) in it; undefined when none fits. */
  draw(locked: readonly PoolGarment[]): Promise<Idea<PoolGarment> | undefined>;
}

/**
 * What an idea is drawn from, with the checks and the garments that may
 * be locked, in one statement. One's own wardrobe: ideasFor's statement
 * (ideasColumns: the pool, saved outfits, clashes and the aimed day's
 * weather), answered by ideasFrom. A shared one: its closet alone
 * (browseIdea: no wash or away state, no rotation, none of the owner's
 * outfits, clashes or weather), and the locked garments without their
 * last-worn day, so a grantee's statement never reads the owner's wears.
 */
export async function ideaReads(
  deps: { db: Db; weather: WeatherService | undefined },
  scope: StylingScope,
  ask: Checks & {
    lockIds: readonly number[];
    aim: IdeasAim;
    today: IsoDate;
    seed: number;
    now: Date;
  },
): Promise<IdeaReads> {
  const { db } = deps;
  const { ownerId, shared, capsuleId } = scope;
  const { lockIds, today, seed, now } = ask;
  const checks = {
    ...checkColumns(scope, ask),
    lockable:
      lockIds.length === 0
        ? undefined
        : styledGarmentsSql(ownerId, lockIds, shared ? null : today),
  };
  if (shared) {
    const row = await selectScalars(db, {
      ...checks,
      closet: closetGarmentsSql(ownerId, capsuleId),
    });
    const closet = readCloset(row.closet);
    return {
      ...readChecks(row),
      lockable: readPool(row.lockable ?? []),
      draw: (locked) => Promise.resolve(browseIdea({ closet, locked, seed })),
    };
  }
  const input: IdeasInput = {
    today,
    ...ask.aim.planning,
    ...ask.aim.weatherAt,
    capsuleId,
    seed,
    offset: 0,
    limit: 1,
  };
  const row = await selectScalars(db, {
    ...checks,
    ...ideasColumns(deps, ownerId, input, now),
  });
  return {
    ...readChecks(row),
    lockable: readPool(row.lockable ?? []),
    draw: async (locked) =>
      (await ideasFrom(deps, { ...input, locked }, row, now)).ideas[0],
  };
}
