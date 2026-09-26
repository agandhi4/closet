import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../../db/client';
import { personalAccessToken, user } from '../../db/schema';
import type { SessionUser } from './session';

/**
 * Personal access tokens (#33): the MCP endpoint's credential
 * (src/web/mcp). A token is `closet_` plus 32 random bytes in base64url,
 * shown once when created; the database keeps its SHA-256 (hex) and a short
 * prefix to tell tokens apart on the profile. A fast hash is right here: the
 * token is 256 random bits, so there is nothing to guess, and a slow one
 * would cost every call. A token acts exactly as its user; a new password
 * revokes every token (revokeAllTokens, called by updatePasswordHash), as it
 * ends every session.
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

/** The user's tokens still in force, newest first. */
export function listTokens(db: Db, userId: number): Promise<TokenListing[]> {
  return db
    .select({
      id: personalAccessToken.id,
      name: personalAccessToken.name,
      prefix: personalAccessToken.tokenPrefix,
      createdAt: personalAccessToken.createdAt,
      lastUsedAt: personalAccessToken.lastUsedAt,
    })
    .from(personalAccessToken)
    .where(
      and(
        eq(personalAccessToken.userId, userId),
        isNull(personalAccessToken.revokedAt),
      ),
    )
    .orderBy(desc(personalAccessToken.id));
}

export type CreateTokenResult =
  | { created: true; id: number; token: string }
  | { created: false; reason: 'too-many' };

/**
 * Makes a token for `userId` and returns it in the clear, the only time it
 * exists outside the caller's hands. `name` is already trimmed and bounded.
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
    const active = await tx.$count(
      personalAccessToken,
      and(
        eq(personalAccessToken.userId, userId),
        isNull(personalAccessToken.revokedAt),
      ),
    );
    if (active >= MAX_ACTIVE_TOKENS) {
      return { created: false, reason: 'too-many' } as const;
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
      .returning({ id: personalAccessToken.id });
    return { created: true, id: row.id, token } as const;
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
    .where(
      and(
        eq(personalAccessToken.id, id),
        eq(personalAccessToken.userId, userId),
        isNull(personalAccessToken.revokedAt),
      ),
    )
    .returning({ id: personalAccessToken.id });
  return revoked.length > 0;
}

/** Revokes every token of the user: a new password (updatePasswordHash). */
export async function revokeAllTokens(
  tx: Queryable,
  userId: number,
): Promise<number> {
  const revoked = await tx
    .update(personalAccessToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(personalAccessToken.userId, userId),
        isNull(personalAccessToken.revokedAt),
      ),
    )
    .returning({ id: personalAccessToken.id });
  return revoked.length;
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
