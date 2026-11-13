import type { RouteOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { assertStatelessRoute, STATELESS_ROUTES } from './same-origin';

const route = (
  method: string | string[],
  url: string,
  config?: RouteOptions['config'],
) => ({ method, url, handler: () => undefined, config }) as RouteOptions;

// `stateless` is the same-origin hook's one exemption for pages (a post with
// no Origin): a CSRF exemption, so the list is reviewed entry by entry and
// any other route that claims it stops the boot.
describe('assertStatelessRoute', () => {
  it('lists only the share target', () => {
    expect([...STATELESS_ROUTES]).toEqual(['POST /inspiration/share']);
  });

  it('lets the share target say stateless, and any route not say it', () => {
    expect(() =>
      assertStatelessRoute(
        route('POST', '/inspiration/share', { stateless: true }),
      ),
    ).not.toThrow();
    expect(() =>
      assertStatelessRoute(route('POST', '/inspiration')),
    ).not.toThrow();
  });

  it.each([
    ['another route', route('POST', '/inspiration', { stateless: true })],
    [
      'another method on the share path',
      route('PUT', '/inspiration/share', { stateless: true }),
    ],
    [
      'a method list with one outside',
      route(['POST', 'DELETE'], '/inspiration/share', { stateless: true }),
    ],
  ])('stops the boot for %s', (_case, options) => {
    expect(() => assertStatelessRoute(options)).toThrow(/STATELESS_ROUTES/);
  });
});
