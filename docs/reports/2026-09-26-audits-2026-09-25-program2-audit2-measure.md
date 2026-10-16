# Closet performance baseline 2: Postgres, auth, mobile, boot, upload (2026-09-25)

This pass covers what `docs/audits/2026-09-25/audit-measure.md` and `audit-remeasure.md` left out. Those measured loopback SQLite with auth off.

| item | value |
|---|---|
| Code | `HEAD` = `6a5e64f`, git worktree at `<scratch>/wt-measure`, `npm ci` + `npm run build` (both exit 0). The repo was not touched. |
| Box | Linux, 16 cores, Node v24.16.0 (the Docker image runs Node 22 on `node:22-slim`) |
| Postgres | `postgres:17` in Docker, `shared_buffers=256MB`, published on `127.0.0.1:55432`. Local and throwaway; the production database was never touched. |
| Added DB latency | `tc qdisc add dev eth0 root netem delay 1ms` inside the Postgres container (container started with `--cap-add NET_ADMIN`, `iproute2` installed in the container, so no host root was needed). Measured `SELECT 1` round trip from Node: **p50 1.20 ms, p95 1.39 ms** with netem, which confirms the 1 ms. |
| App env (all runs) | `NODE_ENV=production AUTH_ENABLED=true PWA_ENABLED=true` + generated VAPID keys, `SITE_URL=https://localhost:<port>` (the VAPID subject must be https or mailto, otherwise boot fails), `ACCESS_TOKEN_SECRET=perfperfperf`, local file storage, `DATA_PATH=<scratch>/data-*` |
| Postgres env | `DATABASE_TYPE=postgres DATABASE_HOST=127.0.0.1 DATABASE_PORT=55432 DATABASE_USER=postgres DATABASE_PASS=Password123 DATABASE_SCHEMA=closet_150` (or `closet_1500`) |
| SQLite env | `DATABASE_TYPE=sqlite` (default `DATA_PATH/sqlite3.db`) |
| Auth | Every request carries the `access_token` cookie from `POST /auth/register` (seed script). The auth path (JWT verify + `user` row lookup) is in every number below. |

Scripts (all in the scratchpad): `seed.mjs`, `measure.sh`, `sqlcount-pg.sh`, `boot.mjs`, `load1000.mjs`, `profhook.cjs`, `profsum.py`, `lhsum.py`, `lhdetail.py`, `pw.mjs`, `mk12mp.mjs`, `upload12.mjs`, `uploadpaced.mjs`, `sharpphases.mjs`, `uptest.mjs`. Raw outputs: `t-*.md`, `sql-*.md`, `pglog-*.txt`, `seed-*.log`, `lh/*.json`, `pw-pg150.md`, `boot-*.txt`, `prof-pg1500gc-{1,2,3}.cpuprofile`, `bootprof/*.cpuprofile`, `upload12.md`, `uploadpaced.md`, `sharpphases.md`, `server-*.log`.

---

## 0. Headline and worst offenders

1. **Correctness bug: a photo uploaded together with its client cutout returns 500 (details in section 8).** With a client-shaped payload (a 12 MP JPEG plus a 4032x4032 cutout WebP), `POST /wardrobe/:id/photo` failed on **every** attempt: 11/11 on loopback, and 3/3 each with the upload paced at 5, 20 and 100 Mbps. The photo alone succeeds. In `FileService.writeThumb` the photo pipeline's thumb step checks `getIfExists(<name>-nobg.webp)`. That file already exists but is empty or partial, because `LocalFileService.store` opens `fs.createWriteStream` on the final path as soon as the nobg transcode starts. sharp then throws "Input buffer contains unsupported image format", the whole upload is rolled back, and the user gets a 500. The bug came in with `64b126d` (today). It also showed up at lower rates while seeding: 11 of 1,511 uploads with a 1000 px photo and a 1080 px cutout (retried), and 3 of 4 with a 400 px photo.
2. **Page cost grows linearly with wardrobe size, and the ORM is the cost, not SQL or Postgres.** At 1,500 garments the TTFB p50s are `/wardrobe` 60 to 66 ms, `/outfits/new` 54 ms (for a 6.7 KB gzip page that shows 9 images) and `/outfits` 45 ms. At 150 garments the same pages take 8 to 14 ms. Postgres executes every statement in 3.5 ms or less. CPU profiles put **70 to 76% of busy CPU in MikroORM** (`@mikro-orm/core` + `@mikro-orm/knex`, entity hydration and `ensurePropagation`). Handlebars is 0.2 to 3%. Nothing paginates, so `/wardrobe` at 1,500 is 870 KB of HTML with 9,246 DOM nodes.
3. **Postgres latency adds about 1 ms per serial round trip, and every request pays for 2 or 3.** At +1 ms, TTFB at 150 garments rises by 2.1 to 3.9 ms against 0 ms. Every authenticated page makes at least 2 serial round trips: `select user` for auth, then the page query. `/wardrobe` makes 3 (user, then `wardrobe_share`, then 4 queries in parallel). Writes are 4 to 7 statements each, for example `POST /outfits` = user, garments, BEGIN, 3 INSERTs, COMMIT. So on Postgres they are 4 to 6x slower than on SQLite: 8.6 vs 2.2 ms and 13.9 vs 2.2 ms.
4. **Mobile (Moto G, slow 4G, simulated):** `/wardrobe` scores 0.98 (LCP 2.35 s). `/outfits/new` scores 0.81 with **LCP 4.96 s**. The builder loads slot images from `/file/nobg/<name>` at full 1080 px, so a garment without a cutout pulls its 535 KB original into an 80 px slot. Lighthouse estimates 518 KiB and 2.7 s of LCP savings from responsive images. `<pwa-install>` pulls the manifest screenshot and icon (157 KB) on every cold load.
5. **Memory: 235 to 250 MB RSS right after boot. After 1,000 page requests RSS is 612 MB with 150 garments and 867 MB with 1,500.** This is not a leak: the JS heap after a forced GC is 81 MB (150) and 94 MB (1,500), flat across 3,000 requests. The rest is V8 heap pages retained after request churn. `MALLOC_ARENA_MAX=2` changes nothing. `--max-old-space-size=192` caps RSS at 369 MB but makes the 1,000 requests 67% slower.
6. **Boot takes 830 to 880 ms on a warm database and 1.2 to 1.6 s on a fresh one (26 migrations).** About half of it is `require`/compile. `heic-convert` and `@aws-sdk/client-s3` are imported eagerly even with local storage (about 110 ms and 55 MB RSS measured in isolation).
7. **Upload: a 12 MP photo costs 130 ms of server CPU; on a phone the upload itself is the cost.** The server spends about 100 to 125 ms after the last body byte (JPEG decode with shrink-on-load about 28 ms, WebP q90 encode about 60 ms, thumb about 18 ms). On a 5 Mbps uplink the same request takes 2.7 s, 96% of it moving the full-resolution original. The client uploads the untouched original plus a full-resolution cutout, while the server keeps 1080 px. sharp runs with `concurrency 1`: glibc without jemalloc, the same as `node:22-slim` in production.

---

## 1. Seeding through the real endpoints (`seed.mjs`)

```
node seed.mjs BASE N PHOTO_PX OUTFITS CONCURRENCY COOKIEFILE
# 150:   node seed.mjs http://127.0.0.1:3200 150 1600 20 1 cookie-pg150.txt
# 1,500: node seed.mjs http://127.0.0.1:3201 1500 1000 200 4 cookie-pg1500.txt
```

The script registers `perf@example.com` through `POST /auth/register` (falling back to `/auth/login`) and keeps the `access_token` cookie. For each garment it sends `POST /wardrobe` (urlencoded: name, category cycling through the 8 enums, brand from 6, color from 12, size from 6), then `POST /wardrobe/:id/photo` (multipart `photo` = a gaussian-noise JPEG tinted per color, 12 distinct images reused; 80% of garments also get `nobgPhoto` = a 1080 px flat-color WebP with alpha). After the garments come `POST /outfits` (3 to 5 slots via repeated `category` + `garmentId`) and 30 `POST /calendar` entries from today minus 15 days to today plus 14.

- 150 garments used 1600x1600 photos (1.38 MB), as in the previous audit.
- 1,500 garments used 1000x1000 photos (540 KB). The planned 400 px photos hit the section 8 race on 3 of 4 uploads. The script now retries a 500 up to 5 times and counts each one: 0 on the Postgres 1,500 seed, 11 of 1,511 on the SQLite 1,500 seed.
- On-disk data: 96 MB (pg150), 856 MB (pg1500), 87 MB (sq150), 850 MB (sq1500).

### Write path latency (client-side, loopback; Postgres with +1 ms)

| request | SQLite 150 p50 / p95 ms | Postgres 150 +1 ms p50 / p95 ms | SQLite 1,500 (conc 4) | Postgres 1,500 +1 ms (conc 4) |
|---|---|---|---|---|
| POST /wardrobe | 2.2 / 3.3 | **8.6 / 13.3** | 2.4 / 4.5 | 8.2 / 11.8 |
| POST /wardrobe/:id/photo (1600 px JPEG; 1000 px at 1,500) | 207.0 / 223.4 | 225.9 / 300.5 | 268.6 / 352.6 | 268.9 / 394.3 |
| POST /outfits (3 to 5 garments) | 2.2 / 7.8 | **13.9 / 20.3** | 1.9 / 2.9 | 12.6 / 14.0 |
| POST /calendar | 1.5 / 2.0 | **10.3 / 12.8** | 1.2 / 1.9 | 9.0 / 12.1 |

### SQL statements per write (Postgres `log_statement=all`)

| request | statements | sequence |
|---|---|---|
| POST /wardrobe | 4 | select user; BEGIN; insert garment; COMMIT |
| POST /outfits (3 garments) | 7 | select user; select garments where id in (...); BEGIN; insert outfit; insert outfit_garments x2 (one per batch, 2 statements for 3 rows); COMMIT |
| POST /calendar | 5 | select user; select outfit; BEGIN; insert outfit_calendar; COMMIT |
| POST /wardrobe/:id/photo (photo only) | 7 | select user; BEGIN; select garment+file; insert file; update garment; delete old file; COMMIT |

Every statement is a serial round trip. On Postgres the write cost is roughly the statement count times the RTT, plus the server-side commit.

---

## 2. Page TTFB, authenticated, gzip (`measure.sh`)

```
measure.sh BASE COOKIEFILE LABEL GID [REPS=30]
curl -s -o /dev/null -H "Cookie: access_token=..." -H "Accept-Encoding: gzip" [-H "HX-Request: true"] \
     -w "%{time_starttransfer} %{time_total} %{size_download} %{http_code}\n" URL      # 1 warm-up + 30 timed
```

Netem was switched with `docker exec -u root closet-perf-pg tc qdisc del dev eth0 root` / `... add ... netem delay 1ms`. `log_statement` was `none` during all timing runs. The garment is id 1.

### 150 garments, 20 outfits, 30 calendar entries (TTFB p50 / p95 ms)

| request | SQLite | Postgres 0 ms | Postgres +1 ms | +1 ms delta vs pg 0 ms | gzip bytes |
|---|---|---|---|---|---|
| GET /wardrobe | 12.3 / 15.6 | 10.2 / 13.5 | **14.1 / 16.5** | +3.9 | 10,640 |
| GET /wardrobe (HX-Request fragment) | 10.9 / 16.9 | 9.3 / 11.8 | 13.3 / 16.6 | +4.0 | 7,651 |
| GET /wardrobe/1 | 3.7 / 4.0 | 3.8 / 5.1 | 6.2 / 7.1 | +2.4 | 6,295 |
| GET /outfits | 8.1 / 11.0 | 8.0 / 11.0 | 10.9 / 13.5 | +2.9 | 7,267 |
| GET /outfits/new | 8.5 / 10.3 | 8.9 / 12.9 | 11.2 / 13.4 | +2.3 | 6,671 |
| GET /calendar | 6.8 / 8.6 | 7.0 / 10.0 | 9.1 / 10.9 | +2.1 | 5,724 |

### 1,500 garments, 200 outfits, 30 calendar entries (TTFB p50 / p95 ms)

| request | SQLite | Postgres 0 ms | Postgres +1 ms | gzip bytes | uncompressed bytes |
|---|---|---|---|---|---|
| GET /wardrobe | 66.4 / 76.1 | 59.7 / 69.8 | **62.9 / 71.9** | 56,647 | 870,566 |
| GET /wardrobe (HX) | 68.0 / 76.2 | 57.6 / 70.9 | 60.2 / 68.4 | 53,231 | ~815,000 |
| GET /wardrobe/1 | 3.4 / 3.7 | 4.2 / 5.2 | 6.4 / 7.2 | 6,295 | |
| GET /outfits | 47.0 / 51.2 | 45.9 / 50.0 | **45.1 / 48.8** | 34,425 | 816,053 |
| GET /outfits/new | 55.1 / 58.8 | 54.6 / 59.2 | **53.6 / 57.4** | 6,680 | 51,421 |
| GET /calendar | 7.4 / 9.5 | 7.5 / 10.6 | 10.1 / 13.3 | 5,726 | |

Reading the numbers:
- At 150 garments, Postgres at 0 ms is on par with SQLite. The +1 ms cost is 2 to 4 ms per page, which matches the serial round-trip depth in section 3 (2 for most pages, 3 for `/wardrobe`). The extra ms beyond one per round trip comes from netem delaying every packet of multi-segment result sets.
- At 1,500 garments the driver stops mattering: SQLite and Postgres are within noise of each other, and the time is Node-side (section 4). `/outfits/new` costs 54 ms to render a 6.7 KB page: it hydrates all 1,500 garments with their files to fill 8 category rows. `/outfits` renders every outfit with all its garments (816 KB of HTML for 200 outfits).
- The HX fragment for `/wardrobe` saves 2 to 3 ms, because the grid is the whole page.
- Production is pgvault on the same NAS over the Docker network, so its RTT is probably well under 1 ms. Treat the +1 ms column as a pessimistic bound. Per page the cost is about (serial round trips x RTT): `/wardrobe` 3 x RTT, other GETs 2 x RTT, writes 4 to 7 x RTT.

---

## 3. SQL statements per request (identical on both drivers)

Postgres: one request after a warm-up, counting `LOG:  statement|execute` lines in `docker logs` (`sqlcount-pg.sh`, full statements in `pglog-*.txt`). SQLite: a second instance with `NODE_ENV=development` (MikroORM `debug` on), counting `[query]` lines.

| request | statements | serial round trips | statements |
|---|---|---|---|
| GET /wardrobe | 6 | **3** | user by id; wardrobe_share join user x2 (grantee = me); then in parallel on 4 connections: distinct brand, distinct size, distinct category, garment left join file |
| GET /wardrobe (HX) | 6 | 3 | same |
| GET /wardrobe/:id | 2 | 2 | user; garment join file + outfits |
| GET /outfits | 2 | 2 | user; outfit join garments join files |
| GET /outfits/new | 2 | 2 | user; garment left join file (all garments) |
| GET /calendar | 3 | 2 | user; then in parallel: outfit id+name; outfit_calendar join outfit + garments + files |

Compared with `audit-remeasure.md` (auth off), auth adds 1 statement per request (`select "u0".* from "user" where id = ? limit 1`, from `AuthContextService`), and `/wardrobe` adds the `wardrobe_share` lookup. The counts do not change with data size: there is no N+1. At 1,500 garments Postgres executes each statement in 0.2 to 3.5 ms (`log_min_duration_statement=0`: the grid query takes 2.0 ms, the `/outfits` join 3.5 ms, the `/outfits/new` query 2.7 ms).

---

## 4. Where the 1,500-garment time goes (V8 CPU profile)

`profhook.cjs` is preloaded with `node -r profhook.cjs dist/main`. `SIGUSR2` starts and stops `Profiler` (200 us sampling) through `inspector`. Each profile covers 100 sequential gzip requests to one URL (`prof-pg1500gc-{1,2,3}.cpuprofile`, summarised by `profsum.py`).

| page (100 requests) | busy ms per request | MikroORM (core + knex) | GC | node core (zlib, streams) | pg driver | Handlebars | app code |
|---|---|---|---|---|---|---|---|
| /outfits/new | ~49 | **55.5%** (45.6 + 9.9) of all samples = 69% of busy | 5.8% | 3.7% | 2.7% | 0.2% | 0.6% |
| /wardrobe | ~58 | **48.5%** (39.4 + 9.1) = 60% of busy | 5.4% | 6.2% | 2.4% | 3.0% | 0.9% |
| /outfits | ~43 | **45.8%** (31.5 + 14.3) = 60% of busy | 4.8% | 5.5% | 3.7% | 1.2% | 0.7% |

Top self-time functions are the same on every page: `ensurePropagation` (@mikro-orm/core, 7.5 to 11.3% of all samples), `EntityFactory.create`, `register` (identity map), `mapJoinedProps` (knex joined-strategy row mapping), and compiled hydrator functions (they appear as anonymous frames with no URL). Rendering and SQL are not the bottleneck. Hydrating around 3,000 managed entities per request (1,500 garments + 1,500 files) is.

---

## 5. Mobile lab metrics

### Lighthouse 12.6.1, mobile preset (simulated Moto G Power, slow 4G: 150 ms RTT, 1.6 Mbps, 4x CPU), performance category, authenticated, Postgres +1 ms, 150 garments

```
CHROME_PATH=~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome \
node node_modules/.bin/lighthouse "http://localhost:3200/wardrobe" --quiet \
  --chrome-flags="--headless=new --no-sandbox" --extra-headers='{"Cookie":"access_token=..."}' \
  --only-categories=performance --output=json --output-path=lh/wardrobe-N.json      # 3 runs per URL
```

| page (median of 3) | score | FCP ms | LCP ms | TBT ms | SI ms | CLS | total bytes | requests | LCP element |
|---|---|---|---|---|---|---|---|---|---|
| /wardrobe (150) | 0.98 | 1,492 | 2,350 | 26 | 1,492 | 0 | 489,600 | 50 | first grid thumb |
| /outfits/new (150) | **0.81** | 1,504 | **4,956** | 28 | 1,504 | 0 | **898,935** | 30 | the H1 (render delay 4.5 s; see below) |
| /wardrobe (1,500, 1 run) | 0.94 | 1,634 | 2,646 | 177 | 1,634 | 0 | 639,469 | 50 | first grid thumb; DOM 9,246 elements |
| /outfits (1,500, 1 run) | 0.94 | 1,582 | 2,714 | 141 | 1,582 | 0 | 1,133,261 | 103 | DOM 4,125 elements |

Run-to-run spread was small: FCP 1,430 to 1,516, LCP 2,339 to 2,587 (/wardrobe); LCP 4,883 to 4,958 (/outfits/new).

Top opportunities:

| page | audit | estimated saving |
|---|---|---|
| /outfits/new | uses-responsive-images / image-delivery-insight | **518 to 671 KiB, LCP -2.7 s**: one `/file/nobg/<uuid>.webp` is 535,136 B, the 1080 px original served as the fallback for a garment with no cutout, shown in a small slot |
| /outfits/new | unused-javascript | 57 KiB (`sortable.esm.js`, `_hyperscript`, `pwa-install.bundle.js`) |
| /outfits/new | unminified-javascript | 10 KiB |
| both | render-blocking-insight | FCP -150 ms (`bundle.css`) |
| /wardrobe | image-delivery-insight | 267 KiB (400 px q80 thumbs shown at 160 CSS px) |
| /wardrobe | uses-responsive-images | 71 KiB |
| /wardrobe | unused-javascript | 32 KiB |
| /wardrobe | dom-size | 1,146 elements at 150 garments, **9,246 at 1,500** (TBT 26 -> 177 ms) |
| both | cold-load extras | `<pwa-install>` (in `layout.hbs`) fetches `/manifest.json` twice, `/assets/icon.png` 45,605 B and `/assets/screenshots/Screenshot_mobile_1.webp` 111,614 B on every cold page load |

The unthrottled trace of `/outfits/new` paints the H1 at 101 to 161 ms. The 4.96 s is Lantern's simulation: every request started before that paint is in the LCP dependency graph, including the 535 KB image, and at 1.6 Mbps that image alone takes about 2.7 s. The page will not literally show a blank header for 5 s on a phone. It will spend about 3 s of a slow-4G link on one image the slot shows at a few percent of its pixels. In this seed only 1 of the 8 slot images lacked a cutout. The other 7 were 3 KB synthetic flat-color cutouts, while real 1080 px cutouts are tens to hundreds of KB, so real byte counts will be higher.

### Playwright + CDP throttling (cross-check)

`pw.mjs` uses a 412x823 mobile context at DPR 1.75, `Emulation.setCPUThrottlingRate 4` and `Network.emulateNetworkConditions` (150 ms latency, 1.6 Mbps down, 750 Kbps up). Values are the median of 3 runs. "Warm" is a reload after one unthrottled visit (service worker installed, HTTP cache primed).

| page (150) | mode | FCP ms | LCP ms | DCL ms | load ms | requests | transferred bytes |
|---|---|---|---|---|---|---|---|
| /wardrobe | cold | 928 | 928 | 1,625 | 1,674 | 33 | 241,665 |
| /wardrobe | warm | 264 | 264 | 468 | 495 | 33 | 108,638 |
| /outfits/new | cold | 932 | 932 | 1,807 | **4,282** | 26 | **775,476** |
| /outfits/new | warm | 92 | 92 | 279 | 292 | 26 | 53,530 |
| /outfits | cold | 828 | 1,040 | 1,641 | 1,881 | 60 | 427,323 |
| /outfits | warm | 80 | 160 | 286 | 303 | 60 | 92,102 |
| /calendar | cold | 848 | 848 | 1,594 | 1,637 | 45 | 301,698 |
| /calendar | warm | 76 | 76 | 184 | 198 | 45 | 44,145 |

The cold `/outfits/new` load event lands at 4.3 s, which confirms the builder's image weight under real devtools throttling. Navigation-timing TTFB under CDP throttling does not include the emulated latency, so it is left out.

---

## 6. Boot and memory

```
node boot.mjs PORT LOG [node flags]   # spawns `node dist/main`, polls GET /healthz every 10 ms, reports ms to first response and VmRSS
```

| scenario | boot to first HTTP response (ms) | RSS after boot (MB) |
|---|---|---|
| Postgres +1 ms, fresh database (26 migrations) | 1,468 (150 db), 1,604 and 1,228 (1,500 db, two fresh creates) | 243 to 253 |
| Postgres +1 ms, migrated database, 5 boots | 1,152, 858, 848, 868, 876 (median **868**) | 235 to 253 |
| SQLite, migrated, 5 boots | 828, 836, 832, 837, 833 (median **833**) | 238 to 241 |

Boot CPU profile (`--cpu-prof`, SQLite): 911 ms sampled, of which 50.6% is node core module loading (`wrapSafe` compile 25.6%, `readFileUtf8`, `internalModuleStat`). Nest DI is about 3% and MikroORM init about 2%. Measured in isolation (`require()` time / RSS delta): `@mikro-orm/postgresql` 139 ms / 38 MB, `@nestjs/core` 109 ms / 34 MB, `@aws-sdk/client-s3` 65 ms / 28 MB, `heic-convert` 46 ms / 28 MB, `sharp` 30 ms / 24 MB. `heic-convert` (`src/file/heic.ts`) and the S3 SDK (`nestjs-s3` in `file.module.ts`) load on every boot, even with `FILE_STORAGE_TYPE=local` and no HEIC upload.

### RSS after 1,000 requests

`load1000.mjs`: 1,000 requests, concurrency 4, round-robin over the 6 measured requests, gzip, authenticated. The heap was read through `process.memoryUsage()` after a forced `gc()` (`--expose-gc`, `SIGHUP` handler in `profhook.cjs`).

| run | RSS after boot | RSS after 1,000 | peak (VmHWM) | heapUsed after GC | heapTotal | wall for 1,000 |
|---|---|---|---|---|---|---|
| Postgres 150 | 253 | **612** | 616 | 80.8 | 315.6 | 5.9 s |
| Postgres 150 (repeat) | 255 | 614 | 635 | 80.8 | 253.9 | 5.9 s |
| Postgres 1,500 | 236 | **867** | 921 | 95.3 | 238.0 | 33.8 s |
| Postgres 1,500, `MALLOC_ARENA_MAX=2` | 234 | 873 | 928 | 95.3 | 255.5 | 33.7 s |
| Postgres 1,500, 3 x 1,000 in one process | 241 | 864 -> 870 -> 863 | 950 | 95.2 -> 93.6 -> 93.6 | 404 -> 282 -> 333 | ~34 s each |
| Postgres 150, no gzip | 251 | 632 | 657 | 79.2 | 229.4 | 5.9 s |
| Postgres 150, `LOG_LEVEL=warn` | 234 | 627 | 639 | 80.4 | 318.1 | 6.0 s |
| Postgres 150, `--max-old-space-size=192` | | **369** | | | | **10.0 s** |
| Postgres 150, `--max-semi-space-size=4` | | 519 | | | | 6.3 s |

What the memory is, from `/proc/<pid>/smaps` after 1,000 requests at 150 garments (601 MB RSS): 451 MB in anonymous mappings of 1 MB or less (V8 heap pages), 60 MB node binary text, 41 MB mid-size anonymous regions, 26 MB `[heap]` (malloc), 6 MB libvips. The live JS heap is about 81 MB. V8 grows its heap under per-request allocation churn and keeps the pages. It is not a leak (flat over 3,000 requests), and it is not malloc fragmentation, gzip or logging (each ruled out above). The throughput cost of capping it is real: 5.9 s becomes 10.0 s for 1,000 requests. At 1,500 garments, 1,000 mixed requests take 34 s at concurrency 4, about 29 req/s for one Node process.

---

## 7. Upload: 12 MP JPEG through `POST /wardrobe/:id/photo`

The 12 MP JPEG comes from `mk12mp.mjs`: 4032x3024, smooth texture plus fine grain, 1,621,344 B. The cutout matches what `background-removal.js` + `mask-editor.js` send: the photo square-padded to 4032x4032, alpha, WebP, 266,654 B. Postgres 150 server, garment 2.

### Loopback (`upload12.mjs`: 1 warm-up + 10 sequential; server CPU = utime+stime delta of the server process across all threads from `/proc/<pid>/stat`)

| request | n | wall p50 ms | wall p95 ms | server CPU p50 ms | peak RSS during run MB | status |
|---|---|---|---|---|---|---|
| photo 12 MP only | 10 | **130** | 136 | 130 | 439 | 201 |
| photo 12 MP + nobg 4032² | 10 | 162 | 179 | 290 | 587 | **500 on 11/11** |

### Paced uplink (`uploadpaced.mjs`: the multipart body written in 16 KB chunks at the given rate; "post-body" = last byte sent -> response end)

| uplink | payload | body bytes | total ms (median of 3) | post-body server ms | statuses |
|---|---|---|---|---|---|
| 5 Mbps (typical LTE uplink) | photo only | 1,621,519 | **2,693** | 98 | 201,201,201 |
| 5 Mbps | photo + nobg | 1,888,311 | 3,165 | 126 | **500,500,500** |
| 20 Mbps | photo only | 1,621,519 | 768 | 119 | 201 x3 |
| 20 Mbps | photo + nobg | 1,888,311 | 906 | 147 | **500 x3** |
| 100 Mbps (Wi-Fi) | photo only | 1,621,519 | 254 | 124 | 201 x3 |
| 100 Mbps | photo + nobg | 1,888,311 | 302 | 151 | **500 x3** |

### Where the server time goes (`sharpphases.mjs`: FileService's exact sharp pipelines on the same inputs, median of 10)

| phase | median ms | p90 ms | output bytes |
|---|---|---|---|
| photo: decode 12 MP JPEG + autoOrient + resize 1080 + WebP q90 | **88** | 89 | 84,412 |
| thumb from the stored 1080 WebP (400 px, q80) | 18 | 18 | 9,696 |
| nobg: decode 4032² WebP + resize 1080 + WebP q90 | **147** | 159 | 50,654 |
| thumb from the stored nobg | 22 | 24 | 7,264 |
| decode only, 12 MP JPEG to raw (full size) | 41 | 43 | 36.6 MB |
| decode with shrink-on-load to 1080 raw | 28 | 29 | 2.6 MB |
| shrink-on-load decode + WebP q90 encode of 1080x810 | 88 | 92 | 84,412 |

Photo-only server time is about 88 ms of transcode (about 28 ms decode/resize, **about 60 ms WebP q90 encode**) plus 18 ms thumb plus 7 SQL statements. That is the 98 to 130 ms measured end to end. The V8 main thread is mostly idle during uploads: sharp runs on the libuv threadpool. `sharp.concurrency()` is **1** here, because sharp defaults libvips to 1 thread on glibc without jemalloc, and production's `node:22-slim` is glibc too. When the cutout is present, the 4032² WebP decode (147 ms) is the longest single step.

For a phone, the transfer is the cost: at 5 Mbps, 2.6 of the 2.7 s is moving the 1.6 MB original (real phone JPEGs are often 3 to 5 MB, so 5 to 8 s), and the full-resolution cutout adds 0.4 s or more. The server throws away everything above 1080 px. Downscaling on the client to about 1600 px before upload would cut upload bytes by roughly 5 to 10x and also shorten the client-side background-removal input.

### The upload race (the 500s above)

`GarmentService.storeUploadedPhotoWithCutout` starts the photo and nobg pipelines concurrently. When the photo pipeline finishes, `FileService.storeImageFromFileUpload` calls `regenerateThumb` -> `writeThumb`, which prefers `getIfExists('<uuid>-nobg.webp')`. `LocalFileService.store` writes with `pipeline(stream, fs.createWriteStream(finalPath))`, and `transcode` calls `store()` before any byte is produced, so the nobg file exists (empty or partial) from the moment the nobg part starts until it finishes. `getIfExists` only checks `R_OK`, so `writeThumb` feeds a truncated file to sharp, which fails with `UnreadableImageError`. `Promise.allSettled` then deletes the variants and the request answers 500.

Stack in `server-pg150.log`: `storeImageFromFileUpload (file-service.abstract.js:73)` -> `writeThumb (:238)` -> `transcode (:260)` -> sharp "Input buffer contains unsupported image format". It appeared 11 times, once per failed upload.

Observed failure rates: 100% with client-shaped payloads at every uplink speed tested. 3 of 4 with a 400 px photo and a 1080 px cutout. 11 of 1,511 with a 1000 px photo and a 1080 px cutout at concurrency 4. 0 of 150 with a 1600 px photo and a 1080 px cutout, the previous audit's shape: a large photo finishes after the tiny cutout, which is why neither earlier audit saw it. `test/integration/mask-edit.spec.ts` covers `nobgPhoto` but evidently not a cutout that is still being written when the photo finishes.

Production has run this code since `64b126d`. Check the production `app.log` for `Unreadable image` warnings on `/wardrobe/*/photo`.

---

## 8. What could not be measured here

- **The production network path** (phone -> Caddy -> container, TLS, HTTP/2) was not measured. Lighthouse and Playwright ran over plain HTTP/1.1 to localhost, with throttling simulated or emulated. TLS handshakes and HTTP/2 multiplexing change the cold-load numbers.
- **The real pgvault RTT** is unknown from this box, and the production database was not touched by design. The +1 ms figures are an upper-bound model: use (serial round trips x RTT) from section 3 to rescale.
- **Real photo content.** The images are synthetic. Real 1080 px cutouts and originals compress differently: the cutouts here were 3 KB flat color (real ones will be much larger), and the 1,500 seed used 1000 px originals. This affects image bytes in section 5, not the server timings.
- **Client-side background removal** (`@imgly/background-removal`, WASM/ONNX in the browser) was not run. The cutout was synthesised with the same dimensions and format the client produces.
- **Device CPU.** Lighthouse's Moto G profile and the CDP 4x CPU slowdown approximate a mid-range phone; no real device was used.
- **HEIC uploads** (iPhone default) were not timed. The HEIC path buffers the whole file and decodes with `heic-convert` (WASM) before sharp, so expect it to be slower than the JPEG numbers.

---

## 9. Teardown

All `node dist/main` processes started here were stopped (`pgrep -af dist/main` came back empty). The `closet-perf-pg` container was removed, the seeded data directories were deleted, and the worktree was removed with `git worktree remove --force`. The repo at `/home/aakash/projects/closet` was not modified.
