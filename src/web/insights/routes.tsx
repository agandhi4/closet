import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  DEFAULT_UNWORN_DAYS,
  isUnwornDays,
  type UnwornDays,
} from '../../wardrobe/insights';
import { sessionUserId } from '../auth/require-session';
import { todayIn } from '../calendar/calendar-date';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { InsightsPage } from './insights-page';
import { readInsights } from './queries';
import { INSIGHTS_PATH } from './urls';

// Navigation state (the unworn list's window chips): anything but one of
// the choices falls back to the default, never a 400.
const InsightsQuery = Type.Object({
  unworn: Type.Optional(Type.String({ maxLength: 8 })),
});

function unwornDays(value: string | undefined): UnwornDays {
  const days = Number(value);
  return isUnwornDays(days) ? days : DEFAULT_UNWORN_DAYS;
}

/**
 * Insights (#17, plan section 10): how the closet is actually used, from
 * the owner's own wears, so the signed-in user's only, like /laundry:
 * `?ownerId=` is ignored and a share never reaches it. Two statements
 * (src/web/insights/queries.ts), computed on request, nothing stored.
 */
export const insightsRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    INSIGHTS_PATH,
    { schema: { querystring: InsightsQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const today = todayIn(config.timeZone, new Date());
      const days = unwornDays(request.query.unworn);
      const started = performance.now();
      const insights = await readInsights(db, userId, today, days);
      logger.debug(
        `Insights for user ${userId}: ${insights.closet.garments} garment(s), ${insights.pairs.length} pair(s), unworn ${days} days in ${Math.round(performance.now() - started)} ms`,
      );
      return renderPage(
        reply,
        <InsightsPage ctx={viewContext(reply)} model={{ insights, today }} />,
      );
    },
  );

  done();
};
