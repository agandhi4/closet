import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage, wantsFragment } from '../render';
import { requestOrigin } from '../security/origin';
import { viewContext } from '../view-context';
import {
  InviteLinkResult,
  InvitePage,
  inviteUrl,
  ManagePage,
  REFUSAL_MESSAGES,
} from './pages';
import {
  acceptInvite,
  type AcceptRefusal,
  createInvite,
  declineInvite,
  findInvite,
  removeShare,
  sharesOf,
} from './queries';

const MANAGE_PATH = '/wardrobe-share/manage';

const ManageQuery = Type.Object({
  // A refusal code from an accept redirect; unknown values show nothing.
  error: Type.Optional(Type.String()),
});

const CreateInviteBody = Type.Object({
  // SharePermission; anything else is a 400, never a stored string.
  permission: Type.Optional(
    Type.Union([Type.Literal('VIEW'), Type.Literal('MANAGE')]),
  ),
});

const ShareParams = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const InviteParams = Type.Object({ token: Type.String({ maxLength: 255 }) });

function isRefusal(value: string | undefined): value is AcceptRefusal {
  return value !== undefined && value in REFUSAL_MESSAGES;
}

/**
 * /wardrobe-share: invite links (view or edit) between users, the manage
 * page, and the public invite landing. Invite tokens are bearer secrets in
 * the path: those routes log their pattern, never the URL (secretPath).
 */
export const sharingRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, logger },
  done,
) => {
  app.get(
    MANAGE_PATH,
    { schema: { querystring: ManageQuery } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const { error } = request.query;
      return renderPage(
        reply,
        <ManagePage
          ctx={viewContext(reply)}
          {...await sharesOf(db, id)}
          origin={requestOrigin(request)}
          refusal={isRefusal(error) ? error : undefined}
        />,
      );
    },
  );

  // The manage page's htmx form swaps the link in; without htmx, back to
  // the page, which lists the new invite with its link.
  app.post(
    '/wardrobe-share/create-invite-link',
    { schema: { body: CreateInviteBody } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const permission = request.body.permission ?? 'VIEW';
      const invite = await createInvite(db, id, permission);
      logger.log(`User ${id} created ${permission} invite ${invite.id}`);
      if (wantsFragment(request, reply)) {
        return renderFragment(
          reply,
          <InviteLinkResult
            url={inviteUrl(requestOrigin(request), invite.inviteToken)}
          />,
        );
      }
      return reply.redirect(MANAGE_PATH, 302);
    },
  );

  // Grantor revoking or grantee leaving. A share this user is no party to
  // is a 404 like an unknown id: share ids reveal nothing.
  app.post(
    '/wardrobe-share/:id/remove',
    { schema: { params: ShareParams } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const shareId = request.params.id;
      if ((await removeShare(db, shareId, userId)) === 'not-found') {
        throw new HttpError(404);
      }
      logger.log(`User ${userId} removed share ${shareId}`);
      return reply.redirect(MANAGE_PATH, 302);
    },
  );

  app.get(
    '/wardrobe-share/invite/:token',
    {
      config: { public: true, secretPath: true },
      schema: { params: InviteParams },
    },
    async (request, reply) => {
      const { token } = request.params;
      return renderPage(
        reply,
        <InvitePage
          ctx={viewContext(reply)}
          invite={await findInvite(db, token)}
          token={token}
        />,
      );
    },
  );

  app.post(
    '/wardrobe-share/invite/:token/accept',
    { config: { secretPath: true }, schema: { params: InviteParams } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const result = await acceptInvite(db, request.params.token, id);
      if (!result.accepted) {
        logger.log(`User ${id} could not accept an invite: ${result.reason}`);
        return reply.redirect(`${MANAGE_PATH}?error=${result.reason}`, 302);
      }
      logger.log(
        `User ${id} accepted share ${result.shareId} of user ${result.grantorId}'s wardrobe`,
      );
      return reply.redirect(MANAGE_PATH, 302);
    },
  );

  // Either answer lands on the manage page: a refused decline (an open link
  // someone else holds) must leave the link intact and says nothing.
  app.post(
    '/wardrobe-share/invite/:token/decline',
    { config: { secretPath: true }, schema: { params: InviteParams } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const declined = await declineInvite(db, request.params.token, id);
      logger.log(
        declined
          ? `User ${id} declined or withdrew an invite`
          : `User ${id} may not decline this invite; left in place`,
      );
      return reply.redirect(MANAGE_PATH, 302);
    },
  );

  done();
};
