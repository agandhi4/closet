import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { outfit as outfitTable } from '../../src/db/schema';
import { createGarment, garmentRow, jpegPhoto, uploadPhoto } from './garments';
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
  garmentShareableId: string;
  outfitId: number;
  outfitShareableId: string;
}

/**
 * One garment with a photo and one outfit wearing it, created through the
 * same requests the UI makes, so detail, edit, clone and share pages have
 * something real to render.
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

  const garment = (await garmentRow(t, garmentId))!;
  const [outfit] = await t.db
    .select({ shareableId: outfitTable.shareableId })
    .from(outfitTable)
    .where(eq(outfitTable.id, outfitId));
  return {
    garmentId,
    garmentShareableId: garment.shareableId,
    outfitId,
    outfitShareableId: outfit.shareableId,
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
    app('/outfits'),
    app('/outfits/new'),
    app(`/outfits/${f.outfitId}`),
    app(`/outfits/${f.outfitId}/edit`),
    app('/calendar'),
    app('/auth/profile'),
    app('/auth/update-email'),
    app('/auth/delete-account'),
    app('/auth/change-password'),
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
