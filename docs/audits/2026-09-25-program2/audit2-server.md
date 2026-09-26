# Closet server and data layer audit, round 2 (2026-09-25)

Scope: what still costs time after the first program (indexes, one auth resolution per request, transactional writes, DISTINCT filters, thumbnails). Everything that shipped is excluded. File:line references are against `main` at 6a5e64f.

## How this was measured

- Throwaway worktree at HEAD (`npm ci`, `npm run build`), removed afterwards. The repo was not touched.
- **Scale:** 1,000 garments (every tenth one archived, each with a File row and about 180 chars of notes), 100 outfits with 4 garments each, and 60 calendar entries. They were seeded straight into SQLite and into a private Postgres 17 container (`closet-audit2-server-pg`, since removed). `AUTH_ENABLED=true` with one user, `NODE_ENV=production`.
- **Network:** Postgres RTT was measured over loopback (about 0.1 ms) and again with `tc netem` adding 1 ms of delay inside the Postgres container. Measured `select 1` RTT was 1.22 ms. A userspace delay proxy was tried first and discarded because it distorted large result sets.
- **Hardware:** a 16-core dev box on Node 24. The NAS has a slower CPU, so treat every CPU number here as a lower bound. Multiply by roughly 2 to 4 for a low-power NAS CPU.
- **Tools:**
  - curl TTFB: 15 to 21 samples per page, reported as p50 and p90.
  - autocannon for load.
  - `--cpu-prof` over 150 renders of `/wardrobe`.
  - A MikroORM micro-benchmark run inside the booted app.
  - SQL counts from MikroORM debug logging.
  - Rerunning every write path with `allowGlobalContext: false`.

## Summary: where the time goes now

| page (1,000 garments) | SQLite p50 | PG loopback p50 | PG 1 ms RTT p50 | SQL stmts | sequential DB round trips | raw HTML / brotli |
|---|---|---|---|---|---|---|
| GET /wardrobe | 45.6 ms | 47.5 | 45.7 | 6 | 3 | 530 KB / 32.5 KB |
| GET /wardrobe (HX fragment) | 42.4 | 42.5 | 43.9 | 6 | 3 | 521 KB / 30 KB |
| GET /wardrobe?keyword=… (10 hits) | 5.7 | 7.2 | 9.4 | 6 | 3 | 27 KB |
| GET /wardrobe/:id | 3.7 | 5.3 | 6.7 | 2 | 2 | 21 KB |
| GET /wardrobe/new | 3.7 | 4.4 | 6.1 | 4 | 2 | 19 KB |
| GET /outfits (100 outfits) | 25.0 | 27.9 | 28.8 | 2 | 2 | 419 KB / 16 KB |
| GET /outfits/new (builder) | 32.7 | 38.5 | 36.1 | 2 | 2 | 53 KB |
| GET /outfits/row-fragment (one arrow tap) | 6.1 | 8.0 | 9.0 | 2 | 2 | 5 KB |
| GET /outfits/:id/edit | 35.7 | 41.8 | 38.8 | 3 | 2 | 53 KB |
| GET /calendar | 7.1 | 10.3 | 9.9 | 3 | 2 | 42 KB |
| GET /wardrobe-share/manage | 3.4 | 5.1 | 6.6 | 4 | 2 | 10 KB |

Round-trip counts come from the SQL log. Every authenticated page starts with the one `user` lookup, then the page's own queries, some of them issued in parallel.

**What the numbers say:**

- **Database latency is no longer the problem.** Moving Postgres 1 ms away adds 1.5 to 3 ms per page, which matches the 2 to 3 sequential round trips.
- **The expensive thing is turning rows into MikroORM entities, on every list page that loads the whole wardrobe.** CPU profile of 150 `/wardrobe` renders (busy time):

  | where | share of busy time |
  |---|---|
  | `@mikro-orm/core` | 38.6% |
  | knex | 11.2% (mostly the driver call) |
  | `@mikro-orm/knex` | 9.6% |
  | GC | 6.2% |
  | Handlebars | 3.5% |
  | app code (view context, helpers, i18n) | 1.2% |

---

## Findings, ranked by impact

### 0. (Correctness, found while measuring uploads) Every upload with a real-size cutout fails with a 500

**Evidence.** `POST /wardrobe/:id/photo` with the browser's real payload returned **500 on 9 of 9 attempts**:

- a 3024x4032 JPEG `photo`, plus
- a 4032x4032 `nobgPhoto`, either the 1.4 MB WebP the mask editor produces on Apply or the 13.6 MB PNG that `removeBackground` returns on Skip.

The same photo with no cutout returned 201 every time. The stack trace:

```
UnreadableImageError: Input buffer contains unsupported image format
  at transcode (file-service.abstract.ts:338-357)
  at writeThumb (file-service.abstract.ts:312-329)
  at storeImageFromFileUpload (file-service.abstract.ts:108)
```

The earlier measurement seeds never hit this because their cutout was a synthetic 18 KB WebP, small enough to finish before the original did. `test/integration/mask-edit.spec.ts` uses small fixtures too.

**Root cause.**

- `LocalFileService.store` (`local-file.service.ts:222-232`) streams straight into the final file name. The file exists, empty or half-written, from the moment the cutout pipeline starts.
- `storeImageFromFileUpload` builds its own thumb as soon as the original is done (`file-service.abstract.ts:108`).
- `writeThumb` picks the cutout whenever `getIfExists(<uuid>-nobg.webp)` succeeds (`:313-315`). "The file exists" is being treated as "the file is complete."
- The chained `thumbJobs` queue only orders thumb writes against each other. It does not order a thumb against the cutout write it reads from.
- The failure surfaces as a 500 because `UnreadableImageError` is only mapped to 400 inside `transcodeUpload`, not on the thumb path.

The same code also encodes the thumb up to three times per upload with a cutout: `:108`, then `:165`, then `garment.service.ts:438`.

**Fix (structural):**

1. Make `store` atomic on the local backend: write to `<name>.<uuid>.part`, then `rename()`. S3 `Upload` already only appears when complete.
2. Stop deriving thumbs inside the per-variant store methods. The upload orchestration (`storeUploadedPhotoWithCutout`) should write the original and the cutout, then write the thumb **once**, from the cutout if one was sent and otherwise from the original.
3. `regenerateThumb` stays for lazy backfill and mask edits.
4. Add an integration test with a cutout larger than the original (a few MB) so the race stays covered.

**Trade-off:** none. This is a bug. **Verify in production first:** check app.log on the NAS for `Unreadable image` on `/wardrobe/*/photo` since today's deploy.

### 1. List pages hydrate the whole wardrobe as managed entities: CPU and memory grow with wardrobe size

**Evidence.**

MikroORM benchmark: the same 900-row grid query (`owner=1, archived=false, order by id desc`, 1,000-garment SQLite), mean of 30 runs:

| variant | ms per query |
|---|---|
| current `find(..., {populate:['photo']})` | **33.0** |
| `fields: [id, name, category, archived, photo.fileName, photo.version]` | 22.0 |
| `disableIdentityMap: true` | 29.1 |
| QueryBuilder `.execute('all')` (plain rows, same join) | **1.3** |
| current query with `limit: 48` | **1.9** |
| outfits index `populate: ['garments','garments.photo']` (100 outfits) | 36.9 |

On Postgres itself the grid SQL executes in 1.27 ms (`EXPLAIN ANALYZE`: hash join plus a sort of 900 rows). More than 95% of the grid's server cost is entity construction, reference propagation (`ensurePropagation` is the top function) and identity-map registration.

**Load and memory:**

| | throughput | latency | RSS |
|---|---|---|---|
| `/wardrobe`, autocannon c=4 | 24.5 req/s | p50 157 ms, p97.5 250 ms | 775 MB, from 240 MB at idle |
| `/outfits/new`, autocannon c=4 | 31 req/s | | |

RSS plateaued at 775 MB and stayed flat across three load rounds, so this is heap growth, not a leak. Every render creates about 2,000 managed objects that become garbage.

On a NAS CPU 2 to 4 times slower, one household member's `/wardrobe` at 1,000 garments costs roughly 100 to 180 ms of blocked event loop. Everything else queues behind it, including thumbnails and `/healthz`, which drives the offline banner.

**Where it happens (all O(all garments) per request):**

- **Wardrobe grid.** `wardrobe.controller.ts:115-118` calls `garment.service.ts:62-103`: every non-archived garment, full columns (notes, washing details, shareable id…) plus the full File row. The template (`partials/wardrobe_main.hbs:32-50`) reads only `id`, `name`, `category`, `archived`, `photo.fileName` and `photo.version`. The HX fragment path pays the same cost, because the grid is the fragment.
- **Outfit builder.** `outfit.controller.ts:54` and `:146-149` (edit) load every garment, only to show **one garment per category row** (about 8 rows). `buildCategoryRows` runs twice on edit (`:155-161`).
- **Builder arrow tap.** `outfit.controller.ts:115-122` loads the whole category (100+ entities at this scale) to render one garment at index `idx`. That is one request per swipe.
- **Outfits index.** `outfit.service.ts:31-43` hydrates every outfit with every garment and its photo, all columns. The template uses outfit `id`, `name` and `notes`, and per garment `name` plus the photo URL.
- **Calendar.** Already bounded to a week, and the picker already selects `id, name`. Leave it.

**Fix, in order of leverage:**

1. **Keyset pagination for the grid.**
   - Query: `WHERE owner_id=? AND archived=false [filters] AND id < :cursor ORDER BY id DESC LIMIT 48`.
   - Result count: from `count(*)` over the same filter, cheap.
   - Index: add `@Index({ properties: ['owner', 'archived', 'id'] })` on Garment so Postgres can walk the index for the LIMIT instead of sorting. That needs a migration pair; at 1,000 rows a sort costs about 1 ms, so it is optional until wardrobes are much larger.
   - **htmx:**
     - Split `partials/wardrobe_main.hbs` into the shell (count, filter bar, modal) and a new `partials/wardrobe_tiles.hbs`.
     - The last tile carries a sentinel: `<div hx-get="/wardrobe/tiles?cursor={{lastId}}&{{query}}" hx-trigger="revealed" hx-swap="outerHTML">`.
     - `GET /wardrobe/tiles` returns the next 48 tiles plus the next sentinel.
     - `GET /wardrobe` and the fragment path render only the first page.
     - The existing `isFragmentRequest`/`Vary` logic is unchanged; the tiles route is always a fragment.
   - **Service worker:** the `pages-v1` NetworkFirst cache keys include the query string, so pages cache naturally.
   - **Trade-off:** offline, only the pages already viewed are browsable. Ctrl-F over the whole wardrobe no longer works (the server-side search does). Given the PWA-first rule, consider a larger first page (96) so a typical phone session never needs more.
2. **Projection read models for list views.**
   - Grid tiles and outfit-index cards should come from `em.createQueryBuilder(...).select([...]).leftJoin(...).execute('all')` or `em.execute`, shaped straight into the view-model objects that already exist in `src/wardrobe/view-models/`.
   - Keep managed entities for detail and write paths, where the unit of work earns its cost.
   - This is the MikroORM-sanctioned read path, not a hack. The measured 25x difference is exactly what it is for.
   - Even without pagination, this alone takes the 1,000-garment grid from about 45 ms to about 12 ms.
3. **Outfit builder without the wardrobe.**
   - `newForm`/`editForm`:
     - One aggregate: `SELECT category, count(*) FROM garment WHERE owner_id=? AND archived=false GROUP BY category`.
     - Plus the first garment per category: `DISTINCT ON (category) … ORDER BY category, id DESC` on Postgres, or a `row_number()` window on SQLite. MikroORM supports both through raw QB.
     - Plus, on edit, the selected garments by id.
   - `rowFragment`: `… AND category=? ORDER BY id DESC LIMIT 1 OFFSET idx-1` plus the category count. This makes each swipe O(1) instead of O(category). The ordering must stay identical to today's `id DESC` so indexes keep their meaning.
4. **Outfits index:** paginate the same way as the grid (20 cards per page), or at minimum use projection.

**Expected result at 1,000 garments:**

| page | now (dev box) | expected |
|---|---|---|
| `/wardrobe` | 46 ms | about 5 ms |
| `/outfits/new` | 36 ms | about 4 ms |
| builder arrow tap | 6 to 9 ms | about 3 ms |

Heap churn drops by roughly 20x. This is the one change that keeps the app flat as wardrobes grow.

### 2. HEIC uploads freeze the whole server for about a second (several seconds on the NAS)

**Evidence.** A 2.0 MB iPhone HEIC (3024x4032) through `decodeHeic` (`heic.ts:37-53`, `heicConvert` at `:47`):

- `heic->jpeg` took 1,166 ms and 1,081 ms.
- The largest event-loop stall measured during the call was **1,152 ms**. libheif-js is synchronous WASM on the main thread. Every request in flight, including `/healthz`, waits.
- It also encodes a 12 MP JPEG at quality 0.92 only for sharp to decode it again.
- Using `heic-decode` directly (raw RGBA) took 575 to 658 ms. Feeding that into `sharp(raw)` for the 1080 WebP took 164 ms.
- Requiring `heic-convert` adds about 28 MB RSS at boot (the libheif WASM), paid by every process even though HEIC is rare.

**Fix:**

1. Decode to raw RGBA with `heic-decode` and hand it to sharp as `{ raw: { width, height, channels: 4 } }`. That cuts decode CPU by about 45% and removes the extra JPEG encode and decode.
2. Run the decode in a `worker_threads` worker, one long-lived worker via piscina or a small hand-rolled pool with a queue of 1. The main event loop then never blocks, and libheif lives only in the worker's heap.

The `MAX_HEIC_BYTES` cap stays. **Trade-off:** one more moving part, a worker with its own lifecycle. It is the standard answer for synchronous WASM in a server.

### 3. Upload pipeline CPU: about 400 ms per real upload, mostly avoidable

**Evidence.** Measured stage costs with sharp 0.34.5 on these inputs:

- a real photo: 3024x4032 JPEG, 2.6 MB
- a 4032x4032 cutout as PNG (13.6 MB) and as WebP (1.4 MB)

| stage | ms |
|---|---|
| original: decode 12 MP JPEG, autoOrient, resize to 1080, WebP q90 | 112-116 |
| cutout as PNG (Skip in the mask editor), decode 16 MP, 1080 WebP | 284-296 |
| cutout as WebP (Apply) | 195-216 |
| one thumb (decode the 1080 WebP, resize to 400, q80) | 26-34 |
| current flow: original and cutout in parallel, then 3 thumbs | 383-549 |
| same outputs, one decode per input, thumb cloned from the decoded cutout | 297-391 |
| original at `effort: 2` instead of the default 4 | 73-99 (output size within 1%) |

The 215 ms p50 in `audit-remeasure.md` used a 1600px noise JPEG and an 18 KB cutout, so it understated real uploads. With real inputs the server spends about 400 ms of CPU per upload. On the NAS that is probably 1 to 1.5 s.

`sharp.concurrency()` is already 1 (glibc without jemalloc) and the libvips cache is the default 50 MB/100 items. Caching does nothing for unique uploads; `sharp.cache(false)` would free that memory.

**Where the time goes:**

1. **Decoding a full-resolution cutout.** The browser sends the cutout at the original resolution: `squarePadBlob` in `public/js/background-removal.js:103-115`, and `removeBackground` output with the PNG default (`output` is commented out at `:35`), labelled `nobg.webp` but actually PNG on Skip. The server then decodes 16 MP only to shrink it to 1080.
2. **The thumb is re-derived from disk up to three times** (finding 0).
3. **Default WebP effort.**

**Fix:**

- **Client side** (belongs with the frontend audit, but it is the biggest server saving): downscale the cutout to 1080 inside the canvas the code already draws, and encode it as WebP 0.9 before upload. The server's cutout transcode drops from about 200-290 ms to about 20 ms, and the phone uploads roughly 10x fewer bytes.
- **Server side:**
  - Decode each input once and emit its outputs from `sharp.clone()`.
  - Write the thumb once (finding 0).
  - Consider `effort: 2` for the 1080 variant: 35% less CPU at equal size.

**Trade-off of `effort: 2`:** slightly worse compression on some images, within 1% here.

**Concurrency.** libuv's default 4-thread pool is shared by sharp and all `fs` work: static files, thumbnail streaming, the `fs.access` probes. A burst of sharp jobs can therefore starve image serving. That happens on the lazy thumb backfill when an old wardrobe first renders its grid, or when two uploads coincide.

- **Fix:** bound sharp work with a small semaphore in `FileService` (2 concurrent transcodes), or raise `UV_THREADPOOL_SIZE` in the Dockerfile (8).
- **Trade-off:** a semaphore adds queueing latency to uploads, but keeps reads responsive.

### 4. Every request is access-logged at info with the full headers, including the JWT, pretty-printed twice

**Evidence.**

- `LoggerModule` (`app.module.ts:170-209`) uses `pinoHttp` with default `autoLogging` and two `pino-pretty` targets (stdout and `DATA_PATH/app.log`).
- In production (`LOG_LEVEL` defaults to info), **every** request logs a "request completed" line with all request and response headers. That includes each static asset, each `/file/thumb/*` (150 per grid view) and each `/healthz` probe (every 30 s per open device).
- Every line includes `cookie: access_token=<JWT>`, so app.log holds live session tokens.
- app.log is plain `pino-pretty` with `destination`. **Nothing rotates it**, despite CLAUDE.md saying "rotating app.log".
- The two pretty targets share one `pino.transport` worker thread. That thread competes for NAS cores with sharp and Postgres.
- **Throughput cost:** at c=10, thumbnail serving drops from 5,977 to 5,031 req/s with info-level logging (-16%). Small pages drop about 4%.

**Fix:**

1. Set `autoLogging: { ignore: (req) => isStaticPath(req.url) }`, reusing `static-prefixes.ts`, so requests that never render are never logged.
2. Add `redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]']`.
3. Log JSON to stdout in production (Docker already collects it) and keep pino-pretty for `NODE_ENV=development`.
4. If app.log must stay, write it with `pino-roll` (size or daily rotation, keep N files).

Also update the CLAUDE.md claim. **Trade-off:** raw JSON in `docker logs` is less readable; `docker logs closet | npx pino-pretty` covers that.

### 5. Brotli-compressing a 24 MB WASM on every fetch

**Evidence.**

- `@fastify/compress` is registered globally with defaults (`app.ts:103`): brotli quality 4, threshold 1 KB, and anything mime-db calls compressible.
- `GET /modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm` with `Accept-Encoding: br` compresses 23.9 MB to 4.8 MB **on every request**: TTFB 202 ms, total 357 ms of one core. The NAS will be slower.
- The background-removal runtime revalidates these files through the service worker (`cache: 'no-cache'`), so a changed build or a new device pays the full compression again.
- `ort.all.bundle.min.mjs` (834 KB) costs 13 ms. `bundle.css` and `sw.js` cost about 2 ms each, on every cold fetch.
- HTML pages compress in about 1 to 2 ms, which is fine and should stay dynamic.

**Fix:**

- Precompress the immutable static roots at build time (brotli q11 plus gzip `.br`/`.gz` siblings, from a small script in `npm run generate` or a Dockerfile step) and set `preCompressed: true` on those `useStaticAssets` registrations (`app.ts:136-195`).
- Keep `@fastify/compress` for dynamic responses. Either restrict it (`global: false` plus `reply.compress` in the view path) or rely on its skip when `Content-Encoding` is already set, which is what the static plugin sets with `preCompressed`.
- **Result:** zero runtime compression CPU for statics, and about 15% smaller files at q11.
- **Trade-off:** a bigger image (the .br files add about 20% of the compressible statics). Skip the 328 MB of model chunks; they are `application/octet-stream` and already bypass compression.

### 6. Postgres connection pool: burst width versus reaping

**Evidence.**

- `dal.module.ts:48-90` passes no `pool` option, so knex's default applies: `min 2, max 10`, with the tarn idle reap at 30 s.
- `/wardrobe` issues 4 concurrent queries: the grid plus 3 DISTINCTs (`garment.service.ts:198-227`). That grows the pool to 4. After 30 s idle it shrinks back to 2 (observed in `pg_stat_activity`: 2, then 4, then 2).
- A new connection (TCP, SCRAM-SHA-256, backend fork) measured **10.8 ms** at 1 ms RTT, about 9 round trips' worth.
- So the first `/wardrobe` after any pause (the normal household pattern) pays that. Measured: 67 ms against 45-53 ms warm.
- The `brands` DISTINCT (`garment.service.ts:200`) is **dead work**. No template or caller reads `filters.brands`.

**Fix:**

1. Fold the filter lists into one statement and drop brands:

   ```sql
   SELECT array_agg(DISTINCT size), array_agg(DISTINCT category) …
   ```

   SQLite has no `array_agg`. Use two `SELECT DISTINCT` statements `UNION ALL`-tagged in one query, or `json_group_array(DISTINCT …)` behind the same service method. Keep it in the repository or service, not the controller.
2. Start `getInboundShares` (`wardrobe.controller.ts:104-113`) in the same `Promise.all` as the grid instead of before it. That saves one sequential round trip.
3. Set `pool: { min: 2, max: 6, idleTimeoutMillis: 600_000 }` so a household-scale burst never reconnects. 6 connections per app is trivial for pgvault.

**Prepared statements:** knex/pg sends parameterised queries as unnamed extended-protocol messages (Parse/Bind/Execute/Sync in one round trip). Named prepared statements would save only server-side planning, which is under 1 ms for these queries. Not worth it.

### 7. Startup time and idle memory

**Evidence.**

- Boot to first `/healthz` takes 850-1,040 ms on SQLite. Of that, 686 ms is `require()` of about 3,200 modules. Nest create is 119 ms and init/listen is 45 ms.
- Idle RSS is about 240 MB.
- Standalone require costs, which overlap through shared dependencies:

  | module | time | RSS |
  |---|---|---|
  | `nestjs-s3` + `@aws-sdk/client-s3` | 150 ms | 39 MB |
  | `heic-convert` | 47 ms | 28 MB |
  | `@mikro-orm/migrations` | 213 ms | 41 MB |
  | `nestjs-i18n` | 174 ms | 36 MB |
  | `sharp` | 54 ms | 22 MB |

- The S3 client is constructed even with `FILE_STORAGE_TYPE=local`. `FileModule` always imports `S3Module.forRootAsync` (`file.module.ts:18`) and always instantiates `S3FileService`.
- The container runs `CMD ["npm","run","start:prod"]` (`docker/Dockerfile`), so an npm process (about 40-50 MB) sits in front of node for the life of the container.

**Fix, in order of value:**

1. Moving HEIC decode into a worker (finding 2) also moves libheif out of the main process, about 28 MB.
2. Use `CMD ["node","dist/main"]`, and set `NODE_OPTIONS=--max-old-space-size=256` (or similar) so V8 does not size the heap for the NAS's total RAM. The 775 MB plateau in finding 1 was V8 taking heap because it could. This bound matters until finding 1 is fixed.
3. Make `FileModule` a dynamic module (`FileModule.forRoot()`) that registers `S3Module` and `S3FileService` only when `FILE_STORAGE_TYPE=object`. This removes client construction and one Nest provider tree. The `require` of `nestjs-s3` remains unless the S3 backend moves to its own module file that only the object-storage path imports, which is the clean version of this.
4. Migrations: `migrator.up()` on every boot costs a few queries against `mikro_orm_migrations` and is fine to keep.

**Trade-off:** boot time only matters for deploy downtime on autoupdate (a few seconds on the NAS). Items 1 and 2 are the ones worth doing. Item 3 is optional.

### 8. Smaller items (each cheap, do while in the area)

- **Search is case-sensitive on production Postgres (correctness).** `garment.service.ts:75-83` uses `$like`. SQLite's LIKE is case-insensitive for ASCII; Postgres' is not. Measured on the same data:

  | keyword | SQLite | Postgres |
  |---|---|---|
  | `garment 12` | 10 | 0 |
  | `UNIQLO` | 133 | 0 |

  - **Fix:** `$ilike`. MikroORM renders it as `ilike` on Postgres and `like` on SQLite. Add an integration case, since CI runs both drivers.
  - **pg_trgm is not warranted.** The filtered query executes in 1.4 ms at 1,000 rows (seq scan on one owner's rows). A trigram GIN on `lower(name || ' ' || coalesce(notes,'') || ' ' || coalesce(brand,''))` only pays off past tens of thousands of rows per owner.
- **Garment detail over-fetch.** `garment.service.ts:111` populates `outfits` (a joined m:n) for every `findOne`. `views/wardrobe/show.hbs` never reads it, and neither do the write paths that reuse `findOne` (update, archive, remove, nobg). Drop it.
- **Duplicate share lookup.** With `?ownerId=` the controller resolves access (`wardrobe.controller.ts:63`), then `GarmentService.findOne` resolves it again (`garment.service.ts:116`). That is one extra `wardrobe_share` query and round trip on every shared-wardrobe detail, edit and update request. Pass the resolved `WardrobeAccess` into `findOne` instead of `(userId, viewOwner)`.
- **Share management page.** `/wardrobe-share/manage`: three parallel `WardrobeShare.find` calls, each populating both users (`wardrobe-share.service.ts:139-158`). One query (`WHERE grantor_id = :me OR grantee_id = :me`) partitioned in the service gives the same result over one connection.
- **`allowGlobalContext: true`** (`dal.module.ts:45,88`) is not needed by any request path. Every write path was rerun with it set to `false`:
  - garment create
  - multipart photo upload
  - mask-edit nobg
  - outfit create
  - calendar create
  - worn toggle
  - archive
  - grid render

  No global-context error: MikroORM's request context survives Fastify body parsing and multipart streams. The nightly reconciliation already forks (`storage-reconciliation.service.ts:111`). Flipping it to `false` turns any future out-of-request EM use into a loud error instead of a silently shared identity map. Run `test:int` on both drivers after the flip.
- **Per-request middleware on static paths.** Nest middleware (`MikroOrmMiddleware` forking an EM, `I18nMiddleware` resolving `Accept-Language` and creating an ALS context) runs through middie for every request, including `/file/**` and `/modules/**`, before the preHandler's static skip. It measured at about 0.1 ms per request (thumbs serve at about 6,000 req/s). Not worth restructuring; noted so nobody hunts for it.

## Checked and fine

- **Handlebars caching.** `@fastify/view` compiles each template once and caches it in production (`prod` follows `NODE_ENV=production`, set in the Dockerfile; `viewPartial` passes it explicitly, `app.ts:231`). The shared LRU (100 entries) holds all 31 templates for both view instances. Partials are registered as strings by `hbs.registerPartials` and compiled lazily **once** into the global partial table (`handlebars/runtime.js:85,224`). Rendering is 3.5% of `/wardrobe` CPU.
- **View context and i18n.** `ViewContextService.buildContext` is a handful of string operations plus one `i18n.t`. Templates make 25-45 `{{t}}` calls per page, each a key walk plus one regex pass. Together they are under 1.2% of CPU.
- **Auth.** One JWT verify and one `user` query per non-static request. Later `findOneOrFail(userId)` calls in the outfit and calendar create paths hit the identity map, with no extra query.
- **N+1.** None anywhere. All populates are joined (MikroORM 6 default `LoadStrategy.JOINED`).
- **Debug logging.** Off in production (`debug: NODE_ENV === 'development'`).
- **Calendar.** Bounded to one week plus an `id,name` picker (3 queries, 10 ms at 1 ms RTT).
- **Image GET path.** `getVariant` does one `fs.access` plus one `createReadStream`, and two for a missing cutout that falls back to the original. It streams and sets immutable headers. There is no `Content-Length`, so responses are chunked; harmless with immutable caching. Thumbnail single-flight via `thumbJobs` is correct for a single process.
- **Query plans.** The indexes shipped in round 1 are used. At household scale the planner's seq scans over one owner's 1,000 rows are the right choice (about 1.3 ms). DB round-trip latency (finding 6) matters far less than the CPU findings above.

## Suggested order

1. **Finding 0.** An atomic `store` plus a single thumb write, with a large-cutout integration test. It is a live upload bug, so check app.log on the NAS first.
2. **Finding 4** (log hygiene and the token leak) and **finding 8's `$ilike`**. Small, and both are correctness or security.
3. **Finding 1.** Projection read models, then grid keyset pagination with htmx `revealed` loading, then the O(1) outfit builder.
4. **Finding 2** (HEIC worker) and **finding 3** (client-side cutout downscale, one decode, effort 2).
5. **Findings 5, 6, 7.** Precompressed statics, pool settings plus the folded filter query, and `node` as PID 1 with a heap cap.
