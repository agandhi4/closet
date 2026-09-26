# Wardrobe features plan (2026-09-26)

Status: **approved 2026-09-26**, every section. The backlog is GitHub issues (one per section, in
milestones by phase, ordered in the pinned Roadmap issue); this document holds the design and the
reasons, and each issue links to its section. Build order, each feeding the next: garment
properties (6), adding garments from a link (0), wears and washes with multiples (1), outfits by
occasion (8), capsules (2), weather (7), the outfit gallery (3), Today (9), trips (4), weekly auto-plan (12),
insights (10), wishlist (11), outfit selfies (13), AI guidance (5, optional). The owner wants the app full-featured: features seen in Cladwell, Whering, ALTA and
others are welcome and are collected under "Candidate features" as research finds them.
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

## Principles that hold across every feature

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
- `garment.away text` (nullable, check `lent` or `repair`) and `garment.away_note`: out of the
  closet for now. A manual state, separate from the derived wash state. Unavailable garments are
  skipped by the generator and flagged on packing lists. Returning one clears it.

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

**Style this item.** `?with=<garmentId>` generates only outfits that contain that garment
(reached from the garment page and from the insights' unworn list).

**Say why not.** A card can be dismissed with a reason: too warm, too cold, clashes, not today.
Too warm and too cold adjust the personal temperature offset (section 7). Clashes stores the
garment pair in `generator_avoid` (owner, garment a, garment b), which the generator never combines
again (undo from the garment page).

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

## 6. Garment properties

**Goal:** store a lot about each garment without making the form a chore. The heavy tee versus the
light tee is the example: two garments with the same category and colour that belong to different
weather.

**Model: typed, nullable columns on `garment`, never a key/value or JSON bag.** Every property is
optional, has a fixed value set enforced by a check constraint (as the colours are), and is added by
a migration, which drizzle-kit makes cheap. The generator, the weather matching and the filters read
them as plain columns. A JSON bag would let values drift from the code's list with nothing to catch
it. That is how the free-text colours became a stored XSS.

| Property | Values | Applies to | Drives |
|---|---|---|---|
| `type` (subcategory) | a fixed list per category: tops = t-shirt, shirt, polo, blouse, sweater, cardigan, hoodie, sweatshirt, tank, ...; bottoms = jeans, chinos, trousers, shorts, skirt, joggers, ...; outerwear = jacket, coat, parka, trench, blazer, vest, rain jacket, ...; footwear = sneakers, boots, sandals, loafers, dress shoes, ...; accessories = hat, cap, beanie, scarf, belt, ... (upstream issue #130) | all | presets, grouping, AI |
| `warmth` | 1 very light, 2 light, 3 medium, 4 warm, 5 very warm | tops, bottoms, one-piece, layers, footwear | weather matching |
| `formality` | 1 lounge, 2 casual, 3 smart casual, 4 dressy | all | occasion matching |
| `materials` | a set: cotton, linen, wool, merino, cashmere, silk, denim, leather, suede, polyester, nylon, fleece, down, knit, synthetic, other | all | care, warmth hints, AI |
| `pattern` | solid, stripes, check, print, graphic, floral, other | tops, bottoms, one-piece, layers | generator (at most one loud pattern) |
| `fit` | slim, regular, relaxed, oversized | tops, bottoms, one-piece, layers | AI, filters |
| `sleeve` | sleeveless, short, three-quarter, long | tops, one-piece | weather matching |
| `length` | short, knee, midi, full | bottoms, one-piece | weather matching |
| `water_resistant` | boolean | layers, footwear, accessories | rain |

No `season` property: seasons follow from warmth, and a "summer" set of garments is a capsule
(section 2). That is one field fewer to fill.

**Keeping it light.** The rules that decide which fields a garment shows live in one table in code
(`GARMENT_PROPERTIES`: property, value set, the roles it applies to, the default per type).

- **Pick a type and the rest fills in.** Choosing "t-shirt" presets warmth 2, sleeve short, formality
  casual and pattern solid, shown as pre-selected chips you can change. A type's presets are
  suggestions and never overwrite a value you set.
- **The form asks only what applies.** Sleeve appears for tops, `water_resistant` for layers and
  footwear. Everything past photo, category, type and colour sits in a collapsed "Details" section
  of tap chips, never selects or free text.
- **Machines fill what they can**: link import (section 0) maps JSON-LD `material` and
  descriptions like "heavyweight", "linen" or "240 gsm", and the optional AI suggests from the
  name and type. Suggestions arrive pre-selected for review, never saved blind.
- **Bulk edit:** select mode on the grid (the capsule picker's) sets one property on every selected
  garment in one post.
- **A tagging mode:** `/wardrobe/tag` swipes through garments missing warmth or formality, one card
  at a time with big buttons. Filling in forty garments is a few minutes, not forty form visits.
- **Nothing is required.** A garment with no properties still works everywhere, and the generator
  treats unknown warmth as the type's preset.

## 7. Weather

- **Provider: Open-Meteo** (free, no API key or account, 16-day hourly forecast with apparent
  temperature, precipitation probability, wind and UV, plus a geocoding API and climate data for
  dates further out). The server fetches from its fixed host, which is an allow-list, not the
  user-URL path of section 0. The PWA itself still makes no external requests.
- **Location:**
  - A **home location** per user, set in the profile by searching a city (Open-Meteo geocoding).
  - **"Use my location"** in the installed app (Geolocation, which needs the https name), stored
    per user rounded to about 1 km and used while fresh.
  - A trip's destination, geocoded, gives that trip its forecast.
  - Coordinates go from the server to Open-Meteo rounded, and no other identifier is sent.
- **Cache:** one fetch per rounded location per hour, in memory, and the last good answer is kept
  for offline pages, shown with its time.
- **Where it shows:**
  - Today's summary on the wardrobe and calendar headers ("9 to 17°C, rain after 3 pm").
  - The next 16 days on the calendar: an icon plus high and low per day.
  - A trip's forecast for its dates. Past 16 days it shows climate normals labelled "typical".
- **How it drives suggestions:** each occasion of the day (section 8) has a time window. Its
  apparent-temperature range sets a target warmth for the outfit (the warmths of its layers
  combined). A large swing between morning and evening asks for a layer. Rain asks for
  water-resistant outerwear or footwear, and the card says so. The optional AI gets the same summary.
- **Personal temperature offset** (Acloset): per user, in degrees, added to the apparent
  temperature before matching. It is set in the profile and nudged by the gallery's "too warm" and
  "too cold" (half a degree each, capped at plus or minus 5).
- **Config:** `WEATHER_ENABLED` (default true). Off means no location is ever sent anywhere and no
  weather is shown.

## 8. Several outfits a day (occasions)

A vacation day is often three outfits: day, dinner, a night out. Office day, then change for dinner,
is common at home too.

- **The calendar already allows it**: its unique key is (owner, day, outfit), not (owner, day). What
  is missing is saying which part of the day each outfit is for.
- **`outfit_calendar.occasion`**: all day (the default), work, daytime, workout, evening, night out.
  Fixed, so each can carry defaults: a time window for the weather (work 8 am to 6 pm, evening 6 to
  11 pm) and a formality hint (work at least smart casual, workout lounge). A day's entries show in
  occasion order.
- **UI:** a calendar day stacks its outfits as chips labelled by occasion, with "+ Another outfit"
  and an occasion picker. The gallery opens with `for=day:YYYY-MM-DD&occasion=evening`, so its
  suggestions use evening temperatures and the evening formality.
- **Wears count days, not outfits.** Jeans worn in the day outfit and again at dinner are one wear
  for washing. The `garment_wear` rows stay one per entry and garment (so unmarking an entry
  removes exactly its rows), and the counts and wash rules count **distinct days**. Because the
  counts are derived, this is a query rule, not extra data to keep in step.
- **Trips:** a trip outfit gets an optional day of the trip and an occasion ("Day 2, dinner"). The
  list stays standalone (owner decision), but the packing list can then see that the jeans for Day
  2's daytime and dinner are one wear, and that a 5-day trip with 2 outfits a day needs a different
  count of tees than 5 outfits. Unassigned outfits still count one wear each.

## 9. Today (the home screen)

`GET /` becomes Today instead of redirecting to the wardrobe (Cladwell's daily outfit).

- The weather for the day at the top (section 7).
- A row per occasion planned for today, or one "all day" row. Each shows the planned outfit if there
  is one, otherwise up to 3 generated suggestions (section 3's generator, with that occasion's
  window and formality), with Refresh and "Wear this".
- "Wear this" schedules and marks worn in one tap (section 1's path).
- **Push**, opt-in per device in the profile (this is issue #5's answer):
  - A morning "today's outfit" at a chosen time: the planned outfit or the first suggestion, and
    the weather line.
  - An evening "What did you wear?" when nothing is marked worn today. It opens Today with the
    day's entries ready to mark.
  - Sent by a scheduler in `server.ts` beside the nightly timers (`APP_TIMEZONE`), through the
    existing sender.

## 10. Insights

`/insights`: queries over `garment_wear`, `garment` and prices. Nothing stored.

- % of the closet worn in the last 30, 90 and 365 days.
- **Unworn in N days**, each with "Style this item" (section 3's `?with=`).
- Most and least worn. Cost per wear (price ÷ wear days), with the best and worst values.
- The pairs worn together most often.
- A colour palette strip, and category and brand breakdowns.
- It is computed on request; at household size each query is a few milliseconds. A yearly recap
  is a later addition.

## 11. Wishlist

Things you are thinking of buying, added the same way as garments (a link: section 0) and judged
against what you own.

- **`garment.archived boolean` becomes `garment.status`**: `wishlist`, `closet`, `archived`. That
  is three states with defined transitions: bought (wishlist to closet), archive (closet to
  archived), restore (archived to closet), drop (delete a wishlist item). One `setGarmentStatus` is
  the only writer, and a pure `garmentStatusTransition` (unit-tested, like the cutout state
  machine) decides the legal moves.
- "In the closet" becomes `status = 'closet'`: one predicate (`inCloset`) used by every closet read
  (the grid, the builder, the generator, capsules, insights). An integration spec proves that a
  wishlist garment appears in none of them.
- The migration converts `archived` (true to archived, false to closet) and rebuilds the grid's
  `(owner_id, archived, id desc)` index on status.
- **"Goes with my closet"**: a wishlist item's page runs the generator with `?with=` over the
  closet plus that item. It shows how many outfits it would make and the best few. "No layer goes
  with this" is an answer too.
- "Bought it" moves it into the closet, keeping its photo, properties and price, and sets
  `acquired_on` to today.

## 12. Weekly auto-plan

- **A week template** per user (`week_template`: weekday, occasion; for example Monday to Friday
  work, Saturday daytime and evening). Set once in the profile.
- **"Plan my week"** on the calendar fills every template slot of the next 7 days that has no entry,
  using the forecast for each slot. It never repeats a garment beyond its wash limit across the week
  (the plan counts its own future wears) and never reuses a whole outfit within the week.
- **Auto entries are marked** (`outfit_calendar.planned_by`: `user` or `auto`). A daily job
  compares each future auto entry's forecast with the one it was planned for. When the target warmth
  or the rain need changed, it re-plans that entry and sends a push ("Thursday turned cold: swapped
  in the wool coat"). Entries you placed or edited are `user` and never touched.
- Generated outfits it picks are saved like gallery picks.

## 13. Outfit selfies

- A calendar entry can carry a mirror photo (`outfit_calendar.photo_id`, nullable FK to `file`,
  set null on delete), through the existing `Photos` pipeline, with no cutout requested.
- Taking one from Today or the calendar marks the entry worn.
- The calendar and the outfit page show the looks as you actually wore them. An outfit page gets a
  "Worn" strip of its selfies.
- **This breaks the rule that calendar entries own no files** (Gotchas, "The DB cascade deletes rows,
  never bytes"). Deleting an entry, or a user, must unlink its photo through `Photos` after commit,
  and `reconcileStorage` must count `outfit_calendar.photo_id` as a reference, or the nightly run
  would delete every selfie as an orphan. Both are specified and tested with the feature, and the
  gotcha is updated in CLAUDE.md.

## Delivery

Each feature is its own GitHub issue (six) and ships alone. The work for each: its schema and migration
(the drift test), integration specs first (behavior, authorization matrix rows for the new routes,
the one-writer rules), unit specs for the pure parts (roles, wash rules, the generator), a
phone-width browser check as the installed PWA, and the CLAUDE.md sections (Architecture, Routes)
updated in the same commit.

## Candidate features (research, 2026-09-26)

Surveyed: Cladwell, Whering, Indyx, Alta, Acloset, Stylebook, Pureple, Save Your Wardrobe, Fits,
Clueless, Smart Closet, OpenWardrobe, and **Wardrowbe** (github.com/theEvgene/wardrowbe, MIT,
self-hosted, household support, Open-Meteo, suggestions from a model). Wardrowbe is the closest
thing to this app; read how it does something before designing that thing here. Its MIT code may
be adapted with its notice kept (this repo is AGPL).

**Folded into the sections above** (high value, low effort, fits the model):

- **Availability status** (Stylebook): lent out, at the tailor or repair. A manual state beside the
  derived wash state, never mixed with it. The generator and packing list skip unavailable garments.
  One nullable `garment.away` column (`lent`, `repair`) plus an optional note: see section 1.
- **Style this item** (Acloset "featured piece", the "unworn items" to "style it" flow): the
  gallery takes `?with=<garmentId>` and only generates outfits containing it: see section 3.
- **Say why not** (Acloset, Wardrowbe ratings): a skipped card can say too warm, too cold, clashes
  or not today. Too warm and too cold adjust a **personal temperature offset** (section 7). Clashes
  records the pair to avoid (section 3).
- **Bulk edit** (Whering): select mode on the grid (the capsule picker's) sets one property on many
  garments: see section 6.

**Promoted to sections 9-13** (owner, 2026-09-26): Today, Insights, the wishlist, the weekly
auto-plan and outfit selfies. The summaries below were the proposals; the sections hold the design.

- **9. Today.** The home screen is today (Cladwell): the weather, then up to 3 suggestions per
  occasion planned today (or one "all day" row), each with refresh and "Wear this". A planned
  outfit shows first. This gives Web Push its use (issue #5): a morning "today's outfit" push, and
  an evening "log what you wore?" reminder when nothing is marked (Fits, Wardrowbe). Both are
  opt-in per device.
- **10. Insights.** One stats page: % of the closet worn in 30/90/365 days, "unworn in N days" (each
  links to style this item), most and least worn, cost per wear (price from section 0), pairs
  most worn together, and a colour palette strip and brand breakdown (Whering, Cladwell,
  Stylebook). All of it is queries over `garment_wear`. A yearly recap (Whering "Unpacked") comes
  later.

**Later** (worth doing, not yet): duplicate detection with image embeddings (Wardrowbe); generator rules ("never X with
Y"); an inspiration library with "recreate this look"; care label and repair log (Save Your
Wardrobe); measurements and per-brand sizes (Stylebook); order email import.

**Skipped:** avatar try-on (a gimmick at household scale), and social feeds, polls and resale
marketplaces (they need a user base).

## Open questions

1. Properties (section 6) go first, so link import and the generator have fields to fill and read.
   Link import follows immediately because it is the fastest way to stock the wardrobe.
2. The role-default wash thresholds (top 1, bottom 3, layer 10) are a guess. Adjust them to taste.
3. Should a trip's outfits also go on the calendar? Currently no, per the decision. A "Schedule
   these" button could be added later without changing the model.
4. The type lists and their presets (section 6) are a first cut, to be tuned on real garments.
