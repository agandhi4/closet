# Closet frontend / PWA audit

## 1. Client assets loaded per page (`views/layout.hbs`)

Everything below loads once per browser session (htmx `hx-boost="true"` swaps only `<body>` on
navigation, so `<head>` scripts are not re-fetched between /wardrobe, /outfits, /calendar).
Bytes are minified, on-disk (pre-gzip; `fastifyCompress` is registered so wire bytes are lower).

| Asset | Bytes | Blocking? | Used on | Needed on every page? |
|---|---|---|---|---|
| `/modules/htmx.min.js` | 51,238 | `defer` | every page (hx-boost) | Yes |
| `/modules/_hyperscript.min.js` | 172,334 | `defer` | every page (`_=` attrs) | Yes |
| `/modules/Sortable.min.js` | 45,478 | `defer` | only `views/outfits/form.hbs:42` (drag-to-reorder) | **No** |
| `/modules/sse.js` (htmx-ext-sse) | 8,921 | `defer` | only `views/chat.hbs` (`/chat`, not a wardrobe/outfit/calendar route) | **No** |
| `/js/color-multiselect.js` | 4,547 | `defer` (attr duplicated, `layout.hbs:57`) | garment/outfit color-picker partial only | Partially |
| `/bundle.css` | 125,081 | render-blocking (`<link rel=stylesheet>`, plus a redundant `rel=preload` of the same URL) | every page | Yes |
| `/modules/pwa-install.bundle.js` | 103,972 | `type=module` (defer semantics) | install banner, gated by `pwaEnabled` | Yes while not installed, dead weight once installed (no `display-mode: standalone` check before injecting) |
| `/modules/workbox-window.prod.mjs` | 3,343 | inline `<script type=module>`, gated by `pwaEnabled` | SW registration | Yes |
| `/modules/pulltorefresh/index.esm.js` | 11,848 | inline `import`, gated by `pwaEnabled` | only used `if (window.navigator.standalone)` (iOS) | Conditional, fine |
| `onnxruntime-web` importmap entries | 0 (declared, not fetched) | n/a | only resolved if `background-removal.js` imports it | Declaration is free; see Finding 2 for the real cost |

Baseline JS+CSS shipped on first load with PWA enabled: **~390–520KB** minified before compression,
of which Sortable (45KB) and sse.js (9KB) serve a single non-core page each, and hyperscript (172KB,
by far the largest single script) is loaded globally for what's mostly a handful of small `_=` snippets.

## 2. Service worker caching matrix (`views/assets/src-sw.ts`, built by `workbox-config.js`)

Precache (`workbox-config.js` globs `**/*.{png,webp,css,ico,js,json,txt}` under `public/`):
bundle.css, favicon.ico, the 4 files in `public/js/`, `manifest`-adjacent json/txt, **and all 8
onboarding screenshots in `public/assets/screenshots/*.webp` (~900KB)** — these are only referenced
by the web-app-manifest's `screenshots` field (shown in the browser's own install UI), never
rendered inside the app, yet are precached into every client's Cache Storage on install.

| Route pattern | Strategy | Offline behaviour |
|---|---|---|
| `/sse` | NetworkOnly | Fails offline (correct — it's a stream) |
| `/file/**` (non-document) | NetworkOnly, deliberately deferring to the **HTTP** cache via `Cache-Control` | Only works offline if the server sent a cacheable header — see Finding 3, `/file/nobg/*` doesn't |
| `/bg-removal-models/**` | NetworkFirst, `bg-removal-models-v2`, 30-day expiry | Falls back to cache once warmed |
| `/modules/onnxruntime-web/**`, `/modules/background-removal/**` | NetworkFirst, 3s timeout, `bg-removal-runtime-modules-v1`, 7-day expiry | Falls back to cache once warmed |
| **Everything else (navigations, htmx fragments, htmx/hyperscript/Sortable/sse.js, `/bundle.css`, `/sw.js` itself)** | `registerRoute(() => true, new NetworkFirst())` — the single `CACHE_STRATEGY` instance, no `networkTimeoutSeconds` | Waits for a full network round trip (or failure) before ever consulting cache — see Finding 1 |
| Navigation fallback | `setCatchHandler` → serves `/offline.html` (via the same NetworkFirst cache) only when the catch-all route itself throws | Works, but only reachable after the blanket NetworkFirst gives up |

`htmx-ext-sse` fragment requests are not distinguished from full-page navigations (no `Vary:
HX-Request` handling, no separate cache name) — they fall into the same catch-all NetworkFirst
bucket as everything else that isn't explicitly matched above.

Update lifecycle: `self.skipWaiting()` unconditionally on `install`, `clientsClaim()` at top level —
the new SW takes every open tab immediately. `layout.hbs:112-134` compensates client-side (sets
`window.__swUpdated`, cancels the next boosted GET and does a hard navigation instead of reloading
in place) but there is no visible "update available" toast anywhere — the convention's non-blocking
update prompt doesn't exist; updates apply silently.

## 3. Findings, ordered by user-perceived impact

### Finding 1 — The service worker's blanket strategy is NetworkFirst, so the "installed PWA" never gets a fast cache-first shell
**Where:** `views/assets/src-sw.ts:90` (`registerRoute(() => true, CACHE_STRATEGY)` where `CACHE_STRATEGY = new NetworkFirst()`, `src-sw.ts:21`); compounded by `src/main.ts:70-100` (`useStaticAssets` calls set no `maxAge`, so `@fastify/static` 8.3.0 defaults `Cache-Control: max-age=0` on `/bundle.css`, `/modules/*`, `/sw.js` itself).
**Why it matters:** Every navigation and every "precached"/"warmed" asset (htmx, hyperscript, bundle.css, `sw.js`) still goes to the network first, with no timeout, before the SW will even look at its own cache. `frontend-pwa.md`'s <200ms cached first paint / <1s cached-interactive targets are structurally unreachable — repeat visits pay a full round trip regardless of how much is sitting in Cache Storage. On a slow connection this also means the shell doesn't degrade to "show cached, sync in background" as the convention requires; it blocks on the network every time.
**Fix:** Split the catch-all by request type. Precache and serve the shell chrome (`bundle.css`, htmx/hyperscript/Sortable/sse.js once actually needed, `layout` partials) with `CacheFirst` or `StaleWhileRevalidate`; keep `NetworkFirst` (with a short `networkTimeoutSeconds`, e.g. 2-3s to match the bg-removal routes) only for HTML navigations and htmx fragments that carry live data. Set real `maxAge`/immutable headers on the versioned static assets in `main.ts` so the HTTP cache and the SW cache agree instead of both being defeated by `max-age=0`.
**Effort:** M.

### Finding 2 — Visiting any garment detail page silently downloads and preloads a 42MB ONNX model, whether or not the user is changing the photo
**Where:** `views/wardrobe/show.hbs:177` imports `public/js/background-removal.js` on every garment detail page that has edit permission; `background-removal.js:82` does a top-level `await import('/modules/background-removal/index.mjs')` and the bottom of the file (`background-removal.js:247`) unconditionally calls `initBackgroundRemoval()`, which calls `mod.preload(config)` (`background-removal.js:87-97`). `config.model = 'isnet_quint8'`, which per `node_modules/@imgly/background-removal-data/dist/resources.json` is **42.3MB**, plus the ONNX runtime WASM/JS itself.
**Why it matters:** This runs on page load, not on user intent — opening a garment to just read its notes or mark it worn triggers the same multi-MB download as actually uploading a new photo. It ignores the `bgRemovalEnabled` localStorage toggle (only checked inside the `change` handler, after the preload already ran) and ignores connectivity state entirely — no "slow connection" deferral, no way to skip it. On mobile data this is a real cost paid on the single most-visited page in the app (the garment detail view), for a feature most visits never use.
**Fix:** Don't import `background-removal.js` from `show.hbs` at all (or don't self-invoke `initBackgroundRemoval`); defer both the dynamic `import()` and `preload()` until the user actually interacts with the photo/camera input or clicks "Edit mask" — i.e. move the eager IIFE and the `mod = await import(...)` at module scope into `wireUpPhotoInput`'s first real use, gated by `isBgRemovalEnabled()`.
**Effort:** S.

### Finding 3 — The one image endpoint actually rendered in the UI is sent `Cache-Control: no-store`, so it can never be offline or bandwidth-cheap despite being a static, precomputed file
**Where:** `src/file/controller/file.controller.ts:76-84` (`GET /file/nobg/:fileName`, used by `views/wardrobe/index.hbs:31` grid thumbnails and `views/wardrobe/show.hbs:154` detail image — i.e. every garment photo shown anywhere in the app) sets `Cache-Control: no-store` explicitly, and the fallback-redirect branch also forces `no-store`. Compare `GET /file/:fileName` (the *original*, rarely displayed directly) which correctly gets `public, max-age=31536000, immutable` at `file.controller.ts:62`. `getNobgVariant` (`src/file/file-service.abstract.ts:23-31`) just streams a pre-stored derivative from disk — it is not computed per request, so there's no correctness reason for `no-store`.
**Why it matters:** Two compounding effects: (1) every wardrobe grid view re-fetches every garment photo over the network — no browser cache, no SW cache (the SW deliberately uses `NetworkOnly` for `/file/**` and relies on the HTTP cache per its own comment at `src-sw.ts:41-45`, which `no-store` defeats). (2) It directly breaks the CLAUDE.md-mandated "offline reads render from cache" behaviour for the single most common read in the app — garment photos are unavailable offline even though the SW's own design assumed they'd be cached via HTTP headers.
**Fix:** Give `/file/nobg/:fileName` the same `public, max-age=31536000, immutable` as `/file/:fileName` (it's already named by content, i.e. `<fileName>-nobg.webp`, so it's as immutable as the original). If mask edits need to bust the cache, change the filename/hash on edit rather than relying on `no-store`; `wireUpEditMaskBtn` already renders the new image from an in-memory blob URL after edits (`background-removal.js:227-229`), so removing `no-store` doesn't even affect that flow.
**Effort:** S.

### Smaller items worth fixing alongside the above
- **Grid images have no `loading="lazy"`, no `width`/`height`, and reuse the full 1080×1080 derivative for 160px cards** (`views/wardrobe/index.hbs:31`). No layout-shift protection and no thumbnail-sized variant for grids. Effort S (attributes) / M (a second, smaller derivative).
- **Sortable.min.js (45KB) and sse.js (9KB) ship globally for a single non-core page each** (outfit reorder; `/chat`, which isn't part of the wardrobe/outfit/calendar surface at all). Move both to per-page `<script>` tags in `outfits/form.hbs` and `chat.hbs` respectively. Effort S.
- **The navbar's `#offline-indicator` is not a connectivity indicator** — it's an `htmx-indicator` spinner that only shows while an htmx request is in flight (`views/partials/navbar.hbs:33-38`). There is no `navigator.onLine`/heartbeat-based connectivity detection anywhere in the codebase, so the mandatory "connectivity is active, not passive" and "persistent offline banner" rules from `frontend-pwa.md` are unimplemented, not just imperfect. Effort M.
- **`hx-boost` swaps the whole `<body>`**, so navbar/dock/drawer state (open/closed) is not preserved as a persistent shell across wardrobe/outfits/calendar navigations — every nav reparents them. Minor given daisyUI's drawer is stateless today, but works against "shell state survives navigation." Effort M if it becomes worth fixing (`hx-select`/OOB swap of just `<main>`).
- **Two separate `<meta name="htmx-config">` tags** (`layout.hbs:42` and `:44`) instead of one merged JSON object — fragile if a third setting is ever added and someone doesn't realize htmx only reads the first (or last, depending on version) tag with that name. Effort S.
- **No visible "update available" UI** despite a working update-detection mechanism (`layout.hbs:105-134`); updates apply on the next navigation with zero user-facing signal. Effort S to add a toast on `wb.addEventListener('waiting'/'controlling', ...)`.
- **`viewport-fit=cover` is set on the viewport meta tag** (`views/layout.hbs:10`), which `frontend-pwa.md` explicitly calls out as a recurring bug: iOS standalone mode handles safe areas automatically, and this flag causes content to render under the home indicator. Drop it (leave `viewport-fit` unset) unless there's a confirmed reason it's needed. Effort S.
- **Precache manifest includes the 8 onboarding screenshots (~900KB)** that are never rendered inside the app (`workbox-config.js:3` glob is unscoped under `public/assets/`). Narrow the glob or move screenshots outside `public/`. Effort S.

## 4. What's fine
- Tailwind's `content` glob (`tailwind.config.js:3`) correctly covers `./views/**/*.hbs`, so `bundle.css` isn't bloated or missing classes; daisyUI theming is used consistently and no hardcoded colors were found in the templates reviewed.
- `background-removal.js` and `mask-editor.js` are properly scoped client JS (only loaded on the one page that needs them) with a clearly stated reason (client-side ONNX inference can't be server-rendered) — good adherence to the "client JS needs a reason" convention, Finding 2 is about *when* it runs, not *whether* it should exist.
- `/file/:fileName` (original photo) and `/file/watermark/:shareableId` have sensible, deliberate `Cache-Control` headers.
- `pulltorefresh` is correctly gated to `iosStandalone` only, and pinned below the fixed navbar via `.ptr--ptr` CSS overrides.
- The catch handler correctly special-cases `request.destination === 'document'` to serve `offline.html` rather than a generic error.
