import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { CloneType, Type } from '@sinclair/typebox';
import { FEELINGS, OFFSET_LIMIT, OFFSET_STEP } from '../../weather/temperature';
import { apiResponses } from '../api/contract';
import type { ApiOptions } from '../api/plugin';
import { literals } from '../api/resource';
import { actorOf } from '../sharing/access';
import { nudgeTemperatureOffset } from './queries';

const TemperatureFeedback = Type.Object(
  {
    feeling: CloneType(literals(FEELINGS), {
      description:
        '`too-warm`: the weather felt warmer than it read, so lighter ideas follow; `too-cold` the other way',
    }),
  },
  { title: 'TemperatureFeedback' },
);

const TemperatureOffset = Type.Object(
  {
    offset: Type.Number({
      minimum: -OFFSET_LIMIT,
      maximum: OFFSET_LIMIT,
      description: `Your temperature offset now: °C added to the feels-like temperature before ideas are matched to it. Each feedback moves it ${OFFSET_STEP}, within ±${OFFSET_LIMIT}`,
    }),
  },
  { title: 'TemperatureOffset' },
);

/**
 * The weather's writes on /api/v1 (#193c). Registered by apiPlugin only
 * with WEATHER_ENABLED, as /weather/* and the gallery's feedback are: the
 * offset means nothing without a forecast, so without one the route does
 * not exist (the problem 404). The rest of the weather (the home place,
 * the unit, the reset) is #195's.
 */
export const weatherApiRoutes: FastifyPluginCallbackTypebox<ApiOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.post(
    '/weather/feedback',
    {
      schema: {
        operationId: 'sendTemperatureFeedback',
        tags: ['weather'],
        summary: 'Says an outfit felt too warm or too cold',
        description:
          'An Ideas card\'s and the profile\'s "Too warm" / "Too cold": your temperature offset moves a step, and the next ideas are matched to it. Not idempotent: each call is a step.',
        body: TemperatureFeedback,
        response: apiResponses({ 200: TemperatureOffset }),
      },
    },
    async (request) => {
      const userId = actorOf(request).userId;
      const { feeling } = request.body;
      const offset = await nudgeTemperatureOffset(db, userId, feeling);
      logger.info(
        `Temperature feedback from user ${userId} (API): ${feeling}, offset now ${offset}`,
      );
      return { offset };
    },
  );

  done();
};
