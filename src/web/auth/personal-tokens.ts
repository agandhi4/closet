import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../../db/client';
import { markSecretChecked } from '../../metrics/request-timing';
import { personalAccessToken, user } from '../../db/schema';
import type { SessionUser } from './session';

/**
 * Personal access tokens (#33): the MCP endpoint's credential
 * (src/web/mcp). A token is `closet_` plus 32 random bytes in base64url,
 * shown once when created; the database keeps its SHA-256 (hex) and a short
 * prefix to tell tokens apart on the profile. A fast hash is right here: the
 * token is 256 random bits, so there is nothing to guess, and a slow one
 * would cost every call. A token acts exactly as its user; a new password
 * revokes every token (revokeAllTokensStatement, in updatePasswordHash's
 * statement), as it ends every session.
 */

export const TOKEN_PREFIX = 'closet_';
/** Characters of the token the profile shows: the fixed prefix and four more. */
const DISPLAY_LENGTH = TOKEN_PREFIX.length + 4;
/** How stale last_used_at may get before a call writes it again. */
const LAST_USED_RESOLUTION_MS = 60_000;
export const TOKEN_NAME_MAX = 100;
/** A household's tokens are a handful; this bounds a runaway script. */
export const MAX_ACTIVE_TOKENS = 20;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenListing {
  id: number;
  name: string;
  /** `closet_AbCd`: shown with an ellipsis. */
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

const listingColumns = {
  id: personalAccessToken.id,
  name: personalAccessToken.name,
  prefix: personalAccessToken.tokenPrefix,
  createdAt: personalAccessToken.createdAt,
  lastUsedAt: personalAccessToken.lastUsedAt,
};

const inForce = (userId: number) =>
  and(
    eq(personalAccessToken.userId, userId),
    isNull(personalAccessToken.revokedAt),
  );

/** The user's tokens still in force, newest first. */
export function listTokens(
  db: Queryable,
  userId: number,
): Promise<TokenListing[]> {
  return db
    .select(listingColumns)
    .from(personalAccessToken)
    .where(inForce(userId))
    .orderBy(desc(personalAccessToken.id));
}

/**
 * What creating answers: the token in the clear (the only time it exists
 * outside the caller's hands) and the list the page shows, the new token
 * first; or, at the cap, the list as it stands.
 */
export type CreateTokenResult =
  | { created: true; id: number; token: string; tokens: TokenListing[] }
  | { created: false; reason: 'too-many'; tokens: TokenListing[] };

/**
 * Makes a token for `userId`. `name` is already trimmed and bounded.
 *
 * The list is read under the user's lock, where the cap is checked, and
 * handed back with the new row: the page needs it either way, so the cap
 * costs no count of its own and the answer no read after commit (#171).
 * The lock and the list stay two statements: the list must be read after
 * the lock is granted, and a statement's snapshot is taken before its
 * locks are, so a creation waiting on another would count the tokens as
 * they were before that one committed.
 */
export function createToken(
  db: Db,
  userId: number,
  name: string,
): Promise<CreateTokenResult> {
  return db.transaction(async (tx) => {
    // The user's row, locked: two creations take turns under the cap.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for('update');
    const tokens = await listTokens(tx, userId);
    if (tokens.length >= MAX_ACTIVE_TOKENS) {
      return { created: false, reason: 'too-many', tokens } as const;
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const [row] = await tx
      .insert(personalAccessToken)
      .values({
        userId,
        name,
        tokenHash: hashToken(token),
        tokenPrefix: token.slice(0, DISPLAY_LENGTH),
      })
      .returning(listingColumns);
    return {
      created: true,
      id: row.id,
      token,
      tokens: [row, ...tokens],
    } as const;
  });
}

/**
 * Revokes the user's token; false when it is not theirs, not a token, or
 * revoked already (the route answers each alike).
 */
export async function revokeToken(
  db: Db,
  userId: number,
  id: number,
): Promise<boolean> {
  const revoked = await db
    .update(personalAccessToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(personalAccessToken.id, id), inForce(userId)))
    .returning({ id: personalAccessToken.id });
  return revoked.length > 0;
}

/**
 * Revokes every token of the user, returning a row per token revoked: a new
 * password, as a CTE of updatePasswordHash's one statement.
 */
export function revokeAllTokensStatement(db: Queryable, userId: number) {
  return db
    .update(personalAccessToken)
    .set({ revokedAt: new Date() })
    .where(inForce(userId))
    .returning({ id: personalAccessToken.id });
}

export interface TokenAuth {
  user: SessionUser;
  /** The token's row id: what logs and the rate limit name, never the token. */
  tokenId: number;
}

/**
 * The user a presented token acts as, or undefined for an unknown or revoked
 * one (the caller answers both with the same 401). One indexed read; a
 * second statement records the use when the last one is a minute old.
 */
export async function authenticateToken(
  db: Db,
  token: string,
  now = new Date(),
): Promise<TokenAuth | undefined> {
  markSecretChecked();
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const [row] = await db
    .select({
      tokenId: personalAccessToken.id,
      lastUsedAt: personalAccessToken.lastUsedAt,
      userId: user.id,
      email: user.email,
    })
    .from(personalAccessToken)
    .innerJoin(user, eq(user.id, personalAccessToken.userId))
    .where(
      and(
        eq(personalAccessToken.tokenHash, hashToken(token)),
        isNull(personalAccessToken.revokedAt),
      ),
    );
  if (!row) return undefined;
  if (
    row.lastUsedAt === null ||
    now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS
  ) {
    await db
      .update(personalAccessToken)
      .set({ lastUsedAt: now })
      .where(eq(personalAccessToken.id, row.tokenId));
  }
  return {
    user: { id: row.userId, email: row.email },
    tokenId: row.tokenId,
  };
}
