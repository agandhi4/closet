import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Garment } from '../../src/dal/entity/garment.entity';
import { User } from '../../src/dal/entity/user.entity';
import {
  SharePermission,
  WardrobeShare,
} from '../../src/dal/entity/wardrobe-share.entity';
import { LOGIN_PATH } from '../../src/auth/redirect-to-login.exception';
import { createGarment } from './garments';
import { createTestApp, TestApp } from './harness';

/**
 * A wardrobe share after it is created (share.spec.ts covers creating and
 * accepting): revoking it from either side ends read and write access,
 * declining an invite grants nothing, and the accept edge cases (the same
 * invite twice, your own invite, an invite addressed to someone else, a
 * clash with a pending addressed invite) are refused without a half-made
 * share. Every test uses fresh grantees so shares never interact.
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
    const { id } = await t.em().findOneOrFail(User, { email });
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
    const em = t.em();
    const share = em.create(WardrobeShare, {
      grantor: owner.id,
      grantee: addressee.id,
      permission: SharePermission.VIEW,
      inviteToken: randomUUID(),
      createdAt: new Date(),
    });
    await em.flush();
    return share.inviteToken!;
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

  /** A refused accept: redirect back to the manage page carrying ?error=. */
  const expectAcceptRefused = (
    res: Awaited<ReturnType<typeof accept>>,
    message: string,
  ) => {
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${MANAGE_PAGE}?error=${encodeURIComponent(message)}`,
    );
  };

  const shareBetween = (grantee: Account) =>
    t.em().findOne(WardrobeShare, { grantor: owner.id, grantee: grantee.id });

  const shareByToken = (token: string) =>
    t.em().findOne(WardrobeShare, { inviteToken: token });

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
    const garment = await t.em().findOneOrFail(Garment, garmentId);
    expect(garment.name).toBe('Owner coat');
    expect(garment.category).toBe('shirt');
    expect(
      await t.em().count(Garment, { name: `Planted by ${account.id}` }),
    ).toBe(0);
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

  describe('revoke (POST /wardrobe-share/:id/remove)', () => {
    it('by the grantor: the MANAGE grantee loses read and write access', async () => {
      const grantee = await signUp('manager');
      await acceptOk(
        await createInvite(owner, SharePermission.MANAGE),
        grantee,
      );
      expect(await readStatuses(grantee)).toEqual([200, 200]);
      const share = await shareBetween(grantee);

      const res = await post(`/wardrobe-share/${share!.id}/remove`, owner);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(MANAGE_PAGE);
      expect(await shareBetween(grantee)).toBeNull();

      expect(await readStatuses(grantee)).toEqual([403, 403]);
      expect(await writeStatuses(grantee)).toEqual([403, 403]);
      await expectNoWritesLanded(grantee);
    });

    it('by the grantee: leaving a VIEW share ends read access', async () => {
      const grantee = await signUp('viewer');
      await acceptOk(await createInvite(owner, SharePermission.VIEW), grantee);
      const share = await shareBetween(grantee);

      const res = await post(`/wardrobe-share/${share!.id}/remove`, grantee);
      expect(res.statusCode).toBe(302);
      expect(await shareBetween(grantee)).toBeNull();
      expect(await readStatuses(grantee)).toEqual([403, 403]);
    });

    it('by a third party or anonymously: refused, the share and its access stay', async () => {
      const grantee = await signUp('manager');
      const stranger = await signUp('stranger');
      await acceptOk(
        await createInvite(owner, SharePermission.MANAGE),
        grantee,
      );
      const share = await shareBetween(grantee);
      const url = `/wardrobe-share/${share!.id}/remove`;

      expect((await post(url, stranger)).statusCode).toBe(403);
      const anonymous = await post(url);
      expect(anonymous.statusCode).toBe(302);
      expect(anonymous.headers.location).toBe(LOGIN_PATH);

      expect(await shareBetween(grantee)).toMatchObject({
        id: share!.id,
        permission: SharePermission.MANAGE,
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
      const token = await createInvite(owner, SharePermission.MANAGE);

      const res = await decline(token, recipient);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(MANAGE_PAGE);

      const invite = await shareByToken(token);
      expect(invite).not.toBeNull();
      expect(invite!.grantee).toBeNull();
      expect(invite!.acceptedAt).toBeNull();
      expect(await shareBetween(recipient)).toBeNull();
      expect(await readStatuses(recipient)).toEqual([403, 403]);
    });

    it('by the grantor: the open link is deleted and can no longer be accepted', async () => {
      const recipient = await signUp('recipient');
      const token = await createInvite(owner, SharePermission.VIEW);

      expect((await decline(token, owner)).statusCode).toBe(302);
      expect(await shareByToken(token)).toBeNull();

      expectAcceptRefused(
        await accept(token, recipient),
        'Invite not found or has already been accepted.',
      );
      expect(await shareBetween(recipient)).toBeNull();
      expect(await readStatuses(recipient)).toEqual([403, 403]);
    });

    it('by the addressee of an addressed invite: the invite is deleted, no share made', async () => {
      const addressee = await signUp('addressee');
      const token = await createAddressedInvite(addressee);

      expect((await decline(token, addressee)).statusCode).toBe(302);
      expect(await shareByToken(token)).toBeNull();
      expect(await shareBetween(addressee)).toBeNull();
      expect(await readStatuses(addressee)).toEqual([403, 403]);
    });

    it('by someone other than the addressee: refused, the invite is untouched', async () => {
      const addressee = await signUp('addressee');
      const other = await signUp('other');
      const token = await createAddressedInvite(addressee);

      expect((await decline(token, other)).statusCode).toBe(302);
      const invite = await shareByToken(token);
      expect(invite!.grantee?.id).toBe(addressee.id);
      expect(invite!.acceptedAt).toBeNull();
    });

    it('anonymously: redirected to login, the invite is untouched', async () => {
      const token = await createInvite(owner, SharePermission.VIEW);
      const res = await decline(token);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(LOGIN_PATH);
      expect(await shareByToken(token)).not.toBeNull();
    });
  });

  describe('accept edge cases (POST /wardrobe-share/invite/:token/accept)', () => {
    it('the same invite twice: the second is refused and the share is unchanged', async () => {
      const grantee = await signUp('viewer');
      const token = await createInvite(owner, SharePermission.VIEW);
      await acceptOk(token, grantee);
      const first = await shareBetween(grantee);

      expectAcceptRefused(
        await accept(token, grantee),
        'Invite not found or has already been accepted.',
      );
      expect(await t.em().count(WardrobeShare, { grantee: grantee.id })).toBe(
        1,
      );
      expect(await shareBetween(grantee)).toMatchObject({
        id: first!.id,
        permission: SharePermission.VIEW,
      });
    });

    it('an invite someone else already accepted: refused, no access', async () => {
      const grantee = await signUp('viewer');
      const latecomer = await signUp('latecomer');
      const token = await createInvite(owner, SharePermission.MANAGE);
      await acceptOk(token, grantee);

      expectAcceptRefused(
        await accept(token, latecomer),
        'Invite not found or has already been accepted.',
      );
      expect(await shareBetween(latecomer)).toBeNull();
      expect(await readStatuses(latecomer)).toEqual([403, 403]);
      expect(await writeStatuses(latecomer)).toEqual([403, 403]);
      await expectNoWritesLanded(latecomer);
    });

    it('your own invite: refused, the link stays pending', async () => {
      const token = await createInvite(owner, SharePermission.MANAGE);

      expectAcceptRefused(
        await accept(token, owner),
        'You cannot accept your own invite.',
      );
      const invite = await shareByToken(token);
      expect(invite!.grantee).toBeNull();
      expect(invite!.acceptedAt).toBeNull();
    });

    it('an invite addressed to someone else: refused, only the addressee can accept', async () => {
      const addressee = await signUp('addressee');
      const other = await signUp('other');
      const token = await createAddressedInvite(addressee);

      expectAcceptRefused(
        await accept(token, other),
        'This invite was sent to a different email address.',
      );
      expect(await shareBetween(other)).toBeNull();
      expect(await readStatuses(other)).toEqual([403, 403]);
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
      const open = await createInvite(owner, SharePermission.MANAGE);

      expectAcceptRefused(
        await accept(open, addressee),
        'You already have access to this wardrobe.',
      );
      expect(await readStatuses(addressee)).toEqual([403, 403]);
      expect(await shareByToken(open)).toMatchObject({ grantee: null });
      expect(await shareByToken(pending)).toMatchObject({ acceptedAt: null });
    });

    it('anonymously: redirected to login, the invite is untouched', async () => {
      const token = await createInvite(owner, SharePermission.VIEW);
      const res = await accept(token);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(LOGIN_PATH);
      expect(await shareByToken(token)).toMatchObject({ grantee: null });
    });
  });
});
