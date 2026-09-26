import jwt from 'jsonwebtoken';

/**
 * The session token's claims. The format is the one @nestjs/jwt issued
 * before the port (HS256, the same claims, 365 days), so cookies set before
 * a deploy stay valid after it.
 */
export interface SessionClaims {
  userId: number;
  email: string | null;
  /**
   * Password fingerprint: the last 8 characters of the user's bcrypt hash.
   * The session resolver compares it on every request, so changing the
   * password ends every session issued before the change.
   */
  pwf: string;
}

/** A token's lifetime; the cookie's Max-Age is the same span in seconds. */
export const SESSION_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

export function passwordFingerprint(passwordHash: string): string {
  return passwordHash.slice(-8);
}

export interface SessionTokens {
  issue(user: { id: number; email: string | null; password: string }): string;
  /** The claims of a valid, unexpired token signed with our secret; else undefined. */
  verify(token: string): SessionClaims | undefined;
}

/**
 * Signs and verifies session tokens with ACCESS_TOKEN_SECRET. Built once by
 * createApp() and shared by the session resolver (every request) and the
 * routes that sign someone in.
 */
export function createSessionTokens(secret: string): SessionTokens {
  return {
    issue(user) {
      const claims: SessionClaims = {
        userId: user.id,
        email: user.email,
        pwf: passwordFingerprint(user.password),
      };
      return jwt.sign(claims, secret, {
        algorithm: 'HS256',
        expiresIn: SESSION_LIFETIME_SECONDS,
      });
    },
    verify(token) {
      let decoded: string | jwt.JwtPayload;
      try {
        // Pinned to the one algorithm we sign with, so a token cannot pick
        // its own verification.
        decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
      } catch {
        return undefined;
      }
      if (
        typeof decoded === 'string' ||
        typeof decoded.userId !== 'number' ||
        typeof decoded.pwf !== 'string'
      ) {
        return undefined;
      }
      return {
        userId: decoded.userId,
        email: typeof decoded.email === 'string' ? decoded.email : null,
        pwf: decoded.pwf,
      };
    },
  };
}
