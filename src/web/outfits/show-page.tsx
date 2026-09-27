import { dayLabel } from '../calendar/labels';
import { AlreadySavedToast } from '../gallery/already-saved';
import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { Dock } from '../layout/dock';
import { Layout } from '../layout/layout';
import { EntrySelfie, SelfieView } from '../selfies/views';
import { ShareLinkButton } from '../share/share-button';
import { stylingUrl } from '../styling/urls';
import type { ViewContext } from '../view-context';
import { GarmentThumb } from '../layout/parts';
import type { OutfitSummary, WornDay } from './queries';

/**
 * GET /outfits/:id: the outfit's garments in order, the days it was worn
 * with their selfies (#19), and edit, share, delete. The owner's own page
 * (outfits are private); the public share page (src/web/share) shows the
 * garments only, never the Worn strip.
 */
export function OutfitPage(props: {
  ctx: ViewContext;
  outfit: OutfitSummary & { shareableId: string };
  /** Worn entries, newest first (wornDays). */
  worn: WornDay[];
  /** The gallery's pick found this outfit already saved (?alreadySaved=1). */
  alreadySaved?: boolean;
}) {
  const { ctx, outfit } = props;
  const name = outfit.name || t('UNTITLED_OUTFIT');
  return (
    <Layout ctx={ctx} title={name}>
      <AppBar ctx={ctx} title={name} back="/outfits" />
      <main class="p-4 pt-20 pb-24 w-full max-w-lg mx-auto">
        {outfit.notes && (
          <p class="text-muted text-sm mb-6 px-1">{outfit.notes}</p>
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
          <p class="text-muted text-sm italic mb-8">
            {t('OUTFIT_NO_GARMENTS')}
          </p>
        )}
        {props.worn.length > 0 && (
          <WornStrip outfitId={outfit.id} worn={props.worn} />
        )}
        <div class="divider"></div>
        <div class="flex gap-3 justify-between items-center">
          <a
            href={stylingUrl({
              outfitId: outfit.id,
              returnTo: `/outfits/${outfit.id}`,
            })}
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
          <ShareLinkButton
            siteUrl={ctx.siteUrl}
            type="outfit"
            shareableId={outfit.shareableId}
          />
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
      <AlreadySavedToast shown={props.alreadySaved === true} />
      <Dock ctx={ctx} />
    </Layout>
  );
}

/**
 * "Worn": every day the outfit was worn, newest first, as the looks were
 * actually worn: its selfie, or a tile with the camera to add one (taken
 * later from the phone's library, most likely). Each day links its week.
 */
function WornStrip(props: { outfitId: number; worn: WornDay[] }) {
  const returnTo = `/outfits/${props.outfitId}`;
  return (
    <section class="mb-8" data-worn-strip="">
      <h2 class="font-semibold mb-3">
        {t('selfie.WORN_HEADING', { count: props.worn.length })}
      </h2>
      <div class="flex overflow-x-auto overscroll-x-contain gap-3 pb-2">
        {props.worn.map(({ entryId, day, selfie }) => (
          <div
            class="flex flex-col items-center gap-1 shrink-0 w-28"
            data-worn-day={day}
          >
            {selfie ? (
              <SelfieView
                selfie={selfie}
                day={day}
                entryId={entryId}
                returnTo={returnTo}
                size="strip"
              />
            ) : (
              <div class="h-36 aspect-[3/4] rounded-box bg-base-200 flex items-center justify-center">
                <EntrySelfie
                  entryId={entryId}
                  day={day}
                  selfie={null}
                  canTake
                  returnTo={returnTo}
                  size="strip"
                />
              </div>
            )}
            <a
              href={`/calendar?week=${day}`}
              class="text-xs text-center link link-hover leading-tight"
            >
              {dayLabel(day)}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
