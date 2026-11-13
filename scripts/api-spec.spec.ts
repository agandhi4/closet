import { Validator } from '@seriousme/openapi-schema-validator';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateApiSpec, serializeSpec, SPEC_PATH } from './api-spec';

/**
 * The OpenAPI drift test (#190; plan section 5): the committed
 * src/web/api/openapi.json, which GET /api/v1/openapi.json serves, is
 * exactly what the /api/v1 routes' schemas generate. A route or schema
 * change without `npm run api:spec` fails here, so a contract change is
 * always a reviewed diff (what a client generated from the spec needs).
 */

interface Operation {
  operationId?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
}

type Spec = {
  paths: Record<string, Record<string, Operation>>;
};

let generated: unknown;

beforeAll(async () => {
  generated = await generateApiSpec();
});

function operations(spec: Spec): [string, Operation][] {
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]): [string, Operation] => [
      `${method.toUpperCase()} ${path}`,
      operation,
    ]),
  );
}

describe('the OpenAPI spec', () => {
  it('is committed as the routes generate it (else: npm run api:spec, commit the diff)', () => {
    expect(readFileSync(SPEC_PATH, 'utf8')).toBe(serializeSpec(generated));
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    // The text as committed (the validator may resolve refs in an object).
    const result = await new Validator().validate(serializeSpec(generated));
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect((generated as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('declares every operation: a unique operationId, tags, a 2xx and the problem for 4xx and 5xx', () => {
    const all = operations(generated as Spec);
    expect(all.length).toBeGreaterThan(0);
    const ids = all.map(([, operation]) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [name, operation] of all) {
      expect(operation.operationId, name).toMatch(/^[a-z][A-Za-z]+$/);
      expect(operation.tags?.length, name).toBeGreaterThan(0);
      const statuses = Object.keys(operation.responses);
      expect(
        statuses.some((status) => /^2\d\d$/.test(status)),
        name,
      ).toBe(true);
      for (const status of ['4XX', '5XX']) {
        expect(
          operation.responses[status]?.content,
          `${name} ${status}`,
        ).toEqual({
          'application/problem+json': {
            schema: { $ref: '#/components/schemas/Problem' },
          },
        });
      }
    }
  });

  it('asks for the device token everywhere but the sign-in and the spec itself', () => {
    const open = operations(generated as Spec)
      .filter(([, operation]) => operation.security?.length === 0)
      .map(([name]) => name);
    expect(open.sort()).toEqual([
      'GET /api/v1/openapi.json',
      'POST /api/v1/auth/token',
    ]);
  });
});
