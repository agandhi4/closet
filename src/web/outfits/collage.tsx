import { categoryRole, type GarmentRole } from '../../wardrobe/properties';
import { type ImageRef, imageUrl } from '../files/image-url';
import { HangerIcon } from '../layout/parts';

/**
 * An outfit laid out the way clothes lie on a bed: the layer and top side
 * by side, the bottom under them, the shoes at the foot, accessories and
 * bags down the side; cutouts contained (never cropped) on the plinth
 * colour, sized by height so a whole card (collage, name, pick) fits a
 * phone screen above the dock. The redesign's one OutfitCollage (docs/plans/2026-09-26-redesign.md,
 * sections 3 and 5): the gallery's Ideas cards today; the Saved grid, the
 * outfit page, calendar entries and Today (R5, R6, #15) at other sizes.
 */

export interface CollageGarment {
  id: number;
  name: string | null;
  category: string;
  photo: ImageRef | null;
}

const UPPER: readonly GarmentRole[] = ['layer', 'one-piece', 'top'];
const SIDE: readonly GarmentRole[] = ['accessory', 'bag', 'none'];

export function OutfitCollage(props: {
  garments: readonly CollageGarment[];
  /** The first card on a page: its images load at once. */
  eager?: boolean;
}) {
  const { garments, eager = false } = props;
  const of = (roles: readonly GarmentRole[]) =>
    garments.filter((g) => roles.includes(categoryRole(g.category)));
  const upper = of(UPPER);
  const lower = of(['bottom']);
  const feet = of(['footwear']);
  const side = of(SIDE);
  const piece = (garment: CollageGarment, width: string) => (
    <CollagePiece garment={garment} class={width} eager={eager} />
  );
  return (
    <div class="bg-base-200 rounded-box p-3 flex gap-2">
      <div class="flex-1 flex flex-col items-center gap-1 min-w-0">
        {upper.length > 0 && (
          <div class="flex justify-center gap-1 w-full">
            {upper.map((g) => piece(g, 'h-24'))}
          </div>
        )}
        {lower.map((g) => piece(g, 'h-28'))}
        {feet.length > 0 && (
          <div class="flex justify-center gap-1 w-full">
            {feet.map((g) => piece(g, 'h-16'))}
          </div>
        )}
      </div>
      {side.length > 0 && (
        <div class="flex flex-col justify-center gap-1">
          {side.map((g) => piece(g, 'h-12'))}
        </div>
      )}
    </div>
  );
}

function CollagePiece(props: {
  garment: CollageGarment;
  class: string;
  eager: boolean;
}) {
  const { garment } = props;
  return garment.photo ? (
    <img
      src={imageUrl(garment.photo, 'thumb')}
      alt={garment.name ?? ''}
      class={`${props.class} w-auto max-w-full aspect-square object-contain`}
      width="200"
      height="200"
      loading={props.eager ? 'eager' : 'lazy'}
      decoding="async"
    />
  ) : (
    <span
      class={`${props.class} aspect-square max-w-full rounded-box bg-base-100 flex flex-col items-center justify-center gap-1 text-muted p-1`}
    >
      <HangerIcon class="size-6" strokeWidth="1.5" />
      <span class="text-xs text-center line-clamp-2">{garment.name}</span>
    </span>
  );
}
