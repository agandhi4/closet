# Performance audit, 2026-09-25

Raw reports from the audit that drove the performance program (see CHANGELOG "Unreleased" and
docs/PROJECT_LOG.md for what shipped). Each file was written by a separate read-only pass;
file:line references are as of commit e6a5ca3 or earlier and may have moved.

- `audit-data.md` — data layer: per-page query table, indexes, transactions
- `audit-request.md` — request lifecycle, auth duplication, ownership checks, boilerplate
- `audit-frontend.md` — client assets, service worker caching matrix, PWA UX gaps
- `audit-images.md` — upload/read/delete lifecycle of garment photos
- `audit-measure.md` — baseline numbers (150 garments) before any change
- `audit-remeasure.md` — the same measurement after the program, with before/after tables

Items from these reports that were deliberately left open are listed at the end of the
project memory / in the "Left open" section of the program summary: NotificationController
test endpoint without a UI, hx-boost swapping the whole body (shell state not preserved),
postLogin rendering failures as 201, load-test script without a base URL override.
