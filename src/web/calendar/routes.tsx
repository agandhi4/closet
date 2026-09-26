import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { IsoDateSchema, RowId } from '../schemas';
import { viewContext } from '../view-context';
import { parseIsoDate, parseYearMonth, todayIn } from './calendar-date';
import { CalendarPage } from './calendar-page';
import { buildCalendarView, weekOf } from './calendar-view';
import {
  deleteEntry,
  findEntries,
  scheduleOutfit,
  toggleWorn,
} from './queries';
import { WornButton } from './worn-button';

/**
 * Validation, decided per route:
 * - GET /calendar reads ?week= and ?calMonth= leniently: a missing or
 *   malformed value falls back (the current week, the week's month), since
 *   they are navigation state in a shareable URL and a stale or mangled link
 *   should still open the calendar. parseIsoDate/parseYearMonth decide.
 * - The writes validate their bodies strictly through the route schema: a
 *   malformed date, outfit id or week is a 400 error page and writes
 *   nothing (IsoDateSchema: the rule parseIsoDate also applies).
 * - POST /calendar/:id/delete and /worn take their body as optional: the
 *   posted week only picks the redirect target.
 */
const EntryParams = Type.Object({ id: RowId });

// null: a post without a body (Fastify validates a missing body as null).
const WeekBody = Type.Union([
  Type.Object({ week: Type.Optional(IsoDateSchema) }),
  Type.Null(),
]);

// Someone else's entry is not found, like a missing one: ids reveal nothing
// (test/integration/authorization.spec.ts).
function entryNotFound(): HttpError {
  return new HttpError(404, 'Calendar entry not found');
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
        <CalendarPage ctx={viewContext(reply)} view={view} />,
      );
    },
  );

  // From the outfit list's "Add to Calendar" dropdown (htmx, 204) and as a
  // plain form post (302 back to the week).
  app.post(
    '/calendar',
    {
      schema: {
        body: Type.Object({
          date: IsoDateSchema,
          outfitId: RowId,
          week: Type.Optional(IsoDateSchema),
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { date, outfitId, week } = request.body;
      const outcome = await scheduleOutfit(db, {
        ownerId,
        outfitId,
        day: date,
      });
      if (outcome === 'no-such-outfit') {
        throw new HttpError(404, 'Outfit not found');
      }
      logger.info(
        outcome === 'scheduled'
          ? `Outfit ${outfitId} scheduled on ${date} by user ${ownerId}`
          : `Outfit ${outfitId} already scheduled on ${date} for user ${ownerId}`,
      );
      if (request.headers['hx-request'] === 'true') {
        return reply.status(204).send();
      }
      return reply.redirect(weekUrl(week ?? date), 302);
    },
  );

  // htmx only (hx-confirm): the page reloads on the week the chip was on.
  app.post(
    '/calendar/:id/delete',
    { schema: { params: EntryParams, body: WeekBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const outcome = await deleteEntry(db, id, ownerId);
      if (outcome !== 'deleted') throw entryNotFound();
      logger.info(`Calendar entry ${id} deleted by user ${ownerId}`);
      return reply
        .header('HX-Redirect', weekUrl(request.body?.week))
        .status(200)
        .send();
    },
  );

  app.post(
    '/calendar/:id/worn',
    { schema: { params: EntryParams, body: WeekBody } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const outcome = await toggleWorn(db, id, ownerId);
      if (typeof outcome === 'string') throw entryNotFound();
      logger.info(
        `Calendar entry ${id} marked ${outcome.worn ? 'worn' : 'not worn'} by user ${ownerId}`,
      );
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
