import { categoryRole, type GarmentRole } from '../../wardrobe/properties';
import type { GarmentStatus } from '../../wardrobe/status';
import { type SignablePhotoRef, imageUrl } from '../files/image-url';
import { viewerTrigger } from '../files/photo-viewer';
import { t } from '../i18n';
import { HangerIcon } from '../layout/parts';
import { isPieceToBuy } from './references';

/**
 * An outfit laid out the way clothes lie on a bed: the layer and top side
 * by side, the bottom under them, the shoes at the foot, accessories and
 * bags down the side; cutouts contained (never cropped) on the plinth
 * colour, sized by height so a whole card (collage, name, pick) fits a
 * phone screen above the dock. The redesign's one OutfitCollage
 * (docs/plans/2026-09-26-redesign.md, sections 3 and 5): the gallery's
 * Ideas cards, the outfit page and Today (`card`), the Saved grid
 * (`tile`), the garment page's "In N outfits" and the calendar (`cell`, a `thumb` that grows at lg),
 * a plan's looks (`look`, #291), whose pieces carry marks, and the plans
 * list's photo row (`cover`, #302: five 4:5 cells across a phone).
 */

/**
 * A piece that is not simply owned: `to-buy`, a plan look's candidate
 * product (#291) or an incomplete outfit's piece not bought yet (#335; an
 * outfit's garment with its status, marked by the collage itself: markOf),
 * drawn with Styling's To buy badge; or `missing`, a look's slot holding
 * nothing it can use (a dashed place where its role goes).
 */
export type CollageMark = 'to-buy' | 'missing';

/**
 * Whether a piece opens the photo viewer, and so is in its set (#313): the
 * set's builder and the piece's trigger must agree, or a tap opens the
 * wrong slide.
 */
export function inViewerSet(piece: CollagePieceView): boolean {
  return piece.photo !== null && markOf(piece) !== 'missing';
}

/** What the collage draws of a piece; a look's emptied slot has no garment id. */
export interface CollagePieceView {
  name: string | null;
  category: string;
  photo: SignablePhotoRef | null;
  mark?: CollageMark;
  /** An outfit's garment's: a wishlist one is drawn as `to-buy`. */
  status?: GarmentStatus;
}

/** The piece's mark: its own (a look's), or `to-buy` for an outfit's piece not bought yet. */
function markOf(piece: CollagePieceView): CollageMark | undefined {
  if (piece.mark) return piece.mark;
  return piece.status && isPieceToBuy({ status: piece.status })
    ? 'to-buy'
    : undefined;
}

export interface CollageGarment extends CollagePieceView {
  id: number;
}

const UPPER: readonly GarmentRole[] = ['layer', 'one-piece', 'top'];
const SIDE: readonly GarmentRole[] = ['accessory', 'bag', 'none'];

/**
 * The outfit without its side column (accessories, bags, `none`), for a
 * frame too narrow for it: the calendar month's ~48 px cells. Every garment
 * when the outfit is all side pieces. Shares `SIDE` with the collage's own
 * layout so the two never disagree.
 */
export function bodyOf<G extends CollagePieceView>(
  garments: readonly G[],
): G[] {
  const body = garments.filter((g) => !SIDE.includes(categoryRole(g.category)));
  return body.length > 0 ? body : [...garments];
}

/**
 * Each size's box, garment column and piece heights: `card` for a card a
 * phone screen holds whole, `tile` for the Saved grid's two columns (about
 * 170 px wide at 390 px: a 4:5 frame so the grid's rows line up, the
 * garments centred in it), `thumb` for a strip of small tiles (the garment
 * page's "In N outfits", about 96 px wide), `look` for a plan look's card
 * in a snap strip (224 px wide: a 4:5 frame, so every card of the strip is
 * the same height, with pieces large enough to carry a badge).
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
    box: 'rounded-box p-2 gap-1.5 aspect-[4/5] lg:p-3 lg:gap-2',
    column: 'justify-center',
    upper: 'h-12 lg:h-16',
    lower: 'h-20 lg:h-24',
    feet: 'h-10 lg:h-14',
    side: 'h-9 lg:h-12',
  },
  thumb: {
    box: 'rounded-field p-1.5 gap-1',
    column: '',
    upper: 'h-8',
    lower: 'h-10',
    feet: 'h-6',
    side: 'h-5',
  },
  // The calendar month's cell: `thumb` on a phone (about 48 px wide), growing
  // with the cell at lg (about 170 px).
  cell: {
    box: 'rounded-field p-1.5 gap-1 lg:p-3 lg:gap-2',
    column: '',
    upper: 'h-8 lg:h-16',
    lower: 'h-10 lg:h-20',
    feet: 'h-6 lg:h-12',
    side: 'h-5 lg:h-10',
  },
  cover: {
    box: 'rounded-field p-1 gap-0.5 aspect-[4/5]',
    column: 'justify-center',
    upper: 'h-5',
    lower: 'h-7',
    feet: 'h-4',
    side: 'h-3',
  },
  look: {
    box: 'rounded-box p-2 gap-1.5 aspect-[4/5]',
    column: 'justify-center',
    upper: 'h-20',
    lower: 'h-28',
    feet: 'h-14',
    side: 'h-12',
  },
} as const;
export type CollageSize = keyof typeof SIZES;

export function OutfitCollage(props: {
  garments: readonly CollagePieceView[];
  /** The first card on a page: its images load at once. */
  eager?: boolean;
  size?: CollageSize;
  /**
   * A photo viewer set (PhotoSet) whose id makes each photo a button that
   * opens it (#313). Only where the collage is not itself inside a link or
   * button.
   */
  viewerSet?: string;
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
  const piece = (garment: CollagePieceView, height: string) => (
    <CollagePiece
      garment={garment}
      class={height}
      eager={eager}
      viewerSet={props.viewerSet}
      labelled={size === 'card'}
      words={size !== 'thumb' && size !== 'cell' && size !== 'cover'}
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

/**
 * A garment of the collage: its thumb, or a hanger (and its name on a
 * card). A missing piece is a dashed place of the same size; a piece to buy
 * wears Styling's badge over its foot. A thumb's pieces are too small for
 * words: the dashed place is empty and the badge a dot, each saying what
 * it means to screen readers only.
 */
function CollagePiece(props: {
  garment: CollagePieceView;
  class: string;
  eager: boolean;
  viewerSet: string | undefined;
  labelled: boolean;
  words: boolean;
}) {
  const { garment, words } = props;
  const mark = markOf(garment);
  if (mark === 'missing') {
    return (
      <span
        class={`${props.class} aspect-square max-w-full rounded-box border border-dashed border-warning flex items-center justify-center p-1`}
        data-missing-piece=""
      >
        <span
          class={
            words ? 'text-xs text-warning text-center leading-tight' : 'sr-only'
          }
        >
          {t('plans.looks.MISSING')}
        </span>
      </span>
    );
  }
  const face = <CollageFace {...props} />;
  if (mark !== 'to-buy') return face;
  return (
    <span class="relative flex justify-center max-w-full">
      {face}
      {words ? (
        <ToBuyBadge />
      ) : (
        <span
          class="absolute bottom-0 right-0 size-2 rounded-full bg-accent"
          data-to-buy=""
        >
          <span class="sr-only">{t('plans.looks.TO_BUY')}</span>
        </span>
      )}
    </span>
  );
}

/**
 * Styling's To buy badge over a piece's foot (its parent is `relative`):
 * the collage's pieces and the public share page's thumbs.
 */
export function ToBuyBadge() {
  return (
    <span
      class="badge badge-accent badge-xs absolute bottom-0 left-1/2 -translate-x-1/2 whitespace-nowrap"
      data-to-buy=""
    >
      {t('plans.looks.TO_BUY')}
    </span>
  );
}

function CollageFace(props: {
  garment: CollagePieceView;
  class: string;
  eager: boolean;
  viewerSet: string | undefined;
  labelled: boolean;
}) {
  const { garment } = props;
  const viewer =
    props.viewerSet && inViewerSet(garment)
      ? {
          ...viewerTrigger(props.viewerSet, garment.photo!),
          role: 'button',
          tabindex: '0',
        }
      : {};
  return garment.photo ? (
    <img
      src={imageUrl(garment.photo, 'thumb')}
      alt={garment.name ?? ''}
      {...viewer}
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
