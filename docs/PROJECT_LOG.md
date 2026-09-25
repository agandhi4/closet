# Project Log

This document is intended for the maintaining team to use to document decisions. This may be a medium for documenting, reviewing, and approving as a means of expressing consensus on project business decisions where the direct output is not necessarily code or assets that may be otherwise checked in and version controlled.

> **Example Entry (Date in ISO8601 format, Year-Month-Day):**
>
> The team agrees to _BLANK_ project business decision(s)...

## 2026-09-25

The fork becomes **Closet**, a private household app: rebranded (single upstream attribution kept per AGPL), marketing/privacy/terms pages removed, one account for now with registration locked.

Deployment decisions: pgvault Postgres over SQLite (nightly dumps, shared triage tooling); `https://closet.kashhq.dedyn.io` is the canonical URL because the PWA needs a secure context, `http://closet.box` is the plain twin; the image publishes on every push to `main` and the homelab autoupdater deploys it, so pushing `main` is deploying.

Performance program (audit, then six phases, all shipped the same day): image asset model with thumbnails and immutable versioned URLs; one session resolution per request; an in-process integration test tier run on SQLite and Postgres in CI; cache-first PWA shell and lazy model loading; indexes on every relation with concurrent Postgres backfill and transactional writes; boilerplate removal and a 54% smaller image; nightly storage reconciliation, HEIC support and safe user deletion. Grid image payload went from 28.6 MB uncached to 1.3 MB cached. Two production bugs found on the way: `garment.color` had become a smallint on Postgres, and an undecodable upload could crash the process.

