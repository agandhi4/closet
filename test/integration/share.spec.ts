import { Garment } from '../../src/dal/entity/garment.entity';
import { User } from '../../src/dal/entity/user.entity';
import { createGarment } from './garments';
import { createTestApp, TestApp } from './harness';

describe('wardrobe sharing', () => {
  let t: TestApp;
  let alice: { id: number; cookie: string };
  let bob: { id: number; cookie: string };

  const userId = async (email: string) =>
    (await t.em().findOneOrFail(User, { email })).id;

  /** The htmx form on /wardrobe-share/manage: returns the invite token. */
  const createInvite = async (
    cookie: string,
    permission: 'VIEW' | 'MANAGE',
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission },
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.statusCode).toBeLessThan(300);
    const match = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(res.body);
    if (!match) throw new Error(`No invite URL in partial:\n${res.body}`);
    return match[1];
  };

  const acceptInvite = async (cookie: string, token: string) => {
    const res = await t.inject({
      method: 'POST',
      url: `/wardrobe-share/invite/${token}/accept`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    // A failed accept redirects to the same page with ?error=.
    expect(res.headers.location).toBe('/wardrobe-share/manage');
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
    expect(await t.em().count(Garment, { name: 'Bob addition' })).toBe(0);
  });

  it('a MANAGE invite upgrades the share and lets the grantee create', async () => {
    const token = await createInvite(alice.cookie, 'MANAGE');
    await acceptInvite(bob.cookie, token);

    const garmentId = await createGarment(t, {
      name: 'Bob addition',
      cookie: bob.cookie,
      ownerId: alice.id,
    });
    const garment = await t
      .em()
      .findOneOrFail(Garment, garmentId, { populate: ['owner'] });
    expect(garment.owner.id).toBe(alice.id);

    const grid = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${alice.id}`,
      headers: { cookie: alice.cookie },
    });
    expect(grid.body).toContain('Bob addition');
  });
});
