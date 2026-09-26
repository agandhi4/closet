import { t } from '../i18n';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { Navbar } from '../layout/navbar';
import type { ViewContext } from '../view-context';
import { BackLink, GarmentThumb } from './parts';
import type { OutfitSummary } from './queries';

// The share link reaches the script as a data attribute, never spliced into
// the hyperscript source.
const COPY_SHARE_LINK = `on click
   call navigator.clipboard.writeText(@data-share-url)
   then add .btn-success then remove .btn-outline
   wait 1s
   then remove .btn-success then add .btn-outline`;

/** GET /outfits/:id: the outfit's garments in order, and edit, share, delete. */
export function OutfitPage(props: {
  ctx: ViewContext;
  outfit: OutfitSummary & { shareableId: string };
}) {
  const { ctx, outfit } = props;
  const name = outfit.name || t('UNTITLED_OUTFIT');
  const shareUrl = `${ctx.siteUrl}/share?shareableId=${outfit.shareableId}&type=outfit`;
  return (
    <Layout ctx={ctx} title={name}>
      <Navbar ctx={ctx} />
      <main class="p-4 pt-20 pb-24 max-w-lg mx-auto">
        <div class="flex items-center gap-3 mb-6">
          <BackLink href="/outfits" />
          <h1 class="text-2xl font-bold flex-1">{name}</h1>
        </div>
        {outfit.notes && (
          <p class="text-base-content/60 text-sm mb-6 px-1">{outfit.notes}</p>
        )}
        <h2 class="font-semibold mb-3">{t('GARMENTS_IN_OUTFIT')}</h2>
        {outfit.garments.length > 0 ? (
          <div class="flex flex-wrap gap-3 mb-8">
            {outfit.garments.map((garment) => (
              <a
                href={`/wardrobe/${garment.id}`}
                class="flex flex-col items-center gap-1 w-24"
              >
                <GarmentThumb garment={garment} class="rounded-box shadow-sm" />
                <span class="text-xs text-center line-clamp-2 leading-tight">
                  {garment.name}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <p class="text-base-content/40 text-sm italic mb-8">
            {t('OUTFIT_NO_GARMENTS')}
          </p>
        )}
        <div class="divider"></div>
        <div class="flex gap-3 justify-between items-center">
          <a
            href={`/outfits/${outfit.id}/edit?returnTo=/outfits/${outfit.id}`}
            class="btn btn-outline btn-sm"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"
              />
            </svg>
            {t('EDIT_OUTFIT')}
          </a>
          <button
            type="button"
            class="btn btn-outline btn-sm"
            data-share-url={shareUrl}
            _={COPY_SHARE_LINK}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.935-2.185 2.25 2.25 0 0 0-3.935 2.185Z"
              />
            </svg>
            {t('SHARE')}
          </button>
          <button
            type="button"
            hx-delete={`/outfits/${outfit.id}`}
            hx-confirm={t('CONFIRM_DELETE')}
            class="btn btn-error btn-sm btn-outline"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              class="size-4"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
              />
            </svg>
            {t('DELETE')}
          </button>
        </div>
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
