import { describe, expect, it } from 'vitest';
import {
  bypassesWorker,
  CACHED_AT_HEADER,
  cachedAt,
  endedSession,
  forbidsStorage,
  isRenderedPage,
  navigationPostAnswer,
  PAGE_ACCOUNT_HEADER,
  pageAccount,
  refetchInTurn,
  type RefetchStep,
  refetchVerdict,
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
  it('fetches Profile, no tab root, from the server', () => {
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

// The sign-in pages are no-store (their returnTo can carry an invite token,
// #661): the worker's pageStore claims the cache from them but never stores
// them under a page key.
describe('forbidsStorage', () => {
  it.each(['no-store', 'private, no-store', 'No-Store , max-age=0'])(
    'refuses an answer of %s',
    (value) => {
      expect(forbidsStorage(new Headers({ 'Cache-Control': value }))).toBe(
        true,
      );
    },
  );

  it.each(['private, no-cache', 'no-cache', 'public, max-age=60'])(
    'stores an answer of %s',
    (value) => {
      expect(forbidsStorage(new Headers({ 'Cache-Control': value }))).toBe(
        false,
      );
    },
  );

  it('stores an answer without the header', () => {
    expect(forbidsStorage(new Headers())).toBe(false);
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

  it('is one still when the login page carries a returnTo (#661)', () => {
    expect(
      sentToLogin({
        redirected: true,
        url: `${ORIGIN}/auth/login?returnTo=%2Fcalendar`,
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

describe('refetchVerdict', () => {
  const answer = ({
    status = 200,
    redirected = false,
    path = '/wardrobe/12',
    headers = { [PAGE_ACCOUNT_HEADER]: '7' },
  }: {
    status?: number;
    redirected?: boolean;
    path?: string;
    headers?: Record<string, string>;
  } = {}) => ({
    status,
    redirected,
    url: `${ORIGIN}${path}`,
    headers: new Headers(headers),
  });

  it('stores a 200', () => {
    expect(refetchVerdict(answer())).toBe('stored');
  });

  it.each([404, 403])('deletes the copy on a %i', (status) => {
    expect(refetchVerdict(answer({ status }))).toBe('deleted');
  });

  it.each([429, 502, 503, 504])(
    'stops the run on a %i, the server unavailable or throttling',
    (status) => {
      expect(refetchVerdict(answer({ status }))).toBe('stop');
    },
  );

  it.each([500, 501])('passes over one page failing with a %i', (status) => {
    expect(refetchVerdict(answer({ status }))).toBe('failed');
  });

  it('keeps the copy on a redirect to another page, never storing it under this key', () => {
    expect(
      refetchVerdict(answer({ redirected: true, path: '/wardrobe' })),
    ).toBe('kept');
  });

  it.each([
    ['a 401', answer({ status: 401, headers: {} })],
    [
      'X-Session-Ended on a 200',
      answer({ headers: { [SESSION_ENDED_HEADER]: '1' } }),
    ],
    [
      'a redirect to the login page',
      answer({ redirected: true, path: '/auth/login', headers: {} }),
    ],
  ])('ends the session on %s', (_case, fetched) => {
    expect(refetchVerdict(fetched)).toBe('session-ended');
  });
});

describe('refetchInTurn', () => {
  // Each key answered as the server would, through the real answer table:
  // what refetchCachedPage hands the walk.
  const server = (statuses: Record<string, number>) => {
    const asked: string[] = [];
    const step = (key: string): RefetchStep => {
      const verdict = refetchVerdict({
        status: statuses[key] ?? 200,
        redirected: false,
        url: `${ORIGIN}${key}`,
        headers: new Headers({ [PAGE_ACCOUNT_HEADER]: '7' }),
      });
      if (verdict === 'deleted') return { verdict, removed: 2 };
      if (verdict === 'stop' || verdict === 'session-ended') {
        return { verdict, stop: verdict };
      }
      return { verdict };
    };
    const refetch = (key: string): Promise<RefetchStep> => {
      asked.push(key);
      return Promise.resolve(step(key));
    };
    return { asked, refetch };
  };
  const keys = ['/wardrobe/1', '/wardrobe/2', '/wardrobe/3'];

  it('asks the keys after one page answering 500', async () => {
    const { asked, refetch } = server({ '/wardrobe/2': 500 });
    const run = await refetchInTurn(keys, refetch, () => false);
    expect(asked).toEqual(keys);
    expect(run).toEqual({ stored: 2, removed: 0, kept: 0, failed: 1 });
  });

  it('counts a gone page as its copies removed and goes on', async () => {
    const { asked, refetch } = server({ '/wardrobe/1': 404 });
    const run = await refetchInTurn(keys, refetch, () => false);
    expect(asked).toEqual(keys);
    expect(run).toEqual({ stored: 2, removed: 2, kept: 0, failed: 0 });
  });

  it('stops at the server unavailable, asking nothing after it', async () => {
    const { asked, refetch } = server({ '/wardrobe/2': 503 });
    const run = await refetchInTurn(keys, refetch, () => false);
    expect(asked).toEqual(['/wardrobe/1', '/wardrobe/2']);
    expect(run).toMatchObject({ stored: 1, stop: 'stop' });
  });

  it('stops before the next key once the session changed', async () => {
    const { asked, refetch } = server({});
    const run = await refetchInTurn(keys, refetch, () => asked.length === 1);
    expect(asked).toEqual(['/wardrobe/1']);
    expect(run.stop).toBe('the session changed');
  });
});
