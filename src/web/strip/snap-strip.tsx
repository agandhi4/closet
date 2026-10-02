import type { Child } from 'hono/jsx';

/**
 * The snap strip: a horizontal scroll-snap carousel whose centred item, with
 * its neighbours peeking, is the choice. The browser does the scrolling (no
 * touch handlers); public/js/snap-strip.js watches which item crosses the
 * strip's centre line and writes that item's `data-snap-value` into the
 * strip's hidden input. A page needs no script of its own. See ./CLAUDE.md.
 *
 * Used by Styling's rows (src/web/styling/styling-row.tsx).
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
    ends: 'before:w-[calc(50%-4.25rem)] after:w-[calc(50%-4.25rem)] before:shrink-0 after:shrink-0',
  },
  small: {
    item: 'w-20',
    ends: 'before:w-[calc(50%-3.25rem)] after:w-[calc(50%-3.25rem)] before:shrink-0 after:shrink-0',
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
 * `class` adds to the strip (a page's own freezing or hooks); the strip is
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
  class?: string;
  children?: Child;
}) {
  const classes = [
    'snap-strip relative flex gap-3 overflow-x-auto snap-x snap-mandatory overscroll-x-contain',
    SIZES[props.size].ends,
    props.class,
  ];
  return (
    <>
      <div
        class={classes.filter(Boolean).join(' ')}
        role={props.listbox === false ? 'group' : 'listbox'}
        aria-label={props.label}
        data-snap-strip=""
      >
        {props.children}
      </div>
      {props.name !== undefined && (
        <input type="hidden" name={props.name} value={props.value ?? ''} />
      )}
    </>
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
