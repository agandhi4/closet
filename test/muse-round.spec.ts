import { expect, type Page, test, type TestInfo } from '@playwright/test';
import { and, eq, inArray } from 'drizzle-orm';
import { garment, personalAccessToken } from '../src/db/schema';
import { proposeOutfit } from '../src/web/outfits/queries';
import { finishRound } from '../src/web/wishlist/rounds';
import { signInAs } from './support/e2e-session';
import { pageErrors } from './support/page-errors';
import { fakeSubscription, stubPushManager } from './support/push-stub';
import { seedDemoAs } from './support/seed-demo';
import { seedMuseInbox } from './support/seed-muse';
import { userIdOf, withServerDb } from './support/server-db';

/**
 * The moment a Muse round lands (#337; docs/plans/2026-10-05-muse-suggestions.md
 * section 4 A), in a browser: Today's one card for the round (on the demo
 * persona's closet with Muse's seeded picks, two proposed outfits and a
 * finished round) and the device's "When Muse finishes a round" toggle on
 * the profile, at 390 and 1440 px, attached as screenshots
 * (`muse-round-<screen>-<width>.png`) for the owner's review. The phone's
 * shots are the viewport, as the phone shows it. The rows and the
 * notification are test/integration/muse-round.spec.ts's.
 */

const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
};
const DESKTOP = { viewport: { width: 1440, height: 900 } };

let email: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  email = await seedDemoAs('muse-round');
  const { options } = await seedMuseInbox(email);
  await withServerDb(async (db) => {
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
          inArray(garment.category, ['tops', 'bottoms', 'footwear']),
        ),
      )
      .orderBy(garment.id);
    const first = (category: string) =>
      closet.find((g) => g.category === category)!.id;
    // The blazer with a shirt and chinos; the second blazer with boots.
    for (const [pick, other] of [
      [options[0][0], first('bottoms')],
      [options[0][1], first('footwear')],
    ]) {
      const proposed = await proposeOutfit(
        db,
        ownerId,
        {
          name: null,
          slots: [
            { category: 'outerwear', garmentId: pick },
            { category: 'tops', garmentId: first('tops') },
            {
              category: other === first('bottoms') ? 'bottoms' : 'footwear',
              garmentId: other,
            },
          ],
        },
        { tokenId: token.id, note: 'The blazer over what you wear weekly.' },
      );
      if (!proposed.ok) throw new Error(`proposal: ${proposed.reason}`);
    }
    const round = await finishRound(db, ownerId, {
      tokenId: token.id,
      summary: 'Office layers for the cooler weeks',
      feedbackUntil: null,
    });
    if (!round.ok) throw new Error('the round brought nothing');
  });
});

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map((img) => img.decode().catch(() => undefined)),
    );
  });
  const path = testInfo.outputPath(`muse-round-${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`muse-round-${name}.png`, {
    path,
    contentType: 'image/png',
  });
}

for (const [label, device] of [
  ['390', PHONE],
  ['1440', DESKTOP],
] as const) {
  test.describe(`at ${label} px`, () => {
    test.skip(
      ({ browserName }) => browserName === 'firefox' && 'isMobile' in device,
      'Firefox cannot emulate a phone (isMobile)',
    );
    test.use(device);

    test('Today shows the round as one card, its one primary Review', async ({
      page,
    }, testInfo) => {
      const errors = pageErrors(page);
      await signInAs(page, email);
      await page.goto('/');
      const card = page.locator('[data-muse-round]');
      await expect(card).toBeVisible();
      await expect(card).toContainText('to consider');
      await expect(card).toContainText('Office layers for the cooler weeks');
      await expect(card.getByRole('link', { name: 'Review' })).toHaveAttribute(
        'href',
        '/outfits',
      );
      await expect(page.locator('[data-muse-needs]')).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(device.viewport.width);
      await shoot(page, testInfo, `today-${label}`);
      expect(errors).toEqual([]);
    });

    test('the profile’s toggle for Muse’s rounds, off until turned on', async ({
      page,
      browserName,
    }, testInfo) => {
      test.skip(
        process.env.PWA_ENABLED !== 'true' || browserName !== 'chromium',
        'needs a server started with PWA_ENABLED=true, in Chromium',
      );
      await stubPushManager(page, fakeSubscription(), true, { granted: true });
      await signInAs(page, email);
      await page.goto('/auth/profile');
      const toggle = page.getByRole('checkbox', {
        name: 'When Muse finishes a round',
      });
      await expect(toggle).toBeVisible();
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      await expect(
        page.locator('#push-reminders [data-autosave-status]'),
      ).toContainText('Saved');
      await toggle.scrollIntoViewIfNeeded();
      await page
        .locator('#push-reminders')
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await shoot(page, testInfo, `settings-${label}`);
    });
  });
}
