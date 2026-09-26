# Wardrobe features plan (2026-09-26)

Status: **proposed**, awaiting owner approval. Six features, built in this order because each feeds
the next: adding garments from a link, wears and washes (with multiples), capsules, the outfit
gallery, trips, AI guidance (optional).
`docs/DESIGN.md` listed wear tracking and packing lists / capsules as out of scope for v0.1; this
is that next step.

## Owner decisions (2026-09-26)

- **Trips are a standalone outfit list**, not a date range over the calendar.
- **The gallery shows generated combinations and saved outfits.** A generated one becomes an outfit
  only when picked.
- **AI sees metadata only** (category, colours, brand, name, notes, wear counts). No photos, emails
  or share data leave the homelab. Off unless configured.
- **Capsules are carved out of one default closet.** The closet is every unarchived garment; a
  capsule (summer, office, festival) is a subset of it.
- **Multiples are built in**: three identical white tees are one garment with a quantity of 3.
- **Garments can be added from a link**: a product page (scraped, reviewed before saving) or a
  direct image URL (photo only, the rest typed in).
- **Features before bulk onboarding.** Production holds 1 garment, 0 outfits and 0 calendar entries,
  so no migration has live data to convert. Onboarding stays a candidate for later.

## Principles that hold across all six

- **Private per owner, like outfits.** Capsules, trips, wears and washes are scoped to the signed-in
  user. Shares never reach them, and another user's id is a 404 (Request security, "Refusals do not
  reveal ids"). A capsule or trip only ever holds the owner's own garments and outfits; the write
  drops any other id, as the outfit form does.
- **One writer per state.** Each new piece of state has one function that changes it. The calendar
  entry's worn toggle and its wear rows change together in one transaction, never from two places.
- **Counts are derived, never stored.** Wear counts, wears since the last wash and "needs a wash" are
  computed from `garment_wear` rows. Household-sized data makes this free, and a stored counter
  would drift the first time an entry is unmarked.
- **Category roles.** The generator, the laundry defaults and the packing list group garments by what
  they do in an outfit. `categoryRole(category)` in `src/web/wardrobe/garment.ts` (pure) maps the
  built-in categories: `tops` to top, `bottoms` to bottom, `dresses` to one-piece, `footwear` to
  footwear, `outerwear` to layer, `accessories` and `bags` to accessory, `other` and every custom
  category to none. A garment with role none is never generated into an outfit, but can still be
  put in one by hand.
- **Offline.** Every new page reads from the network with the cache as a fallback, like the others.
  Writes (pick, pack, wore, washed) are disabled offline with the explanation `frontend-pwa.md`
  requires. The gallery needs the server to generate, so offline it shows only what the cache holds.

## 0. Adding a garment from a link

One flow for both kinds of link: `/wardrobe/new/from-link` takes a URL and ends on the normal garment
form, prefilled, for review. Nothing is saved until the form is posted.

- **A direct image URL** (the response is an image): the photo is fetched and the form opens with it
  and blank fields. This is the basic version, and it is step one of the full one.
- **A product page** (HTML): extracted in order of reliability. schema.org `Product` JSON-LD (name,
  brand, colour, images, sku, price), then Open Graph (`og:title`, `og:image`), then `<title>`. Colour
  text is mapped onto `GARMENT_COLORS` where it matches ("Navy" to blue, else left for review), and
  the category is guessed from the name ("tee" to tops) and always confirmed by the user. When a
  page offers several images, the form shows them as choices (product shots on a plain background
  cut out best).
- **Best effort, by design.** Some retailers render client-side or block bots. When extraction finds
  nothing, the form opens with the URL kept and says so, so the user can paste an image link. The
  optional AI (section 5) can later read a page the extractor could not. A retailer's product page is
  not personal data, so that stays within the metadata-only rule.
- **The photo goes through the existing pipeline**: `Photos` (the `MAX_INPUT_PIXELS` decode bound,
  WebP variants), then the cutout queue, exactly like an upload. The fetched bytes are held as a
  pending photo until the form is saved and deleted if it never is (the nightly reconciliation's
  day-old rule already covers orphans).
- **New columns**: `garment.source_url` (the product page, a link back from the garment page) and
  `garment.price` (optional, numeric). Price is filled by extraction or by hand, and with wear counts
  it gives cost per wear, which `docs/DESIGN.md` listed as future work.
- **Share to Closet.** The manifest gets a `share_target`, so on Android "Share" on a product page
  in any app sends its link straight to this flow. iOS does not support share targets for web apps;
  there it is copy the link, then paste.

**Outbound fetch is an SSRF surface, and linux-box can reach the NAS, pgvault and the router.**
Push's guard is an allow-list of push services and does not fit arbitrary retailer hosts. A new
`src/web/security/outbound-fetch.ts` is the only way the server fetches a user-supplied URL:

- http(s) only, default ports.
- Resolve the name and refuse loopback, private, link-local, CGNAT/Tailscale (100.64.0.0/10) and
  IPv6 unique-local addresses. Then connect to **the address that was checked** (a pinned lookup),
  so DNS rebinding cannot swap it afterwards.
- Follow at most 3 redirects, each re-checked the same way.
- Caps: 10 s total, 2 MB for HTML, 15 MB for an image, content type checked.
- No cookies or credentials sent, and a plain identifying user agent.
- Rate-limited per user. One log line per fetch with the host only, never the full URL (it can
  carry tokens).

## 1. Wears and washes

**Problem.** "Worn" is only `outfit_calendar.worn_at`, and composition is `outfit_slot`, which
changes when the outfit is edited. A count computed by joining the two rewrites history: swap the
shoes in March and January's wears move to the new shoes. Wears need their own record, snapshotted
at the moment they happen.

**Schema**

- `garment_wear`: `id`, `garment_id` (FK, cascade), `owner_id` (FK, cascade), `day date`,
  `outfit_calendar_id` (FK nullable, cascade), `created_at`. Unique
  `(outfit_calendar_id, garment_id)`, so one entry cannot count a garment twice. Index
  `(garment_id, day)` for the counts.
- `garment.last_washed_on date` (nullable) and `garment.wash_after_wears smallint` (nullable: null
  means the role's default).
- `garment.quantity smallint not null default 1` (check `>= 1`): identical copies (see Multiples).

**Rules**

- **Marking a calendar entry worn** snapshots the outfit's non-empty slots into `garment_wear` rows
  for that entry's day. Unmarking deletes them. Deleting the entry cascades to them. It is one
  function, `setEntryWorn` (replacing today's toggle), one transaction.
- **Logging one garment** ("Wore today", garment page) inserts a row with `outfit_calendar_id` null.
  It can be undone the same day.
- **Wearing an outfit off the calendar** (from a trip or the gallery: "Wearing this today") schedules
  it for today and marks that entry worn. The calendar stays the one history of which outfit was
  worn when.
- **Since last wash** = wears with `day > last_washed_on` (all wears when it was never washed). A wear
  on the wash day counts as before the wash: you wash what you wore.
- **Needs a wash** when wears since the last wash reach `wash_after_wears`, or the role default: top
  1, one-piece 1, bottom 3, layer 10, footwear and accessory never. The defaults live in one table in
  `garment.ts`.
- **Washed** sets `last_washed_on` to today (`APP_TIMEZONE`). No wash history table until something
  needs one.

**Multiples.** A garment with quantity N is N interchangeable copies. Which copy you wore is not
tracked, because for identical tees it does not matter. Copies that differ (another size, a worn-out
pair) are separate garments, which the existing Clone button makes quickly.

- The wash rules count copies: with limit k, **dirty copies = ceil(wears since last wash / k)**, capped
  at N, and **clean copies = N minus that**. It **needs a wash** only when no clean copy is left. Three
  white tees (k = 1) stay available for three wears.
- Washed washes every copy (laundry day). Laundry and the grid show "2 of 3 need a wash".
- The generator uses a garment while a clean copy remains. The trip packing list needs one copy per
  k outfits that use it, up to N: "White tee x3". When a trip needs more than the wardrobe owns, the
  list says so.
- The grid shows a "x3" badge. The garment form has a quantity stepper.

**UI**

- Garment page: "Worn 12 times, 2 since washed, last worn Tue". Buttons: Wore today, Washed.
  "Wash after N wears" goes in the garment form.
- Wardrobe grid: a "Needs a wash" filter, and a small mark on those tiles.
- `/laundry`: the garments that need a wash as a checkbox grid, with "Mark washed" for the whole
  load in one post.

## 2. Capsules

A named set of the owner's garments (seasonal, work, a trip's pool) that the rest of the app filters by.

**The default closet is implicit, not a row.** "Closet" is every unarchived garment, and it is what
every page already shows when no capsule is chosen. The UI presents it as the first, permanent
capsule, and new capsules are picked from it. It is deliberately not a stored capsule containing
every garment: that would need a second write on every garment insert and a rule that the two
always agree, which would drift. "In the closet" already has a single definition (owned and not
archived), and removing a garment from the closet is archiving it. Capsule membership never includes
an archived garment in what it shows.

**Schema.** `capsule` (`id`, `owner_id`, `name`, `notes`, `created_at`) and `capsule_garment`
(`capsule_id`, `garment_id`, primary key both, cascade both, index on `garment_id`). A garment may
be in any number of capsules. Archiving a garment keeps its membership; it is filtered out like
everywhere else.

**Routes and UI**

- `/capsules`: a list, each card showing a strip of cutout thumbs and a garment count. `/capsules/new`,
  `/capsules/:id` (its garments as a grid, plus a "Swipe outfits" button into the gallery),
  `/capsules/:id/edit`.
- **Membership is edited with a picker**: the wardrobe grid in select mode (checkbox tiles, the same
  keyset paging and filters), posting the whole selection. The garment page also gets an "In
  capsules" row of toggles.
- The wardrobe grid and the outfit builder take `?capsule=`, so building from a capsule only cycles
  its garments.
- Navigation: a Capsules tab on the wardrobe page, not a new dock item. The dock stays at its current
  size.

## 3. Outfit gallery (the swipe picker)

**Layout.** Full-width outfit cards in a horizontal CSS scroll-snap strip
(`overflow-x-auto snap-x snap-mandatory`, cards `snap-center shrink-0 w-full`). Swiping is native
scrolling, with no JS library and no touch handlers. Each card stacks the cutouts the way you would
lay clothes on a bed: layer and top above, then bottom, then footwear, with accessories beside them.
The last card is followed by a sentinel (`hx-trigger="intersect"`) that loads the next page and
replaces itself, as the wardrobe grid does.

**Sources.** Two tabs. **Ideas** holds generated combinations and **Saved** holds the owner's outfits,
both limited to a capsule when one is chosen.

**Generator** (`src/web/gallery/generate.ts`, pure, unit-tested):

- Pool: the capsule's garments or all unarchived ones, minus those that need a wash.
- Templates: top + bottom + footwear, or one-piece + footwear, each optionally with a layer.
  Accessories are not generated.
- Ordering: a seeded shuffle, weighted toward garments worn least recently, so the gallery rotates
  the wardrobe instead of showing the favourites. It also avoids more than two non-neutral colours in
  one outfit (neutrals: black, white, grey, beige, navy, brown, as `GARMENT_COLORS` names them) and
  skips combinations identical to a saved outfit.
- Paging: the seed and an offset in the URL, so a page is stable and reproducible. A new seed is
  "Shuffle".
- Scale: combinations are enumerated lazily from the seed. Even 40 tops, 20 bottoms and 10 shoes
  (8,000) is sampled, never materialized.

**Picking.** A card's primary action depends on where the gallery was opened from, carried as
`?for=`:

- From the calendar (`for=day:YYYY-MM-DD`): "Wear on Tue". A generated card becomes an outfit (slots
  in role order) and is scheduled, in one transaction.
- From a trip (`for=trip:ID`): "Add to trip". The same, but added to the trip.
- With no context: "Save". Also on every card: "Wearing this today".

A picked generated outfit gets a name you can change later (for example "Navy tee, jeans, white
sneakers"), built from its garments' names or categories.

## 4. Trips (standalone outfit list)

**Schema**

- `trip`: `id`, `owner_id`, `name`, `destination` (text, optional), `starts_on` and `ends_on`
  (dates, optional; informational, for the AI and the list, not the calendar), `notes`,
  `created_at`.
- `trip_outfit`: `trip_id`, `outfit_id`, `position`. Primary key `(trip_id, outfit_id)`, cascade
  both.
- `trip_item`: `id`, `trip_id`, `label`, `packed`, `position`. The extras: charger, toiletries,
  passport.
- `trip_garment_packed`: `trip_id`, `garment_id`. A row means packed. Rows whose garment has left
  the list (the outfit was removed) are ignored and cleaned up on that removal.

**Packing list** (derived, never stored): the distinct garments across the trip's outfits, grouped
by role, each with "in 3 outfits" and the number of copies to pack (Multiples, section 1), then the
extras. Checkboxes toggle packed through htmx (like the
worn pill), with a count of how much is packed. A garment that needs a wash is flagged on the list,
since it has to be washed before packing.

**UI.** `/trips` (upcoming first), `/trips/new`, `/trips/:id` (outfits strip, packing list), add
outfits from the saved list (checkboxes) or through the gallery with `for=trip:ID`, and "Copy
extras from a previous trip". On the trip, "Wearing this today" on an outfit records the wear
through the calendar (section 1).

## 5. AI guidance (optional)

- **Config**: `ANTHROPIC_API_KEY` (optional, no default; unset means every AI control is absent),
  plus a model setting whose default is picked at implementation from the current Claude models. It
  goes through `loadConfig()` and the README table like every variable.
- **Data sent**: garment id, category, role, colours, brand, name, notes, wear count, last worn.
  Trip name, destination, dates and outfit count. Never photos, emails, share data or other users'
  data.
- **Uses**, each a lazy htmx fragment that loads after the page, so a slow or failed call never
  blocks one:
  - Gallery: rank the page's candidates and give each card a one-line "why this works".
  - Trip: suggest how many outfits the dates need, the extras to add (as one-tap `trip_item`s), and
    gaps ("no layer for 12°C evenings"). Weather is out of scope here (upstream issue #120 is the
    place for it).
  - Capsule: gaps and redundancies.
- **Logging and cost**: one line per call (use, model, tokens in and out, ms). An in-memory cache per
  input hash, so repeated views do not repeat calls. Failures are a quiet "Suggestions unavailable",
  never an error page.
- It is advisory only: AI output never writes anything without the user tapping.

## Delivery

Each feature is its own GitHub issue (six) and ships alone. The work for each: its schema and migration
(the drift test), integration specs first (behavior, authorization matrix rows for the new routes,
the one-writer rules), unit specs for the pure parts (roles, wash rules, the generator), a
phone-width browser check as the installed PWA, and the CLAUDE.md sections (Architecture, Routes)
updated in the same commit.

## Open questions

1. Link import is built first (section 0) because every other feature needs a stocked wardrobe and
   this is the fastest way to stock it. Say if it should wait until after wears and washes.
2. The role-default wash thresholds (top 1, bottom 3, layer 10) are a guess. Adjust them to taste.
3. Should a trip's outfits also go on the calendar? Currently no, per the decision. A "Schedule
   these" button could be added later without changing the model.
