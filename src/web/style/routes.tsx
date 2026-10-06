import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { selectScalars } from '../../db/select-scalars';
import { weeklyRhythm } from '../../wardrobe/week';
import { sessionUserId } from '../auth/require-session';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { viewContext } from '../view-context';
import { homeNameSql } from '../weather/queries';
import { inTemplateOrder, weekTemplateSql } from '../week-plan/template';
import { saveStyleProfile, styleProfileSql } from './queries';
import { StyleProfilePage } from './style-page';
import { STYLE_PROFILE_PATH } from './urls';
import {
  EMPTY_STYLE_PROFILE,
  readStyleProfileForm,
  StyleProfileBody,
  styleProfilePost,
  StyleProfileQuery,
} from './validation';

/**
 * The style profile (#34): the signed-in user's own, never another's
 * (shares never reach it), read by get_style_profile and edited here. A
 * native post (PostForm), back to the page with a toast.
 */
export const styleRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger } = options;

  app.get(
    STYLE_PROFILE_PATH,
    { schema: { querystring: StyleProfileQuery } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      // One statement (#251; it was one per part), each part its module's:
      // the profile, the week template its rhythm comes from, and the home
      // city, read-only, the weather's (#14, user_weather, never a second
      // copy), not read with WEATHER_ENABLED off.
      const read = await selectScalars(db, {
        profile: styleProfileSql(userId),
        template: weekTemplateSql(userId),
        home: options.weather ? homeNameSql(userId) : undefined,
      });
      return renderPage(
        reply,
        <StyleProfilePage
          ctx={viewContext(reply)}
          model={{
            values: styleProfilePost(read.profile ?? EMPTY_STYLE_PROFILE),
            rhythm: weeklyRhythm(inTemplateOrder(read.template)),
            home: options.weather ? { name: read.home ?? null } : undefined,
            saved: request.query.saved === '1',
          }}
        />,
      );
    },
  );

  app.post(
    STYLE_PROFILE_PATH,
    { schema: { body: StyleProfileBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const fields = readStyleProfileForm(request.body);
      await saveStyleProfile(db, userId, fields);
      logger.info(
        `Style profile saved by user ${userId}: ${fields.styles?.length ?? 0} styles, ${fields.palette?.length ?? 0} colours`,
      );
      return reply.redirect(`${STYLE_PROFILE_PATH}?saved=1`, 303);
    },
  );

  done();
};
