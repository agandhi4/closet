import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { FEELINGS } from '../../weather/temperature';
import { sessionUserId } from '../auth/require-session';
import { type IsoDate, todayIn } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import { parseDestination } from '../outfits/destination';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { DestinationFields, RowId } from '../schemas';
import { viewContext } from '../view-context';
import { nudgeTemperatureOffset } from '../weather/queries';
import { aimIdeas } from './aim';
import {
  dailySeed,
  IDEAS_PAGE_SIZE,
  ideasPage,
  type IdeasWeather,
  ideasScope,
  MAX_IDEAS_PAGE,
  parseSeed,
} from './ideas';
import { IdeaCards, IdeasPage, type SeededState } from './ideas-page';
import { pickTo, postedDestination } from './pick';
import { allowPair, avoidPair } from './queries';
import { type GalleryState, IDEAS_PATH, ideasUrl } from './urls';

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
 *   own capsule (or closet garment) a 404, as Styling's `?capsule=`.
 * - `?seed=` and `?page=` are navigation state: anything malformed is the
 *   day's seed and page 1.
 * - `for=trip:ID[:day]` (#10) names a trip: not the user's own a 404 like
 *   `?capsule=`; a day that is not one of its days is none (the trip's
 *   day then: today while it is on, else its first). Its ideas use the
 *   destination's forecast (none while the destination is not located),
 *   and a pick adds the outfit to the trip (pickForTrip), for the day and
 *   occasion when given.
 */

const GalleryQuery = Type.Object({
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  replace: Type.Optional(Type.String()),
  capsule: Type.Optional(RowId),
  with: Type.Optional(RowId),
  seed: Type.Optional(Type.String()),
  page: Type.Optional(Type.String()),
});

// What every write posts back so its redirect lands on the same ideas.
const StateFields = {
  ...DestinationFields,
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

function parsePage(value: string | undefined): number {
  const page =
    value !== undefined && /^\d{1,3}$/.test(value) ? Number(value) : 1;
  return page >= 1 && page <= MAX_IDEAS_PAGE ? page : 1;
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
    options: { capsuleMenu: boolean },
  ) {
    const now = new Date();
    const today: IsoDate = todayIn(config.timeZone, now);
    const [{ capsule, styled }, { destination, planning, trip, weatherAt }] =
      await Promise.all([
        ideasScope(db, ownerId, {
          capsuleId: query.capsule,
          withId: query.with,
          today,
        }),
        aimIdeas(db, ownerId, parseDestination(query), today),
      ]);
    const state: SeededState = {
      destination,
      capsuleId: capsule?.id,
      withId: styled?.id,
      seed: parseSeed(query.seed) ?? dailySeed(today),
    };
    const page = parsePage(query.page);
    const started = performance.now();
    const result = await ideasPage(
      { db, weather },
      ownerId,
      {
        today,
        ...planning,
        capsuleId: capsule?.id,
        locked: styled ? [styled] : [],
        ...weatherAt,
        seed: state.seed,
        page,
        pageSize: IDEAS_PAGE_SIZE,
        capsuleMenu: options.capsuleMenu,
      },
      now,
    );
    logger.debug(
      `Ideas for user ${ownerId}: ${result.ideas.length} on page ${page} (seed ${state.seed}, ${planning.day} ${planning.occasion}${trip ? `, trip ${trip.id}` : ''}${capsule ? `, capsule ${capsule.id}` : ''}${styled ? `, with garment ${styled.id}` : ''}${weatherNote(result.weather)}) in ${Math.round(performance.now() - started)} ms`,
    );
    return {
      state,
      planning,
      trip: trip && { id: trip.id, name: trip.name },
      capsule,
      capsules: result.capsules,
      styled,
      cards: { state, planning, ...result, page },
    };
  }

  app.get(
    IDEAS_PATH,
    { schema: { querystring: GalleryQuery } },
    async (request, reply) => {
      // The capsule menu rides in the ideas' own statement (#168).
      const gallery = await galleryFor(sessionUserId(request), request.query, {
        capsuleMenu: true,
      });
      return renderPage(
        reply,
        <IdeasPage
          ctx={viewContext(reply)}
          model={{
            state: gallery.state,
            planning: gallery.planning,
            trip: gallery.trip,
            capsule: gallery.capsule,
            capsules: gallery.capsules ?? [],
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
      const gallery = await galleryFor(sessionUserId(request), request.query, {
        capsuleMenu: false,
      });
      return renderFragment(reply, <IdeaCards model={gallery.cards} />);
    },
  );

  // A card's primary action (a native post): the idea becomes an outfit,
  // planned on the destination's day or added to its trip when there is
  // one, in one transaction; with `replace` (Today's Change, the plan
  // page's, #69) it takes that entry's place instead.
  app.post(
    `${IDEAS_PATH}/pick`,
    { schema: { body: PickBody } },
    async (request, reply) => {
      return pickTo(
        { db, logger },
        reply,
        sessionUserId(request),
        postedDestination(request.body),
        request.body.garmentId,
        { source: 'idea' },
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

/** The ideas log line's weather part: what the page was matched to. */
function weatherNote(weather: IdeasWeather | null): string {
  if (!weather) return '';
  return weather.typical ? ', typical weather' : ', weather';
}
