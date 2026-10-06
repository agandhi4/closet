import { ownerTransaction } from '../auth/queries';
import { buyGarment, type BuyOutcome, type Purchase } from '../wardrobe/status';
import type { WardrobeDeps } from '../wardrobe/writes';
import { decide } from './decisions';

/**
 * "Bought it" (POST /wardrobe/:id/bought), in one owner transaction: the
 * buy (buyGarment: the wishlist item into the closet with its purchase,
 * and the garment it replaces archived when asked), then, for a Muse pick,
 * its need settled (decide's `bought`: resolved by it, its other open
 * picks set aside as chose_another, #333). `ownerId` is the wardrobe's
 * owner (the owner lock's key), not necessarily the requester: a MANAGE
 * grantee buys too.
 */
export async function buyWishlistItem(
  { db, logger }: Pick<WardrobeDeps, 'db' | 'logger'>,
  garmentId: number,
  ownerId: number,
  purchase: Purchase & { archiveReplaced: boolean },
): Promise<BuyOutcome> {
  // The owner lock before buyGarment's garment locks: decide needs it, and a
  // pick takes it before its garments, so the other order could deadlock.
  const outcome = await ownerTransaction(
    db,
    ownerId,
    'buyWishlistItem',
    async (tx) => {
      const bought = await buyGarment(tx, garmentId, ownerId, purchase);
      if (!bought.ok) return bought;
      // Not a suggestion: the writer finds no group and writes nothing.
      const settled = await decide(tx, ownerId, { kind: 'bought', garmentId });
      return { ...bought, settled };
    },
  );
  if (!outcome.ok) return outcome;
  if (outcome.settled.ok && outcome.settled.groupId !== null) {
    logger.info(
      `Garment ${garmentId} bought for user ${ownerId} resolves option group ${outcome.settled.groupId}; picks ${outcome.settled.dismissed.join(', ') || 'none'} set aside as chose_another`,
    );
  }
  return { ok: true, archivedReplaced: outcome.archivedReplaced };
}
