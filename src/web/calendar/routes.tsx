import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { navigateTo, renderFragment, renderPage } from '../render';
import { DEFAULT_OCCASION } from '../../wardrobe/occasions';
import { parseDestination } from '../outfits/destination';
import { listOutfits } from '../outfits/queries';
import { IsoDateSchema, OccasionSchema, RowId } from '../schemas';
import { viewContext } from '../view-context';
import { setEntryWorn } from '../wears/queries';
import { parseIsoDate, parseYearMonth, todayIn } from './calendar-date';
import { CalendarPage } from './calendar-page';
import { buildCalendarView, weekOf } from './calendar-view';
import { PlanPage } from './plan-page';
import { deleteEntry, findEntries, scheduleOutfit } from './queries';
import { WornButton } from './worn-button';

/**
 * Validation, decided per route:
 * - GET /calendar reads ?week= and ?calMonth= leniently: a missing or
 *   malformed value falls back (the current week, the week's month), since
 *   they are navigation state in a shareable URL and a stale or mangled link
 *   should still open the calendar. parseIsoDate/parseYearMonth decide.
 * - GET /calendar/plan reads ?for= and ?occasion= the same way
 *   (parseDestination): no day is today, an unknown occasion all day.
 * - The writes validate their bodies strictly through the route schema: a
 *   malformed date, outfit id, occasion or week is a 400 error page and
 *   writes nothing (IsoDateSchema: the rule parseIsoDate also applies). A
 *   post without an occasion (the pages cached before #13) is all day.
 * - POST /calendar/:id/delete and /worn take their body as optional: the
 *   posted week only picks the redirect target, and /worn's `worn` the
 *   state to set (absent: a toggle, as pills cached before it posted).
 */
const EntryParams = Type.Object({ id: RowId });

// null: a post without a body (Fastify validates a missing body as null).
const WeekBody = Type.Union([
  Type.Object({ week: Type.Optional(IsoDateSchema) }),
  Type.Null(),
]);

const WornBody = Type.Union([
  Type.Object({
    week: Type.Optional(IsoDateSchema),
    worn: Type.Optional(Type.Union([Type.Literal('1'), Type.Literal('0')])),
  }),
  Type.Null(),
]);

// Someone else's entry is not found, like a missing one: ids reveal nothing
// (test/integration/authorization.spec.ts).
function entryNotFound(): HttpError {
  return new HttpError(404, 'Calendar entry not found');
}

/** The log line for what POST /calendar/:id/worn did. */
function wornMessage(
  id: number,
  ownerId: number,
  outcome: { worn: boolean; changed: boolean; wears: number },
): string {
  const state = outcome.worn ? 'worn' : 'not worn';
  if (!outcome.changed) {
    return `Calendar entry ${id} already ${state} for user ${ownerId}`;
  }
  const wears = `${outcome.wears} wears ${outcome.worn ? 'logged' : 'removed'}`;
  return `Calendar entry ${id} marked ${state} by user ${ownerId} (${wears})`;
}

function weekUrl(week: string | undefined): string {
  return week ? `/calendar?week=${week}` : '/calendar';
}

/**
 * The outfit calendar: the week page and its writes. Outfits and entries are
 * the signed-in user's own; wardrobe shares never reach them, and
 * `?ownerId=` is ignored.
 */
export const calendarRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    '/calendar',
    {
      schema: {
        querystring: Type.Object({
          week: Type.Optional(Type.String()),
          calMonth: Type.Optional(Type.String()),
          // The gallery's pick of an outfit already saved (a one-shot flag).
          alreadySaved: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { week, calMonth } = request.query;
      const today = todayIn(config.timeZone, new Date());
      const anchor = parseIsoDate(week);
      if (week && !anchor) {
        logger.debug(
          `GET /calendar: malformed week ${JSON.stringify(week)}, showing the current week`,
        );
      }
      const { start, end } = weekOf(anchor ?? today);
      const entries = await findEntries(db, ownerId, start, end);
      const view = buildCalendarView({
        weekStart: start,
        calMonth: parseYearMonth(calMonth),
        today,
        entries,
      });
      return renderPage(
        reply,
        <CalendarPage
          ctx={viewContext(reply)}
          view={view}
          alreadySaved={request.query.alreadySaved === '1'}
        />,
      );
    },
  );

  // Plan one more outfit on a day: the occasion, then build one or pick a
  // saved one (the calendar day's "+ Plan" / "+ Another outfit").
  app.get(
    '/calendar/plan',
    {
      schema: {
        querystring: Type.Object({
          for: Type.Optional(Type.String()),
          occasion: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const parsed = parseDestination(request.query);
      const destination =
        parsed.kind === 'day'
          ? parsed
          : {
              day: todayIn(config.timeZone, new Date()),
              occasion: DEFAULT_OCCASION,
            };
      if (parsed.kind === 'none' && request.query.for !== undefined) {
        logger.debug(
          `GET /calendar/plan: no day in ${JSON.stringify(request.query.for)}, planning today`,
        );
      }
      const [outfits, entries] = await Promise.all([
        listOutfits(db, ownerId),
        findEntries(db, ownerId, destination.day, destination.day),
      ]);
      return renderPage(
        reply,
        <PlanPage
          ctx={viewContext(reply)}
          model={{
            ...destination,
            outfits,
            planned: new Map(
              entries.map((entry) => [entry.outfit.id, entry.occasion]),
            ),
          }}
        />,
      );
    },
  );

  // From the plan page (a native post, 302 back to the week), the outfit
  // list's "Add to Calendar" dropdown (htmx, 204).
  app.post(
    '/calendar',
    {
      schema: {
        body: Type.Object({
          date: IsoDateSchema,
          outfitId: RowId,
          occasion: Type.Optional(OccasionSchema),
          week: Type.Optional(IsoDateSchema),
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { date, outfitId, week } = request.body;
      const occasion = request.body.occasion ?? DEFAULT_OCCASION;
      const outcome = await scheduleOutfit(db, {
        ownerId,
        outfitId,
        day: date,
        occasion,
      });
      if (outcome === 'no-such-outfit') {
        throw new HttpError(404, 'Outfit not found');
      }
      logger.info(
        outcome === 'scheduled'
          ? `Outfit ${outfitId} scheduled on ${date} (${occasion}) by user ${ownerId}`
          : `Outfit ${outfitId} already scheduled on ${date} for user ${ownerId}; ${occasion} not added`,
      );
      if (request.headers['hx-request'] === 'true') {
        return reply.status(204).send();
      }
      return reply.redirect(weekUrl(week ?? date), 302);
    },
  );

  // The chip's form (hx-confirm): htmx swaps the page to the week the chip
  // was on; the same form posted natively gets the 303 there.
  app.post(
    '/calendar/:id/delete',
    { schema: { params: EntryParams, body: WeekBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const outcome = await deleteEntry(db, id, ownerId);
      if (outcome !== 'deleted') throw entryNotFound();
      logger.info(`Calendar entry ${id} deleted by user ${ownerId}`);
      const target = weekUrl(request.body?.week);
      if (request.headers['hx-request']) return navigateTo(reply, target);
      return reply.redirect(target, 303);
    },
  );

  // The chip's worn pill: the entry and its wears change together
  // (setEntryWorn). A day after today is refused (409): its chip has no
  // pill, so only a page the installed app cached before that rule posts it.
  app.post(
    '/calendar/:id/worn',
    { schema: { params: EntryParams, body: WornBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const posted = request.body?.worn;
      const outcome = await setEntryWorn(db, {
        entryId: id,
        ownerId,
        worn: posted === undefined ? undefined : posted === '1',
        at: new Date(),
        today: todayIn(config.timeZone, new Date()),
      });
      if (outcome === 'not-found') throw entryNotFound();
      if (outcome === 'future') {
        logger.info(`Calendar entry ${id}: not marked worn, its day is ahead`);
        throw new HttpError(409, 'A planned day cannot be marked worn yet');
      }
      logger.info(wornMessage(id, ownerId, outcome));
      const week = request.body?.week;
      if (request.headers['hx-request']) {
        // Swapped in place of the posted form, carrying the posted week on.
        return renderFragment(
          reply,
          <WornButton entryId={id} worn={outcome.worn} week={week} />,
        );
      }
      return reply.redirect(weekUrl(week), 303);
    },
  );

  done();
};
