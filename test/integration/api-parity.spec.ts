import type { FastifyInstance, InjectOptions, RouteOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MCP_WRITES,
  OPERATIONS,
  PAGE_WRITES,
  type Parity,
  type ToolParity,
  twinOperations,
} from '../../src/web/api/operations';
import { mcpTools } from '../../src/web/mcp/tools';
import {
  ADDRESS,
  bootEveryFeature,
  type EveryFeatureApp,
  loadMatrixGroups,
  type RouteKey,
  routeKeysOf,
  templateRouter,
} from './app-routes';
import type { MatrixGroup } from './authorization-matrix';

/**
 * Page, MCP and API parity (#191; src/web/api/operations.ts, plan section
 * 5). Every page route that writes (not a GET or HEAD) is classified in
 * PAGE_WRITES: its API twin's operationId, web-only with a reason, or
 * pending an endpoint issue; every MCP tool that writes is in MCP_WRITES.
 * A route or tool nobody classified fails, and so does a line whose route
 * or tool is gone, or whose twin names an operation no API route declares.
 *
 * Refusal parity: a matrix route (authorization-<group>.routes.ts) whose
 * page route has a twin must carry `api`, the twin's request, which must
 * reach that operation. Its group's matrix then replays every case on the
 * twin with the actor's device token and requires the same outcome
 * (describeMatrix), on the group's own database.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Inventory {
  /** Every page route that writes. */
  pageWrites: RouteKey[];
  /** Every /api/v1 route, and its operationId. */
  operations: Map<RouteKey, string>;
  /** Every route, for the template router. */
  keys: RouteKey[];
}

function inventoryOf(registered: RouteOptions[]): Inventory {
  const pageWrites: RouteKey[] = [];
  const operations = new Map<RouteKey, string>();
  const keys: RouteKey[] = [];
  for (const route of registered) {
    const surface = route.config?.surface ?? 'page';
    for (const key of routeKeysOf(route)) {
      keys.push(key);
      if (surface === 'api' && route.schema?.operationId) {
        operations.set(key, route.schema.operationId);
      }
      if (surface === 'page' && WRITE_METHODS.has(key.split(' ')[0])) {
        pageWrites.push(key);
      }
    }
  }
  return { pageWrites, operations, keys };
}

/** Each line: a write nobody classified, or a classification of nothing. */
function classificationProblems(
  writes: string[],
  manifest: Readonly<Record<string, Parity | ToolParity>>,
  what: string,
): string[] {
  const present = new Set(writes);
  const blank = (parity: Parity | ToolParity) =>
    Object.values(parity).some(
      (value) => typeof value === 'string' && value.trim() === '',
    );
  return [
    ...writes
      .filter((key) => !(key in manifest))
      .map((key) => `${key}: a ${what} nobody classified`),
    ...Object.entries(manifest).flatMap(([key, parity]) => {
      if (!present.has(key)) return [`${key}: classified, but no such ${what}`];
      if (blank(parity)) return [`${key}: classified without a reason`];
      return [];
    }),
  ];
}

/** Each twin names an operation an API route declares, and each is declared. */
function operationProblems(operations: Map<RouteKey, string>): string[] {
  const declared = new Set(operations.values());
  const twins = [
    ...Object.entries(PAGE_WRITES),
    ...Object.entries(MCP_WRITES),
  ].flatMap(([key, parity]) =>
    'api' in parity
      ? twinOperations(parity.api)
          .filter((id) => !declared.has(id))
          .map((id) => `${key}: its twin ${id} is no API route`)
      : [],
  );
  const unrouted = OPERATIONS.filter((id) => !declared.has(id)).map(
    (id) => `${id}: in OPERATIONS, but no API route declares it`,
  );
  return [...twins, ...unrouted];
}

/** PAGE_WRITES by any route key, for the routes a request resolves to. */
const PAGE_PARITY: Readonly<Record<RouteKey, Parity>> = PAGE_WRITES;

/** What one matrix route says about its twin, against its page route's line. */
interface TwinFacts {
  name: string;
  /** The page template its request reaches. */
  page: RouteKey | undefined;
  /** It carries `api`. */
  hasApi: boolean;
  /** The operation its `api` request reaches, if any. */
  operation: string | undefined;
}

/** The operations a page write's twin is, any of which its matrix route may reach. */
function twinOf(parity: Parity | undefined): readonly string[] | undefined {
  return parity && 'api' in parity ? twinOperations(parity.api) : undefined;
}

function twinProblem({
  name,
  page,
  hasApi,
  operation,
}: TwinFacts): string | undefined {
  const parity = page === undefined ? undefined : PAGE_PARITY[page];
  const expected = twinOf(parity);
  const named = expected?.join(' or ');
  if (!hasApi) {
    return expected ? `${name}: its twin ${named} has no api` : undefined;
  }
  if (operation === undefined) return `${name}: its api reaches no API route`;
  if (expected !== undefined && !expected.includes(operation)) {
    return `${name}: its api reaches ${operation}, not ${named}`;
  }
  // A read may carry a twin (GETs are not classified); a write's names it.
  if (expected === undefined && parity !== undefined) {
    return `${name}: has an api, but ${page} is not ${operation}`;
  }
  return undefined;
}

/**
 * A matrix route whose page route has a twin carries `api`, reaching that
 * twin; one that carries `api` reaches an API route, for a page write
 * classified with that operation.
 */
async function twinProblems(
  groups: MatrixGroup[],
  router: FastifyInstance,
  operations: Map<RouteKey, string>,
): Promise<string[]> {
  const templateOf = async ({ method, url }: InjectOptions) => {
    const res = await router.inject({ method, url });
    return res.statusCode === 200 ? res.body : undefined;
  };
  const problems: string[] = [];
  for (const { group, routes } of groups) {
    for (const route of routes) {
      const query =
        route.vias[0] === 'ownerId' ? `?ownerId=${ADDRESS.ownerId}` : '';
      const twin = route.api
        ? await templateOf(await route.api.request(ADDRESS, query))
        : undefined;
      const problem = twinProblem({
        name: `${group}: ${route.name}`,
        page: await templateOf(await route.request(ADDRESS, query)),
        hasApi: route.api !== undefined,
        operation: twin === undefined ? undefined : operations.get(twin),
      });
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

describe('page, MCP and API parity', () => {
  let app: EveryFeatureApp;
  let inventory: Inventory;
  let router: FastifyInstance;
  let groups: MatrixGroup[];
  const writeTools = mcpTools({ weather: true })
    .filter((tool) => tool.writes)
    .map((tool) => tool.name);

  beforeAll(async () => {
    app = await bootEveryFeature();
    inventory = inventoryOf(app.registered);
    router = await templateRouter(inventory.keys);
    ({ groups } = await loadMatrixGroups());
  });

  afterAll(async () => {
    await router?.close();
    await app?.close();
  });

  it('classifies every page write route, and nothing else', () => {
    expect(inventory.pageWrites.length).toBeGreaterThan(0);
    expect(
      classificationProblems(inventory.pageWrites, PAGE_WRITES, 'route'),
    ).toEqual([]);
  });

  it('classifies every MCP write tool, and nothing else', () => {
    expect(writeTools.length).toBeGreaterThan(0);
    expect(classificationProblems(writeTools, MCP_WRITES, 'tool')).toEqual([]);
  });

  it('names only operations an API route declares, and routes every one', () => {
    expect(operationProblems(inventory.operations)).toEqual([]);
  });

  it("gives every twinned matrix route its twin's request", async () => {
    expect(await twinProblems(groups, router, inventory.operations)).toEqual(
      [],
    );
  });

  it('fails on a page write route nobody classified, and on a stale line', () => {
    const [first] = inventory.pageWrites;
    const kept = Object.entries(PAGE_PARITY).filter(([key]) => key !== first);
    expect(
      classificationProblems(
        [...inventory.pageWrites, 'POST /wardrobe/:id/unlisted'],
        { ...Object.fromEntries(kept), 'DELETE /gone': { pending: '#195' } },
        'route',
      ),
    ).toEqual([
      `${first}: a route nobody classified`,
      'POST /wardrobe/:id/unlisted: a route nobody classified',
      'DELETE /gone: classified, but no such route',
    ]);
  });

  it('fails on a twinned write whose matrix route has no api, or another one', () => {
    const login = { name: 'login', page: 'POST /auth/login' };
    expect([
      twinProblem({ ...login, hasApi: false, operation: undefined }),
      twinProblem({ ...login, hasApi: true, operation: 'getMe' }),
      twinProblem({ ...login, hasApi: true, operation: 'signIn' }),
    ]).toEqual([
      'login: its twin signIn has no api',
      'login: its api reaches getMe, not signIn',
      undefined,
    ]);
    // A write of two shapes (POST /calendar, its `replace`) has two twins.
    const plan = { name: 'plan', page: 'POST /calendar' };
    expect([
      twinProblem({ ...plan, hasApi: true, operation: 'getMe' }),
      twinProblem({
        ...plan,
        hasApi: true,
        operation: 'replaceCalendarEntryOutfit',
      }),
    ]).toEqual([
      'plan: its api reaches getMe, not createCalendarEntry or replaceCalendarEntryOutfit',
      undefined,
    ]);
  });
});
