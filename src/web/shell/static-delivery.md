# Static delivery: precompressed files (#116)

Linked from `CLAUDE.md` in this directory (PWA and the service worker), which keeps the cache policy and the service worker's side.

One `@fastify/static` root, `public/` (`src/static-assets.ts`); `/modules/*` is `public/modules/`, libraries copied from node_modules (`CLIENT_MODULES`, `scripts/static-assets.ts`). The build's last step (`generate:precompress`) writes `.br` (brotli 11) and `.gz` beside each text file of 1 KB+; `preCompressed` serves the one asked for with the source's type and `Vary: Accept-Encoding`, and `@fastify/compress` only compresses what has no variant (pages). At boot a variant older than its source, or orphaned, turns them off with a warning (never stale); development never uses them. Workbox globs match no variant and skip `modules/**`. The integration globalSetup lays out `public/` the same way. The request metrics (`src/metrics/http.ts`) add `Server-Timing` to a static answer at onSend, a header only: the body is the variant as it is on disk (`delivery.spec.ts` checks both).

## Gotchas

- **`preCompressed` with several roots misses files** (`@fastify/static` 10.1): one without a variant in the first root is then sought in the last only. Keep one root.
