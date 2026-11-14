import { expect, type Page } from '@playwright/test';

/**
 * Every outfit collage's pieces sit inside its plinth (#663): no
 * `data-collage-piece` box, nor any element inside one (a placeholder's
 * hanger icon), extends past the box of the `data-collage` that holds it,
 * to a pixel's rounding. Call it on a page showing a layered outfit (two
 * upper pieces, one without a photo) at the width under test.
 */
export async function expectCollagePiecesInsidePlinths(
  page: Page,
): Promise<void> {
  const collages = await page.locator('[data-collage]').count();
  expect(collages, `collages on ${page.url()}`).toBeGreaterThan(0);
  const outside = await page.locator('[data-collage]').evaluateAll((plinths) =>
    plinths.flatMap((plinth) => {
      const frame = plinth.getBoundingClientRect();
      return [...plinth.querySelectorAll('[data-collage-piece]')]
        .flatMap((piece) => [piece, ...piece.querySelectorAll('*')])
        .map((element) => ({
          element: `${element.tagName.toLowerCase()} in ${element.closest('[data-collage-piece]')?.getAttribute('data-collage-piece')}`,
          box: element.getBoundingClientRect(),
        }))
        .filter(
          ({ box }) =>
            box.left < frame.left - 0.5 ||
            box.right > frame.right + 0.5 ||
            box.top < frame.top - 0.5 ||
            box.bottom > frame.bottom + 0.5,
        )
        .map(({ element, box }) => ({
          element,
          box: [box.left, box.top, box.right, box.bottom],
          frame: [frame.left, frame.top, frame.right, frame.bottom],
        }));
    }),
  );
  expect(
    outside,
    `collage pieces outside their plinth on ${page.url()}`,
  ).toEqual([]);
}
