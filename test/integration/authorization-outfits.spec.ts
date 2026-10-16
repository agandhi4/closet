import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { outfit, outfitSlot } from '../../src/db/schema';
import { describeMatrix } from './authorization-matrix';
import { ROUTES } from './authorization-outfits.routes';

describeMatrix('outfits', ROUTES, (m) => {
  // The outfit form posts garment ids; an id outside the requester's own
  // wardrobe refuses the save whole (#219): a 404 like an unknown id, the
  // garment never named, nothing written. So no outfit can reference a
  // shared garment.
  const outfitsOf = (ownerId: number) =>
    m.t.db.$count(outfit, eq(outfit.ownerId, ownerId));

  it.each(['manager', 'viewer', 'stranger'] as const)(
    "POST /outfits as %s refuses the owner's garment ids",
    async (actor) => {
      const { id, cookie } = m.actors[actor];
      if (id === undefined) throw new Error(`${actor} has no account`);
      const before = await outfitsOf(id);
      const res = await m.t.inject({
        method: 'POST',
        url: `/outfits?ownerId=${m.actors.owner.id}`,
        payload: {
          name: `Borrowed ${actor}`,
          category: 'shirt',
          garmentId: String(m.shared.garmentId),
        },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(m.shared.garmentName);
      expect(await outfitsOf(id)).toBe(before);

      // Their own empty outfit, then an edit naming the owner's garment.
      const own = await m.t.inject({
        method: 'POST',
        url: '/outfits',
        payload: { name: `Own ${actor}` },
        headers: { cookie },
      });
      expect(own.statusCode).toBe(302);
      const outfitId = Number(
        /^\/outfits\/(\d+)$/.exec(own.headers.location as string)?.[1],
      );
      const edit = await m.t.inject({
        method: 'POST',
        url: `/outfits/${outfitId}`,
        payload: { category: 'shirt', garmentId: String(m.shared.garmentId) },
        headers: { cookie },
      });
      expect(edit.statusCode).toBe(404);
      expect(edit.body).not.toContain(m.shared.garmentName);
      expect(
        await m.t.db.$count(outfitSlot, eq(outfitSlot.outfitId, outfitId)),
      ).toBe(0);
    },
  );
});
