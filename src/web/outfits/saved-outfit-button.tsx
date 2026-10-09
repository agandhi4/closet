import { t } from '../i18n';
import { collagePieces, OutfitCollage } from './collage';
import type { GarmentOutfit } from './queries';
import { buyFirstNote } from './to-buy';

/**
 * One saved outfit as a submit button of a picking form (its id is the
 * submitter's value, `outfitId`): the calendar's plan page and a trip's add
 * page (#10). The whole outfit as its `row` collage over the name, as a
 * trip's own rows show it (#360). Disabled, saying why, when picking it
 * would change nothing (`note`: already on the day, already on the trip) or
 * be refused: an incomplete outfit (#335) is neither planned nor packed
 * until its pieces are bought. Disabled reads through the card (flat, on
 * the plinth colour) and its dimmed picture; the name and the reason stay
 * at full strength (text is never dimmed: Conventions). The picture is
 * hidden from assistive tech, as the old thumbs' empty alts were: the
 * button's name is the outfit's, and the note says what is to buy.
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
      class="group card bg-base-100 shadow-sm gap-2 p-2 text-left disabled:bg-base-200 disabled:shadow-none disabled:cursor-not-allowed"
      disabled={note !== undefined}
    >
      <span class="flex min-w-0 group-disabled:opacity-50" aria-hidden="true">
        <OutfitCollage
          garments={collagePieces(outfit.garments, { warn: false })}
          size="row"
        />
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
