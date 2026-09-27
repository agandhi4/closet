import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import { type Static, Type } from '@sinclair/typebox';
import type { Idea } from '../../wardrobe/generator';
import { DEFAULT_OCCASION, type Occasion } from '../../wardrobe/occasions';
import { GARMENT_ROLES, type GarmentRole } from '../../wardrobe/properties';
import { sessionUserId } from '../auth/require-session';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import {
  type CapsuleRef,
  capsuleNames,
  findCapsule,
} from '../capsules/queries';
import { capsuleNotFound } from '../capsules/validation';
import { HttpError } from '../errors';
import { aimIdeas, type IdeasAim } from '../gallery/aim';
import {
  browseIdea,
  dailySeed,
  ideaName,
  ideasFor,
  parseSeed,
  shuffledSeed,
} from '../gallery/ideas';
import { pickTo, postedDestination } from '../gallery/pick';
import { type PoolGarment, styledGarments } from '../gallery/queries';
import {
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import { OUTFIT_NAME_MAX, updateOutfit } from '../outfits/queries';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import {
  DestinationFields,
  IsoDateSchema,
  OccasionSchema,
  RowId,
} from '../schemas';
import { safeReturnTo } from '../security/return-to';
import { authorizeWardrobe, sharedWardrobesOf } from '../sharing/access';
import { viewContext } from '../view-context';
import {
  MAX_ROWS,
  openingStates,
  type RoleWindow,
  type RowState,
  shuffledStates,
  stylingRows,
  topToToe,
  withEveryRole,
} from './rows';
import {
  ownGarments,
  type RoledGarment,
  roleGarmentsBefore,
  roleWindows,
  savedGarments,
} from './queries';
import { type StylingModel, StylingPage, StylingRows } from './styling-page';
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
 * - `?capsule=`, `?with=`, `?outfit=` and `?ownerId=` name data: not an id
 *   is a 400; a capsule outside the wardrobe, a garment not in its closet
 *   or another's outfit is a 404.
 * - The rows Shuffle and "Add row" post back (`role`, `garmentId`, `lock`,
 *   one of each per row) are the page's own: lists of unequal length are
 *   a 400, and a garment that is not the wardrobe's is dropped from its row.
 * - Save's post is data: malformed is a 400 and writes nothing; `for`
 *   must read back as posted (postedDestination).
 */

const RoleSchema = Type.Union(GARMENT_ROLES.map((role) => Type.Literal(role)));
const OwnerId = Type.Union([Type.Literal(''), RowId]);

const PageQuery = Type.Object({
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  replace: Type.Optional(Type.String()),
  capsule: Type.Optional(RowId),
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
  ownerId: Type.Optional(OwnerId),
});

const SaveBody = Type.Object({
  ...RowFields,
  ...DestinationFields,
  name: Type.Optional(Type.String({ maxLength: OUTFIT_NAME_MAX })),
  outfit: Type.Optional(RowId),
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
}

/** What the page was opened with (openedWith). */
interface Opened {
  saved?: { id: number; name: string | null; garments: RoledGarment[] };
  with?: RoledGarment;
}

/** "Style this"'s opening idea (styleThis); empty without `?with=`. */
interface StyledOpening {
  idea?: Idea<PoolGarment>;
  /** Shuffle's next seed. */
  seed?: number;
  /** Nothing fits around the garment: the page says so. */
  missed?: boolean;
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
}): StylingModel {
  const { wardrobe, aim, opened, styled, windows } = input;
  const states = openingStates(windows, {
    saved: opened.saved?.garments,
    with: opened.with,
    idea: styled.idea?.garments,
  });
  return {
    state: {
      destination: aim.destination,
      capsuleId: wardrobe.capsule?.id,
      outfitId: opened.saved?.id,
      ownerId: wardrobe.viewOwner,
      returnTo: input.returnTo,
    },
    destination: aim.destination,
    rows: stylingRows(states, windows, opened.saved?.garments ?? []),
    roles: rolesOf(windows),
    seed: styled.seed,
    notice: styled.missed ? 'no-idea' : undefined,
    capsule: wardrobe.capsule,
    capsules: input.capsules,
    outfit: opened.saved,
    trip: aim.trip,
    shared:
      input.owner === undefined
        ? undefined
        : { ownerId: wardrobe.ownerId, name: input.owner },
  };
}

/** The garments the opening rows hold: the strips' windows must reach them. */
function openingGarments(
  opened: Opened,
  idea: Idea<PoolGarment> | undefined,
): { id: number }[] {
  return [
    ...(opened.saved?.garments ?? []),
    ...(opened.with ? [opened.with] : []),
    ...(idea?.garments ?? []),
  ];
}

/** The debug line's account of what a page or a shuffle was over. */
function describeScope(wardrobe: Wardrobe, opened: Opened = {}): string {
  return [
    wardrobe.viewOwner === undefined
      ? 'own wardrobe'
      : `wardrobe ${wardrobe.ownerId} (shared)`,
    wardrobe.capsule && `capsule ${wardrobe.capsule.id}`,
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
   * requester, 404 otherwise), and its capsule when one is named (404
   * outside it).
   */
  async function scopeOf(
    userId: number,
    query: { ownerId?: number | ''; capsule?: number },
  ): Promise<Wardrobe> {
    const { access, viewOwner } = await authorizeWardrobe(
      db,
      userId,
      query.ownerId,
      'view',
      'Wardrobe not found',
    );
    const capsule =
      query.capsule === undefined
        ? undefined
        : await findCapsule(db, query.capsule, access.ownerId);
    if (query.capsule !== undefined && !capsule) throw capsuleNotFound();
    return { ownerId: access.ownerId, viewOwner, capsule };
  }

  /** Whose wardrobe the page browses, by name, for a grantee. */
  async function sharedName(userId: number, ownerId: number) {
    const shares = await sharedWardrobesOf(db, userId);
    return shares.find((share) => share.grantorId === ownerId)?.grantorName;
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
   * The first idea for the rows' locks: through ideasFor (the generator
   * fed from the owner's pool, saved outfits, clashes and the aimed day's
   * weather) on one's own wardrobe, browseIdea over a shared one.
   */
  async function shuffleIdea(
    userId: number,
    wardrobe: Wardrobe,
    input: {
      aim: IdeasAim;
      today: IsoDate;
      capsuleId?: number;
      lockedIds: number[];
      seed: number;
    },
  ): Promise<Idea<PoolGarment> | undefined> {
    const { today, capsuleId, lockedIds, seed } = input;
    if (wardrobe.viewOwner !== undefined) {
      return browseIdea(db, wardrobe.ownerId, {
        today,
        capsuleId,
        lockedIds,
        seed,
      });
    }
    const locked = await styledGarments(db, userId, lockedIds, today);
    const { ideas } = await ideasFor(
      { db, weather },
      userId,
      {
        today,
        ...input.aim.planning,
        ...input.aim.weatherAt,
        capsuleId,
        locked,
        seed,
        offset: 0,
        limit: 1,
      },
      new Date(),
    );
    return ideas[0];
  }

  /**
   * What the page was opened with, each the requester's to open: a saved
   * outfit (`?outfit=`, their own, never over a shared wardrobe: its
   * garments are theirs) and "Style this"'s garment (`?with=`, in the
   * wardrobe's closet). Either named and not found is a 404.
   */
  async function openedWith(
    userId: number,
    wardrobe: Wardrobe,
    query: { outfit?: number; with?: number; ownerId?: number | '' },
  ): Promise<Opened> {
    const [saved, styled] = await Promise.all([
      query.outfit === undefined || isOther(query.ownerId, userId)
        ? undefined
        : savedGarments(db, query.outfit, userId),
      query.with === undefined
        ? []
        : ownGarments(db, wardrobe.ownerId, [query.with]),
    ]);
    if (query.outfit !== undefined && !saved) {
      throw new HttpError(404, 'Outfit not found');
    }
    const garment = styled.find((g) => g.status === 'closet');
    if (query.with !== undefined && !garment) {
      throw new HttpError(404, 'Garment not found');
    }
    return { saved, with: garment };
  }

  /**
   * "Style this" opens on the day's first idea around the garment; the
   * page then carries the next seed for Shuffle. Nothing else reads the
   * day: the bare page's fresh stack stays byte-stable (page-cache.ts).
   */
  async function styleThis(
    userId: number,
    wardrobe: Wardrobe,
    input: { aim: IdeasAim; today: IsoDate; garment?: RoledGarment },
  ): Promise<StyledOpening> {
    if (!input.garment) return {};
    const seed = dailySeed(input.today);
    const idea = await shuffleIdea(userId, wardrobe, {
      aim: input.aim,
      today: input.today,
      capsuleId: wardrobe.capsule?.id,
      lockedIds: [input.garment.id],
      seed,
    });
    return { idea, seed: shuffledSeed(seed), missed: !idea };
  }

  app.get(
    STYLING_PATH,
    { schema: { querystring: PageQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const today = todayIn(config.timeZone, new Date());
      const wardrobe = await scopeOf(userId, query);
      const shared = wardrobe.viewOwner !== undefined;
      const [aim, opened] = await Promise.all([
        aimOf(userId, shared, query, today),
        openedWith(userId, wardrobe, query),
      ]);
      const styled = await styleThis(userId, wardrobe, {
        aim,
        today,
        garment: opened.with,
      });
      const [windows, capsules, owner] = await Promise.all([
        roleWindows(db, wardrobe.ownerId, {
          capsuleId: wardrobe.capsule?.id,
          selected: ids(openingGarments(opened, styled.idea)),
        }),
        capsuleNames(db, wardrobe.ownerId),
        shared ? sharedName(userId, wardrobe.ownerId) : undefined,
      ]);
      const model = pageModel({
        wardrobe,
        aim,
        opened,
        styled,
        windows,
        capsules,
        owner,
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

  /**
   * The rows a request posted back, checked against the wardrobe: a
   * garment that is not one of its owned garments, or not of its row's role
   * (recategorised meanwhile), leaves the row at "No garment", unlocked. An archived
   * garment an edited outfit still holds stays (a detached row).
   */
  async function checkedStates(
    ownerId: number,
    posted: RowState[],
  ): Promise<{ states: RowState[]; held: RoledGarment[] }> {
    const held = await ownGarments(
      db,
      ownerId,
      posted.flatMap((state) => state.garmentId ?? []),
    );
    const states = posted.map((state) => {
      if (state.garmentId === null) return state;
      const garment = held.find((g) => g.id === state.garmentId);
      // The lock was on that garment: gone, the row is free again.
      return garment?.role === state.role
        ? state
        : { ...state, garmentId: null, locked: false };
    });
    return { states, held };
  }

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
      ownerId: wardrobe.viewOwner,
    };
  }

  // Shuffle: the generator fills the unlocked rows; a GET, as it reads.
  app.get(
    STYLING_SHUFFLE_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const started = performance.now();
      const today = todayIn(config.timeZone, new Date());
      const wardrobe = await scopeOf(userId, query);
      const shared = wardrobe.viewOwner !== undefined;
      const [{ states, held }, aim] = await Promise.all([
        checkedStates(wardrobe.ownerId, postedStates(query)),
        aimOf(userId, shared, query, today),
      ]);
      const seed = parseSeed(query.seed) ?? dailySeed(today);
      const lockedIds = states.flatMap((s) =>
        s.locked && s.garmentId !== null ? [s.garmentId] : [],
      );
      const idea = await shuffleIdea(userId, wardrobe, {
        aim,
        today,
        capsuleId: wardrobe.capsule?.id,
        lockedIds,
        seed,
      });
      const windows = await roleWindows(db, wardrobe.ownerId, {
        capsuleId: wardrobe.capsule?.id,
        selected: [
          ...states.flatMap((s) => s.garmentId ?? []),
          ...ids(idea ? idea.garments : []),
        ],
      });
      const rows = withEveryRole(states, windows);
      logger.debug(
        `Styling shuffle for user ${userId} over ${describeScope(wardrobe)}: ${lockedIds.length} locked, seed ${seed}, ${idea ? `idea of garments ${ids(idea.garments).join(', ')}` : 'no idea fits'} in ${Math.round(performance.now() - started)} ms`,
      );
      return renderRows(reply, {
        states: idea ? shuffledStates(rows, idea.garments) : rows,
        windows,
        held,
        seed: shuffledSeed(seed),
        notice: idea ? undefined : 'no-idea',
        context: {
          state: postedState(query, wardrobe),
          viewOwner: wardrobe.viewOwner,
        },
      });
    },
  );

  // "Add row": the rows again, one more (empty) of the role asked for.
  app.get(
    STYLING_ROW_PATH,
    { schema: { querystring: RowsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { query } = request;
      const wardrobe = await scopeOf(userId, query);
      const { states, held } = await checkedStates(
        wardrobe.ownerId,
        postedStates(query),
      );
      if (query.add !== undefined && states.length < MAX_ROWS) {
        states.push({ role: query.add, garmentId: null, locked: false });
      }
      const windows = await roleWindows(db, wardrobe.ownerId, {
        capsuleId: wardrobe.capsule?.id,
        selected: states.flatMap((s) => s.garmentId ?? []),
      });
      return renderRows(reply, {
        states: topToToe(states),
        windows,
        held,
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
      const userId = sessionUserId(request);
      const { role, before, capsule, ownerId } = request.query;
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        userId,
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
            state: { capsuleId: capsule, ownerId: viewOwner },
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
  app.post(
    STYLING_PATH,
    { schema: { body: SaveBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { body } = request;
      const garmentIds = chosenIds(body.garmentId);
      if (garmentIds.length === 0) {
        throw new HttpError(400, 'Choose at least one garment to save');
      }
      const name = body.name?.trim() || undefined;
      const destination = postedDestination(body);
      if (body.outfit !== undefined) {
        return saveEdit(reply, userId, body.outfit, {
          garmentIds,
          name,
          destination,
          schedule: scheduled(body),
          returnTo: body.returnTo,
        });
      }
      const schedule = scheduled(body);
      const planned: OutfitDestination =
        destination.kind === 'none' && schedule
          ? { kind: 'day', ...schedule }
          : destination;
      return pickTo({ db, logger }, reply, userId, planned, garmentIds, {
        source: 'styling',
        name,
      });
    },
  );

  /**
   * A saved outfit changed in Styling: its slots replaced by the rows'
   * garments top to toe, its name (blank: named for its garments), and
   * planned on a day when asked, in one transaction (updateOutfit, which
   * also makes the week planner's entries of it the person's and prunes
   * the packed marks of garments it no longer holds). The garments must
   * all be the requester's own, in the closet or archived (an archived one
   * the outfit held stays); else a 404 and nothing is written. It changes
   * in place, so a trip or an entry to replace is a 400.
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
      throw new HttpError(404, 'Garment not found');
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
