import { asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { garment, outfit, outfitSlot } from '../../db/schema';

/**
 * The public share page's reads: a garment or an outfit by its share id,
 * whoever asks (a share link is a bearer link), with its owner's email.
 * Photos carry their shareableId, which addresses the watermarked Open Graph
 * image (/file/watermark/:shareableId).
 */

const PHOTO_COLUMNS = {
  columns: { fileName: true, version: true, shareableId: true },
} as const;

export async function findSharedGarment(db: Db, shareableId: string) {
  return db.query.garment.findFirst({
    columns: { name: true, category: true, brand: true },
    where: eq(garment.shareableId, shareableId),
    with: { owner: { columns: { email: true } }, photo: PHOTO_COLUMNS },
  });
}

export type SharedGarment = NonNullable<
  Awaited<ReturnType<typeof findSharedGarment>>
>;

/** The outfit with its chosen garments in the order it was built. */
export async function findSharedOutfit(db: Db, shareableId: string) {
  const row = await db.query.outfit.findFirst({
    columns: { name: true, notes: true },
    where: eq(outfit.shareableId, shareableId),
    with: {
      owner: { columns: { email: true } },
      slots: {
        columns: {},
        where: isNotNull(outfitSlot.garmentId),
        orderBy: asc(outfitSlot.position),
        with: {
          garment: {
            columns: { id: true, name: true },
            with: { photo: PHOTO_COLUMNS },
          },
        },
      },
    },
  });
  if (!row) return undefined;
  const { slots, ...fields } = row;
  return {
    ...fields,
    garments: slots.flatMap(({ garment: shown }) => (shown ? [shown] : [])),
  };
}

export type SharedOutfit = NonNullable<
  Awaited<ReturnType<typeof findSharedOutfit>>
>;
