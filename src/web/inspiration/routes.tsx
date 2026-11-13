import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionUserId } from '../auth/require-session';
import { AutosaveSaved } from '../autosave';
import { INSPIRATION_PHOTO_ROOT } from '../files/image-url';
import { sendPrivatePhoto } from '../files/private-photo';
import { t } from '../i18n';
import { loggableUrl } from '../loggable-url';
import type { WebOptions } from '../plugin';
import { renderFragment, renderPage } from '../render';
import { RowId } from '../schemas';
import { LINK_IMPORT_LIMIT, tooManyAttempts } from '../security/rate-limit';
import { viewContext } from '../view-context';
import {
  LINK_INPUT_MAX,
  linkIn,
  LinkImportError,
  type LinkImportRefusal,
  REFUSALS,
} from '../wardrobe/link-import/import';
import { InspirationListPage } from './list-page';
import { NewInspirationPage } from './new-page';
import {
  findInspiration,
  INSPIRATION_NOTE_MAX,
  INSPIRATION_TITLE_MAX,
  isOwnInspirationPhoto,
  listInspirations,
  updateInspirationText,
} from './queries';
import { InspirationPage } from './show-page';
import {
  INSPIRATION_LINK_PATH,
  INSPIRATION_PATH,
  inspirationUrl,
  NEW_INSPIRATION_PATH,
} from './urls';
import {
  addLinkedInspiration,
  addUploadedInspiration,
  attachInspirationPhoto,
  removeInspiration,
  unreadReasonOf,
} from './writes';

/** One look's routes: its page, its title and note, its photo, its delete. */
const LOOK_ROUTE = `${INSPIRATION_PATH}/:id`;

const LookParams = Type.Object({ id: RowId });
// `?unread=` is URL state (a redirect's one-shot note): anything unknown
// shows no note, never a 400.
const LookQuery = Type.Object({
  unread: Type.Optional(Type.String({ maxLength: 32 })),
});
const LinkBody = Type.Object({
  url: Type.String({ maxLength: LINK_INPUT_MAX }),
});
// The autosave posts the whole form: both fields always (stored data, so
// anything else is a 400). Blank is none.
const TextBody = Type.Object({
  title: Type.String({ maxLength: INSPIRATION_TITLE_MAX }),
  note: Type.String({ maxLength: INSPIRATION_NOTE_MAX }),
});
// Checked by the handler, like /file/**: anything that is not a photo name
// is a 404 like a missing photo.
const FileParams = Type.Object({ fileName: Type.String() });

/**
 * Saved looks (#22; docs/plans/2026-11-13-inspiration-library.md), the
 * Outfits page's Inspiration tab: the list, adding one from a photo or a
 * pasted link, a look's page with its title and note, its photo and
 * Delete, and the photos themselves. The signed-in owner's own, like the
 * style profile: `sessionUserId` alone, no `?ownerId=`; another user's look
 * or photo is a 404 like an unknown id (the writers' NotFound), whatever
 * wardrobe is shared. Every write is a native post (PostForm), answered
 * with a 303 to the look's page, the list after a delete; the autosave is
 * answered with its status line.
 */
export const inspirationRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  { db, photos, logger, fetcher },
  done,
) => {
  const deps = { db, photos, logger, fetcher };
  // A budget of its own, like the order mail's "Add to closet": the
  // garment link import's checker lives in its plugin, and a separate
  // createRateLimit is a separate store (src/web/wardrobe/link-import/AGENTS.md).
  const linkLimit = app.createRateLimit(LINK_IMPORT_LIMIT);

  async function linkRetryAfter(
    request: FastifyRequest,
  ): Promise<number | undefined> {
    const verdict = await linkLimit(request);
    if (verdict.isAllowed || !verdict.isExceeded) return undefined;
    logger.warn(
      `Rate limit reached: ${request.method} ${loggableUrl(request)} for user ${sessionUserId(request)}`,
    );
    return verdict.ttlInSeconds;
  }

  function refuseLink(
    reply: FastifyReply,
    reason: LinkImportRefusal,
    link: string,
  ): Promise<FastifyReply> {
    const { message, status } = REFUSALS[reason];
    return renderPage(
      reply,
      <NewInspirationPage
        ctx={viewContext(reply)}
        model={{ link, error: t(message) }}
      />,
      { status },
    );
  }

  app.get(INSPIRATION_PATH, async (request, reply) => {
    const looks = await listInspirations(db, sessionUserId(request));
    return renderPage(
      reply,
      <InspirationListPage ctx={viewContext(reply)} looks={looks} />,
    );
  });

  app.get(NEW_INSPIRATION_PATH, async (_request, reply) =>
    renderPage(
      reply,
      <NewInspirationPage ctx={viewContext(reply)} model={{ link: '' }} />,
    ),
  );

  // The camera or library button of the add page: a native multipart post.
  app.post(INSPIRATION_PATH, async (request, reply) => {
    const id = await addUploadedInspiration(
      deps,
      sessionUserId(request),
      // One file: the photo (a second is a 413).
      request.files({ limits: { files: 1 } }),
    );
    return reply.redirect(inspirationUrl(id), 303);
  });

  // A pasted link: fetched here (importLink), then the look's page. A link
  // the server will not fetch is the add page again with the reason; past
  // the rate limit, the 429 error page (a native post shows it).
  app.post(
    INSPIRATION_LINK_PATH,
    { schema: { body: LinkBody } },
    async (request, reply) => {
      const retryAfter = await linkRetryAfter(request);
      if (retryAfter !== undefined) throw tooManyAttempts(retryAfter);
      const userId = sessionUserId(request);
      const typed = request.body.url;
      const link = linkIn(typed);
      if (!link) return refuseLink(reply, 'no-link', typed);
      try {
        const { id, unread } = await addLinkedInspiration(deps, userId, link);
        return reply.redirect(inspirationUrl(id, unread), 303);
      } catch (error) {
        if (!(error instanceof LinkImportError)) throw error;
        logger.warn(
          `Inspiration link by user ${userId} refused (${error.reason})`,
        );
        return refuseLink(reply, error.reason, typed);
      }
    },
  );

  app.get(
    LOOK_ROUTE,
    { schema: { params: LookParams, querystring: LookQuery } },
    async (request, reply) => {
      const look = await findInspiration(
        db,
        request.params.id,
        sessionUserId(request),
      );
      return renderPage(
        reply,
        <InspirationPage
          ctx={viewContext(reply)}
          look={look}
          unread={unreadReasonOf(request.query.unread)}
        />,
      );
    },
  );

  // The page's title and note (an AutosaveForm): answered with the form's
  // status line, never the fields; a plain post gets the page again.
  app.post(
    LOOK_ROUTE,
    { schema: { params: LookParams, body: TextBody } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = sessionUserId(request);
      const title = request.body.title.trim();
      const note = request.body.note.trim();
      await updateInspirationText(db, id, userId, {
        title: title || null,
        note: note || null,
      });
      logger.info(`Inspiration ${id} title and note saved by user ${userId}`);
      if (!request.headers['hx-request']) {
        return reply.redirect(inspirationUrl(id), 303);
      }
      return renderFragment(reply, <AutosaveSaved />);
    },
  );

  app.post(
    `${LOOK_ROUTE}/photo`,
    { schema: { params: LookParams } },
    async (request, reply) => {
      const { id } = request.params;
      await attachInspirationPhoto(
        deps,
        id,
        sessionUserId(request),
        request.files({ limits: { files: 1 } }),
      );
      return reply.redirect(inspirationUrl(id), 303);
    },
  );

  app.post(
    `${LOOK_ROUTE}/delete`,
    { schema: { params: LookParams } },
    async (request, reply) => {
      await removeInspiration(deps, request.params.id, sessionUserId(request));
      return reply.redirect(INSPIRATION_PATH, 303);
    },
  );

  // The images: the owner's session only (sendPrivatePhoto), never by name
  // alone, never under the public /file/**.
  const sendLookPhoto = (
    reply: FastifyReply,
    fileName: string,
    variant: 'original' | 'thumb',
    ownerId: number,
  ) =>
    sendPrivatePhoto({ photos, logger }, reply, {
      fileName,
      variant,
      ownerId,
      kind: 'Inspiration',
      isOwn: (name, owner) => isOwnInspirationPhoto(db, name, owner),
    });

  app.get(
    `${INSPIRATION_PHOTO_ROOT}/:fileName`,
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendLookPhoto(
        reply,
        request.params.fileName,
        'original',
        sessionUserId(request),
      ),
  );
  app.get(
    `${INSPIRATION_PHOTO_ROOT}/thumb/:fileName`,
    { schema: { params: FileParams } },
    async (request, reply) =>
      sendLookPhoto(
        reply,
        request.params.fileName,
        'thumb',
        sessionUserId(request),
      ),
  );

  done();
};
