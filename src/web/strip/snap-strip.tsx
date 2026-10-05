import type { Child } from 'hono/jsx';
import { t } from '../i18n';

/**
 * The snap strip: a horizontal scroll-snap carousel whose centred item, with
 * its neighbours peeking, is the choice. The browser does the scrolling (no
 * touch handlers); public/js/snap-strip.js watches which item crosses the
 * strip's centre line and writes that item's `data-snap-value` into the
 * strip's hidden input. A page needs no script of its own. See ./CLAUDE.md.
 *
 * Used by Styling's rows (src/web/styling/styling-row.tsx), the plan review,
 * the Looks strips and the shopping list.
 */

/**
 * An item's width and the strip's end spacers go together: each spacer is
 * half the strip less half an item and the strip's gap (`gap-3`, 0.75rem,
 * also falls between a spacer and its item), so the first and last items
 * can be centred and the neighbours peek in what is left. Spacers, not
 * padding (#179): WebKit leaves a flex scroller's end padding out of its
 * scrollable width when the items alone fit, so a strip of two items could
 * not scroll at all in Safari and the second was never chosen. The width is
 * fixed, not a percentage: a flex item's percentage would resolve against
 * the strip, not the item's share of it. Whole class strings, for Tailwind.
 */
const SIZES = {
  regular: {
    item: 'w-28',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-4.25rem)] after:w-[calc(50%-4.25rem)] before:shrink-0 after:shrink-0',
  },
  // Styling's accessory rows; larger tiles from `lg` (#321), where the row has the width.
  small: {
    item: 'w-20 lg:w-28',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-3.25rem)] after:w-[calc(50%-3.25rem)] lg:before:w-[calc(50%-4.25rem)] lg:after:w-[calc(50%-4.25rem)] before:shrink-0 after:shrink-0',
  },
  // Styling's garment rows: `regular` on a phone, larger from `lg`.
  roomy: {
    item: 'w-28 lg:w-40',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-4.25rem)] after:w-[calc(50%-4.25rem)] lg:before:w-[calc(50%-5.75rem)] lg:after:w-[calc(50%-5.75rem)] before:shrink-0 after:shrink-0',
  },
  // A plan look's card (#291): a collage with words and reactions under it.
  card: {
    item: 'w-56',
    gap: 'gap-3',
    ends: 'before:w-[calc(50%-7.75rem)] after:w-[calc(50%-7.75rem)] before:shrink-0 after:shrink-0',
  },
  // An idea card (#321): the strip's whole width on a phone (no spacers: the
  // negative margins cancel the gap beside the zero-width pseudo-element),
  // a fixed card from `lg`. The percentage resolves against the strip.
  page: {
    item: 'w-full lg:w-72',
    gap: 'gap-4',
    ends: 'before:w-0 after:w-0 before:-mr-4 after:-ml-4 lg:before:mr-0 lg:after:ml-0 lg:before:w-[calc(50%-10rem)] lg:after:w-[calc(50%-10rem)] before:shrink-0 after:shrink-0',
  },
  // The same card with the next one peeking in on a phone (Today's rows),
  // flush left as before: the first card cannot be centred there.
  peek: {
    item: 'w-[85%] lg:w-72',
    gap: 'gap-3',
    ends: 'before:w-0 after:w-0 before:-mr-3 after:-ml-3 lg:before:mr-0 lg:after:ml-0 lg:before:w-[calc(50%-9.75rem)] lg:after:w-[calc(50%-9.75rem)] before:shrink-0 after:shrink-0',
  },
  // Goes-with's best outfits: the next card peeks in on a phone (a single
  // one uses `page`, full width, with the same gap).
  pair: {
    item: 'w-11/12 lg:w-72',
    gap: 'gap-3',
    ends: 'before:w-0 after:w-0 before:-mr-3 after:-ml-3 lg:before:mr-0 lg:after:ml-0 lg:before:w-[calc(50%-9.75rem)] lg:after:w-[calc(50%-9.75rem)] before:shrink-0 after:shrink-0',
  },
} as const;

export type SnapSize = keyof typeof SIZES;

/**
 * The strip and, right after it, the hidden input the observer writes the
 * chosen item's value into. The observer pairs them by position (the input is
 * the strip's `nextElementSibling`), so any number of strips can share a
 * container. `value` is the item chosen on the
 * server (`data-selected`, see `snapItem`); "" when none is. A strip given no
 * `name` has no input: the observer still marks the centred item and writes
 * nothing.
 *
 * The strip, its input and the step buttons sit in one `relative` frame, so
 * the buttons overlay the strip's edges. `class` adds to the strip (a page's
 * own freezing or hooks); the strip is
 * `relative`, a flex row and `overscroll-x-contain`.
 */
export function SnapStrip(props: {
  /** The hidden input's name; none when nothing reads the choice. */
  name?: string;
  value?: string;
  size: SnapSize;
  label: string;
  /**
   * False for a strip that is not a choice (the shopping list's: its tiles
   * hold links, which an `option` would hide from screen readers): a plain
   * group, and `snapItem({ listbox: false })` on its items.
   */
  listbox?: boolean;
  /**
   * True when no tile holds a focusable control (the Looks strip's collage
   * cards hold none the keyboard needs): the strip itself takes focus, so the
   * arrow keys can reach it. Off where tiles are buttons or links, which
   * would only add a second tab stop.
   */
  focusable?: boolean;
  class?: string;
  /** Extra attributes on the strip itself (an `id` a page's test or script finds it by). */
  /**
   * True where the tiles hold buttons or links that must work on the first
   * tap, even on a peeking neighbour (Ideas, Today): the tap-to-centre
   * handler leaves clicks on controls alone. Only for `listbox={false}`
   * strips, whose tiles are not the choice.
   */
  tapThrough?: boolean;
  attributes?: Readonly<Record<string, string>>;
  /** Classes on the frame around the strip and its step buttons (a page hides the buttons while it freezes the strip). */
  frameClass?: string;
  children?: Child;
}) {
  const classes = [
    'snap-strip relative flex rounded-box focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary overflow-x-auto snap-x snap-mandatory overscroll-x-contain',
    SIZES[props.size].gap,
    SIZES[props.size].ends,
    props.class,
  ];
  return (
    <div class={`snap-strip-frame relative ${props.frameClass ?? ''}`}>
      <div
        class={classes.filter(Boolean).join(' ')}
        role={props.listbox === false ? 'group' : 'listbox'}
        aria-label={props.label}
        tabindex={props.focusable ? 0 : undefined}
        data-snap-strip=""
        data-snap-tap-through={props.tapThrough ? '' : undefined}
        {...props.attributes}
      >
        {props.children}
      </div>
      {props.name !== undefined && (
        <input type="hidden" name={props.name} value={props.value ?? ''} />
      )}
      <StepButton step={-1} label={props.label} />
      <StepButton step={1} label={props.label} />
    </div>
  );
}

/**
 * The inline module a page with strips renders once (the plan pages' is
 * `LOOKS_INIT`, Styling's `initStyling`): a boosted navigation brings new
 * strips and a `<script src>` module runs only once, so the page asks for
 * the observer on every visit. A fixed string, nothing interpolated.
 */
export function SnapStripsInit() {
  return (
    <script
      type="module"
      dangerouslySetInnerHTML={{
        __html: `import { initSnapStrips } from 'snap-strip';
initSnapStrips(document);`,
      }}
    />
  );
}

/**
 * Previous / next, for a mouse (#311): hidden except where the primary input
 * hovers and is precise (the `fine` variant, views/assets/main.css), so one
 * markup serves every device. Wired by public/js/snap-strip.js. They follow
 * the hidden input in the frame, which keeps it the strip's
 * `nextElementSibling`.
 */
function StepButton(props: { step: -1 | 1; label: string }) {
  const previous = props.step < 0;
  return (
    <button
      type="button"
      class={`btn btn-circle btn-sm absolute top-1/2 z-10 hidden -translate-y-1/2 fine:inline-flex ${previous ? 'left-1' : 'right-1'}`}
      data-snap-step={props.step}
      aria-label={t(previous ? 'strip.PREVIOUS' : 'strip.NEXT', {
        label: props.label,
      })}
    >
      <span aria-hidden="true">{previous ? '‹' : '›'}</span>
    </button>
  );
}

/**
 * The attributes of one item (spread onto its element): snap-centred, one
 * at a time (`snap-always`), the size's fixed width, an option of the
 * strip's listbox carrying the value it chooses. `group/item` lets the
 * item's children style off `data-selected`. The page adds the element, its
 * look and its own classes.
 */
export function snapItem(props: {
  value: string;
  selected: boolean;
  size: SnapSize;
  /** False in a strip that is not a listbox: no `option` role or `aria-selected`. */
  listbox?: boolean;
  class?: string;
}) {
  const option = props.listbox !== false;
  return {
    class: [
      'snap-item group/item snap-center snap-always shrink-0',
      SIZES[props.size].item,
      props.class,
    ]
      .filter(Boolean)
      .join(' '),
    role: option ? 'option' : undefined,
    'data-snap-item': '',
    'data-snap-value': props.value,
    'data-selected': props.selected ? '' : undefined,
    'aria-selected': option ? (props.selected ? 'true' : 'false') : undefined,
  } as const;
}
