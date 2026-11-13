import { expect, type Page } from '@playwright/test';

/**
 * The phone's sizing rules (#636; views/assets/main.css, Touch sizing and
 * Touch hit areas) as the browser computes them on the page on screen. A
 * scenario at 390 px with `hasTouch` (Chromium then matches
 * `pointer: coarse`) calls these on the pages it visits, so a new page
 * there inherits them.
 */

/** The inputs a tap types into: iOS zooms the page into one under 16 px. */
const TEXT_FIELDS =
  'input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="color"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="hidden"]), select, textarea';

/** What a tap can activate. */
const CONTROLS =
  'a[href], button, summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]';

/** Apple's minimum and WCAG 2.5.5's: 44 CSS px each way. */
export const MIN_TARGET_PX = 44;

/** Every visible text field's computed font size is at least 16 px. */
export async function expectNoZoomingFields(page: Page): Promise<void> {
  const small = await page.locator(TEXT_FIELDS).evaluateAll((fields) =>
    fields
      .filter((field) => field.checkVisibility({ visibilityProperty: true }))
      .map((field) => ({
        field: `${field.tagName.toLowerCase()}[name=${field.getAttribute('name')}]`,
        size: parseFloat(getComputedStyle(field).fontSize),
      }))
      .filter(({ size }) => size < 16),
  );
  expect(small, `fields under 16 px on ${page.url()}`).toEqual([]);
}

/**
 * Every visible control's hit box is at least 44 px each way. The hit box
 * is what a tap there activates: the element's border box, unioned with
 * its ::before and ::after when they are positioned boxes (the theme's hit
 * areas, a stretched link), and with its labels' boxes (a checkbox in its
 * label, a file input hidden inside one). A pseudo-element's box is its
 * resolved insets against its containing block: the element when it is
 * positioned, else its offsetParent; none when the element's own overflow
 * clips them. Not measured: what an ancestor's overflow clips, and what a
 * neighbour's area covers.
 */
export async function expectTouchTargets(page: Page): Promise<void> {
  const small = await page.locator(CONTROLS).evaluateAll((controls, min) => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const union = (a: Box, b: Box): Box => ({
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    });
    const pseudoBox = (el: Element, which: '::before' | '::after') => {
      const style = getComputedStyle(el, which);
      if (style.content === 'none' || style.display === 'none') return null;
      if (style.position !== 'absolute' && style.position !== 'fixed')
        return null;
      const positioned = getComputedStyle(el).position !== 'static';
      const block = positioned
        ? el
        : ((el as HTMLElement).offsetParent ?? document.documentElement);
      const outer = block.getBoundingClientRect();
      const left = outer.left + block.clientLeft;
      const top = outer.top + block.clientTop;
      // An inline link has no client size: its box is the block.
      const width = block.clientWidth || outer.width;
      const height = block.clientHeight || outer.height;
      return {
        left: left + parseFloat(style.left),
        top: top + parseFloat(style.top),
        right: left + width - parseFloat(style.right),
        bottom: top + height - parseFloat(style.bottom),
      };
    };
    const hitBox = (el: Element): Box => {
      let box: Box = el.getBoundingClientRect();
      // Its own overflow clips its pseudo-elements (a `truncate` link).
      const clips = getComputedStyle(el).overflow !== 'visible';
      for (const which of ['::before', '::after'] as const) {
        const pseudo = clips ? null : pseudoBox(el, which);
        if (pseudo) box = union(box, pseudo);
      }
      const labels = (el as HTMLInputElement).labels ?? [];
      for (const label of Array.from(labels)) {
        box = union(box, hitBox(label));
      }
      return box;
    };
    const name = (el: Element) =>
      (
        el.getAttribute('aria-label') ??
        el.textContent?.trim().replace(/\s+/g, ' ') ??
        ''
      ).slice(0, 40);
    return controls
      .filter((el) => el.checkVisibility({ visibilityProperty: true }))
      .map((el) => {
        const box = hitBox(el);
        return {
          control: `${el.tagName.toLowerCase()} "${name(el)}"`,
          width: Math.round(box.right - box.left),
          height: Math.round(box.bottom - box.top),
        };
      })
      .filter(({ width, height }) => Math.min(width, height) < min);
  }, MIN_TARGET_PX);
  expect(small, `controls under ${MIN_TARGET_PX} px on ${page.url()}`).toEqual(
    [],
  );
}
