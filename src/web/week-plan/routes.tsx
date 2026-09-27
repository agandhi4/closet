import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { hourIn, todayIn } from '../calendar/calendar-date';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { RowId } from '../schemas';
import { planDays, planMyWeek, undoWeekPlan, weekForecast } from './plan';
import {
  readWeekTemplateForm,
  saveWeekTemplate,
  WeekTemplateBody,
} from './template';
import {
  plannedWeekUrl,
  UNDONE_FLAG,
  WEEK_SAVED_FLAG,
  WEEK_SETTINGS_ID,
  WEEK_SETTINGS_PATH,
} from './urls';

/**
 * The weekly auto-plan's writes (#16): "Plan my week", its Undo, and the
 * Profile's week template. The signed-in user's own, like the calendar;
 * shares never reach them. Every one is a native post answered with a 303
 * (the calendar's banner, the profile's section); what they show is read
 * by the calendar's and the profile's GET routes.
 *
 * Validation: "Plan my week" takes no input (an empty body is null); the
 * undo's id is data (not an id: 400; not the owner's batch: 404); the
 * template is WeekTemplateBody (an occasion outside its field's set: 400).
 */
export const weekPlanRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger, weather },
  done,
) => {
  app.post('/calendar/plan-week', async (request, reply) => {
    const ownerId = sessionUserId(request);
    const now = new Date();
    const today = todayIn(config.timeZone, now);
    const started = performance.now();
    const forecast = await weekForecast({ db, weather }, ownerId, now, {
      fresh: true,
    });
    const result = await planMyWeek(db, ownerId, {
      today,
      hour: hourIn(config.timeZone, now),
      days: planDays(today),
      forecast,
    });
    const ms = Math.round(performance.now() - started);
    if (!result.templateSet) {
      logger.info(
        `Week not planned for user ${ownerId}: no week template; sent to set one`,
      );
      return reply.redirect(WEEK_SETTINGS_PATH, 303);
    }
    const unfilled = `${result.unfilled.length} slot(s) unfilled`;
    const entries = result.planned.map((p) => p.entryId).join(', ');
    logger.info(
      result.weekPlanId === null
        ? `Week plan for user ${ownerId} from ${today}: nothing to plan, ${unfilled} in ${ms} ms`
        : `Week planned for user ${ownerId} from ${today} (plan ${result.weekPlanId}): ${result.planned.length} outfit(s) (entries ${entries}), ${unfilled}, forecast for ${forecast.days.size} day(s) in ${ms} ms`,
    );
    return reply.redirect(plannedWeekUrl(result.weekPlanId ?? 'none'), 303);
  });

  app.post(
    '/calendar/plan-week/:id/undo',
    { schema: { params: Type.Object({ id: RowId }) } },
    async (request, reply) => {
      const ownerId = sessionUserId(request);
      const { id } = request.params;
      const undone = await undoWeekPlan(db, ownerId, id);
      if (undone === 'not-found') throw new HttpError(404, 'Plan not found');
      logger.info(
        `Week plan ${id} undone by user ${ownerId}: ${undone.entries} entr(ies) and ${undone.outfits} outfit(s) removed`,
      );
      return reply.redirect(`/calendar?${UNDONE_FLAG}=${undone.entries}`, 303);
    },
  );

  app.post(
    '/auth/profile/week',
    { schema: { body: WeekTemplateBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const slots = readWeekTemplateForm(request.body);
      await saveWeekTemplate(db, userId, slots);
      logger.info(
        `Week template saved by user ${userId}: ${slots.length} slot(s) on ${new Set(slots.map((s) => s.weekday)).size} day(s)`,
      );
      return reply.redirect(
        `/auth/profile?${WEEK_SAVED_FLAG}=1#${WEEK_SETTINGS_ID}`,
        303,
      );
    },
  );

  done();
};
