import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../errors';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { RowId } from '../schemas';
import { ACCOUNT_LIMIT } from '../security/rate-limit';
import { viewContext } from '../view-context';
import {
  createToken,
  listTokens,
  revokeToken,
  TOKEN_NAME_MAX,
} from './personal-tokens';
import { verifyPassword } from './passwords';
import { findUserById } from './queries';
import { sessionUserId } from './require-session';
import { TokensPage } from './tokens-page';
import { Password } from './validation';

export const TOKENS_PATH = '/auth/tokens';

const TokensQuery = Type.Object({
  // Navigation state from the revoke redirect; anything else shows nothing.
  revoked: Type.Optional(Type.String()),
});

// A longer name is a 400 (the input carries the same maxlength); a blank one
// re-renders the page with a message.
const CreateTokenBody = Type.Object({
  name: Type.String({ maxLength: TOKEN_NAME_MAX }),
  currentPassword: Password,
});

const TokenParams = Type.Object({ id: RowId });

/**
 * The profile's "Agent access" (#33): create, list and revoke personal
 * access tokens (src/web/auth/personal-tokens.ts), the MCP endpoint's
 * credential. Every form is a native post (PostForm). Creating needs the
 * current password (a token is a credential that survives signing out) and
 * answers the page with the token in it, once, and `no-store`, so no cache
 * keeps it; rate-limited like the other routes that check the password.
 * Revoking needs no password: it only narrows access.
 */
export const tokenRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, config, logger },
  done,
) => {
  app.get(
    TOKENS_PATH,
    { schema: { querystring: TokensQuery } },
    async (request, reply) =>
      renderPage(
        reply,
        <TokensPage
          ctx={viewContext(reply)}
          tokens={await listTokens(db, sessionUserId(request))}
          timeZone={config.timeZone}
          notice={request.query.revoked === '1' ? 'revoked' : undefined}
        />,
      ),
  );

  app.post(
    TOKENS_PATH,
    {
      config: { rateLimit: ACCOUNT_LIMIT },
      schema: { body: CreateTokenBody },
    },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const name = request.body.name.trim();
      // The form again with what was typed, the password never echoed.
      const refuse = async (
        notice: 'name-required' | 'too-many' | undefined,
        passwordError?: string,
      ) =>
        renderPage(
          reply,
          <TokensPage
            ctx={viewContext(reply)}
            tokens={await listTokens(db, userId)}
            timeZone={config.timeZone}
            notice={notice}
            form={{ name: request.body.name, passwordError }}
          />,
          { status: 400 },
        );
      if (!name) return refuse('name-required');

      // Step-up, as for every route that hands out or changes a credential:
      // a token outlives signing out, so a borrowed unlocked phone or a
      // stolen cookie must not be enough to mint one.
      const account = await findUserById(db, userId);
      if (
        !(await verifyPassword(request.body.currentPassword, account?.password))
      ) {
        logger.info(`Token refused for user ${userId}: wrong current password`);
        return refuse(undefined, t('WRONG_CURRENT_PASSWORD'));
      }

      const result = await createToken(db, userId, name);
      if (!result.created) {
        logger.warn(`Token refused for user ${userId}: ${result.reason}`);
        return refuse(result.reason);
      }
      logger.info(`User ${userId} created access token ${result.id}`);
      // The only time the token exists in a response: nothing may store it.
      reply.header('Cache-Control', 'no-store');
      return renderPage(
        reply,
        <TokensPage
          ctx={viewContext(reply)}
          tokens={await listTokens(db, userId)}
          timeZone={config.timeZone}
          created={{ name, token: result.token }}
        />,
      );
    },
  );

  app.post(
    `${TOKENS_PATH}/:id/revoke`,
    { schema: { params: TokenParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const { id } = request.params;
      // Another user's token, an unknown id and a revoked one alike.
      if (!(await revokeToken(db, userId, id))) throw new HttpError(404);
      logger.info(`User ${userId} revoked access token ${id}`);
      return reply.redirect(`${TOKENS_PATH}?revoked=1`, 303);
    },
  );

  done();
};
