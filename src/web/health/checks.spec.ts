import { describe, expect, it } from 'vitest';
import { captureLogs } from '../../../test/support/log-capture';
import {
  checkCutoutQueue,
  checkDatabase,
  checkJobs,
  type HealthCheck,
  readiness,
} from './checks';

/**
 * /health/ready's verdict and checks with their inputs stubbed: the 503
 * paths no healthy integration database can show. The real round-trip is
 * test/integration/delivery.spec.ts.
 */

const up = (required: boolean): HealthCheck => ({ status: 'up', required });
const down = (required: boolean): HealthCheck => ({ status: 'down', required });

describe('readiness', () => {
  it.each([
    ['every check up', { a: up(true), b: up(false) }, 'up'],
    ['an optional check down', { a: up(true), b: down(false) }, 'up'],
    ['a required check down', { a: down(true), b: up(false) }, 'down'],
  ])('%s: %s', (_case, checks, status) => {
    expect(readiness('abc1234', checks)).toEqual({
      status,
      version: 'abc1234',
      checks,
    });
  });
});

describe('checkDatabase', () => {
  const BUILD = 1_700_000_000_000;
  const { logger, logs } = captureLogs();

  it.each([
    ['current', BUILD, 'up'],
    ['ahead (an older build rolled back onto it)', BUILD + 1, 'up'],
    ['behind', BUILD - 1, 'down'],
    ['with no migration recorded', undefined, 'down'],
  ])('a database %s: migrations %s', async (_case, last, migrations) => {
    const checks = await checkDatabase(
      () => Promise.resolve(last),
      BUILD,
      logger,
    );
    expect(checks.database).toEqual(up(true));
    expect(checks.migrations.status).toBe(migrations);
    expect(checks.migrations.required).toBe(true);
  });

  it('a failed query is down, its text only in the log', async () => {
    logs.clear();
    const failure = new Error('connect ECONNREFUSED 10.0.0.5:5433 closet_user');
    const checks = await checkDatabase(
      () => Promise.reject(failure),
      BUILD,
      logger,
    );
    expect(checks.database.status).toBe('down');
    expect(checks.migrations.status).toBe('down');
    expect(JSON.stringify(checks)).not.toContain('ECONNREFUSED');
    expect(logs.messages('warn')).toEqual([
      'Readiness: the database query failed',
    ]);
  });

  it('a query that outlasts the bound is down', async () => {
    const checks = await checkDatabase(
      () => new Promise<never>(() => {}),
      BUILD,
      logger,
      5,
    );
    expect(checks.database).toMatchObject(down(true));
    expect(checks.migrations).toMatchObject(down(true));
  });
});

describe('checkJobs and checkCutoutQueue', () => {
  it('are optional, down when nothing was started or a job is stuck', () => {
    expect(checkJobs([])).toEqual(up(false));
    expect(checkJobs(undefined)).toMatchObject(down(false));
    expect(checkJobs(['Week re-plan'])).toMatchObject({
      ...down(false),
      stuck: ['Week re-plan'],
    });
    expect(checkCutoutQueue(true)).toEqual(up(false));
    expect(checkCutoutQueue(false)).toMatchObject(down(false));
  });
});
