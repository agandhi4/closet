# Add several garments from photos at once; export the wardrobe (#200)

Two features from the upstream triage of 2026-09-28: choosing several photos from the library makes one draft per photo, and settings exports the wardrobe as CSV and JSON. Out of scope: CSV import, and photo archives in the export (the JSON carries photo URLs).

## Multi-add

### Drafts are pending photos in a batch

A draft is a pending photo (`pending_photo`, `src/web/files/pending-photos.ts`): bytes stored, no `file` or `garment` row until its form is saved, removed by reconciliation after a week (a single pending photo keeps its day: owner, 2026-09-28, since a 30-photo batch takes more than an evening). The batch reuses that storage and adds three nullable columns in `drizzle/0030_pending_photo_batch.sql`:

- `batch_id` (uuid): the upload the photo came in.
- `batch_position` (smallint): its place in that upload, so the queue keeps the order the photos were picked in. A batch's rows share one `created_at` (one transaction), so the timestamp cannot order them.
- `batch_owner_id`: the wardrobe the batch adds to, so a grantee's drafts for a shared wardrobe resume there and not in their own. `on delete set null`: a draft whose wardrobe is gone shows nowhere and is reconciled after a week like any draft, with its bytes.

A check keeps `batch_id` and `batch_position` null together.

### Avoiding the eviction at MAX_PENDING_PER_USER

Decision: **an explicit allowance for batched drafts, refused rather than evicted past it.**

- `MAX_PENDING_PER_USER` (10) and its oldest-first eviction apply only to unbatched pending photos (link import, the camera, a one-photo library pick). They are one-at-a-time and the eviction is what keeps a browsing session from piling up bytes.
- Batched drafts count against `MAX_DRAFTS_PER_USER` (30), and are never evicted. An upload that would take a user past 30 is refused whole with a 409 naming how many are waiting. Nothing from it is kept. The check runs twice: before the body is read, which leaves room for at least one photo (the upload's `files` limit is the room left, so the parser stops at the first photo past it); and under the per-user advisory lock when the rows are written.
- Why not raise the cap for a batch: an eviction would still silently take the oldest drafts when the next batch or a single upload arrives. Why not chunk: the user picked 15 photos once, and chunking means either several uploads they must start themselves or client code that splits and sequences posts. Both lose drafts when one chunk fails.
- 30 is two full batches of 15. At about 400 KB a prepared photo, that is 12 MB of drafts a user can hold for at most a week, which the nightly pass then removes.

A photo in the batch that cannot be read (not an image, a HEIC over its cap, too many pixels) is left out. The others are kept, and the queue names the ones left out, so nothing is lost silently. A batch in which no photo could be read is the error page. A one-photo pick keeps today's path and today's errors.

### The draft queue

- The library row's input is `multiple`, and `photo-input.js`'s `preparePhoto` prepares every chosen file (a 1600 px JPEG each, HEIC left for the server). It still returns the first, so the handler string cached pages carry keeps working. The camera stays single.
- `POST /wardrobe/new/photo` with two or more photos stores each through `storeUpload` in turn (awaited, so at most one HEIC is buffered at a time), records the batch, and answers 303 to the first draft: `GET /wardrobe/new?photo=<name>`. That URL is the same new garment form a single upload opens, so the duplicate check (#20, `addsToCloset`) runs on every draft, as do the properties' presets and the owner-only fields.
- A draft's form differs in three ways:
  1. **The queue above the form**: "N photos to add", a strip of the remaining drafts' thumbs (each a link to that draft, the current one marked), **Skip** (the next draft after this one, wrapping around) and **Discard** (a `PostForm` to `POST /wardrobe/new/drafts/discard`, which reuses `discardPendingPhoto`). It also says that waiting photos are kept for a week, and lists any photos the upload left out.
  2. **Category first**, above Name, so the category's properties (its types, warmth, weight) come next as the form already redraws them.
  3. **Save goes to the next draft**, not to the garment page: `POST /wardrobe` sees that the claimed photo was a draft (it reads the batch before the claim), and answers 303 to the next draft after it in picked order, wrapping round, so a skipped draft comes back once the rest are done.
- The saved garments' ids travel with the queue: a hidden `draftsSaved` in the form, `saved=` on Skip, Discard and the thumbs. It is navigation state, never stored. Malformed ids are dropped, and ids outside the wardrobe select nothing. When no draft is left, the save lands on **select mode with the batch checked** (`/wardrobe?select=1&checked=<ids>`), saying how many were added, so the bulk edit (#12b, "Set…") tags them together. The batch's garments are the newest, so they are on the first page.
- **Resuming**: the closet grid shows a slim prompt, "N photos waiting to be added · Continue", to anyone who can add, for their own drafts in that wardrobe (`batch_owner_id`). Closing the app mid-queue loses nothing for a week.

## Export

- `GET /wardrobe/export.csv` and `GET /wardrobe/export.json`, linked from Profile › Export (plain links with `download`, `hx-boost="false"`). Both are `attachment`s named `closet-<household today>.<ext>` with `Cache-Control: no-store`. `bypassesWorker` (`src/web/page-cache.ts`) keeps the service worker from treating them as pages, so an export is never stored in the page cache and never answered from it offline.
- **Owner only, grantees cannot export.** The route resolves `?ownerId=` with `need: 'own'`: a MANAGE or VIEW grantee is a 403, a stranger a 404, as for archive and delete. An export is a copy of the whole wardrobe to keep. It includes the owner's own records (where it is and why, when it was last washed, its wash limit) that a share never shows. MANAGE lets a grantee edit garments one at a time, which is not the same as taking the data. With no grantee path, nothing owner-only can leak through the export. Repair costs are not in it at all: the repair log is a table of its own, not a garment field, and stays on the garment page.
- **Columns**: every column of `garment` except `owner_id` (always the requester) and `photo_id` (an internal row id), read from Drizzle's `getTableColumns(garment)`. A column added later lands in the export without a second list, and the round-trip test fails if the export and the table ever disagree. The names are the database's (`acquired_on`, `care_wash`), the same in both formats. That gives: `id`, `shareable_id`, `name`, `category`, `brand`, `size`, `notes`, `colors`, `acquired_on`, `washing_details`, `status`, `replaces_garment_id`, `type`, `warmth`, `formality`, `materials`, `pattern`, `fit`, `sleeve`, `length`, `fabric_weight`, `water_resistant`, `source_url`, `price`, `quantity`, `wash_after_wears`, `last_washed_on`, `away`, `away_note`, `condition`, `condition_note`, `care_wash`, `care_bleach`, `care_dry`, `care_iron`, `care_dry_clean`. Then the photo: `photo_url`, `cutout_url` and `thumb_url`, absolute URLs on the request's origin, `cutout_url` empty unless the cutout is shown. The photos are public by name already (`/file/**`).
- **Values**: stored values, not labels (`dry-clean-only`, warmth `3`), so a spreadsheet can filter them and a future import can read them back. In CSV, null is an empty cell, which is lossless because the form stores blank text as NULL, never ''. Sets are joined with `, `, since no set value holds a comma. Booleans are `true`/`false`. The JSON keeps types: arrays, numbers, booleans, null. `price` stays a decimal string (`"24.90"`), so no cent goes through a float. The JSON is `{ "exportedAt", "garments": [ { ...columns, "photo": { "original", "cutout", "thumb" } | null } ] }`.
- **Streaming**: keyset pages of 200 garments by id over the owner's rows (every status, the wishlist and archived included, since `status` says which), each page one statement with its photo joined. The pages are written to a `Readable` that Fastify sends and compresses as it goes. A closet of any size holds one page in memory. An error mid-stream is logged and ends the response, which the browser reports as a failed download.
- **CSV escaping**: RFC 4180 (a cell with `,`, `"`, CR or LF is quoted, `"` doubled, CRLF line ends) and a UTF-8 BOM for spreadsheet apps. A cell starting with `=`, `+`, `-`, `@`, a tab or CR is prefixed with `'` first (OWASP's CSV injection advice), so a garment named `=HYPERLINK(...)` is text in every spreadsheet. The JSON is not escaped that way: it is data, not a sheet.
- **Proof**: `test/integration/wardrobe-export.spec.ts` fills every column of a garment (the fixture asserts none is null), exports both formats, and compares every exported field with the row read back from the database. Both CSV and JSON are un-escaped by the spec's own parser. The spec also covers a second page of garments, formula cells, and the grantee and stranger refusals.
