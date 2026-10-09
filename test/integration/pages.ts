import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { outfit as outfitTable } from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  uploadPhoto,
} from './garments';
import { TestApp } from './harness';
import { planEntry, takeSelfie } from './selfies';

/**
 * Used by pages.spec.ts: the fixture every page renders against, the route
 * table, and the checks every rendered page must pass.
 */

/** A `lang.KEY` that reached the HTML untranslated. */
const RAW_I18N_KEY = /\blang\.[A-Z_]{3,}/;

export const HX_FRAGMENT = { 'hx-request': 'true' };
export const HX_BOOSTED = { 'hx-request': 'true', 'hx-boosted': 'true' };

export interface PageFixture {
  garmentId: number;
  /** A wishlist item replacing the garment. */
  wishlistId: number;
  garmentShareableId: string;
  capsuleId: number;
  outfitId: number;
  outfitShareableId: string;
  /** The outfit's selfie (#19) of today's entry: Today, the week, the outfit page. */
  selfieFileName: string;
  /** A trip (#10) on now, the outfit on today, packed, with an extra. */
  tripId: number;
}

/**
 * One garment with a photo, a capsule holding it and one outfit wearing it,
 * worn today with a selfie, created through the same requests the UI makes,
 * so detail, edit, clone and share pages have something real to render.
 */
export async function createPageFixture(
  t: TestApp,
  cookie?: string,
): Promise<PageFixture> {
  const headers = cookie ? { cookie } : {};
  const garmentId = await createGarment(t, {
    name: 'Black Linen Blazer',
    category: 'shirt',
    cookie,
  });
  await uploadPhoto(t, garmentId, await jpegPhoto(), cookie);
  const wishlistId = await createWishlistItem(t, {
    name: 'Charcoal Linen Blazer',
    category: 'shirt',
    replaces: garmentId,
    price: '120',
    sourceUrl: 'https://shop.example/blazer',
    cookie,
  });

  const capsule = await t.inject({
    method: 'POST',
    url: '/capsules',
    payload: { name: 'Office' },
    headers,
  });
  expect(capsule.statusCode).toBe(303);
  const capsuleId = Number(
    /^\/capsules\/(\d+)\?/.exec(capsule.headers.location as string)?.[1],
  );
  const chosen = await t.inject({
    method: 'POST',
    url: `/capsules/${capsuleId}/garments`,
    payload: { ids: [garmentId] },
    headers,
  });
  expect(chosen.statusCode).toBe(303);

  const res = await t.inject({
    method: 'POST',
    url: '/outfits',
    payload: {
      name: 'Office look',
      category: 'shirt',
      garmentId: String(garmentId),
    },
    headers,
  });
  expect(res.statusCode).toBe(302);
  const match = /^\/outfits\/(\d+)$/.exec(res.headers.location as string);
  if (!match) {
    throw new Error(`Unexpected outfit redirect: ${res.headers.location}`);
  }
  const outfitId = Number(match[1]);
  const { fileName: selfieFileName } = await takeSelfie(
    t,
    await planEntry(t, outfitId, t.today(), cookie),
    cookie,
  );

  const today = t.today();
  const trip = await t.inject({
    method: 'POST',
    url: '/trips',
    payload: {
      name: 'Lisbon',
      destination: 'Lisbon',
      startsOn: today,
      endsOn: addDays(today, 2),
    },
    headers,
  });
  expect(trip.statusCode).toBe(303);
  const tripId = Number(
    /^\/trips\/(\d+)\?/.exec(trip.headers.location as string)?.[1],
  );
  for (const [url, payload] of [
    [`/trips/${tripId}/outfits`, { outfitId: String(outfitId), day: today }],
    [`/trips/${tripId}/items`, { label: 'Charger' }],
    [`/trips/${tripId}/packed`, { packed: String(garmentId) }],
  ] as const) {
    const res = await t.inject({ method: 'POST', url, payload, headers });
    expect(res.statusCode, url).toBe(303);
  }

  const garment = (await garmentRow(t, garmentId))!;
  const [outfit] = await t.db
    .select({ shareableId: outfitTable.shareableId })
    .from(outfitTable)
    .where(eq(outfitTable.id, outfitId));
  return {
    garmentId,
    wishlistId,
    garmentShareableId: garment.shareableId,
    capsuleId,
    outfitId,
    outfitShareableId: outfit.shareableId,
    selfieFileName,
    tripId,
  };
}

export interface PageRoute {
  url: string;
  /** `config: { public: true }`: renders for an anonymous visitor too, instead of a login redirect. */
  public: boolean;
  /**
   * An add or edit page, which its save is done with: its app bar says so
   * (`AppBar formPage`, `data-form-page`), and the back arrow of the page
   * the save lands on skips it (public/js/back.js). `expectFormPageFlag`.
   */
  formPage: boolean;
}

/**
 * Every GET route that renders a full page; all render for a signed-in user.
 * A new add or edit page is listed with `form`, so a page that forgets its
 * `formPage` fails, as does a page that claims it wrongly.
 */
export function pageRoutes(f: PageFixture, inviteToken: string): PageRoute[] {
  const app = (url: string): PageRoute => ({
    url,
    public: false,
    formPage: false,
  });
  const form = (url: string): PageRoute => ({
    url,
    public: false,
    formPage: true,
  });
  const open = (url: string): PageRoute => ({
    url,
    public: true,
    formPage: false,
  });
  return [
    app('/'),
    app('/wardrobe'),
    app('/wardrobe?archived=true'),
    form('/wardrobe/new'),
    app(`/wardrobe/${f.garmentId}`),
    form(`/wardrobe/${f.garmentId}/edit`),
    form(`/wardrobe/${f.garmentId}/clone`),
    app('/wardrobe/tag'),
    app(`/wardrobe?capsule=${f.capsuleId}`),
    app(`/wardrobe?pick=${f.capsuleId}`),
    app('/wardrobe/wishlist'),
    form('/wardrobe/new?to=wishlist'),
    form(`/wardrobe/new?to=wishlist&replaces=${f.garmentId}`),
    form('/wardrobe/new/from-link?to=wishlist'),
    app(`/wardrobe/${f.wishlistId}`),
    form(`/wardrobe/${f.wishlistId}/edit`),
    form(`/wardrobe/${f.wishlistId}/bought`),
    app('/capsules'),
    form('/capsules/new'),
    app(`/capsules/${f.capsuleId}`),
    form(`/capsules/${f.capsuleId}/edit`),
    app('/outfits'),
    app('/outfits?for=day:2030-10-09&occasion=evening'),
    form('/styling'),
    form(`/styling?capsule=${f.capsuleId}`),
    form(`/styling?with=${f.garmentId}`),
    form(`/styling?outfit=${f.outfitId}&returnTo=%2Fcalendar`),
    app(`/outfits/${f.outfitId}`),
    app('/calendar'),
    app('/calendar/month'),
    app('/calendar/month?month=2030-10'),
    app('/calendar/plan?for=day:2030-10-09&occasion=evening'),
    form('/styling?for=day:2030-10-09&occasion=evening'),
    form(`/styling?for=trip:${f.tripId}`),
    app('/outfits/ideas'),
    app('/outfits/ideas?for=day:2030-10-09&occasion=evening'),
    app(`/outfits/ideas?capsule=${f.capsuleId}&with=${f.garmentId}`),
    app('/trips'),
    form('/trips/new'),
    app(`/trips/${f.tripId}`),
    form(`/trips/${f.tripId}/edit`),
    form(`/trips/${f.tripId}/outfits/new`),
    form(`/trips/${f.tripId}/outfits/new?day=2030-10-09&occasion=evening`),
    app(`/outfits/ideas?for=trip:${f.tripId}`),
    app('/wardrobe/insights'),
    app('/wardrobe/insights?unworn=30'),
    app('/wardrobe/recap'),
    app('/wardrobe/recap?year=2025'),
    app('/auth/profile'),
    form('/auth/profile/style'),
    form('/auth/profile/sizes'),
    app('/auth/update-email'),
    app('/auth/delete-account'),
    app('/auth/change-password'),
    form('/auth/tokens'),
    // Public, but a signed-out visitor is sent to log in like any app page.
    app('/auth/logout'),
    open('/about'),
    open('/offline.html'),
    open('/auth/login'),
    open('/auth/register'),
    open(`/wardrobe-share/invite/${inviteToken}`),
    open(`/share?shareableId=${f.garmentShareableId}&type=garment`),
    open(`/share?shareableId=${f.outfitShareableId}&type=outfit`),
  ];
}

/** The app bar marks exactly the pages `pageRoutes` lists as form pages. */
export function expectFormPageFlag(
  route: PageRoute,
  res: LightMyRequestResponse,
): void {
  const header = /<header class="app-bar\b[^>]*>/.exec(res.body)?.[0] ?? '';
  expect({
    url: route.url,
    formPage: header.includes('data-form-page'),
  }).toEqual({ url: route.url, formPage: route.formPage });
}

export function expectNoRawI18nKeys(res: LightMyRequestResponse): void {
  expect(res.body).not.toMatch(RAW_I18N_KEY);
}

/** A whole document: layout, exactly one htmx config, every string translated. */
export function expectFullPage(res: LightMyRequestResponse): void {
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).toMatch(/^<!DOCTYPE html>/i);
  // htmx reads only the first htmx-config meta (CLAUDE.md Gotchas).
  expect(res.body.match(/<meta\s+name="htmx-config"/g)).toHaveLength(1);
  expectNoRawI18nKeys(res);
  expectNativePostForms(res);
  expectAutosaveControls(res);
  expectNoScriptNavigation(res);
  expectAppBar(res);
  // _hyperscript left the app (2026-09-26): an `_=` attribute would do
  // nothing at all.
  expect(res.body).not.toMatch(/\s_="/);
  expect(res.body).not.toContain('_hyperscript');
}

/**
 * Every page has the one app bar (src/web/layout/app-bar.tsx) and its title
 * is the page's only h1; signed in, the avatar opens Profile, signed out
 * the bar offers a way in. The drawer is gone (#82).
 */
export function expectAppBar(res: LightMyRequestResponse): void {
  const body = res.body;
  expect(body.match(/<header class="app-bar\b/g)).toHaveLength(1);
  expect(body.match(/<h1\b/g)).toHaveLength(1);
  expect(body).not.toContain('drawer-toggle');
  if (res.headers['x-page-account']) {
    expect(body.match(/<a href="\/auth\/profile" id="avatar"/g)).toHaveLength(
      1,
    );
  } else {
    // A link in, or on the login page its own form.
    expect(body).toMatch(/(?:href|action)="\/auth\/(?:login|register)"/);
  }
}

/** The app bar's title, the page's h1, as text. */
export function pageTitle(body: string): string | undefined {
  return /<h1\b[^>]*>([^<]*)<\/h1>/.exec(body)?.[1];
}

/**
 * Navigation is a link or an htmx request, never script setting the
 * location: that is a full document load, which re-runs every shell script
 * and the service worker update check, and races a boosted click on a link
 * inside the element (client audit H4).
 */
export function expectNoScriptNavigation(res: LightMyRequestResponse): void {
  expect(res.body).not.toMatch(/\blocation(\.href)?\s*=/);
}

/**
 * The layout boosts every form, and htmx drops a boosted 4xx: a refused
 * native post would do nothing on screen (the boosted registration form is
 * how the owner lost their password). Every `<form method="post">` must opt
 * out with hx-boost="false"; forms that post through htmx (hx-post) handle
 * their own responses and are not native posts.
 */
export function expectNativePostForms(res: LightMyRequestResponse): void {
  const offenders = (res.body.match(/<form\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      /\bmethod=["']?post\b/i.test(tag) &&
      !/\bhx-post=/i.test(tag) &&
      !/\bhx-boost=["']?false\b/i.test(tag),
  );
  expect(offenders).toEqual([]);
}

/**
 * Every control that posts on `change` is built by src/web/autosave.tsx
 * (`AutosaveForm`, `autosaveAttributes`): queued per form, latest last, and
 * marked for public/js/autosave.js, which drops answers a newer edit
 * overtook. One built by hand loses quick edits (found on #62). The auth
 * forms' inline check is exempt: it swaps nothing of its own
 * (`hx-swap="none"`, messages out of band), so it cannot redraw a field.
 */
export function expectAutosaveControls(res: LightMyRequestResponse): void {
  const offenders = (res.body.match(/<[a-z-]+\b[^>]*>/gi) ?? []).filter(
    (tag) =>
      /\bhx-post=/i.test(tag) &&
      /\bhx-trigger="[^"]*\bchange\b/i.test(tag) &&
      !/\bhx-swap="none"/i.test(tag) &&
      !(
        /\bhx-sync="closest form:queue last"/i.test(tag) &&
        /\bdata-autosave=""/i.test(tag)
      ),
  );
  expect(offenders).toEqual([]);
}

/**
 * An htmx swap target: no layout around it. Status is the caller's to
 * check.
 */
export function expectFragment(res: LightMyRequestResponse): void {
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).not.toMatch(/<html\b/i);
  expect(res.body).not.toContain('htmx-config');
  expect(res.body.trim().length).toBeGreaterThan(0);
  expectNoRawI18nKeys(res);
}
