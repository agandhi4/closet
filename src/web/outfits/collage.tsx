import { categoryRole, type GarmentRole } from '../../wardrobe/properties';
import { type SignablePhotoRef, imageUrl } from '../files/image-url';
import { HangerIcon } from '../layout/parts';

/**
 * An outfit laid out the way clothes lie on a bed: the layer and top side
 * by side, the bottom under them, the shoes at the foot, accessories and
 * bags down the side; cutouts contained (never cropped) on the plinth
 * colour, sized by height so a whole card (collage, name, pick) fits a
 * phone screen above the dock. The redesign's one OutfitCollage
 * (docs/plans/2026-09-26-redesign.md, sections 3 and 5): the gallery's
 * Ideas cards, the outfit page and Today (`card`), the Saved grid
 * (`tile`), the garment page's "In N outfits" and the calendar (`thumb`).
 */

export interface CollageGarment {
  id: number;
  name: string | null;
  category: string;
  photo: SignablePhotoRef | null;
}

const UPPER: readonly GarmentRole[] = ['layer', 'one-piece', 'top'];
const SIDE: readonly GarmentRole[] = ['accessory', 'bag', 'none'];

/**
 * The outfit without its side column (accessories, bags, `none`), for a
 * frame too narrow for it: the calendar month's ~48 px cells. Every garment
 * when the outfit is all side pieces. Shares `SIDE` with the collage's own
 * layout so the two never disagree.
 */
export function bodyOf<G extends CollageGarment>(garments: readonly G[]): G[] {
  const body = garments.filter((g) => !SIDE.includes(categoryRole(g.category)));
  return body.length > 0 ? body : [...garments];
}

/**
 * Each size's box, garment column and piece heights: `card` for a card a
 * phone screen holds whole, `tile` for the Saved grid's two columns (about
 * 170 px wide at 390 px: a 4:5 frame so the grid's rows line up, the
 * garments centred in it), `thumb` for a strip of small tiles (the garment
 * page's "In N outfits", about 96 px wide).
 */
const SIZES = {
  card: {
    box: 'rounded-box p-3 gap-2',
    column: '',
    upper: 'h-24',
    lower: 'h-28',
    feet: 'h-16',
    side: 'h-12',
  },
  tile: {
    box: 'rounded-box p-2 gap-1.5 aspect-[4/5]',
    column: 'justify-center',
    upper: 'h-12',
    lower: 'h-20',
    feet: 'h-10',
    side: 'h-9',
  },
  thumb: {
    box: 'rounded-field p-1.5 gap-1',
    column: '',
    upper: 'h-8',
    lower: 'h-10',
    feet: 'h-6',
    side: 'h-5',
  },
} as const;
export type CollageSize = keyof typeof SIZES;

export function OutfitCollage(props: {
  garments: readonly CollageGarment[];
  /** The first card on a page: its images load at once. */
  eager?: boolean;
  size?: CollageSize;
}) {
  const { garments, eager = false } = props;
  const size = props.size ?? 'card';
  const sizes = SIZES[size];
  const of = (roles: readonly GarmentRole[]) =>
    garments.filter((g) => roles.includes(categoryRole(g.category)));
  const upper = of(UPPER);
  const lower = of(['bottom']);
  const feet = of(['footwear']);
  const side = of(SIDE);
  const piece = (garment: CollageGarment, height: string) => (
    <CollagePiece
      garment={garment}
      class={height}
      eager={eager}
      labelled={size === 'card'}
    />
  );
  return (
    <div class={`bg-base-200 flex ${sizes.box}`}>
      <div
        class={['flex-1 flex flex-col items-center gap-1 min-w-0', sizes.column]
          .filter(Boolean)
          .join(' ')}
      >
        {upper.length > 0 && (
          <div class="flex justify-center gap-1 w-full">
            {upper.map((g) => piece(g, sizes.upper))}
          </div>
        )}
        {lower.map((g) => piece(g, sizes.lower))}
        {feet.length > 0 && (
          <div class="flex justify-center gap-1 w-full">
            {feet.map((g) => piece(g, sizes.feet))}
          </div>
        )}
      </div>
      {side.length > 0 && (
        <div class="flex flex-col justify-center gap-1">
          {side.map((g) => piece(g, sizes.side))}
        </div>
      )}
    </div>
  );
}

/** A garment of the collage: its thumb, or a hanger (and its name on a card). */
function CollagePiece(props: {
  garment: CollageGarment;
  class: string;
  eager: boolean;
  labelled: boolean;
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
      <HangerIcon
        class={props.labelled ? 'size-6' : 'size-4'}
        strokeWidth="1.5"
      />
      {props.labelled && (
        <span class="text-xs text-center line-clamp-2">{garment.name}</span>
      )}
    </span>
  );
}
