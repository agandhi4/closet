# Caching and offline (2026-09-28)

Issue #178, part of #156. This doc covers what the PWA caches today, what to change in HTTP caching,
how to read offline beyond the pages already visited, and the owner's options for writing offline.
**This is the plan only.** The owner decides on offline writes (section 3) before anything is built,
and the issue stays open for the build.

**The constraint that shapes it.** Production's server reaches its database over WiFi (homelab #40:
114 ms average RTT, up to 1.1 s, with loss). Every request that reaches the server pays at least one
statement (the session row, `src/web/security/CLAUDE.md`), and a page pays 5 to 30. So the saving that
counts is a request that never reaches the server. Saving bytes between the phone and the server counts
for much less.

## 0. Today (measured)

The measurements come from the production build (`NODE_ENV=production`, `PWA_ENABLED`), run with
`start:test` on a throwaway database seeded with the demo persona (83 garments, 26 outfits). The
headers were read with curl.

| Route class | Cache-Control | Validator | Vary | On the wire (br) | Stored (decoded) |
| --- | --- | --- | --- | --- | --- |
| Static `/js`, `/modules`, `/vendor`, `bundle.css` (`?v=`) | `public, max-age=31536000, immutable` | weak ETag, Last-Modified (304 works) | Accept-Encoding | 2.5 KB (`pwa.js`), 20 KB (`bundle.css`) | precache 22 files, 370 KB |
| `sw.js`, `manifest.json` | `no-cache` | ETag on `sw.js` only (304 works per encoding) | Accept-Encoding | 11 KB, 1 KB | |
| `/file/{thumb,nobg,}/<uuid>.webp?v=` | `public, max-age=31536000, immutable` | none (`If-None-Match` gets a 200) | none | thumb 2.5 KB, cutout 5.9 KB (seed art) | |
| `/file/watermark/:id` | `public, max-age=86400` | none | none | | |
| `/selfies/*` | `private, max-age=31536000, immutable` (not measured: from `src/web/selfies/CLAUDE.md`) | | | | |
| Pages (`/`, `/wardrobe`, `/wardrobe/:id`, `/outfits/:id`, `/calendar`, `/offline.html`) | **none** | **none** | Accept-Encoding, plus `HX-Request, HX-Boosted, HX-History-Restore-Request` on `/wardrobe` | 4.8 to 8.6 KB | garment 27 KB, outfit 41 KB, `/wardrobe` 54 KB, `/outfits` 62 KB, `/calendar` 60 KB, `/styling` 73 KB |
| Fragments (`/wardrobe` fragment, `/wardrobe/tiles?before=`) | none | none | as above | 4.9 KB, 1.5 KB | |
| `/healthz` | `no-store` | | | 0 | |

The service worker (`views/assets/src-sw.ts`, `src/web/shell/CLAUDE.md`):

- **Precache.** It precaches public/ by content hash.
- **Tab roots.** The four tab roots open stale-while-revalidate.
- **Every other page and fragment.** These are NetworkFirst with a 3 s timeout. They go in `pages-v2`,
  which holds 50 entries and one account's pages.
- **Images.** `/file/**` images are CacheFirst in `images-v1` (500 entries, 30 days).
- **Offline.** Writes are disabled while offline (`data-needs-network`).

Three findings shape the plan:

1. **An image the device lacks costs a database round trip.** Every `/file/*` request runs
   `publicPhoto`, one statement, to refuse selfies and read the variant key. The wardrobe's first
   page shows 48 thumbs, so a cold grid costs 48 statements over the WiFi link.
2. **`images-v1` outlives the session.** Sign-out drops `pages-v2` but keeps the photos
   (`src/web/security/CLAUDE.md`, Logout). That was acceptable because only visited pages' photos
   were there. It stops being acceptable once we warm the whole wardrobe.
3. **`pages-v2` holds 50 entries.** A warmed wardrobe of 83 garment pages would evict the tab roots.

## 1. HTTP caching: today versus possible

| Route class | Change | What it saves |
| --- | --- | --- |
| Static, `sw.js` | None. Already immutable, precompressed and precached. | |
| `/file/*` photos | In the worker, **drop `maxAgeSeconds`** from `images-v1` and size it by entries (section 2). The URLs are immutable, so an age limit only forces a refetch, and each refetch is a statement. | one statement per photo per month, per device |
| `/file/*` photos | No ETag. Browsers never revalidate `immutable`, and the worker never asks. | |
| Pages and fragments | Send **`Cache-Control: private, no-cache`** from `send()` (`src/web/render.ts`). Today the header is missing: nothing may store an account's page in a shared cache, and any browser cache must revalidate. `no-cache` keeps the back-forward cache (`no-store` would block it). | correctness, not speed |
| Pages: short `max-age` | **No.** The worker's fetch goes through the HTTP cache, so a page cached for even 10 s would hide the user's own write, which `HX-Location` lands on at once. | |
| Pages: body-hash ETag (304) | **Not on its own.** The server still renders the page, all 5 to 30 statements, to hash it. It saves 5 to 9 KB of transfer, and the phone's link is not the bottleneck. | bytes only |
| Pages: **revision ETag** (later) | A per-owner `revision` on the `user` row, bumped by a trigger on every owned table. `ETag = hash(build, viewer, revision of each wardrobe shown, household date)`. The session gate already reads that row, so a 304 costs **zero extra statements** instead of a render. Today and anything showing weather is excluded. Build it with #196 (incremental sync), whose change cursor it is. | a whole render per tab root revalidation, per revalidation after reconnect, and per warm refresh |

The one HTTP change that saves database round trips is the revision ETag. Without it, a tab root
revalidation still renders. Section 4 explains why it waits for #187 and #196.

## 2. Read offline: warm the page cache

**What is warmed.** Only the signed-in user's own wardrobe:

- the four tab roots;
- the calendar's current week and the next one (`/calendar?week=<next Sunday>`, the planned week);
- each wardrobe garment's page (`/wardrobe/:id`, archived ones excluded);
- each saved outfit's page (`/outfits/:id`);
- the wardrobe grid's later tile pages (`/wardrobe/tiles?before=`, as htmx requests, so they land under
  their `|hx` key);
- the thumb of every garment and outfit on those pages.

The following are **not** warmed:

- cutouts (`nobg`). Offline, the worker answers a missing `/file/nobg/<name>?v=` with the cached thumb
  of the same name and version, so the garment page still shows the garment, scaled up;
- selfies (private, and left to the HTTP cache);
- Today, which is day-specific and NetworkFirst, and is what the app has just loaded anyway;
- shared wardrobes, where the visited pages are what's available offline, as today.

**How.** The server sends the list, and the worker fetches it through the page cache's own strategy:

- **The list.** `GET /offline/warm` (session-gated, `no-store`) answers `{ pages, fragments, images }`.
  It runs one query per kind and builds URLs with `garmentUrl`, `imageUrl(photo, 'thumb')` and the
  grid's own keyset cursor. It is part of the web shell, versioned with the worker. It is **not** part
  of `/api/v1` (section 4).
- **Pages.** The worker fetches each page with `pages.handleAll` and each image with `images.handleAll`,
  as `rewarmOfflinePage` already does for the offline page. The page plugins therefore apply: the
  generation check (#121), `claimPageCache` ownership, the stamp and the 200 filter. A sign-out in the
  middle of a warm stores nothing more. A routed `fetch` would not work: the images route matches only
  `destination === 'image'`.
- **Requests.** Two at a time. Each carries `X-Closet-Warm: 1`, so the request log and the metrics
  can tell warming apart from a person.
- **What gets fetched.** Only URLs without a copy, or with one older than 24 h. Pages on the
  `/wardrobe/:id` and `/outfits/:id` patterns that are no longer on the list (deleted, archived)
  are removed from the cache.
- **Logging.** Each run logs one line:
  `[sw] warmed 31 pages, 12 images in 8.2 s (78 fresh, 2 removed, usage 6.1 MB of 12 GB)`.

**When.**

- **Trigger.** The page's `pwa.js` posts `WARM_PAGES` after `load` when all of these hold:
  - the page is visible and online (`connectivity.js` state);
  - `navigator.connection?.saveData` is not set;
  - the worker's `warmed-at` record is older than 24 h, or missing.
- **After sign-in.** The record lives in `pages-v2` under a `page-cache.invalid` key, like the owner
  record. Every drop (sign-in, sign-out, account change) takes it, so the first page after a sign-in
  warms the new account.
- **Staying in the foreground.** iOS has no Background Sync or Periodic Background Sync (below). A push
  can wake the worker, but WebKit requires every push to show a notification, so push is not a warming
  trigger. So warming runs only while the app is open, a few seconds at a time. It is resumable,
  because it skips fresh copies.
- **Wi-Fi.** "Only on Wi-Fi" cannot be detected on iOS: Safari has no Network Information API. The
  budget below is therefore kept small enough for cellular.
- **Idle.** `requestIdleCallback` is off by default on iOS Safari, so "idle" means after `load`, with
  the requests throttled to two at a time.

**Invalidation.** Online, every in-app tap is NetworkFirst and replaces the copy, so warming never
makes a page shown online older. Offline, a warmed copy is at most about 24 h old, and the freshness
indicator already says how old it is ("Updated 5 hours ago"). A write made online (Wore today swaps a
fragment) leaves that garment's warmed full page stale until the next visit or warm. That is acceptable
while offline writes stay disabled. Evicting a page's copy after a successful write under its path is a
follow-up if it bites.

**Storage budget.** The demo wardrobe is the owner's target size. Cache Storage keeps decoded bodies.

| Cache | Demo (83 garments, 26 outfits) | Cap |
| --- | --- | --- |
| Pages (decoded) | 4 roots about 250 KB, 2 weeks 100 KB, 83 garments × 27 KB = 2.2 MB, 26 outfits × 41 KB = 1.1 MB: **about 3.7 MB** | `pages-v2` 50 → **400 entries**; the list is capped at 300 garments and 80 outfits (most recently added or worn first) |
| Thumbs | 86 × 2.5 KB (seed art); real 400 px photos estimated at 20–30 KB: **about 2.2 MB** | `images-v1` 500 → **600 entries**, no age limit |
| Precache | 370 KB | |
| **Total** | **about 6.5 MB**; at the cap about 20 MB | warming stops when `navigator.storage.estimate()` reports usage above 50 MB |

Transfer: the first warm is about 0.8 MB of pages (br) plus the thumbs once, since thumbs are
immutable. Each later day is at most 0.8 MB, and nothing when nothing is older than 24 h. The cost
lands on the server: about 115 renders a device a day. Section 1's revision ETag would turn most of
them into 304s.

**iOS quota and eviction**, from WebKit's storage policy (Safari 17 / iOS 17 and later):

- **Quota.** An origin may use up to 60% of the disk in a browser app, 15% in other apps. A Home Screen
  web app has the same quotas as in the browser. Either is gigabytes, far above the budget.
- **Eviction.** It is whole-origin and least-recently-used: when the overall quota is exceeded, under
  storage pressure, or when the site has not been used for a while.
- **Persistent storage.** An origin in persistent mode is excluded from eviction.
  `navigator.storage.persist()` is granted "based on heuristics like whether the website is opened as a
  Home Screen Web App". So the installed app calls `persist()` once, standalone only, and logs the
  answer.
- **The 7-day cap.** ITP deletes a site's script-writable storage (Cache Storage and IndexedDB
  included) "after seven days of Safari use without user interaction on the site". A Home Screen web
  app is "not part of Safari" and has its own day counter, which its own use resets: WebKit does "not
  expect the first-party in such a web application to have its website data deleted". **So offline
  reading is dependable in the installed app only.** In a Safari tab, a week away empties it.

**Privacy.** The rules stay the same (`src/web/shell/CLAUDE.md`, Page cache ownership, #121, #131):

- one account per cache;
- the cache is dropped at every session boundary (`X-Session-Ended` included);
- every stored page is checked against the generation.

Two additions:

- **`dropPages` also deletes `images-v1`.** A warmed wardrobe's photos must not outlive the session
  on a shared device, even though their names are unguessable. The cost is re-downloading thumbs after
  a sign-in.
- **The warm list is the session's own wardrobe.** It is never computed from `?ownerId=`, so warming
  never widens what a grantee's device holds.

## 3. Write offline: options for the owner

The candidates are the two lowest-risk writes:

- **Wore today**: `POST /wardrobe/:id/wear`, `setWoreToday`, one row per (garment, day), `onConflictDoNothing`.
- **Washed**: `POST /wardrobe/:id/washed`, `markWashed`, sets `last_washed_on`.

Neither takes the owner lock. Both are already idempotent, **except that the server dates them with
its own today.** A Wore today queued on Sunday night and replayed Monday morning would record Monday.

| Option | What it is | Cost | Risk |
| --- | --- | --- | --- |
| **(a) Online-only** (today) | Writes are disabled offline, and the banner says why. | none | none; a wear forgotten in a basement is added later from the calendar |
| **(b) Small queue** | Wore today (and its undo) and Washed are queued in IndexedDB and replayed on reconnect. | about a week: server, queue, pending UI, WebKit e2e | low to moderate; see below |
| **(c) Broader offline editing** | Garment edits, outfits, calendar planning, photos. | months | high: it is a sync client inside an htmx app |

**(b) in detail.** It needs the following:

- **Explicit day.** The queued request carries `day`, the household date (`APP_TIMEZONE`, read from the
  page) at the moment of the tap. The server accepts it from `today - 7` to `today`. Anything older is
  a 409 the queue reports ("Too old to record: add it from the calendar"). `markWashed` sets
  `greatest(last_washed_on, day)`, so a late replay never moves a wash backwards. With the day explicit,
  both writes are idempotent by their own semantics: replaying one twice changes nothing.
- **Idempotency keys.** Each entry carries a UUID key, sent as `Idempotency-Key` and logged with the
  request, so a replay is traceable. No receipt table is built for (b). #187 decides the idempotency
  convention for the JSON API (the epic lists "no idempotent writes for offline use" as a gap), and (b)
  adopts it rather than inventing a second one.
- **Collapsing.** The queue keeps one entry per (garment, action, day). The last intent wins, so
  Wore today then Undo, offline, replays as nothing.
- **Replay.** Replay is driven by the page, on `connectivity:change` to online and on `load`. The page
  replays in order and stops at the first network failure. Same-origin POSTs from the page carry
  `Origin`, so the CSRF hook passes. iOS has no Background Sync, so replay happens only when the app is
  open. Chromium could use Background Sync, but a second replay path is not worth it: one path, the
  page.
- **Answers.**

  | Answer | Meaning | What the queue does |
  | --- | --- | --- |
  | 2xx | saved | drops the entry |
  | 404, 403, wishlist 409 | the garment was deleted, un-shared, or is not owned | drops it and says so in a toast |
  | 503 `OwnerLockTimeout`, 5xx, network | contention or failure | keeps it for the next reconnect; the owner lock is contention working as designed, not a conflict |
  | 401, or redirect to login | the session expired or was revoked while offline | keeps it and shows "Sign in to save 2 changes" |

- **Account.** Each entry records its account (`X-Page-Account` at enqueue time). It is replayed only
  when the current page's account matches, and the store is deleted at every session boundary. Sign-in
  as the same account replays it. Another account's sign-in discards it, because nothing crosses
  accounts, like the page cache. Sign-out itself needs the network, so a queue can only be lost by a
  session ending away from the device. The "Sign in to save" line says so.
- **UI.** The tapped control shows "Saved on this phone" and the garment page shows a pending line.
  The cached page itself still shows the old wear count until replay.

**Recommendation: (a) now.** Revisit (b) only if the owner actually misses Wore today while offline,
and build it after #187 fixes the idempotency convention. **Never (c) on the web.** Every table would
need versions and tombstones (the epic lists both as gaps), there would be a second renderer for
optimistic state beside the server's JSX, and conflict UIs. That work is the native client's sync
(#196), and doing it twice is the waste to avoid.

## 4. A native iOS app later (#186)

- **It reuses:**
  - the domain functions, and the JSON API built on them (`/api/v1`);
  - the immutable `/file/*?v=` photo URLs, cached by `URLCache` or the app's own store;
  - device tokens (#189);
  - the idempotency convention and the change cursor (#187, #196);
  - explicit-day writes. `setWoreToday` already takes a `day`; section 3(b) would only expose it.
- **It replaces:** the service worker, the page cache and its ownership rules, `freshness.js`, the
  warmer and `/offline/warm`, `connectivity.js` (with `NWPathMonitor`), and the IndexedDB queue. A
  native app keeps data in a local store synced by cursor, not HTML pages, and has an outbox with
  `BGTaskScheduler`.
- **Built once, not twice:**
  - The **revision** (section 1) is #196's change cursor: one trigger-maintained counter serves both web
    304s and native sync. Do not add a web-only one first.
  - The **idempotency convention** comes from #187, and a web queue adopts it.
  - `/offline/warm` stays a list of HTML URLs, internal to the shell. It must not grow into a second
    JSON API. Anything a program needs goes in `/api/v1`.
  - **No (c)** on the web.

## 5. Recommended first step: warm the owner's wardrobe for offline reading

One PR, shippable alone, with no owner decision needed. It is sections 1 and 2 without the revision
ETag, and it changes nothing about writes.

- **Server.**
  - `GET /offline/warm`, with the caps from section 2.
  - `send()` adds `Cache-Control: private, no-cache` to every HTML answer.
- **Worker.**
  - `WARM_PAGES` with the rules and the `warmed-at` record.
  - `pages-v2` goes to 400 entries; `images-v1` to 600, with no age limit.
  - The thumb stands in for a missing cutout offline.
  - `dropPages` also deletes `images-v1`.
  - One log line per run.
- **Page.**
  - `pwa.js` posts `WARM_PAGES` under the conditions in section 2.
  - It calls `navigator.storage.persist()` once when standalone and logs the answer.

**Acceptance criteria.**

1. After sign-in as the demo persona, with the device then offline, these open from the cache with
   their age shown: every garment page, every outfit page, the four tab roots, the current and next
   calendar week, and every wardrobe grid page scrolled. Each shows its thumbs.
   `test/offline-warm.spec.ts` (Chromium, with `networkSwitch` from `stale-pages.spec.ts`, since
   `setOffline` does not cut the worker's fetches).
2. A second open within 24 h warms nothing: the server log shows no `X-Closet-Warm` request. After
   24 h only the stale copies are fetched. A deleted garment's page is gone from the cache after the
   next run.
3. Signing out, or signing in as another account, empties `pages-v2` and `images-v1`, and a warm
   already running stores nothing after the drop (the generation check).
   `stale-pages.spec.ts` gains the images and mid-warm cases.
4. A grantee's warm list holds only their own wardrobe: an integration spec on `/offline/warm`.
5. Every HTML answer has `Cache-Control: private, no-cache`, and `/file/*` and static answers are
   unchanged (`delivery.spec.ts`).
6. The demo persona's warmed caches total under 10 MB (`navigator.storage.estimate()` in the spec),
   and the log line reports it.
7. `src/web/shell/CLAUDE.md` describes warming, the new caps and the images drop.

**Then, in order:** the owner's call on section 3. The revision ETag with #196. (b), if chosen, after #187.

## Questions for the owner

1. **Offline writes: (a), (b) or (c)?** The recommendation is (a) now. If (b), should it be only
   Wore today and Washed, or also the calendar's Worn pill? And is a 7-day window for a late replay
   right?
2. **Cellular.** iOS cannot tell Wi-Fi from cellular. Is about 3 MB on the first warm and at most
   0.8 MB a day acceptable on cellular, or should warming wait for a manual "Save for offline" in
   Profile instead?
3. **Cutouts offline.** Is the thumb, scaled up on the garment page, good enough, or should the
   cutouts be warmed too (an estimated 5–8 MB more at the demo size)?

## Sources

- WebKit, "Updates to Storage Policy" (Safari 17, iOS 17): quotas, eviction, Home Screen web apps,
  `persist()`. https://webkit.org/blog/14403/updates-to-storage-policy/
- WebKit, "Full Third-Party Cookie Blocking and More": the 7-day cap on script-writable storage,
  and its note on web apps added to the Home Screen. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- WebKit, "Meet Web Push": every push must show a notification, "not an invitation for silent
  background runtime". https://webkit.org/blog/12945/meet-web-push/
- Can I use, Background Sync (Chromium only; no Safari or iOS Safari through 27.2):
  https://caniuse.com/background-sync, and MDN's Background Synchronization API:
  https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API
- Can I use, Network Information API (none in Safari or iOS Safari): https://caniuse.com/netinfo
- Can I use, `requestIdleCallback` (off by default in iOS Safari 27.2): https://caniuse.com/requestidlecallback
