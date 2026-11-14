import { desc, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wardrobeShare } from '../../src/db/schema';
import { createGarment, garmentRow, garmentsNamed } from './garments';
import { createTestApp, TEST_PASSWORD, TestApp, userIdOf } from './harness';

describe('wardrobe sharing', () => {
  let t: TestApp;
  let alice: { id: number; cookie: string };
  let bob: { id: number; cookie: string };

  const userId = async (email: string) => userIdOf(t, email);

  /**
   * Profile › Sharing's view link (the htmx form, answering the link) or
   * the edit link's step-up page (a native post with the password, #668,
   * landing on the section): the new invite's token, from its row.
   */
  const createInvite = async (
    cookie: string,
    permission: 'VIEW' | 'MANAGE',
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission, currentPassword: TEST_PASSWORD },
      headers:
        permission === 'VIEW' ? { cookie, 'hx-request': 'true' } : { cookie },
    });
    expect(res.statusCode).toBe(permission === 'VIEW' ? 200 : 302);
    const [row] = await t.db
      .select({ token: wardrobeShare.inviteToken })
      .from(wardrobeShare)
      .where(isNull(wardrobeShare.acceptedAt))
      .orderBy(desc(wardrobeShare.id))
      .limit(1);
    if (permission === 'VIEW') expect(res.body).toContain(row.token!);
    return row.token!;
  };

  const acceptInvite = async (cookie: string, token: string) => {
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    // Accepted lands on the grantor's wardrobe (#661); a refusal on
    // Profile › Sharing with ?shareError=.
    expect(res.headers.location).toBe(`/wardrobe?ownerId=${alice.id}`);
  };

  beforeAll(async () => {
    t = await createTestApp();
    alice = {
      cookie: await t.register('alice@example.com'),
      id: await userId('alice@example.com'),
    };
    bob = {
      cookie: await t.register('bob@example.com'),
      id: await userId('bob@example.com'),
    };
    await createGarment(t, { name: 'Alice coat', cookie: alice.cookie });
  });

  afterAll(() => t?.cleanup());

  it('a VIEW invite lets the grantee read but not write', async () => {
    const token = await createInvite(alice.cookie, 'VIEW');

    const landing = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${token}`,
    });
    expect(landing.statusCode).toBe(200);

    await acceptInvite(bob.cookie, token);

    const shared = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${alice.id}`,
      headers: { cookie: bob.cookie },
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toContain('Alice coat');

    const own = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: bob.cookie },
    });
    expect(own.body).not.toContain('Alice coat');

    const write = await t.inject({
      method: 'POST',
      url: `/wardrobe?ownerId=${alice.id}`,
      payload: { name: 'Bob addition', category: 'shirt' },
      headers: { cookie: bob.cookie },
    });
    expect(write.statusCode).toBe(403);
    expect(await garmentsNamed(t, 'Bob addition')).toBe(0);
  });

  it('a MANAGE invite upgrades the share and lets the grantee create', async () => {
    const token = await createInvite(alice.cookie, 'MANAGE');
    await acceptInvite(bob.cookie, token);

    const garmentId = await createGarment(t, {
      name: 'Bob addition',
      cookie: bob.cookie,
      ownerId: alice.id,
    });
    expect((await garmentRow(t, garmentId))?.ownerId).toBe(alice.id);

    const grid = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${alice.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(grid.body).toContain('Bob addition');
  });
});
