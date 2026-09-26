import { describe, expect, it } from 'vitest';
import {
  bypassesWorker,
  CACHED_AT_HEADER,
  cachedAt,
  PAGE_ACCOUNT_HEADER,
  pageAccount,
  revalidationOutcome,
  servesStaleWhileRevalidate,
} from './page-cache';

const ORIGIN = 'https://closet.test';

describe('bypassesWorker', () => {
  it.each(['/mcp', '/mcp/', '/mcp/anything'])('leaves %s alone', (path) => {
    expect(bypassesWorker(new URL(`${ORIGIN}${path}`))).toBe(true);
  });

  it.each(['/wardrobe', '/mcpx', '/auth/tokens', '/'])(
    'handles %s as the app',
    (path) => {
      expect(bypassesWorker(new URL(`${ORIGIN}${path}`))).toBe(false);
    },
  );
});

describe('servesStaleWhileRevalidate', () => {
  it.each(['/wardrobe', '/outfits', '/calendar'])(
    'opens the tab root %s from the cache',
    (path) => {
      expect(
        servesStaleWhileRevalidate(
          { mode: 'navigate', url: `${ORIGIN}${path}` },
          ORIGIN,
        ),
      ).toBe(true);
    },
  );

  it('leaves htmx requests to the network (they follow the user’s writes)', () => {
    expect(
      servesStaleWhileRevalidate(
        { mode: 'cors', url: `${ORIGIN}/wardrobe` },
        ORIGIN,
      ),
    ).toBe(false);
  });

  it.each([
    '/wardrobe?category=tops',
    '/calendar?week=2026-09-20',
    '/wardrobe/12',
    '/',
    '/auth/login',
  ])('leaves %s to the network', (path) => {
    expect(
      servesStaleWhileRevalidate(
        { mode: 'navigate', url: `${ORIGIN}${path}` },
        ORIGIN,
      ),
    ).toBe(false);
  });

  it('never serves another origin', () => {
    expect(
      servesStaleWhileRevalidate(
        { mode: 'navigate', url: 'https://elsewhere.test/wardrobe' },
        ORIGIN,
      ),
    ).toBe(false);
  });
});

describe('cachedAt and pageAccount', () => {
  it('read the stamp and the account', () => {
    const headers = new Headers({
      [CACHED_AT_HEADER]: '1727300000000',
      [PAGE_ACCOUNT_HEADER]: '7',
    });
    expect(cachedAt(headers)).toBe(1727300000000);
    expect(pageAccount(headers)).toBe('7');
  });

  it('treat a missing or broken stamp as never cached, and no account as signed out', () => {
    expect(cachedAt(new Headers())).toBe(0);
    expect(cachedAt(new Headers({ [CACHED_AT_HEADER]: 'soon' }))).toBe(0);
    expect(pageAccount(new Headers())).toBe('');
  });
});

describe('revalidationOutcome', () => {
  const cached = { account: '7', body: '<html>a</html>' };
  const fresh = (
    overrides: Partial<Parameters<typeof revalidationOutcome>[1]> = {},
  ) => ({
    status: 200,
    redirected: false,
    account: '7',
    body: '<html>a</html>',
    ...overrides,
  });

  it('is current when the server renders the same page', () => {
    expect(revalidationOutcome(cached, fresh())).toBe('current');
  });

  it('is updated when the page changed', () => {
    expect(revalidationOutcome(cached, fresh({ body: '<html>b</html>' }))).toBe(
      'updated',
    );
  });

  it('fails without an answer or on a server error, keeping the copy', () => {
    expect(revalidationOutcome(cached, undefined)).toBe('failed');
    expect(revalidationOutcome(cached, fresh({ status: 502, body: '' }))).toBe(
      'failed',
    );
  });

  it('is signed out on a redirect, a 401 or a signed-out render', () => {
    expect(
      revalidationOutcome(
        cached,
        fresh({ status: 0, redirected: true, body: '' }),
      ),
    ).toBe('signed-out');
    expect(revalidationOutcome(cached, fresh({ status: 401, body: '' }))).toBe(
      'signed-out',
    );
    expect(revalidationOutcome(cached, fresh({ account: '' }))).toBe(
      'signed-out',
    );
  });

  it('reports another account even when the markup matches', () => {
    expect(revalidationOutcome(cached, fresh({ account: '8' }))).toBe(
      'account-changed',
    );
  });
});
