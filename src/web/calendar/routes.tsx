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
import { safeReturnTo } from '../security/return-to';
import { detachedLooks } from '../selfies/queries';
import { viewContext } from '../view-context';
import { setEntryWorn } from '../wears/queries';
import { plannedBanner } from '../week-plan/plan';
import { hourIn, parseIsoDate, parseYearMonth, todayIn } from './calendar-date';
import { CalendarPage } from './calendar-page';
import { buildCalendarView, weekOf } from './calendar-view';
import { PlanPage } from './plan-page';
import { findEntries, scheduleOutfit } from './queries';
import {
  isRefused,
  replaceEntryOutfit,
  replaceMessage,
  replaceRefusal,
} from './replace';
import { WornButton } from './worn-button';
import { removeEntry } from './writes';

/**
 * Validation, decided per route:
 * - GET /calendar reads ?week= and ?calMonth= leniently: a missing or
 *   malformed value falls back (the current week, the week's month), since
 *   they are navigation state in a shareable URL and a stale or mangled link
 *   should still open the calendar. parseIsoDate/parseYearMonth decide.
 * - GET /calendar/plan reads ?for=, ?occasion= and ?replace= the same way
 *   (parseDestination): no day is today, an unknown occasion all day, and
 *   a `replace` that is not the user's entry there plans one more outfit.
 * - POST /calendar's `replace` is data (RowId, else a 400); the entry must
 *   be the user's on `date` for `occasion` (else a 404, replaceRefusal).
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
    // Where a plain post goes back to (Today's "Wore it"), through
    // safeReturnTo; else the posted week.
    returnTo: Type.Optional(Type.String({ maxLength: 2048 })),
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

/** `?planned=`: a batch id or 'none'; anything else is no banner. */
function parsePlanned(value: string | undefined): number | 'none' | undefined {
  if (value === 'none') return 'none';
  return value !== undefined && /^[1-9]\d{0,9}$/.test(value)
    ? Number(value)
    : undefined;
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
  { db, config, logger, photos },
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
          // After "Plan my week" (#16): its batch id, or 'none'; and after
          // its Undo, how many entries went. Navigation state: anything
          // malformed, or another's batch, shows nothing.
          planned: Type.Optional(Type.String({ maxLength: 12 })),
          undone: Type.Optional(Type.String({ maxLength: 6 })),
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
      const planned = parsePlanned(request.query.planned);
      const [entries, looks, banner] = await Promise.all([
        findEntries(db, ownerId, start, end),
        detachedLooks(db, ownerId, start, end),
        planned === undefined
          ? undefined
          : plannedBanner(db, ownerId, planned, {
              today,
              hour: hourIn(config.timeZone, new Date()),
            }),
      ]);
      const undone = request.query.undone;
      const view = buildCalendarView({
        weekStart: start,
        calMonth: parseYearMonth(calMonth),
        today,
        entries,
        looks,
      });
      return renderPage(
        reply,
        <CalendarPage
          ctx={viewContext(reply)}
          view={view}
          alreadySaved={request.query.alreadySaved === '1'}
          banner={banner}
          undone={
            undone !== undefined && /^\d+$/.test(undone)
              ? Number(undone)
              : undefined
          }
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
          replace: Type.Optional(Type.String()),
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
      // Changing an entry (#69): it must be the owner's, on the day and for
      // the occasion; otherwise the page plans one more (navigation state,
      // never a 404), and the write checks again.
      const replace = parsed.kind === 'day' ? parsed.replace : undefined;
      const replacing = entries.find(
        (entry) =>
          entry.id === replace && entry.occasion === destination.occasion,
      );
      if (replace !== undefined && !replacing) {
        logger.debug(
          `GET /calendar/plan: entry ${replace} is not user ${ownerId}'s on ${destination.day} (${destination.occasion}), planning another`,
        );
      }
      return renderPage(
        reply,
        <PlanPage
          ctx={viewContext(reply)}
          model={{
            day: destination.day,
            occasion: destination.occasion,
            outfits,
            planned: new Map(
              entries.map((entry) => [entry.outfit.id, entry.occasion]),
            ),
            replacing: replacing && {
              entryId: replacing.id,
              outfitName: replacing.outfit.name,
              worn: replacing.worn,
            },
          }}
        />,
      );
    },
  );

  // From the plan page (a native post, 302 back to the week), the outfit
  // list's "Add to Calendar" dropdown (htmx, 204). With `replace` (the plan
  // page opened to change an entry, #69) the outfit takes that entry's
  // place instead of joining the day: replaceEntryOutfit.
  app.post(
    '/calendar',
    {
      schema: {
        body: Type.Object({
          date: IsoDateSchema,
          outfitId: RowId,
          occasion: Type.Optional(OccasionSchema),
          week: Type.Optional(IsoDateSchema),
          replace: Type.Optional(RowId),
        }),
      },
    },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { date, outfitId, week, replace } = request.body;
      const occasion = request.body.occasion ?? DEFAULT_OCCASION;
      if (replace !== undefined) {
        const target = { entryId: replace, day: date, occasion };
        const replaced = await replaceEntryOutfit(db, ownerId, target, {
          outfitId,
        });
        logger.info(replaceMessage(ownerId, target, replaced));
        if (isRefused(replaced)) throw replaceRefusal(replaced);
        if (request.headers['hx-request'] === 'true') {
          return reply.status(204).send();
        }
        return reply.redirect(weekUrl(week ?? date), 302);
      }
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
      if (!(await removeEntry({ db, photos, logger }, id, ownerId))) {
        throw entryNotFound();
      }
      const target = weekUrl(request.body?.week);
      if (request.headers['hx-request']) return navigateTo(reply, target);
      return reply.redirect(target, 303);
    },
  );

  // The chip's worn pill, and Today's "Wore it" and its undo (plain posts
  // back to Today through `returnTo`): the entry and its wears change
  // together (setEntryWorn). A day after today is refused (409): its chip
  // has no pill, so only a page the installed app cached before that rule
  // posts it.
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
      return reply.redirect(
        safeReturnTo(request.body?.returnTo, weekUrl(week)),
        303,
      );
    },
  );

  done();
};
