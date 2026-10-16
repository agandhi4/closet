# Closet performance measurements (2026-09-25)

Environment: `dist/` was fresh (only a spec file and the generated `src-sw.js` were newer than `dist/main.js`), so no rebuild.
Server: `node dist/main` (Node v24.16.0 on this box, 16 cores), better-sqlite, local file storage, `AUTH_ENABLED=false PWA_ENABLED=false`.
Two instances were used: port 3100 with `NODE_ENV=production` for all timing, and port 3101 with `NODE_ENV=development` for SQL counting (MikroORM `debug` is `NODE_ENV !== 'production'`, and the Joi schema defaults `NODE_ENV` to `production`, so debug output needs an explicit `NODE_ENV=development`).
All logs and scripts are in this scratchpad: `seed.mjs`, `seed-results.json`, `seed.log`, `measure.sh`, `raw-*.txt`, `timings.md`, `headers.txt`, `queries.md`, `q-*.log`, `loadtest.log`, `autocannon-3100.log`, `server-prod.log`, `server-debug.log`.

```
DATA_PATH=<scratch>/measure-data AUTH_ENABLED=false PWA_ENABLED=false PORT=3100 NODE_ENV=production node dist/main
DATA_PATH=<scratch>/measure-data AUTH_ENABLED=false PWA_ENABLED=false PORT=3101 NODE_ENV=development node dist/main
```

## 1. Seed through the real HTTP endpoints (`node seed.mjs`)

Field names came from `wardrobe.controller.ts`, `outfit.controller.ts`, `calendar.controller.ts`, `views/wardrobe/form.hbs` and `views/wardrobe/show.hbs`.

Flow per garment, identical to what the browser does:
1. `POST /wardrobe` (urlencoded: name, category, brand, color, size, notes) -> 302 to `/wardrobe/:id?created=1`
2. `POST /wardrobe/:id/photo` (multipart: `photo` = 1600x1600 JPEG generated with sharp, gaussian noise tinted per color, avg 1,333,824 bytes; for 120 of the 150 garments also `nobgPhoto` = 1080x1080 WebP with alpha, 18,732 bytes)

Client-side background removal (`@imgly/background-removal` in the browser) cannot be scripted; the `nobgPhoto` field is what that step would upload, so a synthetic WebP was sent in its place. The server does no processing of `nobgPhoto` beyond streaming it to disk.

Outfits: `POST /outfits` with repeated `category` + `garmentId` fields (3 to 5 garments). Calendar: `POST /calendar` with `date`, `outfitId`, `notes`, `week`.

| create step | n | p50 ms | p95 ms |
|---|---|---|---|
| POST /wardrobe (metadata only) | 150 | 1.7 | 3.3 |
| POST /wardrobe/:id/photo, photo + nobgPhoto | 120 | 201.1 | 217.7 |
| POST /wardrobe/:id/photo, photo only | 30 | 199.4 | 214.6 |
| POST /outfits | 20 | 2.4 | 7.1 |
| POST /calendar | 30 | 2.0 | 2.5 |

Upload latency is entirely sharp: decode 1600x1600 JPEG, resize to 1080, encode WebP at `quality: 100`. First upload was 248.8 ms (cold sharp), then flat at ~200 ms. Measured client-side on loopback, so it includes the 1.3 MB body transfer but no real network.

Stored output: each 1080x1080 WebP at quality 100 is **890,052 bytes** for a noisy photo (real photos will be smaller but quality 100 lossy WebP is close to lossless in size). 150 garments -> `measure-data` was 122 MB.

## 2. Page and asset latency (`measure.sh`, 1 warm-up + 20 requests each, loopback)

```
curl -s -o /dev/null -w "%{time_starttransfer} %{time_total} %{size_download} %{http_code}\n" "$url" [-H ...]
```

No `Accept-Encoding` unless the row says gzip. G_ID=1, O_ID=1.

| request | status | TTFB p50 ms | TTFB p95 ms | total p50 ms | total p95 ms | body bytes |
|---|---|---|---|---|---|---|
| GET /wardrobe (150 garments) | 200 | 11.0 | 15.8 | 11.1 | 15.9 | 98,473 |
| GET /wardrobe, Accept-Encoding: gzip | 200 | 11.1 | 13.6 | 11.3 | 13.7 | 10,001 |
| GET /wardrobe, HX-Request: true | 200 | 10.1 | 10.6 | 10.2 | 10.7 | 98,473 |
| GET /wardrobe?keyword=blue&category=tops (0 results) | 200 | 5.3 | 6.1 | 5.3 | 6.2 | 20,129 |
| GET /wardrobe?color=blue (10 results) | 200 | 5.5 | 5.8 | 5.6 | 5.9 | 24,635 |
| GET /wardrobe/1 | 200 | 2.3 | 2.8 | 2.4 | 2.8 | 18,508 |
| GET /outfits (20 outfits) | 200 | 6.2 | 7.8 | 6.3 | 7.9 | 81,761 |
| GET /outfits/1 | 200 | 2.3 | 2.7 | 2.3 | 2.8 | 10,972 |
| GET /outfits/new (builder) | 200 | 6.9 | 8.9 | 7.0 | 8.9 | 49,181 |
| GET /outfits/new, gzip | 200 | 7.4 | 9.6 | 7.5 | 9.6 | 5,981 |
| GET /calendar (30 entries) | 200 | 9.0 | 10.5 | 9.0 | 10.6 | 37,821 |
| GET /file/nobg/<name>.webp, no nobg variant on disk | 302 | 0.9 | 1.0 | 0.9 | 1.0 | 0 |
| GET /file/<name>.webp (the redirect target) | 200 | 1.1 | 1.3 | 2.0 | 2.6 | 878,682 |
| GET /file/<name>.webp, gzip | 200 | 1.5 | 1.8 | 17.6 | 22.8 | 878,970 |
| GET /file/nobg/<name>.webp, nobg variant present | 200 | 0.9 | 1.1 | 1.0 | 1.2 | 18,732 |
| GET /bundle.css | 200 | 1.1 | 1.3 | 1.3 | 1.6 | 125,081 |
| GET /bundle.css, gzip | 200 | 1.9 | 2.6 | 3.4 | 3.7 | 20,545 |
| GET /sw.js | 200 | 1.1 | 1.3 | 1.2 | 1.5 | 127,703 |
| GET /modules/htmx.min.js | 200 | 1.1 | 1.2 | 1.1 | 1.2 | 51,238 |

Observations from the numbers:
- `HX-Request: true` on `/wardrobe` returns the identical 98,473-byte full page; there is no fragment path for the wardrobe grid.
- The garment grid `<img src>` is `/file/nobg/<fileName>`. It is `Cache-Control: no-store` in both branches (302 and 200), so every grid render re-requests every image, and when there is no nobg variant the browser makes two requests per garment (302 then the full file).
- `/file/<name>.webp` is served through `@fastify/compress`: with `Accept-Encoding: gzip` (which every browser sends) an incompressible 878 KB WebP is gzipped per request (878,682 -> 878,970 bytes, total time 2.0 ms -> 17.6 ms). Only the nobg variant benefits from the `no-store` skipping nothing; the compressible HTML pages are fine.
- `/file/<name>.webp` has **no `content-type` header** (only `cache-control`, `x-content-type-options: nosniff`, `vary`); with `nosniff` set the browser cannot sniff it. `/file/nobg/...` does set `image/webp`.

### Response headers observed (`headers.txt`)

```
== /file/nobg/<name>.webp (no nobg variant)
HTTP/1.1 302 Found
content-type: image/webp
cache-control: no-store
content-length: 0
== /file/<name>.webp
HTTP/1.1 200 OK
cache-control: public, max-age=31536000, immutable
x-content-type-options: nosniff
vary: accept-encoding
content-encoding: gzip           (no content-type, no content-length, no etag)
== /file/nobg/<name>.webp (nobg variant present)
HTTP/1.1 200 OK
content-type: image/webp
cache-control: no-store
== /bundle.css, /sw.js, /modules/htmx.min.js
cache-control: public, max-age=0
etag: W/"..."   last-modified: ...   content-encoding: gzip
== /wardrobe
content-type: text/html; charset=utf-8   content-encoding: gzip   (no cache-control)
```

## 3. Load tests

Repo load test (`npm run test:load`, `scripts/load-test.ts`). It rebuilds the app, spawns its own server on port 3000 with `NODE_ENV=production` and the inherited env, then runs autocannon with 10 connections for 10 s against `GET /`, which is a 302 to `/wardrobe`. It therefore measures redirect throughput, not a page render. It also writes `scripts/results/load-test-results.json` in the repo (its normal behaviour).

```
DATA_PATH=<scratch>/measure-data AUTH_ENABLED=false PWA_ENABLED=false PORT=3000 npm run test:load > loadtest.log
```

| metric | value |
|---|---|
| Requests/sec | 13,897.82 |
| Latency avg | 0.10 ms |
| Latency p50 | 0.00 ms |
| Latency p99 | 4.00 ms |
| Throughput | 8.59 MB/s |

Autocannon against the seeded pages on port 3100 (10 connections, 10 s, same library, `autocannon-3100.log`):

| URL | req/s | latency avg ms | p50 ms | p99 ms | MB/s | errors |
|---|---|---|---|---|---|---|
| /wardrobe | 114.7 | 86.3 | 79 | 171 | 10.85 | 0 |
| /outfits/new | 184.7 | 53.5 | 48 | 105 | 8.78 | 0 |
| /calendar | 148.2 | 66.7 | 63 | 130 | 5.44 | 0 |

Single Node process: 115 req/s for /wardrobe means roughly 8.7 ms of server CPU per render of the 150-garment page, matching the 11 ms single-request TTFB. Rendering, not SQL, is the cost (see section 4).

## 4. SQL statements per page (MikroORM debug on port 3101, `queries.md`, `q-*.log`)

Method: warm each page once, then record the log line count, make one request, and count `[query]` lines appended.

| page | SQL statements | queries (rows, time) |
|---|---|---|
| GET /wardrobe | 2 | `garment` unfiltered, no join (150 rows, 1 ms) for `findAvailableFilters`; `garment` left join `file` (150 rows, 5 ms) for the grid |
| GET /wardrobe?keyword=blue&category=tops | 2 | same unfiltered 150-row query for filters; filtered join query (0 rows, 3 ms) |
| GET /wardrobe/1 | 1 | `garment` joined to `file` and `outfits` (2 rows) |
| GET /outfits | 1 | `outfit` joined to garments (79 rows for 20 outfits) |
| GET /outfits/1 | 1 | `outfit` join (3 rows) |
| GET /outfits/new | 1 | `garment` left join `file` (150 rows, 1 ms) |
| GET /calendar | 2 | `outfit` join garments (79 rows, 1 ms); `outfit_calendar` join outfit + garments + files (28 rows, 7 ms) |
| GET /file/nobg/<name>.webp | 0 | filesystem only |

No N+1 anywhere. The only waste is `findAvailableFilters` loading all garment rows in full (every column) on every wardrobe request to derive distinct brand/size/category in JS, so `/wardrobe` always reads 150 + 150 rows.

## 5. /wardrobe page composition with 150 garments (`wardrobe.html`)

| item | count |
|---|---|
| HTML bytes (uncompressed / gzip) | 98,473 / 10,001 |
| `<img>` tags | 150 (all `src="/file/nobg/<name>.webp"`, 150 unique, no `loading="lazy"`, no `srcset`, no width/height) |
| `<script>` tags | 7 (5 external: htmx.min.js, _hyperscript.min.js, Sortable.min.js, sse.js, /js/color-multiselect.js; 1 inline; 1 other) |
| `<link>` tags | 7 (canonical, icon, apple-touch-icon, manifest, preconnect cloudflareinsights, preload bundle.css, stylesheet bundle.css) |
| CSS `url()` in HTML | 0 |

Image requests a browser issues for this page: 150 image fetches, all `no-store` so none are served from cache on revisit. With no nobg variant on disk each becomes 2 requests (302 + full file), so 150 to 300 image requests per grid render. In this seed 120 garments had a nobg variant (18 KB each) and 30 did not (each falls through to an 878 KB full-size WebP that is gzipped on the fly); with real photos where background removal was skipped, the grid pulls the full 1080px quality-100 image per tile. Payload for this grid: 120 x 18.7 KB + 30 x 879 KB = about 28.6 MB, of which 26.4 MB is the 30 non-nobg tiles. All 150 images load eagerly on first paint.

`/outfits/new` renders 9 `<img>` (8 unique `/file/` sources), one per category row, so the builder page is light despite loading all 150 garments server-side.

## 6. Teardown

Both servers were stopped and `<scratch>/measure-data` deleted. The repo was not modified except for `scripts/results/load-test-results.json`, which the repo's own load-test script writes on every run.
