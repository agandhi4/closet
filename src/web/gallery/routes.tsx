import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { FEELINGS } from '../../weather/temperature';
import { sessionUserId } from '../auth/require-session';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import { capsuleNames } from '../capsules/queries';
import { HttpError } from '../errors';
import {
  type OutfitDestination,
  parseDestination,
} from '../outfits/destination';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { OccasionSchema, RowId } from '../schemas';
import { viewContext } from '../view-context';
import { nudgeTemperatureOffset } from '../weather/queries';
import { GarmentParams } from '../wardrobe/validation';
import { OutfitCountLink } from './goes-with';
import {
  dailySeed,
  goesWithCount,
  IDEAS_PAGE_SIZE,
  ideasFor,
  ideasScope,
  MAX_SEED,
  pickIdea,
} from './ideas';
import { IdeaCards, IdeasPage, type SeededState } from './ideas-page';
import { allowPair, avoidPair } from './queries';
import {
  ALREADY_SAVED_FLAG,
  type GalleryState,
  IDEAS_PATH,
  ideasUrl,
} from './urls';

/**
 * The outfit gallery (#9): the Outfits page's Ideas tab and its writes.
 * Private like outfits: the signed-in user's own garments, capsules and
 * outfits; `?ownerId=` is not read, and a capsule or garment that is not
 * theirs is a 404 like an unknown id.
 *
 * Validation, decided per parameter:
 * - `?for=` and `?occasion=` are navigation state: parseDestination, lenient
 *   (malformed is no destination: ideas for today, a pick just saves). A
 *   write's `for` is data it stores: a malformed one is a 400.
 * - `?capsule=` and `?with=` name data: not an id is a 400, not the user's
 *   own capsule (or closet garment) a 404, as the builder's `?capsule=`.
 * - `?seed=` and `?page=` are navigation state: anything malformed is the
 *   day's seed and page 1.
 * - `for=trip:ID` (#10, deprioritised) reads as no destination until
 *   OutfitDestination learns trips; then a pick adds to the trip here.
 */

/** Pages a gallery goes to: 50 pages of 6 is more than anyone swipes. */
const MAX_PAGE = 50;

const GalleryQuery = Type.Object({
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  capsule: Type.Optional(RowId),
  with: Type.Optional(RowId),
  seed: Type.Optional(Type.String()),
  page: Type.Optional(Type.String()),
});

// What every write posts back so its redirect lands on the same ideas.
const StateFields = {
  for: Type.Optional(Type.String({ pattern: '^day:\\d{4}-\\d{2}-\\d{2}$' })),
  occasion: Type.Optional(OccasionSchema),
  capsule: Type.Optional(RowId),
  with: Type.Optional(RowId),
  seed: Type.Optional(Type.String()),
};

/** The most garments a card holds: a template, a layer and a locked piece or two. */
const MAX_PICKED = 8;

const PickBody = Type.Object({
  garmentId: Type.Array(RowId, { minItems: 1, maxItems: MAX_PICKED }),
  ...StateFields,
});

const FeedbackBody = Type.Object({
  feeling: Type.Union(FEELINGS.map((feeling) => Type.Literal(feeling))),
  ...StateFields,
});

const PairBody = Type.Object({
  garmentId: Type.Array(RowId, { minItems: 2, maxItems: 2 }),
  ...StateFields,
});

function parseSeed(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
  const seed = Number(value);
  return seed <= MAX_SEED ? seed : undefined;
}

function parsePage(value: string | undefined): number {
  const page =
    value !== undefined && /^\d{1,3}$/.test(value) ? Number(value) : 1;
  return page >= 1 && page <= MAX_PAGE ? page : 1;
}

/**
 * A write's destination: its `for` must be a real day when posted (the
 * schema checked the shape; parseDestination the date).
 */
function postedDestination(body: {
  for?: string;
  occasion?: string;
}): OutfitDestination {
  const destination = parseDestination(body);
  if (body.for !== undefined && destination.kind === 'none') {
    throw new HttpError(400, 'body/for must be a real day');
  }
  return destination;
}

/** The gallery a write came from, for its redirect back. */
function postedState(
  body: Static<typeof PairBody> | Static<typeof FeedbackBody>,
): GalleryState {
  return {
    destination: postedDestination(body),
    capsuleId: body.capsule,
    withId: body.with,
    seed: parseSeed(body.seed),
  };
}

function garmentNotFound(): HttpError {
  return new HttpError(404, 'Garment not found');
}

export const galleryRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  /** The page's and the sentinel's shared reading of the query, and the ideas for it. */
  async function galleryFor(
    ownerId: number,
    query: Static<typeof GalleryQuery>,
  ) {
    const now = new Date();
    const today: IsoDate = todayIn(config.timeZone, now);
    const destination = parseDestination(query);
    const planning =
      destination.kind === 'day'
        ? { day: destination.day, occasion: destination.occasion }
        : { day: today, occasion: DEFAULT_OCCASION };
    const { capsule, styled } = await ideasScope(db, ownerId, {
      capsuleId: query.capsule,
      withId: query.with,
      today,
    });
    const state: SeededState = {
      destination,
      capsuleId: capsule?.id,
      withId: styled?.id,
      seed: parseSeed(query.seed) ?? dailySeed(today),
    };
    const page = parsePage(query.page);
    const started = performance.now();
    const result = await ideasFor(
      { db, weather },
      ownerId,
      {
        today,
        ...planning,
        capsuleId: capsule?.id,
        styled,
        seed: state.seed,
        offset: (page - 1) * IDEAS_PAGE_SIZE,
        limit: IDEAS_PAGE_SIZE,
      },
      now,
    );
    logger.debug(
      `Ideas for user ${ownerId}: ${result.ideas.length} on page ${page} (seed ${state.seed}, ${planning.day} ${planning.occasion}${capsule ? `, capsule ${capsule.id}` : ''}${styled ? `, with garment ${styled.id}` : ''}${result.weather ? ', weather' : ''}) in ${Math.round(performance.now() - started)} ms`,
    );
    return {
      ownerId,
      state,
      planning,
      capsule,
      styled,
      cards: { state, planning, ...result, page },
    };
  }

  app.get(
    IDEAS_PATH,
    { schema: { querystring: GalleryQuery } },
    async (request, reply) => {
      const gallery = await galleryFor(sessionUserId(request), request.query);
      const capsules = await capsuleNames(db, gallery.ownerId);
      return renderPage(
        reply,
        <IdeasPage
          ctx={viewContext(reply)}
          model={{
            state: gallery.state,
            planning: gallery.planning,
            capsule: gallery.capsule,
            capsules,
            styled: gallery.styled,
            cards: gallery.cards,
          }}
        />,
      );
    },
  );

  // The strip's sentinel (hx-trigger="intersect"): the next page of cards
  // and its own sentinel. Always a fragment.
  app.get(
    `${IDEAS_PATH}/more`,
    { schema: { querystring: GalleryQuery } },
    async (request, reply) => {
      const gallery = await galleryFor(sessionUserId(request), request.query);
      return renderFragment(reply, <IdeaCards model={gallery.cards} />);
    },
  );

  // A card's primary action (a native post): the idea becomes an outfit,
  // planned on the destination's day when there is one, in one transaction.
  app.post(
    `${IDEAS_PATH}/pick`,
    { schema: { body: PickBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const destination = postedDestination(request.body);
      const plan =
        destination.kind === 'day'
          ? { day: destination.day, occasion: destination.occasion }
          : undefined;
      const picked = await pickIdea(db, ownerId, {
        garmentIds: request.body.garmentId,
        plan,
      });
      if (picked === 'not-found') throw garmentNotFound();
      const garments = request.body.garmentId.join(', ');
      logger.info(
        picked.alreadySaved
          ? `Idea picked by user ${ownerId}: garments ${garments} already outfit ${picked.id}${plan ? `, ${picked.schedule} ${plan.day} (${plan.occasion})` : ''}; nothing created`
          : `Idea picked by user ${ownerId}: outfit ${picked.id} of garments ${garments}${plan ? `, planned ${plan.day} (${plan.occasion})` : ', saved'}`,
      );
      // A pick of an outfit that exists (a double tap, a retried post) is
      // a success too; the page it lands on says so.
      const flag = picked.alreadySaved ? `${ALREADY_SAVED_FLAG}=1` : '';
      return reply.redirect(
        plan
          ? `/calendar?week=${plan.day}${flag && `&${flag}`}`
          : `/outfits/${picked.id}${flag && `?${flag}`}`,
        303,
      );
    },
  );

  // "Too warm" / "too cold" on a card: the personal offset moves (the
  // weather's one writer), and the gallery comes back matched to it. Only
  // with the weather: the offset means nothing without it.
  app.post(
    `${IDEAS_PATH}/feedback`,
    { schema: { body: FeedbackBody } },
    async (request, reply) => {
      if (!weather) throw new HttpError(404, 'Weather is off');
      const ownerId = sessionUserId(request);
      const state = postedState(request.body);
      const offset = await nudgeTemperatureOffset(
        db,
        ownerId,
        request.body.feeling,
      );
      logger.info(
        `Temperature feedback from user ${ownerId} in the gallery: ${request.body.feeling}, offset now ${offset}`,
      );
      return reply.redirect(ideasUrl(state), 303);
    },
  );

  // "Clashes": the pair is never generated together again. htmx removes
  // the card (a 200 swapped as delete; a 204 would swap nothing); a plain
  // post comes back to the gallery.
  app.post(
    `${IDEAS_PATH}/avoid`,
    { schema: { body: PairBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const state = postedState(request.body);
      const [a, b] = request.body.garmentId;
      const outcome = await avoidPair(db, ownerId, a, b);
      if (outcome === 'not-found') throw garmentNotFound();
      logger.info(
        `Garments ${a} and ${b} ${outcome === 'added' ? 'avoided' : 'already avoided'} together by user ${ownerId}`,
      );
      if (request.headers['hx-request']) {
        return reply.type('text/html; charset=utf-8').send('');
      }
      return reply.redirect(ideasUrl(state), 303);
    },
  );

  // "Goes with my closet"'s count for a shopping list candidate (#18b): a
  // chip loaded when it scrolls into view, so the list's cost is what is
  // on screen, not every candidate of every item. Always a fragment. The
  // owner's own wishlist item, like the section on its page: anything else
  // (a closet garment, another's, a grantee's view) is a 404.
  app.get(
    '/wardrobe/:id/outfit-count',
    { schema: { params: GarmentParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const started = performance.now();
      const count = await goesWithCount(
        db,
        ownerId,
        id,
        todayIn(config.timeZone, new Date()),
      );
      if (!count) throw new HttpError(404, 'Not on your wishlist');
      logger.debug(
        `Outfit count for user ${ownerId}: wishlist item ${id} makes ${count.outfits}${count.capped ? '+' : ''} outfit(s) in ${Math.round(performance.now() - started)} ms`,
      );
      return renderFragment(
        reply,
        <OutfitCountLink garmentId={id} count={count} />,
      );
    },
  );

  // The garment page's undo ("Allow again", a native post): the first id is
  // the page's garment, where the answer goes back to.
  app.post(
    `${IDEAS_PATH}/allow`,
    { schema: { body: PairBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const [a, b] = request.body.garmentId;
      if (!(await allowPair(db, ownerId, a, b))) {
        throw new HttpError(404, 'No such pair');
      }
      logger.info(
        `Garments ${a} and ${b} allowed together again by user ${ownerId}`,
      );
      return reply.redirect(`/wardrobe/${a}`, 303);
    },
  );

  done();
};
