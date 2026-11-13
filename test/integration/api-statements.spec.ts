import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceToken, SIGN_IN_URL, signInDevice } from './api';
import {
  createTestApp,
  recordQueries,
  TEST_PASSWORD,
  type TestApp,
} from './harness';

/**
 * What each /api/v1 route costs in statements (#190; plan section 10):
 * production pays a round trip per statement, so the count is the latency.
 * Each runs inside recordQueries, so it lands in build/statements.json as
 * `<METHOD>:/api/v1/...` and the metrics ratchet holds it. Every
 * authenticated count is the token's read (authenticateToken), as a page's
 * is the session's, plus its last-use write when the last one is a minute
 * old (pinned both ways).
 */

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(async () => {
  await t.cleanup();
});

async function statementsOf(work: () => Promise<{ statusCode: number }>) {
  let status = 0;
  const record = await recordQueries(async () => {
    status = (await work()).statusCode;
  });
  return { status, statements: record.statements, sql: record.sql };
}

describe('API statements per route', () => {
  it('GET /me: the token read, and its last-use write on the first call of a minute', async () => {
    await t.register('me-statements@example.com');
    const { token } = await deviceToken(t, {
      email: 'me-statements@example.com',
    });
    const me = () => t.api(token, { method: 'GET', url: '/api/v1/me' });
    const first = await statementsOf(me);
    expect(first).toMatchObject({ status: 200, statements: 2 });
    expect(first.sql[1]).toMatch(/^update "personal_access_token"/);
    expect(await statementsOf(me)).toMatchObject({
      status: 200,
      statements: 1,
    });
  });

  it('POST /auth/token: the lookup, then the mint (its twin, POST /auth/tokens, pays the same)', async () => {
    const email = 'sign-in-statements@example.com';
    const cookie = await t.register(email);
    const signIn = await statementsOf(() => signInDevice(t, { email }));
    // findUserByEmail; then createToken: begin, the user's row locked with
    // its password, the list of devices, the insert, commit.
    expect(signIn).toMatchObject({ status: 201, statements: 6 });
    // The page that mints an agent token: the session with the hash, then
    // the same transaction.
    const twin = await statementsOf(() =>
      t.inject({
        method: 'POST',
        url: '/auth/tokens',
        payload: { name: 'Twin', currentPassword: TEST_PASSWORD },
        headers: { cookie },
      }),
    );
    expect(twin).toMatchObject({ status: 200, statements: signIn.statements });
  });

  it('DELETE /auth/token: the token read and its last-use write, then the revoke', async () => {
    await t.register('sign-out-statements@example.com');
    const { token } = await deviceToken(t, {
      email: 'sign-out-statements@example.com',
    });
    expect(
      await statementsOf(() =>
        t.api(token, { method: 'DELETE', url: SIGN_IN_URL }),
      ),
    ).toMatchObject({ status: 204, statements: 3 });
  });

  it('GET /openapi.json: none', async () => {
    expect(
      await statementsOf(() =>
        t.api(undefined, { method: 'GET', url: '/api/v1/openapi.json' }),
      ),
    ).toMatchObject({ status: 200, statements: 0 });
  });
});
