# Closet client-side performance audit, pass 2 (phone-perceived)

Date: 2026-09-25. Tree: `/home/aakash/projects/closet`, read-only (no builds run in the repo). Baseline: CLAUDE.md,
`docs/audits/2026-09-25/audit-frontend.md`, `audit-remeasure.md`. This pass leaves out what already shipped:
thumbnails, immutable `?v=` statics, the SW precache and SWR assets, NetworkFirst pages with a 3 s timeout, the lazy model,
the wardrobe fragment, the update toast and the heartbeat. It covers what a thumb on a phone still waits for.

Method: I read the code path from each entry point down. I measured bytes on the existing files in `public/` and
`node_modules/` (gzip -9 and Node zlib brotli q4/q11). I built the SW into the scratchpad only to compare dev and prod
builds (`sw-dev.js`, `sw-prod.js`), and benchmarked the background-removal library's own resize loop in Node
(`resize-bench.js`). Timings marked "est." are estimates for a mid-range phone (about 4-6x slower than this 16-core
desktop). Everything else is measured or read from code.

---

## 0. Ranked summary

| # | Impact | Finding | Where |
|---|---|---|---|
| H1 | High | Photo pipeline runs at full camera resolution. A 12 MP (on newer iPhones 24 MP) image is padded, encoded as PNG, segmented, upscaled, re-encoded and uploaded **twice at full size** (original plus a full-res cutout that is PNG on iOS and on "Skip"). Est. 6-15 MB uplink and several seconds of main-thread pixel loops per photo. The server then shrinks everything to 1080 px. | `public/js/background-removal.js:103-115,199-205`, `mask-editor.js:35-41,165`, `views/wardrobe/show.hbs:79-94` |
| H2 | High | The creation flow is built in the slowest order. 44 MB model plus 12-23 MB WASM per device. Inference is single-threaded because the app is not cross-origin isolated, runs with ORT verbose logging, and a mask editor modal is mandatory. The photo step only starts after the metadata step, and ends in a full reload. | `background-removal.js:26-44`, `src/app.ts:86-99`, `wardrobe.controller.ts:211,418` |
| H3 | High | Cold open of the installed app waits on the network. Navigations are NetworkFirst with no navigation preload. The SW is an **unminified dev build of Workbox** (130 KB, dev logging on). There is no freshness indicator, so an SWR shell is not possible yet. | `views/assets/src-sw.ts:45-60`, `package.json:15` |
| H4 | High | Taps that escape hx-boost and do a full document reload: every outfit card (`onclick="window.location=…"`), every calendar chip, the shared-wardrobe switcher, and **5 `HX-Redirect` responses** (photo upload, archive, garment delete, outfit delete, calendar delete). | `views/outfits/index.hbs:17`, `calendar/index.hbs:83`, `wardrobe_main.hbs:19`, controllers |
| M1 | Medium | Every boosted navigation re-mounts the whole shell. htmx snapshots the full body into sessionStorage (clone plus JSON of up to 10 pages). `<pwa-install>` re-connects and **fetches `/manifest.json` again**. Pull-to-refresh is torn down and rebuilt, even on fragment swaps. A 250 ms global view transition blocks input and cross-fades the static navbar and dock. | `layout.hbs:45-48,106-116`, `public/js/pwa.js:75-87` |
| M2 | Medium | Dead weight on the installed PWA's cold start. `pwa-install` (104 KB) and `pulltorefresh` (12 KB) load and run on Android standalone, where they do nothing. `_hyperscript` (172 KB) serves 12 attributes app-wide. A `preconnect` to `static.cloudflareinsights.com` opens an external TLS connection on every cold start. | `layout.hbs:84-93`, `public/js/pwa.js:16-17` |
| M3 | Medium | Outfit builder carousel: every swipe or arrow is a server round trip that re-queries the whole category. Row images are the **1080 px `nobg`** shown at 56 px. Each row has a non-passive hyperscript `touchmove`. | `views/partials/outfit_row.hbs:6-34,61,92-96`, `outfit.service.ts:235`, `outfit.controller.ts:106-124` |
| M4 | Medium | No tap feedback on boosted navigations. The indicator is not inherited (`disableInheritance`), so a tap on a card or the dock shows nothing for up to the 3 s NetworkFirst timeout. | `layout.hbs:47,106`, `navbar.hbs:34-39` |
| M5 | Medium | Background-removal SW routes revalidate **content-addressed** chunks: about 15-20 conditional round trips on every warm-up, and no timeout on the model route (poor signal leaves it hanging). The NAS brotli-compresses 44 MB of model and 23 MB of WASM on the fly for each download. The iOS/CPU path imports the 834 KB `ort.all` bundle where a 47 KB `ort.wasm` bundle would do. | `src-sw.ts:107-141`, `src/app.ts:104,184-195`, `layout.hbs:68` |
| L1 | Low | Versioned immutable `/modules/*` use StaleWhileRevalidate, which does needless background refetches. The core runtime (htmx, hyperscript) is not precached. | `src-sw.ts:66-82`, `workbox-config.js` |
| L2 | Low | The heartbeat polls `/healthz` every 30 s while visible, on top of real htmx traffic that already proves connectivity. | `public/js/connectivity.js:105,171-176` |
| L3 | Low | The pages cache (50-entry LRU) fills with fragments (`row-fragment` per index, every filter combination), which evict real pages needed offline. | `src-sw.ts:45-60` |
| L4 | Low (grows) | `/wardrobe` renders everything: no pagination, no `content-visibility`. At about 500 garments the sessionStorage history snapshot reaches the quota and htmx's retry loop re-stringifies. | `wardrobe_main.hbs:30-51`, htmx `saveToHistoryCache` |
| L5 | Low | Statics are compressed per request (brotli q4) rather than precompressed at q11, which leaves 11-20% on the table and spends NAS CPU. `sortablejs` is now the unminified ESM (119 KB vs 45 KB). The navbar logo links to `/`, which costs a 302 on every tap. | `src/app.ts:104`, `layout.hbs:71`, `navbar.hbs:30` |

Adjacent bugs (not performance, found on the way, worth fixing now):
- **Web push never subscribes.** `pwa.js:60-63` looks for `access_token` in `document.cookie`, but the cookie is
  `httpOnly` (`src/auth/auth.controller.ts:62,97`), so `authenticated` is always false. If that check is fixed as it
  stands, `webPush.subscribe()` (`webPush.js:8`) calls `Notification.requestPermission()` on page load with no user
  gesture, which iOS rejects. The subscription should hang off an explicit "Enable notifications" tap.
- **24 MP iPhone photos lose their cutout, with the wrong message.** `squarePadBlob` makes a
  `max(w,h)²` canvas. A 5712x4284 photo (the default on iPhone 15 Pro and later) becomes 32.6 MP, which exceeds WebKit's
  16.7 MP canvas area limit. The catch at `background-removal.js:151-157` then tells the user the browser "cannot
  decode" the photo. H1's downscale fixes this.
- **The iOS "webp" cutout is actually a PNG.** Safari does not encode WebP from canvas, so
  `canvas.toBlob(…,'image/webp')` (`mask-editor.js:165`) falls back to PNG per spec. The file is still uploaded as
  `nobg.webp` / `image/webp`. On Skip, every platform uploads the library's raw PNG under that name. Sharp sniffs the
  content, so it works, but those are the full-resolution bytes counted in H1.

---

## 1. First load and cold start of the installed PWA

### What the layout requests (`views/layout.hbs`)

| Resource | Line | Loading | Raw | gzip -9 | br q4 (what @fastify/compress sends) | br q11 | Cache path |
|---|---|---|---|---|---|---|---|
| navigation `/wardrobe` (150 garments) | n/a | n/a | 110,143 | 10,805 | n/a | n/a | SW NetworkFirst 3 s (`pages-v1`), **no nav preload** |
| `/bundle.css?v` | 55 | **render-blocking** | 127,789 | 20,812 | 21,600 | 17,439 | precache |
| `/modules/htmx.min.js?v` | 59 | defer | 51,238 | 16,539 | 17,156 | 14,996 | SWR `assets-v1` |
| `/modules/_hyperscript.min.js?v` | 60 | defer | 172,334 | 45,080 | 45,956 | 39,052 | SWR |
| `/js/color-multiselect.js?v` | 61 | defer | 4,547 | 1,440 | | | precache |
| `/js/connectivity.js?v` then `toast.js` | 82 | module | 3,483 + 1,512 | 1,525 + 780 | | | precache |
| `/modules/pwa-install.bundle.js?v` | 84-87 | module | 103,972 | 30,000 | 30,370 | 25,785 | SWR |
| `/js/pwa.js?v` then `workbox-window`, `pulltorefreshjs`, `toast` | 90 | module | 3,114 + 3,343 + 11,848 | 1,433 + 1,358 + 3,257 | | | precache + SWR |
| `favicon.ico?v`, `apple-touch-icon` | 36, 40 | n/a | 15,086 / 44,804 | | | | precache |
| `/manifest.json` | 53 | browser (+ `pwa-install` fetch) | ~1-2 KB | | | | **not routed by SW**, `no-cache`, no ETag |
| `preconnect static.cloudflareinsights.com` | 93 | n/a | DNS+TCP+TLS | | | | **external, wasted** |
| `/healthz` | connectivity.js:202 | fetch | 204 | | | | network (`no-store`) |
| `sw.js` update check | pwa.js:58 | browser | 130,682 | 29,371 | | | `no-cache` → 304 |

Shell JS on every cold start: **355 KB raw, about 101 KB gzip** across 9 scripts. Of that, `_hyperscript` is 48%.
`pwa-install` plus `pulltorefresh` are 33%, and neither does anything on an installed Android app (M2).

CSS: `bundle.css` is 20.8 KB gzip. daisyUI 5 is already tree-shaken: 84 of 551 class selectors have no literal match in
views/js/src, and they are mostly sibling variants such as `menu-*`, `step-*`, `stack-*` and `swap-*`, plus false negatives
like the `chip-N` classes built at runtime. Realistic saving is under 2 KB gzip, **not worth pursuing**. Only two themes
(`light`, `dark`). **No web fonts** (system stack, `@font-face` count 0), so there is no font loading cost.

Precache (`workbox-config.js`): 10 entries, **218,820 bytes raw**: bundle.css, 7 `/js/*`, icon.png, favicon. The
screenshots are correctly excluded now. htmx, hyperscript and pwa-install are **not** precached because they live
under `/modules` (node_modules). See L1.

### H3. Cold open waits on the network, and the SW is a dev build

**Evidence**
- `src-sw.ts:45-60`: navigations are `NetworkFirst({networkTimeoutSeconds: 3})`. No `navigationPreload.enable()`
  exists anywhere, but the bundled Workbox already consumes `event.preloadResponse` when it is present
  (`public/sw.js` around line 671: "Using a preloaded navigation response"). Without it, the navigation fetch cannot
  start until the SW has booted and routed.
- `package.json:15`: `esbuild --bundle views/assets/src-sw.ts` has no `--minify` and no
  `--define:process.env.NODE_ENV="production"`. The output keeps Workbox's dev branches (`if (true) {` ×66,
  `logger.debug(...)` on every strategy step, `finalAssertExports` argument assertions). Measured in the scratchpad:
  dev bundle **129,978 B / 29,184 gz**, prod minified bundle **27,498 B / 8,902 gz** (4.7x smaller). iOS and Android kill
  idle service workers within seconds to minutes, so every cold open re-parses the worker and runs the logging and
  assertion code on each fetch.
- No freshness indicator: when the 3 s timeout falls back to the cache, the page looks live. frontend-pwa.md requires
  "Show cached data immediately with a last updated timestamp".
- HTML responses carry no `ETag` (remeasure headers), so every revalidation is a full-body download.

**Why the thumb feels it:** first paint on a cold open is gated by SW boot, then the network RTT over Tailscale (est.
80-300 ms on LTE, more when the tunnel re-handshakes after idle), then the server (9 ms), then the body. On weak signal the
user stares at the splash for the whole 3 s before the cached copy shows. iOS standalone apps are cold-started on almost
every return from background, which multiplies this.

**Fix (in order, each independently shippable)**
1. `navigationPreload.enable()` (workbox-navigation-preload) in `src-sw.ts`. One line: the network request overlaps
   SW boot. Trade-off: none of consequence. Safari 15.4+ and Chrome support it, and the server already `Vary`s correctly.
2. Production SW build: `--minify --define:process.env.NODE_ENV='"production"'` in `generate:sw`. Trade-off: SW
   logs in production drop to the explicit `console.log` calls in `src-sw.ts`.
3. Serve the three tab roots (`/wardrobe`, `/outfits`, `/calendar`, and later `/wardrobe/:id`) **stale-while-revalidate
   with a freshness stamp**. The SW answers from `pages-v1` at once, adds an `X-SW-Cached-At` header (or the page reads
   `Date`), and revalidates in the background. When the new body's ETag differs, it `postMessage`s the client, and the client
   runs `htmx.ajax('GET', location.href, {target:'main', select:'main'})` to update in place. If the user has
   scrolled or has a form open, it shows an "Updated, tap to refresh" chip instead. Add `@fastify/etag` so revalidations
   are 304s. Trade-offs: (a) on logout the SW must purge `pages-v1` (post a message from the logout page), or a
   shared device could briefly show the previous user's wardrobe; (b) a garment edited on another device can show
   stale for one paint. That is what the freshness stamp is for, and the convention explicitly prefers it. Expected cold
   paint: SW boot plus a cache read, est. 50-150 ms, against today's RTT-bound 150 ms to 3 s.

---

## 2. Navigation

### H4. Full document reloads that bypass hx-boost

| Site | Trigger | Consequence |
|---|---|---|
| `views/outfits/index.hbs:17` | `<div class="card-body" onclick="window.location = '/outfits/{{id}}'">` covers most of the card | Tapping an outfit is a full page load. A tap on the inner `<a>` (line 19/60) *also* bubbles here: htmx only `preventDefault`s the boosted click and does not stop propagation, so a boosted XHR and a full navigation race, and the full navigation wins. |
| `views/calendar/index.hbs:83` | chip `onclick="window.location.href='/outfits/{{id}}/edit?…'"` | Full reload into the outfit editor, which then loads sortablejs cold. |
| `views/partials/wardrobe_main.hbs:19` | `<select onchange="location.href=this.value">` | Switching to a shared wardrobe is a full reload. |
| `wardrobe.controller.ts:418` | `HX-Redirect` after photo upload | Full reload of `/wardrobe/:id?photoSaved=1`, the last step of garment creation. `hx-target="main" hx-select="main"` on the form (`show.hbs:83-85`) is dead code. |
| `wardrobe.controller.ts:439`, `:481` | `HX-Redirect` after archive / delete | Full reload of `/wardrobe`: 110 KB page, all 8 eager thumbs re-decoded. |
| `outfit.controller.ts:212` | `HX-Redirect` after outfit delete | Full reload of `/outfits`. |
| `calendar.controller.ts:75` | `HX-Redirect` after calendar delete | Full reload of `/calendar`. |

A full reload on the installed app re-runs everything in section 1. The browser re-executes all 9 shell scripts, runs a SW
update check, the pwa-install manifest fetch, a `/healthz` probe and the Cloudflare preconnect, and paints white in between.
It also throws away htmx's history snapshots.

**Fix:** make the cards real `<a href>` (boosted), or use `hx-get` with `hx-push-url`. Replace `HX-Redirect` with
`HX-Location: {"path": "...", "target": "main", "select": "main"}`, which gives an ajax navigation with a history push and
leaves the shell alive. For the photo upload, simplest of all: return the updated `main` directly with `HX-Push-Url`,
since the form already targets `main`. Trade-off: none. The `?photoSaved=1` toast flag still works through `HX-Location`.

### M1. What a boosted navigation costs, and how to shrink it

`<body hx-boost="true">` (`layout.hbs:106`) swaps the whole body. Per tap:

1. **History snapshot on the critical path.** Before the swap, htmx 2.0.10 runs `saveCurrentPageToHistory()`
   (`htmx.js:4907`), which calls `cleanInnerHtmlForHistory`, a **deep clone of the whole body** (`htmx.js:3239`), then
   `JSON.parse` of the existing cache, a push, and `JSON.stringify` of up to `historyCacheSize: 10` snapshots into
   sessionStorage (`htmx.js:3175-3196`). A wardrobe snapshot is about 110 KB, so the worst case is about 1 MB parsed and
   re-serialized synchronously on every tap (est. 10-40 ms on a mid phone, growing with the wardrobe; see L4).
2. **`<pwa-install>` lives in the body** (`layout.hbs:115`). Every swap disconnects and reconnects it.
   Its `connectedCallback` runs `_init()`, which calls `fetchAndProcessManifest(this.manifestUrl)` and so issues
   `fetch('/manifest.json')`. Each reconnect also loads a locale and triggers a Lit render. That is **one extra network
   request per navigation**, `no-cache`, no ETag, unmatched by the SW, and it runs even in standalone mode where the
   component has nothing to offer.
3. **Pull-to-refresh** is torn down and re-initialized on every `htmx:afterSettle` (`pwa.js:86`). That includes fragment
   swaps such as filter changes and every outfit-row swipe.
4. **Global view transitions** (`layout.hbs:47`, `globalViewTransitions: true`). Each swap captures old and new
   snapshots of the full viewport and cross-fades for the UA default of about 250 ms. While the transition runs, hit
   testing lands on the `::view-transition` overlay, so taps are dropped. Navbar and dock have no
   `view-transition-name`, so the fixed chrome cross-fades as well. There is no `prefers-reduced-motion` handling
   (frontend-pwa.md requires it).
5. The response still carries `<head>` (3.1 KB), navbar, dock, app_status and pwa-install (about 5.4 KB raw), which get
   parsed and discarded or re-created. The bytes are small (about 2 KB gzip). The lifecycle churn in points 2-3 is what
   costs.

**Fix (the known open item, now with concrete payoff)**
- Swap `main` only. On `<body>`, set `hx-boost="true" hx-target="main" hx-select="main" hx-swap="outerHTML show:none"` and
  `hx-inherit="hx-boost hx-target hx-select hx-swap hx-indicator"`. Update the dock's active state with
  `hx-select-oob="#dock"`. htmx updates `<title>` itself. Every page already has exactly one `<main>`; check
  `wardrobe_main`'s `id="wardrobe-main"` still matches `main`. Set `hx-history-elt` on `main` so snapshots shrink to
  content only.
- Once the SW serves pages SWR (H3), set `historyCacheSize: 0`. Back navigation then becomes an
  `HX-History-Restore-Request` answered from the SW cache in milliseconds and revalidated. That removes the per-tap
  sessionStorage cost and the stale-on-back problem (today, back after editing a garment shows the pre-edit grid from
  sessionStorage).
- Move `<pwa-install>` out of the swapped region, or better, don't render it in standalone mode at all (M2).
- View transitions: give navbar and dock `view-transition-name`s so they stay static. Set
  `::view-transition-group(root){animation-duration:150ms}`, and use `@media (prefers-reduced-motion){::view-transition-group(*){animation:none}}`.
  Trade-off: 150 ms still blocks input, so disabling transitions on filter fragment swaps (`transition:false` in
  `hx-swap`) is worth it.
- Prefetch: add `htmx-ext-preload` (about 3 KB) with `preload="mousedown"` (it maps to touchstart on touch devices) on
  **dock links only**. On grid cards it would fire on every scroll that starts on a card, wasting requests. With SWR
  pages (H3) plus warming the three tab roots into `pages-v1` on `requestIdleCallback`, tab switches become instant and
  preload is only a nicety.

### M4. No tap feedback on navigation
`hx-indicator="#loading"` (`navbar.hbs:34-39`) only shows when an element sets it. Boosted anchors (cards, dock, back
arrows) don't, and `disableInheritance` (`layout.hbs:47`) stops it being inherited. htmx adds `.htmx-request` to the tapped
anchor, but no CSS reacts. On a slow network nothing visible happens for up to 3 s. **Fix:** add `hx-indicator` to the
body's `hx-inherit` list, point it at `#loading`, and add `.card.htmx-request{opacity:.6}` and a dock pressed state. Trade-off: none.

---

## 3. Garment creation flow, end to end

### How it runs today
1. `/wardrobe/new`: metadata form (no photo) → `POST /wardrobe` (boosted) → **302** → `GET /wardrobe/:id?created=1`
   (`wardrobe.controller.ts:211-213`), which is two round trips.
2. On the detail page, the user touches the photo input → `warmUp()` (`background-removal.js:57-70`) imports
   `/modules/background-removal/index.mjs` (172 KB, 32 KB gz) and `preload(config)`. That fetches `resources.json`, the
   ORT bundle (`ort.webgpu.bundle.min.mjs` 400 KB / 109 KB gz on the GPU path, `ort.all.bundle.min.mjs` **834 KB /
   200 KB gz** on the CPU/iOS path), the WASM (`…jsep.wasm` 23.9 MB in 6 chunks for GPU, `…threaded.wasm` 12.7 MB in 3
   chunks for CPU), and the model `isnet_quint8` **44.35 MB in 11 chunks** (`@imgly/background-removal-data/dist/resources.json`).
   On the wire, brotli q4 on the fly: model chunks about 66% of raw (4,194,304 → 2,779,375 per chunk), jsep WASM
   23.9 → 4.56 MB, CPU WASM 12.7 → 2.68 MB. **First run is about 34 MB (GPU) or 32 MB (CPU) over cellular** (est. 25-60 s at
   5-10 Mbps).
3. Photo picked (`change`, line 135):
   - `squarePadBlob(file)` (103-115): decodes the full photo, pads it into a `max(w,h)²` OffscreenCanvas and
     **encodes a PNG**. For 12 MP (4032x3024) that is a 4032x4032 canvas: 16.3 MP, 65 MB RGBA, PNG-encoded (est. 1-3 s).
     For 24 MP it is 32.6 MP, over the iOS canvas limit, so it fails and shows a misleading message.
   - `removeBackground(squareFile, config)`. Inside the library (`index.mjs`): it decodes that PNG again, then
     `tensorResizeBilinear` down to 1024² **in plain JS on the main thread** (`index.mjs:848-881`, `ndarray.get/set` per
     channel). ORT inference runs in a worker (`proxyToWorker`). With `rescale` on by default, the 1024² mask is
     upscaled back to 4032² in the same JS loop, the alpha is spliced over 16.3 M pixels, and the result is encoded as
     **full-size PNG** (`output` is left at default, `background-removal.js:36-39`).
   - Benchmarked in Node on this desktop with the library's own code (`scratchpad/resize-bench.js`):

     | step | 4032² (12 MP padded) | 1080² | mid phone est. |
     |---|---|---|---|
     | input downscale to 1024 (RGBA) | 37 ms | 22 ms | 150-220 ms vs 90-130 ms |
     | mask upscale 1024 to target | **184 ms** | 13 ms | **0.7-1.1 s** vs 50-80 ms |
     | alpha splice loop | 42 ms | 3 ms | 170-250 ms vs about 15 ms |

     Add the two 16 MP PNG encodes and one decode (est. 3-6 s on a phone, all main thread), and the UI freezes for
     seconds while the status text claims progress.
   - `openMaskEditor` (mask-editor.js): a **mandatory modal**. Two more full-resolution canvases (`35-41`). The restore brush
     `drawImage`s the 16 MP offscreen canvas through a clip on every `touchmove` (`87`). Accept runs
     `toBlob('image/webp', 0.92)` on 16 MP (PNG on Safari).
   - `debug: true` (`:28`) makes the library set `ort.env.debug = true; ort.env.logLevel = 'verbose'`
     (`index.mjs:1036-1041`), so ORT logs verbosely during session creation and run.
   - Threads: `maxNumThreads()` asks for `hardwareConcurrency` threads, but ORT's threaded WASM needs
     `SharedArrayBuffer`, which needs `crossOriginIsolated`. There is no COOP/COEP header anywhere (`src/app.ts:86-99`
     sets only CSP and friends), so **Android's CPU path runs single-threaded**. The iOS patch pins 1 thread anyway.
4. Tap "Add photo" → multipart `POST /wardrobe/:id/photo` with **the original file as picked, plus the full-res cutout**.
   There is no upload progress, only a spinner ring (frontend-pwa.md: "progress bars … warn before large uploads").
5. Server: HEIC goes through `heic-convert` (JS libheif, buffers the whole file, `src/file/heic.ts:43-57`), then sharp
   resizes to **1080 px** (`file-service.abstract.ts:23,305`) and derives the thumb. So the server discards 90%+ of the
   pixels the phone spent seconds producing and uploading.
6. `HX-Redirect` → **full document reload** (H4).

### H1. Upload bytes: phone photo vs client 1080 px

| Upload | Original part | Cutout part | Total (est.) | Uplink time at 5 Mbps |
|---|---|---|---|---|
| iPhone 12 MP HEIC, Accept in editor (PNG, since Safari has no WebP encode) | 1.5-3 MB HEIC | 4032² PNG with alpha, 4-10 MB | **6-13 MB** | 10-21 s |
| Android 12 MP JPEG, Accept (WebP q0.92) | 3-6 MB | 4032² WebP with alpha, 0.8-2 MB | **4-8 MB** | 6-13 s |
| Any platform, **Skip** in editor (library PNG) | 1.5-6 MB | 4032² PNG, 4-10 MB | **6-16 MB** | 10-26 s |
| **Client downscale to 1080 first** | 1080 JPEG q0.85 / WebP q0.85: 150-300 KB | 1080² WebP (Chrome) 60-150 KB / PNG (Safari) 400-900 KB | **0.2-1.2 MB** | 0.3-2 s |

Pixel count drops 14x (12.2 MP → 0.87 MP for a 4:3 photo), so encoded bytes drop by roughly the same factor. The server's
measured average stored original (1080 px q90, synthetic noisy photo) was 548 KB, an upper bound for real clothing shots.

**Fix (H1):** decode once at pick:
`createImageBitmap(file, {resizeWidth, resizeHeight, resizeQuality: 'high', imageOrientation: 'from-image'})` fitted to
1080 (or 1280 for headroom). Pad **that** to square, then feed the same bitmap/blob to both `removeBackground` and the
mask editor. Encode the original part as JPEG q0.85 (WebP on Chromium), and set `output: {format: 'image/webp', quality: 0.85}`
on Chromium or keep PNG at 1080 on Safari. Replace the `photo` field with the downscaled file through `DataTransfer` (the
pattern already used at `show.hbs:216-219`). Wire `htmx:xhr:progress` to a `<progress>`.

What the server pipeline could drop or simplify: the HEIC decode path is no longer hit from iOS, because Safari decodes
HEIC and the client re-encodes. It stays only for Android HEIC, where Chrome can't decode, and that is rare. `sharp` still
re-encodes (never trust client bytes), but it works on 1 MP inputs, so upload handling goes from about 215 ms p50 to est.
under 60 ms. The 100 MB multipart cap and the HEIC buffer cap stop mattering in practice.

Trade-off: the server no longer receives the full-resolution original. It throws that away today anyway (1080 cap), so
nothing is lost unless a future "full-res export" is wanted. In that case send 2048 px, still about 4x fewer bytes.

### H2. The flow's architecture

Beyond H1, the client does the heaviest work in the most user-visible order:

- **Sequencing.** Metadata first, photo second, so model download plus inference (est. 5-15 s single-threaded on a mid Android,
  plus the first-run 32-34 MB download) sits in plain view after the user has finished typing. **Photo-first on
  `/wardrobe/new`**: start warm-up on page entry (or on input focus as now), run inference as soon as a photo is picked,
  and let the user fill in name and category while it runs. That hides 5-15 s entirely. One POST creates the garment with
  both parts, which also removes the 302 and the separate photo step.
- **Mask editor is mandatory** (`background-removal.js:201`). Make it opt-in: accept the cutout automatically and keep the
  existing "Edit mask" button on the detail page (`show.hbs:37-57`, `wireUpEditMaskBtn`) for fixes. One modal less per garment.
- **Threads.** Serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (or
  `require-corp`; everything is same-origin) on HTML. ORT then gets `SharedArrayBuffer` and 2-4x faster CPU inference on
  Android. Trade-off: it breaks any cross-origin embed; there are none once the Cloudflare hint is removed (M2).
- **`debug: false`** in production (line 28). This turns off ORT verbose logging.
- **Structural alternative (recommended to decide now).** Run the same `isnet_quint8` model **on the server** with
  `onnxruntime-node` in the NestJS process after upload. That deletes about 60 MB of per-device downloads, the patched
  `@imgly` dependency, 3 SW routes, the importmap entries for ORT, and the iOS thread and canvas workarounds. It also gives
  cutouts to Android HEIC. Writes are already disabled offline (CLAUDE.md), so client-side inference buys no offline
  capability. Trade-offs: NAS CPU of est. 1-3 s per photo, which is fine for a household. It needs a "processing"
  state on the detail page (`hx-trigger="load delay:1s"` polling, or SSE). And the mask editor stays client-side but works
  on the server-made cutout, which it already does for "Edit mask".

### M5. Background-removal delivery waste (applies while it stays client-side)
- `src-sw.ts:107-121`: `/bg-removal-models/**` is NetworkFirst with `fetchOptions: {cache: 'no-cache'}` and **no
  `networkTimeoutSeconds`**. Every file there except `resources.json` is named by its sha256 (87 files, for example
  `064e16ef…a47`), so they are immutable by construction. Each warm-up still sends about 11 model plus 3-6 WASM
  conditional requests (304s, one RTT each, parallel but under HTTP/1.1's 6-connection limit, so 3+ waves). On lie-fi,
  each one waits for the network to fail before the cache answers. **Fix:** CacheFirst for hashed chunks, and NetworkFirst
  with a 3 s timeout only for `resources.json`. Same for `/modules/background-removal/*.mjs` and `/modules/onnxruntime-web/**`:
  their URLs aren't versioned by content, so keep revalidating the entry files but add `?v` through the importmap (already
  there for the entries).
- `src/app.ts:104`: `fastifyCompress` compresses `application/octet-stream` and `application/wasm` (mime-db marks both
  compressible), so the NAS brotli-q4 compresses 44 MB of model plus 12-24 MB of WASM **per download per device**, with
  no `Content-Length`, so the progress bar can't show a percentage. **Fix:** precompress once at build (`.br`, q11) and
  serve with `@fastify/static`'s `preCompressed: true`. Model chunks gain little (quantized weights: about 34% saving); the
  WASM gains a lot (24 MB → about 4.5 MB).
- `layout.hbs:68`: `"onnxruntime-web"` maps to `ort.all.bundle.min.mjs` (834 KB / 200 KB gz). The CPU path (all of iOS
  after the patch, and Android without WebGPU) needs only the WASM EP: `ort.wasm.bundle.min.mjs` is **46.5 KB / 15 KB gz**.
  Verify that it accepts the `wasmPaths` the library sets before switching.

---

## 4. Large list pages

`/wardrobe` (`partials/wardrobe_main.hbs`): 150 cards, `main` is 101,663 B raw / 7,969 gz of the 110 KB page, about 585 B per
card. Images are done right after the first program: `thumb` at 400 px for a 160 CSS px tile (about 480 device px at 3x,
so no `srcset` is needed), `width/height`, `decoding=async`, eager for the first 8, lazy after. Cards are plain boosted
anchors with no per-card handlers (htmx attaches one boost listener per anchor, 150 of them, which is negligible).

### L4. No pagination or incremental rendering
- The whole wardrobe renders on every visit, every filter swap and every history snapshot. That's fine at 150 (about 8 KB
  gzip). At 500 garments it becomes about 290 KB raw per page and per snapshot. htmx's sessionStorage loop
  (`htmx.js:3194-3200`) retries `JSON.stringify` of the whole cache after each `QuotaExceededError`, so each tap
  serializes megabytes several times.
- **Fix (cheap):** `.card{content-visibility:auto; contain-intrinsic-size:auto 176px auto 230px}` on grid cards (skips
  layout and paint for the roughly 140 offscreen tiles). **Fix (when it grows):** first page of 60 plus a sentinel
  `<div hx-get="/wardrobe?page=2" hx-trigger="revealed" hx-swap="outerHTML" hx-select=".card,…">`. Together with
  `historyCacheSize: 0` from M1, this removes the snapshot cliff.
- Garment detail LCP image (`show.hbs:31-35`): `nobg` at 1080 px in an `aspect-square` figure, so there is no CLS risk.
  Adding `fetchpriority="high"` is a nicety.
- Outfit index (`outfits/index.hbs`): 92 KB for 20 outfits (about 4.6 KB each), because each card carries its own
  add-to-calendar dropdown form plus a hyperscript program (lines 18-58). Render **one** shared dialog and pass the outfit
  id in, which cuts about 60% of the HTML and 19 of the 20 hyperscript compilations. The per-card `onclick` is H4.

### M3. Outfit builder (`views/outfits/form.hbs`, `partials/outfit_row.hbs`)
- **Each swipe or arrow is a network round trip.** `hx-get="/outfits/row-fragment?category=…&index=…"` (`:61,119`) and the
  hyperscript swipe (`:32`). The server re-runs `garmentService.findAll(category)` and renders one row
  (`outfit.controller.ts:115-123`). On LTE over Tailscale every step is 100-300 ms+, NetworkFirst caches each `(category,
  index)` as its own `pages-v1` entry (L3), and a fast swipe queues requests that race.
- Row image is **`nobg` at 1080 px** (`outfit.service.ts:235`) shown at `size-14` (56 px). With no cutout it is the
  548 KB original. It should be `thumb` (about 9 KB). The garment modal can take `nobg` through a data attribute.
- **Non-passive `touchmove` on every row** (hyperscript `on touchmove … event.preventDefault()`, `:9-16`). Vertical scrolls
  that start on a row wait for the hyperscript runtime before the compositor may scroll, which is jank on the page where
  users scroll most.
- **Fix:** render all garments of a category into a horizontal CSS scroll-snap strip of thumbs
  (`overflow-x:auto; scroll-snap-type:x mandatory; touch-action:pan-x pan-y`). A few lines of JS on `scrollend` set the
  hidden `garmentId` from the snapped index. There is **zero network per step**, no touch handlers, and native momentum.
  The server already has the list. Trade-off: HTML grows with category size (thumbs are lazy). For a household-sized
  wardrobe that's fine; past about 100 items per category, render a window.
- `sortablejs` importmap entry (`layout.hbs:71`) points at the **unminified** `modular/sortable.esm.js` (119,505 B /
  28,168 gz) instead of the 45,478 B / 15,038 gz minified build the global script used. Minify it into `public/vendor/`
  at build, or wrap `Sortable.min.js`.

---

## 5. Interaction latency

- `_hyperscript` (172 KB raw, 45 KB gz) is loaded on every page for **12 `_=` attributes** in the whole app (counted:
  show 2, outfit_row 3, outfits/index 1, wardrobe_main 3, outfits/form 1, wardrobe-share/manage 2). V8 pre-parse is
  3.5 ms on this desktop (est. 15-35 ms on a phone), plus runtime init and one compile per attribute per swap. The
  runtime cost is small but real. The byte cost is the largest item in the shell. Several uses are thin wrappers around
  JS (`on click js(me) … end`, `outfit_row.hbs:78-90`), and the filter modal's reset/apply (`wardrobe_main.hbs:189-230`)
  is a form that could simply submit. **Option:** keep hyperscript as the convention says, but consider replacing these 12
  with small inline handlers or htmx attributes and dropping the library, which removes 48% of shell JS. This is a
  convention-level call (CLAUDE.md prefers `_hyperscript` over hand-written JS), so flag it to the owner rather than
  deciding it here.
- No long tasks in the navigation path except M1-1 (the history snapshot) and the view-transition input block. The
  long tasks are all in the photo flow (H1: seconds of main-thread pixel loops).
- `color-multiselect.js`: one document-level click listener plus `initAll` on each `htmx:afterSwap`. Fine.

---

## 6. Service worker (`views/assets/src-sw.ts`)

- H3: dev-mode Workbox build, and no navigation preload.
- **L1.** `assets-v1` is **StaleWhileRevalidate** for `?v=`-versioned URLs, which the server marks immutable for a year
  (`src-sw.ts:66-82`). SWR sends a background `fetch` for every script on every full load. That usually hits the HTTP
  cache, but iOS evicts the standalone app's HTTP cache aggressively, and then it is a real download of
  htmx+hyperscript+pwa-install (about 92 KB gz) each cold start for bytes that cannot have changed. **Fix:** CacheFirst,
  keyed on the full URL including `?v`, with ExpirationPlugin cleaning old versions. Also precache the core runtime
  (copy htmx/hyperscript into `public/vendor/` at build, or use `additionalManifestEntries`). Today, a first offline launch
  whose HTTP cache was evicted boots without htmx.
- **L3.** `pages-v1` (50 entries) caches every htmx GET, including `row-fragment?category&index` and every filter
  combination (`url|hx`). A few minutes in the outfit builder can evict `/wardrobe`, `/outfits` and `/calendar`, the pages
  the offline story depends on. **Fix:** a separate `fragments-v1` cache (small, short TTL), or skip caching
  `row-fragment` entirely.
- Model routes: M5.
- The catch handler and `warmStrategyCache` for offline.html are correct.

---

## 7. Request inventory (installed PWA, `PWA_ENABLED=true`, authenticated)

Legend. **Trigger**: L = layout.hbs, H = htmx, SW = service worker, HB = heartbeat (connectivity.js), PI = pwa-install,
WW = workbox-window / browser SW update, B = browser, P = page script. **Answered by**: PC = SW precache, RC = SW runtime
cache (strategy), NET = network, HTTP = HTTP cache. Bytes are gzip on the wire where compressible.

### Journey A: cold open to /wardrobe (SW installed, caches warm)

| # | Request | Trigger | Needed? | Answered by | Bytes | Waste / note |
|---|---|---|---|---|---|---|
| A1 | `GET /wardrobe` (navigate) | B | yes | **NET first** (NetworkFirst 3 s), SW boot in series (no nav preload) | 10,805 | Blocks first paint on RTT. No ETag, so a full body every time (H3) |
| A2 | `bundle.css?v` | L:55 | yes | PC | 0 net | fine |
| A3 | `favicon.ico?v` | L:36 | marginal in standalone | PC | 0 | fine |
| A4 | `htmx.min.js?v` | L:59 | yes | RC SWR, **plus a background refetch** | 0-16.5 KB | SWR on immutable (L1) |
| A5 | `_hyperscript.min.js?v` | L:60 | for 12 attributes | RC SWR, plus a background refetch | 0-45 KB | L1; M2/§5 |
| A6 | `/js/color-multiselect.js?v` | L:61 | only on forms | PC | 0 | executes on every page; fine |
| A7 | `/js/connectivity.js?v` → `/js/toast.js?v` | L:82 | yes | PC | 0 | fine |
| A8 | `/modules/pwa-install.bundle.js?v` | L:84-87 | **no** (already installed) | RC SWR, plus a background refetch | 0-30 KB | M2 |
| A9 | `/js/pwa.js?v` → `workbox-window` → `pulltorefreshjs` → `toast` | L:90 | pulltorefresh **only on iOS standalone** | PC + RC SWR | 0-4.6 KB | static import of PTR on all platforms (M2) |
| A10 | `/manifest.json` | B (link rel) | browser-managed | NET (`no-cache`, no ETag, SW passthrough) | ~1-2 KB | send an ETag/304 |
| A11 | `/manifest.json` again | **PI** `connectedCallback` | **no** | NET | ~1-2 KB | **duplicate** (M1/M2) |
| A12 | TLS preconnect `static.cloudflareinsights.com` | L:93 | **no** | NET (DNS+TCP+TLS) | handshake | external, nothing uses it; also in CSP (`app.ts:96`) |
| A13 | `GET /healthz` | HB `probe('load')` | yes (once) | NET, `no-store` | 204, 0 body | fine at load |
| A14 | `GET /sw.js` (update check) | WW `register()` / B on navigation | yes | NET conditional → 304 | 0 (29 KB gz when changed; 8.9 KB if prod build) | fine; smaller with H3-2 |
| A15-22 | 8 eager thumbs `/file/thumb/…?v` | page | yes | RC CacheFirst `images-v1` | 0 | fine |
| A23+ | 142 lazy thumbs on scroll | page | yes | RC CacheFirst | 0 | fine |
| - | `/notification/vapid-public-key`, `POST /notification/subscribe` | P (pwa.js:64) | yes, once | never sent | 0 | **bug**: httpOnly cookie check always false |
| every 30 s | `GET /healthz` | HB | partly | NET | 204 | L2 |

Network round trips before the user sees the grid: A1, plus SW boot in series. After that, in parallel: A10, A11, A12, A13, A14.
Five of these don't need to happen on a cold start (A11, A12, and the SWR refetches from A4, A5 and A8 if HTTP-evicted).

### Journey B: tap a garment, then back

| # | Request | Trigger | Needed? | Answered by | Bytes | Waste / note |
|---|---|---|---|---|---|---|
| B0 | (none, main thread) | H `saveCurrentPageToHistory` | no (with SWR) | n/a | ~110 KB clone + up to ~1 MB JSON to sessionStorage | M1-1 |
| B1 | `GET /wardrobe/:id` (HX-Request, HX-Boosted) | H boost | yes | NET first (3 s), then RC | ~4-5 KB gz (20,511 raw) | no tap feedback while waiting (M4); full page for a `main` swap (M1-5) |
| B2 | `/manifest.json` | **PI re-mount** | **no** | NET | ~1-2 KB | **per navigation** (M1-2) |
| B3 | `/file/nobg/<uuid>.webp?v` | page | yes | RC CacheFirst; first view NET 15-575 KB | 0 after first | fine |
| B4 | `/js/background-removal.js?v` → `/js/mask-editor.js?v` | P (inline module, `show.hbs:184`) | only if editing | PC; module map reuses it after the first time | 0 | fine (runs `wireUp…` on each visit) |
| B5 | view transition | `globalViewTransitions` | optional | n/a | about 250 ms, input blocked | M1-4 |
| B6 | back: none if htmx sessionStorage hit | H history | n/a | sessionStorage | 0 | **stale** after edits; costs B0 on the way in |
| B6' | back, cache miss: `GET /wardrobe` (HX-History-Restore-Request) | H | yes | NET first | 10.8 KB | would be instant with SWR |
| B7 | `/manifest.json` | **PI re-mount on restore** | **no** | NET | ~1-2 KB | duplicate |
| iOS | PTR destroy/init | pwa.js afterSettle | once per page | n/a | n/a | M1-3 |

Net requests for one detail visit and back: 2-3 fetches that aren't needed (B2, B7) and 1-2 that would be instant under SWR (B1, B6').

### Journey C: create a garment with a photo (Android Chrome, first time)

| # | Request | Trigger | Needed? | Answered by | Bytes | Waste / note |
|---|---|---|---|---|---|---|
| C1 | `GET /wardrobe/new` | H boost | yes | NET first | ~5 KB gz | plus a manifest re-fetch (PI) |
| C2 | `POST /wardrobe` → **302** | H boost form | yes | NET (SW passthrough) | small | redirect costs 1 extra RTT |
| C3 | `GET /wardrobe/:id?created=1` | follow of C2 | yes | NET (not via SW) | ~4-5 KB gz | could be the POST's response with `HX-Push-Url` |
| C4 | `/manifest.json` | PI re-mount | no | NET | 1-2 KB | duplicate |
| C5 | `/modules/background-removal/index.mjs` | P warmUp | yes (while client-side) | RC NetworkFirst `no-cache` → NET conditional | 32 KB gz first; 304 after | revalidated every session |
| C6 | `/bg-removal-models/resources.json` | library | yes | NetworkFirst `no-cache`, **no timeout** | small | the only file that needs revalidation |
| C7 | `onnxruntime-web/…bundle.min.mjs` (webgpu 109 KB gz / all **200 KB gz**) | library import | yes | NetworkFirst `no-cache` | as listed | CPU path could use 15 KB gz `ort.wasm` (M5) |
| C8 | 6 WASM chunks (jsep) or 3 (CPU) | library | yes, first time | NetworkFirst `no-cache`, no timeout | 4.56 MB / 2.68 MB (br q4 on the fly) | **304 round trips on every later warm-up** for immutable hashes; NAS compresses per request (M5) |
| C9 | 11 model chunks | library | yes, first time | same | ~30.5 MB (44.35 MB raw) | same |
| C10 | (none, main thread) | P | n/a | n/a | 16 MP PNG encode, decode, JS resize, PNG encode | H1 |
| C11 | `POST /wardrobe/:id/photo` multipart | H | yes | NET | **4-16 MB** (H1 table) | 0.2-1.2 MB with a client downscale |
| C12 | **`HX-Redirect` → full document load** of `/wardrobe/:id?photoSaved=1` | H | a view is needed, not a reload | NET plus every Journey A request (A2-A14) | ~15 KB HTML plus revalidations | H4 |
| C13 | `/file/nobg/…?v=1` for the new photo | page | yes | NET, then CacheFirst | ~15-150 KB | fine |

Second and later garments (warm model): C5-C9 turn into **about 17-20 conditional requests (304)** before inference
starts, and they wait on the network with no timeout on the model route.

### Waste list with fixes

| Waste | Journeys | Fix |
|---|---|---|
| Navigation waits on network plus SW boot | A1, B1, B6', C1 | Navigation preload now; SWR pages with a freshness stamp and in-place refresh (H3) |
| `/manifest.json` fetched by `<pwa-install>` on every body swap | A11, B2, B7, C4 | Don't render `<pwa-install>` when `matchMedia('(display-mode: standalone)')` matches; lazy-import the bundle only in browser mode; or move it out of the swapped body |
| Manifest and HTML re-sent in full | A1, A10 | `@fastify/etag` (304s through the HTTP cache under the SW) |
| External preconnect to Cloudflare | A12 | Delete `layout.hbs:93` and the two CSP host entries (`app.ts:96`). It also violates CLAUDE.md's "zero external requests" rule |
| SWR background refetch of immutable versioned scripts | A4, A5, A8, A9 | CacheFirst for `?v` URLs; precache the core runtime (L1) |
| pwa-install and pulltorefresh fetched and executed on installed Android | A8, A9 | Gate: `if (!standalone) import('pwa-install')`; `if (navigator.standalone) import('pulltorefreshjs')` |
| Full-body snapshot to sessionStorage per tap | B0 | `hx-history-elt` on `main`; `historyCacheSize: 0` once SWR serves back navigations |
| POST → 302 → GET | C2-C3 (also `POST /wardrobe/:id` edit, clone) | Answer the POST with the rendered page plus `HX-Push-Url` (or `HX-Location`); keep the 302 for no-JS |
| `HX-Redirect` full reloads | C12, archive, delete ×3 | `HX-Location` with `target: main` (H4) |
| Revalidating content-hashed model/WASM chunks | C8, C9 (every warm-up) | CacheFirst for sha256-named files; NetworkFirst with timeout only for `resources.json` (M5) |
| On-the-fly brotli of 60+ MB model/WASM on the NAS, with no Content-Length | C8, C9 | Precompress at build; `preCompressed: true` (M5) |
| 834 KB ORT bundle on the CPU path | C7 | `ort.wasm.bundle.min.mjs` for `"onnxruntime-web"` |
| Full-resolution original plus cutout uploaded | C11 | Client downscale to 1080 (H1) |
| Outfit-row step = one request plus a server findAll | builder | Client-side scroll-snap strip (M3) |
| Row images at 1080 px for 56 px | builder | `thumb` variant (M3) |
| Heartbeat every 30 s even while htmx traffic flows | A (ongoing) | Reset the heartbeat timer on every successful `htmx:afterRequest`; idle cadence 60 s; keep the 5 s retry while offline (L2) |
| Fragments polluting the 50-entry page cache | builder, filters | Separate fragment cache or skip `row-fragment` (L3) |
| Navbar logo `href="/"` → 302 → `/wardrobe` | any | `href="/wardrobe"` (`navbar.hbs:30`) |

---

## 8. Checked and fine (don't spend time here)
- `bundle.css` size and daisyUI pruning; no web fonts; only the CSS blocks render; all scripts are defer or module.
- Grid images (thumb size, dimensions, lazy after 8, immutable, CacheFirst). No `srcset` needed at a 160 px display.
- Fragment/page cache keys (`pageCacheKey` plus `Vary`) are consistent between server and SW.
- The update flow (no skipWaiting on install, toast, reload on controlling).
- Precache contents (219 KB, screenshots excluded).

## 9. Suggested order
1. Quick wins, no design needed (about half a day): navigation preload; production SW build; delete the Cloudflare
   preconnect and CSP entries; `debug:false`; outfit row `thumb`; navbar logo href; gate pwa-install and
   pulltorefresh by display mode; `HX-Location` instead of `HX-Redirect`; remove the outfit-card and calendar-chip
   `onclick` navigations; `hx-indicator` inheritance; CacheFirst for hashed model chunks; `ort.wasm` bundle.
2. Photo pipeline (H1): client downscale at pick, with upload progress.
3. Decide H2: server-side inference (recommended) or photo-first plus COOP/COEP.
4. Shell (M1 plus H3-3): `main`-only boost, SWR pages with freshness stamp and ETag, `historyCacheSize: 0`, view-transition names.
5. Outfit builder scroll-snap strip (M3); wardrobe `content-visibility`, then pagination when it grows.
