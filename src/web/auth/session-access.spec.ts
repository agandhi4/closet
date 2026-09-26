import { describe, expect, it } from 'vitest';
import type { AuthContext } from './session';
import { decideSessionAccess } from './session-access';

// The decision requireSession takes; test/integration/web.spec.ts checks
// that the gate answers with it.
describe('decideSessionAccess', () => {
  const session: AuthContext = { user: { id: 3, email: 'a@example.com' } };
  const anonymous = (headers: Record<string, string> = {}) => ({ headers });

  it('allows a public route without a session', () => {
    expect(decideSessionAccess(anonymous(), true)).toBe('allow');
  });

  it('allows a protected route with a session, whatever the request', () => {
    for (const headers of [{}, { 'hx-request': 'true' }]) {
      expect(decideSessionAccess({ headers, auth: session }, false)).toBe(
        'allow',
      );
    }
  });

  it.each([
    ['no fetch metadata (curl, inject)', {}],
    ['a browser navigation', { 'sec-fetch-mode': 'navigate' }],
    [
      'an htmx boosted navigation',
      { 'hx-request': 'true', 'hx-boosted': 'true', 'sec-fetch-mode': 'cors' },
    ],
    [
      'an htmx history restore',
      {
        'hx-request': 'true',
        'hx-history-restore-request': 'true',
        'sec-fetch-mode': 'cors',
      },
    ],
  ])('redirects %s to the login page', (_label, headers) => {
    expect(decideSessionAccess(anonymous(headers), false)).toBe(
      'redirect-to-login',
    );
  });

  it.each([
    [
      'an htmx fragment request',
      { 'hx-request': 'true', 'sec-fetch-mode': 'cors' },
    ],
    ['a fetch()', { 'sec-fetch-mode': 'cors' }],
    ['a same-origin fetch()', { 'sec-fetch-mode': 'same-origin' }],
  ])('answers %s with login-required (401)', (_label, headers) => {
    expect(decideSessionAccess(anonymous(headers), false)).toBe(
      'login-required',
    );
  });
});
