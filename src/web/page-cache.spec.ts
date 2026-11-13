import { describe, expect, it } from 'vitest';
import {
  bypassesWorker,
  CACHED_AT_HEADER,
  cachedAt,
  endedSession,
  isRenderedPage,
  navigationPostAnswer,
  PAGE_ACCOUNT_HEADER,
  pageAccount,
  revalidationOutcome,
  sentToLogin,
  servesStaleWhileRevalidate,
  SESSION_ENDED_HEADER,
} from './page-cache';
import { PROFILE_PATH } from './auth/urls';

const ORIGIN = 'https://closet.test';

describe('bypassesWorker', () => {
  it.each([
    '/mcp',
    '/mcp/',
    '/mcp/anything',
    '/api',
    '/api/v1/me',
    '/api/v1/auth/token',
    '/API/v1/me',
    '/wardrobe/export.csv',
    '/wardrobe/export.json',
  ])('leaves %s alone', (path) => {
    expect(bypassesWorker(new URL(`${ORIGIN}${path}`))).toBe(true);
  });

  it.each([
    '/wardrobe',
    '/wardrobe/export',
    '/mcpx',
    '/apix',
    '/auth/tokens',
    '/',
  ])('handles %s as the app', (path) => {
    expect(bypassesWorker(new URL(`${ORIGIN}${path}`))).toBe(false);
  });
});

describe('navigationPostAnswer', () => {
  const nav = (method: string, path: string, mode = 'navigate') => ({
    method,
    mode,
    url: `${ORIGIN}${path}`,
  });

  // The worker never sends a navigation post to the server (#542): every
  // one is stopped before any route, and the only one it answers itself is
  // the share target, on the device (receiveShare fetches nothing:
  // share-target.spec.ts). Everything else is the browser's own post.
  it('answers only the share target itself', () => {
    expect(
      navigationPostAnswer(nav('POST', '/inspiration/share'), ORIGIN),
    ).toBe('share-target');
  });

  it.each([
    ['POST', '/auth/login'],
    ['POST', '/auth/logout'],
    ['POST', '/inspiration'],
    ['POST', '/inspiration/share/confirm'],
    ['POST', '/inspiration/share/'],
    ['PUT', '/inspiration/share'],
    ['DELETE', '/inspiration/share'],
    ['PATCH', '/wardrobe/1'],
  ])('leaves a %s navigation to %s to the browser', (method, path) => {
    expect(navigationPostAnswer(nav(method, path), ORIGIN)).toBe('browser');
  });

  it('leaves a share-target navigation to another origin to the browser', () => {
    expect(
      navigationPostAnswer(
        {
          method: 'POST',
          mode: 'navigate',
          url: 'https://evil.example/inspiration/share',
        },
        ORIGIN,
      ),
    ).toBe('browser');
  });

  it('leaves the worker a GET navigation (its page routes)', () => {
    expect(navigationPostAnswer(nav('GET', '/inspiration/share'), ORIGIN)).toBe(
      undefined,
    );
  });

  it.each(['cors', 'same-origin', 'no-cors'])(
    'leaves the worker a %s POST (only our own pages’ fetches reach it)',
    (mode) => {
      expect(
        navigationPostAnswer(nav('POST', '/inspiration/share', mode), ORIGIN),
      ).toBe(undefined);
    },
  );
});

describe('servesStaleWhileRevalidate', () => {
  it.each(['/wardrobe', '/styling', '/outfits', '/calendar'])(
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
    '/styling?with=12',
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

  it('opens Today (/), a dock tab, network first: all of it is the day’s (#15)', () => {
    expect(
      servesStaleWhileRevalidate(
        { mode: 'navigate', url: `${ORIGIN}/` },
        ORIGIN,
      ),
    ).toBe(false);
  });

  // Signing in or registering lands on Profile (routes.tsx). A landing the
  // worker answered from its cache could show the previous account's copy;
  // fetched first, its answer for the new account claims the cache, which
  // drops the old one before anything is stored (claimPageCache).
  it('fetches a sign-in’s landing, Profile, from the server', () => {
    expect(
      servesStaleWhileRevalidate(
        { mode: 'navigate', url: `${ORIGIN}${PROFILE_PATH}` },
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

describe('isRenderedPage', () => {
  it.each(['text/html; charset=utf-8', 'text/html', 'Text/HTML ; charset=x'])(
    'is a page answered as %s',
    (type) => {
      expect(isRenderedPage(new Headers({ 'Content-Type': type }))).toBe(true);
    },
  );

  it.each(['image/webp', 'image/jpeg', 'text/csv', 'application/json'])(
    'is not an answer of %s (an image or a download opened as a document)',
    (type) => {
      expect(isRenderedPage(new Headers({ 'Content-Type': type }))).toBe(false);
    },
  );

  it('is not an answer without a type', () => {
    expect(isRenderedPage(new Headers())).toBe(false);
  });
});

describe('sentToLogin', () => {
  const signedOut = new Headers();

  it('is a page request redirected to the login page, rendered for nobody', () => {
    expect(
      sentToLogin({
        redirected: true,
        url: `${ORIGIN}/auth/login`,
        headers: signedOut,
      }),
    ).toBe(true);
  });

  it.each([
    ['not redirected (the login page opened itself)', false, '/auth/login'],
    [
      'redirected elsewhere (an archive landing on the grid)',
      true,
      '/wardrobe',
    ],
    ['redirected to a page under the login path', true, '/auth/login/x'],
  ])('is not a page %s', (_label, redirected, path) => {
    expect(
      sentToLogin({ redirected, url: `${ORIGIN}${path}`, headers: signedOut }),
    ).toBe(false);
  });

  it('is not a redirect to a login page rendered for a signed-in account (DISABLE_REGISTRATION)', () => {
    expect(
      sentToLogin({
        redirected: true,
        url: `${ORIGIN}/auth/login`,
        headers: new Headers({ [PAGE_ACCOUNT_HEADER]: '7' }),
      }),
    ).toBe(false);
  });
});

describe('endedSession', () => {
  it('is an answer that says the session ended (endSession)', () => {
    expect(endedSession(new Headers({ [SESSION_ENDED_HEADER]: '1' }))).toBe(
      true,
    );
  });

  it('is not an answer without it (a plain refusal)', () => {
    expect(endedSession(new Headers())).toBe(false);
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
