# Closet data model audit (second pass)

Date: 2026-09-25. Scope: every entity in `src/dal/entity/`, both migration trees, both snapshots, and every service that queries them. Read-only; no build, no production access. Nothing below repeats the shipped items in `docs/audits/2026-09-25/audit-data.md` (FK indexes, the CONCURRENTLY backfill, DISTINCT filters, transactional photo writes, single session lookup). Where the shipped index set has a flaw, it is listed as new.

All paths are relative to `/home/aakash/projects/closet`.

---

## 0. Root cause, stated once

Five of the seven data bugs this codebase has had or still has come from **running two SQL dialects against one entity model**:

| Bug | Cause |
|---|---|
| `garment.color` became `smallint` on Postgres (shipped, fixed today) | Driver-specific type mapping |
| Postgres had no FK indexes (shipped, fixed today) | SQLite auto-indexes FKs, Postgres does not |
| Keyword search is case-sensitive in production only (**new, §1.3**) | `LIKE` is case-insensitive on SQLite and case-sensitive on Postgres |
| `notes` longer than 255 characters is a 500 in production only (**new, §1.4**) | `varchar(255)` on Postgres, `text` on SQLite |
| SQLite table-rebuild migrations delete every pivot and calendar row (**new, §1.1**) | SQLite ignores `pragma foreign_keys = off` inside a transaction |

The integration tier runs on both drivers in CI, and that is why this is manageable now. But the default test loop is SQLite and production is Postgres, so every behavior that differs by dialect passes locally and fails in prod. The fork has exactly one database, and it is Postgres (`docs/PROJECT_LOG.md:13`). **The structural decision is whether to keep SQLite.** §5 treats it as decision D1. Most of the target model can be built under either answer. The parts that need Postgres (`date`, `uuid`, `text[]`, CHECK constraints, expression indexes) are marked **[PG]**.

---

## 1. Must-fix: correctness

### 1.1 SQLite rebuild migrations cascade-delete child rows (data loss; not production, but the default driver)

- **Evidence:** `src/dal/migrations/sqlite/Migration20260925183003.ts:6-15` rebuilds `garment`: `pragma foreign_keys = off`, create `garment__temp_alter`, copy, `drop table garment`, rename. `Migration20260416215236.ts` does the same to `outfit` and `garment`, and `Migration20260612010037.ts:12-19` does it to `garment`.
- **Why it deletes data:**
  - The SQLite migrator runs with `transactional: true` (`src/dal/dal.module.ts:37`) and the default `allOrNothing` (`node_modules/@mikro-orm/migrations/Migrator.js:349-356`), so every migration runs inside a transaction.
  - SQLite documents `PRAGMA foreign_keys` as a **no-op inside a transaction**. MikroORM turns foreign keys on for every connection (`@mikro-orm/knex/dialects/sqlite/BaseSqliteConnection.js:15`).
  - `DROP TABLE garment` therefore runs an implicit `DELETE FROM garment`, which fires `ON DELETE CASCADE` on `outfit_garments.garment_id`. The outfit rebuild does the same to `outfit_garments` and `outfit_calendar`.
- **Reproduced** with the repo's own `better-sqlite3`: inside a transaction, `foreign_keys` still reads `1` after the pragma, and the child table goes from 1 row to 0 after the rebuild.
- **Blast radius:**
  - Any SQLite install with outfits that upgrades across `20260925183003` loses every outfit-garment link. Across `20260416215236` it also loses every calendar entry.
  - Production (Postgres) is not affected. The local `data/sqlite3.db` has 0 outfits, so no local data was lost. CI does not catch it because the harness migrates an empty in-memory database.
- **Fix:** if SQLite is dropped (D1), this goes away. If it stays:
  - Rebuild migrations must override `isTransactional()` to return `false`, and the SQLite config must set `allOrNothing: false`, so the pragma runs outside any transaction.
  - Add a harness test that seeds outfits and calendar rows at an old migration, migrates to head, and asserts row counts are unchanged.

### 1.2 `user.password_reset_id → password_reset ON DELETE CASCADE`: deleting a reset PIN deletes the user

- **Evidence:** `src/dal/migrations/postgres/Migration20260305215234.ts:25`, which follows from `User.passwordReset` being the owning side (`src/dal/entity/user.entity.ts:37-44`, `cascade: [Cascade.ALL]`).
- **The hazard:** the FK points the wrong way. `DELETE FROM password_reset WHERE ...` cascades to `user`, and from there to every garment, outfit, calendar entry, file row, device and share. That is exactly the cleanup someone would write, by hand in `pgvault-connect` or as the obvious "consume the PIN" fix.
- **The flow is also broken on its own terms** (`src/auth/auth.service.ts:131-159`):
  - The PIN is stored in plaintext.
  - There is no expiry.
  - It is never consumed, so a PIN stays valid forever after first use.
  - Each request inserts a new `password_reset` row and orphans the previous one.
- **Fix:**
  - Target model: `password_reset(user_id PK FK→user ON DELETE CASCADE, pin_hash, expires_at, attempts)`. Delete the row on successful reset.
  - Migration: add `user_id`, backfill from `user.password_reset_id`, drop the old FK and column, then drop the orphans. In production this table is almost certainly empty (one account, registration locked), so the risk is low. Verify with `SELECT count(*) FROM password_reset`.

### 1.3 Keyword search is case-sensitive in production

- **Evidence:** `src/wardrobe/garment.service.ts:75-83` uses `$like '%kw%'` on name, notes and brand.
- **Effect:** On Postgres, `LIKE` is case-sensitive, so "blazer" does not find "Black Linen Blazer". SQLite `LIKE` is case-insensitive for ASCII, so the local loop never shows it. The one integration assertion (`test/integration/delivery.spec.ts:141`, `keyword=Fragment`) uses the stored case.
- **Why not `$ilike`:** MikroORM passes it through as a raw `ilike` operator (`@mikro-orm/core/enums.js:43`, with no emulation in `knex/query/QueryBuilderHelper.js:539-551`), and SQLite rejects that.
- **Fix:** match `lower(col) LIKE lower(?)` portably, or on Postgres only, `ILIKE` [PG].
- Also escape `%` and `_` in the keyword; today "100%" matches everything. Add a mixed-case assertion to the integration test so the Postgres run catches this.

### 1.4 `varchar(255)` on Postgres for free text that SQLite stores as `text`

- **Columns** (snapshot `.snapshot-postgres.json`):
  - `garment.notes`, `outfit.notes`, `outfit_calendar.notes`, `garment.name`, `brand`, `size`, `category`, `outfit.name`
  - `user_device.push_endpoint`, `user_device.user_agent`
- **Garment/outfit notes are a `<textarea>` with no `maxlength`** (`views/wardrobe/form.hbs:117-124`, `views/outfits/form.hbs:99-106`), so more than 255 characters gives SQLSTATE 22001 → 500 in production. It works on SQLite.
- **Push endpoints:** Firefox autopush v2 endpoints routinely run 250-400 characters, so a Firefox or Android-Firefox push subscription can fail the insert in `src/notification/notification.service.ts:60-66`. Long Android WebView user agents can exceed 255 too.
- **Fix:** `columnType: 'text'` on every free-text property. On Postgres, `varchar(n) → text` is binary-coercible: a catalog-only change with no table rewrite, instant. Risk: none.

### 1.5 Outfit composition has two sources of truth, and the displayed one is unordered

- **The two stores:** `Outfit.slots` (JSON array of `{category, garmentId}`, `src/dal/entity/outfit.entity.ts:32-33`) holds the order and the empty rows the builder saves. `outfit_garments` holds the membership set.
- **They disagree by construction** (`src/wardrobe/outfit.service.ts:70-133`):
  - Slots are stored as posted. The pivot is filtered to owned garments (`findOwnedGarments`, `:101-109`), so a hand-edited request produces slots that name garments the pivot does not have.
  - Deleting a garment cascades the pivot row. The slot keeps a dangling `garmentId` with no FK.
  - A garment in two slots is one pivot row.
- **What gets rendered:** the show page and list render the pivot (`src/wardrobe/outfit.controller.ts:132-134`, `views/outfits/index.hbs:62`). The pivot has no position column, and `OutfitService.findAll` has no `orderBy` (`:32-44`). Postgres therefore returns outfits, and the garments within each outfit, in heap or plan order. The order the user built in is lost on every page except the edit form.
- **Archived garments are silently dropped on edit.** The edit form builds its rows from `garmentService.findAll`, which excludes archived garments (`garment.service.ts:74`). An outfit containing an archived garment loses it from both stores on the next save (`outfit.controller.ts:146-160`).
- **Fix (target model):** one `outfit_slot` table, detailed in §5. It replaces both stores, with a position, an FK and `ON DELETE SET NULL`.

### 1.6 Calendar days are instants, and "today" is the server's UTC date

- **What is stored:** `outfit_calendar.date` is `timestamptz` (`Migration20260406193304.ts:6`). The app writes UTC midnight (`calendar.controller.ts:54`, `new Date('YYYY-MM-DD')`) and reads it back with UTC getters (`calendar.service.ts:222-224, 443-458`). `garment.date_aquired` is the same (`Migration20260617003819.ts:6`, `app.ts:290-294`). The round trip is internally consistent, but only because every path remembers to use UTC.
- **Off-by-one today:** "today" is `new Date().toISOString()` in UTC (`calendar.service.ts:407`). For a household in the Americas, after 17:00-20:00 local time the calendar highlights tomorrow, and "this week" flips early on Saturday evening.
- **Latent:** `findWeek` mixes local and UTC arithmetic (`setDate`/`getDate` at `:66-67` and `:78-79`, UTC helpers elsewhere). It is correct only while the container's TZ is UTC. Setting `TZ` to "fix today" would mislabel days in weeks that contain a DST change.
- **Other readers:** `psql` in a non-UTC session shows every planned day as the previous evening.
- **Fix [PG `date` is also a SQLite affinity, so portable]:**
  - Store `outfit_calendar.day date` and `garment.acquired_on date`, typed as a `'YYYY-MM-DD'` string in the entity, so no JS `Date` exists for calendar days.
  - "Today" comes from one `APP_TIMEZONE` config value (one household) or from the client.
  - Migration: `ALTER COLUMN date TYPE date USING (date AT TIME ZONE 'UTC')::date`. First verify with `SELECT count(*) FROM outfit_calendar WHERE date <> date_trunc('day', date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, which should be 0.

### 1.7 Smaller correctness gaps (each a one-line constraint or validation)

| Gap | Evidence | Fix |
|---|---|---|
| `shareable_id` has only a plain index, not UNIQUE, although `findOne({shareableId})` assumes uniqueness and DESIGN.md says UK | `shareableId.entity.ts:9-11` | `@Unique()`, built `CREATE UNIQUE INDEX CONCURRENTLY`, then drop the plain index. [PG] also make it `uuid DEFAULT gen_random_uuid()` |
| Garment create body is unvalidated. `category` can be missing (NOT NULL → 500) or `''`. `color` accepts any string (only the search DTO validates the enum). Empty strings are stored for cleared fields, and code then filters them out on read | `wardrobe.controller.ts:170-212`, `garment.service.ts:223` | DTO with `IsEnum(GarmentColor, {each})`, trim, `'' → NULL`. CHECK `(brand <> '')` etc. [PG] |
| Category case duplicates ("Tops" vs "tops": same label, different filter value) | `garment.service.ts:54-60` lowercases only for the label | Normalize to `lower(btrim())` on write. CHECK `category = lower(btrim(category))` [PG] |
| `user.email` is nullable and unique case-sensitively; login uses an exact match | `user.entity.ts:30-32`, `auth.service.ts:73` | `NOT NULL`, unique on `lower(email)` [PG] (or lowercase in the DTO) |
| `wardrobe_share`: `permission` has no CHECK. Nothing prevents `grantor = grantee`. Invite tokens never expire. `created_at` has no DB default | `wardrobe-share.entity.ts:40-51` | See the split in §5 |
| `user_device` dedupes by deep-equal of the subscription JSON among the user's own devices, but `push_endpoint` is globally UNIQUE. Re-subscribing with rotated keys, or the same phone under another account, is a unique violation → 500. 404/410 from the push service never prunes the row | `notification.service.ts:55-66, 91-110` | Upsert on `push_endpoint`; delete on 404/410 |
| `new Date(body.date)` on a malformed date → Invalid Date → DB error 500 | `calendar.controller.ts:54` | Validate `YYYY-MM-DD` (moot once the column is a date string) |

---

## 2. Shape

### 2.1 `ShareableId` is not an entity; it is a base class that stamps three columns on four tables

`src/dal/entity/shareableId.entity.ts` adds `shareable_id`, `flagged` and `banned` to `user`, `file`, `garment` and `outfit`.

- `flagged` and `banned` are never read or written anywhere in `src/` or `views/`. They are dead upstream moderation fields: 8 dead columns.
- `user.shareable_id` is never looked up, but carries an index (`user_shareable_id_index`) that has to be maintained.
- `file.shareable_id` exists only so `/file/watermark/:shareableId` and the OG image can address a photo (`file.controller.ts:48-53`, `open-graph.service.ts:56-86`). The garment's or outfit's own share ID would serve.
- **Target:** `share_id uuid NOT NULL UNIQUE` on `garment` and `outfit` only. Drop the base class.
- **Adjacent (security, not data):** `/share` is unauthenticated and prints `From <owner email>` (`open-graph.service.ts:43,67,90`). The `file` branch builds `ogUrl` as `/file/<shareableId>`, but that route takes a file name (`file.controller.ts:30`), so the link is broken.

### 2.2 `File`: one row per photo set, referenced only by `garment.photo_id`

- **What remains of the table:**
  - `mimetype` is never set by `FileService.newFileRow` (`file-service.abstract.ts:254-262`), so it is always NULL. It is still rendered at `views/share.hbs:11`.
  - `flagged` and `banned` are dead.
  - `shareable_id` is covered in 2.1.
  - `created_on` is an ISO **string** compared as text (`storage-reconciliation.service.ts:241`).
  - That leaves `file_name`, `version` and `created_by_id` as the real content.
- **Cost of the separate table:**
  - A join on every grid, builder and calendar query.
  - Two-entity transactions on create, replace and delete (`garment.service.ts:239-253, 308-316`).
  - A whole reconciliation pass ("rows no garment references", `storage-reconciliation.service.ts:196-250`) that exists only because the two rows can diverge.
  - A `$nin` list of every referenced ID (`:235-247`); at 5,000 garments that is a 5,000-parameter `NOT IN`, where a `NOT EXISTS` anti-join would do.
- **Verdict:** it does not earn its place today. Three columns on `garment` would carry it: `photo_key uuid UNIQUE`, `photo_version int NOT NULL DEFAULT 1` and `photo_updated_at`. `imageUrl()` already only needs `{fileName, version}` (`file-url/image-url.ts`).
- **Why this is still nice-to-have:** the current shape is correct, the join is a PK lookup, and folding touches `FileService`, reconciliation, OG and user deletion. Keep `File` if outfit covers or user avatars are ever planned.

### 2.3 Outfit–garment pivot

Covered in 1.5. MikroORM can order an M:N (`fixedOrder`), but a slot here is more than an ordered link. It has a category, and it can be empty, which the builder relies on (`outfit.service.ts:190-201`). That makes `outfit_slot` its own entity, one-to-many from `Outfit` with `orderBy: { position: 'asc' }`, not an M:N. `Garment.outfits` becomes a query over `outfit_slot.garment_id`.

**Redundant index (new, from the shipped work):** `outfit_garments_outfit_id_index` duplicates the leading column of the PK `(outfit_id, garment_id)`. Only the `garment_id` index is needed. This moot once `outfit_slot` replaces the table.

### 2.4 Wardrobe sharing vs a household model

Production has one account, registration is locked, and no sharing is planned (deploy notes). The directional grant (`grantor` lets `grantee` VIEW or MANAGE *their* wardrobe, `wardrobe-share.service.ts:170-196`) is a real feature that a flat household or membership model would lose. With one household, a household model would also add a table and a join to every owner-scoped query. **Keep directional grants.** What is wrong is that one row holds two states:

- **Invite:** `grantee NULL`, `invite_token` set, `accepted_at NULL`.
- **Grant:** `grantee` set, token NULL, `accepted_at` set.
- **Unreachable state:** `grantee` set with `accepted_at NULL`. Nothing ever creates it (no code path sets `grantee` before acceptance), yet `getPendingShares` queries for exactly that (`:128-133`), and the manage page renders an always-empty section for it (`wardrobe-share.controller.ts:46`).
- **Redundant index (new):** `wardrobe_share_grantor_id_index` duplicates the leading column of `UNIQUE(grantor_id, grantee_id)`.
- **Target:**
  - `wardrobe_invite(id, token_hash UNIQUE, grantor_id, permission, created_at, expires_at)`
  - `wardrobe_share(grantor_id, grantee_id, permission, created_at, PRIMARY KEY(grantor_id, grantee_id), CHECK(grantor_id <> grantee_id))`, with an index on `grantee_id`

  Every nullable column disappears, along with the dead query.

### 2.5 Ownership and `AUTH_ENABLED=false`

Every `owner_id` is nullable, and every service has an `owner: null` branch (`garment.service.ts:98-102`, `outfit.service.ts:39-43`, `calendar.service.ts:69-70, 98-100, 146, 429-433`, `wardrobe-share.service.ts:174-184`). That exists for the upstream no-auth mode, which this fork does not run. **Decision D2:** if the fork commits to auth, `owner_id` becomes `NOT NULL` on garment, outfit and calendar, and roughly a dozen branches disappear. Verify first with `SELECT count(*) FROM garment WHERE owner_id IS NULL` (and the same on the other tables).

`outfit_calendar.owner_id` duplicates `outfit.owner_id`. Keep it as a deliberate denormalization, because it makes the `(owner_id, day)` index possible. `create()` enforces the invariant (`calendar.service.ts:97-113`).

### 2.6 Timestamps

- **There are none:** no table has `created_at` or `updated_at` except `wardrobe_share.created_at` (ORM-set, no DB default) and `file.created_on` (string).
- **Proxies in use:** "Newest first" works through `id DESC`. The PWA freshness indicator and any ETag or conditional GET have nothing to key on.
- **Target:** `created_at timestamptz NOT NULL DEFAULT now()` and `updated_at timestamptz NOT NULL DEFAULT now()` on garment, outfit and outfit_slot's parent. `updated_at` is set by the ORM (`onUpdate: () => new Date()`); a trigger is not warranted for one writer.
- **Cost on Postgres 17:** `ADD COLUMN ... DEFAULT now()` uses the fast-default path, with no rewrite. Existing rows get the migration time; `garment.created_at` can be backfilled from `file.created_on` where a photo exists.

### 2.7 Denormalizations for hot pages: none warranted

- **Garment counts:** the grid's "N results" is `garments.length` today. With pagination (§3) it becomes one `count(*)` on the same partial index, well under a millisecond at 5,000 rows.
- **Outfit cover thumbnail:** the outfit list renders every garment's thumbnail anyway (`views/outfits/index.hbs:62-70`), so a cover column would save nothing.
- **Why not counter caches:** at household scale they are a consistency liability with no latency payoff.

### 2.8 IDs

`serial int4` PKs are fine: authorization is checked on every route, and the public surface uses `shareable_id`. Converting to `identity` or `uuid` buys nothing here.

---

## 3. Performance: query shape per hot page, and what changes at 5,000 garments

Default load strategy is `JOINED` (`@mikro-orm/core/utils/Configuration.js:50`).

| Page | Query the model forces | Declared index that serves it | At 5,000 garments |
|---|---|---|---|
| **Wardrobe grid** `GET /wardrobe` (`garment.service.ts:62-103`) | `garment LEFT JOIN file WHERE owner_id=$1 AND archived=false [AND category=… AND size=… AND color LIKE '%c%' AND (name LIKE … OR notes LIKE … OR brand LIKE …)] ORDER BY id DESC`. **No LIMIT.** Plus 3× `SELECT DISTINCT` (brand, size, category) | `garment_owner_id_index (owner_id)`. With one or two owners it is barely selective, so the planner seq-scans and sorts | Every garment hydrated twice over (garment + file entity), ~5,000 cards (≈3-4 MB of HTML) rendered by Handlebars, and 5,000 DOM nodes on a phone. **This is the scaling cliff.** SQL is ms; hydration, rendering and transfer are hundreds of ms and megabytes |
| **Garment detail** | PK lookup + photo + `outfits` via the pivot's `garment_id` index, + ≤1 share lookup | PK, `outfit_garments_garment_id_index`, `UNIQUE(grantor,grantee)` | Flat. Fine |
| **Outfits list** (`outfit.service.ts:32-44`) | `outfit JOIN outfit_garments JOIN garment JOIN file WHERE owner_id=$1`. **No ORDER BY, no LIMIT** | `outfit_owner_id_index` | Grows with outfits × garments. Nondeterministic order (1.5) |
| **Outfit builder** new/edit (`outfit.controller.ts:54, 146-149`) and **row carousel** (`:107-123`) | Form: every non-archived garment + photo, grouped in JS just to show one garment and a count per row. **Every prev/next tap** re-runs `findAll({category})`, loading every garment in the category to pick index `idx` | `garment_owner_id_index`, plus `garment_category_index` (category alone, not owner-first) | Form loads 5,000 rows for ~8 visible cards. Each tap loads ~600 rows to render one |
| **Calendar week + mini-month** (`calendar.service.ts:64-91, 142-150`) | `outfit_calendar WHERE owner_id=$1 AND date >= $2 AND date < $3`, joined to outfit → pivot → garment → file; + outfit picker `(id, name)` | Separate `(owner_id)` and `(date)` indexes | Bounded by one week, so fine. The mini-month renders no entries, so it costs no query |

### Index corrections (Postgres, all `CREATE INDEX CONCURRENTLY`)

- **Grid:** `garment (owner_id, id DESC) WHERE NOT archived`, a partial index that serves the default grid with keyset pagination as an index-only range scan. The archived toggle can fall back to `(owner_id, id DESC)`.
- **Category filter and builder rows:** `garment (owner_id, category, id DESC) WHERE NOT archived`. Then **drop `garment_category_index`**: category-only, not owner-first, low cardinality, and not usefully chosen by any query.
- **Calendar:** `outfit_calendar (owner_id, day)`, replacing the separate `date` and `owner_id` indexes. Keep `outfit_id` for the cascade.
- **Outfits:** `outfit (owner_id, id DESC)` once the list gets an `ORDER BY`.
- **Drop the redundant indexes:** `outfit_garments_outfit_id_index` and `wardrobe_share_grantor_id_index` (PK or UNIQUE prefix duplicates), and `user_shareable_id_index` (never queried).
- **SQLite:** these become plain composite indexes; partial indexes also work in SQLite ≥ 3.8. MikroORM `@Index({ expression })` is needed for the partial/DESC form, and that must be written per driver, which is another D1 cost.

### Code changes the model needs (no schema)

- **Keyset pagination on the grid:** `WHERE id < $cursor ORDER BY id DESC LIMIT 48`, with htmx `hx-trigger="revealed"` on the last card and the count from a separate `count(*)`. This is the single change that makes 5,000 garments feel like 50. It fits the existing `#wardrobe-main` fragment route.
- **Builder:**
  - Row list: `SELECT category, count(*) … GROUP BY category`.
  - Selected garment per slot: by ID.
  - Carousel tap: `… WHERE owner_id=$1 AND category=$2 AND NOT archived ORDER BY id DESC OFFSET $idx-1 LIMIT 1`. OFFSET is acceptable at a few hundred per category; it is served by the category partial index.
- **Outfits list:** `ORDER BY id DESC` and paginate the same way.

### Text search strategy

- **At 5,000 rows:** an owner-scoped `lower(col) LIKE '%kw%'` over three short columns is a few-millisecond filter over the owner's rows.
- **pg_trgm:** a GIN trigram index (`gin (lower(name||' '||brand||' '||notes) gin_trgm_ops)`) pays off from roughly 50-100k rows. It is not needed here.
- **tsvector:** wrong tool: brand names and single words gain nothing from stemming, and it needs a per-language config across six UI languages.
- **Recommendation:** the portable `lower() LIKE` (1.3) now. Leave trigram as a documented threshold.
- **Colour filter:** `color LIKE '%red%'` is safe only because `SearchGarmentDto` restricts it to enum names (`search-garment.dto.ts:15-18`) and no enum name contains another (`garment-color.enum.ts`). That is correct, but fragile to enum additions. [PG] target: `colors text[] NOT NULL DEFAULT '{}' CHECK (colors <@ ARRAY[...])`, filtered with `colors @> ARRAY[$1]`. No index needed at this scale. Portable alternative: store `,red,blue,` with delimiters and match `'%,red,%'`.

---

## 4. Migrations

### 4.1 History hygiene and squash

Postgres tree: 13 files. They include `colors jsonb → color varchar` (`20260306212749`), the accidental `color → smallint` (`20260612010041:13`), its repair (`20260925182919`), and the one-off CONCURRENTLY backfills. SQLite tree: 14 files, **none with `down()`**, three of them destructive rebuilds (1.1).

- **Why squashing is cheap now:** production is one Postgres database, created from these migrations on 2026-09-25.
- **Squash procedure:**
  1. Generate a baseline from the entities against an empty scratch database (`migration:create --initial` requires no prior migrations, per `Migrator.js:148-176`). Plain `CREATE INDEX` is fine there, since a fresh database has no writers.
  2. Diff `pg_dump --schema-only` of prod against the scratch database built from the baseline. They must be identical apart from migration-table rows.
  3. On prod, in one transaction the user approves: `DELETE FROM mikro_orm_migrations; INSERT INTO mikro_orm_migrations(name, executed_at) VALUES ('Migration<ts>_baseline', now());` → verify with SELECT → COMMIT.
  4. Delete the old files and snapshots, then regenerate the snapshot.
- **Risk:** low if step 2 is done. The value is moderate: faster fresh-database CI, the smallint trap gone from history, and the CONCURRENTLY exception confined to future migrations.
- **Timing:** do it **after** the §5 schema changes land, so the baseline is the target model rather than today's.
- **Alternative to the row swap:** a baseline whose `up()` returns early when `to_regclass('public.garment')` is non-null. Rejected: it silently accepts partial schemas.

### 4.2 The CONCURRENTLY backfill (`Migration20260925181256`, `…183958`)

The approach is right: non-transactional per-migration, `allOrNothing: false` so earlier tables are visible (`dal.module.ts:64-71`), and a spec that enforces `concurrently if not exists` (`postgres-indexes.spec.ts`). One real gap and one limit:

- **INVALID indexes pass silently.** A failed concurrent build leaves an INVALID index. On rerun, `IF NOT EXISTS` skips it and the migration records success. The comment (`:14-15`) says the invalid index must be dropped by hand first, but nothing detects one. Add a boot or migration assertion: `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid` must return nothing, else fail loudly. Worth a one-time manual check on prod now.
- **Hand-editing each generated migration is the only mechanism.** The next index added via `@Index()` will again be generated as a locking `create index` unless someone remembers. The spec only covers migrations listed in `INDEX_MIGRATIONS`. Make the spec scan **every** Postgres migration for `create index` without `concurrently`, rather than a hand-maintained list.

### 4.3 Keeping the two trees in sync

- **The CLI configs read different entity sources:**
  - Postgres reads `src/**` TypeScript (`mikro-orm.postgres.cli-config.ts:14`).
  - SQLite reads `./dist/**` through `entitiesTs` (`mikro-orm.sqlite.cli-config.ts:9-10`, with `entities` and `entitiesTs` swapped relative to their names).
  - A forgotten `npm run build` therefore generates the SQLite twin from stale metadata and the Postgres twin from current source. This is a drift source by design.
  - The two configs also disagree on `allOrNothing`, and on `pattern` (`/^[\w-]+\d+|\d\.ts$/` against the runtime's `/^.*\.(js|ts)$/`).
- **No schema-equivalence check:** nothing asserts that a migrated database equals the entity metadata. The integration harness already boots through `orm.migrator.up()` (`app.module.ts:254`). One assertion that `orm.schema.getUpdateSchemaSQL()` is empty after boot, on both CI drivers, catches a forgotten twin, a hand-edited index that metadata does not declare, and stale-dist generation.
- **Snapshots:** `.snapshot-postgres.json` and `.snapshot-sqlite3.db.json` are CLI-only (runtime `snapshot: false`), and they match the entities today. The known stray-snapshot-per-dbName issue (deploy notes) stays open.

---

## 5. Proposal

### Decisions first

- **D1: drop SQLite for this fork (recommended).**
  - *Gains:* removes 1.1 outright, prevents the 1.3 and 1.4 class of bug, halves migration work, and unlocks the [PG] items: `date`, `uuid`, `text[]`, CHECK, partial and expression indexes, `citext`/`lower()` uniqueness.
  - *Cost:* the ~3 s in-memory integration loop becomes a Postgres-per-spec loop. The harness already supports it (`TEST_DATABASE_URL`, one database per spec file). Upstream merges get harder, but the fork has already diverged heavily.
  - *If you keep SQLite:* every [PG] item below degrades to application validation, and 1.1 needs its own fix.
- **D2: drop `AUTH_ENABLED=false` for this fork.** This allows `owner_id NOT NULL` and removes about a dozen `owner: null` branches (2.5).

### Target model (Postgres; assumes D1 and D2)

```
user            id serial PK, email text NOT NULL, password text NOT NULL, first_name text, last_name text,
                created_at timestamptz NOT NULL DEFAULT now()
                UNIQUE (lower(email))
password_reset  user_id int PK → user ON DELETE CASCADE, pin_hash text NOT NULL,
                expires_at timestamptz NOT NULL, attempts smallint NOT NULL DEFAULT 0
user_device     id serial PK, user_id int NOT NULL → user CASCADE, push_endpoint text NOT NULL UNIQUE,
                subscription jsonb NOT NULL, user_agent text, created_at timestamptz NOT NULL DEFAULT now()
                INDEX (user_id)
garment         id serial PK, owner_id int NOT NULL → user CASCADE, share_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
                name text, category text NOT NULL CHECK (category <> '' AND category = lower(btrim(category))),
                brand text CHECK (brand <> ''), size text CHECK (size <> ''),
                colors text[] NOT NULL DEFAULT '{}' CHECK (colors <@ ARRAY['red',…,'other']),
                notes text, washing_details text, acquired_on date, archived boolean NOT NULL DEFAULT false,
                photo_id int UNIQUE → file SET NULL   -- or, if folded: photo_key uuid UNIQUE, photo_version int NOT NULL DEFAULT 1
                created_at, updated_at timestamptz NOT NULL DEFAULT now()
                INDEX (owner_id, id DESC) WHERE NOT archived
                INDEX (owner_id, category, id DESC) WHERE NOT archived
file (if kept)  id serial PK, file_name text NOT NULL UNIQUE, version int NOT NULL DEFAULT 1,
                created_by_id int → user CASCADE, created_at timestamptz NOT NULL DEFAULT now()
                INDEX (created_by_id)
outfit          id serial PK, owner_id int NOT NULL → user CASCADE, share_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
                name text, notes text, created_at, updated_at
                INDEX (owner_id, id DESC)
outfit_slot     outfit_id int → outfit CASCADE, position smallint, category text NOT NULL,
                garment_id int NULL → garment ON DELETE SET NULL,
                PRIMARY KEY (outfit_id, position), INDEX (garment_id)
outfit_calendar id serial PK, owner_id int NOT NULL → user CASCADE, outfit_id int NOT NULL → outfit CASCADE,
                day date NOT NULL, worn_at timestamptz
                INDEX (owner_id, day), INDEX (outfit_id)
wardrobe_invite id serial PK, grantor_id int NOT NULL → user CASCADE, token_hash text NOT NULL UNIQUE,
                permission text NOT NULL CHECK (permission IN ('VIEW','MANAGE')),
                created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
wardrobe_share  grantor_id, grantee_id int → user CASCADE, permission text NOT NULL CHECK (…),
                created_at timestamptz NOT NULL DEFAULT now(),
                PRIMARY KEY (grantor_id, grantee_id), CHECK (grantor_id <> grantee_id), INDEX (grantee_id)
```

Removed: `flagged` and `banned` (×4), `user.shareable_id`, `user.password_reset_id`, `file.shareable_id`, `file.mimetype`, `file.created_on` (string), `outfit.slots` (JSON), `outfit_garments`, `outfit_calendar.notes` (no UI writes it; `views/calendar` has no notes field), and the redundant indexes listed in §3.

### Migration path from production

Every step is its own Postgres migration, and the steps are independent unless noted. Before starting, run a read-only step 0 on prod (the user runs it; no writes):

```sql
SELECT (SELECT count(*) FROM garment) g, (SELECT count(*) FROM outfit) o,
       (SELECT count(*) FROM outfit_garments) og, (SELECT count(*) FROM outfit_calendar) c,
       (SELECT count(*) FROM password_reset) pr, (SELECT count(*) FROM wardrobe_share) ws;
SELECT count(*) FROM garment WHERE owner_id IS NULL;            -- D2 precondition (repeat for outfit, outfit_calendar)
SELECT count(*) FROM outfit_calendar
  WHERE date <> date_trunc('day', date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';   -- must be 0
SELECT shareable_id, count(*) FROM garment GROUP BY 1 HAVING count(*) > 1;      -- must be empty (and outfit, file)
SELECT DISTINCT unnest(string_to_array(color, ',')) FROM garment;               -- all enum names?
SELECT count(*) FROM garment WHERE brand = '' OR size = '' OR color = '' OR category <> lower(btrim(category));
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;                 -- must be empty
```

**Must-fix (correctness):**

| # | Step | Lock / rewrite | Risk |
|---|---|---|---|
| M1 | Invert the password-reset FK: add `password_reset.user_id`, backfill from `user.password_reset_id`, drop the old FK and column, add `pin_hash`/`expires_at`, delete orphans. Code: hash, expire, consume | Tiny table | **Low** (likely 0 rows) |
| M2 | `varchar(255) → text` on every free-text column | Catalog-only on PG (binary-coercible) | **None** |
| M3 | Case-insensitive search + wildcard escaping (code only); mixed-case integration assertion | none | **None** |
| M4 | If SQLite is kept: non-transactional rebuild migrations + `allOrNothing: false` + seeded upgrade test. If D1: delete the tree | n/a | Low |
| M5 | `outfit_slot` expand: create table, backfill from `outfit.slots` via `jsonb_array_elements … WITH ORDINALITY` (a `garment_id` survives only if the garment exists **and** has the same owner, else NULL); outfits with pivot rows but no slots get one slot per pivot row ordered by `(category, id)`. Verify: count of slots with a garment = count of pivot rows, per outfit. Switch reads and writes. **Contract** (drop `outfit_garments`, `outfit.slots`) one release later | Small tables, in-transaction | **Medium**: the two sources can disagree; run the verification SELECT before the contract step |
| M6 | Calendar and acquisition dates → `date` (`USING (col AT TIME ZONE 'UTC')::date`), rename to `day` and `acquired_on`, one `APP_TIMEZONE` for "today", remove the local/UTC mix in `findWeek` | ACCESS EXCLUSIVE + rewrite; ms at this size | **Medium** (every calendar code path changes; step 0 check must be 0) |
| M7 | `UNIQUE` on share IDs (`CREATE UNIQUE INDEX CONCURRENTLY`, then drop the plain index); garment write DTO validation; `'' → NULL` backfill; CHECKs added `NOT VALID` then `VALIDATE CONSTRAINT` (validation takes no write lock) | Concurrent / no write lock | Low |
| M8 | `user_device` upsert by endpoint + 404/410 pruning (code) | none | Low |

**Nice-to-have (simplicity and performance):**

| # | Step | Risk |
|---|---|---|
| N1 | Keyset pagination: grid and outfits list; builder `GROUP BY` / `LIMIT 1` queries | Low (code only). **Highest-value performance item** |
| N2 | Composite partial indexes (§3), built CONCURRENTLY; drop `garment_category_index`, `outfit_garments_outfit_id_index` (moot after M5), `wardrobe_share_grantor_id_index`, `user_shareable_id_index` | Low |
| N3 | Drop dead columns (`flagged`/`banned` ×4, `user.shareable_id`, `file.mimetype`, `file.shareable_id` once OG uses the garment/outfit share ID); `file.created_on` → `created_at timestamptz USING created_on::timestamptz` | Low (`DROP COLUMN` is catalog-only) |
| N4 | `owner_id NOT NULL` (D2): `ADD CONSTRAINT … CHECK (owner_id IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` (PG12+ uses the validated check, so no scan under lock) → drop the check | Low once step 0 shows 0 NULLs |
| N5 | Split `wardrobe_invite` / `wardrobe_share`; hash tokens; add expiry. Current rows: accepted → share, pending → invite | Low (table likely empty) |
| N6 | `created_at` / `updated_at` columns (fast default) | Low |
| N7 | `color` → `colors text[]` [PG] with CHECK | Low-medium (`USING string_to_array(nullif(color,''), ',')`) |
| N8 | Fold `File` into `garment` (`photo_key`, `photo_version`), retire the rows→garments reconciliation pass | **Medium** (FileService, reconciliation, OG, user delete); optional |
| N9 | Migration hygiene: INVALID-index assertion, spec scans every PG migration, `getUpdateSchemaSQL()` empty-after-boot assertion, align CLI configs | Low |
| N10 | Squash to a baseline after everything above lands (§4.1) | Low with the schema diff |

**Suggested order:** M2, M3, M1 (instant or near-free); then M7, M8; then M5 and M6 (the two medium ones, each with its verification query); then N1 and N2 together (pagination is what the indexes are for); then N3-N9; N10 last.

---

## 6. DESIGN.md drift (docs)

`docs/DESIGN.md`'s entity section no longer describes the model:

- It lists `colors: string[]`; the code has a comma-joined `color`.
- It lists an 11-value category enum; the code has 8 values plus free text.
- It lists `shareableId` as UK; the code has a plain index.
- It has no slots, archive, calendar, sharing or file version.

It is the document that feature work is "assessed against" (CLAUDE.md), so it should be updated alongside M5 and M6.
