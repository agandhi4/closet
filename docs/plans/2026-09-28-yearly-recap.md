# Yearly recap (2026-09-28)

Issue #26. A year in review built from insights: the most worn pieces, what was added, and the cost
per wear winners. Seen in Whering's "Unpacked". **Shareable means an image export** (coordinator's
design call on the issue): the owner saves the recap as a PNG and sends it wherever they like. There
is no public link and no unauthenticated route. **The recap is owner-only, like Insights**: it is
built from the wear log, and wear data never reaches a grantee. (A first version let grantees see
the owner's recap under their grant; the coordinator reversed that on 2026-09-28.)

## Data

- **Nothing stored, nothing new in the schema.** The recap is insights' two statements
  (`src/web/insights/queries.ts`) read over a different window, then computed in
  `src/wardrobe/recap.ts` from the same rows with insights' own rules: cost per wear
  (`costFigures`) and colour shares (`colourShares`). It adds no query of its own.
- **The window.** Insights reads the closet over the last 365 days up to today. `InsightsWindow`
  generalises this to `{ from, to, scope }`. Insights passes `recentWindow(today)`, which is the
  same as before. The recap passes its year:
  - `from` is January 1 and `to` is the year's last day that has happened.
  - "Recent" wear days are the year's wear days.
  - A garment's lifetime wear days and its "days since" stop at `to`. So a past year's cost per wear
    is what it was on December 31.
  - `scope` is `owned`: the closet and the archive. A coat that was worn out and archived in November
    was still that year's most worn.
- **The year boundary is the household's.** `garment_wear.day` is already a date in `APP_TIMEZONE`,
  and "today" is `todayIn(APP_TIMEZONE)`. On New Year's Eve in New York, while UTC is already in
  January, the current year is still the old one, and its period ends on December 31
  (`today.spec.ts` has a row for this). No instant is ever cut at a UTC midnight.
- **The figures:**
  - wears: garment-days in the year, the insights unit;
  - pieces worn;
  - the 5 most worn by the year's wear days;
  - new additions: `acquired_on` in the year, the newest first, the count whole. A garment without
    an acquired date is not an addition, because nothing records when it came;
  - best value: insights' "best" among the pieces worn that year;
  - the colours worn: each colour's share of the year's wears;
  - the pair worn together most: insights' pairs over the year.

## UX

- **Where it lives.** `GET /wardrobe/recap[?year=YYYY]`, under Wardrobe in the dock.
  It is reached from the Wardrobe's ⋯ menu ("Year in review") and from Insights.
  - The menu offers it only on the user's own wardrobe, never in a grantee's view of another.
  - `?year=` is navigation state. Anything that is not a four-digit year up to this one is the
    current year, never a 400.
- **Access.** The signed-in user's own, exactly like Insights: the route reads `sessionUserId` and
  ignores `?ownerId=`. A grantee who passes `?ownerId=<owner>` sees their own recap, never the
  owner's. So "Save image" is owner-only by construction: there is only ever one's own recap to
  export.
- **Phone first**, in one column of Atelier cards:
  1. the year's switcher (‹ 2025 · 2026 so far ›);
  2. the summary: wears, pieces worn, new pieces, and "Save image";
  3. Most worn, New this year, Best value per wear, Colours worn, and Worn together most.

  Garments link to their pages.
- **Current year versus past years:**
  - The current year reads "2026 so far", through today ("Jan 1 – Sep 27"), and fills in as the year
    goes on.
  - A past year is the whole year, fixed: its figures stop at December 31, so later wears never
    change it.
  - The ‹ link shows only when wears exist before the year. The › link shows only for a past year.
  - `/wardrobe/recap` with no year is the current year. In early January that year is empty, and its
    empty state links to last year.
- **Too little data.** A year needs at least `RECAP_MIN_WEARS` (10) wears to be recapped. Below
  that, the page shows an empty state:
  - it says how many wears the year has;
  - it offers the calendar;
  - it keeps the ‹ link when an earlier year has wears.

  There is no export for such a year. A year with additions but no wears is still empty: the recap
  is about what was worn.
- **The image.** A 1080 × 1350 PNG (4:5, the shape a phone's photo apps and chats show whole).
  - It shows the year's title, the three numbers, the top three most worn on the plinth, best value
    and the best pair, and the colour strip.
  - It is drawn in the light Atelier theme, whatever the phone's scheme. It is drawn at the same
    size whatever the screen's width.

## Image export: on the device, with Canvas 2D

`public/js/recap-export.js` (about 200 lines, loaded only by the recap page) draws the card on a
`<canvas>` from a JSON data island the page renders. `canvas.toBlob` makes the PNG. Then:

- where the browser can share files (`navigator.canShare({ files })`: iOS Safari 15 and later,
  Android), "Save image" opens the share sheet, whose "Save Image" puts the PNG in Photos;
- elsewhere, the PNG downloads (`<a download>` on a blob URL).

The PNG is rendered as soon as the page opens, so the tap shares a file that is already made.
WebKit's `navigator.share` needs the tap's user activation, which a slow render could outlive. If
the render is still running, the tap waits for it, and a refused share falls back to the download.

**Why not sharp on the server.** sharp is already a dependency, but its text goes through Pango and
fontconfig.

- The runtime image (`node:22-slim`) has no system fonts.
- Pango does not take the woff2 files the app ships: a render with Fraunces' woff2 as `fontfile`
  measured exactly the same as one without it, so it fell back.

Server-side export would mean adding fonts to the image (a Dockerfile change and TTF copies of
Inter and Fraunces) and laying the card out a second time in SVG. The browser already has both
fonts loaded (`document.fonts`), the theme's tokens, the swatches' colours and the garment
thumbnails. The thumbnails are same-origin, so the canvas is never tainted. The render works
offline too, in the installed app, from cached thumbnails.

**Why not an HTML-to-image library.** They draw the DOM through SVG `foreignObject`, which Safari
renders unreliably: images missing on the first draw, and fonts that must be inlined. They are also
a new client dependency. The card is small and fixed, so drawing it directly is simpler and
predictable.

## Seed

Theo's 13 weeks of history (anchor 2026-09-26) all fall in 2026, and 16 of his garments were
acquired in 2026. So `/wardrobe/recap` shows him a full "2026 so far": 517 wears of 54 pieces, 16
additions, best value, colours and pairs (`insights-seed.spec.ts`). 2025 has no wears, so its
recap is the empty state and 2026 has no ‹ link. Dana, with no wears, and
Riley, with nothing, show the empty state. **The seed does not change**: a year of simulated history
would rewrite every figure `insights-seed.spec.ts` pins, for no better demonstration of this page.

## Out of scope

- Any public or unauthenticated recap link, Open Graph preview or server-rendered image.
- Stored or precomputed recaps, a December push ("your year is ready"), or an MCP tool.
- Comparisons between years ("20% more wears than 2025") and "most worn outfit". Outfits are
  owner-only and not share-aware.
- Seasonal or monthly recaps. The window type would allow them, but nothing asks for them yet.
- The days dressed (distinct days with any wear). The rows are per garment, so this would need a
  third statement. Wears and pieces worn tell the story.
