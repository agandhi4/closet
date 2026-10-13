# Maintenance: timers, reconciliation and the CLIs

## Layout

```
  maintenance/         reconcile.ts (reconcileStorage: storage and the file table kept in step, with
                       the deletion guard; abandoned pending photos in a pass of their own), nightly.ts (a daily timer at an APP_TIMEZONE hour, started
                       by server.ts when MAINTENANCE_ENABLED), minutely.ts (a timer a second past every
                       minute, or every `everyMinutes`, never overlapping: the push reminders, the
                       week's re-plan, the order mail's poll, Muse's quiet round close),
                       scheduled.ts (what both timers share: ScheduledJob, whose stop() waits for a
                       run in flight at most STOP_WAIT_MS, and stopBeforeClose, the preClose hook
                       that stops them all before the pool ends), cli.ts (runCli: config, logger, schema check,
                       pool, exit status), reconcile.cli.ts (`npm run maintenance:reconcile`),
                       set-password.cli.ts (`npm run user:set-password -- <email>`): the locked-out recovery,
                       revoke-push.cli.ts (`npm run push:revoke-all`): every push subscription, after
                       a secret rotation
```

## Commands

```
npm run maintenance:reconcile [-- --dry-run] [--force]
                              # one storage reconciliation pass from dist/ (build first). On linux-box:
                              # docker exec closet npm run maintenance:reconcile. Exits 3 when the
                              # guard refused; --force deletes anyway (dry-run first). Like set-password it
                              # never migrates: a database behind the build is refused (start the server first)
npm run user:set-password -- <email>
                              # sets a locked-out user's password (read without echo, or piped
                              # stdin), signs out their sessions, revokes their access tokens and
                              # push subscriptions. On linux-box:
                              # docker exec -it closet npm run user:set-password -- <email>
npm run push:revoke-all       # removes every account's push subscriptions: the step after rotating
                              # ACCESS_TOKEN_SECRET (Deployment). docker exec closet npm run push:revoke-all
```

## Statements per run

What each job sends to Postgres (#173). Production pays a round trip per statement over the WiFi link (homelab #40), so a statement inside a loop over people or rows multiplies it: **read per batch, compose per person**. A job that loops per person keeps its per-person isolation (one person's failure is logged and counted, never the others'), and only reads that serve everyone move out of the loop. `test/integration/job-statements.spec.ts` pins each count for one person (or row) and for three; the page audit's `#173` steps measure them on the demo (`docs/perf/README.md`).

| Job | Statements | Scales with | Whole-table reads |
| --- | --- | --- | --- |
| Morning reminders | 5 + 6 per person (+1 undressed day: the ideas) | people due; re-plan and Today stay per person | `user_device` rows with a reminder (a household's handful, no index) |
| Evening reminders | 4, or 3 when all wore something | nothing | as above |
| Reminders, nothing due | 1 | nothing | as above |
| Week re-plan | 2 + 5 per person due (+ writes per swap or kept entry) | people due | none |
| Forecast refresh | 1 (+1 upsert per location fetched) | locations, not people | none |
| Cutout job | 8 per photo (claim 4, result 4), +3 for the look that finds the queue empty | photos | none (indexed claim) |
| Cutout retry | 1, or 5 when anything failed | nothing | none |
| Reconciliation | 3 (+1 per orphaned row, +1 per aged pending photo) | findings, which are rare | `pending_photo` and `file` (with `garment` and `selfie` for the references): the job is comparing storage with every row |
| Order mail poll | 2, or 1 + per new email: 1 (no products) or 4 | new emails | none |
| Prunes (reminder, re-plan claims) | 1 each | nothing | none |
| Muse round close | 1, + 4 per round closed (`finishRound`: begin, lock, round, commit) and 1 for the batch's devices | rounds left open, which are rare | none (`quietRounds`: Muse's rows only, partial indexes) |

The morning reminders read the mornings' forecasts (`refreshForecastsFor`), who of them is due a re-plan (`replanCandidates` with their ids) and the evenings' days (`eveningDays`) once for the minute, in parallel, then send every message in one batch (`PushSender.sendEach`: the devices of all of them read in one statement at send time, never earlier, so a device revoked or moved meanwhile gets nothing). The re-plan's transaction reads its auto entries with the day's claim in one statement (`claimAutoEntries`, a data-modifying CTE) and its week, pool, memory and outfits' garments in a second (`weekSql`, `outfitGarmentStatesSql`). The cutout job's per-photo 8 is the lease's price: the claim and the result each lock the row, ask the state machine and write (see Background removal). Reconciliation's per-row deletes stay per row on purpose (`removeOrphanedRows`: one bad row must not cancel the sweep).

## Gotchas

- **Reconciliation refuses wholesale deletions.** It deletes photo sets whose `file` row is gone, so a database that lost its rows (a restore, the wrong `DATABASE_*`) would have it wipe every photo. `guardRefusal` (`src/maintenance/reconcile.ts`) stops a run that would delete anything while the file table is empty and storage holds photos, more than 25 sets, or (above 5 sets) more than a fifth of the stored ones: it logs a warning, deletes nothing, reports `refused`, and the CLI exits 3. `--force` is the operator's override after a `--dry-run`. `test/integration/reconcile-guard.spec.ts` covers each rule. Pending photos are explained, not counted, and removed past their cutoff (the run's, or a week for a batch's drafts, #200: `pendingCutoffs`; see the link import gotcha above; `link-import.spec.ts` reconciles 27 abandoned imports and then a real mismatch). A live photo's day-old cutout and thumb files under another variant key than its row's (a cutout write that died before its swap, #141; see Images) are deleted as `supersededVariantsDeleted` and do count, one set per photo.
- **A database restored behind its storage never costs a cutout** (#141). After a restore from a backup older than some cutout edits, those rows name older variant keys than the newest files on disk. The superseded pass therefore deletes a set with a cutout only when all its files are day-old and older than every file of the set the row points at. A set newer than the row's is kept and logged at warn (`Keeping variant key <k> of <photo>: newer than the row's variant (key <k'>): database restored behind storage?`); a row whose own set is not in storage deletes nothing of that photo (`Keeping every variant of <photo>: ... not in storage`). No operator step: the photo shows its row's (older) cutout, the newer bytes stay on disk until someone points the row back (`update file set variant_key = '<k>', version = version + 1 where file_name = '<photo>'`) or edits the mask again. The guard stays as the second line. A superseded key holding only a thumb goes once day-old whatever its age against the row's set: a thumb is derived (regenerable from its nobg), never the one copy of anything, and a thumb backfilled across a swap is exactly that, newer than the set the row points at; a lone superseded nobg is a cutout and is kept like a whole set. `reconcile.spec.ts` covers each case.
- **Only the server schedules the nightly reconciliation, the push reminders and the week's re-plan.** `serve()` (`server.ts`) starts `scheduleNightly` (03:00 in `APP_TIMEZONE`, recomputed after every run, never overlapping) when `MAINTENANCE_ENABLED` (reconciliation) and always (the cutout retry), with `PWA_ENABLED` the reminders' `scheduleMinutely` and their claims' nightly prune, and always the re-plan's and its prune (without `WEATHER_ENABLED` it still judges availability) and Muse's quiet round close (`closeQuietRounds`, `src/web/wishlist/round-end.ts`; notified only with `PWA_ENABLED`); `createApp()` does neither, so the integration harness and the CLIs never hold a timer or send a notification. A spec runs one minute's reminders with `sendDueReminders(deps, now)`.
- **Every timer is stopped and drained before the pool ends** (#78). Both schedulers return a `ScheduledJob` (`src/maintenance/scheduled.ts`): `stop()` clears the timer, so no run starts after it, and waits for a run in flight, at most `STOP_WAIT_MS` (15 s, `settlesWithin`), after which it logs `<job> still running after 15000 ms; stopped` and resolves; it never rejects. `serve()` collects every job it starts into one list and hands it to `stopBeforeClose`, a single `preClose` hook that stops them all together (one bound in all, not one per job) and logs `Stopped N scheduled jobs in T ms` (context `Scheduler`); `createApp()`'s `onClose` (the cutout queue, then the pool) runs only after it. Until #78 the nightly jobs' `stop()` only cleared the timer and ran in `onClose`, so a reconciliation in flight at a 03:00 deploy lost every later query to the ended pool. An abandoned run is safe by each job's own design (claims before work, rows before bytes). A new timer is pushed onto that list, never given a hook of its own, and its run is wrapped in `metrics.timeJob(<JobName>, run)` (job_duration_seconds; see Metrics). `scheduled.spec.ts` closes a real Fastify instance with runs in flight.
- **The CLIs never migrate.** `runCli` (`src/maintenance/cli.ts`) checks `requireCurrentSchema` first and exits 1 with "The database is N migration(s) behind this build. Start the server..." when the image is newer than the database. A recovery tool run beside a live server must not change the schema under it (until 2026-09-26 they booted the whole app, migrations included). `test/integration/migration-runner.spec.ts` covers the check.
