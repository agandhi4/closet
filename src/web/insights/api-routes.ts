import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, Type } from '@sinclair/typebox';
import { dateParts, todayIn } from '../../calendar-date';
import { DEFAULT_UNWORN_DAYS, UNWORN_CHOICES } from '../../wardrobe/insights';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals } from '../api/resource';
import { HttpError } from '../errors';
import { t } from '../i18n';
import { actorOf } from '../sharing/access';
import {
  InsightsResource,
  RecapResource,
  toInsightsResource,
  toRecapResource,
} from './insights-resource';
import { readInsights, readRecap } from './queries';
import { recapPeriod } from './recap-period';

// Data, unlike the pages' navigation state: a window or year the page
// would fall back from is a 400 here (querystrings still coerce, so
// `?unwornDays=30` is the number).
const InsightsQuery = Type.Object({
  unwornDays: Type.Optional(
    CloneType(literals(UNWORN_CHOICES), {
      description: `The unworn list's window in days; ${DEFAULT_UNWORN_DAYS} unless given`,
    }),
  ),
});

const RecapQuery = Type.Object({
  year: Type.Optional(
    Type.Integer({
      minimum: 1000,
      maximum: 9999,
      description:
        "The year to recap, the household's current one unless given; a later year is a 400",
    }),
  ),
});

/**
 * Insights and the year in review on /api/v1 (#588), each its page's read
 * (readInsights; readRecap over recapPeriod): the
 * token's user's own wear log, owner-only like the pages, so no
 * `?ownerId=` (an undeclared parameter is a 400). "Today" is the
 * household's (todayIn), as on the pages.
 */
export const insightsApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    '/insights',
    {
      schema: {
        operationId: 'getInsights',
        tags: ['insights'],
        summary: 'How your closet is used',
        description:
          "The insights page's figures, computed from your wear log on every call: worn lately, unworn, most and least worn, cost per wear, pairs, colours, categories, brands and condition. Your own closet only.",
        querystring: InsightsQuery,
        response: apiResponses({ 200: InsightsResource }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const today = todayIn(config.timeZone, new Date());
      const days = request.query.unwornDays ?? DEFAULT_UNWORN_DAYS;
      const started = performance.now();
      const insights = await readInsights(db, userId, today, days);
      logger.debug(
        `Insights for user ${userId} (API): ${insights.closet.garments} garment(s), ${insights.pairs.length} pair(s), unworn ${days} days in ${Math.round(performance.now() - started)} ms`,
      );
      return toInsightsResource(insights, today);
    },
  );

  app.get(
    '/insights/recap',
    {
      schema: {
        operationId: 'getRecap',
        tags: ['insights'],
        summary: 'Your year in review',
        description:
          "The year in review's figures over a calendar year: January 1 to December 31, or to today while the year runs. Garments archived since still count; `enough` false is the page's empty state. Your own wear log only.",
        querystring: RecapQuery,
        response: apiResponses({ 200: RecapResource }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const today = todayIn(config.timeZone, new Date());
      const current = dateParts(today).year;
      const year = request.query.year ?? current;
      if (year > current) {
        throw new HttpError(400, t('api.RECAP_YEAR', { year: current }));
      }
      const period = recapPeriod(year, today);
      const started = performance.now();
      const recap = await readRecap(db, userId, period);
      logger.debug(
        `Recap ${period.year} for user ${userId} (API): ${recap.wears} wear(s), ${recap.piecesWorn} piece(s), ${recap.additions.count} added in ${Math.round(performance.now() - started)} ms`,
      );
      return toRecapResource(recap);
    },
  );

  done();
};
