import { and, eq, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/client';
import { markSecretChecked } from '../../metrics/request-timing';
import { isUniqueViolation } from '../../db/errors';
import {
  type SharePermission,
  SHARE_GRANTEE_UNIQUE,
  user,
  wardrobeShare,
} from '../../db/schema';

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

/**
 * Everything Profile › Sharing lists for a user, from one statement (#170;
 * it was three): every row the user is a party to, sorted into
 * - `outbound`: wardrobes this user shares, accepted shares and open invites;
 * - `inbound`: wardrobes shared with this user;
 * - `pending`: invites addressed to this user, not yet answered.
 */
export async function sharesOf(db: Db, userId: number) {
  const rows = await selectShares(db).where(
    or(
      eq(wardrobeShare.grantorId, userId),
      eq(wardrobeShare.granteeId, userId),
    ),
  );
  const received = rows.filter((row) => row.grantee?.id === userId);
  return {
    outbound: rows.filter((row) => row.grantor.id === userId),
    inbound: received.filter((row) => row.acceptedAt !== null),
    pending: received.filter((row) => row.acceptedAt === null),
  };
}

/** What the invite landing shows: the permission offered, and who offers it. */
export interface InviteView {
  permission: SharePermission;
  grantor: { firstName: string | null };
}

/**
 * The invite landing's read. The page is public (opened before signing in,
 * fetched by link previews), so the query reads the inviter's first name
 * alone, never an email, and nothing of the grantee. An accepted invite
 * has no token, so it is not found.
 */
export async function findInvite(
  db: Db,
  token: string,
): Promise<InviteView | undefined> {
  markSecretChecked();
  const [row] = await db
    .select({
      permission: wardrobeShare.permission,
      grantor: { firstName: user.firstName },
    })
    .from(wardrobeShare)
    .innerJoin(user, eq(user.id, wardrobeShare.grantorId))
    .where(eq(wardrobeShare.inviteToken, token));
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
 * Accepts an invite for `granteeId` in two statements (#170; it was a
 * transaction of five): the invite with the share its grantor already gave
 * this user, if any, then one write guarded by the token, so an invite
 * accepted, declined or withdrawn in between is "not found" and nothing
 * changes. An accepted invite has no token any more, so "already accepted"
 * is "not found" too. A second invite from a wardrobe the user already has
 * folds into the existing share (upgrading VIEW to MANAGE) and is deleted.
 * A pending addressed invite from the same grantor collides with the
 * (grantor, grantee) constraint: that is "already shared".
 */
export async function acceptInvite(
  db: Db,
  token: string,
  granteeId: number,
): Promise<AcceptResult> {
  markSecretChecked();
  const existing = alias(wardrobeShare, 'existing');
  const [invite] = await db
    .select({
      id: wardrobeShare.id,
      grantorId: wardrobeShare.grantorId,
      granteeId: wardrobeShare.granteeId,
      permission: wardrobeShare.permission,
      existing: { id: existing.id, permission: existing.permission },
    })
    .from(wardrobeShare)
    .leftJoin(
      existing,
      and(
        eq(existing.grantorId, wardrobeShare.grantorId),
        eq(existing.granteeId, granteeId),
        isNotNull(existing.acceptedAt),
      ),
    )
    .where(
      and(
        eq(wardrobeShare.inviteToken, token),
        isNull(wardrobeShare.acceptedAt),
      ),
    );
  if (!invite) return { accepted: false, reason: 'not-found' };
  const refusal = refusalOf(invite, granteeId);
  if (refusal) return { accepted: false, reason: refusal };
  // The invite as read: still holding its token, so still unanswered.
  const unanswered = and(
    eq(wardrobeShare.id, invite.id),
    eq(wardrobeShare.inviteToken, token),
  );
  const held = invite.existing;
  const outcome = held
    ? await foldInvite(db, unanswered, {
        shareId: held.id,
        upgrade: invite.permission === 'MANAGE' && held.permission === 'VIEW',
      })
    : await claimInvite(db, unanswered, granteeId);
  return typeof outcome === 'number'
    ? { accepted: true, shareId: outcome, grantorId: invite.grantorId }
    : { accepted: false, reason: outcome };
}

/** Why `granteeId` may not accept the invite as read, if they may not. */
function refusalOf(
  invite: { grantorId: number; granteeId: number | null },
  granteeId: number,
): AcceptRefusal | undefined {
  if (invite.grantorId === granteeId) return 'own-invite';
  if (invite.granteeId !== null && invite.granteeId !== granteeId) {
    return 'wrong-recipient';
  }
  return undefined;
}

/**
 * Makes the invite `granteeId`'s share: its id, or why not (gone meanwhile,
 * or the (grantor, grantee) constraint: another invite of theirs).
 */
async function claimInvite(
  db: Db,
  unanswered: SQL | undefined,
  granteeId: number,
): Promise<number | 'not-found' | 'already-shared'> {
  try {
    const [claimed] = await db
      .update(wardrobeShare)
      .set({ granteeId, acceptedAt: new Date(), inviteToken: null })
      .where(unanswered)
      .returning({ id: wardrobeShare.id });
    return claimed?.id ?? 'not-found';
  } catch (error) {
    if (isUniqueViolation(error, SHARE_GRANTEE_UNIQUE)) return 'already-shared';
    throw error;
  }
}

/**
 * Deletes an invite into the share its grantor already gave the user, in
 * one statement: the delete and, with `upgrade`, the share raised to MANAGE
 * only if the delete found the invite (data-modifying CTEs, which Postgres
 * runs whether or not the outer select reads them). The share's id, or
 * 'not-found' when the invite was answered meanwhile.
 */
async function foldInvite(
  db: Db,
  unanswered: SQL | undefined,
  into: { shareId: number; upgrade: boolean },
): Promise<number | 'not-found'> {
  const folded = db
    .$with('folded')
    .as(
      db
        .delete(wardrobeShare)
        .where(unanswered)
        .returning({ id: wardrobeShare.id }),
    );
  const upgraded = db.$with('upgraded').as(
    db
      .update(wardrobeShare)
      .set({ permission: 'MANAGE' })
      .where(
        and(
          eq(wardrobeShare.id, into.shareId),
          sql`exists (select 1 from ${folded})`,
        ),
      )
      .returning({ id: wardrobeShare.id }),
  );
  const [row] = await db
    .with(...(into.upgrade ? [folded, upgraded] : [folded]))
    .select({ found: sql<number>`count(*)::int` })
    .from(folded);
  return row.found > 0 ? into.shareId : 'not-found';
}

/**
 * Deletes an unanswered invite in one statement: the addressee declining
 * it, or the grantor withdrawing an open link (the invite's answerer:
 * its grantee, else its grantor). Anyone else is refused (false, nothing
 * deleted), so an open link survives for the person it was meant for.
 */
export async function declineInvite(
  db: Db,
  token: string,
  userId: number,
): Promise<boolean> {
  markSecretChecked();
  const deleted = await db
    .delete(wardrobeShare)
    .where(
      and(
        eq(wardrobeShare.inviteToken, token),
        eq(
          sql`coalesce(${wardrobeShare.granteeId}, ${wardrobeShare.grantorId})`,
          userId,
        ),
      ),
    )
    .returning({ id: wardrobeShare.id });
  return deleted.length > 0;
}

/**
 * Removes a share (or an outstanding invite) that `userId` is a party to,
 * in one statement: the grantor revoking it or the grantee leaving.
 * `not-found` also covers a share between two other people, so share ids
 * reveal nothing.
 */
export async function removeShare(
  db: Db,
  shareId: number,
  userId: number,
): Promise<'removed' | 'not-found'> {
  const removed = await db
    .delete(wardrobeShare)
    .where(
      and(
        eq(wardrobeShare.id, shareId),
        or(
          eq(wardrobeShare.grantorId, userId),
          eq(wardrobeShare.granteeId, userId),
        ),
      ),
    )
    .returning({ id: wardrobeShare.id });
  return removed.length > 0 ? 'removed' : 'not-found';
}
