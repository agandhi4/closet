import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { t } from '../i18n';
import type { WebOptions } from '../plugin';
import { renderPage } from '../render';
import { requestOrigin } from '../security/origin';
import { viewContext } from '../view-context';
import { findSharedGarment, findSharedOutfit } from './queries';
import { type Shared, SharePage, type SharePreview } from './share-page';

// Navigation state from a link, never a 400: a missing or unknown value
// renders the empty page, as a link to a deleted item does.
const ShareQuery = Type.Object({
  shareableId: Type.Optional(Type.String({ maxLength: 255 })),
  type: Type.Optional(Type.String()),
});

async function findShared(
  options: WebOptions,
  type: string | undefined,
  shareableId: string,
): Promise<Shared | undefined> {
  if (type === 'garment') {
    const garment = await findSharedGarment(options.db, shareableId);
    return garment && { type, garment };
  }
  if (type === 'outfit') {
    const outfit = await findSharedOutfit(options.db, shareableId);
    return outfit && { type, outfit };
  }
  return undefined;
}

/** The Open Graph values of a found item; absolute URLs on the request's origin. */
function sharePreview(
  origin: string,
  shareableId: string,
  shared: Shared,
): SharePreview {
  const item =
    shared.type === 'garment'
      ? {
          name: shared.garment.name,
          owner: shared.garment.owner,
          photo: shared.garment.photo,
        }
      : {
          name: shared.outfit.name,
          owner: shared.outfit.owner,
          // The first garment, in the outfit's order, with a photo.
          photo: shared.outfit.garments.find((g) => g.photo)?.photo,
        };
  return {
    url: `${origin}/share?shareableId=${encodeURIComponent(shareableId)}&type=${shared.type}`,
    title: item.name ?? undefined,
    description: `${t('SHARED_BY')} ${item.owner.email}`,
    image: item.photo
      ? `${origin}/file/watermark/${item.photo.shareableId}`
      : undefined,
  };
}

/**
 * GET /share?shareableId=&type=garment|outfit: the public landing page of a
 * share link (the garment page's and the outfit page's Share buttons build
 * it on SITE_URL). Public: the link is the credential, and crawlers fetch it
 * for the preview. The preview image is the first photo's watermarked
 * rendition (/file/watermark/:shareableId, src/web/files/routes.ts).
 */
export const shareRoutes: FastifyPluginCallbackTypebox<WebOptions> = (
  app,
  options,
  done,
) => {
  app.get(
    '/share',
    { config: { public: true }, schema: { querystring: ShareQuery } },
    async (request, reply) => {
      const { shareableId = '', type } = request.query;
      const shared = shareableId
        ? await findShared(options, type, shareableId)
        : undefined;
      const preview =
        shared && sharePreview(requestOrigin(request), shareableId, shared);
      return renderPage(
        reply,
        <SharePage
          ctx={viewContext(reply)}
          shared={shared}
          preview={preview}
        />,
      );
    },
  );
  done();
};
