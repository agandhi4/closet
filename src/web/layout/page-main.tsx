import type { Child } from 'hono/jsx';

/**
 * The page's content column. A width is chosen by name, never a per-page
 * `max-w-*`, so the layout owns how wide a page may grow (the tokens are
 * `--container-page-*` in views/assets/main.css):
 *  - `narrow` (40rem): forms, reading and single-column lists. The default,
 *    so a new page stays a column until it earns more.
 *  - `wide` (80rem): galleries, which fill the width the left rail leaves.
 * Below the narrow width the column is the screen, so phones are unchanged.
 *
 * Always `w-full` beside `mx-auto`: the body is a flex column, and a flex
 * item with auto margins sizes to its content instead of stretching (a
 * horizontal scroll strip once widened the garment page past a phone).
 * Pass `class` for the page's own padding and layout, never a max width.
 */
export type PageWidth = 'narrow' | 'wide';

// Whole class names, so Tailwind finds them.
const WIDTH_CLASS: Readonly<Record<PageWidth, string>> = {
  narrow: 'max-w-page-narrow',
  wide: 'max-w-page-wide',
};

export function PageMain(props: {
  width?: PageWidth;
  class?: string;
  /** For a fragment that htmx swaps in place (the wardrobe's `#wardrobe-main`). */
  id?: string;
  children?: Child;
}) {
  const { width = 'narrow' } = props;
  return (
    <main
      id={props.id}
      class={`w-full mx-auto ${WIDTH_CLASS[width]}${props.class ? ` ${props.class}` : ''}`}
    >
      {props.children}
    </main>
  );
}
