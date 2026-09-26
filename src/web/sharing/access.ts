import { and, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type SharePermission, user, wardrobeShare } from '../../db/schema';

/**
 * What the requesting user may do with the wardrobe a request addresses.
 * `ownerId` is the wardrobe actually being read or written (the requester's
 * own unless a share is in play), so callers pass it straight on.
 *
 * Refusal policy (callers turn this into a status): without `canView` the
 * wardrobe does not exist for the requester, a 404, so ids never reveal
 * whose data exists. With `canView` but not what the route needs
 * (`canManage`, or ownership), a 403: they know it exists.
 */
export interface WardrobeAccess {
  ownerId: number;
  isOwner: boolean;
  canView: boolean;
  canManage: boolean;
  permission?: SharePermission;
}

/**
 * The single ownership resolver for wardrobe routes. At most one share
 * lookup; none for the requester's own wardrobe. Used by the Nest garment
 * routes through WardrobeShareService until they are ported.
 */
export async function resolveWardrobeAccess(
  db: Db,
  userId: number,
  ownerId: number | undefined,
): Promise<WardrobeAccess> {
  if (ownerId == null || ownerId === userId) {
    return { ownerId: userId, isOwner: true, canView: true, canManage: true };
  }
  const [share] = await db
    .select({ permission: wardrobeShare.permission })
    .from(wardrobeShare)
    .where(
      and(
        eq(wardrobeShare.grantorId, ownerId),
        eq(wardrobeShare.granteeId, userId),
        isNotNull(wardrobeShare.acceptedAt),
      ),
    );
  return {
    ownerId,
    isOwner: false,
    canView: share !== undefined,
    canManage: share?.permission === 'MANAGE',
    permission: share?.permission,
  };
}

export interface SharedWardrobe {
  grantorId: number;
  grantorName: string;
  permission: SharePermission;
}

/** Wardrobes shared with `userId`, for the wardrobe page's switcher. */
export async function sharedWardrobesOf(
  db: Db,
  userId: number,
): Promise<SharedWardrobe[]> {
  const rows = await db
    .select({
      grantorId: wardrobeShare.grantorId,
      firstName: user.firstName,
      email: user.email,
      permission: wardrobeShare.permission,
    })
    .from(wardrobeShare)
    .innerJoin(user, eq(user.id, wardrobeShare.grantorId))
    .where(
      and(
        eq(wardrobeShare.granteeId, userId),
        isNotNull(wardrobeShare.acceptedAt),
      ),
    )
    .orderBy(wardrobeShare.id);
  return rows.map((row) => ({
    grantorId: row.grantorId,
    grantorName: row.firstName || row.email || '',
    permission: row.permission,
  }));
}
