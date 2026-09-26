import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { type SharePermission, user, wardrobeShare } from '../../db/schema';
import { isUniqueViolation } from '../auth/queries';

/**
 * Wardrobe shares. A row is either an open invite (invite_token set, no
 * grantee, not accepted; the UI only makes these), an invite addressed to
 * a user (token and grantee set, not accepted), or an accepted share
 * (grantee and accepted_at set, token cleared). (grantor, grantee) is
 * unique, so a user holds at most one row per wardrobe.
 */

export interface ShareParty {
  id: number;
  email: string | null;
  firstName: string | null;
}

export interface ShareView {
  id: number;
  permission: SharePermission;
  inviteToken: string | null;
  acceptedAt: Date | null;
  grantor: ShareParty;
  grantee: ShareParty | null;
}

const grantor = alias(user, 'grantor');
const grantee = alias(user, 'grantee');

function selectShares(db: Db) {
  return db
    .select({
      id: wardrobeShare.id,
      permission: wardrobeShare.permission,
      inviteToken: wardrobeShare.inviteToken,
      acceptedAt: wardrobeShare.acceptedAt,
      grantor: {
        id: grantor.id,
        email: grantor.email,
        firstName: grantor.firstName,
      },
      grantee: {
        id: grantee.id,
        email: grantee.email,
        firstName: grantee.firstName,
      },
    })
    .from(wardrobeShare)
    .innerJoin(grantor, eq(grantor.id, wardrobeShare.grantorId))
    .leftJoin(grantee, eq(grantee.id, wardrobeShare.granteeId))
    .orderBy(wardrobeShare.id);
}

/** Everything the manage page lists for a user, in one round trip each. */
export async function sharesOf(db: Db, userId: number) {
  const [outbound, inbound, pending] = await Promise.all([
    // Wardrobes this user shares: accepted shares and open invites.
    selectShares(db).where(eq(wardrobeShare.grantorId, userId)),
    // Wardrobes shared with this user.
    selectShares(db).where(
      and(
        eq(wardrobeShare.granteeId, userId),
        isNotNull(wardrobeShare.acceptedAt),
      ),
    ),
    // Invites addressed to this user, not yet answered.
    selectShares(db).where(
      and(
        eq(wardrobeShare.granteeId, userId),
        isNull(wardrobeShare.acceptedAt),
      ),
    ),
  ]);
  return { outbound, inbound, pending };
}

export async function findInvite(
  db: Db,
  token: string,
): Promise<ShareView | undefined> {
  const [row] = await selectShares(db).where(
    eq(wardrobeShare.inviteToken, token),
  );
  return row;
}

export async function createInvite(
  db: Db,
  grantorId: number,
  permission: SharePermission,
): Promise<{ id: number; inviteToken: string }> {
  const [row] = await db
    .insert(wardrobeShare)
    .values({
      grantorId,
      permission,
      inviteToken: randomUUID(),
      createdAt: new Date(),
    })
    .returning({
      id: wardrobeShare.id,
      inviteToken: wardrobeShare.inviteToken,
    });
  return { id: row.id, inviteToken: row.inviteToken! };
}

/** Why an invite could not be accepted; each has its message on the manage page. */
export type AcceptRefusal =
  | 'not-found'
  | 'own-invite'
  | 'wrong-recipient'
  | 'already-shared';

export type AcceptResult =
  | { accepted: true; shareId: number; grantorId: number }
  | { accepted: false; reason: AcceptRefusal };

/**
 * Accepts an invite for `granteeId`, in one transaction with the invite row
 * locked. An accepted invite has no token any more, so "already accepted"
 * is "not found". A second invite from a wardrobe the user already has
 * folds into the existing share (upgrading VIEW to MANAGE) and is deleted.
 * A pending addressed invite from the same grantor collides with the
 * (grantor, grantee) constraint: that is "already shared".
 */
export async function acceptInvite(
  db: Db,
  token: string,
  granteeId: number,
): Promise<AcceptResult> {
  try {
    return await db.transaction(async (tx): Promise<AcceptResult> => {
      const [invite] = await tx
        .select()
        .from(wardrobeShare)
        .where(eq(wardrobeShare.inviteToken, token))
        .for('update');
      if (!invite || invite.acceptedAt) {
        return { accepted: false, reason: 'not-found' };
      }
      if (invite.grantorId === granteeId) {
        return { accepted: false, reason: 'own-invite' };
      }
      if (invite.granteeId !== null && invite.granteeId !== granteeId) {
        return { accepted: false, reason: 'wrong-recipient' };
      }

      const [existing] = await tx
        .select()
        .from(wardrobeShare)
        .where(
          and(
            eq(wardrobeShare.grantorId, invite.grantorId),
            eq(wardrobeShare.granteeId, granteeId),
            isNotNull(wardrobeShare.acceptedAt),
          ),
        );
      if (existing) {
        if (invite.permission === 'MANAGE' && existing.permission === 'VIEW') {
          await tx
            .update(wardrobeShare)
            .set({ permission: 'MANAGE' })
            .where(eq(wardrobeShare.id, existing.id));
        }
        await tx.delete(wardrobeShare).where(eq(wardrobeShare.id, invite.id));
        return {
          accepted: true,
          shareId: existing.id,
          grantorId: invite.grantorId,
        };
      }

      await tx
        .update(wardrobeShare)
        .set({ granteeId, acceptedAt: new Date(), inviteToken: null })
        .where(eq(wardrobeShare.id, invite.id));
      return {
        accepted: true,
        shareId: invite.id,
        grantorId: invite.grantorId,
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { accepted: false, reason: 'already-shared' };
    }
    throw error;
  }
}

/**
 * Deletes an unanswered invite: the addressee declining it, or the grantor
 * withdrawing an open link. Anyone else is refused (false), so an open link
 * survives for the person it was meant for.
 */
export async function declineInvite(
  db: Db,
  token: string,
  userId: number,
): Promise<boolean> {
  const [invite] = await db
    .select({
      id: wardrobeShare.id,
      grantorId: wardrobeShare.grantorId,
      granteeId: wardrobeShare.granteeId,
    })
    .from(wardrobeShare)
    .where(eq(wardrobeShare.inviteToken, token));
  if (!invite) return false;
  const answerer = invite.granteeId ?? invite.grantorId;
  if (answerer !== userId) return false;
  await db.delete(wardrobeShare).where(eq(wardrobeShare.id, invite.id));
  return true;
}

/**
 * Removes a share (or an outstanding invite) that `userId` is a party to:
 * the grantor revoking it or the grantee leaving. `not-found` also covers a
 * share between two other people, so share ids reveal nothing.
 */
export async function removeShare(
  db: Db,
  shareId: number,
  userId: number,
): Promise<'removed' | 'not-found'> {
  const [share] = await db
    .select({
      grantorId: wardrobeShare.grantorId,
      granteeId: wardrobeShare.granteeId,
    })
    .from(wardrobeShare)
    .where(eq(wardrobeShare.id, shareId));
  if (!share || (share.grantorId !== userId && share.granteeId !== userId)) {
    return 'not-found';
  }
  await db.delete(wardrobeShare).where(eq(wardrobeShare.id, shareId));
  return 'removed';
}
