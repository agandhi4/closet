import { expect, type Page, test } from '@playwright/test';
import { createCapsule, createGarment } from './support/e2e-data';
import { SAME_ORIGIN, signIn } from './support/e2e-session';

/**
 * Save-on-change forms keep every quick edit (src/web/autosave.tsx,
 * public/js/autosave.js; found on #62's reminders form). Each form family
 * is changed several times in a row while its saves are held on a slow
 * network, which is when htmx used to drop a change made while the previous
 * save was in flight (the queued request died with the element the answer
 * replaced) and when an answer re-rendered controls the person had changed
 * since. Every test asserts that the saves never overlapped, that the last
 * one carried every change, and that the page, and the page reloaded from
 * the server, show them all. The server side is in the integration specs of
 * each family.
 */

test.use({ viewport: { width: 390, height: 844 } });

// page.route sees the page's requests only without a worker in between.
test.use({ serviceWorkers: 'block' });

const HOLD_MS = 800;

interface SlowSaves {
  /** Each POST's form, in the order the browser sent them. */
  readonly bodies: URLSearchParams[];
  /** True when a POST was sent while another was still held. */
  readonly overlapped: boolean;
  /** Resolves once no POST is held and the page has no htmx request in flight. */
  settled(): Promise<void>;
}

/**
 * Holds every POST whose path matches for HOLD_MS before it reaches the
 * server (a slow uplink), recording its form. Other requests pass.
 */
async function slowSaves(page: Page, path: RegExp): Promise<SlowSaves> {
  const bodies: URLSearchParams[] = [];
  let held = 0;
  let overlapped = false;
  await page.route(
    (url) => path.test(url.pathname),
    async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      held += 1;
      if (held > 1) overlapped = true;
      bodies.push(new URLSearchParams(route.request().postData() ?? ''));
      try {
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        const response = await route.fetch();
        await route.fulfill({ response });
      } finally {
        held -= 1;
      }
    },
  );
  return {
    bodies,
    get overlapped() {
      return overlapped;
    },
    async settled() {
      // htmx marks an element htmx-request for every request in flight and
      // issues a queued one in the same task that ends the previous, so
      // both quiet at once means nothing is left to send.
      await expect
        .poll(
          async () =>
            held === 0 && (await page.locator('.htmx-request').count()) === 0,
          { timeout: 15_000 },
        )
        .toBe(true);
    },
  };
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const radio = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true });

/** The garment's edit form, "More details" open: what the server kept. */
async function editForm(page: Page, id: number): Promise<void> {
  await page.goto(`/wardrobe/${id}/edit`);
  await page.getByText('More details').click();
}

test('tagging: three quick taps and Next are all saved, then the next garment', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-tag');
  await createGarment(page, 'Older tee');
  const tee = await createGarment(page, 'Newest tee');
  await page.goto('/wardrobe/tag');
  await expect(page.getByText('Newest tee')).toBeVisible();

  const saves = await slowSaves(page, /^\/wardrobe\/\d+\/tag$/);
  await radio(page, 'T-shirt').check();
  await radio(page, 'Warm').check();
  await radio(page, 'Dressy').check();
  await page.getByText('Next', { exact: true }).click();
  await saves.settled();

  await expect(page.getByText('Older tee')).toBeVisible();
  expect(saves.overlapped).toBe(false);
  const last = saves.bodies.at(-1)!;
  expect(Object.fromEntries(last)).toMatchObject({
    type: 't-shirt',
    warmth: '4',
    formality: '4',
  });

  // What the server kept: the taps, not the T-shirt's presets.
  await editForm(page, tee);
  await expect(radio(page, 'T-shirt')).toBeChecked();
  await expect(radio(page, 'Warm')).toBeChecked();
  await expect(radio(page, 'Dressy')).toBeChecked();
  expect(errors).toEqual([]);
});

test('tagging: a type tapped after a choice keeps the choice; the presets fill the rest', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-tag-presets');
  const tee = await createGarment(page, 'Only tee');
  await page.goto('/wardrobe/tag');
  await expect(page.getByText('Only tee')).toBeVisible();

  const saves = await slowSaves(page, /^\/wardrobe\/\d+\/tag$/);
  await radio(page, 'Dressy').check();
  await radio(page, 'Warm').check();
  await radio(page, 'T-shirt').check();
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  // Chosen by the person: kept on the card, never the preset's.
  await expect(radio(page, 'T-shirt')).toBeChecked();
  await expect(radio(page, 'Warm')).toBeChecked();
  await expect(radio(page, 'Dressy')).toBeChecked();
  await expect(page.getByText('0 left to tag')).toBeVisible();

  await editForm(page, tee);
  await expect(radio(page, 'Warm')).toBeChecked();
  await expect(radio(page, 'Dressy')).toBeChecked();
  expect(errors).toEqual([]);
});

test("the garment form's properties: taps made while the type's presets load are kept", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-properties');
  await page.goto('/wardrobe/new');
  const category = page.locator('#garment-category');
  await category.fill('tops');
  await category.blur();
  await expect(page.getByRole('group', { name: 'Type' })).toBeVisible();
  await page.getByText('More details').click();
  await expect(radio(page, 'Dressy')).toBeVisible();

  const saves = await slowSaves(page, /^\/wardrobe\/properties-fragment$/);
  await radio(page, 'T-shirt').check();
  await radio(page, 'Warm').check();
  await radio(page, 'Dressy').check();
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  await expect(radio(page, 'T-shirt')).toBeChecked();
  await expect(radio(page, 'Warm')).toBeChecked();
  await expect(radio(page, 'Dressy')).toBeChecked();
  // The type's presets still arrive for what was left alone.
  await expect(radio(page, 'Short sleeve')).toBeChecked();

  await page.locator('#garment-name').fill('Quick tee');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/wardrobe\/\d+/);
  await editForm(page, Number(new URL(page.url()).pathname.split('/').pop()));
  await expect(radio(page, 'T-shirt')).toBeChecked();
  await expect(radio(page, 'Warm')).toBeChecked();
  await expect(radio(page, 'Dressy')).toBeChecked();
  expect(errors).toEqual([]);
});

test("the garment form's properties: a warmth tapped while a category change loads survives, and the presets catch up", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-preset-markers');
  await page.goto('/wardrobe/new');
  const category = page.locator('#garment-category');
  const marker = (name: string) => page.locator(`input[name="${name}"]`);
  await category.fill('tops');
  await category.blur();
  await radio(page, 'T-shirt').check();
  await expect(marker('presetType')).toHaveValue('t-shirt');
  await expect(radio(page, 'Light')).toBeChecked();

  // The category's answer is held; the tap lands first and drops it, so the
  // form keeps the tee's markers while it posts outerwear.
  const saves = await slowSaves(page, /^\/wardrobe\/properties-fragment$/);
  await category.fill('outerwear');
  await category.blur();
  await radio(page, 'Warm').check();
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  expect(saves.bodies).toHaveLength(2);
  expect(Object.fromEntries(saves.bodies[1])).toMatchObject({
    category: 'outerwear',
    warmth: '4',
    presetCategory: 'tops',
    presetType: 't-shirt',
  });
  // The tap survives, and the markers now name what the chips on screen
  // came from: outerwear, no type yet.
  await expect(radio(page, 'Warm')).toBeChecked();
  await expect(marker('presetCategory')).toHaveValue('outerwear');
  await expect(marker('presetType')).toHaveValue('');

  // The next answer builds on consistent markers: a parka brings its presets
  // to what is unset and leaves the tapped warmth alone.
  await radio(page, 'Parka').check();
  await saves.settled();
  await expect(marker('presetType')).toHaveValue('parka');
  await expect(radio(page, 'Warm')).toBeChecked();
  await page.getByText('More details').click();
  await expect(radio(page, 'Casual')).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Water-resistant' }),
  ).toBeChecked();
  expect(errors).toEqual([]);
});

test('condition: two quick chips and a note are all saved', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-condition');
  const tee = await createGarment(page, 'Worn tee');
  await page.goto(`/wardrobe/${tee}`);

  const section = page.locator('#garment-condition');
  const saves = await slowSaves(page, /^\/wardrobe\/\d+\/condition$/);
  await radio(page, 'Needs repair').check();
  await radio(page, 'Replace soon').check();
  const note = section.getByRole('textbox', { name: 'What is wrong' });
  await note.fill('Hole in the elbow');
  await note.press('Tab');
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  expect(Object.fromEntries(saves.bodies.at(-1)!)).toMatchObject({
    condition: 'replace_soon',
    conditionNote: 'Hole in the elbow',
  });
  await expect(radio(page, 'Replace soon')).toBeChecked();
  await expect(note).toHaveValue('Hole in the elbow');

  await page.reload();
  await expect(radio(page, 'Replace soon')).toBeChecked();
  await expect(
    section.getByRole('textbox', { name: 'What is wrong' }),
  ).toHaveValue('Hole in the elbow');
  expect(errors).toEqual([]);
});

test('where it is: two quick choices and a note are all saved', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-away');
  const tee = await createGarment(page, 'Lent tee');
  await page.goto(`/wardrobe/${tee}`);

  const saves = await slowSaves(page, /^\/wardrobe\/\d+\/away$/);
  await radio(page, 'Lent').check();
  await radio(page, 'At repair').check();
  const note = page.getByRole('textbox', { name: 'Where, or who has it' });
  await note.fill('Cobbler on 5th');
  await note.press('Tab');
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  expect(Object.fromEntries(saves.bodies.at(-1)!)).toMatchObject({
    away: 'repair',
    awayNote: 'Cobbler on 5th',
  });
  await expect(radio(page, 'At repair')).toBeChecked();
  await expect(note).toHaveValue('Cobbler on 5th');

  await page.reload();
  await expect(radio(page, 'At repair')).toBeChecked();
  await expect(
    page.getByRole('textbox', { name: 'Where, or who has it' }),
  ).toHaveValue('Cobbler on 5th');
  expect(errors).toEqual([]);
});

test('"In capsules": three quick toggles are all saved', async ({ page }) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-capsules');
  const tee = await createGarment(page, 'Capsule tee');
  const names = ['Office', 'Weekend', 'Travel'];
  for (const name of names) await createCapsule(page, name);
  await page.goto(`/wardrobe/${tee}`);

  const saves = await slowSaves(page, /^\/wardrobe\/\d+\/capsules$/);
  for (const name of names) {
    await page.getByRole('checkbox', { name }).check();
  }
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  expect(saves.bodies.at(-1)!.getAll('capsuleIds')).toHaveLength(3);
  for (const name of names) {
    await expect(page.getByRole('checkbox', { name })).toBeChecked();
  }

  await page.reload();
  for (const name of names) {
    await expect(page.getByRole('checkbox', { name })).toBeChecked();
  }
  expect(errors).toEqual([]);
});

test("a trip's packing list: three quick checks are all saved", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-packing');
  const names = ['Packed tee', 'Packed jeans', 'Packed sneakers'];
  const ids = [
    await createGarment(page, names[0], 'tops'),
    await createGarment(page, names[1], 'bottoms'),
    await createGarment(page, names[2], 'footwear'),
  ];
  const outfit = await page.request.post('/outfits', {
    headers: {
      ...SAME_ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
    },
    data: new URLSearchParams([
      ['name', 'Packed look'],
      ...ids.flatMap((id, i) => [
        ['category', ['tops', 'bottoms', 'footwear'][i]],
        ['garmentId', String(id)],
      ]),
    ]).toString(),
  });
  const outfitId = new URL(outfit.url()).pathname.split('/').pop()!;
  const trip = await page.request.post('/trips', {
    form: { name: 'Packing', startsOn: '2030-10-01', endsOn: '2030-10-02' },
    headers: SAME_ORIGIN,
  });
  const tripPath = new URL(trip.url()).pathname;
  await page.request.post(`${tripPath}/outfits`, {
    form: { outfitId },
    headers: SAME_ORIGIN,
  });
  await page.goto(tripPath);

  const saves = await slowSaves(page, /^\/trips\/\d+\/packed$/);
  for (const name of names) {
    await page.getByRole('checkbox', { name: new RegExp(name) }).check();
  }
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  expect(saves.bodies.at(-1)!.getAll('packed')).toHaveLength(3);
  await expect(page.locator('#trip-packed-summary')).toContainText(
    '3 of 3 packed',
  );
  await page.reload();
  for (const name of names) {
    await expect(
      page.getByRole('checkbox', { name: new RegExp(name) }),
    ).toBeChecked();
  }
  expect(errors).toEqual([]);
});

test('the weather unit: two quick taps end on the second, and the offset reads in it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await signIn(page, 'autosave-unit');
  for (const [url, form] of [
    ['/weather/unit', { unit: 'fahrenheit' }],
    ['/weather/feedback', { feeling: 'too-warm' }],
  ] as const) {
    const res = await page.request.post(url, {
      form,
      headers: SAME_ORIGIN,
      maxRedirects: 0,
    });
    expect(res.status()).toBe(303);
  }
  await page.goto('/auth/profile');
  const settings = page.locator('#weather');
  // Half a degree Celsius is 0.9 °F.
  await expect(settings).toContainText('as if it were 0.9° warmer');

  const saves = await slowSaves(page, /^\/weather\/unit$/);
  await settings.getByRole('radio', { name: '°C' }).check();
  await settings.getByRole('radio', { name: '°F' }).check();
  await saves.settled();

  expect(saves.overlapped).toBe(false);
  expect(saves.bodies.at(-1)!.get('unit')).toBe('fahrenheit');
  await expect(settings.getByRole('radio', { name: '°F' })).toBeChecked();
  await expect(settings).toContainText('as if it were 0.9° warmer');

  await page.reload();
  await expect(
    page.locator('#weather').getByRole('radio', { name: '°F' }),
  ).toBeChecked();
  expect(errors).toEqual([]);
});
