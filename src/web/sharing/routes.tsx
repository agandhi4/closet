import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { SHARE_PERMISSIONS } from '../../db/schema';
import { sessionUserId } from '../auth/require-session';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage, wantsFragment } from '../render';
import { requestOrigin } from '../security/origin';
import { viewContext } from '../view-context';
import { actorOf } from './access';
import { InviteLinkResult, InvitePage, inviteUrl, parseRefusal } from './pages';
import {
  acceptInvite,
  createInvite,
  declineInvite,
  findInvite,
  removeShare,
} from './queries';
import { wardrobeUrl } from '../wardrobe/urls';
import { LEGACY_MANAGE_PATH, SHARING_PATH, sharingRefusalUrl } from './urls';

const LegacyManageQuery = Type.Object({
  // A refusal code from an accept redirect made before #82; unknown values
  // are dropped.
  error: Type.Optional(Type.String()),
});

const CreateInviteBody = Type.Object({
  // Anything else is a 400, never a stored string.
  permission: Type.Optional(
    Type.Union(SHARE_PERMISSIONS.map((value) => Type.Literal(value))),
  ),
});

const ShareParams = Type.Object({ id: Type.Integer({ minimum: 1 }) });
const InviteParams = Type.Object({ token: Type.String({ maxLength: 255 }) });

/**
 * /wardrobe-share: invite links (view or edit) between users, their answers
 * and the public invite landing. Sharing is managed in Profile › Sharing
 * (SharingSection, rendered by the profile route), where every write here
 * lands. Invite tokens are bearer secrets in the path: those routes log
 * their pattern, never the URL (secretPath).
 */
export const sharingRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, logger },
  done,
) => {
  // The manage page moved into Profile (#82). Links in pages the installed
  // app cached still come here: a permanent redirect, keeping a refusal.
  app.get(
    LEGACY_MANAGE_PATH,
    { schema: { querystring: LegacyManageQuery } },
    async (request, reply) => {
      const refusal = parseRefusal(request.query.error);
      return reply.redirect(
        refusal ? sharingRefusalUrl(refusal) : SHARING_PATH,
        301,
      );
    },
  );

  // Profile's htmx form swaps the link in; without htmx, back to the
  // section, which lists the new invite with its link.
  app.post(
    '/wardrobe-share/create-invite-link',
    { schema: { body: CreateInviteBody } },
    async (request, reply) => {
      const id = sessionUserId(request);
      const permission = request.body.permission ?? 'VIEW';
      const invite = await createInvite(db, id, permission);
      logger.info(`User ${id} created ${permission} invite ${invite.id}`);
      if (wantsFragment(request, reply)) {
        return renderFragment(
          reply,
          <InviteLinkResult
            url={inviteUrl(requestOrigin(request), invite.inviteToken)}
          />,
        );
      }
      return reply.redirect(SHARING_PATH, 302);
    },
  );

  // Grantor revoking or grantee leaving (removeShare refuses any other).
  app.post(
    '/wardrobe-share/:id/remove',
    { schema: { params: ShareParams } },
    async (request, reply) => {
      const actor = actorOf(request);
      const shareId = request.params.id;
      await removeShare(db, actor, shareId);
      logger.info(`User ${actor.userId} removed share ${shareId}`);
      return reply.redirect(SHARING_PATH, 302);
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
    {
      config: { secretPath: true },
      schema: { params: InviteParams },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const result = await acceptInvite(db, request.params.token, id);
      if (!result.accepted) {
        logger.info(`User ${id} could not accept an invite: ${result.reason}`);
        return reply.redirect(sharingRefusalUrl(result.reason), 302);
      }
      logger.info(
        `User ${id} accepted share ${result.shareId} of user ${result.grantorId}'s wardrobe`,
      );
      // Straight into what was shared: the grantor of the invite this write
      // accepted, never an id the request named.
      return reply.redirect(wardrobeUrl(result.grantorId), 302);
    },
  );

  // Either answer lands on Profile › Sharing: a refused decline (an open link
  // someone else holds) must leave the link intact and says nothing.
  app.post(
    '/wardrobe-share/invite/:token/decline',
    {
      config: { secretPath: true },
      schema: { params: InviteParams },
    },
    async (request, reply) => {
      const id = sessionUserId(request);
      const declined = await declineInvite(db, request.params.token, id);
      logger.info(
        declined
          ? `User ${id} declined or withdrew an invite`
          : `User ${id} may not decline this invite; left in place`,
      );
      return reply.redirect(SHARING_PATH, 302);
    },
  );

  done();
};
