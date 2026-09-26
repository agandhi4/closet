# Project Log

This document is intended for the maintaining team to use to document decisions. This may be a medium for documenting, reviewing, and approving as a means of expressing consensus on project business decisions where the direct output is not necessarily code or assets that may be otherwise checked in and version controlled.

> **Example Entry (Date in ISO8601 format, Year-Month-Day):**
>
> The team agrees to _BLANK_ project business decision(s)...

## 2026-09-25

The fork becomes **Closet**, a private household app: rebranded (single upstream attribution kept per AGPL), marketing/privacy/terms pages removed, one account for now with registration locked.

Deployment decisions: pgvault Postgres over SQLite (nightly dumps, shared triage tooling); `https://closet.kashhq.dedyn.io` is the canonical URL because the PWA needs a secure context, `http://closet.box` is the plain twin; the image publishes on every push to `main` and the homelab autoupdater deploys it, so pushing `main` is deploying.

Performance program (audit, then six phases, all shipped the same day): image asset model with thumbnails and immutable versioned URLs; one session resolution per request; an in-process integration test tier run on SQLite and Postgres in CI; cache-first PWA shell and lazy model loading; indexes on every relation with concurrent Postgres backfill and transactional writes; boilerplate removal and a 54% smaller image; nightly storage reconciliation, HEIC support and safe user deletion. Grid image payload went from 28.6 MB uncached to 1.3 MB cached. Two production bugs found on the way: `garment.color` had become a smallint on Postgres, and an undecodable upload could crash the process.


## 2026-09-26

Program 2 (audit, then gate, correctness, simplification, speed), all shipped within two days. Record: `docs/audits/2026-09-25-program2/` (eight audits, `PLAN.md` with every decision, the background-removal benchmark), CHANGELOG "Unreleased".

Found live and fixed first: `/file/app.log` served the request log (session cookies included) publicly; every real photo upload with a cutout failed (the thumbnail read a half-written file); the owner was locked out (a browser-generated password on an htmx-submitted form was never saved) and email reset could not work. Leak cleanup: log route closed, cookies redacted, the secret rotated, the old log deleted, Loki's copies deleted.

Decisions by the owner:
- **Postgres only.** SQLite hid production-only bugs and its own migrations deleted data.
- **Login always required; email reset replaced** by an in-app change password and a `user:set-password` recovery command.
- **English only. Sharing kept** (deprioritised). **Web Push kept** and repaired; what it is for is still open.
- **Platform:** Drizzle replaces MikroORM, plain Fastify replaces NestJS, typed JSX (hono/jsx, escape by default) replaces Handlebars, Vitest replaces Jest; done feature by feature with the tests as the parity proof. Drizzle became the only migration authority by recording a baseline on production's MikroORM-built database.
- **Background removal on the server** (BiRefNet 512, MIT), and the whole stack **moved from the NAS to linux-box** because the NAS CPU has no AVX. Photos stay on the NAS over NFS; the database stays on pgvault.
- **Backups** are a separate homelab effort (they were found failing silently).

Gate: publishing waits for CI; pre-commit runs format, lint, types and both test tiers; pre-push runs the browser suite in production configuration; 800+ tests including an authorization matrix, a schema-drift test and a native-post guard.

Numbers: `/wardrobe` at 1,500 garments 63 ms to 6.5 ms and 870 KB to 42 KB; boot 650 to 430 ms; idle memory 225 to 162 MB; service worker 30 to 10 KB gzipped; image 1.47 GB to 0.59 GB; high-severity advisories 9 to 0; type errors 790 to 0.
