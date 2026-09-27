import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { outfit as outfitTable, planItem } from '../../src/db/schema';
import {
  createGarment,
  createWishlistItem,
  garmentRow,
  jpegPhoto,
  uploadPhoto,
} from './garments';
import { TestApp } from './harness';

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
  /** A wardrobe plan (#34) with one item. */
  planId: number;
  planItemId: number;
}

/**
 * One garment with a photo, a capsule holding it and one outfit wearing it,
 * created through the same requests the UI makes, so detail, edit, clone
 * and share pages have something real to render.
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

  const plan = await t.inject({
    method: 'POST',
    url: '/wardrobe/plans',
    payload: { name: 'NYC minimal' },
    headers,
  });
  expect(plan.statusCode).toBe(303);
  const planId = Number(
    /^\/wardrobe\/plans\/(\d+)\?/.exec(plan.headers.location as string)?.[1],
  );
  const item = await t.inject({
    method: 'POST',
    url: `/wardrobe/plans/${planId}/items`,
    payload: { category: 'shirt', name: 'Linen blazer' },
    headers,
  });
  expect(item.statusCode).toBe(303);
  const [{ id: planItemId }] = await t.db
    .select({ id: planItem.id })
    .from(planItem)
    .where(eq(planItem.planId, planId));

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
    planId,
    planItemId,
  };
}

export interface PageRoute {
  url: string;
  /** `config: { public: true }`: renders for an anonymous visitor too, instead of a login redirect. */
  public: boolean;
}

/** Every GET route that renders a full page; all render for a signed-in user. */
export function pageRoutes(f: PageFixture, inviteToken: string): PageRoute[] {
  const app = (url: string): PageRoute => ({ url, public: false });
  const open = (url: string): PageRoute => ({ url, public: true });
  return [
    app('/wardrobe'),
    app('/wardrobe?archived=true'),
    app('/wardrobe/new'),
    app(`/wardrobe/${f.garmentId}`),
    app(`/wardrobe/${f.garmentId}/edit`),
    app(`/wardrobe/${f.garmentId}/clone`),
    app(`/wardrobe?capsule=${f.capsuleId}`),
    app(`/wardrobe?pick=${f.capsuleId}`),
    app('/wardrobe/wishlist'),
    app('/wardrobe/new?to=wishlist'),
    app(`/wardrobe/new?to=wishlist&replaces=${f.garmentId}`),
    app('/wardrobe/new/from-link?to=wishlist'),
    app(`/wardrobe/${f.wishlistId}`),
    app(`/wardrobe/${f.wishlistId}/edit`),
    app(`/wardrobe/${f.wishlistId}/bought`),
    app('/capsules'),
    app('/capsules/new'),
    app(`/capsules/${f.capsuleId}`),
    app(`/capsules/${f.capsuleId}/edit`),
    app('/outfits'),
    app('/outfits/new'),
    app(`/outfits/new?capsule=${f.capsuleId}`),
    app(`/outfits/${f.outfitId}`),
    app(`/outfits/${f.outfitId}/edit`),
    app('/calendar'),
    app('/calendar/plan?for=day:2030-10-09&occasion=evening'),
    app('/outfits/new?for=day:2030-10-09&occasion=evening'),
    app('/wardrobe/plans'),
    app('/wardrobe/plans/new'),
    app(`/wardrobe/plans/${f.planId}`),
    app(`/wardrobe/plans/${f.planId}/edit`),
    app(`/wardrobe/plans/${f.planId}/items/new`),
    app(`/wardrobe/plans/${f.planId}/items/${f.planItemId}/edit`),
    app('/auth/profile'),
    app('/auth/profile/style'),
    app('/auth/update-email'),
    app('/auth/delete-account'),
    app('/auth/change-password'),
    app('/auth/tokens'),
    // Public, but a signed-out visitor is sent to log in like any app page.
    app('/auth/logout'),
    app('/wardrobe-share/manage'),
    open('/about'),
    open('/offline.html'),
    open('/auth/login'),
    open('/auth/register'),
    open(`/wardrobe-share/invite/${inviteToken}`),
    open(`/share?shareableId=${f.garmentShareableId}&type=garment`),
    open(`/share?shareableId=${f.outfitShareableId}&type=outfit`),
  ];
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
  expectNoScriptNavigation(res);
  // _hyperscript left the app (2026-09-26): an `_=` attribute would do
  // nothing at all.
  expect(res.body).not.toMatch(/\s_="/);
  expect(res.body).not.toContain('_hyperscript');
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
