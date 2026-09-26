import { and, count, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SharePermission, wardrobeShare } from '../../src/db/schema';
import { LOGIN_PATH } from '../../src/web/auth/session-access';
import { createGarment, garmentRow, garmentsNamed } from './garments';
import { createTestApp, TestApp, userIdOf } from './harness';

/**
 * A wardrobe share after it is created (share.spec.ts covers creating and
 * accepting): revoking it from either side ends read and write access,
 * declining an invite grants nothing, and the accept edge cases (the same
 * invite twice, your own invite, an invite addressed to someone else, a
 * clash with a pending addressed invite) are refused without a half-made
 * share. Every test uses fresh grantees so shares never interact.
 *
 * Without a share the owner's wardrobe does not exist for a user: reads and
 * writes addressing it are 404, as for an unknown id.
 */
describe('wardrobe share lifecycle', () => {
  let t: TestApp;
  let owner: Account;
  let garmentId: number;

  interface Account {
    id: number;
    cookie: string;
  }

  const MANAGE_PAGE = '/wardrobe-share/manage';

  const signUp = async (label: string): Promise<Account> => {
    const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
    const cookie = await t.register(email);
    const id = await userIdOf(t, email);
    return { id, cookie };
  };

  const createInvite = async (
    grantor: Account,
    permission: SharePermission,
  ) => {
    const res = await t.inject({
      method: 'POST',
      url: '/wardrobe-share/create-invite-link',
      payload: { permission },
      headers: { cookie: grantor.cookie, 'hx-request': 'true' },
    });
    const match = /\/wardrobe-share\/invite\/([0-9a-f-]{36})/.exec(res.body);
    if (!match) throw new Error(`No invite URL in partial:\n${res.body}`);
    return match[1];
  };

  /**
   * An invite with its grantee already set. The UI only makes open links
   * (grantee null); this is the row shape acceptInvite/declineInvite guard
   * with "sent to a different email address", so it is written directly.
   */
  const createAddressedInvite = async (addressee: Account) => {
    const inviteToken = randomUUID();
    await t.db.insert(wardrobeShare).values({
      grantorId: owner.id,
      granteeId: addressee.id,
      permission: 'VIEW',
      inviteToken,
      createdAt: new Date(),
    });
    return inviteToken;
  };

  const post = (url: string, account?: Account, payload?: object) =>
    t.inject({
      method: 'POST',
      url,
      payload,
      headers: account ? { cookie: account.cookie } : {},
      anonymous: !account,
    });

  const accept = (token: string, account?: Account) =>
    post(`/wardrobe-share/invite/${token}/accept`, account);

  const decline = (token: string, account?: Account) =>
    post(`/wardrobe-share/invite/${token}/decline`, account);

  const acceptOk = async (token: string, account: Account) => {
    const res = await accept(token, account);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(MANAGE_PAGE);
  };

  /**
   * A refused accept: redirect back to the manage page carrying the refusal
   * code, which the page shows as its message.
   */
  const expectAcceptRefused = async (
    res: Awaited<ReturnType<typeof accept>>,
    code: string,
    message: string,
    account: Account,
  ) => {
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${MANAGE_PAGE}?error=${code}`);
    const page = await t.inject({
      method: 'GET',
      url: `${MANAGE_PAGE}?error=${code}`,
      headers: { cookie: account.cookie },
    });
    expect(page.body).toContain(message);
  };

  type ShareRow = typeof wardrobeShare.$inferSelect;

  const shareBetween = async (grantee: Account): Promise<ShareRow | null> => {
    const [row] = await t.db
      .select()
      .from(wardrobeShare)
      .where(
        and(
          eq(wardrobeShare.grantorId, owner.id),
          eq(wardrobeShare.granteeId, grantee.id),
        ),
      );
    return row ?? null;
  };

  const shareByToken = async (token: string): Promise<ShareRow | null> => {
    const [row] = await t.db
      .select()
      .from(wardrobeShare)
      .where(eq(wardrobeShare.inviteToken, token));
    return row ?? null;
  };

  /** Status of reading the owner's wardrobe grid and garment as `account`. */
  const readStatuses = async (account: Account) => {
    const headers = { cookie: account.cookie };
    const [grid, garment] = await Promise.all([
      t.inject({
        method: 'GET',
        url: `/wardrobe?ownerId=${owner.id}`,
        headers,
      }),
      t.inject({
        method: 'GET',
        url: `/wardrobe/${garmentId}?ownerId=${owner.id}`,
        headers,
      }),
    ]);
    return [grid.statusCode, garment.statusCode];
  };

  /** Edit the owner's garment and create one in their wardrobe; statuses. */
  const writeStatuses = async (account: Account) => {
    const edit = await post(
      `/wardrobe/${garmentId}?ownerId=${owner.id}`,
      account,
      { name: `Edited by ${account.id}`, category: 'pants' },
    );
    const create = await post(`/wardrobe?ownerId=${owner.id}`, account, {
      name: `Planted by ${account.id}`,
      category: 'shirt',
    });
    return [edit.statusCode, create.statusCode];
  };

  const expectNoWritesLanded = async (account: Account) => {
    const garment = (await garmentRow(t, garmentId))!;
    expect(garment.name).toBe('Owner coat');
    expect(garment.category).toBe('shirt');
    expect(await garmentsNamed(t, `Planted by ${account.id}`)).toBe(0);
  };

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signUp('owner');
    garmentId = await createGarment(t, {
      name: 'Owner coat',
      cookie: owner.cookie,
    });
  });

  afterAll(() => t?.cleanup());

  it('the wardrobe switcher swaps the grid in place, never reloading the page', async () => {
    const grantee = await signUp('switcher');
    await acceptOk(await createInvite(owner, 'VIEW'), grantee);
    const page = await t.inject({
      method: 'GET',
      url: '/wardrobe',
      headers: { cookie: grantee.cookie },
    });
    const select = /<select\b[^>]*name="ownerId"[^>]*>/.exec(page.body)?.[0];
    expect(select).toBeDefined();
    expect(select).toContain('hx-get="/wardrobe"');
    expect(select).toContain('hx-target="#wardrobe-main"');
    expect(select).toContain('hx-push-url="true"');
    expect(page.body).toContain(`<option value="${owner.id}">`);

    // What htmx sends for the owner's option: the grid fragment alone.
    const swapped = await t.inject({
      method: 'GET',
      url: `/wardrobe?ownerId=${owner.id}`,
      headers: { cookie: grantee.cookie, 'hx-request': 'true' },
    });
    expect(swapped.statusCode).toBe(200);
    expect(swapped.body).toMatch(/^<main id="wardrobe-main"/);
    expect(swapped.body).toContain(
      `/wardrobe/${garmentId}?ownerId=${owner.id}`,
    );
    // And the empty value is the grantee's own wardrobe.
    const own = await t.inject({
      method: 'GET',
      url: '/wardrobe?ownerId=',
      headers: { cookie: grantee.cookie, 'hx-request': 'true' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).not.toContain(`/wardrobe/${garmentId}`);
  });

  it('the public invite page never shows the inviter email', async () => {
    const email = `inviter-${randomUUID().slice(0, 8)}@example.com`;
    const cookie = await t.register(email);
    const inviter = { id: await userIdOf(t, email), cookie };
    const token = await createInvite(inviter, 'VIEW');

    const res = await t.inject({
      method: 'GET',
      url: `/wardrobe-share/invite/${token}`,
      anonymous: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(email);
    expect(res.body).toContain('A user');
  });

  describe('revoke (POST /wardrobe-share/:id/remove)', () => {
    it('by the grantor: the MANAGE grantee loses read and write access', async () => {
      const grantee = await signUp('manager');
      await acceptOk(await createInvite(owner, 'MANAGE'), grantee);
      expect(await readStatuses(grantee)).toEqual([200, 200]);
      const share = await shareBetween(grantee);

      const res = await post(`/wardrobe-share/${share!.id}/remove`, owner);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(MANAGE_PAGE);
      expect(await shareBetween(grantee)).toBeNull();

      expect(await readStatuses(grantee)).toEqual([404, 404]);
      expect(await writeStatuses(grantee)).toEqual([404, 404]);
      await expectNoWritesLanded(grantee);
    });

    it('by the grantee: leaving a VIEW share ends read access', async () => {
      const grantee = await signUp('viewer');
      await acceptOk(await createInvite(owner, 'VIEW'), grantee);
      const share = await shareBetween(grantee);

      const res = await post(`/wardrobe-share/${share!.id}/remove`, grantee);
      expect(res.statusCode).toBe(302);
      expect(await shareBetween(grantee)).toBeNull();
      expect(await readStatuses(grantee)).toEqual([404, 404]);
    });

    it('by a third party or anonymously: refused, the share and its access stay', async () => {
      const grantee = await signUp('manager');
      const stranger = await signUp('stranger');
      await acceptOk(await createInvite(owner, 'MANAGE'), grantee);
      const share = await shareBetween(grantee);
      const url = `/wardrobe-share/${share!.id}/remove`;

      // Not their share: as unknown as a missing id.
      expect((await post(url, stranger)).statusCode).toBe(404);
      const anonymous = await post(url);
      expect(anonymous.statusCode).toBe(302);
      expect(anonymous.headers.location).toBe(LOGIN_PATH);

      expect(await shareBetween(grantee)).toMatchObject({
        id: share!.id,
        permission: 'MANAGE',
      });
      expect(await readStatuses(grantee)).toEqual([200, 200]);
    });

    it('an unknown share id is a 404', async () => {
      expect(
        (await post('/wardrobe-share/999999/remove', owner)).statusCode,
      ).toBe(404);
    });
  });

  describe('decline (POST /wardrobe-share/invite/:token/decline)', () => {
    // declineInvite doubles as "the grantor revokes an open link"; anyone
    // else declining an open link is refused (and the refusal swallowed by
    // the controller), so the link survives for whoever it was meant for.
    it('by a recipient of an open link: the link stays pending and they gain nothing', async () => {
      const recipient = await signUp('recipient');
      const token = await createInvite(owner, 'MANAGE');

      const res = await decline(token, recipient);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(MANAGE_PAGE);

      const invite = await shareByToken(token);
      expect(invite).not.toBeNull();
      expect(invite!.granteeId).toBeNull();
      expect(invite!.acceptedAt).toBeNull();
      expect(await shareBetween(recipient)).toBeNull();
      expect(await readStatuses(recipient)).toEqual([404, 404]);
    });

    it('by the grantor: the open link is deleted and can no longer be accepted', async () => {
      const recipient = await signUp('recipient');
      const token = await createInvite(owner, 'VIEW');

      expect((await decline(token, owner)).statusCode).toBe(302);
      expect(await shareByToken(token)).toBeNull();

      await expectAcceptRefused(
        await accept(token, recipient),
        'not-found',
        'Invite not found or has already been accepted.',
        recipient,
      );
      expect(await shareBetween(recipient)).toBeNull();
      expect(await readStatuses(recipient)).toEqual([404, 404]);
    });

    it('by the addressee of an addressed invite: the invite is deleted, no share made', async () => {
      const addressee = await signUp('addressee');
      const token = await createAddressedInvite(addressee);

      expect((await decline(token, addressee)).statusCode).toBe(302);
      expect(await shareByToken(token)).toBeNull();
      expect(await shareBetween(addressee)).toBeNull();
      expect(await readStatuses(addressee)).toEqual([404, 404]);
    });

    it('by someone other than the addressee: refused, the invite is untouched', async () => {
      const addressee = await signUp('addressee');
      const other = await signUp('other');
      const token = await createAddressedInvite(addressee);

      expect((await decline(token, other)).statusCode).toBe(302);
      const invite = await shareByToken(token);
      expect(invite!.granteeId).toBe(addressee.id);
      expect(invite!.acceptedAt).toBeNull();
    });

    it('anonymously: redirected to login, the invite is untouched', async () => {
      const token = await createInvite(owner, 'VIEW');
      const res = await decline(token);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(LOGIN_PATH);
      expect(await shareByToken(token)).not.toBeNull();
    });
  });

  describe('accept edge cases (POST /wardrobe-share/invite/:token/accept)', () => {
    it('the same invite twice: the second is refused and the share is unchanged', async () => {
      const grantee = await signUp('viewer');
      const token = await createInvite(owner, 'VIEW');
      await acceptOk(token, grantee);
      const first = await shareBetween(grantee);

      await expectAcceptRefused(
        await accept(token, grantee),
        'not-found',
        'Invite not found or has already been accepted.',
        grantee,
      );
      const [{ shares }] = await t.db
        .select({ shares: count() })
        .from(wardrobeShare)
        .where(eq(wardrobeShare.granteeId, grantee.id));
      expect(shares).toBe(1);
      expect(await shareBetween(grantee)).toMatchObject({
        id: first!.id,
        permission: 'VIEW',
      });
    });

    it('an invite someone else already accepted: refused, no access', async () => {
      const grantee = await signUp('viewer');
      const latecomer = await signUp('latecomer');
      const token = await createInvite(owner, 'MANAGE');
      await acceptOk(token, grantee);

      await expectAcceptRefused(
        await accept(token, latecomer),
        'not-found',
        'Invite not found or has already been accepted.',
        latecomer,
      );
      expect(await shareBetween(latecomer)).toBeNull();
      expect(await readStatuses(latecomer)).toEqual([404, 404]);
      expect(await writeStatuses(latecomer)).toEqual([404, 404]);
      await expectNoWritesLanded(latecomer);
    });

    it('your own invite: refused, the link stays pending', async () => {
      const token = await createInvite(owner, 'MANAGE');

      await expectAcceptRefused(
        await accept(token, owner),
        'own-invite',
        'You cannot accept your own invite.',
        owner,
      );
      const invite = await shareByToken(token);
      expect(invite!.granteeId).toBeNull();
      expect(invite!.acceptedAt).toBeNull();
    });

    it('an invite addressed to someone else: refused, only the addressee can accept', async () => {
      const addressee = await signUp('addressee');
      const other = await signUp('other');
      const token = await createAddressedInvite(addressee);

      await expectAcceptRefused(
        await accept(token, other),
        'wrong-recipient',
        'This invite was sent to a different email address.',
        other,
      );
      expect(await shareBetween(other)).toBeNull();
      expect(await readStatuses(other)).toEqual([404, 404]);
      expect(await shareByToken(token)).toMatchObject({ acceptedAt: null });

      await acceptOk(token, addressee);
      expect(await readStatuses(addressee)).toEqual([200, 200]);
    });

    // The unique (grantor, grantee) constraint trips when a user with a
    // pending addressed invite accepts an open link from the same grantor;
    // acceptInvite maps the violation to a 400-style refusal (audit A4 bug 1
    // was this path turning into a 500).
    it('an open link while an addressed invite is pending: refused without a 500', async () => {
      const addressee = await signUp('addressee');
      const pending = await createAddressedInvite(addressee);
      const open = await createInvite(owner, 'MANAGE');

      await expectAcceptRefused(
        await accept(open, addressee),
        'already-shared',
        'You already have access to this wardrobe.',
        addressee,
      );
      expect(await readStatuses(addressee)).toEqual([404, 404]);
      expect(await shareByToken(open)).toMatchObject({ granteeId: null });
      expect(await shareByToken(pending)).toMatchObject({ acceptedAt: null });
    });

    it('anonymously: redirected to login, the invite is untouched', async () => {
      const token = await createInvite(owner, 'VIEW');
      const res = await accept(token);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(LOGIN_PATH);
      expect(await shareByToken(token)).toMatchObject({ granteeId: null });
    });
  });
});
