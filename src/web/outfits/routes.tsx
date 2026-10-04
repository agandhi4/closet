import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { type Static, Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { parseIsoDate, todayIn } from '../calendar/calendar-date';
import { pickDestination } from '../calendar/day-choice';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { navigateTo, renderPage } from '../render';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { IsoDateSchema, OccasionSchema, RowId } from '../schemas';
import { ALREADY_SAVED_FLAG } from '../gallery/urls';
import { groupLooks, looksOfShownPlan, type ShownLooks } from '../plans/looks';
import { stylingUrl } from '../styling/urls';
import { viewContext } from '../view-context';
import { type OutfitDestination, parseDestination } from './destination';
import { OutfitsPage } from './list-page';
import { outfitContext, savedContext } from './page-context';
import {
  createOutfit,
  deleteOutfit,
  OUTFIT_NAME_MAX,
  OUTFIT_NOTES_MAX,
  type OutfitInput,
  type SaveResult,
  updateOutfit,
} from './queries';
import { OutfitPage } from './show-page';

/**
 * Validation, decided per route:
 * - The builder's old addresses (`/outfits/new`, `/outfits/:id/edit`) only
 *   redirect into Styling, carrying what they meant: navigation state, so
 *   anything malformed is dropped rather than refused (`?for=` through
 *   parseDestination, `?scheduleDate=` from calendar pages cached before
 *   #13 through parseIsoDate, `?capsule=` and `?returnTo=` passed on for
 *   Styling to judge).
 * - The outfit form's post (POST /outfits, /outfits/:id: pages the
 *   installed app cached before Styling, and the specs' fixtures) is data
 *   the write stores: anything malformed is a 400 and writes nothing. An
 *   empty date input posts '' (no schedule); no occasion (a form cached
 *   before #13) is all day.
 * - GET /outfits reads ?for=, ?occasion= and ?replace= as navigation state
 *   (parseDestination, as the plan page does): no day is the plain grid, an
 *   unknown occasion all day, and a `replace` that is not the user's
 *   unworn entry there picks one more outfit. POST /calendar checks again.
 */

const OutfitParams = Type.Object({ id: RowId });

/** Rows in one outfit: position is a smallint, and no form needs more. */
const MAX_ROWS = 100;

// What an outfit row's category may be.
const Category = Type.String({ minLength: 1, maxLength: 255, pattern: '\\S' });

// A date input left empty posts ''.
const OptionalDay = Type.Union([Type.Literal(''), IsoDateSchema]);

// The builder's links: the calendar's plan page (`?for=`), calendar pages
// cached before #13 (`?scheduleDate=`), a capsule's "Build an outfit", and
// the edit links (`?returnTo=/calendar&returnToWeek=`).
const BuilderLinkQuery = Type.Object({
  returnTo: Type.Optional(Type.String()),
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  scheduleDate: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(Type.String()),
  capsule: Type.Optional(Type.String()),
});

// The Saved tab picking for a day (`?for=day:D&occasion=O[&replace=E]`,
// R5): navigation state, read by parseDestination (anything malformed is
// the plain grid, a trip too: trips add outfits on their own page).
const DestinationQuery = Type.Object({
  for: Type.Optional(Type.String()),
  occasion: Type.Optional(Type.String()),
  replace: Type.Optional(Type.String()),
});

// The gallery's pick lands here with `alreadySaved=1` when the outfit
// existed (a one-shot flag: anything else is no toast).
const FlagQuery = Type.Object({
  alreadySaved: Type.Optional(Type.String()),
});

// The form posts one category + garmentId pair per row, in row order (a
// single row arrives as scalars; ajv's coerceTypes: 'array' makes them
// one-element arrays). garmentId '' is a row without a garment. Absent
// fields: an update leaves name and notes as they are; no rows is an empty
// outfit.
const OutfitBody = Type.Object({
  name: Type.Optional(Type.String({ maxLength: OUTFIT_NAME_MAX })),
  notes: Type.Optional(Type.String({ maxLength: OUTFIT_NOTES_MAX })),
  category: Type.Optional(Type.Array(Category, { maxItems: MAX_ROWS })),
  garmentId: Type.Optional(
    Type.Array(Type.Union([Type.Literal(''), RowId]), { maxItems: MAX_ROWS }),
  ),
  scheduleDate: Type.Optional(OptionalDay),
  scheduleOccasion: Type.Optional(OccasionSchema),
  returnTo: Type.Optional(Type.String()),
  returnToWeek: Type.Optional(OptionalDay),
});

type OutfitForm = Static<typeof OutfitBody>;

/** A text field as stored: trimmed, and null when blank; undefined when not posted. */
function textField(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value.trim() || null;
}

function outfitInput(body: OutfitForm): OutfitInput {
  const categories = body.category ?? [];
  const garmentIds = body.garmentId ?? [];
  if (categories.length !== garmentIds.length) {
    throw new HttpError(
      400,
      'Each outfit row needs a category and a garment id (empty for none)',
    );
  }
  return {
    name: textField(body.name),
    notes: textField(body.notes),
    slots: categories.map((category, i) => ({
      category,
      garmentId: garmentIds[i] === '' ? null : garmentIds[i],
    })),
    plan: body.scheduleDate
      ? {
          day: body.scheduleDate,
          occasion: body.scheduleOccasion ?? DEFAULT_OCCASION,
        }
      : undefined,
  };
}

/**
 * Where an old builder link meant a new outfit to go: `?for=`, else a
 * `?scheduleDate=` from a calendar page cached before #13 (all day).
 */
function linkedDestination(
  query: Static<typeof BuilderLinkQuery>,
): OutfitDestination {
  const destination = parseDestination(query);
  if (destination.kind !== 'none') return destination;
  const day = parseIsoDate(query.scheduleDate);
  return day
    ? { kind: 'day', day, occasion: DEFAULT_OCCASION }
    : { kind: 'none' };
}

/**
 * The edit links' way back: the calendar week they came from
 * (`returnTo=/calendar&returnToWeek=`), else `returnTo` as it was.
 */
function linkedReturnTo(
  query: Static<typeof BuilderLinkQuery>,
): string | undefined {
  const week = parseIsoDate(query.returnToWeek);
  return query.returnTo === '/calendar' && week
    ? `/calendar?week=${week}`
    : query.returnTo;
}

/**
 * Where a saved form goes: back to the calendar week it came from, else the
 * outfit; either says "Already saved" when the garments were an outfit
 * already (createOutfit reused it, ALREADY_SAVED_FLAG).
 */
function afterSave(body: OutfitForm, id: number, alreadySaved = false): string {
  const flag = alreadySaved ? `${ALREADY_SAVED_FLAG}=1` : '';
  if (body.returnTo === '/calendar') {
    const week = body.returnToWeek || body.scheduleDate;
    return week
      ? `/calendar?week=${week}${flag && `&${flag}`}`
      : `/calendar${flag && `?${flag}`}`;
  }
  return `/outfits/${id}${flag && `?${flag}`}`;
}

function describeSave(result: SaveResult, plan: OutfitInput['plan']): string {
  const parts = [`${result.slots} row(s)`];
  if (plan && result.schedule === 'scheduled') {
    parts.push(`scheduled on ${plan.day} (${plan.occasion})`);
  }
  if (plan && result.schedule === 'already-scheduled') {
    parts.push(`already scheduled on ${plan.day}`);
  }
  if (result.entriesClaimed) {
    parts.push(`${result.entriesClaimed} planned entry(ies) now the user's`);
  }
  return parts.join(', ');
}

function outfitNotFound(): HttpError {
  return new HttpError(404, 'Outfit not found');
}

const NO_PLAN_LOOKS: ShownLooks = { looks: [], draftedBy: null };

/**
 * /outfits: the list, the detail page, the writes, and the builder's old
 * addresses, now redirects into Styling (src/web/styling). Outfits are the signed-in user's own:
 * wardrobe shares never reach them, `?ownerId=` is ignored, and anyone
 * else's outfit id is a 404 like an unknown one.
 */
export const outfitRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { config, db, logger },
  done,
) => {
  app.get(
    '/outfits',
    { schema: { querystring: DestinationQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const destination = parseDestination(request.query);
      if (destination.kind === 'trip') {
        logger.debug(
          `GET /outfits: a trip is not picked for here (user ${ownerId}), showing Saved`,
        );
      }
      const day = destination.kind === 'day' ? destination : undefined;
      // Picking for a day is its own task: the plan's looks stay out of it.
      const [{ outfits, activity, choice }, planLooks] = await Promise.all([
        savedContext(db, ownerId, today, day),
        day
          ? NO_PLAN_LOOKS
          : looksOfShownPlan(db, ownerId).then(({ looks, draftedBy }) => ({
              looks: groupLooks(looks).strip,
              draftedBy,
            })),
      ]);
      if (day?.replace !== undefined && !choice?.replacing) {
        logger.debug(
          `GET /outfits: entry ${day.replace} is not user ${ownerId}'s on ${day.day} (${day.occasion}), picking another`,
        );
      }
      return renderPage(
        reply,
        <OutfitsPage
          ctx={viewContext(reply)}
          model={{
            outfits,
            activity,
            planLooks,
            picking:
              day && choice
                ? { destination: pickDestination(day, choice), choice }
                : undefined,
          }}
        />,
      );
    },
  );

  // The builder became Styling (#42): its links (the manifest's and
  // pages the installed app cached, the calendar's, a capsule's) land there
  // with what they meant; Styling judges the capsule (404 if not the
  // wardrobe's), and one that is not even an id is dropped.
  app.get(
    '/outfits/new',
    { schema: { querystring: BuilderLinkQuery } },
    async (request, reply) => {
      const { query } = request;
      const capsule = /^\d{1,10}$/.test(query.capsule ?? '')
        ? Number(query.capsule)
        : undefined;
      return reply.redirect(
        stylingUrl({
          destination: linkedDestination(query),
          capsuleId: capsule,
          returnTo: query.returnTo,
        }),
        302,
      );
    },
  );

  app.get(
    '/outfits/:id',
    { schema: { params: OutfitParams, querystring: FlagQuery } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const today = todayIn(config.timeZone, new Date());
      const found = await outfitContext(db, id, ownerId, today);
      if (!found) throw outfitNotFound();
      return renderPage(
        reply,
        <OutfitPage
          ctx={viewContext(reply)}
          outfit={found.outfit}
          entries={found.entries}
          today={today}
          alreadySaved={request.query.alreadySaved === '1'}
        />,
      );
    },
  );

  // Editing an outfit is Styling with it open (`?outfit=`), which checks
  // it is the requester's.
  app.get(
    '/outfits/:id/edit',
    { schema: { params: OutfitParams, querystring: BuilderLinkQuery } },
    async (request, reply) =>
      reply.redirect(
        stylingUrl({
          outfitId: request.params.id,
          returnTo: linkedReturnTo(request.query),
        }),
        302,
      ),
  );

  app.post(
    '/outfits',
    { schema: { body: OutfitBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const input = outfitInput(request.body);
      const result = await createOutfit(db, ownerId, input);
      logger.info(
        result.alreadySaved
          ? `Outfit form by user ${ownerId}: its garments are already outfit ${result.id}, nothing created (${describeSave(result, input.plan)})${result.adopted ? '; taken over from the week planner' : ''}`
          : `Outfit ${result.id} created by user ${ownerId}: ${describeSave(result, input.plan)}`,
      );
      return reply.redirect(
        afterSave(request.body, result.id, result.alreadySaved),
        302,
      );
    },
  );

  app.post(
    '/outfits/:id',
    { schema: { params: OutfitParams, body: OutfitBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const input = outfitInput(request.body);
      const result = await updateOutfit(db, id, ownerId, input);
      if (result === 'not-found') throw outfitNotFound();
      logger.info(
        `Outfit ${id} updated by user ${ownerId}: ${describeSave(result, input.plan)}`,
      );
      return reply.redirect(afterSave(request.body, id), 302);
    },
  );

  // htmx only (hx-delete, hx-confirm): the page swaps to the list.
  app.delete(
    '/outfits/:id',
    { schema: { params: OutfitParams } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const deleted = await deleteOutfit(db, id, ownerId);
      if (!deleted) throw outfitNotFound();
      logger.info(
        `Outfit ${id} deleted by user ${ownerId} (${deleted.wearsKept} wears kept as day-level wears)`,
      );
      return navigateTo(reply, '/outfits');
    },
  );

  done();
};
