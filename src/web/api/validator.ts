import { AjvCompiler } from '@fastify/ajv-compiler';
import type { FastifyInstance, FastifySchemaCompiler } from 'fastify';

/**
 * The /api/v1 scope's validator compiler (apiPlugin): a JSON body is
 * validated as sent, never coerced. Fastify's ajv coerces types by default
 * (`coerceTypes: 'array'`), which the pages need (a form posts strings, a
 * single row as scalars) but which corrupts JSON: a `0`, `""` or `false`
 * meets `{ type: 'null' }` as null and `"3"` passes as 3. Querystring and
 * params arrive as strings, so they keep the coercing compiler (`?limit=20`).
 *
 * Both are @fastify/ajv-compiler, the factory Fastify itself builds its
 * compiler with, with the root's options (app.ts sets none), so formats,
 * `useDefaults` and `removeAdditional` stay as on every other route. Built
 * on the first route compiled, when the scope's shared schemas (Problem)
 * are all added; a request schema referring to one a child scope adds
 * would fail the boot as an unresolved $ref, never pass unchecked.
 */
export function jsonApiValidator(
  scope: FastifyInstance,
): FastifySchemaCompiler<unknown> {
  const build = AjvCompiler();
  let compilers: { body: Compile; other: Compile } | undefined;
  return (route) => {
    if (!compilers) {
      // Fastify types its schema bucket as unknown values; they are the
      // JSON schemas addSchema took, which is what the factory wants.
      const shared = scope.getSchemas() as Parameters<typeof build>[0];
      compilers = {
        body: build(shared, { customOptions: { coerceTypes: false } }),
        other: build(shared, { customOptions: {} }),
      };
    }
    // The factory's compiler takes the route definition (it reads
    // `.schema`), though its types name only a schema.
    return (route.httpPart === 'body' ? compilers.body : compilers.other)(
      route,
    );
  };
}

type Compile = ReturnType<ReturnType<typeof AjvCompiler>>;
