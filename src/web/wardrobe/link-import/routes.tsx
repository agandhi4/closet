import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessionUserId } from '../../auth/require-session';
import { t } from '../../i18n';
import type { WebOptions } from '../../plugin';
import { renderFragment, renderPage } from '../../render';
import { loggableUrl } from '../../loggable-url';
import { LINK_IMPORT_LIMIT, tooManyAttempts } from '../../security/rate-limit';
import { authorizeWardrobe } from '../../sharing/access';
import { viewContext } from '../../view-context';
import { resolveDestination } from '../destination';
import { renderGarmentForm } from '../render-form';
import { type Destination, LINK_IMPORT_PATH, LINK_PHOTO_PATH } from '../urls';
import { DestinationQuery, OwnerQuery } from '../validation';
import { discardPendingPhoto, type WardrobeDeps } from '../writes';
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
  ...DestinationQuery.properties,
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
 * share one per-user rate limit (linkImportLimit).
 */
export const linkImportRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  const { db, logger, photos, fetcher } = options;
  const importDeps = { db, fetcher, photos, logger };
  // ONE counter for both routes that fetch: the import and its photo
  // choice spend the same LINK_IMPORT_LIMIT. Never a route's
  // `config.rateLimit` beside it: every one of those, and every
  // createRateLimit call, gets a store of its own (LocalStore.child), so
  // each route would allow the full ten. A checker, not route config, also
  // lets the photo choice (an hx-post; htmx swaps no 429) answer its slot.
  const linkImportLimit = app.createRateLimit(LINK_IMPORT_LIMIT);
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
    destination: Destination,
  ): Promise<FastifyReply> {
    const { message, status } = REFUSALS[reason];
    return renderPage(
      reply,
      <LinkPage
        ctx={viewContext(reply)}
        model={{ link, viewOwner, destination, error: t(message) }}
      />,
      { status },
    );
  }

  /**
   * Counts a fetching request against linkImportLimit: the seconds until
   * it may retry when past the limit (logged), else undefined.
   */
  async function linkImportRetryAfter(
    request: FastifyRequest,
  ): Promise<number | undefined> {
    const verdict = await linkImportLimit(request);
    // `isAllowed` is the plugin's allow list; the count is isExceeded.
    if (verdict.isAllowed || !verdict.isExceeded) return undefined;
    logger.warn(
      `Rate limit reached: ${request.method} ${loggableUrl(request)} for user ${sessionUserId(request)}`,
    );
    return verdict.ttlInSeconds;
  }

  // The link page, from the new garment form's "Add from a link", the
  // wishlist's (`?to=wishlist`, carried to the form) or a share into the
  // installed app (the closet). Fetches nothing: the person sees the link
  // and taps Fetch (a GET never writes, and a pending photo is one).
  app.get(
    LINK_IMPORT_PATH,
    { schema: { querystring: LinkQuery } },
    async (request, reply) => {
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        sessionUserId(request),
        request.query.ownerId,
        'manage',
        'Garment not found',
      );
      const { destination } = await resolveDestination(
        db,
        request.query,
        access,
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
            destination,
            error: shared && !link ? t(REFUSALS['no-link'].message) : undefined,
          }}
        />,
      );
    },
  );

  // Fetch the link and answer the garment form, prefilled (a 200 page, not
  // a redirect: nothing is saved to redirect to). A refusal is the link
  // page again with the reason; past the rate limit, the 429 error page (a
  // native post shows it).
  app.post(
    LINK_IMPORT_PATH,
    { schema: { querystring: DestinationQuery, body: LinkBody } },
    async (request, reply) => {
      const retryAfter = await linkImportRetryAfter(request);
      if (retryAfter !== undefined) throw tooManyAttempts(retryAfter);
      const { access, viewOwner } = await authorizeWardrobe(
        db,
        sessionUserId(request),
        request.query.ownerId,
        'manage',
        'Garment not found',
      );
      const { destination, candidateFor } = await resolveDestination(
        db,
        request.query,
        access,
      );
      const userId = sessionUserId(request);
      const typed = request.body.url;
      const link = linkIn(typed);
      if (!link) return refuse(reply, 'no-link', typed, viewOwner, destination);
      try {
        const result = await importLink(importDeps, link, userId);
        const form = importedForm(result, link);
        logger.info(
          `Link import by user ${userId} into wardrobe ${access.ownerId} (${destination.to}): ${result.kind}${form.link.photo ? `, photo ${form.link.photo} pending` : ', no photo'}, ${form.link.choices.length} choices`,
        );
        return await renderGarmentForm(reply, db, {
          mode: { kind: 'new', destination },
          suggestionsFrom: access.ownerId,
          viewOwner,
          values: {
            ...form.values,
            replaces:
              destination.replaces === undefined
                ? ''
                : String(destination.replaces),
          },
          link: form.link,
          candidateFor,
        });
      } catch (error) {
        if (!(error instanceof LinkImportError)) throw error;
        logger.warn(`Link import by user ${userId} refused (${error.reason})`);
        return refuse(reply, error.reason, typed, viewOwner, destination);
      }
    },
  );

  // Another of the page's photos (or none) on the prefilled form: fetched
  // and stored as the pending photo, the one it replaces discarded (only if
  // it is this user's and still pending). Always answers the slot, a
  // refusal (the rate limit's included) with its message and the photo it
  // had: htmx would not swap a 4xx.
  app.post(
    LINK_PHOTO_PATH,
    { schema: { querystring: OwnerQuery, body: LinkPhotoBody } },
    async (request, reply) => {
      const userId = sessionUserId(request);
      const current = request.body.linkPhoto || undefined;
      if ((await linkImportRetryAfter(request)) !== undefined) {
        return renderFragment(
          reply,
          <LinkPhotoSlot
            photo={current}
            errors={[t('linkImport.RATE_LIMITED')]}
          />,
        );
      }
      // The pending photo is the fetching user's, not the wardrobe's; the
      // wardrobe is still checked, so only someone who may add to it fetches.
      const { access } = await authorizeWardrobe(
        db,
        userId,
        request.query.ownerId,
        'manage',
        'Garment not found',
      );
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
      if (current) {
        await discardPendingPhoto(writeDeps, current, {
          userId,
          ownerId: access.ownerId,
        });
      }
      logger.info(
        `Link photo choice by user ${userId}: ${photo ?? 'no photo'}${current ? ` instead of ${current}` : ''}`,
      );
      return renderFragment(reply, <LinkPhotoSlot photo={photo} />);
    },
  );

  done();
};
