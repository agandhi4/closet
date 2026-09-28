import { and, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db } from '../../db/client';
import { type SharePermission, user, wardrobeShare } from '../../db/schema';
import { sessionUserId } from '../auth/require-session';
import { HttpError } from '../errors';

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
 * Who asks: a signed-in request (a page or a form, whose session statement
 * may have read the share its `?ownerId=` names already: shareToReadAhead),
 * or a user id (the MCP tools, which have no cookie session and read the
 * share themselves).
 */
export type Requester = FastifyRequest | number;

/** The one definition of a share that opens `ownerId`'s wardrobe to `userId`. */
function acceptedShare(ownerId: number, userId: number) {
  return and(
    eq(wardrobeShare.grantorId, ownerId),
    eq(wardrobeShare.granteeId, userId),
    isNotNull(wardrobeShare.acceptedAt),
  );
}

/** What the session statement read of the share a request addresses. */
export interface ShareReadAhead {
  ownerId: number;
  /** Null: no accepted share, so that wardrobe does not exist for the requester. */
  permission: SharePermission | null;
}

const sharesReadAhead = new WeakMap<FastifyRequest, ShareReadAhead>();

// RowId's maximum (src/web/schemas.ts): ids are int4.
const MAX_ROW_ID = 2_147_483_647;

/**
 * The other user's wardrobe a request's `?ownerId=` names, whose share the
 * session statement reads in the same round trip (findSessionAccount,
 * src/web/auth/queries.ts), so a grantee's request pays no statement of
 * its own for the access check (#170). Undefined for one's own wardrobe and
 * for anything but a plain row id: the route's schema judges those, and
 * resolveWardrobeAccess then reads the share itself (a body's `ownerId`
 * too). The session hook runs before validation, so this reads the raw
 * query string.
 */
export function shareToReadAhead(
  request: FastifyRequest,
  userId: number,
): number | undefined {
  const raw = (request.query as Record<string, unknown> | undefined)?.ownerId;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const ownerId = Number(raw);
  return ownerId <= MAX_ROW_ID && ownerId !== userId ? ownerId : undefined;
}

/**
 * The permission of `userId`'s accepted share of `ownerId`'s wardrobe as a
 * scalar subquery, null for none: a column of the session statement.
 */
export function sharePermissionSql(
  ownerId: number,
  userId: number,
): SQL<SharePermission | null> {
  return sql<SharePermission | null>`(
    select ${wardrobeShare.permission} from ${wardrobeShare}
    where ${acceptedShare(ownerId, userId)}
  )`;
}

/**
 * Keeps what the session statement read, for this request alone: the
 * resolver stores it only for a cookie that opened a session, and the next
 * request reads the share again, so a revoked share stops access there.
 */
export function rememberShareReadAhead(
  request: FastifyRequest,
  share: ShareReadAhead,
): void {
  sharesReadAhead.set(request, share);
}

/** The requester's share of `ownerId`'s wardrobe: the one read ahead when it is this wardrobe's, else a statement. */
async function sharePermission(
  db: Db,
  requester: Requester,
  userId: number,
  ownerId: number,
): Promise<SharePermission | null> {
  const ahead =
    typeof requester === 'number' ? undefined : sharesReadAhead.get(requester);
  if (ahead?.ownerId === ownerId) return ahead.permission;
  const [share] = await db
    .select({ permission: wardrobeShare.permission })
    .from(wardrobeShare)
    .where(acceptedShare(ownerId, userId));
  return share?.permission ?? null;
}

/**
 * The single ownership resolver for wardrobe routes (src/web/wardrobe). At
 * most one share lookup: none for the requester's own wardrobe, and none
 * for a request whose session statement read the share already.
 */
export async function resolveWardrobeAccess(
  db: Db,
  requester: Requester,
  ownerId: number | undefined,
): Promise<WardrobeAccess> {
  const userId =
    typeof requester === 'number' ? requester : sessionUserId(requester);
  if (ownerId == null || ownerId === userId) {
    return { ownerId: userId, isOwner: true, canView: true, canManage: true };
  }
  const permission = await sharePermission(db, requester, userId, ownerId);
  return {
    ownerId,
    isOwner: false,
    canView: permission !== null,
    canManage: permission === 'MANAGE',
    permission: permission ?? undefined,
  };
}

/** What a route needs of the wardrobe it addresses. */
export type WardrobeNeed = 'view' | 'manage' | 'own';

export interface AuthorizedWardrobe {
  access: WardrobeAccess;
  /** The shared wardrobe addressed, for links; undefined for one's own. */
  viewOwner: number | undefined;
}

/**
 * The refusal policy above, applied: resolves the wardrobe `ownerId` names
 * (`''` or absent: the requester's own) and throws unless the requester has
 * what the route `need`s: a view (404 without one, `notFound` its message,
 * so the page reads like an unknown id), a MANAGE share or ownership (403),
 * or ownership (403). Every route that takes `?ownerId=` goes through it:
 * the garment routes (src/web/wardrobe) and the capsule routes
 * (src/web/capsules).
 */
export async function authorizeWardrobe(
  db: Db,
  requester: Requester,
  ownerId: number | '' | undefined,
  need: WardrobeNeed,
  notFound: string,
): Promise<AuthorizedWardrobe> {
  const access = await resolveWardrobeAccess(
    db,
    requester,
    ownerId || undefined,
  );
  if (!access.canView) throw new HttpError(404, notFound);
  if (need === 'manage' && !access.canManage) throw new HttpError(403);
  if (need === 'own' && !access.isOwner) throw new HttpError(403);
  // `?ownerId=<self>` is the own wardrobe (nobody shares with themselves),
  // and its links must not carry the parameter.
  return { access, viewOwner: access.isOwner ? undefined : access.ownerId };
}

export interface SharedWardrobe {
  grantorId: number;
  /** The first name, else the email: what the switcher shows the grantee. */
  grantorName: string;
  /** The first name alone (the MCP tools never pass an email on). */
  grantorFirstName: string | null;
  permission: SharePermission;
}

/** A share with `userId` as sharedWardrobesOf and sharedWardrobesSql read it. */
export interface SharedWardrobeRow {
  grantorId: number;
  firstName: string | null;
  email: string | null;
  permission: SharePermission;
}

function acceptedSharesWith(userId: number) {
  return and(
    eq(wardrobeShare.granteeId, userId),
    isNotNull(wardrobeShare.acceptedAt),
  );
}

export function toSharedWardrobe(row: SharedWardrobeRow): SharedWardrobe {
  return {
    grantorId: row.grantorId,
    grantorName: row.firstName || row.email || '',
    grantorFirstName: row.firstName || null,
    permission: row.permission,
  };
}

/** Wardrobes shared with `userId`: the other tabs' switchers, list_shared_wardrobes (MCP). */
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
    .where(acceptedSharesWith(userId))
    .orderBy(wardrobeShare.id);
  return rows.map(toSharedWardrobe);
}

/**
 * sharedWardrobesOf's rows as a scalar subquery (a JSON array, empty for
 * none; map each through toSharedWardrobe), for a page that reads it in
 * one statement with its other lists: the grid's switcher (gridContext,
 * src/web/wardrobe/grid-context.ts).
 */
export function sharedWardrobesSql(userId: number): SQL<SharedWardrobeRow[]> {
  return sql<SharedWardrobeRow[]>`(
    select coalesce(
      json_agg(
        json_build_object(
          'grantorId', ${wardrobeShare.grantorId},
          'firstName', ${user.firstName},
          'email', ${user.email},
          'permission', ${wardrobeShare.permission}
        )
        order by ${wardrobeShare.id}
      ),
      '[]'
    )
    from ${wardrobeShare}
    join ${user} on ${eq(user.id, wardrobeShare.grantorId)}
    where ${acceptedSharesWith(userId)}
  )`;
}
