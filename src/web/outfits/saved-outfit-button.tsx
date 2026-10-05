import { imageUrl } from '../files/image-url';
import { t } from '../i18n';
import { HangerIcon } from '../layout/parts';
import type { GarmentOutfit } from './queries';
import { buyFirstNote } from './to-buy';

/** Garments shown per saved outfit: three fit beside the name at phone width. */
const THUMBS = 3;

/**
 * One saved outfit as a submit button of a picking form (its id is the
 * submitter's value, `outfitId`): the calendar's plan page and a trip's add
 * page (#10). Disabled, saying why, when picking it would change nothing
 * (`note`: already on the day, already on the trip) or be refused: an
 * incomplete outfit (#335) is neither planned nor packed until its pieces
 * are bought. Disabled reads through the card (flat, on the plinth colour)
 * and its dimmed thumbs; the name and the reason stay at full strength
 * (text is never dimmed: Conventions).
 */
export function SavedOutfitButton(props: {
  outfit: GarmentOutfit;
  note: string | undefined;
}) {
  const { outfit } = props;
  const note = props.note ?? buyFirstNote(outfit.garments);
  return (
    <button
      type="submit"
      name="outfitId"
      value={String(outfit.id)}
      class="group card card-side bg-base-100 shadow-sm items-center gap-3 p-2 text-left disabled:bg-base-200 disabled:shadow-none disabled:cursor-not-allowed"
      disabled={note !== undefined}
    >
      <span class="flex gap-1 shrink-0 group-disabled:opacity-50">
        {outfit.garments.slice(0, THUMBS).map((garment) =>
          garment.photo ? (
            <img
              src={imageUrl(garment.photo, 'thumb')}
              alt=""
              class="size-12 rounded object-cover"
              width="48"
              height="48"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span class="size-12 rounded bg-base-200 flex items-center justify-center">
              <HangerIcon class="size-5 text-faint" strokeWidth="1.5" />
            </span>
          ),
        )}
      </span>
      <span class="flex flex-col min-w-0">
        <span class="font-medium truncate">
          {outfit.name || t('UNTITLED_OUTFIT')}
        </span>
        {note && <span class="text-xs text-muted">{note}</span>}
      </span>
    </button>
  );
}
