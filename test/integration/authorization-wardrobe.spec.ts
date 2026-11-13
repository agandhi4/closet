import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { garmentWear } from '../../src/db/schema';
import { describeMatrix } from './authorization-matrix';
import { unescapeHtml } from './harness';
import { ROUTES } from './authorization-wardrobe.routes';

describeMatrix('wardrobe', ROUTES, (m) => {
  // The page offers what the routes allow: clone to anyone who can see the
  // garment, edit (and condition) to the owner and a MANAGE grantee,
  // archive, delete and the wear section to the owner only.
  it.each([
    ['owner', { clone: true, edit: true, remove: true }],
    ['manager', { clone: true, edit: true, remove: false }],
    ['viewer', { clone: true, edit: false, remove: false }],
  ] as const)(
    'the garment page shows %s the actions they may take',
    async (actor, can) => {
      const q = `?ownerId=${m.actors.owner.id}`;
      const res = await m.t.inject({
        method: 'GET',
        url: `/wardrobe/${m.shared.garmentId}${q}`,
        headers: { cookie: m.actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      const html = unescapeHtml(res.body);
      const id = m.shared.garmentId;
      expect(html.includes(`href="/wardrobe/${id}/clone`)).toBe(can.clone);
      expect(html.includes(`href="/wardrobe/${id}/edit`)).toBe(can.edit);
      expect(html.includes('name="photo"')).toBe(can.edit);
      expect(html.includes(`hx-delete="/wardrobe/${id}`)).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/archive`)).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/condition`)).toBe(can.edit);
      expect(html.includes('id="garment-wear"')).toBe(can.remove);
      expect(html.includes(`/wardrobe/${id}/wear`)).toBe(can.remove);
    },
  );

  // "Goes with my closet" (#18b) judges a wishlist item against the owner's
  // closet and clashes: the owner's alone, like ideas, though every grantee
  // reads the item itself (mcp-seed.spec.ts refuses goes_with_closet to a
  // grantee's token).
  it.each([
    ['owner', true],
    ['manager', false],
    ['viewer', false],
  ] as const)(
    'a wishlist item’s page shows %s "Goes with my closet": %s',
    async (actor, shown) => {
      const res = await m.t.inject({
        method: 'GET',
        url: `/wardrobe/${m.shared.wishlistId}?ownerId=${m.actors.owner.id}`,
        headers: { cookie: m.actors[actor].cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(m.shared.wishlistName);
      expect(res.body.includes('id="goes-with"')).toBe(shown);
    },
  );

  // The wear's undo (#193a) is wearGarment behind the same guard as its
  // PUT, so it refuses as the PUT's matrix cases do; its own case needs a
  // wear to undo, which the shared fixture must not have
  // (authorization-coverage.spec.ts, EXEMPT).
  it('DELETE /api/v1/garments/:id/wears/:day refuses as its PUT does', async () => {
    const { garmentId, today } = m.shared;
    const url = `/api/v1/garments/${garmentId}/wears/${today}`;
    const owner = m.actors.owner.token!;
    const wearsOf = () =>
      m.t.db.$count(garmentWear, eq(garmentWear.garmentId, garmentId));
    const worn = await m.t.api(owner, { method: 'PUT', url });
    expect(worn.json()).toMatchObject({ worn: true, changed: true });
    const before = await wearsOf();
    for (const actor of ['manager', 'viewer', 'stranger'] as const) {
      const token = m.actors[actor].token!;
      const own = await m.t.api(token, { method: 'DELETE', url });
      const named = await m.t.api(token, {
        method: 'DELETE',
        url: `${url}?ownerId=${m.actors.owner.id}`,
      });
      expect([own.statusCode, named.statusCode], actor).toEqual(
        actor === 'stranger' ? [404, 404] : [404, 403],
      );
      expect(named.body).not.toContain(m.shared.garmentName);
    }
    expect(await wearsOf()).toBe(before);
    const undone = await m.t.api(owner, { method: 'DELETE', url });
    expect(undone.json()).toMatchObject({ worn: false, changed: true });
    expect(await wearsOf()).toBe(before - 1);
  });
});
