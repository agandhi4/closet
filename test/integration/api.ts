import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { ErrorCode, Problem } from '../../src/web/problem';
import {
  OWNER_EMAIL,
  TEST_PASSWORD,
  type TestApp,
  uniqueClient,
} from './harness';

/**
 * A native client for the integration specs (#190): what an iOS app sends
 * to /api/v1 (t.api), signed in through the real device sign-in, never a
 * token minted behind the route's back (mcp.ts's mintToken does that for
 * the cap specs).
 */

export const SIGN_IN_URL = '/api/v1/auth/token';

export interface SignIn {
  email?: string;
  password?: string;
  deviceName?: string;
  /** The client address (SIGN_IN_LIMIT counts per address); a new one by default. */
  client?: Record<string, string>;
}

/** POST /api/v1/auth/token: the answer, whatever it is. */
export function signInDevice(
  t: TestApp,
  {
    email = OWNER_EMAIL,
    password = TEST_PASSWORD,
    deviceName = 'iPhone',
    client = uniqueClient(),
  }: SignIn = {},
): Promise<LightMyRequestResponse> {
  return t.api(undefined, {
    method: 'POST',
    url: SIGN_IN_URL,
    headers: client,
    payload: { email, password, deviceName },
  });
}

/** A sign-in that must succeed: the device token and its row id. */
export async function deviceToken(
  t: TestApp,
  signIn: SignIn = {},
): Promise<{ token: string; tokenId: number }> {
  const res = await signInDevice(t, signIn);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ token: string; tokenId: number }>();
}

/**
 * The answer is a problem body (RFC 9457) of `status` and `code`, naming
 * the request's id, with no CORS header: what every API error must be.
 */
export function expectProblem(
  res: LightMyRequestResponse,
  status: number,
  code: ErrorCode,
): Problem {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = res.json<Problem>();
  expect(body).toMatchObject({
    type: 'about:blank',
    status,
    code,
    requestId: res.headers['x-request-id'],
  });
  expectNoCors(res);
  return body;
}

export function expectNoCors(res: LightMyRequestResponse): void {
  expect(
    Object.keys(res.headers).filter((name) =>
      name.startsWith('access-control-'),
    ),
  ).toEqual([]);
}
