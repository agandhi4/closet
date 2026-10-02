import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Static, Type } from '@sinclair/typebox';
import type { Idea } from '../../wardrobe/generator';
import { DEFAULT_OCCASION, type Occasion } from '../../wardrobe/occasions';
import { GARMENT_ROLES, type GarmentRole } from '../../wardrobe/properties';
import { sessionUserId } from '../auth/require-session';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import type { CapsuleRef } from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import { HttpError } from '../errors';
import { aimIdeas, type IdeasAim } from '../gallery/aim';
import { dailySeed, ideaName, parseSeed, shuffledSeed } from '../gallery/ideas';
import { pickTo, postedDestination } from '../gallery/pick';
import type { PoolGarment } from '../gallery/queries';
import {
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import {
  describeGone,
  garmentsGoneError,
  OutfitGarmentsGone,
} from '../outfits/gone-garments';
import { OUTFIT_NAME_MAX, updateOutfit } from '../outfits/queries';
import type { WebOptions } from '../plugin';
import { planNotFound } from '../plans/validation';
import { renderFragment, renderPage } from '../render';
import {
  DestinationFields,
  IsoDateSchema,
  OccasionSchema,
  RowId,
} from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { authorizeWardrobe } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  MAX_ROWS,
  openingStates,
  keepingCandidates,
  type RoleWindow,
  type RowState,
  shuffledStates,
  type StylingRow,
  stylingRows,
  topToToe,
  withEveryRole,
} from './rows';
import {
  type Chosen,
  ownGarments,
  type RoledGarment,
  roleGarmentsBefore,
  type SavedOutfit,
  type StyledPlan,
} from './queries';
import {
  ideaReads,
  type StripsReads,
  stripsReads,
  type StylingScope,
} from './reads';
import {
  type SaveDraft,
  type StylingModel,
  StylingPage,
  StylingRows,
} from './styling-page';
import { type RowContext, StripPage } from './styling-row';
import {
  STYLING_GARMENTS_PATH,
  STYLING_PATH,
  STYLING_ROW_PATH,
  STYLING_SHUFFLE_PATH,
  type StylingState,
} from './urls';

/**
 * Styling (#42): the outfit composer that replaced the builder. The page,
 * its strips' next pages, Shuffle, "Add row" and Save.
 *
 * Whose wardrobe: `?ownerId=` browses a wardrobe shared with the requester
 * (authorizeWardrobe, view: a stranger's is a 404), with its capsules; its
 * Shuffle sees only what the share shows (browseIdea). Nothing over a
 * shared wardrobe saves: outfits are private and hold only their owner's
 * garments, so Save takes the requester's own garments alone (a grantee
 * posting the owner's is a 404, nothing written). A saved outfit
 * (`?outfit=`) is the requester's own, and opens in their own wardrobe.
 *
 * Validation, decided per parameter:
 * - `?for=`, `?occasion=`, `?replace=`, `?seed=` and `?returnTo=` are
 *   navigation state: parseDestination and parseSeed fall back (no
 *   destination, the day's seed), returnTo goes through safeReturnTo. A
 *   `for=trip:ID` that is not the requester's trip is a 404 (aimIdeas).
 * - `?capsule=`, `?with=`, `?outfit=`, `?plan=` and `?ownerId=` name data:
 *   not an id is a 400; a capsule outside the wardrobe, a garment not in
 *   its closet, another's outfit or a plan that is not the requester's is
 *   a 404. `?plan=` (#273) is the requester's own plan only: over a shared
 *   wardrobe it is ignored, as plans are never shared.
 * - The rows Shuffle and "Add row" post back (`role`, `garmentId`, `lock`,
 *   one of each per row) are the page's own: lists of unequal length are
 *   a 400, and a garment that is not the wardrobe's is dropped from its row.
 * - Save's post is data: malformed is a 400 and writes nothing; `for`
 *   must read back as posted (postedDestination). A garment it cannot
 *   hold (archived for a new outfit, deleted, not the requester's) refuses
 *   the whole save (OutfitGarmentsGone, #219): the page again, its rows
 *   and sheet as posted, those rows back to "No garment" and the garments
 *   named, with the refusal's status (409, or 404 for one not theirs).
 */

const RoleSchema = Type.Union(GARMENT_ROLES.map((role) => Type.Literal(role)));
const OwnerId = Type.Union([Type.Literal(''), RowId]);

const PageQuery = Type.Object({
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  replace: Type.Optional(Type.String()),
  capsule: Type.Optional(RowId),
  plan: Type.Optional(RowId),
  with: Type.Optional(RowId),
  outfit: Type.Optional(RowId),
  ownerId: Type.Optional(OwnerId),
  returnTo: Type.Optional(Type.String()),
});

// The rows as the page posts them back (Shuffle, "Add row"): one role,
// garmentId and lock per row, in document order.
const RowFields = {
  role: Type.Optional(Type.Array(RoleSchema, { maxItems: MAX_ROWS })),
  garmentId: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), RowId]), { maxItems: MAX_ROWS }),
  ),
  lock: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), Type.Literal('1')]), {
      maxItems: MAX_ROWS,
    }),
  ),
};

const RowsQuery = Type.Object({
  ...PageQuery.properties,
  ...RowFields,
  seed: Type.Optional(Type.String()),
  // "Add row": the role of the row to add.
  add: Type.Optional(RoleSchema),
});

const GarmentsQuery = Type.Object({
  role: RoleSchema,
  before: RowId,
  capsule: Type.Optional(RowId),
  // Carried by the sentinel's link like the capsule, and unused: candidates
  // are on a strip's first window alone.
  plan: Type.Optional(RowId),
  ownerId: Type.Optional(OwnerId),
});

const SaveBody = Type.Object({
  ...RowFields,
  ...DestinationFields,
  name: Type.Optional(Type.String({ maxLength: OUTFIT_NAME_MAX })),
  outfit: Type.Optional(RowId),
  // The page's capsule and plan: read only to show the page again when Save is refused.
  capsule: Type.Optional(RowId),
  plan: Type.Optional(RowId),
  // The sheet's "Add to calendar" without a destination; '' when left empty.
  scheduleDate: Type.Optional(Type.Union([Type.Literal(''), IsoDateSchema])),
  scheduleOccasion: Type.Optional(OccasionSchema),
  returnTo: Type.Optional(Type.String()),
});

type RowsInput = Static<typeof RowsQuery>;

/** The rows a request posted back, as states; a 400 when the lists do not line up. */
function postedStates(query: RowsInput): RowState[] {
  const roles = query.role ?? [];
  const garmentIds = query.garmentId ?? [];
  const locks = query.lock ?? [];
  if (garmentIds.length !== roles.length || locks.length !== roles.length) {
    throw new HttpError(400, 'Each row needs a role, a garment id and a lock');
  }
  return roles.map((role, i) => ({
    role,
    garmentId: garmentIds[i] === '' ? null : garmentIds[i],
    locked: locks[i] === '1',
  }));
}

/**
 * Save's rows as states when the post carries the page's rows (a role and
 * a lock per garment id); undefined for a hand-made post of ids alone.
 */
function savedStates(body: Static<typeof SaveBody>): RowState[] | undefined {
  const { role, garmentId, lock } = body;
  if (
    !role ||
    role.length !== garmentId?.length ||
    role.length !== lock?.length
  ) {
    return undefined;
  }
  return postedStates({ role, garmentId, lock });
}

/** The posted garment ids, once each, blanks ("No garment") left out. */
function chosenIds(posted: readonly (number | '')[] | undefined): number[] {
  return [...new Set((posted ?? []).filter((id) => id !== ''))];
}

function ids(garments: readonly { id: number }[]): number[] {
  return garments.map((g) => g.id);
}

/** `?ownerId=` names a wardrobe other than the requester's own. */
function isOther(ownerId: number | '' | undefined, userId: number): boolean {
  return ownerId !== undefined && ownerId !== '' && ownerId !== userId;
}

/** Back, and where a saved edit goes: a same-site path only, else none. */
function returnToOf(value: string | undefined): string | undefined {
  return safeReturnTo(value, '') || undefined;
}

/** The wardrobe a Styling request addresses, resolved. */
interface Wardrobe {
  ownerId: number;
  /** A shared wardrobe's owner (links carry it); undefined for one's own. */
  viewOwner: number | undefined;
  capsule?: CapsuleRef;
  /** `?plan=`, as the reads found it: the requester's own. */
  plan?: { id: number; name: string };
}

/** A request's scope (reads.ts) with the owner its links carry. */
type Scope = StylingScope & Pick<Wardrobe, 'viewOwner'>;

/** The wardrobe once the reads checked its capsule. */
function wardrobeOf(
  scope: Scope,
  capsule: CapsuleRef | undefined,
  plan?: Wardrobe['plan'],
): Wardrobe {
  return {
    ownerId: scope.ownerId,
    viewOwner: scope.viewOwner,
    capsule,
    plan,
  };
}

/** What the page was opened with: a saved outfit (`?outfit=`), "Style this"'s garment (`?with=`). */
interface Opened {
  saved?: SavedOutfit;
  with?: { id: number; role: GarmentRole };
}

/** "Style this"'s opening idea (styledOpening); empty without `?with=`. */
interface StyledOpening {
  idea?: Idea<PoolGarment>;
  /** Shuffle's next seed. */
  seed?: number;
  /** Nothing fits around the garment: the page says so. */
  missed?: boolean;
}

/** What GET /styling read to open the page (plainOpening, styledOpening). */
interface Opening {
  wardrobe: Wardrobe;
  aim: IdeasAim;
  opened: Opened;
  styled: StyledOpening;
  reads: StripsReads;
}

/** The page's model from what the handler read. */
function pageModel(input: {
  wardrobe: Wardrobe;
  aim: IdeasAim;
  opened: Opened;
  styled: StyledOpening;
  windows: RoleWindow[];
  capsules: CapsuleRef[];
  /** The shared wardrobe's owner's name; undefined for one's own. */
  owner: string | undefined;
  returnTo: string | undefined;
  /** A refused Save: its rows as posted, instead of the opening ones. */
  refused?: RefusedSave;
}): StylingModel {
  const { wardrobe, aim, opened, styled, windows, refused } = input;
  return {
    state: {
      destination: aim.destination,
      capsuleId: wardrobe.capsule?.id,
      planId: wardrobe.plan?.id,
      outfitId: opened.saved?.id,
      ownerId: wardrobe.viewOwner,
      returnTo: input.returnTo,
    },
    destination: aim.destination,
    rows: modelRows(input),
    roles: rolesOf(windows),
    seed: styled.seed,
    notice: styled.missed ? 'no-idea' : undefined,
    capsule: wardrobe.capsule,
    plan: wardrobe.plan,
    capsules: input.capsules,
    outfit: opened.saved,
    trip: aim.trip,
    shared:
      input.owner === undefined
        ? undefined
        : { ownerId: wardrobe.ownerId, name: input.owner },
    refusal: refused && {
      message: refused.error.message,
      draft: refused.draft,
      toBuy: refused.error.gone.flatMap((g) =>
        g.garment?.status === 'wishlist'
          ? [{ id: g.id, name: g.garment.name }]
          : [],
      ),
    },
  };
}

/** The page's rows: a refused Save's as posted, else the opening ones. */
function modelRows(input: {
  opened: Opened;
  styled: StyledOpening;
  windows: RoleWindow[];
  refused?: RefusedSave;
}): StylingRow[] {
  const { opened, windows, refused } = input;
  if (refused) {
    const states = withEveryRole(refused.states, windows);
    return stylingRows(states, windows, refused.held);
  }
  const states = openingStates(windows, {
    saved: opened.saved?.garments,
    with: opened.with,
    idea: input.styled.idea?.garments,
  });
  return stylingRows(states, windows, opened.saved?.garments ?? []);
}

/** A Save refused for its garments (OutfitGarmentsGone), as the page shows it again. */
interface RefusedSave {
  error: OutfitGarmentsGone;
  /** The posted rows, those holding a gone garment back to "No garment". */
  states: RowState[];
  /** The posted garments the requester still owns (an archived one an edit keeps). */
  held: RoledGarment[];
  /** The sheet as it was posted. */
  draft: SaveDraft;
}

/** A garment in its role's row, as the strips' windows reach it. */
function chosen(garment: { id: number; role: GarmentRole }): Chosen {
  return { role: garment.role, garmentId: garment.id };
}

/** The rows' garments, each in its row's role (roleWindowsSql). */
function chosenOf(states: readonly RowState[]): Chosen[] {
  return states.flatMap(({ role, garmentId }) =>
    garmentId === null ? [] : [{ role, garmentId }],
  );
}

/** The garments the rows hold. */
function heldIdsOf(states: readonly RowState[]): number[] {
  return states.flatMap((state) => state.garmentId ?? []);
}

/**
 * The posted rows, checked against `held` (the wardrobe's owned garments
 * among theirs): a garment that is not one of its owned garments, or not
 * of its row's role (recategorised meanwhile), leaves the row at "No
 * garment", unlocked. An archived garment an edited outfit still holds
 * stays (a detached row).
 */
function checkedStates(
  posted: readonly RowState[],
  held: readonly RoledGarment[],
): RowState[] {
  return posted.map((state) => {
    if (state.garmentId === null) return state;
    const garment = held.find((g) => g.id === state.garmentId);
    // The lock was on that garment: gone, the row is free again.
    return garment?.role === state.role
      ? state
      : { ...state, garmentId: null, locked: false };
  });
}

/** The capsule a request named, as the reads found it: a 404 outside the wardrobe. */
function checkedCapsule(
  found: CapsuleRef | null | undefined,
): CapsuleRef | undefined {
  if (found === null) throw capsuleNotFound();
  return found;
}

/**
 * The plan a request named (`asked`), as the reads found it: a 404 unless
 * the requester's. `reads.plan` is undefined when none was asked, which
 * includes a shared wardrobe, whose scope drops `?plan=`.
 */
function checkedPlan(
  asked: number | undefined,
  found: StyledPlan | null | undefined,
): Wardrobe['plan'] {
  if (found === null) throw planNotFound();
  return asked === undefined || !found
    ? undefined
    : { id: asked, name: found.name };
}

/** The outfit a request named (`asked`), as the reads found it: a 404 unless the requester's. */
function checkedOutfit(
  asked: number | undefined,
  found: SavedOutfit | undefined,
): SavedOutfit | undefined {
  if (asked !== undefined && !found) {
    throw new HttpError(404, 'Outfit not found');
  }
  return found;
}

/** A settled promise's value; its refusal, thrown. */
function valueOf<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** The debug line's account of what a page or a shuffle was over. */
function describeScope(wardrobe: Wardrobe, opened: Opened = {}): string {
  return [
    wardrobe.viewOwner === undefined
      ? 'own wardrobe'
      : `wardrobe ${wardrobe.ownerId} (shared)`,
    wardrobe.capsule && `capsule ${wardrobe.capsule.id}`,
    wardrobe.plan && `plan ${wardrobe.plan.id}`,
    opened.saved && `outfit ${opened.saved.id}`,
    opened.with && `with garment ${opened.with.id}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The roles the wardrobe has garments of, top to toe: "Add row"'s choices. */
function rolesOf(windows: readonly RoleWindow[]): GarmentRole[] {
  return topToToe(windows).map((w) => w.role);
}

interface Plan {
  day: IsoDate;
  occasion: Occasion;
}

/** The sheet's "Add to calendar" (no destination): a day, all day without an occasion. */
function scheduled(body: {
  scheduleDate?: IsoDate;
  scheduleOccasion?: Occasion;
}): Plan | undefined {
  return body.scheduleDate
    ? {
        day: body.scheduleDate,
        occasion: body.scheduleOccasion ?? DEFAULT_OCCASION,
      }
    : undefined;
}

export const stylingRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  /**
   * The wardrobe a request addresses (its own, or one shared with the
   * requester, 404 otherwise), with the capsule it names: the reads check
   * that (reads.ts; a 404 outside it, checkedCapsule).
   */
  async function scopeOf(
    request: FastifyRequest,
    query: { ownerId?: number | ''; capsule?: number; plan?: number },
  ): Promise<Scope> {
    const { access, viewOwner } = await authorizeWardrobe(
      db,
      request,
      query.ownerId,
      'view',
      'Wardrobe not found',
    );
    return {
      userId: sessionUserId(request),
      ownerId: access.ownerId,
      shared: viewOwner !== undefined,
      viewOwner,
      capsuleId: query.capsule,
      // Plans are never shared: a grantee's `?plan=` is ignored.
      planId: viewOwner === undefined ? query.plan : undefined,
    };
  }

  /**
   * Where Shuffle's ideas are aimed: the page's `?for=` (its day's weather
   * and occasion, a trip's destination) on one's own wardrobe; over a
   * shared one, nowhere (browseIdea reads none of the owner's days).
   */
  async function aimOf(
    userId: number,
    shared: boolean,
    query: { for?: string; occasion?: string; replace?: string },
    today: IsoDate,
  ): Promise<IdeasAim> {
    const none: OutfitDestination = { kind: 'none' };
    return aimIdeas(db, userId, shared ? none : parseDestination(query), today);
  }

  /**
   * The page without "Style this": the fresh stack, or a saved outfit's
   * rows (`?outfit=`, the requester's own, never opened over a shared
   * wardrobe), in one statement beside the aim (a trip's lookup): the
   * windows reach the outfit's garments through its id. The capsule is
   * refused before the trip or the outfit, as it always was.
   */
  async function plainOpening(
    scope: Scope,
    query: Static<typeof PageQuery>,
    today: IsoDate,
    outfitId: number | undefined,
  ): Promise<Opening> {
    const [aimed, read] = await Promise.allSettled([
      aimOf(scope.userId, scope.shared, query, today),
      stripsReads(db, scope, {
        checkCapsule: true,
        outfitId,
        chosen: [],
        chosenOutfit: outfitId,
        menu: true,
      }),
    ]);
    const reads = valueOf(read);
    const capsule = checkedCapsule(reads.capsule);
    const plan = checkedPlan(scope.planId, reads.plan);
    const aim = valueOf(aimed);
    const saved = checkedOutfit(query.outfit, reads.outfit);
    return {
      wardrobe: wardrobeOf(scope, capsule, plan),
      aim,
      opened: { saved },
      styled: {},
      reads,
    };
  }

  /**
   * "Style this" (`?with=`, a closet garment of the wardrobe: else a 404)
   * opens on the day's first idea around the garment, locked; the page
   * then carries the next seed for Shuffle. Nothing else reads the day:
   * the bare page's fresh stack stays byte-stable (page-cache.ts). The
   * garment, the outfit and the capsule are checked in the idea's
   * statement (ideaReads); then the windows reach the idea (stripsReads).
   */
  async function styledOpening(
    scope: Scope,
    query: Static<typeof PageQuery>,
    today: IsoDate,
    outfitId: number | undefined,
    withId: number,
  ): Promise<Opening> {
    const aim = await aimOf(scope.userId, scope.shared, query, today);
    const seed = dailySeed(today);
    const read = await ideaReads({ db, weather }, scope, {
      checkCapsule: true,
      outfitId,
      lockIds: [withId],
      aim,
      today,
      seed,
      now: new Date(),
    });
    const capsule = checkedCapsule(read.capsule);
    const saved = checkedOutfit(query.outfit, read.outfit);
    const [garment] = read.lockable;
    if (!garment) throw new HttpError(404, 'Garment not found');
    const idea = await read.draw([garment]);
    const opened: Opened = { saved, with: garment };
    const reads = await stripsReads(db, scope, {
      chosen: [
        ...(saved?.garments ?? []),
        garment,
        ...(idea?.garments ?? []),
      ].map(chosen),
      menu: true,
    });
    return {
      wardrobe: wardrobeOf(
        scope,
        capsule,
        checkedPlan(scope.planId, reads.plan),
      ),
      aim,
      opened,
      styled: { idea, seed: shuffledSeed(seed), missed: !idea },
      reads,
    };
  }

  app.get(
    STYLING_PATH,
    { schema: { querystring: PageQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const today = todayIn(config.timeZone, new Date());
      const scope = await scopeOf(request, query);
      // A saved outfit is the requester's: over a shared wardrobe, a 404.
      const outfitId = isOther(query.ownerId, userId)
        ? undefined
        : query.outfit;
      const { wardrobe, aim, opened, styled, reads } =
        query.with === undefined
          ? await plainOpening(scope, query, today, outfitId)
          : await styledOpening(scope, query, today, outfitId, query.with);
      const model = pageModel({
        wardrobe,
        aim,
        opened,
        styled,
        windows: reads.windows,
        capsules: reads.capsules,
        owner: reads.owner,
        returnTo: returnToOf(query.returnTo),
      });
      logger.debug(
        `Styling for user ${userId}: ${model.rows.length} row(s), ${describeScope(wardrobe, opened)}${styled.missed ? ', no idea fits' : ''}`,
      );
      return renderPage(
        reply,
        <StylingPage ctx={viewContext(reply)} model={model} />,
      );
    },
  );

  /** Shuffle and "Add row" answer the rows alone, with what the page carries on. */
  function renderRows(
    reply: FastifyReply,
    input: {
      states: RowState[];
      windows: RoleWindow[];
      held: RoledGarment[];
      seed?: number;
      notice?: 'no-idea';
      context: RowContext;
    },
  ) {
    return renderFragment(
      reply,
      <StylingRows
        model={{
          rows: stylingRows(
            withEveryRole(input.states, input.windows),
            input.windows,
            input.held,
          ),
          seed: input.seed,
          notice: input.notice,
        }}
        context={input.context}
      />,
    );
  }

  /** The state a fragment's links carry on (the sentinel's), from a posted query. */
  function postedState(query: RowsInput, wardrobe: Wardrobe): StylingState {
    return {
      destination: parseDestination(query),
      capsuleId: wardrobe.capsule?.id,
      planId: wardrobe.plan?.id,
      ownerId: wardrobe.viewOwner,
    };
  }

  // Shuffle: the generator fills the unlocked rows; a GET, as it reads. The
  // posted rows are checked in the idea's statement (ideaReads), then the
  // windows reach the idea (stripsReads).
  app.get(
    STYLING_SHUFFLE_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const started = performance.now();
      const today = todayIn(config.timeZone, new Date());
      const scope = await scopeOf(request, query);
      const posted = postedStates(query);
      const aim = await aimOf(userId, scope.shared, query, today);
      const seed = parseSeed(query.seed) ?? dailySeed(today);
      const read = await ideaReads({ db, weather }, scope, {
        checkCapsule: true,
        heldIds: heldIdsOf(posted),
        lockIds: heldIdsOf(posted.filter((state) => state.locked)),
        aim,
        today,
        seed,
        now: new Date(),
      });
      const capsule = checkedCapsule(read.capsule);
      const states = checkedStates(posted, read.held);
      const lockedIds = states.flatMap((s) =>
        s.locked && s.garmentId !== null ? [s.garmentId] : [],
      );
      const idea = await read.draw(
        read.lockable.filter((g) => lockedIds.includes(g.id)),
      );
      // The ideas draw from the closet alone: a candidate is never drawn,
      // and a row posted on one stays as it is (never in an idea's rows).
      const strips = await stripsReads(db, scope, {
        chosen: [...chosenOf(states), ...(idea?.garments ?? []).map(chosen)],
      });
      const { windows } = strips;
      const wardrobe = wardrobeOf(
        scope,
        capsule,
        checkedPlan(scope.planId, strips.plan),
      );
      const rows = withEveryRole(
        keepingCandidates(posted, states, strips.plan?.candidates ?? []),
        windows,
      );
      logger.debug(
        `Styling shuffle for user ${userId} over ${describeScope(wardrobe)}: ${lockedIds.length} locked, seed ${seed}, ${idea ? `idea of garments ${ids(idea.garments).join(', ')}` : 'no idea fits'} in ${Math.round(performance.now() - started)} ms`,
      );
      return renderRows(reply, {
        states: idea ? shuffledStates(rows, idea.garments) : rows,
        windows,
        held: read.held,
        seed: shuffledSeed(seed),
        notice: idea ? undefined : 'no-idea',
        context: {
          state: postedState(query, wardrobe),
          viewOwner: wardrobe.viewOwner,
        },
      });
    },
  );

  // "Add row": the rows again, one more (empty) of the role asked for. One
  // statement: the windows reach each posted garment in its row's role,
  // which is what checkedStates keeps.
  app.get(
    STYLING_ROW_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const { query } = request;
      const scope = await scopeOf(request, query);
      const posted = postedStates(query);
      const reads = await stripsReads(db, scope, {
        checkCapsule: true,
        heldIds: heldIdsOf(posted),
        chosen: chosenOf(posted),
      });
      const wardrobe = wardrobeOf(
        scope,
        checkedCapsule(reads.capsule),
        checkedPlan(scope.planId, reads.plan),
      );
      const states = keepingCandidates(
        posted,
        checkedStates(posted, reads.held),
        reads.plan?.candidates ?? [],
      );
      if (query.add !== undefined && states.length < MAX_ROWS) {
        states.push({ role: query.add, garmentId: null, locked: false });
      }
      return renderRows(reply, {
        states: topToToe(states),
        windows: reads.windows,
        held: reads.held,
        seed: parseSeed(query.seed),
        context: {
          state: postedState(query, wardrobe),
          viewOwner: wardrobe.viewOwner,
        },
      });
    },
  );

  // A strip's next page (its sentinel). Always a fragment. The capsule
  // needs no lookup here: inCapsule matches none of the wardrobe's
  // garments for a capsule of another (CLAUDE.md, Gotchas).
  app.get(
    STYLING_GARMENTS_PATH,
    { schema: { querystring: GarmentsQuery } },
    async (request, reply) => {
      const { role, before, capsule, plan, ownerId } = request.query;
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        request,
        ownerId,
        'view',
        'Wardrobe not found',
      );
      const page = await roleGarmentsBefore(db, access.ownerId, role, {
        capsuleId: capsule,
        before,
      });
      return renderFragment(
        reply,
        <StripPage
          role={role}
          garments={page.garments}
          more={page.more}
          context={{
            state: {
              capsuleId: capsule,
              planId: viewOwner === undefined ? plan : undefined,
              ownerId: viewOwner,
            },
            viewOwner,
          }}
        />,
      );
    },
  );

  // Save (the sheet's native post). A new outfit goes where the page is
  // going, through the gallery's pick (pickTo: planned, added to a trip,
  // or in an entry's place, once however often it is tapped); a saved one
  // (`outfit`) is updated through the outfit writer, its slots replaced.
  // Refused for a garment it cannot hold: the page again (refusedPage).
  app.post(
    STYLING_PATH,
    { schema: { body: SaveBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { body } = request;
      try {
        return await save(reply, userId, body);
      } catch (error) {
        const states = savedStates(body);
        if (!(error instanceof OutfitGarmentsGone) || !states) throw error;
        return refusedPage(request, reply, body, { error, states });
      }
    },
  );

  async function save(
    reply: FastifyReply,
    userId: number,
    body: Static<typeof SaveBody>,
  ) {
    const garmentIds = chosenIds(body.garmentId);
    if (garmentIds.length === 0) {
      throw new HttpError(400, 'Choose at least one garment to save');
    }
    const name = body.name?.trim() || undefined;
    const destination = postedDestination(body);
    const schedule = scheduled(body);
    if (body.outfit !== undefined) {
      return saveEdit(reply, userId, body.outfit, {
        garmentIds,
        name,
        destination,
        schedule,
        returnTo: body.returnTo,
      });
    }
    const planned: OutfitDestination =
      destination.kind === 'none' && schedule
        ? { kind: 'day', ...schedule }
        : destination;
    return pickTo({ db, logger }, reply, userId, planned, garmentIds, {
      source: 'styling',
      name,
    });
  }

  /**
   * A refused Save's answer: Styling as it was posted (its destination,
   * capsule, outfit and sheet), the rows holding a gone garment back to
   * "No garment", and the refusal's words above them, with its status.
   * Always the requester's own wardrobe: Save takes nothing else, so a
   * garment of another's is cleared like a deleted one and never shown.
   */
  async function refusedPage(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Static<typeof SaveBody>,
    refused: Pick<RefusedSave, 'error' | 'states'>,
  ) {
    const userId = sessionUserId(request);
    logger.info(
      `Styling save by user ${userId} refused (${refused.error.statusCode}): garments ${describeGone(refused.error.gone)}${body.outfit === undefined ? '' : ` for outfit ${body.outfit}`}; the page again`,
    );
    const today = todayIn(config.timeZone, new Date());
    const gone = new Set(refused.error.gone.map((g) => g.id));
    const cleared = refused.states.map((state) =>
      state.garmentId !== null && gone.has(state.garmentId)
        ? { ...state, garmentId: null, locked: false }
        : state,
    );
    // One statement beside the aim, as the page without "Style this" reads
    // (plainOpening); the windows reach the rows, not the outfit's garments.
    const scope: Scope = {
      userId,
      ownerId: userId,
      shared: false,
      viewOwner: undefined,
      capsuleId: body.capsule,
      planId: body.plan,
    };
    const [aimed, read] = await Promise.allSettled([
      aimIdeas(db, userId, postedDestination(body), today),
      stripsReads(db, scope, {
        checkCapsule: true,
        outfitId: body.outfit,
        heldIds: heldIdsOf(cleared),
        chosen: chosenOf(cleared),
        menu: true,
      }),
    ]);
    const reads = valueOf(read);
    const capsule = checkedCapsule(reads.capsule);
    const plan = checkedPlan(body.plan, reads.plan);
    const aim = valueOf(aimed);
    const saved = checkedOutfit(body.outfit, reads.outfit);
    const model = pageModel({
      wardrobe: wardrobeOf(scope, capsule, plan),
      aim,
      opened: { saved },
      styled: {},
      windows: reads.windows,
      capsules: reads.capsules,
      owner: undefined,
      returnTo: returnToOf(body.returnTo),
      refused: {
        error: refused.error,
        states: checkedStates(cleared, reads.held),
        held: reads.held,
        draft: {
          name: body.name,
          scheduleDate: body.scheduleDate || undefined,
          scheduleOccasion: body.scheduleOccasion,
        },
      },
    });
    return renderPage(
      reply,
      <StylingPage ctx={viewContext(reply)} model={model} />,
      { status: refused.error.statusCode },
    );
  }

  /**
   * A saved outfit changed in Styling: its slots replaced by the rows'
   * garments top to toe, its name (blank: named for its garments), and
   * planned on a day when asked, in one transaction (updateOutfit, which
   * also makes the week planner's entries of it the person's and prunes
   * the packed marks of garments it no longer holds). The garments must
   * all be the requester's own, in the closet or archived (an archived one
   * the outfit held stays); else OutfitGarmentsGone and nothing is written
   * (also when one goes between this check and the write: updateOutfit
   * refuses it too). It changes in place, so a trip or an entry to replace
   * is a 400.
   */
  async function saveEdit(
    reply: FastifyReply,
    userId: number,
    outfitId: number,
    input: {
      garmentIds: number[];
      name: string | undefined;
      destination: OutfitDestination;
      schedule: Plan | undefined;
      returnTo: string | undefined;
    },
  ) {
    const { destination } = input;
    if (
      destination.kind === 'trip' ||
      (destination.kind === 'day' && destination.replace !== undefined)
    ) {
      throw new HttpError(
        400,
        'A saved outfit changes in place: plan it on a day only',
      );
    }
    const plan =
      destination.kind === 'day'
        ? { day: destination.day, occasion: destination.occasion }
        : input.schedule;
    const garments = topToToe(await ownGarments(db, userId, input.garmentIds));
    if (garments.length !== input.garmentIds.length) {
      throw await garmentsGoneError(db, userId, input.garmentIds, 'owned');
    }
    const result = await updateOutfit(db, outfitId, userId, {
      name: input.name ?? ideaName(garments),
      slots: garments.map((g) => ({ category: g.category, garmentId: g.id })),
      plan,
    });
    if (result === 'not-found') throw new HttpError(404, 'Outfit not found');
    const planned = plan
      ? `, ${result.schedule} ${plan.day} (${plan.occasion})`
      : '';
    const claimed = result.entriesClaimed
      ? `, ${result.entriesClaimed} planned entry(ies) now the user's`
      : '';
    logger.info(
      `Outfit ${outfitId} changed in Styling by user ${userId}: garments ${ids(garments).join(', ')}${planned}${claimed}`,
    );
    return reply.redirect(
      safeReturnTo(input.returnTo, `/outfits/${outfitId}`),
      303,
    );
  }

  done();
};
