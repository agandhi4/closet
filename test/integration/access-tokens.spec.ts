import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalAccessToken } from '../../src/db/schema';
import {
  createToken,
  hashToken,
  MAX_ACTIVE_TOKENS,
} from '../../src/web/auth/personal-tokens';
import {
  createTestApp,
  TEST_PASSWORD,
  type TestApp,
  unescapeHtml,
  userIdOf,
} from './harness';
import { createAccessToken } from './mcp';
import { expectNativePostForms } from './pages';

/**
 * The profile's Agent access page (#33): personal access tokens for the MCP
 * endpoint, created (shown once), listed by name and prefix, and revoked.
 * Only a hash is stored; nobody reaches another user's tokens.
 */
describe('agent access tokens', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const page = () => t.inject({ method: 'GET', url: '/auth/tokens' });

  it('is linked from the profile', async () => {
    const res = await t.inject({ method: 'GET', url: '/auth/profile' });
    expect(res.body).toContain('href="/auth/tokens"');
  });

  it('shows a new token once, with the command that connects Claude Code', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: 'Laptop', currentPassword: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectNativePostForms(res);
    const token = /closet_[A-Za-z0-9_-]{43}/.exec(res.body)![0];
    expect(unescapeHtml(res.body)).toContain(
      `claude mcp add --transport http closet http://localhost:3000/mcp --header "Authorization: Bearer ${token}"`,
    );

    const [row] = await t.db
      .select()
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Laptop'));
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenPrefix).toBe(token.slice(0, 11));

    const listed = await page();
    expect(listed.body).toContain('Laptop');
    expect(listed.body).toContain(`${token.slice(0, 11)}…`);
    expect(listed.body).not.toContain(token);
  });

  describe('asks for the current password (a token outlives signing out)', () => {
    const WRONG = 'Not-the-password-9';
    const tokensOf = async (userId: number) =>
      t.db.$count(personalAccessToken, eq(personalAccessToken.userId, userId));

    it('refuses a wrong one: 400, the form again, nothing created, nothing echoed', async () => {
      const cookie = await t.register('stepup@example.com');
      const id = await userIdOf(t, 'stepup@example.com');
      t.logs.clear();
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Borrowed phone', currentPassword: WRONG },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expectNativePostForms(res);
      expect(res.body).toContain('Current password is incorrect');
      // The name is kept, the password never.
      expect(res.body).toContain('value="Borrowed phone"');
      expect(res.body).not.toContain(WRONG);
      expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
      expect(await tokensOf(id)).toBe(0);
      expect(t.logs.messages('info', 'Web')).toContain(
        `Token refused for user ${id}: wrong current password`,
      );
      expect(JSON.stringify(t.logs.records)).not.toContain(WRONG);
    });

    it('refuses a missing one as a malformed form, creating nothing', async () => {
      const cookie = await t.register('nopassword@example.com');
      const id = await userIdOf(t, 'nopassword@example.com');
      const res = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'No password' },
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(await tokensOf(id)).toBe(0);
    });

    it('creates with the right one, and never logs the password', async () => {
      const cookie = await t.register('right@example.com');
      const id = await userIdOf(t, 'right@example.com');
      t.logs.clear();
      await createAccessToken(t, { cookie });
      expect(await tokensOf(id)).toBe(1);
      expect(JSON.stringify(t.logs.records)).not.toContain(TEST_PASSWORD);
    });

    it('counts every attempt against the account limit (5 a minute)', async () => {
      const cookie = await t.register('guesser@example.com');
      const id = await userIdOf(t, 'guesser@example.com');
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await t.inject({
          method: 'POST',
          url: '/auth/tokens',
          payload: { name: 'Guess', currentPassword: `${WRONG}${attempt}` },
          headers: { cookie },
        });
        expect(res.statusCode).toBe(400);
      }
      // Even the right password is refused once the limit is reached.
      const limited = await t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Guess', currentPassword: TEST_PASSWORD },
        headers: { cookie },
      });
      expect(limited.statusCode).toBe(429);
      expect(await tokensOf(id)).toBe(0);
    });
  });

  it('asks for a name', async () => {
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: '   ', currentPassword: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
  });

  it('revokes a token of one’s own, and 404s anyone else’s', async () => {
    const cookie = await t.register('other@example.com');
    await createAccessToken(t, { cookie, name: 'Theirs' });
    const [theirs] = await t.db
      .select({ id: personalAccessToken.id })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.name, 'Theirs'));
    const refused = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('Theirs');

    const res = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/auth/tokens?revoked=1');
    const [row] = await t.db
      .select({ revokedAt: personalAccessToken.revokedAt })
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, theirs.id));
    expect(row.revokedAt).not.toBeNull();
    // Revoked is gone from the list, and a second revoke finds nothing.
    const listed = await t.inject({
      method: 'GET',
      url: '/auth/tokens',
      headers: { cookie },
    });
    expect(listed.body).not.toContain('Theirs');
    const again = await t.inject({
      method: 'POST',
      url: `/auth/tokens/${theirs.id}/revoke`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(404);
  });

  it(`stops at ${MAX_ACTIVE_TOKENS} tokens in force`, async () => {
    // Straight through the writer: the page is rate limited like the other
    // account writes (ACCOUNT_LIMIT, 5 a minute).
    const cookie = await t.register('busy@example.com');
    const id = await userIdOf(t, 'busy@example.com');
    for (let n = 0; n < MAX_ACTIVE_TOKENS; n += 1) {
      await createToken(t.db, id, `Token ${n}`);
    }
    const res = await t.inject({
      method: 'POST',
      url: '/auth/tokens',
      payload: { name: 'One more', currentPassword: TEST_PASSWORD },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/closet_[A-Za-z0-9_-]{43}/);
  });
});
