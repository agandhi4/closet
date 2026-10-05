import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { and, eq, inArray } from 'drizzle-orm';
import { garment, outfit, personalAccessToken } from '../src/db/schema';
import { createOutfit } from '../src/web/outfits/queries';
import { signInAs } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { seedDemoAs } from './support/seed-demo';
import { seedMuseInbox } from './support/seed-muse';
import { userIdOf, withServerDb } from './support/server-db';

/**
 * Muse's outfits on the Outfits tab in a browser (#335; docs/plans/
 * 2026-10-05-muse-suggestions.md section 4 B): a round of 8 shaped like the
 * owner's (the demo persona's closet with Muse's seeded picks and their
 * generated art: most holding pieces to buy, some complete, one loved), as
 * large cards above the persona's own outfits. A piece opens the photo
 * viewer, Not for me opens in place, every action is at least 44 px on a
 * phone, and nothing scrolls sideways. The screenshots the owner reviews
 * are attached to each test (`muse-outfits-<screen>-<width>.png`). The rows
 * each reaction writes are test/integration/muse-outfits.spec.ts's.
 */

const PHONE_DEVICE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const DESKTOP_DEVICE = { viewport: { width: 1440, height: 900 } };

let email: string;
let ids: number[] = [];

test.describe.configure({ mode: 'serial' });

/** The round: [name, Muse's note, closet categories, picks by [need, option], reaction]. */
const ROUND: [
  string,
  string,
  string[],
  [number, number][],
  'proposed' | 'loved',
][] = [
  [
    'Office, softened',
    'The navy blazer turns your oxford and chinos into a jacket outfit without a suit.',
    ['tops', 'bottoms', 'footwear'],
    [[0, 0]],
    'loved',
  ],
  [
    'Weekend layers',
    'A field jacket over the grey sweatshirt: warm enough for October.',
    ['bottoms', 'footwear'],
    [
      [3, 0],
      [2, 0],
    ],
    'proposed',
  ],
  [
    'Brown on navy',
    'Suede boots warm up the navy; the blazer keeps it smart.',
    ['tops', 'bottoms'],
    [
      [0, 1],
      [1, 0],
    ],
    'proposed',
  ],
  [
    'Easy Saturday',
    'Your own clothes, put together: nothing to buy.',
    ['tops', 'bottoms', 'footwear'],
    [],
    'proposed',
  ],
  [
    'Dinner out',
    'The hopsack blazer is the smartest of the three.',
    ['tops', 'bottoms', 'footwear'],
    [[0, 1]],
    'proposed',
  ],
  [
    'Errands',
    'The cheaper sweatshirt with what you wear every week.',
    ['bottoms', 'footwear'],
    [[2, 1]],
    'proposed',
  ],
  [
    'Cold morning',
    'The field jacket over a knit, boots for the rain.',
    ['tops', 'bottoms'],
    [
      [3, 0],
      [1, 1],
    ],
    'proposed',
  ],
  [
    'Plain and warm',
    'A complete outfit from your closet for a grey day.',
    ['outerwear', 'tops', 'bottoms', 'footwear'],
    [],
    'proposed',
  ],
];

test.beforeAll(async () => {
  email = await seedDemoAs('muse-outfits');
  const { options } = await seedMuseInbox(email);
  ids = await withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    const [token] = await db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.userId, ownerId));
    const closet = await db
      .select({ id: garment.id, category: garment.category })
      .from(garment)
      .where(
        and(
          eq(garment.ownerId, ownerId),
          eq(garment.status, 'closet'),
          inArray(garment.category, [
            'outerwear',
            'tops',
            'bottoms',
            'footwear',
          ]),
        ),
      )
      .orderBy(garment.id);
    const pickIds = ROUND.flatMap(([, , , picks]) =>
      picks.map(([need, option]) => options[need][option]),
    );
    const pickCategory = new Map(
      (
        await db
          .select({ id: garment.id, category: garment.category })
          .from(garment)
          .where(inArray(garment.id, pickIds))
      ).map((g) => [g.id, g.category]),
    );
    const made: number[] = [];
    for (const [
      index,
      [name, note, categories, picks, reaction],
    ] of ROUND.entries()) {
      // A different closet garment per look, so no two share a set.
      const slots = [
        ...picks.map(([need, option]) => ({
          category: pickCategory.get(options[need][option])!,
          garmentId: options[need][option],
        })),
        ...categories.map((category) => {
          const ofCategory = closet.filter((g) => g.category === category);
          const chosen = ofCategory[index % ofCategory.length];
          return { category, garmentId: chosen.id };
        }),
      ];
      const saved = await createOutfit(db, ownerId, { name, slots });
      // A set the persona saved already would make theirs Muse's: a fixture bug.
      if (saved.alreadySaved) throw new Error(`${name} repeats an outfit`);
      await db
        .update(outfit)
        .set({
          proposedAt: new Date(Date.now() - (ROUND.length - index) * 60_000),
          proposedByTokenId: token.id,
          proposalNote: note,
          reaction,
        })
        .where(eq(outfit.id, saved.id));
      made.push(saved.id);
    }
    return made;
  });
});

/**
 * A screenshot attached to the test: the page whole at 1440, but the
 * screen alone on a phone, where a page of 8 cards and the closet's
 * outfits is too tall to judge (and a full-page capture paints the fixed
 * dock where the first screen ended).
 */
async function shoot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage: boolean,
) {
  await page.evaluate(async () => {
    for (const img of document.querySelectorAll('img')) img.loading = 'eager';
    await Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map((img) => img.decode().catch(() => undefined)),
    );
  });
  const path = testInfo.outputPath(`muse-outfits-${name}.png`);
  await page.screenshot({ path, fullPage });
  await testInfo.attach(`muse-outfits-${name}.png`, {
    path,
    contentType: 'image/png',
  });
}

function noSideScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

for (const [label, device] of [
  ['390', PHONE_DEVICE],
  ['1440', DESKTOP_DEVICE],
] as const) {
  const { width } = device.viewport;
  test.describe(`at ${label} px`, () => {
    test.skip(
      ({ browserName }) => browserName === 'firefox' && 'isMobile' in device,
      'Firefox cannot emulate a phone (isMobile): the phone shots are Chromium’s and WebKit’s',
    );
    test.use(device);

    test('Muse’s round as large cards above the own outfits, one primary each', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto('/outfits');
      const cards = page.locator('[data-muse-outfit]');
      await expect(cards).toHaveCount(8);
      for (const card of await cards.all()) {
        await expect(card.locator('[data-muse-primary]')).toHaveCount(1);
      }
      await expect(
        page.locator(`[data-muse-outfit="${ids[0]}"] [data-muse-primary]`),
      ).toHaveAttribute('data-muse-primary', 'choose');
      await expect(
        page.locator(`[data-muse-outfit="${ids[3]}"] [data-muse-primary]`),
      ).toHaveAttribute('data-muse-primary', 'save');
      if (label === '390') {
        // A to-buy piece's badge (its page's link) is hittable over a full
        // 44 px band: the points 21 px above and below its middle land on it.
        const badge = page
          .locator(`[data-muse-outfit="${ids[1]}"] [data-piece-link]`)
          .first();
        await badge.scrollIntoViewIfNeeded();
        const hits = await badge.evaluate((link) => {
          const box = link.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return [-21, 0, 21].map(
            (dy) =>
              document
                .elementFromPoint(x, y + dy)
                ?.closest('[data-piece-link]') === link,
          );
        });
        expect(hits).toEqual([true, true, true]);
        await page.evaluate(() => window.scrollTo(0, 0));
        for (const primary of await page.locator('[data-muse-primary]').all()) {
          expect((await primary.boundingBox())!.height).toBeGreaterThanOrEqual(
            44,
          );
        }
      }
      if (label === '1440') {
        // The pieces being decided on are the page's largest images.
        const tile = page
          .locator(`[data-muse-outfit="${ids[1]}"] [data-piece]`)
          .first();
        // About 150 px (143 at 1440): two cards across the page, four pieces each,
        // larger than any piece of the collages below.
        expect((await tile.boundingBox())!.width).toBeGreaterThanOrEqual(140);
      }
      await noSideScroll(page, width);
      await shoot(page, testInfo, `tab-${label}`, label === '1440');
      // The dock sits at the foot of the screen, not over the cards.
      const dock = await page
        .locator('nav.dock, [data-dock]')
        .first()
        .boundingBox();
      if (dock && label === '390') {
        expect(dock.y + dock.height).toBeGreaterThanOrEqual(844 - 1);
      }
      // A piece opens the photo viewer.
      await page
        .locator(`[data-muse-outfit="${ids[1]}"] [data-photo-open]`)
        .first()
        .click();
      await expect(page.locator('dialog[open]')).toBeVisible();
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    });

    test('Not for me opens in place, a reason one tap away', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto('/outfits');
      const card = page.locator(`[data-muse-outfit="${ids[2]}"]`);
      await card.locator('[data-not-for-me] summary').click();
      const reason = card.getByRole('button', { name: 'The style' });
      await expect(reason).toBeVisible();
      if (label === '390') {
        expect((await reason.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await card
        .locator('[data-not-for-me]')
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await noSideScroll(page, width);
      await shoot(page, testInfo, `not-for-me-${label}`, label === '1440');
      expect(errors).toEqual([]);
    });
  });
}
