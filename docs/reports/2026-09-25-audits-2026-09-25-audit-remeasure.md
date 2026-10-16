# Closet performance re-measurement after the program (2026-09-25)

Repeats `audit-measure.md` (the baseline) on `main` at `e6a5ca3` with the same methodology. Same box (Node v24.16.0, 16 cores), better-sqlite, local file storage, `AUTH_ENABLED=false PWA_ENABLED=false`, `npm run build` fresh (`remeasure-build.log`, exit 0).

```
DATA_PATH=<scratch>/remeasure-data AUTH_ENABLED=false PWA_ENABLED=false PORT=3100 NODE_ENV=production node dist/main   # all timing
DATA_PATH=<scratch>/remeasure-data AUTH_ENABLED=false PWA_ENABLED=false PORT=3101 NODE_ENV=development node dist/main  # SQL counting
```

Files in this scratchpad: `remeasure.sh` (driver, reuses the baseline `measure.sh` and `seed.mjs` unchanged), `remeasure-seed.log`, `remeasure-seed-results.json`, `remeasure-timings.md`, `raw-rm-*.txt`, `remeasure-headers.txt`, `remeasure-wardrobe.html`, `remeasure-grid-urls.txt`, `remeasure-grid-bytes.txt`, `remeasure-autocannon-3100.log`, `remeasure-loadtest.log`, `remeasure-queries.md`, `remeasure-q-*.log`, `remeasure-server-prod.log`, `remeasure-server-debug.log`.

## 1. Seed through the real HTTP endpoints (`node seed.mjs`, unchanged from baseline)

Controller field names are unchanged (`POST /wardrobe` urlencoded, `POST /wardrobe/:id/photo` multipart `photo` + optional `nobgPhoto`), so the baseline script ran as is: 150 garments with a 1600x1600 noisy JPEG (avg 1,333,800 bytes), 120 of them with the synthetic 18,732-byte WebP `nobgPhoto`, 20 outfits, 30 calendar entries.

| create step | n | p50 ms | p95 ms | baseline p50 / p95 |
|---|---|---|---|---|
| POST /wardrobe (metadata only) | 150 | 1.8 | 3.0 | 1.7 / 3.3 |
| POST /wardrobe/:id/photo, photo + nobgPhoto | 120 | 215.2 | 226.3 | 201.1 / 217.7 |
| POST /wardrobe/:id/photo, photo only | 30 | 217.3 | 232.0 | 199.4 / 214.6 |
| POST /outfits | 20 | 2.4 | 8.8 | 2.4 / 7.1 |
| POST /calendar | 30 | 1.7 | 2.4 | 2.0 / 2.5 |

First upload 247.2 ms (cold sharp), then flat at ~215 ms. Upload is about 15 ms slower than baseline because the server now produces three variants per photo instead of one.

Stored output per garment (`find remeasure-data`): 420 WebP files for 150 garments.

| variant on disk | files | avg bytes | baseline |
|---|---|---|---|
| `<uuid>.webp` (original, 1080px) | 150 | 548,108 | 890,052 (quality 100) |
| `<uuid>-thumb.webp` (400px, q80, derived from nobg when present) | 150 | 8,879 | did not exist |
| `<uuid>-nobg.webp` | 120 | 14,526 | 18,732 (stored as uploaded) |

`remeasure-data` was 87 MB for 150 garments (baseline 122 MB).

## 2. Page and asset latency (`measure.sh`, 1 warm-up + 20 requests each, loopback, port 3100)

```
curl -s -o /dev/null -w "%{time_starttransfer} %{time_total} %{size_download} %{http_code}\n" "$url" [-H ...]
```

No `Accept-Encoding` unless the row says gzip. G_ID=1, O_ID=1. `<thumb>` is the grid `<img src>` exactly as rendered: `/file/thumb/<uuid>.webp?v=1`.

| request | status | TTFB p50 ms | TTFB p95 ms | total p50 ms | total p95 ms | body bytes |
|---|---|---|---|---|---|---|
| GET /wardrobe (150 garments) | 200 | 8.7 | 12.6 | 8.8 | 12.7 | 110,143 |
| GET /wardrobe, Accept-Encoding: gzip | 200 | 9.2 | 12.3 | 9.4 | 12.3 | 10,805 |
| GET /wardrobe, HX-Request: true (fragment `partials/wardrobe_main`) | 200 | 7.6 | 9.0 | 7.7 | 9.1 | 101,665 |
| GET /wardrobe?keyword=blue&category=tops (0 results) | 200 | 2.9 | 3.3 | 2.9 | 3.3 | 22,738 |
| GET /wardrobe?color=blue (10 results) | 200 | 3.1 | 3.7 | 3.2 | 3.7 | 27,751 |
| GET /wardrobe/1 | 200 | 2.7 | 3.0 | 2.8 | 3.1 | 20,511 |
| GET /outfits (20 outfits) | 200 | 6.6 | 7.7 | 6.7 | 7.8 | 92,146 |
| GET /outfits/1 | 200 | 2.5 | 2.8 | 2.6 | 2.9 | 13,101 |
| GET /outfits/new (builder) | 200 | 7.0 | 7.4 | 7.0 | 7.5 | 51,304 |
| GET /outfits/new, gzip | 200 | 7.6 | 10.3 | 7.7 | 10.4 | 6,647 |
| GET /calendar (30 entries) | 200 | 5.4 | 6.3 | 5.5 | 6.4 | 41,494 |
| GET `<thumb>` for garment 1 (nobg present) | 200 | 1.1 | 1.3 | 1.2 | 1.4 | 5,424 |
| GET `<thumb>` for garment 1, gzip | 200 | 1.0 | 1.1 | 1.1 | 1.2 | 5,424 |
| GET `<thumb>` for garment 150 (no nobg) | 200 | 1.1 | 1.2 | 1.2 | 1.3 | 25,876 |
| GET /file/nobg/<name>.webp, no nobg variant on disk | 200 | 1.2 | 1.3 | 1.9 | 2.1 | 574,482 |
| GET /file/nobg/<name>.webp, nobg variant present | 200 | 1.1 | 1.3 | 1.2 | 1.4 | 15,954 |
| GET /file/<name>.webp (original) | 200 | 1.2 | 1.3 | 2.2 | 2.5 | 574,482 |
| GET /file/<name>.webp, gzip | 200 | 1.1 | 1.3 | 2.0 | 2.4 | 574,482 |
| GET /bundle.css | 200 | 1.1 | 1.4 | 1.3 | 1.6 | 127,361 |
| GET /bundle.css, gzip | 200 | 2.3 | 2.6 | 3.5 | 4.3 | 20,954 |
| GET /sw.js | 200 | 1.0 | 1.3 | 1.2 | 1.8 | 130,682 |
| GET /modules/htmx.min.js | 200 | 1.0 | 1.2 | 1.1 | 1.3 | 51,238 |

Observations:
- `HX-Request: true` on `/wardrobe` now returns the `partials/wardrobe_main` fragment (101,665 bytes vs 110,143 for the page) with `Vary: HX-Request, HX-Boosted, HX-History-Restore-Request, accept-encoding`. The fragment is still 92% of the page because the 150-tile grid is the page.
- Images are no longer gzipped on the fly: `/file/<name>.webp` with `Accept-Encoding: gzip` returns the same 574,482 bytes in 2.0 ms (baseline: 878,682 -> 878,970 bytes and 2.0 -> 17.6 ms).
- `/file/nobg/<name>` with no nobg on disk now answers 200 with the original instead of a 302 to it, so one request instead of two. The grid no longer uses this route anyway.
- Every `/file/**` response now has `content-type: image/webp` and `cache-control: public, max-age=31536000, immutable`.

### Response headers observed (`remeasure-headers.txt`, all with `Accept-Encoding: gzip`)

```
== /file/thumb/<uuid>.webp?v=1  (the grid image)
HTTP/1.1 200 OK
cache-control: public, max-age=31536000, immutable
content-type: image/webp
x-content-type-options: nosniff          (no content-encoding: images bypass compress)
== /file/nobg/<name>.webp, /file/<name>.webp
same three headers as above
== /bundle.css (and /bundle.css?v=0.5.1+e6a5ca3)
Cache-Control: public, max-age=31536000, immutable
etag: W/"1f181-1a0d9f7740a"   last-modified   content-type: text/css; charset=utf-8   content-encoding: gzip   vary: accept-encoding
== /sw.js
Cache-Control: no-cache
etag, last-modified, content-type: application/javascript; charset=utf-8, content-encoding: gzip
== /modules/htmx.min.js (and ?v=0.5.1+e6a5ca3)
cache-control: public, max-age=31536000, immutable
etag, last-modified, content-type: application/javascript; charset=utf-8, content-encoding: gzip
== /manifest.json
cache-control: no-cache   content-type: application/manifest+json; charset=utf-8
== /wardrobe
vary: HX-Request, HX-Boosted, HX-History-Restore-Request, accept-encoding
content-type: text/html; charset=utf-8   content-encoding: gzip   (no cache-control)
```

## 3. Load tests

### Repo load test (`LOAD_TEST_DURATION=10 npm run test:load`, `remeasure-loadtest.log`)

The script has no base URL override: it rebuilds, spawns its own `dist/main.js` on port 3000 with `NODE_ENV=production AUTH_ENABLED=false`, and now seeds one garment with a photo and hits four real targets (10 connections, 10 s each). The baseline version hit `GET /` (a 302). The two runs therefore measure different things; the baseline row is kept for the record only. It ran with `DATA_PATH=<scratch>/remeasure-loadtest-data`, and `scripts/results/load-test-results.json` is gitignored.

| target (1 garment seeded) | req/s | latency avg ms | p50 ms | p99 ms | MB/s | non-2xx |
|---|---|---|---|---|---|---|
| wardrobe (GET /wardrobe) | 1,177.30 | 7.94 | 7 | 16 | 21.66 | 0 |
| wardrobe-fragment (HX-Request: true) | 1,358.55 | 6.82 | 6 | 13 | 14.02 | 0 |
| outfits-new (GET /outfits/new) | 1,527.91 | 6.07 | 5 | 12 | 27.33 | 0 |
| thumb (GET /file/thumb/<uuid>.webp?v=1) | 5,332.55 | 1.30 | 1 | 6 | 5.07 | 0 |
| baseline: GET / (302 redirect) | 13,897.82 | 0.10 | 0 | 4 | 8.59 | 0 |

### Autocannon against the seeded pages on port 3100 (10 connections, 10 s, `remeasure-autocannon-3100.log`)

| URL | req/s | latency avg ms | p50 ms | p99 ms | MB/s | errors |
|---|---|---|---|---|---|---|
| /wardrobe | 149.81 | 66.05 | 59 | 129 | 15.84 | 0 |
| /outfits/new | 180.90 | 54.66 | 49 | 108 | 8.97 | 0 |
| /calendar | 295.61 | 33.25 | 30 | 65 | 11.89 | 0 |

## 4. SQL statements per page (MikroORM debug on port 3101, `remeasure-queries.md`, `remeasure-q-*.log`)

Method as baseline: warm each page once, record the log line count, make one request, count `[query]` lines appended.

| page | SQL statements | queries (rows, time) |
|---|---|---|
| GET /wardrobe | 4 | `select distinct brand` (6 rows, 1 ms), `select distinct size` (6 rows, 1 ms), `select distinct category` (8 rows, 2 ms) for the filters; `garment` left join `file` (150 rows, 1 ms) for the grid |
| GET /wardrobe?keyword=blue&category=tops | 4 | same three distinct queries; filtered join query (0 rows, 0 ms) |
| GET /wardrobe/1 | 1 | `garment` joined to `file` and outfits (2 rows, 0 ms) |
| GET /outfits | 1 | `outfit` joined to garments (79 rows, 1 ms) |
| GET /outfits/1 | 1 | `outfit` join (3 rows, 1 ms) |
| GET /outfits/new | 1 | `garment` left join `file` (150 rows, 2 ms) |
| GET /calendar | 2 | `outfit` id+name only (20 rows, 2 ms); `outfit_calendar` join outfit + garments + files (28 rows, 1 ms) |
| GET /modules/htmx.min.js | 0 | static path, session hook skipped |
| GET /file/thumb/<uuid>.webp?v=1 | 0 | filesystem only |

No N+1. `findAvailableFilters` no longer loads all 150 garment rows; it runs three `SELECT DISTINCT` statements instead (statement count went 2 -> 4 on `/wardrobe`, rows read went 300 -> 170). The calendar's outfit list now selects `id, name` only instead of the full join (79 -> 20 rows).

## 5. /wardrobe page composition with 150 garments (`remeasure-wardrobe.html`)

| item | count |
|---|---|
| HTML bytes (uncompressed / gzip) | 110,143 / 10,805 |
| `<img>` tags | 150 (all `src="/file/thumb/<uuid>.webp?v=1"`, 150 unique, `width="400" height="400" decoding="async"`) |
| `<img loading="lazy">` | 142 (the first 8 tiles are eager) |
| `<script>` tags | 6 (4 external: htmx.min.js, _hyperscript.min.js, /js/color-multiselect.js, /js/connectivity.js, all `?v=0.5.1+e6a5ca3`; 2 inline) |
| `<link>` tags | 6 (canonical, icon, apple-touch-icon, manifest, stylesheet bundle.css?v=..., preconnect cloudflareinsights); the `preload bundle.css` is gone |
| CSS `url()` in HTML | 0 |

Grid payload, fetched once per distinct URL (`remeasure-grid-bytes.txt`): 150 images, all 200 `image/webp`, min 3,578 bytes, max 27,830 bytes, **total 1,331,982 bytes (1.27 MiB)** for one full grid render, identical with or without `Accept-Encoding: gzip`. Every tile is `public, max-age=31536000, immutable`, so a revisit makes zero image requests, and the service worker's `images-v1` CacheFirst route can hold them. Only 8 of the 150 images load eagerly on first paint.

The baseline grid was 150 x `/file/nobg/<name>` at `no-store`, 120 x 18.7 KB + 30 x (302 + 879 KB) = about 28.6 MB, 150 to 300 requests, no lazy loading.

## 6. Teardown

Both servers were stopped; `remeasure-data` and `remeasure-loadtest-data` were deleted. `git status` shows only the pre-existing untracked `.claude/`; `scripts/results/load-test-results.json` is gitignored.

## 7. BEFORE vs AFTER (baseline numbers verbatim from `audit-measure.md`)

### Seed / upload

| metric | before | after | delta |
|---|---|---|---|
| POST /wardrobe p50 / p95 ms | 1.7 / 3.3 | 1.8 / 3.0 | flat |
| POST photo + nobgPhoto p50 / p95 ms | 201.1 / 217.7 | 215.2 / 226.3 | +14 ms (thumb + nobg re-encode) |
| POST photo only p50 / p95 ms | 199.4 / 214.6 | 217.3 / 232.0 | +18 ms |
| POST /outfits p50 / p95 ms | 2.4 / 7.1 | 2.4 / 8.8 | flat |
| POST /calendar p50 / p95 ms | 2.0 / 2.5 | 1.7 / 2.4 | flat |
| stored original WebP bytes (noisy photo) | 890,052 | 548,108 avg | -38% |
| stored nobg bytes | 18,732 (as uploaded) | 14,526 avg | -22% |
| thumb variant | none | 8,879 avg | new |
| data dir for 150 garments | 122 MB | 87 MB | -29% |

### Page latency (TTFB p50 / p95 ms, body bytes)

| request | before | after | delta |
|---|---|---|---|
| GET /wardrobe | 11.0 / 15.8, 98,473 B | 8.7 / 12.6, 110,143 B | -21% TTFB, +12% HTML |
| GET /wardrobe, gzip | 11.1 / 13.6, 10,001 B | 9.2 / 12.3, 10,805 B | -17% TTFB |
| GET /wardrobe, HX-Request: true | 10.1 / 10.6, 98,473 B (full page) | 7.6 / 9.0, 101,665 B (fragment) | -25% TTFB, real fragment now |
| GET /wardrobe?keyword=blue&category=tops | 5.3 / 6.1, 20,129 B | 2.9 / 3.3, 22,738 B | -45% TTFB |
| GET /wardrobe?color=blue | 5.5 / 5.8, 24,635 B | 3.1 / 3.7, 27,751 B | -44% TTFB |
| GET /wardrobe/1 | 2.3 / 2.8, 18,508 B | 2.7 / 3.0, 20,511 B | +0.4 ms |
| GET /outfits | 6.2 / 7.8, 81,761 B | 6.6 / 7.7, 92,146 B | flat, +13% HTML |
| GET /outfits/1 | 2.3 / 2.7, 10,972 B | 2.5 / 2.8, 13,101 B | flat |
| GET /outfits/new | 6.9 / 8.9, 49,181 B | 7.0 / 7.4, 51,304 B | flat |
| GET /outfits/new, gzip | 7.4 / 9.6, 5,981 B | 7.6 / 10.3, 6,647 B | flat |
| GET /calendar | 9.0 / 10.5, 37,821 B | 5.4 / 6.3, 41,494 B | -40% TTFB |
| grid image (before: /file/nobg, nobg present; after: /file/thumb) | 0.9 / 1.1, 18,732 B, no-store | 1.1 / 1.3, 5,424 B, immutable | -71% bytes, cacheable |
| grid image, no nobg (before: 302 + /file/<name>; after: /file/thumb) | 0.9 + 1.1 TTFB, 2 requests, 878,682 B | 1.1 / 1.2, 1 request, 25,876 B | -97% bytes |
| GET /file/<name>.webp, gzip (total p50 / p95) | 17.6 / 22.8 ms, 878,970 B | 2.0 / 2.4 ms, 574,482 B | -89% total time, no gzip |
| GET /bundle.css | 1.1 / 1.3, 125,081 B | 1.1 / 1.4, 127,361 B | flat |
| GET /bundle.css, gzip | 1.9 / 2.6, 20,545 B | 2.3 / 2.6, 20,954 B | flat |
| GET /sw.js | 1.1 / 1.3, 127,703 B | 1.0 / 1.3, 130,682 B | flat |
| GET /modules/htmx.min.js | 1.1 / 1.2, 51,238 B | 1.0 / 1.2, 51,238 B | flat |

### Cache headers

| asset | before | after |
|---|---|---|
| grid image | `no-store`, 302 for missing nobg | `public, max-age=31536000, immutable`, always 200 |
| /file/<name>.webp | immutable, **no content-type**, gzipped on the fly | immutable, `image/webp`, not compressed |
| /file/nobg/<name>.webp | `no-store` | immutable, `image/webp` |
| /bundle.css | `public, max-age=0` | `public, max-age=31536000, immutable` (versioned `?v=`) |
| /modules/htmx.min.js | `public, max-age=0` | `public, max-age=31536000, immutable` (versioned `?v=`) |
| /sw.js | `public, max-age=0` | `no-cache` |
| /wardrobe | no cache-control, no Vary | no cache-control, `Vary: HX-Request, HX-Boosted, HX-History-Restore-Request, accept-encoding` |

### Load (10 connections, 10 s)

| URL | before req/s (p50 / p99 ms) | after req/s (p50 / p99 ms) | delta req/s |
|---|---|---|---|
| /wardrobe (150 garments, port 3100) | 114.7 (79 / 171) | 149.81 (59 / 129) | +31% |
| /outfits/new (port 3100) | 184.7 (48 / 105) | 180.90 (49 / 108) | -2% (noise) |
| /calendar (port 3100) | 148.2 (63 / 130) | 295.61 (30 / 65) | +99% |
| repo `test:load` | 13,897.82 (0 / 4) on `GET /` 302 | 1,177.30 (7 / 16) on /wardrobe with 1 garment, plus 3 more targets | not comparable, script changed |

### SQL statements per page

| page | before | after |
|---|---|---|
| GET /wardrobe | 2 (150 + 150 rows) | 4 (6 + 6 + 8 + 150 rows) |
| GET /wardrobe?keyword=blue&category=tops | 2 (150 + 0 rows) | 4 (6 + 6 + 8 + 0 rows) |
| GET /wardrobe/1 | 1 | 1 |
| GET /outfits | 1 | 1 |
| GET /outfits/1 | 1 | 1 |
| GET /outfits/new | 1 | 1 |
| GET /calendar | 2 (79 + 28 rows) | 2 (20 + 28 rows) |
| grid image | 0 | 0 |
| GET /modules/htmx.min.js | not measured | 0 |

### /wardrobe grid payload (150 garments)

| metric | before | after |
|---|---|---|
| HTML bytes (plain / gzip) | 98,473 / 10,001 | 110,143 / 10,805 |
| `<img>` tags | 150 | 150 |
| `<img loading="lazy">` | 0 | 142 |
| width/height on tiles | none | 400x400, `decoding="async"` |
| `<script>` tags | 7 | 6 |
| `<link>` tags | 7 | 6 |
| image requests per grid render | 150 to 300 (302 + file for missing nobg) | 150, and 0 on a warm cache (immutable) |
| total image bytes per grid render | about 28.6 MB (120 x 18.7 KB + 30 x 879 KB) | 1,331,982 B (1.27 MiB), min 3,578, max 27,830 |
| images eager on first paint | 150 | 8 |
