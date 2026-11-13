/**
 * Enumerable keys on the built-in prototypes, which every `for...in` in the
 * process walks: an integration worker keeps one process across spec files
 * (`isolate: false`, vitest.config.mts), so a key a module adds at import is
 * seen by every app the worker boots afterwards. fast-json-stringify copies
 * them into the schemas it merges for an `anyOf`, and ajv then compiles a
 * `required` array with a hole: /api/v1/changes answered 500 in every worker
 * that had loaded drizzle-kit/api first (#620).
 *
 * Used by shared-worker-setup.ts (none may be left after a file) and
 * schema-drift.ts (drizzle-kit/api's own, hidden at import).
 */
const PROTOTYPES = {
  'Object.prototype': Object.prototype,
  'Array.prototype': Array.prototype,
  'String.prototype': String.prototype,
} as const;

/** Each one as `Array.prototype.random`. */
export function enumerablePrototypeKeys(): string[] {
  return Object.entries(PROTOTYPES).flatMap(([name, prototype]) =>
    Object.keys(prototype).map((key) => `${name}.${key}`),
  );
}

/**
 * Makes every enumerable key on them non-enumerable, value untouched: the
 * library that added one still calls it, and no `for...in` sees it.
 */
export function hidePrototypeExtensions(): void {
  for (const prototype of Object.values(PROTOTYPES)) {
    for (const key of Object.keys(prototype)) {
      Object.defineProperty(prototype, key, { enumerable: false });
    }
  }
}
