import Fastify, {
  type FastifyInstance,
  type HTTPMethods,
  type RouteOptions,
} from 'fastify';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startSentryStub, type SentryStub } from '../support/sentry-stub';
import {
  collectMatrix,
  featureApp,
  type Fixture,
  type MatrixGroup,
  type Via,
} from './authorization-matrix';
import { createTestApp, PWA_ENV, type TestApp } from './harness';

/**
 * Every route that takes an id is in the authorization matrix (#182): a
 * route whose path has a parameter (`:id`, `:itemId`, a wildcard), or whose
 * querystring or body schema takes `ownerId` (the share-aware wardrobe
 * routes, which address someone's wardrobe without a path parameter), is
 * requested by some matrix case, or is on EXEMPT with the reason it needs
 * none. A route whose querystring takes `ownerId` is requested with it (the
 * `ownerId` via). So a new id route fails CI until it joins its group's
 * authorization-<group>.spec.ts or EXEMPT.
 *
 * The app's routes are what its Fastify instance registered, caught by an
 * onRoute hook added as createApp creates it (the `fastify` mock below: the
 * routes register inside createApp, before a spec could add a hook), on an
 * app with every optional feature on, so a route behind a flag counts too.
 * The matrix's routes are its cases' requests (collectMatrix), each resolved
 * to the route template it reaches by Fastify's own router: a mirror app with
 * the same templates, each answering its own name.
 */

const registeredOf = vi.hoisted(() => new WeakMap<object, RouteOptions[]>());

vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>();
  const fastify = new Proxy(actual.default, {
    apply(target, self, args) {
      const app: FastifyInstance = Reflect.apply(target, self, args);
      const routes: RouteOptions[] = [];
      registeredOf.set(app, routes);
      app.addHook('onRoute', (route) => {
        routes.push(route);
      });
      return app;
    },
  });
  return { ...actual, default: fastify, fastify };
});

/**
 * Id routes the matrix does not request, each with why it needs no case:
 * public by design (static files, a capability URL whose token is the
 * credential), or covered by a named test elsewhere. Keyed
 * `METHOD /template`.
 */
const EXEMPT: Record<RouteKey, string> = {
  'GET /*':
    'public by design: public/ (scripts, styles, icons), static files that belong to nobody',
  'GET /.well-known/*': 'public by design: well-known static files',
  'GET /wardrobe-share/invite/:token':
    'public by design: the invite landing page, a capability URL whose token is the credential; covered by share-lifecycle.spec.ts "the public invite page never shows the inviter email"',
  'POST /wardrobe-share/invite/:token/accept':
    'a capability URL: the token is the credential, not an id of the wardrobe; covered by share-lifecycle.spec.ts "accept edge cases" (twice, taken, own, addressed to someone else, anonymous)',
  'POST /wardrobe-share/invite/:token/decline':
    'a capability URL: the token is the credential, not an id of the wardrobe; covered by share-lifecycle.spec.ts "decline" (by a recipient, the grantor, the addressee, someone else, anonymous)',
};

/** `METHOD /template`, the key EXEMPT and the report use. */
type RouteKey = string;

interface AppRoute {
  key: RouteKey;
  /**
   * The path has a parameter or a wildcard, or the body names a wardrobe
   * (`ownerId`, as starting a plan from someone's closet does).
   */
  takesId: boolean;
  /** Its querystring takes `?ownerId=`: the matrix must send it. */
  ownerQuery: boolean;
}

/** Whether a JSON schema (TypeBox: objects, unions, intersections) has `ownerId`. */
function takesOwnerId(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const { properties, anyOf, allOf, oneOf } = schema as {
    properties?: Record<string, unknown>;
    anyOf?: unknown[];
    allOf?: unknown[];
    oneOf?: unknown[];
  };
  if (properties && 'ownerId' in properties) return true;
  return [...(anyOf ?? []), ...(allOf ?? []), ...(oneOf ?? [])].some(
    takesOwnerId,
  );
}

function appRoutes(registered: RouteOptions[]): AppRoute[] {
  const routes = registered.flatMap((route) =>
    [route.method].flat().map((method: HTTPMethods) => ({
      method,
      url: route.url,
      ownerQuery: takesOwnerId(route.schema?.querystring),
      ownerBody: takesOwnerId(route.schema?.body),
    })),
  );
  const gets = new Set(
    routes.filter(({ method }) => method === 'GET').map(({ url }) => url),
  );
  return (
    routes
      // Fastify's HEAD beside every GET (exposeHeadRoutes) runs the GET's
      // handler: the GET's cases cover it.
      .filter(({ method, url }) => method !== 'HEAD' || !gets.has(url))
      .map(({ method, url, ownerQuery, ownerBody }) => ({
        key: `${method} ${url}`,
        takesId: /[:*]/.test(url) || ownerQuery || ownerBody,
        ownerQuery,
      }))
  );
}

/**
 * Fastify's router over the app's templates: each answers its own key, so a
 * concrete request resolves to the template the app would run.
 */
async function templateRouter(routes: AppRoute[]) {
  const mirror = Fastify({ exposeHeadRoutes: false });
  for (const { key } of routes) {
    const [method, url] = key.split(' ') as [HTTPMethods, string];
    mirror.route({
      method,
      url,
      handler: (_request, reply) => reply.send(key),
    });
  }
  await mirror.ready();
  return mirror;
}

/**
 * Stand-ins for the fixture's ids and names: only the URL a case requests
 * matters here, never the data behind it.
 */
const ADDRESS: Fixture = {
  garmentId: 101,
  garmentName: 'Coat',
  wishlistId: 102,
  wishlistName: 'Wish',
  archivedId: 103,
  archivedName: 'Old',
  capsuleId: 104,
  capsuleName: 'Capsule',
  outfitId: 105,
  outfitName: 'Look',
  entryId: 106,
  selfieId: 107,
  selfieFileName: 'selfie.webp',
  selfieShareableId: '00000000-0000-4000-8000-000000000107',
  ownerId: 1,
  planId: 108,
  planName: 'Plan',
  planItemId: 109,
  tripId: 110,
  tripName: 'Trip',
  tripOutfitId: 111,
  tripItemId: 112,
  otherTripId: 113,
  today: '2026-09-28',
  ownerToken: () => Promise.resolve(114),
  brandSizeId: 115,
  brand: 'Brand',
  repairId: 116,
  orderItemId: 117,
  orderItemName: 'Ordered',
  weekPlanId: 118,
  inviteShareId: 119,
  planDeclinedItemId: 120,
  planLookId: 121,
  planDeclinedLookId: 122,
  planCompleteLookId: 123,
  photo: Buffer.alloc(0),
  cutout: Buffer.alloc(0),
  shopPhotoUrl: 'http://shop.test/photo.jpg',
};

/** Each template a matrix case requests, and by which vias. */
async function matrixCoverage(
  groups: MatrixGroup[],
  router: FastifyInstance,
): Promise<{ covered: Map<RouteKey, Set<Via>>; unresolved: string[] }> {
  const covered = new Map<RouteKey, Set<Via>>();
  const unresolved: string[] = [];
  const cases = groups.flatMap(({ group, routes }) =>
    routes.flatMap((route) => route.vias.map((via) => ({ group, route, via }))),
  );
  for (const { group, route, via } of cases) {
    const query = via === 'ownerId' ? `?ownerId=${ADDRESS.ownerId}` : '';
    const { method, url } = await route.request(ADDRESS, query);
    const res = await router.inject({ method, url });
    if (res.statusCode !== 200) {
      unresolved.push(`${group}: ${route.name} (${via}) reaches no route`);
      continue;
    }
    covered.set(res.body, (covered.get(res.body) ?? new Set()).add(via));
  }
  return { covered, unresolved };
}

/** Exemptions that no longer hold: stale, needless or now in the matrix. */
function exemptionProblems(
  routes: AppRoute[],
  covered: Map<RouteKey, Set<Via>>,
  exempt: Record<RouteKey, string>,
): string[] {
  const byKey = new Map(routes.map((route) => [route.key, route]));
  return Object.keys(exempt).flatMap((key) => {
    const route = byKey.get(key);
    if (!route) return [`${key}: exempt, but no such route`];
    if (covered.has(key)) return [`${key}: exempt, but the matrix requests it`];
    if (!route.takesId) return [`${key}: exempt, but it takes no id`];
    return [];
  });
}

/** What fails the spec: each line one route. */
function coverageProblems(
  routes: AppRoute[],
  covered: Map<RouteKey, Set<Via>>,
  exempt: Record<RouteKey, string>,
): string[] {
  const missing = routes.flatMap(({ key, takesId, ownerQuery }) => {
    if (key in exempt) return [];
    const vias = covered.get(key);
    if (takesId && !vias) {
      return [`${key}: takes an id, but no matrix case requests it`];
    }
    if (ownerQuery && !vias?.has('ownerId')) {
      return [`${key}: takes ?ownerId=, but no case sends it`];
    }
    return [];
  });
  return [...missing, ...exemptionProblems(routes, covered, exempt)];
}

describe('authorization matrix coverage', () => {
  let t: TestApp;
  let features: Awaited<ReturnType<typeof featureApp>>;
  let sentry: SentryStub;
  let routes: AppRoute[];
  let router: FastifyInstance;
  let files: string[];
  let groups: MatrixGroup[];

  beforeAll(async () => {
    [features, sentry] = await Promise.all([
      featureApp(new Set(['weather', 'orderMail'])),
      startSentryStub(),
    ]);
    // Every optional feature on: some routes are registered only then.
    t = await createTestApp(
      {
        ...features.env,
        ...PWA_ENV,
        METRICS_ENABLED: 'true',
        SENTRY_DSN: sentry.dsn,
      },
      features.options,
    );
    const registered = registeredOf.get(t.app);
    if (!registered) throw new Error('The fastify mock saw no app');
    routes = appRoutes(registered);
    router = await templateRouter(routes);
    files = (await readdir(__dirname)).filter(
      (file) =>
        /^authorization-.+\.spec\.ts$/.test(file) &&
        file !== basename(__filename),
    );
    groups = await collectMatrix(() =>
      Promise.all(files.map((file) => import(join(__dirname, file)))),
    );
  });

  afterAll(async () => {
    await router?.close();
    await t?.cleanup();
    await Promise.all([features?.close(), sentry?.close()]);
  });

  it('loads a matrix group from every authorization-<group>.spec.ts', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(groups).toHaveLength(files.length);
  });

  it('resolves every matrix case to a route of the app', async () => {
    const { unresolved } = await matrixCoverage(groups, router);
    expect(unresolved).toEqual([]);
  });

  it('requests every id route, or exempts it with a reason', async () => {
    const { covered } = await matrixCoverage(groups, router);
    expect(coverageProblems(routes, covered, EXEMPT)).toEqual([]);
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.trim(), key).not.toBe('');
    }
  });

  it('fails on a new id route nobody listed', async () => {
    const { covered } = await matrixCoverage(groups, router);
    const added: AppRoute = {
      key: 'GET /wardrobe/:id/unlisted',
      takesId: true,
      ownerQuery: false,
    };
    expect(coverageProblems([...routes, added], covered, EXEMPT)).toEqual([
      'GET /wardrobe/:id/unlisted: takes an id, but no matrix case requests it',
    ]);
  });
});
