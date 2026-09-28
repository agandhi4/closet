# The wardrobe grid

Part of the Wardrobe (`CLAUDE.md` in this directory): `GET /wardrobe` (the Closet tab, or `#wardrobe-main` to a fragment request) and `GET /wardrobe/tiles` (the next page).

## What each statement reads, and why

Production reaches Postgres over a link that costs a round trip per statement (about 114 ms, homelab #40), so the grid's cost is its statement count (#156, #159). `wardrobe-grid.spec.ts` asserts every count below; a new read joins a statement that already runs, never a new one.

- **The session** (`select ... from "user"`): the root hook's, every page's (#174).
- **The page** (`gridPage`): one row per tile and one more that says there are more; only what a tile shows (id, name, category, status, photo name and version, quantity, condition). The owner's grid adds `care`: `away`, and the dirty copies, a correlated count of the garment's wears since its wash per tile with a wash limit (`dirtyCopiesSql`, over `garment_wear_garment_id_day_index`). The plan puts it at about 0.03 ms a tile, so it stays correlated: a set-based join would cost more than it saves. The capsule picker (`?pick=`) adds `member`, `inCapsule` per tile, which pre-checks the tile. It replaced a separate `memberIds` read, the ids of every member, in #159.
- **The context** (`gridContext`, `grid-context.ts`): one row of scalar subqueries (`selectScalars`, `src/db/select-scalars.ts`), since they share no rows. Lists arrive as JSON, so the harness's Rows column counts it as one. Each part exists for one piece of the page, and `gridContextParts` (`routes.tsx`) asks only for what the answer renders:
  - `count`: the scope row's "N results", `count(*)` over `gridWhere`, the page's own filters;
  - `options`: the filter modal's choices (`filterOptionsSql`), only values the wardrobe holds, archived included, so no choice finds nothing;
  - `capsules`: the scope row's capsule menu, and the lookup that makes another wardrobe's `?capsule=` or `?pick=` a 404 and names the picker's bar;
  - `toTag`: "N garments need details" (`toTagCountSql`), for an editor only;
  - `toWash`: the laundry prompt (`needingWash`, `src/web/wears/queries.ts`), for the owner only (it reads wears);
  - `drafts`: "N photos waiting · Continue" (#200, `draftsWaitingSql`), for an editor only;
  - `sharedWardrobes`: the app bar's switcher, on a full page only (a fragment swaps `#wardrobe-main` and the ⋯ menu, never the bar).

  Select mode and the picker render none of it. They read only `capsules`, and only when a `?capsule=` or `?pick=` names one; plain select mode sends no context statement at all.
- **So**: a page or fragment is 3 statements, select mode 2, the picker 3, a next page 2. Before #159 a page was 9 (8 reads in parallel, each its own round trip and pool connection) and the picker 10.

Tagging mode is 2 statements. `nextToTag` reads the card with its count left as a window (`count(*) over ()`), the garments below the cursor sorted first. A tap's answer is 3 (`taggedGarment`, the chips and the count), or 4 when it writes (`select-and-tag.md`).

## Paging, filters and search

- **The grid is keyset-paged**: `GRID_PAGE_SIZE` (48) tiles newest first, `id < before` for the next page. The last tile is followed by a sentinel (`hx-trigger="revealed"`, `hx-swap="outerHTML"`) that fetches `/wardrobe/tiles` with the same filters and replaces itself with the next page and its own sentinel. Filtering and searching swap `#wardrobe-main` and so start at page one. Indexes: `(owner_id, status, id desc)` and `(owner_id, category, id desc)`, also the owner foreign key's; at household size the planner often prefers a backward primary-key scan with a filter, which is as fast (under 0.3 ms at 1,500). A new sort order needs its own cursor and index.
- **Care filters and badges** (#7): `?needsWash=true` (a copy needs a wash; the owner's own wardrobe only, `gridSearch` drops it on a share, and the modal does not offer it there) and `?attention=true` (condition not good), checkboxes in the modal's Care group. Tiles carry `quantity` ("×3") and `condition` for everyone, and `care` (dirty copies, away) only when `gridPage(..., { ownerView })` is the owner's: the correlated wear count is not even computed for a share. The owner's grid shows a slim "N garments need a wash · Laundry" banner (`toWash`); Laundry is also a Wardrobe tab, not on a shared wardrobe.
- **Capsule filter** (`?capsule=<id>`, #8): members only (`inCapsule`, `src/web/capsules/queries.ts`); chosen from the scope row's capsule menu (`CapsuleScope`, which also links the Capsules tab), carried by every link through `GridSearch`; a `?capsule=` URL is honoured wherever it comes from. Not an id is a 400, not one of the addressed wardrobe's capsules a 404.
- **Property filters**: `type` (only with its category: `gridSearch` drops a type the chosen category lacks, so dropping the category pill drops it too), `warmth`, `formality` and `material` (`materials @> array[...]`, as the colour's `colors @> array[...]`); the scales and the material are 400 outside their sets, like a colour. No GIN index on either array: the owner's grid index narrows to one wardrobe (hundreds of rows) and the containment is a filter over those, as the other property filters are. The filter modal's values: `options` above (materials through an `unnest` subquery). `GridSearch`'s keys are the query parameters' names, so `searchParams(search)` is the whole list: links, the sentinel, the search form's hidden inputs and the bulk form's action all spread it, and a new filter needs no second list.
- **Search** is `ILIKE` on name, notes and brand with the keyword's `%`, `_` and `\` escaped (`containsPattern`). The colour filter (`colors @> array[<colour>]`) must be a built-in colour (else 400).
