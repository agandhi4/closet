# Desktop: a side-by-side Styling composer (#468) and a Calendar week grid (#467)

Status: approved by the owner 2026-11-12, with every recommended option. Both are the "Later" items of the desktop epic #307.

## 1. What exists

- **The epic's rules (#307)**: at `lg` (1024 px) the dock is a left rail from the same markup (`main.css`,
  `src/web/layout/AGENTS.md`); responsiveness is CSS only, one markup, no viewport-dependent HTML, because
  `/styling` and `/calendar` are stale-while-revalidate tab roots (`OPENS_STALE`, `page-cache.ts`).
  `test/integration/layout-rail.spec.ts` already asserts every tab root is the same bytes for a phone and a
  desktop request. Widths come from `PageMain` (`narrow` 40rem, `wide` 80rem); column steps from `columns.ts`.
- **Styling** (`styling-page.tsx`): `PageMain width="wide"`, then `Header`, the `#styling-form` `PostForm`
  holding `#styling-rows` (`PicksToggle`, one `StylingRowView` per role), `AddRow`; outside `<main>` the fixed
  `ActionBar` (`left-rail bottom-dock`, Shuffle and Save, `max-w-page-narrow`) and the `SaveSheet` dialog
  (`modal-bottom sm:modal-middle`, its fields joining the form by `form=`). Rows are `SnapStrip`s, `roomy`
  (w-28, w-40 from lg) or `small`; #311 gave them step buttons on a fine pointer and ArrowLeft/Right. There is
  **no outfit preview and no weather fit** on Styling today: the outfit is only the rows' centred items.
  Shuffle, "Add row" and the picks switch answer `#styling-rows`, the capsule menu out of band (`ScopeMenu`).
- **Calendar week** (`calendar-page.tsx`): `PageMain` narrow; tabs, `WeatherSlot`, "Plan my week", ‹ week ›,
  `WeekStrip` (seven day links), then one `DaySection` per day (`data-day`: `DayHeading`, `WeatherDaySlot`,
  `OccasionRow` per entry in occasion order, `OpenSlotRow` per template occasion it lacks from today on,
  `DayLooks`, "+ Plan" when no open slot), then the seven `PlanSheet` dialogs. The month grid
  (`month-page.tsx`) already grows at lg (`lg:min-h-32`, the collage's `cell` size, about 170 px).

## 2. Styling at lg (#468)

**Frame.** Inside the same `PageMain`, the header spans the width; below it a `lg:grid lg:grid-cols-[1fr_20rem]
lg:gap-6`: the form, its rows and "Add row" on the left; on the right a new `StylingAside`
(`contents lg:flex lg:flex-col lg:sticky lg:top-20 lg:self-start`) holding, in order, the preview, the fit line
and the `ActionBar`. The ActionBar moves into the aside in the DOM and keeps `fixed left-rail bottom-dock` below
lg (a fixed box ignores a non-transformed parent, and `contents` gives the aside no box on a phone), then
`lg:static lg:border-0` with its buttons stacked full width. `pb-40` becomes `pb-40 lg:pb-8`.

**Choosing stays the snap strip** (recommended; owner decision 1). One markup, one choosing mechanism, the
lock contract (`overflow-x: hidden`, `inert` neighbours, `snap-strip:choose` cancelled) and #311's buttons and
keys all hold. A per-role grid of choices would need a second mechanism (radios), a second lock rule and
paging that is not the strip's sentinel, and eight wrapped grids make a page taller than the strips do.
The left column is about 600 px at 1024 and 900 px at 1440: four to six `roomy` tiles per row.

**The preview** (`StylingPreview`, `aria-hidden`: the listboxes already say what is chosen): one slot per row in
row order (top to toe, accessory, bag and `none` small in a line at the foot), each the chosen garment's
image or nothing for "No garment". The server renders it from the rows' states (first paint is right for
`?with=`, `?outfit=`, a refused Save), and Shuffle, "Add row" and the picks switch answer it out of band, as
`ScopeMenu` is (`hx-swap-oob`, the convention's swap-target map). Between swaps the choice moves without a
request, so `public/js/styling.js` mirrors it: `snap-strip.js` gains a non-cancelable `snap-strip:chosen`
after it moves `data-selected` (a two-line hook, documented in `src/web/strip/AGENTS.md`), and styling.js
copies the chosen item's `img` into its row's slot. No new module; it works offline like choosing does.
A stack, not `OutfitCollage`: the collage lays out by the roles present, which only the server knows.

**The fit line** (slice 468b; owner decision 3): `GET /styling/fit` with the rows (`hx-include="#styling-form"`,
`hx-trigger="load, snap-strip:chosen from:#styling-rows delay:500ms"`, plus after each oob preview) answers
`assessOutfit(needs, garments)` (`src/weather/match.ts`) for `aimIdeas`' planning day and occasion, in the
gallery's words (`gallery.problem.*`, "Fits the weather"). Loaded after paint like `WeatherSlot`, so `/styling`
stays byte-stable. The posted ids are read through `rowGarmentsSql` (what the rows may carry) in one
statement; the forecast is the weather service's cache (no Open-Meteo call beyond the page's). No line without
`WEATHER_ENABLED`, without a forecast for the day, or over a shared wardrobe (`browseIdea` has no weather).
Offline it says the weather check needs a connection (`data-needs-network`); it writes nothing.

**Save** keeps the sheet, centred at lg as today (recommended; owner decision 2): its fields post by `form=`, and
an inline panel would need them rendered once in two places. **Keyboard**: DOM order is header, rows (label,
lock, strip), Add row, then the aside's Shuffle and Save; arrows step a focused strip. Locks unchanged.

## 3. Calendar week grid at lg (#467)

**Same route, same markup** (no `?view=`): a view parameter is another cache key, not the tab root, so the
desktop week would fail offline where the phone's opens from cache; the server cannot pick by width anyway.

**Rows**: `buildCalendarView` gains `weekOccasions`, the week template's occasions plus any an entry uses, in
`OCCASIONS` order (pure, computed from the same data, so byte-stable; unit-tested in `unit-new-york`).
**Grid**: the day sections' wrapper is `lg:grid lg:grid-cols-7 lg:gap-x-2` with a row template for header,
the k occasion rows, looks and the day's button (a lookup table of whole class strings for k = 1..6, like
`SIZES`); each `DaySection` is `lg:grid lg:grid-rows-subgrid lg:row-span-full`, so occasion rows line up across
days. A day's entries and open slot of one occasion sit in a cell wrapper (`contents lg:flex lg:flex-col
lg:row-start-N`, N from a table by occasion index); `contents` keeps the phone's box tree as it is. A week
occasion a day has nothing for gets an empty cell, `hidden lg:flex`, which from today on holds a "+" opener
(`data-plan={planSheetChoice(day, occasion)}`, `OPEN_PLAN_SHEET`; the sheet unchanged). `WeekStrip` is
`lg:hidden` (the column heads are the days); `DayHeading` and `WeatherDaySlot` head each column.
**A cell** is the same `OccasionRow`, restyled at lg into a card: collage on top at the column's width (its
`cell` size, as the month), name under it (`line-clamp-2`), Change, ×, selfie and worn pill wrapping below.
The worn toggle still answers the whole row, so the htmx swap keeps the look. Each column is about 130 px at
1024 and 175 px at 1440 (owner decision 4). `PageMain` gains a width `agenda` (`narrow`, `wide` from lg),
named once in `page-main.tsx`. **Navigation**: the ‹ › links (`?week=`) as now; `dayUrl` anchors still
resolve, and a `:target` column gets a ring at lg. Statements stay 2 (`calendar.spec.ts`). No drag-and-drop.

## 4. Shared rules

- **Phone unchanged**: every class added to existing elements is `lg:`-prefixed or a phone no-op (`contents`);
  new desktop-only elements are `hidden lg:*` (the preview is in the DOM on a phone, hidden). Proven by the
  390 px Playwright scenarios staying green as they are, `layout-rail.spec.ts`' same-bytes check, and 390 px
  screenshots before and after attached to each PR (the #307 rule: 390 and 1440 per PR).
- Strings through `t()` (new: `styling.PREVIEW`, `styling.FIT_OFFLINE`; the fit reuses `gallery.problem.*`);
  daisyUI tokens only; `text-muted` for secondary text. JS: two small additions to existing modules.

## 5. Tests

- **Integration** (`test/integration/styling.spec.ts`, `calendar.spec.ts`/`calendar-page.ts`): one aside holding
  Shuffle and Save; preview slots one per row, in row order, naming the chosen garment on first paint for bare,
  `?with=` and `?outfit=`; Shuffle, Add row and the switch answer the preview out of band. `/styling/fit`: its
  words for a too-cold pick, nothing over a share or without a forecast, a 400 for bad rows, its statement count
  in `styling-statements.spec.ts`, no Open-Meteo call (`weather.spec.ts`' pattern). Calendar: `weekOccasions`
  order; each entry's cell carries the row class of its occasion on every day; empty cells only from today on
  carry `data-plan`; statements still 2.
- **Playwright: no new scenario.** Grid placement, subgrid and sticky are visual (screenshots). The one
  browser-only behaviour, styling.js mirroring a choice, runs at every width, so `test/styling.spec.ts`'
  existing 390 px scenario absorbs one assertion: after its swipe, the row's preview slot holds the new garment.
- **Screenshots**: `test/screenshots.spec.ts` gains a 1440x900 block (Styling fresh and after Shuffle with a
  lock; the demo persona's planned Calendar week); `make screenshots` writes both widths.

## 6. Slices

- **468a**: the aside, the ActionBar move, the preview (server render, oob answers, `snap-strip:chosen`, the
  styling.js mirror), the 1440 screenshot block. Styling and Strip AGENTS, a decisions.md entry.
- **468b**: `GET /styling/fit` and the fit line.
- **467a**: `weekOccasions`, the grid, the cell restyle, `PageMain` `agenda`, the empty-cell openers; Calendar
  and Layout AGENTS (widths list), a decisions.md entry. Independent of 468; either may go first.

## Owner decisions

1. Styling on desktop keeps the snap strips with step buttons and arrow keys (recommended), or a grid of
   every choice per role?
2. Save stays the centred sheet (recommended), or an inline panel in the aside (fields moved out of the dialog)?
3. Is the weather fit line wanted (468b), and on desktop only, or on the phone too (a phone change, so later)?
4. The grid from `lg` (130 px columns at 1024, recommended to match the month) or from `xl` (1280, about 160 px),
   with the agenda below?
5. Grid rows: the template's occasions plus any used (recommended), all six always, or only those used?
6. Empty-cell "+" openers on desktop mean more than one way into a day's sheet there (the phone keeps one): fine?
7. The preview as a top-to-toe stack mirrored in the browser (recommended, offline), or the server's
   `OutfitCollage` re-rendered after each choice (one request per choice, stale offline)?
