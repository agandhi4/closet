# Closet

A private, self-hosted household wardrobe PWA. Catalog garments with photos (backgrounds removed automatically), compose outfits, plan them on a calendar, and share a wardrobe between users.

A fork of [Libre Closet](https://github.com/lazztech/libre-closet) by Lazztech LLC, licensed under the AGPL-3.0.

---

## Quick start

```bash
# SQLite + local storage (zero config)
docker run -d \
  -p 3000:3000 \
  -v closet_data:/app/data \
  ghcr.io/agandhi4/closet:latest
```

Open [http://localhost:3000](http://localhost:3000). No account required by default.

### docker-compose

```yaml
services:
  closet:
    image: ghcr.io/agandhi4/closet:latest
    ports:
      - '3000:3000'
    volumes:
      - closet_data:/app/data
    environment:
      AUTH_ENABLED: 'false'
      PWA_ENABLED: 'true'
      # Required when PWA_ENABLED is true: npx web-push generate-vapid-keys
      PUBLIC_VAPID_KEY: '<public key>'
      PRIVATE_VAPID_KEY: '<private key>'
      DATA_PATH: /app/data
    restart: unless-stopped

volumes:
  closet_data:
```

---

## Configuration

`.env` contains committed defaults. Override any value via a `.env.local` file (gitignored) or by passing real environment variables to Docker.

| Variable                           | Description                                                                          | Default                 | Example                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| `APP_NAME`                         | Display name shown in the UI and navbar                                              | `Closet`                | `My awesome Closet manager`                                                               |
| `ICON_NAME`                        | Icon file under `public/assets/` used for the navbar, manifest and share previews    | `icon.png`              | `my-icon.png`                                                                             |
| `SITE_URL`                         | Public origin, used for absolute links in share previews and emails                  | `http://localhost:3000` | `https://closet.example.com`                                                              |
| `DATA_PATH`                        | Directory for SQLite DB and uploaded files                                           | `./data`                | `./closet-data`                                                                           |
| `AUTH_ENABLED`                     | Enable JWT user accounts and login                                                   | `false`                 | `true`                                                                                    |
| `DISABLE_REGISTRATION`             | Disallows user sign ups when true                                                    | `false`                 | `true`                                                                                    |
| `PWA_ENABLED`                      | Enable service worker and PWA install prompt                                         | `false`                 | `true`                                                                                    |
| `WATERMARK_ENABLED`                | Composite the app icon onto share-link preview images                                | `false`                 | `true`                                                                                    |
| `ACCESS_TOKEN_SECRET`              | JWT signing secret - **change for production**                                       | `ChangeMe!`             | `u9n8c2y847rfctb23468tcb689f243`                                                          |
| `TRUSTED_PROXIES`                  | Comma-separated IPs/CIDRs of reverse proxies whose `X-Forwarded-*` headers are trusted (rate limiting, canonical URLs) | `127.0.0.1,::1` | `172.16.0.0/12`                                                                   |
| `LOG_LEVEL`                        | pino level for the console and `app.log` (`trace` … `fatal`, or `silent`)            | `info`                  | `debug`                                                                                   |
| `DATABASE_TYPE`                    | `sqlite` or `postgres`                                                               | `sqlite`                | `postgres`                                                                                |
| `DATABASE_HOST`                    | Postgres host                                                                        | -                       | `192.168.10.5`                                                                            |
| `DATABASE_PORT`                    | Postgres port                                                                        | `5432`                  | `9867`                                                                                    |
| `DATABASE_USER`                    | Postgres user                                                                        | -                       | `postgres`                                                                                |
| `DATABASE_PASS`                    | Postgres password                                                                    | -                       | `7yfhcn2349cr32f`                                                                         |
| `DATABASE_SCHEMA`                  | Postgres schema                                                                      | `postgres`              | `closet`                                                                                  |
| `DATABASE_SSL`                     | Use SSL for Postgres                                                                 | `false`                 | `true`                                                                                    |
| `FILE_STORAGE_TYPE`                | `local` or `object` (S3)                                                             | `local`                 | `object`                                                                                  |
| `OBJECT_STORAGE_ACCESS_KEY_ID`     | S3 access key                                                                        | -                       | `AKIAIOSFODNN7EXAMPLE`                                                                    |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | S3 secret key                                                                        | -                       | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`                                                |
| `OBJECT_STORAGE_ENDPOINT`          | S3-compatible endpoint URL                                                           | -                       | `https://s3.example.com:8443`                                                             |
| `OBJECT_STORAGE_REGION`            | S3 region                                                                            | `us-east-1`             | `us-west-1`                                                                               |
| `OBJECT_STORAGE_BUCKET_NAME`       | S3 bucket name                                                                       | `closet`                | `my-awesome-closet-manager-bucket`                                                        |
| `EMAIL_FROM_ADDRESS`               | From address for password reset emails                                               | -                       | `closet@example.com`                                                                      |
| `EMAIL_TRANSPORT`                  | `gmail` or `mailgun`                                                                 | `gmail`                 | `mailgun`                                                                                 |
| `EMAIL_API_KEY`                    | Mailgun API key                                                                      | -                       | `fyhn2437cryb248cbrdc32`                                                                  |
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
- Docker (optional, for Postgres testing)

```bash
nvm install && nvm use
npm install
cp .env .env.local     # override defaults locally (gitignored)
npm run start:dev
```

### Scripts

```bash
npm run start:dev       # watch mode
npm run start:prod      # production
npm run test            # unit tests
npm run test:int        # integration tests (real app in-process, in-memory SQLite)
npm run test:e2e        # Playwright end-to-end
npm run test:cov        # coverage
npm run test:load       # autocannon load test, see below
npm run generate:icons  # regenerate public/assets/icon.png and favicon.ico from icon.svg
npm run precommit       # format check + lint + unit + integration + build (run before committing)
```

### Load test

`npm run test:load` builds the app, starts it with `AUTH_ENABLED=false` and a
temporary `DATA_PATH`, seeds one garment with a photo through the real
endpoints, and runs autocannon against `/wardrobe` (full page and htmx
fragment), `/outfits/new` and the seeded `/file/thumb/...` image. Results
land in `scripts/results/load-test-results.json`, one entry per target.

| Variable             | Description                       | Default |
| -------------------- | --------------------------------- | ------- |
| `LOAD_TEST_DURATION` | Seconds of load per target        | `5`     |

`npm run test:load:baseline` saves the run as the baseline;
`npm run test:load:compare` reports the change per target against it.

### Migrations

```bash
# SQLite (build first due to config differences)
npm run build
npx mikro-orm migration:create --config mikro-orm.sqlite.cli-config.ts

# PostgreSQL
npx mikro-orm migration:create --config mikro-orm.postgres.cli-config.ts
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

For most self-hosters: deploy to a VPS via [Coolify](https://coolify.io/) or Portainer using the docker-compose above with SQLite + local storage. SQLite handles thousands of users without issue - see [DjangoCon 2023: Use SQLite in Production](https://youtu.be/yTicYJDT1zE).

If you need horizontal scaling later, switch to S3-compatible storage and add [Litestream](https://litestream.io/) for streaming SQLite backups before considering a PostgreSQL migration.

---

## Contributing

Fixes that would benefit the upstream project belong in [Lazztech's repository](https://github.com/lazztech/libre-closet). Everything specific to this fork goes here. This project is licensed under AGPL-3.0 - contributions must be compatible with that license.

---

## License

[GNU AGPL-3.0](LICENSE)
