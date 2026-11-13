# Offline writes: wears, washes and packing ticks queue and sync (#178)

Status: approved by the owner 2026-11-13 (scope 2026-11-12), with every recommendation: the laundry batch queues; sign-out with unsynced changes confirms, then discards; replays apply within 7 days.

Scope (`docs/decisions.md` 2026-11-12, "The whole backlog is approved"): wears, washes and packing
ticks queue offline and sync on reconnect, last write wins; a new garment with its photo stays online.
It builds `2026-09-28-caching-and-offline.md` 3(b) on `2026-11-12-json-api.md`'s idempotency model, and
is the recorded exception to frontend-pwa.md's "unreachable writes are disabled, never dropped".

## 1. What the PWA does offline today

- **Reads.** Precached statics; the four tab roots stale-while-revalidate; every other page and htmx
  request NetworkFirst (3 s) in `pages-v2`; the daily warm (`offline-warm.md`) holds every garment and
  outfit page, next week and the grid; each copy shows its age (`freshness.js`).
- **Writes.** `connectivity.js` (`HEAD /health/live` every 30 s, on `htmx:sendError`/`responseError`,
  5 s while offline) sets the real `disabled` on every control in a `[data-needs-network]` zone and
  marks it `data-offline-disabled`; every `PostForm` and `AutosaveForm` carries the marker, and
  `test/offline-writes.spec.ts` holds every PostForm on a page to it (#411). Nothing is queued.
- **The gap.** Until the next probe (up to 30 s) a write stays enabled: an htmx post fails
  (`sendError`), a native one lands on the offline page. Only the auth POSTs go through the worker.

## 2. What queues, and what stays disabled

| Write | Route | Control today | Writer |
| --- | --- | --- | --- |
| Wore today, and its undo | `POST /wardrobe/:id/wear` (`worn=1\|0`) | htmx, `#garment-wear-status` | `setWoreToday` |
| Washed | `POST /wardrobe/:id/washed` | htmx, same region | `markWashed` |
| Laundry's batch | `POST /laundry` (`ids`) | `PostForm` | `markWashed` |
| An entry worn, and Undo | `POST /calendar/:id/worn` (`worn=1\|0`) | `WornControl`: the calendar's pill (htmx), Today's and a trip's (`PostForm`) | `setEntryWorn` |
| A packing tick, an extra's tick | `POST /trips/:id/packed`, `/items/packed` | `AutosaveForm native` | `setPacked`, `setItemsPacked` |

Everything else keeps `data-needs-network`, notably: Away (an autosave with a note), a trip's "Wore it"
for an outfit with no entry yet (`createUrl`: it plans an entry, and `outfit_calendar.client_id` is
#196a's), Today's "Wear this" (creates an outfit), adding or removing extras, every garment create or
edit, every photo. A queued control carries `data-offline-queue="<kind>"` instead; `guardWrites` skips it.

## 3. The queue (the outbox)

- **The page owns it, not the worker.** iOS has no Background Sync, so the worker cannot replay with
  the app closed, and a second Chromium-only path is not worth it (caching plan 3b). The page module
  `outbox.js` writes and replays; the worker only deletes records at session boundaries (section 6).
- **IndexedDB** (the Cache API stores GET responses, not bodies to send): `closet-outbox`, store
  `writes`, indexed by `key` and `account`. **Record:** `{ id (uuid), account, kind, key, path,
  fields, label, queuedAt, attempts, state: 'pending' | 'failed', reason? }`. `key` collapses (`wear:41:2026-11-12`, `wash:41`, `entry:88`, `packed:7:41`, `item:7:3`); `fields` are
  the form's fields plus `day`; `label` is the garment or trip name, from the control's `data-*`, for
  the notices.
- **Collapse, last intent wins.** Enqueue deletes the record with the same `key` and puts the new one
  in one transaction: Wore then Undo offline replays only the undo; two washes keep the later day (laundry's batch is a
  `wash:<id>` per garment, replayed through `/wardrobe/:id/washed`). A
  packing tick is one record per item, so the replay posts `shown` as just the changed items and
  `packed` as those ticked: the checklist protocol (`src/web/checklist.tsx`) then changes only those,
  which is per-item last write wins, never a stale snapshot of the whole list.
- **The day is the tap's.** `day = todayIn(APP_TIMEZONE, tap time)` in the page (the zone from
  `#app-status`), never the server's day at replay: a Sunday-night wear replayed Monday is Sunday's. A
  cached page rendered on another day than the tap refuses to queue Wore today (its state is that
  day's), with a reason.
- **When it enqueues.** A queueable submit while `connectivity` is not `online` (htmx: `htmx:confirm`
  cancelled; native: a capture-phase `submit`, before `submit-once.js` disables the buttons), and an
  htmx queueable request that ends in `htmx:sendError` (it may have been applied; the replay is
  idempotent). A native post in the undetected window still lands on the offline page, as today.
- **Replay** on `connectivity:change` to online, on every page load, and on `visibilitychange` to
  visible once the probe says online (the triggers iOS has). One drainer across tabs
  (`navigator.locks`, `ifAvailable`); records in `queuedAt` order, one at a time; a network error or
  5xx stops the drain and keeps the rest in order, retried with backoff (5 s doubling, at most 5 min);
  a 401 stops it. Cap 200 pending: past it the control is disabled with a reason.

## 4. Idempotency on the server

- **One model with the JSON API.** Every queued write sends its record id as `Idempotency-Key`,
  accepted and logged, never stored (api plan section 2). The one create, Wore today's `worn=1`, also
  posts it as `clientId`; `garment_wear.client_id` arrives with #196a and `setWoreToday` stores it
  then. Until then the `(garment, day)` unique index makes a retry a no-op anyway. Everything else is
  set-state, idempotent by meaning, as the API's PUTs on the same writers will be.
- **Explicit `day`** (optional, `IsoDateSchema`) on `/wear` and `/washed`, accepted from
  `today - 7` to `today`: older is a 409 `too-old`, later a 409 `future`. Without it, the server's today
  as now. `markWashed` becomes `greatest(last_washed_on, day)`, so a late replay never moves a wash
  back. The entry worn needs none: the entry has its day, and its wears are dated by it.
- **A replay** carries `X-Closet-Queued: <account>`. A root preHandler for routes marked
  `config: { queueable: '<kind>' }` (`src/web/offline-writes.ts`, beside the pure kind list in
  `src/offline-writes.ts`) refuses a mismatch with the session's user, 409 `account`, nothing written.
  The route then answers a replay `204` with `X-Closet-Outcome: changed | unchanged`, not the fragment
  or the 303's page (5 to 30 statements over the WiFi link). An already-applied replay is an ordinary
  `unchanged` 204: there is nothing to look up.
- **Last write wins, toggles included.** Wear and entry worn have undos; the last replay to land sets
  the state, on any device. Washed has no undo, so it is monotone.
- **Gone targets** answer what they answer today: a deleted garment, entry or trip is 404; a wishlist
  item 409. The client never treats them as done silently (section 5). A tick on a garment that left
  the trip's list is moot (`setPacked` marks only listed garments) and is logged, like every replay:
  `Garment 41 worn on 2026-11-09 by user 3 (replayed, queued 2 h ago, key 1a2b3c4d)`.

## 5. The UI

- **Optimistic, from server markup.** Each queued control renders its other state in a `<template
  data-outbox-state>` beside it (Wore today ↔ "✓ Worn today" and Undo; Wore it ↔ ✓ Worn), so the page
  only picks which to show and no state is drawn by script. Counts ("Worn 12 times") stay the server's
  until the sync. A packing checkbox is its own optimistic state.
- **Per item:** `data-outbox="pending"` on the control's region shows a muted "Waiting to sync" with a
  clock; reapplied on every page load from the pending records (a cached page reopened offline).
- **Global:** the connectivity banner gains "N changes waiting to sync"; online with records it reads
  "Syncing N changes" only past 2 s (frontend-pwa.md), then the back-online toast says "N changes
  saved".
- **After a sync:** the chips go, the page asks `REVALIDATE_PAGE` (swapped in only if untouched), and
  the worker refetches the affected paths' cached copies (`OUTBOX_SYNCED`, through `pages.handleAll`)
  so a warmed garment page does not reopen with the old state.
- **A failure stays visible.** A 404, 409 or 400 moves the record to `failed`, and a dismissible notice
  in `#app-status` lists it: "Navy chinos, Wore today: not saved, the garment was deleted." It goes on
  Dismiss, never on its own. A 401 keeps everything pending: "Sign in to save 3 changes". Strings:
  `outbox.*` in `lang.json`, passed as `data-text-*` on `#app-status` like the banner's.

## 6. Accounts and sessions

- **A record is its account's.** `account` is the page's (`data-account` on `#app-status`, the id
  `X-Page-Account` already sends). The drainer replays only the current page's account; the server's
  account check (section 4) is the guard if that ever fails.
- **Another account's page deletes the others' records** (page load, and the worker's `claimPageCache`
  for a different account): counted in the console, never shown to the new account. A signed-out page
  (the login page after a revoked session) deletes nothing, so signing back in as the same account
  replays them.
- **Sign-out** drains first (it is online by definition). What is left (failed, or a 5xx) is named in
  a confirm, "3 changes have not synced. Sign out and discard them?", then deleted; the worker's logout
  and account-deletion boundary deletes the store too (on an old worker, the page's rule is the backstop).

## 7. Security

- Replays are same-origin `fetch` POSTs from the page: they carry `Origin` and the cookie, so the CSRF
  hook applies unchanged. The worker sends nothing.
- `outbox.js` replays only a `path` that resolves on `location.origin` and matches a queueable kind's
  pattern (the list the routes' `config.queueable` names; a spec holds them equal); anything else is
  deleted, logged. The store holds no header, credential or email.

## 8. Tests

- **Integration** (`test/integration/queued-writes.spec.ts`): each route replayed twice, one row and
  `204 unchanged`; an explicit day lands on that day, 8 days back is `too-old`, tomorrow `future`;
  `greatest` on wash; a packing replay changes only its `shown` items beside another tick; the
  account mismatch writes nothing; a deleted garment, entry and trip 404; a replay without `Origin` is
  403; the queueable list equals the routes' config. Statement budgets: a replay is the writer's
  statements plus the session.
- **Unit:** the collapse keys, the day, the answer table and the allowlist are pure (`src/offline-writes.ts`),
  bundled into `outbox.js` from `views/assets/outbox.ts` by the worker's esbuild step.
- **Browser:** `test/offline-writes.spec.ts` absorbs it (the cap stays ten): offline, Wore today and a
  tick stay enabled and show pending and the count; online they sync and a reload shows them; a deleted
  garment's wear shows the notice; another account's sign-in deletes a record unsent. WebKit nightly.

## 9. Slices

- **178a, server:** `day`, `clientId`, `Idempotency-Key`, `config.queueable`, the account preHandler,
  the 204 replay answer, `greatest` on wash; the integration spec. Ships alone: no page sends them yet.
- **178b, the outbox:** `outbox.ts` and its pure rules, `data-offline-queue` and the templates on the
  five controls, the indicators and notices, sign-out's drain; `offline-writes.spec.ts`; the exception
  written into the root AGENTS.md project rules, Wears, Trips and `src/web/shell/` docs, with a
  `docs/decisions.md` entry.
- **178c, the worker:** deletion at claims and the logout boundary, `OUTBOX_SYNCED`'s refetch;
  `session-caches.md`.

## 10. Owner decisions

1. **Laundry's batch** queues too (recommended: laundry day is where the signal is worst), or only
   the garment page's Washed.
2. **Sign-out with unsynced changes:** confirm and discard (recommended), or refuse to sign out
   until they sync.
3. **The late-replay window:** 7 days (recommended), after which a queued wear asks to be added from
   the calendar.
