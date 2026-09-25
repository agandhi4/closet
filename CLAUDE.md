# Closet

Self-hosted digital wardrobe for the household: catalog garments (photo with background removal, category, brand, size, color), compose outfits, plan them on a calendar, and share a wardrobe with another user. Fork of Libre Closet (Lazztech, AGPL-3.0; repo `agandhi4/closet`, upstream remote `lazztech/libre-closet`). Deployed on the homelab as `closet.box`.

**The primary interface is the installed PWA on phones.** Every feature must work as an installed, offline-tolerant app first and as a desktop web page second.

## Stack

Conventions: `backend.md`, `frontend.md`, `frontend-pwa.md`, `frontend-htmx.md` (hypermedia principles only; the Jinja2/FastAPI specifics do not apply)

- **Runtime**: Node 22 (`.nvmrc` pins `v22.20.0`), TypeScript, NestJS 11 on the **Fastify** adapter (not Express: use `FastifyReply`, `reply.view`, `reply.setCookie`).
- **Views**: server-rendered Handlebars (`@fastify/view`) with htmx 2 + `htmx-ext-sse` for interactivity and `_hyperscript` for client logic. Not a SPA. There is no JSON API for the UI.
- **CSS**: Tailwind v4 (`@tailwindcss/cli`) + daisyUI. Source `views/assets/main.css`, compiled to `public/bundle.css` by `npm run generate:tailwind`.
- **Data**: MikroORM 6 with runtime-selected driver: `better-sqlite` (default) or `postgresql`, chosen by `DATABASE_TYPE` in `src/dal/dal.module.ts`. Separate migration trees per driver.
- **Auth**: optional (`AUTH_ENABLED`) JWT in an `access_token` httpOnly cookie, bcrypt passwords, `ConditionalAuthGuard` so the same controllers work open or authenticated. `DISABLE_REGISTRATION` locks signup.
- **PWA**: Workbox `injectManifest` over a hand-written service worker (`views/assets/src-sw.ts`, esbuild to `.js`, injected to `public/sw.js`), `/manifest.json` served from config by `AppController`, `@khmyznikov/pwa-install`, `pulltorefreshjs`, Web Push via `web-push` + VAPID keys. Gated by `PWA_ENABLED`.
- **Images**: `sharp` (WebP optimization) and `@imgly/background-removal` (patched, see gotchas).
- **Storage**: `src/file/` abstraction, `local` (disk under `DATA_PATH`) or `object` (S3 via `nestjs-s3`).
- **i18n**: `nestjs-i18n`, strings in `src/i18n/<lang>/lang.json`, six languages.
- **Logging**: `nestjs-pino`, pretty to stdout and rotating `app.log` under `DATA_PATH`.
- **Tests**: Jest unit, Playwright e2e (`test/`), autocannon load test (`scripts/load-test.ts`), Lighthouse CI.

## Architecture

```
src/
  main.ts              Fastify bootstrap, static assets, view engine, preHandler that resolves the session
                       once (req.auth via AuthContextService) and fills reply.locals; skipped entirely for
                       the static paths in static-prefixes.ts
  app.module.ts        Root module. Joi env schema (the ONLY place config is declared), pino, throttler,
                       i18n, global error-view filter. Every new env var is added here with a default.
  auth/                Login/register/password-reset controllers, JWT service, guards
  dal/                 Data access layer
    dal.module.ts      MikroORM config, picks sqlite vs postgres driver at runtime
    entity/            user, garment, outfit, outfit-calendar, file, passwordReset, shareableId,
                       userDevice, wardrobe-share
    migrations/        {sqlite,postgres}/ — two parallel trees, both must be generated for every change
  wardrobe/            Core domain: garments, outfits, calendar. Controllers render views;
                       services own business logic; view-models/ shape entities for templates
  wardrobe-share/      Invite-link sharing (view/edit) between users
  file/                FileService abstract + local-file/ and s3-file/ implementations, file-url/
  email/               nodemailer (gmail or mailgun) for password reset
  notification/        Web Push to registered user devices
  open-graph/          OG meta for shared links
  view-context/        Builds the per-request template context (user, flags, i18n) exposed as reply.locals
  i18n/                lang.json per language
views/                 Handlebars, one directory per feature module + partials/ + layout
  assets/              main.css (Tailwind source), src-sw.ts (service worker source)
public/                Static: sw.js (generated), bundle.css (generated), js/, assets/ (icon.svg is the
                       source; icon.png and favicon.ico come from `npm run generate:icons`)
test/                  Playwright specs (smoke.spec.ts is the CI gate)
docs/DESIGN.md         Upstream MVP design doc and entity model. Assess feature work against it.
```

### Routes

`GET /` redirects to `/wardrobe`; there is no landing page, and no privacy, terms or sitemap routes. `/about` carries the upstream attribution. `manifest.json` is not a static file: `AppController` serves it from config so `APP_NAME` and `ICON_NAME` flow into the installed PWA's name and icon.

### Request flow

Controller method → `@Render('feature/view')` or `reply.view(...)` → Handlebars template with `layout` → htmx in the browser swaps fragments returned by further controller routes. Controllers detect htmx via the `HX-Request` header when the same route must serve a full page and a fragment.

### Config

`ConfigModule` loads `.env.local` then `.env`. `.env` is committed and holds public defaults; `.env.local` is gitignored and is for local development only. **The Docker image bakes `.env` and never sees `.env.local`**, so production configuration is real container environment variables, nothing else.

### PWA and the service worker

`public/sw.js` is a build artifact. Edit `views/assets/src-sw.ts` and run `npm run generate:sw`. The precache manifest comes from `workbox-config.js` globs. Service workers and Web Push require a secure context, which is why production is served over HTTPS (see Deployment).

## Conventions

Upstream rules we keep (from `.github/prompts/boilerplate.prompt.md`), plus ours:

- **Server owns the HTML.** Reach for htmx swaps and `_hyperscript` before any hand-written JS. Client JS extracted to `public/js/` needs a reason stated in the PR.
- **Locality of behavior.** Keep view logic beside its markup. Extract only when reused.
- **Every user-facing string goes through i18n.** `{{t 'lang.KEY'}}` in templates, `i18n.t()` in controllers and DTO validation messages. Add the key to every language file, English first.
- **daisyUI components, not bespoke CSS.** Theme through daisyUI tokens. No hardcoded colors in templates.
- **No runtime CDN imports.** Every client dependency is an npm package served by `useStaticAssets` in `main.ts`. The installed PWA must boot with zero external requests.
- **Config via `ConfigService`**, never `process.env` outside `main.ts`. New env vars: Joi entry in `app.module.ts` with a default, row in the README configuration table.
- **Migrations come in pairs.** Any entity change produces both a SQLite and a Postgres migration (see Commands). Production runs Postgres, CI smoke-tests both, so a missing twin fails CI, not prod.
- **Cookies stay `Secure`-less.** The `.box` name is HTTP by design (Tailscale encrypts). Adding `secure: true` to `reply.setCookie` in `src/auth/` makes login silently never stick over `http://closet.box`. If a secure cookie is ever wanted it must be driven by a `COOKIE_SECURE` env var defaulting to false.
- **Offline-first UX per `frontend-pwa.md`.** Reads render from cache with a freshness indicator, writes that cannot reach the server are disabled with an explanation, never silently dropped. Connectivity detection is active (heartbeat), not `navigator.onLine`.
- **Logging**: use the injected pino logger with the module name as context. Log at operation boundaries with garment/outfit IDs and user IDs. Nothing inside template rendering or loops.

## Commands

```bash
nvm use                       # Node 22.20.0
npm ci                        # postinstall applies patches/ via patch-package

npm run start:dev             # nest --watch + tailwind --watch
npm run build                 # nest build + generate (tailwind, service worker)
npm run start:prod            # node dist/main

npm run lint                  # eslint --fix
npm run format                # prettier
npm test                      # jest unit
npm run test:e2e              # playwright (full)
npm run test:e2e:smoke        # playwright smoke, the CI gate
npm run test:load             # autocannon against a running instance
npm run lighthouse            # lhci autorun
npm run precommit             # format + lint + test:cov + smoke + build + load + lighthouse (slow)

# Migrations — run BOTH after any entity change (build first, CLI reads dist)
npm run build
npx mikro-orm migration:create --config mikro-orm.sqlite.cli-config.ts
npx mikro-orm migration:create --config mikro-orm.postgres.cli-config.ts

docker build -f docker/Dockerfile -t closet .
```

Builds, test suites, and `npm ci` go through a `build-runner` subagent, never inline.

## Deployment

Runs as the `closet` stack on the homelab NAS (`agandhi4/homelab`, `/volume1/docker/homelab` on the NAS). Same shape as `orbit` and `finplat`: one container from a GHCR image, joined to `homeinfra_web`, fronted by the shared Caddy.

| Piece | Value |
|-------|-------|
| URL (canonical, PWA) | `https://closet.kashhq.dedyn.io` |
| URL (HTTP twin) | `http://closet.box` (no service worker or push here; secure context required) |
| Image | `ghcr.io/agandhi4/closet:latest`, amd64, published by `docker-publish.yml` on every push to `main` |
| Container port | 3000 (`PORT`) |
| Database | pgvault Postgres, `closet_db` / `closet_user`, provisioned by `stacks/homeinfra/scripts/add-app.sh closet --port 3000` |
| Persistent volume | `DATA_PATH` → `/volume1/docker/appdata/closet` (uploaded photos, `app.log`) |
| Caddy | `stacks/homeinfra/caddy/apps.d/closet.caddy` with both `http://closet.box` and `http://closet.kashhq.dedyn.io` → `closet:3000` |
| DNS | nothing: Pi-hole wildcard `address=/box/` covers `closet.box`; `kashhq.dedyn.io` mirrors `.box` |
| DSM reverse proxy | rule for `closet.box` and `closet.kashhq.dedyn.io` → `localhost:8080`, WebSocket header on |
| Auto-update | `closet   # autoupdate` in `hosts/synology/manifest` |

Production env (`hosts/synology/closet.env`, gitignored, values never in this repo):

```
APP_NAME=Closet
SITE_URL=https://closet.kashhq.dedyn.io
PWA_ENABLED=true
AUTH_ENABLED=true
DISABLE_REGISTRATION=true          # flip to false only while creating the two household accounts
ACCESS_TOKEN_SECRET=<openssl rand -hex 32>
TRUSTED_PROXIES=172.16.0.0/12      # Docker bridge range: Caddy is the client Fastify sees, so trust its X-Forwarded-For
PUBLIC_VAPID_KEY=<npx web-push generate-vapid-keys>   # no defaults; required when PWA_ENABLED=true
PRIVATE_VAPID_KEY=<same>
# ICON_NAME left unset (default icon.png)
# WATERMARK_ENABLED left unset (default false)
DATABASE_TYPE=postgres
DATABASE_HOST=pgvault
DATABASE_PORT=5432
DATABASE_SCHEMA=closet_db
DATABASE_USER=closet_user
DATABASE_PASS=<from add-app.sh, hex>
FILE_STORAGE_TYPE=local
DATA_PATH=/app/data
```

Deploy: on the NAS, `cd /volume1/docker/homelab && /usr/local/bin/git pull && ./deploy.sh up synology closet`. Data fixes go through `pgvault-connect closet_db` (read freely, write only when asked, inside a transaction).

## Gotchas

- **`patches/@imgly+background-removal+1.7.0.patch`** is applied on every install. Read it before bumping that package; a version bump silently drops the patch.
- **`@imgly/background-removal-data`** is a tarball from `staticimgly.com`, not the npm registry. Builds need outbound access to that host.
- **`docker-publish.yml` publishes `:latest` on every push to `main`** (and semver tags on `v*` tags from `tag-release.yml`), amd64 only, GHCR only. Merging to main is deploying: the homelab autoupdater redeploys within the hour.
- **Upstream references are limited to attribution.** The only permitted mentions of the upstream project are the attribution link in the About page and README and code comments citing upstream issues or PRs. Any other occurrence of the upstream company or project name (assets, links, config defaults, CI values, marketing copy) is a rebrand regression; grep for it before a PR.
- **Regenerate `package-lock.json` only with Node 22 / npm 10** (`nvm use`, or `docker run --rm -v $PWD:/app -w /app node:22 npm install --package-lock-only`). npm 11 prunes nested entries that npm 10's `npm ci` in the Docker build then reports as missing, so the image build fails while local installs look fine.
- **Two parallel migration trees.** Forgetting the Postgres twin passes locally on SQLite and fails in CI's Postgres+MinIO job.
- **`precommit` is minutes long** (Lighthouse and load test included). Use it as the pre-PR gate, not on every save.

## Workflow

<!-- ORCHESTRATION-OVERRIDE: claudebot agents skip this section.
     Your agent definition governs your workflow. -->

- Before implementing, search Graphiti with `group_ids: ["closet"]` for decisions and gotchas in the area.
- Plan in plain text and get approval before writing code or spawning implementers. Approval of a goal is not approval of an implementation.
- Every feature is verified in a browser as an installed PWA on a phone-width viewport before it is called done. Type checks and Playwright verify code, not the app.
- Summarize changes and wait for an explicit go-ahead before committing. Run `npm run format && npm run lint` before staging. If a hook fails, fix and create a new commit, never amend.
- Commit messages: concise, why over what.
- When a new pattern or gotcha lands, update this file in the same commit and store the decision in Graphiti.
- Upstream sync: this fork will diverge (rebrand, household features). Keep upstream-worthy fixes in their own commits so they can be offered back to `lazztech/libre-closet`.
