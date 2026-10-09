import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { garment, garmentWear } from '../../src/db/schema';
import { addDays } from '../../src/calendar-date';
import { acceptInvite, createInvite } from '../../src/web/sharing/queries';
import { createGarment, createWishlistItem } from './garments';
import { createTestApp, type TestApp, userIdOf } from './harness';
import { callTool, createAccessToken, tool } from './mcp';

/**
 * get_wardrobe (#277): the whole closet in one read. The owner's wears are
 * theirs alone (as get_garment), the wishlist is never in it, an archived
 * garment only on request, and a wardrobe without a share is refused.
 */

interface WardrobeGarment {
  id: number;
  name: string;
  category: string;
  copies: number;
  condition: string;
  wears?: number;
  lastWorn?: string | null;
}

describe('MCP get_wardrobe', () => {
  let t: TestApp;
  let token: string;
  let viewerToken: string;
  let strangerToken: string;
  let worn: number;
  let unworn: number;
  let archived: number;
  let wishlisted: number;

  const read = (callerToken: string, args: Record<string, unknown> = {}) =>
    tool<{ total: number; garments: WardrobeGarment[] }>(
      t,
      callerToken,
      'get_wardrobe',
      args,
    );

  const signUp = async (email: string) => {
    const cookie = await t.register(email);
    return {
      id: await userIdOf(t, email),
      token: await createAccessToken(t, { cookie }),
    };
  };

  beforeAll(async () => {
    t = await createTestApp();
    worn = await createGarment(t, { name: 'Worn tee', category: 'tops' });
    unworn = await createGarment(t, {
      name: 'Fresh jeans',
      category: 'bottoms',
    });
    archived = await createGarment(t, {
      name: 'Old coat',
      category: 'outerwear',
    });
    wishlisted = await createWishlistItem(t, { name: 'Wanted shirt' });
    await t.db
      .update(garment)
      .set({ status: 'archived' })
      .where(eq(garment.id, archived));
    await t.db.update(garment).set({ quantity: 3 }).where(eq(garment.id, worn));
    await t.db.insert(garmentWear).values(
      [5, 2].map((days) => ({
        garmentId: worn,
        ownerId: t.owner.id,
        day: addDays(t.today(), -days),
        outfitCalendarId: null,
      })),
    );

    token = await createAccessToken(t);
    const viewer = await signUp('viewer@example.com');
    viewerToken = viewer.token;
    strangerToken = (await signUp('stranger@example.com')).token;
    const invite = await createInvite(t.db, t.owner.id, 'VIEW');
    expect(
      (await acceptInvite(t.db, invite.inviteToken, viewer.id)).accepted,
    ).toBe(true);
  });

  afterAll(() => t?.cleanup());

  it("answers the owner's closet with copies and wears, no wishlist and no archived", async () => {
    const { total, garments } = await read(token);
    expect(total).toBe(2);
    expect(garments.map((g) => g.id).sort()).toEqual([worn, unworn].sort());
    expect(garments.find((g) => g.id === worn)).toMatchObject({
      name: 'Worn tee',
      category: 'tops',
      copies: 3,
      condition: 'good',
      wears: 2,
      lastWorn: addDays(t.today(), -2),
    });
    expect(garments.find((g) => g.id === unworn)).toMatchObject({
      wears: 0,
      lastWorn: null,
    });
    expect(garments.map((g) => g.id)).not.toContain(wishlisted);
  });

  it('includes archived garments only on request', async () => {
    const { garments } = await read(token, { includeArchived: true });
    expect(garments.map((g) => g.id)).toContain(archived);
    expect(garments.map((g) => g.id)).not.toContain(wishlisted);
  });

  it("gives a grantee the closet without the owner's wears", async () => {
    const { total, garments } = await read(viewerToken, {
      ownerId: t.owner.id,
    });
    expect(total).toBe(2);
    for (const g of garments) {
      expect(g).not.toHaveProperty('wears');
      expect(g).not.toHaveProperty('lastWorn');
    }
  });

  it('refuses a wardrobe that is not shared', async () => {
    const answer = await callTool(t, strangerToken, 'get_wardrobe', {
      ownerId: t.owner.id,
    });
    expect(answer).toMatchObject({
      isError: true,
      value: { error: 'Wardrobe not found' },
    });
  });
});
