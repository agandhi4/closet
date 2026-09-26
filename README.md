# Closet

A private, self-hosted household wardrobe PWA. Catalog garments with photos (backgrounds removed automatically), compose outfits, plan them on a calendar, and share a wardrobe between users.

A fork of [Libre Closet](https://github.com/lazztech/libre-closet) by Lazztech LLC, licensed under the AGPL-3.0.

---

## Quick start

Closet needs a PostgreSQL 13+ database (production runs 17).

```yaml
services:
  closet:
    image: ghcr.io/agandhi4/closet:latest
    ports:
      - '3000:3000'
    volumes:
      - closet_data:/app/data
    environment:
      # The household's time zone: decides "today" on the calendar.
      APP_TIMEZONE: America/New_York
      PWA_ENABLED: 'true'
      # Required when PWA_ENABLED is true: npx web-push generate-vapid-keys
      PUBLIC_VAPID_KEY: '<public key>'
      PRIVATE_VAPID_KEY: '<private key>'
      DATA_PATH: /app/data
      DATABASE_HOST: postgres
      DATABASE_SCHEMA: closet
      DATABASE_USER: closet
      DATABASE_PASS: '<password>'
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: closet
      POSTGRES_PASSWORD: '<password>'
      POSTGRES_DB: closet
    volumes:
      - closet_pg:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U closet -d closet']
      interval: 5s
      retries: 10
    restart: unless-stopped

volumes:
  closet_data:
  closet_pg:
```

Open [http://localhost:3000](http://localhost:3000) and register an account: login is always required. Once everyone in the household has signed up, set `DISABLE_REGISTRATION=true`.

---

## Configuration

`.env` contains committed defaults. Override any value via a `.env.local` file (gitignored) or by passing real environment variables to Docker.

| Variable                           | Description                                                                          | Default                 | Example                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `APP_NAME`                         | Display name shown in the UI and navbar                                              | `Closet`                | `My awesome Closet manager`                                                               |
| `APP_TIMEZONE`                     | The household's IANA time zone: what "today" is on the calendar and which week opens by default | `America/New_York` | `Europe/Berlin`                                                                   |
| `ICON_NAME`                        | Icon file under `public/assets/` used for the navbar, manifest and share previews    | `icon.png`              | `my-icon.png`                                                                             |
| `SITE_URL`                         | Public origin, used for absolute links in share previews and as the Web Push (VAPID) contact, which must be `https:` when `PWA_ENABLED=true` | `http://localhost:3000` | `https://closet.example.com`                                                              |
| `DATA_PATH`                        | Directory for uploaded files and `app.log`                                           | `./data`                | `./closet-data`                                                                           |
| `DISABLE_REGISTRATION`             | Disallows user sign ups when true                                                    | `false`                 | `true`                                                                                    |
| `PWA_ENABLED`                      | Enable service worker, PWA install prompt and Web Push notifications                 | `false`                 | `true`                                                                                    |
| `WATERMARK_ENABLED`                | Composite the app icon onto share-link preview images                                | `false`                 | `true`                                                                                    |
| `ACCESS_TOKEN_SECRET`              | JWT signing secret - **change for production**                                       | `ChangeMe!`             | `u9n8c2y847rfctb23468tcb689f243`                                                          |
| `TRUSTED_PROXIES`                  | Comma-separated IPs/CIDRs of reverse proxies whose `X-Forwarded-*` headers are trusted (login rate limits, the cross-site request check, canonical URLs). Behind a reverse proxy it must include the proxy's address | `127.0.0.1,::1` | `172.16.0.0/12`                                                                   |
| `LOG_LEVEL`                        | pino level for the console and `app.log` (`trace` … `fatal`, or `silent`)            | `info`                  | `debug`                                                                                   |
| `DATABASE_HOST`                    | Postgres host (required)                                                             | -                       | `192.168.10.5`                                                                            |
| `DATABASE_PORT`                    | Postgres port                                                                        | `5432`                  | `9867`                                                                                    |
| `DATABASE_USER`                    | Postgres user (required)                                                             | -                       | `postgres`                                                                                |
| `DATABASE_PASS`                    | Postgres password (required; may be empty for trust auth)                            | -                       | `7yfhcn2349cr32f`                                                                         |
| `DATABASE_SCHEMA`                  | Postgres database name (required)                                                    | -                       | `closet`                                                                                  |
| `DATABASE_SSL`                     | Use SSL for Postgres                                                                 | `false`                 | `true`                                                                                    |
| `MAINTENANCE_ENABLED`              | Run the nightly storage reconciliation (03:00 in `APP_TIMEZONE`); `npm run maintenance:reconcile` runs it once regardless | `true`   | `false`                                                                                   |
| `MAX_HEIC_BYTES`                   | Largest HEIC/HEIF upload accepted; HEIC is decoded in memory before resizing         | `41943040` (40 MB)      | `20971520`                                                                                |
| `PUBLIC_VAPID_KEY`                 | Web push - required when `PWA_ENABLED=true`, generate with `npx web-push generate-vapid-keys` | -                | `<from web-push>` |
| `PRIVATE_VAPID_KEY`                | Web push - required when `PWA_ENABLED=true`, generate with `npx web-push generate-vapid-keys` | -                | `<from web-push>`                                             |

Generate JWT secret:

```bash
openssl rand -base64 60
```

Generate VAPID keys:

```bash
npx web-push generate-vapid-keys
```

---

## Development

### Prerequisites

- Node (see `.nvmrc`, Node 22) - install via [nvm](https://github.com/nvm-sh/nvm)
- Docker, for Postgres. Development and tests use the shared local
  **pgvault-dev** (a sibling `../pgvault-dev` compose project: Postgres on
  `localhost:5432`, superuser `postgres`, trust auth).

```bash
nvm install && nvm use
npm install
(cd ../pgvault-dev && docker compose up -d --wait)
docker compose -f ../pgvault-dev/docker-compose.yml exec postgres \
  psql -U postgres -c 'create database closet_db'   # once
cat > .env.local <<'ENV'                            # gitignored
DATABASE_HOST=localhost
DATABASE_SCHEMA=closet_db
DATABASE_USER=postgres
DATABASE_PASS=
ENV
npm run start:dev
```

The integration tier and the load test never touch `closet_db`: each run
creates scratch databases on the server named by `TEST_DATABASE_URL`
(default `postgres://postgres@localhost:5432/postgres`, pgvault-dev) and drops
them afterwards.

### Scripts

```bash
npm run start:dev       # tsc --watch + node --watch + tailwind --watch
npm run build           # tsc (type-checked) to dist/, plus Tailwind, the service worker and the cache key
npm run start:prod      # node dist/main.js
npm run test            # Vitest unit tests (test:watch to rerun on change)
npm run test:int        # Vitest integration tests (real app in-process, scratch Postgres database per file)
npm run test:all        # both Vitest tiers in one run
npm run test:e2e        # build, then Playwright end-to-end
npm run test:cov        # both Vitest tiers with v8 coverage (coverage/)
npm run test:load       # autocannon load test, see below
npm run generate:icons  # regenerate public/assets/icon.png and favicon.ico from icon.svg
npm run check           # format, lint, types, unit + integration in parallel (the pre-commit hook)
npm run verify:push     # build + Chromium Playwright (the pre-push hook)
npm run maintenance:reconcile [-- --dry-run] [--force]
                        # one storage reconciliation pass (needs `npm run build`; see below)
npm run user:set-password -- <email>
                        # set a locked-out user's password (needs `npm run build`; see below)
```

### Locked out

There is no password reset by email. Whoever runs the server sets a new
password for an account with `npm run user:set-password -- <email>` (in a
container: `docker exec -it closet npm run user:set-password -- <email>`). It
asks for the password twice without echoing it (or reads one line from piped
stdin), applies the registration rules, and signs out every existing session
of that account. An unknown email changes nothing and exits with status 1.

Neither this nor the storage maintenance command migrates the database: they
refuse, with exit status 1, a database the running build has not migrated
yet. Start the server of that build first (it migrates at boot).

### Storage maintenance

Every photo is a set of files in storage (`<uuid>.webp` plus `-nobg` and
`-thumb` variants) and one `file` row. Deleting a garment or an account
removes both, and a nightly job (03:00 in `APP_TIMEZONE`, `MAINTENANCE_ENABLED`)
keeps them describing each other: stored photo sets older than a day with no
row are deleted, rows older than a day that no garment references are deleted
with their files, and rows whose original is missing are logged. Run it by
hand, on the NAS with `docker exec closet npm run maintenance:reconcile`, or
locally after `npm run build`; `-- --dry-run` only reports.

A run that would delete anything while the `file` table is empty, more than
25 photo sets, or more than a fifth of the stored ones (once it is more than
5) deletes nothing: it logs why, reports `refused` and exits with status 3.
That is the database and the disk disagreeing wholesale (a restore, the wrong
database), not stray uploads. Check with `-- --dry-run`, then
`-- --force` deletes anyway.

### Load test

`npm run test:load` builds the app, starts it on a scratch Postgres database
and a temporary `DATA_PATH`, registers a user and seeds one garment with a
photo through the real endpoints, and runs autocannon against `/wardrobe`
(full page and htmx fragment) and `/outfits/new` with that user's session, and
against the seeded `/file/thumb/...` image. Results
land in `scripts/results/load-test-results.json`, one entry per target.

| Variable             | Description                       | Default |
| -------------------- | --------------------------------- | ------- |
| `LOAD_TEST_DURATION` | Seconds of load per target        | `5`     |

`npm run test:load:baseline` saves the run as the baseline;
`npm run test:load:compare` reports the change per target against it.

### Migrations

The schema is `src/db/schema.ts` (Drizzle). The app applies the migrations in
`drizzle/` on every boot, so a deploy is the migration.

```bash
# After editing src/db/schema.ts: writes drizzle/NNNN_<name>.sql and its
# snapshot. Needs no database. Read the SQL before committing it.
npx drizzle-kit generate --name <what-changed>
```

Databases created before Drizzle took over (built by MikroORM's migrations)
are adopted on their first boot: the runner checks that the last MikroORM
migration was applied and records the Drizzle baseline without running it.

A migration that converts data refuses to guess: it fails the boot, changes
nothing, and names what to fix. `0004_garment_web` (garment colours become a
fixed set, the acquisition date a plain date) stops on a colour outside the
built-in set (older builds let people type their own), an acquisition date
that is not UTC midnight, a blank category, or a share id two rows hold. To
check a database before upgrading:

```sql
SELECT DISTINCT unnest(string_to_array(color, ',')) FROM garment;  -- built-in names only
SELECT count(*) FROM garment
 WHERE (date_aquired AT TIME ZONE 'UTC')::time <> '00:00'
    OR btrim(category) = '';                                       -- 0
```

### Docker build

```bash
# Build image
docker build --no-cache -f docker/Dockerfile . -t closet:latest

# Cross-compile for linux/amd64 (e.g. building on Apple Silicon for a VPS)
docker buildx build --platform linux/amd64 --no-cache -f docker/Dockerfile . -t closet:latest
```

---

## Deployment recommendations

For most self-hosters: deploy to a VPS via [Coolify](https://coolify.io/) or Portainer using the docker-compose above, with local storage. Back up both the Postgres database and `DATA_PATH`, taken close together: the nightly storage reconciliation deletes photos that no database row references.

---

## Contributing

Fixes that would benefit the upstream project belong in [Lazztech's repository](https://github.com/lazztech/libre-closet). Everything specific to this fork goes here. This project is licensed under AGPL-3.0 - contributions must be compatible with that license.

---

## License

[GNU AGPL-3.0](LICENSE)
