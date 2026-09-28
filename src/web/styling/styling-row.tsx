import type { GarmentRole } from '../../wardrobe/properties';
import { imageUrl } from '../files/image-url';
import { t, type StringKey } from '../i18n';
import { HangerIcon } from '../layout/parts';
import { categoryLabel } from '../wardrobe/garment';
import { garmentUrl } from '../wardrobe/urls';
import type { RowGarment, StylingRow } from './rows';
import { STYLING_GARMENTS_PATH, type StylingState, stylingUrl } from './urls';

/**
 * A Styling row (#42): a role's strip of garments, scroll-snap with the
 * neighbours peeking, "No garment" first; the centred garment is the row's
 * choice. Swiping is the browser's own scrolling (no touch handlers): the
 * page's module (public/js/styling.js) watches which item crosses the
 * strip's centre line and writes it into the row's `garmentId`, which is
 * what Save and Shuffle post, with `role` and `lock`, one of each per row
 * in document order. The server marks the chosen item `data-selected`; the
 * module centres it on load, after a swap and after a history restore.
 *
 * What the row shows is CSS off that state (#106): the chosen item's plinth
 * wears a ring (PLINTH_STATE), and a locked row is frozen: its strip stops
 * scrolling sideways (`overflow-x: hidden`, `touch-action: pan-y
 * pinch-zoom`, so the page still scrolls under a thumb and still zooms under
 * two; `pan-y` alone turned pinch-zoom off over the strip) and its
 * neighbours fade, until the lock is lifted and the strip swipes again from
 * the same item. The neighbours are also `inert` (#146, see `itemState`).
 */

const ROLE_LABELS: Record<GarmentRole, StringKey> = {
  layer: 'styling.role.layer',
  'one-piece': 'styling.role.one-piece',
  top: 'styling.role.top',
  bottom: 'styling.role.bottom',
  footwear: 'styling.role.footwear',
  accessory: 'styling.role.accessory',
  bag: 'styling.role.bag',
  none: 'styling.role.none',
};

export function roleLabel(role: GarmentRole): string {
  return t(ROLE_LABELS[role]);
}

/** Accessories, bags and the rest ride along: smaller items, so the outfit leads. */
const SMALL: readonly GarmentRole[] = ['accessory', 'bag', 'none'];

/**
 * An item's width and the strip's end spacers go together: each spacer is
 * half the strip less half an item and the strip's gap (`gap-3`, 0.75rem,
 * also falls between a spacer and its item), so the first and last items
 * can be centred and the neighbours peek in what is left. Spacers, not
 * padding (#179): WebKit leaves a flex scroller's end padding out of its
 * scrollable width when the items alone fit, so a row of "No garment" and
 * one garment could not scroll at all in Safari and the garment was never
 * chosen. The width is fixed, not a percentage: a flex item's percentage
 * would resolve against the strip, not the item's share of it.
 */
function sizing(role: GarmentRole): { item: string; strip: string } {
  return SMALL.includes(role)
    ? {
        item: 'w-20',
        strip:
          'before:w-[calc(50%-3.25rem)] after:w-[calc(50%-3.25rem)] before:shrink-0 after:shrink-0',
      }
    : {
        item: 'w-28',
        strip:
          'before:w-[calc(50%-4.25rem)] after:w-[calc(50%-4.25rem)] before:shrink-0 after:shrink-0',
      };
}

/**
 * The chosen item's plinth wears an ink ring, inset so the strip's own
 * clipping never cuts it. In a locked row the ring takes the lock's clay
 * accent (the theme's "used sparingly": a locked row is one of its uses)
 * and the neighbours fade, so the frozen row reads as one at a glance.
 */
const PLINTH_STATE =
  'ring-inset group-data-selected/item:ring-2 group-data-selected/item:ring-primary group-data-selected/item:group-has-[.styling-lock:checked]/row:ring-accent group-not-data-selected/item:group-has-[.styling-lock:checked]/row:opacity-40';

/**
 * An item's choice attributes. In a locked row the neighbours are `inert`
 * (#146): a frozen strip cannot scroll to reveal one, so Tab reaching it
 * left the focus off-screen; inert takes them out of the tab order, out of
 * the accessibility tree (they are not choosable, so the listbox offers the
 * chosen garment alone, beside a checked "Lock <role>") and out of hit
 * testing (a tap on one lands on the strip). The server renders it so a row
 * opened locked is right from the first paint; styling.js keeps it in step
 * when the lock is toggled and when a strip's next page arrives
 * (`syncLock`).
 */
function itemState(props: { selected: boolean; locked: boolean }) {
  return {
    'data-selected': props.selected ? '' : undefined,
    'aria-selected': props.selected ? 'true' : 'false',
    inert: props.locked && !props.selected,
  } as const;
}

/** What a row's links and sentinel need of the page. */
export interface RowContext {
  state: StylingState;
  /** The shared wardrobe shown (garment links carry it), undefined for one's own. */
  viewOwner: number | undefined;
}

export function StylingRowView(props: {
  row: StylingRow;
  context: RowContext;
}) {
  const { row, context } = props;
  const label = roleLabel(row.role);
  const { strip } = sizing(row.role);
  return (
    <section
      class="group/row flex flex-col gap-1"
      data-styling-row={row.role}
      aria-label={label}
    >
      <div class="flex items-center justify-between px-4">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
        </h2>
        <LockToggle locked={row.locked} label={label} />
      </div>
      <div
        class={`styling-strip relative flex gap-3 overflow-x-auto snap-x snap-mandatory overscroll-x-contain group-has-[.styling-lock:checked]/row:overflow-x-hidden group-has-[.styling-lock:checked]/row:touch-pan-y group-has-[.styling-lock:checked]/row:touch-pinch-zoom ${strip}`}
        role="listbox"
        aria-label={t('styling.STRIP_LABEL', { role: label })}
      >
        <NoGarment
          role={row.role}
          selected={row.garmentId === null}
          locked={row.locked}
        />
        {row.garments.map((garment) => (
          <GarmentItem
            garment={garment}
            role={row.role}
            selected={garment.id === row.garmentId}
            locked={row.locked}
            detached={garment.id === row.detachedId}
            viewOwner={context.viewOwner}
          />
        ))}
        {row.moreBefore !== undefined && (
          <StripSentinel
            role={row.role}
            before={row.moreBefore}
            context={context}
          />
        )}
      </div>
      <input type="hidden" name="role" value={row.role} />
      <input type="hidden" name="garmentId" value={row.garmentId ?? ''} />
      <input type="hidden" name="lock" value={row.locked ? '1' : ''} />
    </section>
  );
}

/**
 * Lock: the row is frozen (no swiping, see the header) and Shuffle leaves
 * it as it is. The checkbox has no name: styling.js (`setLocked`) writes
 * the row's `lock` field, which posts in step with its `role` and
 * `garmentId` (an unchecked box would post nothing and shift the lists),
 * mirrors its state into its `checked` attribute, which htmx's history
 * snapshot (innerHTML) keeps, so a row restored by Back is still frozen and
 * still reads locked, and makes the neighbours inert or not.
 */
function LockToggle(props: { locked: boolean; label: string }) {
  return (
    // daisyUI's swap: the label is the control (its input has no box), so
    // it shows the keyboard focus its checkbox has.
    <label class="swap btn btn-ghost btn-xs btn-circle has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
      <input
        type="checkbox"
        class="styling-lock"
        checked={props.locked}
        aria-label={t('styling.LOCK', { role: props.label })}
      />
      {/* Heroicons' lock-closed and lock-open, outline. */}
      <svg
        class="swap-on size-4 text-accent"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
      <svg
        class="swap-off size-4 text-muted"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke-width="1.5"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      </svg>
    </label>
  );
}

/** The builder's position 0: the row adds nothing to the outfit. */
function NoGarment(props: {
  role: GarmentRole;
  selected: boolean;
  locked: boolean;
}) {
  const { item } = sizing(props.role);
  return (
    <button
      type="button"
      class={`styling-item group/item snap-center snap-always shrink-0 ${item} flex flex-col gap-1`}
      role="option"
      data-garment-id=""
      {...itemState(props)}
    >
      <span
        class={`aspect-square w-full rounded-box border border-dashed border-base-300 flex items-center justify-center text-faint text-2xl ${PLINTH_STATE}`}
      >
        —
      </span>
      <span class="text-xs text-muted truncate">{t('styling.NO_GARMENT')}</span>
    </button>
  );
}

/**
 * A garment on the plinth, its cutout contained (never cropped). A tap on
 * the centred one opens its page; a tap on a neighbour centres it
 * (styling.js). The strips show the 400 px thumb, made from the cutout.
 */
function GarmentItem(props: {
  garment: RowGarment;
  role: GarmentRole;
  selected: boolean;
  locked: boolean;
  detached: boolean;
  viewOwner: number | undefined;
}) {
  const { garment } = props;
  const { item } = sizing(props.role);
  return (
    <a
      href={garmentUrl(garment.id, props.viewOwner)}
      class={`styling-item group/item snap-center snap-always shrink-0 ${item} flex flex-col gap-1 no-underline`}
      role="option"
      data-garment-id={garment.id}
      {...itemState(props)}
    >
      <span
        class={`aspect-square w-full rounded-box bg-base-200 flex items-center justify-center p-2 ${PLINTH_STATE}`}
      >
        {garment.photo ? (
          <img
            src={imageUrl(garment.photo, 'thumb')}
            alt=""
            class="max-h-full max-w-full object-contain"
            width="200"
            height="200"
            loading={props.selected ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : (
          <HangerIcon class="size-10 text-faint" strokeWidth="1" />
        )}
      </span>
      <span class="text-xs truncate">
        {garment.name ?? categoryLabel(garment.category)}
      </span>
      {props.detached && (
        <span class="badge badge-ghost badge-xs">{t('ARCHIVED')}</span>
      )}
    </a>
  );
}

/**
 * The end of the strip's window: fetches the next page of the role's cycle
 * when it scrolls into view and is replaced by it (and its own sentinel).
 * `intersect`, not `revealed`: that one watches the window's scroll, never
 * a horizontal strip's (CLAUDE.md, Gotchas).
 */
function StripSentinel(props: {
  role: GarmentRole;
  before: number;
  context: RowContext;
}) {
  const url = stylingUrl(props.context.state, STYLING_GARMENTS_PATH, [
    `role=${props.role}`,
    `before=${props.before}`,
  ]);
  return (
    <span
      class="snap-center shrink-0 w-12 flex items-center justify-center"
      hx-get={url}
      hx-trigger="intersect once"
      hx-swap="outerHTML"
      data-strip-more=""
    >
      <span
        class="loading loading-dots loading-sm text-muted"
        aria-label={t('LOADING_MORE')}
      ></span>
    </span>
  );
}

/**
 * GET /styling/garments: the next page of a strip, and its sentinel when
 * more follow. Never chosen and never inert: the request does not carry the
 * row's lock, so styling.js makes them inert as they land in a locked row.
 */
export function StripPage(props: {
  role: GarmentRole;
  garments: RowGarment[];
  more: boolean;
  context: RowContext;
}) {
  const last = props.garments.at(-1);
  return (
    <>
      {props.garments.map((garment) => (
        <GarmentItem
          garment={garment}
          role={props.role}
          selected={false}
          locked={false}
          detached={false}
          viewOwner={props.context.viewOwner}
        />
      ))}
      {props.more && last && (
        <StripSentinel
          role={props.role}
          before={last.id}
          context={props.context}
        />
      )}
    </>
  );
}
