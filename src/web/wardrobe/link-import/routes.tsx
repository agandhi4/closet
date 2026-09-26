import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { sessionUserId } from '../../auth/require-session';
import { t } from '../../i18n';
import type { WebOptions } from '../../plugin';
import { renderFragment, renderPage } from '../../render';
import { LINK_IMPORT_LIMIT } from '../../security/rate-limit';
import { authorizeWardrobe } from '../../sharing/access';
import { viewContext } from '../../view-context';
import { renderGarmentForm } from '../render-form';
import { LINK_IMPORT_PATH, LINK_PHOTO_PATH } from '../urls';
import { OwnerQuery } from '../validation';
import { discardLinkPhoto, type WardrobeDeps } from '../writes';
import {
  fetchLinkPhoto,
  importLink,
  LINK_INPUT_MAX,
  linkIn,
  LinkImportError,
  type LinkImportRefusal,
  REFUSALS,
} from './import';
import { LinkPage } from './link-page';
import { LinkPhotoSlot } from './photo-choice';
import { importedForm } from './prefill';

// A share sheet's text can be a whole paragraph around the link; it is only
// scanned for the link (linkIn, linear), never stored.
const SHARED_TEXT_MAX = 16_384;

// The link page's query: the wardrobe, and the manifest's share target
// (src/web/shell/manifest.ts), which sends `title`, `text` and `url`
// (Android puts the link in either of the last two). Navigation state.
const LinkQuery = Type.Object({
  ...OwnerQuery.properties,
  url: Type.Optional(Type.String({ maxLength: SHARED_TEXT_MAX })),
  text: Type.Optional(Type.String({ maxLength: SHARED_TEXT_MAX })),
  title: Type.Optional(Type.String({ maxLength: SHARED_TEXT_MAX })),
});

const LinkBody = Type.Object({
  url: Type.String({ maxLength: LINK_INPUT_MAX }),
});

// A photo choice on the prefilled form: the picked photo's address ('' for
// no photo) and the pending photo it replaces.
const LinkPhotoBody = Type.Object({
  url: Type.Optional(Type.String({ maxLength: LINK_INPUT_MAX })),
  linkPhoto: Type.Optional(Type.String({ maxLength: 64 })),
});

/**
 * Adding a garment from a link (issue #6): the link page, the import that
 * answers the garment form prefilled (import.ts, prefill.ts), and the photo
 * choice on that form. The form posts to POST /wardrobe like any new
 * garment, which claims the pending photo; nothing is written to a garment
 * or `file` row before that. Adding is a write to the addressed wardrobe:
 * the owner or a MANAGE grantee (authorizeWardrobe). Both routes that fetch
 * are rate limited per user.
 */
export const linkImportRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, photos, fetcher } = options;
  const importDeps = { db, fetcher, photos, logger };
  const writeDeps: WardrobeDeps = {
    db,
    photos,
    logger,
    cutouts: options.cutouts,
  };

  function refuse(
    reply: FastifyReply,
    reason: LinkImportRefusal,
    link: string,
    viewOwner: number | undefined,
  ): Promise<FastifyReply> {
    const { message, status } = REFUSALS[reason];
    return renderPage(
      reply,
      <LinkPage
        ctx={viewContext(reply)}
        model={{ link, viewOwner, error: t(message) }}
      />,
      { status },
    );
  }

  // The link page, from the new garment form's "Add from a link" or a
  // share into the installed app. Fetches nothing: the person sees the
  // link and taps Fetch (a GET never writes, and a pending photo is one).
  app.get(
    LINK_IMPORT_PATH,
    { schema: { querystring: LinkQuery } },
    async (request, reply) => {
      const { viewOwner } = await authorizeWardrobe(
        db,
        sessionUserId(request),
        request.query.ownerId,
        'manage',
        'Garment not found',
      );
      const { url = '', text = '' } = request.query;
      const shared = `${url} ${text}`.trim();
      const link = linkIn(shared);
      if (shared) {
        logger.info(
          `Link import opened with a shared ${link ? 'link' : 'text without a link'} by user ${sessionUserId(request)}`,
        );
      }
      return renderPage(
        reply,
        <LinkPage
          ctx={viewContext(reply)}
          model={{
            link: link ?? '',
            viewOwner,
            error: shared && !link ? t(REFUSALS['no-link'].message) : undefined,
          }}
        />,
      );
    },
  );

  // Fetch the link and answer the garment form, prefilled (a 200 page, not
  // a redirect: nothing is saved to redirect to). A refusal is the link
  // page again with the reason.
  app.post(
    LINK_IMPORT_PATH,
    {
      config: { rateLimit: LINK_IMPORT_LIMIT },
      schema: { querystring: OwnerQuery, body: LinkBody },
    },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        sessionUserId(request),
        request.query.ownerId,
        'manage',
        'Garment not found',
      );
      const userId = sessionUserId(request);
      const typed = request.body.url;
      const link = linkIn(typed);
      if (!link) return refuse(reply, 'no-link', typed, viewOwner);
      try {
        const result = await importLink(importDeps, link, userId);
        const form = importedForm(result, link);
        logger.info(
          `Link import by user ${userId} into wardrobe ${access.ownerId}: ${result.kind}${form.link.photo ? `, photo ${form.link.photo} pending` : ', no photo'}, ${form.link.choices.length} choices`,
        );
        return await renderGarmentForm(reply, db, {
          mode: { kind: 'new' },
          suggestionsFrom: access.ownerId,
          viewOwner,
          values: form.values,
          link: form.link,
        });
      } catch (error) {
        if (!(error instanceof LinkImportError)) throw error;
        logger.warn(`Link import by user ${userId} refused (${error.reason})`);
        return refuse(reply, error.reason, typed, viewOwner);
      }
    },
  );

  // Another of the page's photos (or none) on the prefilled form: fetched
  // and stored as the pending photo, the one it replaces discarded (only if
  // it is this user's and still pending). Always answers the slot, a refusal with its message
  // (htmx would not swap a 4xx) and the photo it had.
  app.post(
    LINK_PHOTO_PATH,
    {
      config: { rateLimit: LINK_IMPORT_LIMIT },
      schema: { querystring: OwnerQuery, body: LinkPhotoBody },
    },
    async (request, reply) => {
      // The pending photo is the fetching user's, not the wardrobe's; the
      // wardrobe is still checked, so only someone who may add to it fetches.
      const userId = sessionUserId(request);
      await authorizeWardrobe(
        db,
        userId,
        request.query.ownerId,
        'manage',
        'Garment not found',
      );
      const current = request.body.linkPhoto || undefined;
      const url = request.body.url?.trim();
      let photo: string | undefined;
      if (url) {
        try {
          photo = await fetchLinkPhoto(importDeps, url, userId);
        } catch (error) {
          if (!(error instanceof LinkImportError)) throw error;
          logger.warn(
            `Link photo choice by user ${userId} refused (${error.reason})`,
          );
          return renderFragment(
            reply,
            <LinkPhotoSlot
              photo={current}
              errors={[t(REFUSALS[error.reason].message)]}
            />,
          );
        }
      }
      if (current) await discardLinkPhoto(writeDeps, current, userId);
      logger.info(
        `Link photo choice by user ${userId}: ${photo ?? 'no photo'}${current ? ` instead of ${current}` : ''}`,
      );
      return renderFragment(reply, <LinkPhotoSlot photo={photo} />);
    },
  );

  done();
};
