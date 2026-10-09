import * as z from 'zod/v4';
import { hourIn, todayIn } from '../../../calendar-date';
import { planDays, planMyWeek, weekForecast } from '../../week-plan/plan';
import { defineTool } from '../tool';

/**
 * The weekly auto-plan (#16) as a tool: the calendar's "Plan my week",
 * through the same planMyWeek (the template, the forecast per slot, wash
 * limits across the week, no outfit twice, one transaction under the
 * owner's lock). The caller's own week, like the calendar: no ownerId.
 */
export const weekPlanTools = [
  defineTool({
    name: 'plan_week',
    title: 'Plan my week',
    description:
      "WRITES: fills the empty slots of your week template (get_style_profile's week: each weekday's occasions) for today and the next six days with outfits from your closet, each dressed for its slot's forecast (weather on and a location set) and its occasion's formality, as the calendar's Plan my week does. Its own planned wears count toward wash limits across the week, and no outfit is used twice in it. New outfits are saved and named after their garments; each planned entry is marked auto, which the daily re-plan may swap when the forecast changes, until you edit or wear it. Safe to retry: slots already filled are left alone, so a second call plans nothing new. Returns what it planned (entry and outfit ids, garments, any problems of a near miss), the slots nothing clean could fill, and weekPlanId; Undo is in the app. With no week template it plans nothing and says so.",
    input: z.object({}),
    writes: true,
    // Filled slots are skipped: a retry plans nothing more.
    idempotent: true,
    async run(_args, ctx) {
      const now = new Date();
      const today = todayIn(ctx.timeZone, now);
      const forecast = await weekForecast(ctx, ctx.userId, now, {
        fresh: true,
      });
      const result = await planMyWeek(ctx.db, ctx.userId, {
        today,
        hour: hourIn(ctx.timeZone, now),
        days: planDays(today),
        forecast,
      });
      ctx.webLogger.info(
        result.templateSet
          ? `Week planned for user ${ctx.userId} (MCP) from ${today}: ${result.planned.length} outfit(s)${result.weekPlanId === null ? '' : ` (plan ${result.weekPlanId})`}, ${result.unfilled.length} slot(s) unfilled`
          : `Week not planned for user ${ctx.userId} (MCP): no week template`,
      );
      return {
        from: today,
        templateSet: result.templateSet,
        weekPlanId: result.weekPlanId,
        weatherDays: forecast.days.size,
        planned: result.planned.map((entry) => ({
          entryId: entry.entryId,
          day: entry.day,
          occasion: entry.occasion,
          outfit: { id: entry.outfitId, name: entry.outfitName },
          alreadySaved: entry.alreadySaved,
          garments: entry.garments,
          problems: entry.problems,
        })),
        unfilled: result.unfilled,
        ...(result.templateSet
          ? {}
          : {
              note: 'No week template yet: set one in the app (Profile, Your week).',
            }),
      };
    },
  }),
];
