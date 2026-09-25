import type { LightMyRequestResponse } from 'fastify';
import { Garment } from '../../src/dal/entity/garment.entity';
import { Outfit } from '../../src/dal/entity/outfit.entity';
import { createGarment, jpegPhoto, uploadPhoto } from './garments';
import { TestApp } from './harness';

/**
 * Shared by pages.auth-off.spec.ts and pages.auth-on.spec.ts (one app per
 * AUTH_ENABLED value, see CLAUDE.md Gotchas): the fixture both render against,
 * the route table with the status each auth mode documents, and the checks
 * every rendered page must pass.
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

  const em = t.em();
  const garment = await em.findOneOrFail(Garment, garmentId);
  const outfit = await em.findOneOrFail(Outfit, outfitId);
  return {
    garmentId,
    garmentShareableId: garment.shareableId,
    outfitId,
    outfitShareableId: outfit.shareableId,
  };
}

export interface PageRoute {
  url: string;
  /** Expected status with AUTH_ENABLED=false (no session exists). */
  authOff: number;
  /** Expected status with AUTH_ENABLED=true and a signed-in user. */
  authOn: number;
}

/**
 * Every GET route that renders a full page. Account-only pages (AuthGuard,
 * RequireSessionGuard) do not exist with auth off: 404, rendered by
 * ErrorViewFilter as a full error page.
 */
export function pageRoutes(f: PageFixture, inviteToken: string): PageRoute[] {
  const both = (url: string): PageRoute => ({ url, authOff: 200, authOn: 200 });
  const accountOnly = (url: string): PageRoute => ({
    url,
    authOff: 404,
    authOn: 200,
  });
  return [
    both('/wardrobe'),
    both('/wardrobe?archived=true'),
    both('/wardrobe/new'),
    both(`/wardrobe/${f.garmentId}`),
    both(`/wardrobe/${f.garmentId}/edit`),
    both(`/wardrobe/${f.garmentId}/clone`),
    both('/outfits'),
    both('/outfits/new'),
    both(`/outfits/${f.outfitId}`),
    both(`/outfits/${f.outfitId}/edit`),
    both('/calendar'),
    both('/about'),
    both('/offline.html'),
    both('/auth/login'),
    both('/auth/register'),
    both('/auth/reset'),
    both('/auth/reset-code?email=alice%40example.com'),
    accountOnly('/auth/profile'),
    accountOnly('/auth/update-email'),
    accountOnly('/auth/delete-account'),
    accountOnly('/wardrobe-share/manage'),
    // With auth off no invite can exist, so the landing renders its
    // "not found" state; with auth on the token is a live invite.
    both(`/wardrobe-share/invite/${inviteToken}`),
    both(`/share?shareableId=${f.garmentShareableId}&type=garment`),
    both(`/share?shareableId=${f.outfitShareableId}&type=outfit`),
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
}

/**
 * An htmx swap target: no layout around it. Status is the caller's to check:
 * Nest answers POST fragments with 201 (CLAUDE.md Gotchas).
 */
export function expectFragment(res: LightMyRequestResponse): void {
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.body).not.toMatch(/<html\b/i);
  expect(res.body).not.toContain('htmx-config');
  expect(res.body.trim().length).toBeGreaterThan(0);
  expectNoRawI18nKeys(res);
}
