# Page audit

Commit `3c9aa94`, 2026-09-28T06:11:10.426Z. 20 runs per step after 3 warm-up, 16 × AMD Ryzen 7 8845HS w/ Radeon 780M Graphics, Node v22.20.0, load average 7.9 at the start and 25.4 at the end. Server ms is the request in process (`inject`), db ms Server-Timing’s `db`; statements and rows are the median run’s, with the range when runs differed; KB decompressed, and as sent with `br`.

## #158 Today

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Today | `GET /` | 200 | 11.1 | 36.8 | 10.4 | 8 | 245 | 19.9 | 4.9 |
| Refresh an ideas row | `GET /today/ideas` | 200 | 7.2 | 33.8 | 6.3 | 6 | 243 | 6.6 | 1.3 |
| Weather summary | `GET /weather/summary` | 200 | 5.4 | 11.5 | 1.9 | 3 | 3 | 1.8 | 0.4 |
| Wear this | `POST /today/wear` | 303 | 14.1 | 15.6 | 12.8 | 25 | 16 | 0.0 | 0.0 |
| Wore it (from Today) | `POST /calendar/:id/worn` | 303 | 7.4 | 9.3 | 6.2 | 9 | 8 | 0.0 | 0.0 |
| Reminders form (this device) | `POST /push/reminders/form` | 200 | 3.5 | 4.9 | 1.0 | 2 | 2 | 3.2 | 0.8 |
| Save reminders | `POST /push/reminders` | 200 | 3.3 | 4.8 | 1.8 | 2 | 2 | 0.1 | 0.1 |

## #159 Wardrobe grid

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Grid | `GET /wardrobe` | 200 | 9.8 | 22.8 | 12.9 | 8 | 59 | 53.5 | 8.6 |
| Grid fragment (scope row, filters) | `GET /wardrobe` | 200 | 7.7 | 23.4 | 11.0 | 8 | 37 | 32.7 | 4.1 |
| Search | `GET /wardrobe` | 200 | 8.6 | 22.0 | 11.8 | 8 | 16 | 37.2 | 6.8 |
| Filters: category, colour, warmth | `GET /wardrobe` | 200 | 7.4 | 21.1 | 10.6 | 8 | 16 | 40.5 | 7.2 |
| Care filters: needs a wash, attention | `GET /wardrobe` | 200 | 7.3 | 18.3 | 10.6 | 8 | 10 | 36.5 | 6.7 |
| Show archived | `GET /wardrobe` | 200 | 8.5 | 20.1 | 11.8 | 8 | 59 | 54.5 | 8.7 |
| Capsule filter | `GET /wardrobe` | 200 | 7.7 | 25.5 | 9.8 | 8 | 39 | 46.3 | 7.8 |
| Next page (tiles) | `GET /wardrobe/tiles` | 200 | 5.7 | 14.2 | 2.6 | 2 | 33 | 12.8 | 1.5 |
| Select mode | `GET /wardrobe` | 200 | 8.8 | 23.0 | 13.9 | 8 | 59 | 48.8 | 6.6 |
| Capsule picker | `GET /wardrobe` | 200 | 9.7 | 22.0 | 14.1 | 9 | 88 | 42.1 | 5.6 |
| Tagging mode | `GET /wardrobe/tag` | 200 | 5.8 | 13.9 | 2.8 | 3 | 3 | 11.8 | 3.4 |
| Laundry tab | `GET /laundry` | 200 | 6.5 | 13.0 | 4.0 | 3 | 4 | 17.4 | 4.8 |
| Capsules tab | `GET /capsules` | 200 | 5.9 | 17.0 | 6.2 | 6 | 27 | 22.8 | 5.3 |
| A capsule | `GET /capsules/:id` | 200 | 6.7 | 16.5 | 4.9 | 4 | 32 | 21.2 | 4.6 |
| New capsule form | `GET /capsules/new` | 200 | 3.1 | 9.8 | 0.6 | 1 | 1 | 9.6 | 3.1 |
| Edit capsule form | `GET /capsules/:id/edit` | 200 | 3.6 | 12.2 | 0.9 | 2 | 2 | 9.9 | 3.2 |
| Bulk edit (select mode’s Set…) | `POST /wardrobe/bulk` | 303 | 5.0 | 8.5 | 3.8 | 5 | 3 | 0.0 | 0.0 |
| Tag a garment | `POST /wardrobe/:id/tag` | 200 | 6.8 | 8.4 | 4.0 | 4 | 4 | 2.4 | 0.5 |
| Laundry: washed | `POST /laundry` | 303 | 3.9 | 5.7 | 2.4 | 2 | 2 | 0.0 | 0.0 |
| New capsule | `POST /capsules` | 303 | 3.2 | 4.6 | 2.1 | 4 | 2 | 0.0 | 0.0 |
| Edit capsule | `POST /capsules/:id` | 303 | 3.5 | 4.9 | 2.0 | 3 | 3 | 0.0 | 0.0 |
| Capsule members (picker save) | `POST /capsules/:id/garments` | 303 | 5.6 | 10.2 | 4.3 | 8 | 5 | 0.0 | 0.0 |
| Delete capsule | `DELETE /capsules/:id` | 200 | 2.9 | 5.9 | 1.7 | 2 | 2 | 0.0 | 0.0 |

## #160 Garment page

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Garment page | `GET /wardrobe/:id` | 200 | 9.7 | 28.9 | 15.1 | 9 | 13 | 30.4 | 7.6 |
| Wore today | `POST /wardrobe/:id/wear` | 200 | 8.2 | 11.1 | 5.7 | 6 | 5 | 1.0 | 0.4 |
| Washed | `POST /wardrobe/:id/washed` | 200 | 7.8 | 9.0 | 6.3 | 5 | 5 | 0.7 | 0.7 |
| Where it is (away) | `POST /wardrobe/:id/away` | 200 | 5.1 | 6.4 | 3.2 | 3 | 3 | 0.0 | 0.0 |
| Condition | `POST /wardrobe/:id/condition` | 200 | 3.5 | 5.7 | 1.9 | 2 | 2 | 0.0 | 0.0 |
| Capsules row (saved on change) | `POST /wardrobe/:id/capsules` | 200 | 6.9 | 8.3 | 5.1 | 7 | 4 | 0.0 | 0.0 |
| Log a repair | `POST /wardrobe/:id/repairs` | 303 | 6.3 | 8.9 | 4.6 | 8 | 6 | 0.0 | 0.0 |
| Delete a repair | `POST /wardrobe/:id/repairs/:repairId/delete` | 303 | 7.1 | 9.8 | 5.3 | 7 | 5 | 0.0 | 0.0 |
| Archive | `POST /wardrobe/:id/archive` | 200 | 4.6 | 5.5 | 3.5 | 5 | 2 | 0.0 | 0.0 |
| Restore | `POST /wardrobe/:id/restore` | 200 | 4.1 | 11.6 | 3.2 | 5 | 2 | 0.0 | 0.0 |

## #161 Add and edit a garment

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Add form | `GET /wardrobe/new` | 200 | 5.9 | 14.8 | 2.2 | 2 | 2 | 26.7 | 5.9 |
| Edit form | `GET /wardrobe/:id/edit` | 200 | 7.6 | 22.7 | 3.7 | 5 | 5 | 32.9 | 7.1 |
| Clone form | `GET /wardrobe/:id/clone` | 200 | 7.2 | 23.2 | 4.2 | 5 | 31 | 32.4 | 7.1 |
| Properties after a category change | `POST /wardrobe/properties-fragment` | 200 | 2.6 | 9.0 | 0.6 | 1 | 1 | 4.6 | 0.7 |
| Lookalike check | `GET /wardrobe/lookalikes` | 200 | 3.0 | 9.7 | 1.5 | 2 | 28 | 0.1 | 0.1 |
| Link page | `GET /wardrobe/new/from-link` | 200 | 3.0 | 9.5 | 0.6 | 1 | 1 | 9.5 | 3.1 |
| Save a new garment | `POST /wardrobe` | 302 | 3.9 | 5.7 | 2.9 | 4 | 2 | 0.0 | 0.0 |
| Save an edit | `POST /wardrobe/:id` | 302 | 5.3 | 6.1 | 3.4 | 3 | 3 | 0.0 | 0.0 |
| Import a link | `POST /wardrobe/new/from-link` | 200 | 97.9 | 106.6 | 14.6 | 9 | 76 | 31.2 | 6.7 (6.7–6.7) |
| Choose a link’s photo | `POST /wardrobe/new/from-link/photo` | 200 | 93.1 | 112.3 | 8.2 | 6 | 2 | 0.4 | 0.4 |
| Add from a photo (upload) | `POST /wardrobe/new/photo` | 303 | 81.6 | 98.3 | 4.5 | 6 | 3 | 0.0 | 0.0 |
| Add form with a pending photo | `GET /wardrobe/new` | 200 | 6.8 | 9.9 | 2.5 | 3 | 3 | 27.0 | 6.0 (6.0–6.0) |
| Clone | `POST /wardrobe/:id/clone` | 302 | 35.7 | 41.3 | 4.5 | 7 | 5 | 0.0 | 0.0 |
| Add a copy | `POST /wardrobe/:id/copies` | 303 | 3.3 | 3.8 | 2.5 | 7 | 4 | 0.0 | 0.0 |
| Delete a garment | `DELETE /wardrobe/:id` | 200 | 4.0 | 5.1 | 2.8 | 6 | 3 | 0.0 | 0.0 |

## #162 Photos and cutouts

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Original | `GET /file/:fileName` | 200 | 2.6 | 6.8 | 0.9 | 1 | 1 | 10.7 | 10.7 |
| Cutout | `GET /file/nobg/:fileName` | 200 | 1.8 | 9.0 | 0.8 | 1 | 1 | 14.3 | 14.3 |
| Thumb | `GET /file/thumb/:fileName` | 200 | 1.7 | 6.8 | 0.7 | 1 | 1 | 6.0 | 6.0 |
| Thumb, regenerated | `GET /file/thumb/:fileName` | 200 | 38.1 | 93.5 | 0.8 | 1 | 1 | 6.0 | 6.0 |
| Cutout poll (pending page) | `GET /wardrobe/:id/cutout` | 200 | 4.9 | 9.1 | 1.9 | 2 | 2 | 1.1 | 0.6 |
| Upload a photo | `POST /wardrobe/:id/photo` | 303 | 60.6 | 71.1 | 5.4 | 9 | 6 | 0.0 | 0.0 |
| Save a mask edit | `POST /wardrobe/:id/nobg` | 200 | 51.7 | 59.8 | 3.6 | 6 | 3 | 0.0 (0.0–0.0) | 0.0 (0.0–0.0) |
| Rotate the photo | `POST /wardrobe/:id/photo/rotate` | 303 | 72.3 | 109.3 | 6.8 | 10 | 7 | 0.0 | 0.0 |
| Try the cutout again | `POST /wardrobe/:id/cutout/retry` | 303 | 6.7 | 11.5 | 4.7 | 5 | 3 | 0.0 | 0.0 |

## #163 Styling

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Styling | `GET /styling` | 200 | 9.3 | 26.4 | 3.9 | 3 | 60 | 71.2 | 7.2 |
| Style this (?with=) | `GET /styling` | 200 | 17.6 | 36.6 | 15.6 | 10 | 325 | 86.1 | 8.0 |
| Edit an outfit (?outfit=) | `GET /styling` | 200 | 11.3 | 26.2 | 5.6 | 4 | 83 | 87.3 | 8.2 |
| For a planned evening (?for=) | `GET /styling` | 200 | 9.3 | 19.9 | 3.8 | 3 | 60 | 71.6 | 7.3 |
| Shuffle, one row locked | `GET /styling/shuffle` | 200 | 19.3 | 53.7 | 11.1 | 9 | 323 | 74.3 | 4.6 |
| Add a row | `GET /styling/row` | 200 | 7.6 | 19.2 | 2.9 | 2 | 56 | 58.3 | 3.6 |
| Strip paging | `GET /styling/garments` | 200 | 4.0 | 10.9 | 1.6 | 2 | 12 | 7.7 | 0.9 |
| Old builder link (/outfits/new) | `GET /outfits/new` | 302 | 1.6 | 4.2 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Old edit link (/outfits/:id/edit) | `GET /outfits/:id/edit` | 302 | 1.2 | 3.8 | 0.4 | 1 | 1 | 0.0 | 0.0 |
| Save an outfit | `POST /styling` | 303 | 5.9 | 10.2 | 4.8 | 8 | 6 | 0.0 | 0.0 |

## #164 Outfits and saved outfits

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Outfits (Saved) | `GET /outfits` | 200 | 9.6 | 21.6 | 5.4 | 3 | 68 | 61.2 | 6.7 |
| Saved, picking for a day | `GET /outfits` | 200 | 11.9 | 34.1 | 10.4 | 4 | 69 | 68.4 | 7.0 |
| Outfit page (Worn strip) | `GET /outfits/:id` | 200 | 8.1 | 21.0 | 3.8 | 3 | 21 | 65.6 | 5.6 |
| Create an outfit | `POST /outfits` | 302 | 3.7 | 4.8 | 2.8 | 6 | 4 | 0.0 | 0.0 |
| Edit an outfit | `POST /outfits/:id` | 302 | 5.3 | 6.8 | 4.3 | 12 | 6 | 0.0 | 0.0 |
| Delete an outfit | `DELETE /outfits/:id` | 200 | 3.9 | 4.8 | 3.0 | 9 | 4 | 0.0 | 0.0 |

## #165 Calendar and week plan

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Week agenda | `GET /calendar` | 200 | 11.2 | 24.4 | 7.6 | 4 | 21 | 58.9 | 7.8 |
| Next week | `GET /calendar` | 200 | 9.7 | 20.8 | 5.2 | 4 | 14 | 39.4 | 5.8 |
| Month collages | `GET /calendar/month` | 200 | 10.6 | 28.4 | 5.0 | 2 | 37 | 46.7 | 5.5 |
| Last month | `GET /calendar/month` | 200 | 10.6 | 23.6 | 4.8 | 2 | 41 | 46.2 | 5.3 |
| + Plan sheet | `GET /calendar/plan` | 200 | 9.9 | 20.5 | 8.2 | 3 | 38 | 39.2 | 5.6 |
| Selfie | `GET /selfies/:fileName` | 200 | 3.3 | 18.0 | 1.4 | 2 | 2 | 14.7 | 14.7 |
| Selfie thumb | `GET /selfies/thumb/:fileName` | 200 | 2.9 | 8.9 | 1.3 | 2 | 2 | 3.4 | 3.4 |
| Plan an outfit on a day | `POST /calendar` | 302 | 4.1 | 5.4 | 3.2 | 11 | 6 | 0.0 | 0.0 |
| Remove a planned entry | `POST /calendar/:id/delete` | 303 | 3.9 | 5.5 | 3.0 | 8 | 4 | 0.0 | 0.0 |
| Mark worn (calendar) | `POST /calendar/:id/worn` | 303 | 5.2 | 6.4 | 4.3 | 9 | 8 | 0.0 | 0.0 |
| Plan my week | `POST /calendar/plan-week` | 303 | 13.0 | 16.3 | 11.7 | 12 | 435 | 0.0 | 0.0 |
| Undo Plan my week | `POST /calendar/plan-week/:id/undo` | 303 | 7.4 | 10.1 | 6.6 | 19 | 11 | 0.0 | 0.0 |
| Save the week template | `POST /auth/profile/week` | 303 | 1.0 | 1.4 | 0.6 | 4 | 1 | 0.0 | 0.0 |
| Add a selfie | `POST /calendar/:id/selfie` | 303 | 55.1 | 65.6 | 5.3 | 14 | 8 | 0.0 | 0.0 |
| Remove a selfie | `POST /selfies/:id/delete` | 303 | 2.4 | 4.0 | 1.4 | 2 | 2 | 0.0 | 0.0 |

## #166 Trips and packing

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Trips | `GET /trips` | 200 | 5.0 | 12.4 | 1.8 | 2 | 2 | 9.4 | 3.0 |
| Trip page and packing list | `GET /trips/:id` | 200 | 14.3 | 26.1 | 9.0 | 6 | 27 | 33.3 | 5.7 |
| New trip form | `GET /trips/new` | 200 | 3.5 | 11.1 | 0.6 | 1 | 1 | 10.3 | 3.2 |
| Edit trip form | `GET /trips/:id/edit` | 200 | 4.0 | 15.5 | 1.2 | 2 | 2 | 10.6 | 3.3 |
| Add-an-outfit page | `GET /trips/:id/outfits/new` | 200 | 10.2 | 29.9 | 6.0 | 4 | 38 | 39.5 | 5.6 |
| Trip weather | `GET /trips/:id/weather` | 200 | 2.6 | 6.2 | 1.1 | 2 | 2 | 0.1 | 0.1 |
| Ideas for the trip | `GET /outfits/ideas` | 200 | 11.2 | 22.4 | 7.4 | 6 | 246 | 31.8 | 5.0 |
| Create a trip | `POST /trips` | 303 | 1.7 | 2.2 | 1.1 | 2 | 2 | 0.0 | 0.0 |
| Edit a trip | `POST /trips/:id` | 303 | 3.4 | 4.1 | 2.7 | 8 | 3 | 0.0 | 0.0 |
| Delete a trip | `DELETE /trips/:id` | 200 | 1.4 | 1.9 | 0.9 | 2 | 2 | 0.0 | 0.0 |
| Add an outfit to the trip | `POST /trips/:id/outfits` | 303 | 2.3 | 3.0 | 1.8 | 6 | 3 | 0.0 | 0.0 |
| Remove a trip outfit | `POST /trips/:id/outfits/:tripOutfitId/delete` | 303 | 2.7 | 4.4 | 2.1 | 6 | 3 | 0.0 | 0.0 |
| Wear on a trip day | `POST /trips/:id/outfits/:tripOutfitId/wear` | 303 | 4.4 | 5.7 | 3.7 | 17 | 10 | 0.0 | 0.0 |
| Pack garments | `POST /trips/:id/packed` | 303 | 3.6 | 5.0 | 3.0 | 7 | 2 | 0.0 | 0.0 |
| Add a packing item | `POST /trips/:id/items` | 303 | 2.4 | 3.2 | 1.7 | 5 | 2 | 0.0 | 0.0 |
| Pack items | `POST /trips/:id/items/packed` | 303 | 2.2 | 2.8 | 1.6 | 5 | 2 | 0.0 | 0.0 |
| Remove a packing item | `POST /trips/:id/items/:itemId/delete` | 303 | 1.8 | 2.7 | 1.1 | 2 | 2 | 0.0 | 0.0 |
| Copy another trip’s items | `POST /trips/:id/items/copy` | 303 | 4.1 | 5.1 | 3.3 | 9 | 15 | 0.0 | 0.0 |
| Destination search | `GET /trips/:id/places` | 200 | 1.9 | 2.7 | 0.5 | 2 | 2 | 0.4 | 0.4 |
| Set the destination | `POST /trips/:id/destination` | 303 | 2.4 | 3.1 | 1.3 | 2 | 2 | 0.0 | 0.0 |

## #167 Plans, shopping list, wishlist and Bought it

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Plans | `GET /wardrobe/plans` | 200 | 7.1 | 20.2 | 5.0 | 5 | 102 | 10.3 | 3.3 |
| Plan page (gaps) | `GET /wardrobe/plans/:id` | 200 | 9.3 | 18.4 | 7.5 | 5 | 103 | 24.7 | 5.1 |
| New plan form | `GET /wardrobe/plans/new` | 200 | 3.2 | 8.5 | 0.6 | 1 | 1 | 9.6 | 3.1 |
| Edit plan form | `GET /wardrobe/plans/:id/edit` | 200 | 3.8 | 7.9 | 1.1 | 2 | 2 | 9.6 | 3.1 |
| New item form | `GET /wardrobe/plans/:id/items/new` | 200 | 5.7 | 10.0 | 1.6 | 3 | 9 | 19.5 | 4.8 |
| Edit item form | `GET /wardrobe/plans/:id/items/:itemId/edit` | 200 | 6.7 | 12.7 | 2.3 | 4 | 10 | 19.8 | 4.9 |
| Candidates picker | `GET /wardrobe/plans/:id/items/:itemId/candidates` | 200 | 8.6 | 20.3 | 6.1 | 5 | 7 | 11.7 | 3.5 |
| Shopping list | `GET /wardrobe/shopping` | 200 | 8.6 | 20.2 | 9.3 | 5 | 103 | 13.9 | 3.9 |
| Compare plans | `GET /wardrobe/plans/compare` | 200 | 7.3 | 19.0 | 4.6 | 4 | 101 | 9.6 | 3.0 |
| Wishlist | `GET /wardrobe/wishlist` | 200 | 8.5 | 15.2 | 6.0 | 5 | 15 | 19.5 | 5.2 |
| Wishlist item | `GET /wardrobe/:id` | 200 | 52.7 | 132.1 | 10.6 | 7 | 87 | 24.1 | 6.8 |
| Wishlist form | `GET /wardrobe/new` | 200 | 9.3 | 28.3 | 6.2 | 5 | 84 | 31.9 | 7.0 |
| Goes with my closet | `GET /wardrobe/:id/outfit-count` | 200 | 9.9 | 17.8 | 4.7 | 4 | 84 | 0.1 | 0.1 |
| Plan items of a wishlist item | `GET /wardrobe/:id/plan-items` | 200 | 8.4 | 23.5 | 7.8 | 6 | 103 | 16.2 | 3.5 |
| Bought it form | `GET /wardrobe/:id/bought` | 200 | 13.1 | 26.3 | 10.6 | 8 | 105 | 10.5 | 3.3 |
| Style profile | `GET /auth/profile/style` | 200 | 5.3 | 10.0 | 1.8 | 4 | 13 | 14.1 | 3.9 |
| From your orders | `GET /wardrobe/orders` | 200 | 4.4 | 11.9 | 1.4 | 2 | 7 | 14.4 | 3.3 |
| Create a plan | `POST /wardrobe/plans` | 303 | 3.0 | 4.6 | 2.3 | 7 | 4 | 0.0 | 0.0 |
| Plan from a wardrobe | `POST /wardrobe/plans/from-wardrobe` | 303 | 7.1 | 8.4 | 5.7 | 12 | 65.5 (56–75) | 0.0 | 0.0 |
| Edit a plan | `POST /wardrobe/plans/:id` | 303 | 2.8 | 3.7 | 2.0 | 7 | 5 | 0.0 | 0.0 |
| Duplicate a plan | `POST /wardrobe/plans/:id/duplicate` | 303 | 14.3 | 17.8 | 13.5 | 32 | 116.5 (107–126) | 0.0 | 0.0 |
| Activate a plan | `POST /wardrobe/plans/:id/activate` | 303 | 3.0 | 4.1 | 2.3 | 8 | 4 | 0.0 | 0.0 |
| Delete a plan | `DELETE /wardrobe/plans/:id` | 200 | 2.6 | 3.1 | 1.9 | 6 | 4 | 0.0 | 0.0 |
| Add a plan item | `POST /wardrobe/plans/:id/items` | 303 | 3.5 | 4.6 | 2.6 | 8 | 6 | 0.0 | 0.0 |
| Edit a plan item | `POST /wardrobe/plans/:id/items/:itemId` | 303 | 4.3 | 5.8 | 3.0 | 8 | 6 | 0.0 | 0.0 |
| Accept a proposed item | `POST /wardrobe/plans/:id/items/:itemId/accept` | 303 | 3.0 | 3.4 | 2.3 | 7 | 5 | 0.0 | 0.0 |
| Delete a plan item | `DELETE /wardrobe/plans/:id/items/:itemId` | 200 | 2.6 | 3.6 | 2.0 | 7 | 5 | 0.0 | 0.0 |
| Save candidates | `POST /wardrobe/plans/:id/items/:itemId/candidates` | 303 | 4.6 | 6.1 | 3.6 | 11 | 8 | 0.0 | 0.0 |
| Save a wishlist item’s plan items | `POST /wardrobe/:id/plan-items` | 303 | 4.3 | 5.5 | 3.5 | 10 | 7 | 0.0 | 0.0 |
| Bought it | `POST /wardrobe/:id/bought` | 303 | 6.3 | 7.2 | 5.1 | 13 | 5 | 0.0 | 0.0 |
| Save the style profile | `POST /auth/profile/style` | 303 | 2.0 | 2.5 | 1.1 | 2 | 1 | 0.0 | 0.0 |
| Add an order item to the closet | `POST /wardrobe/orders/:id/add` | 200 | 73.7 | 78.2 | 7.0 | 10 | 124 | 31.4 | 6.8 (6.8–6.8) |
| Dismiss an order item | `POST /wardrobe/orders/:id/dismiss` | 303 | 1.8 | 2.2 | 1.1 | 2 | 2 | 0.0 | 0.0 |

## #168 Ideas gallery

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Ideas | `GET /outfits/ideas` | 200 | 9.9 | 23.1 | 8.3 | 7 | 247 | 41.7 | 5.1 |
| Ideas for a planned evening | `GET /outfits/ideas` | 200 | 31.2 | 56.8 | 11.2 | 7 | 247 | 37.0 | 4.9 |
| Ideas with a garment | `GET /outfits/ideas` | 200 | 10.6 | 26.4 | 8.2 | 8 | 248 | 44.1 | 5.0 |
| More ideas (page 2) | `GET /outfits/ideas/more` | 200 | 8.8 | 21.2 | 7.6 | 6 | 243 | 31.3 | 1.8 |
| More ideas (page 50, the cap) | `GET /outfits/ideas/more` | 200 | 33.5 | 67.8 | 11.9 | 6 | 243 | 31.3 | 2.1 |
| Pick an idea | `POST /outfits/ideas/pick` | 303 | 4.4 | 5.0 | 3.7 | 8 | 8 | 0.0 | 0.0 |
| Never pair these (clash) | `POST /outfits/ideas/avoid` | 303 | 2.6 | 3.1 | 1.9 | 5 | 3 | 0.0 | 0.0 |
| Pair them again | `POST /outfits/ideas/allow` | 303 | 2.0 | 2.3 | 1.1 | 2 | 2 | 0.0 | 0.0 |
| Too warm | `POST /outfits/ideas/feedback` | 303 | 2.3 | 3.1 | 1.4 | 2 | 2 | 0.0 | 0.0 |

## #169 Insights and yearly recap

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Insights | `GET /wardrobe/insights` | 200 | 12.2 | 25.1 | 8.8 | 3 | 86 | 52.4 | 7.2 |
| Insights, unworn 30 days | `GET /wardrobe/insights` | 200 | 9.6 | 24.0 | 6.8 | 3 | 86 | 57.9 | 7.7 |
| Year in review | `GET /wardrobe/recap` | 200 | 7.9 | 18.8 | 6.0 | 3 | 89 | 23.3 | 5.3 |
| Year in review, last year | `GET /wardrobe/recap` | 200 | 6.5 | 20.6 | 4.6 | 3 | 84 | 10.2 | 3.3 |

## #170 Sharing and shared views

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Shared wardrobe | `GET /wardrobe` | 200 | 7.6 | 15.0 | 8.3 | 8 | 18 | 31.5 | 6.4 |
| Shared garment | `GET /wardrobe/:id` | 200 | 8.4 | 17.3 | 4.6 | 5 | 3 | 18.5 | 5.7 |
| Shared capsules | `GET /capsules` | 200 | 7.3 | 15.9 | 9.2 | 7 | 8 | 18.6 | 4.9 |
| Shared wishlist | `GET /wardrobe/wishlist` | 200 | 7.3 | 13.3 | 3.3 | 4 | 3 | 16.6 | 4.6 |
| Styling a shared wardrobe | `GET /styling` | 200 | 8.9 | 22.0 | 6.2 | 5 | 15 | 38.0 | 5.0 |
| Share page, garment (signed out) | `GET /share` | 200 | 4.4 | 12.7 | 1.4 | 1 | 1 | 8.7 | 2.8 |
| Share page, outfit (signed out) | `GET /share` | 200 | 5.6 | 9.4 | 2.2 | 1 | 1 | 9.2 | 2.9 |
| Share preview image | `GET /file/watermark/:shareableId` | 200 | 65.3 | 132.9 | 1.1 | 1 | 1 | 29.1 | 29.1 |
| Old manage page | `GET /wardrobe-share/manage` | 301 | 1.7 | 4.5 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Create an invite link | `POST /wardrobe-share/create-invite-link` | 200 | 2.1 | 2.6 | 1.1 | 2 | 2 | 0.7 | 0.7 |
| Invite landing | `GET /wardrobe-share/invite/:token` | 200 | 2.8 | 5.0 |  | 2 | 2 | 6.2 | 2.1 (2.1–2.1) |
| Accept an invite | `POST /wardrobe-share/invite/:token/accept` | 302 | 3.3 | 6.2 |  | 6 | 2 | 0.0 | 0.0 |
| Decline an invite | `POST /wardrobe-share/invite/:token/decline` | 302 | 1.4 | 3.2 |  | 2 | 2 | 0.0 | 0.0 |
| Remove a share | `POST /wardrobe-share/:id/remove` | 302 | 2.7 | 4.2 | 1.5 | 3 | 2 | 0.0 | 0.0 |
| Edit a shared garment (MANAGE) | `POST /wardrobe/:id` | 302 | 4.4 | 5.3 | 2.7 | 4 | 4 | 0.0 | 0.0 |

## #171 Auth, account and push

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Profile | `GET /auth/profile` | 200 | 6.8 | 28.0 | 12.7 | 9 | 34 | 26.9 | 6.2 |
| Sign-in page | `GET /auth/login` | 200 | 2.1 | 6.0 | 0.0 | 0 | 0 | 9.2 | 2.9 |
| Registration page | `GET /auth/register` | 200 | 2.1 | 6.7 | 0.0 | 0 | 0 | 9.6 | 3.0 |
| Change email page | `GET /auth/update-email` | 200 | 3.4 | 8.0 | 0.6 | 1 | 1 | 10.0 | 3.1 |
| Change password page | `GET /auth/change-password` | 200 | 3.3 | 8.8 | 0.6 | 1 | 1 | 10.3 | 3.1 |
| Delete account page | `GET /auth/delete-account` | 200 | 3.2 | 9.6 | 0.7 | 1 | 1 | 9.7 | 3.1 |
| Agent access (tokens) | `GET /auth/tokens` | 200 | 5.0 | 17.5 | 1.8 | 2 | 13 | 13.7 | 2.8 |
| Sign-out page | `GET /auth/logout` | 200 | 2.9 | 8.3 | 0.6 | 1 | 1 | 8.7 | 2.8 |
| Sizes | `GET /auth/profile/sizes` | 200 | 5.1 | 13.3 | 2.0 | 3 | 10 | 24.8 | 4.4 |
| Brand size hint | `GET /auth/profile/sizes/hint` | 200 | 2.5 | 6.4 | 1.0 | 2 | 2 | 0.2 | 0.2 |
| VAPID public key | `GET /push/vapid-public-key` | 200 | 1.5 | 7.5 | 0.5 | 1 | 1 | 0.1 | 0.1 |
| Sign in | `POST /auth/login` | 302 | 276.8 | 294.4 |  | 1 | 1 | 0.0 | 0.0 |
| Register | `POST /auth/register` | 302 | 274.7 | 308.8 | 1.9 | 2 | 1 | 0.0 | 0.0 |
| Validate registration (as typed) | `POST /auth/validate/register` | 200 | 0.3 | 1.2 | 0.0 | 0 | 0 | 0.4 | 0.4 |
| Validate an email change | `POST /auth/validate/update-email` | 200 | 1.4 | 3.1 | 0.5 | 1 | 1 | 0.1 | 0.1 |
| Change email | `POST /auth/update-email` | 302 | 299.6 | 327.5 |  | 4 | 2 | 0.0 | 0.0 |
| Change password | `POST /auth/change-password` | 302 | 600.4 | 628.3 |  | 7 | 3 | 0.0 | 0.0 |
| Delete account | `POST /auth/delete-account` | 302 | 299.8 | 322.9 |  | 7 | 2 | 0.0 | 0.0 |
| Create an access token | `POST /auth/tokens` | 200 | 561.3 | 853.4 |  | 8 | 6 | 9.2 | 3.0 (3.0–3.0) |
| Revoke an access token | `POST /auth/tokens/:id/revoke` | 303 | 4.8 | 8.4 | 3.2 | 2 | 2 | 0.0 | 0.0 |
| Sign out | `POST /auth/logout` | 303 | 2.0 | 3.4 | 0.7 | 1 | 1 | 0.0 | 0.0 |
| Subscribe a device | `POST /push/subscribe` | 204 | 4.7 | 8.9 | 2.7 | 2 | 2 | 0.0 | 0.0 |
| Unsubscribe a device | `POST /push/unsubscribe` | 204 | 3.9 | 7.1 | 2.3 | 2 | 2 | 0.0 | 0.0 |
| Send a test notification | `POST /push/test` | 200 | 3.1 | 3.8 | 1.4 | 2 | 25 | 0.1 | 0.1 |
| Sizes: unit | `POST /auth/profile/sizes/unit` | 303 | 3.8 | 6.2 | 2.2 | 2 | 1 | 0.0 | 0.0 |
| Sizes: measurements | `POST /auth/profile/sizes/measurements` | 303 | 5.2 | 6.6 | 3.2 | 3 | 2 | 0.0 | 0.0 |
| Sizes: add a brand | `POST /auth/profile/sizes/brands` | 303 | 4.5 | 7.8 | 3.0 | 4 | 2 | 0.0 | 0.0 |
| Sizes: edit a brand | `POST /auth/profile/sizes/brands/:id` | 303 | 4.3 | 6.5 | 2.7 | 2 | 2 | 0.0 | 0.0 |
| Sizes: remove a brand | `POST /auth/profile/sizes/brands/:id/delete` | 303 | 3.7 | 6.3 | 2.3 | 2 | 2 | 0.0 | 0.0 |
| Weather: city search | `GET /weather/places` | 200 | 4.0 | 9.6 | 1.0 | 1 | 1 | 0.4 | 0.4 |
| Weather: set home | `POST /weather/home` | 200 | 6.8 | 8.0 | 3.0 | 3 | 2 | 1.6 | 0.6 |
| Weather: use this phone’s location | `POST /weather/here` | 200 | 8.6 | 14.5 | 4.5 | 3 | 2 | 1.2 | 0.5 |
| Weather: stop using this phone’s location | `POST /weather/here/clear` | 200 | 6.5 | 10.2 | 3.0 | 3 | 2 | 1.6 | 0.6 |
| Weather: unit | `POST /weather/unit` | 200 | 5.0 | 8.4 | 2.7 | 3 | 2 | 0.9 | 0.9 |
| Weather: feels warmer or colder | `POST /weather/feedback` | 200 | 5.8 | 17.1 | 3.7 | 3 | 3 | 0.8 (0.6–0.8) | 0.8 (0.6–0.8) |
| Weather: reset the offset | `POST /weather/offset/reset` | 200 | 5.0 | 9.3 | 3.1 | 3 | 2 | 0.6 | 0.6 |
| Weather: remove home | `POST /weather/home/clear` | 200 | 6.0 | 8.1 | 2.8 | 3 | 2 | 1.5 | 0.6 |
| Weather: set home again | `POST /weather/home` | 200 | 8.1 | 8.1 | 4.6 | 3 | 2 | 1.6 | 0.6 |

## #172 MCP tools

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| get_today | `mcp get_today` | 200 | 26.5 | 44.3 |  | 10 | 433 | 1.3 | 0.6 (0.6–0.6) |
| search_garments | `mcp search_garments` | 200 | 7.3 | 12.1 |  | 3 | 51 | 11.7 | 0.4 |
| search_garments (keyword) | `mcp search_garments` | 200 | 7.4 | 13.2 |  | 3 | 8 | 1.7 | 0.4 |
| get_garment | `mcp get_garment` | 200 | 11.0 | 12.8 |  | 5 | 54 | 3.4 (3.4–3.4) | 0.8 (0.8–0.8) |
| get_garment_photo | `mcp get_garment_photo` | 200 | 9.6 | 13.1 |  | 3 | 3 | 0.5 | 0.5 |
| update_garment | `mcp update_garment` | 200 | 16.0 | 23.2 |  | 7 | 32 | 1.1 | 0.6 (0.6–0.6) |
| add_garment_copy | `mcp add_garment_copy` | 200 | 15.7 | 24.0 |  | 11 | 33 | 0.9 | 0.9 |
| list_wishlist | `mcp list_wishlist` | 200 | 6.3 | 7.9 |  | 2 | 4 | 0.7 | 0.7 |
| add_garment_from_link | `mcp add_garment_from_link` | 200 | 138.2 | 155.2 |  | 17 | 36 | 1.1 | 0.6 |
| list_capsules | `mcp list_capsules` | 200 | 9.8 | 15.1 |  | 3 | 44 | 1.5 | 0.2 (0.2–0.2) |
| get_capsule | `mcp get_capsule` | 200 | 9.5 | 11.5 |  | 3 | 29 | 7.5 | 1.3 (1.3–1.3) |
| set_capsule_membership | `mcp set_capsule_membership` | 200 | 9.0 | 11.2 |  | 7 | 4 | 0.1 | 0.1 |
| list_outfits | `mcp list_outfits` | 200 | 14.3 | 20.5 |  | 2 | 84 | 15.8 | 1.8 (1.8–1.8) |
| get_outfit | `mcp get_outfit` | 200 | 7.1 | 9.1 |  | 2 | 2 | 0.3 | 0.3 |
| create_outfit | `mcp create_outfit` | 200 | 18.8 | 35.5 |  | 10 | 10 | 0.1 | 0.1 |
| schedule_outfit | `mcp schedule_outfit` | 200 | 15.2 | 19.2 |  | 12 | 10 | 0.2 | 0.2 |
| suggest_outfits | `mcp suggest_outfits` | 200 | 15.5 | 22.7 |  | 6 | 544 | 2.9 | 0.6 (0.6–0.6) |
| goes_with_closet | `mcp goes_with_closet` | 200 | 70.9 | 84.6 |  | 4 | 199 | 2.3 | 0.6 |
| pick_outfit | `mcp pick_outfit` | 200 | 14.9 | 22.6 |  | 13 | 10 | 0.2 | 0.2 |
| get_calendar | `mcp get_calendar` | 200 | 15.3 | 20.3 |  | 4 | 25 | 9.7 | 1.3 |
| laundry_status | `mcp laundry_status` | 200 | 7.7 | 10.6 |  | 2 | 3 | 0.3 | 0.3 |
| mark_worn | `mcp mark_worn` | 200 | 5.4 | 10.0 |  | 3 | 2 | 0.1 | 0.1 |
| mark_washed | `mcp mark_washed` | 200 | 7.0 | 10.9 |  | 2 | 2 | 0.1 | 0.1 |
| plan_week | `mcp plan_week` | 200 | 12.0 | 16.0 |  | 8 | 5 | 0.3 | 0.3 |
| list_trips | `mcp list_trips` | 200 | 7.7 | 16.2 |  | 2 | 71 | 12.3 | 0.4 (0.4–0.4) |
| get_trip | `mcp get_trip` | 200 | 14.5 | 30.6 |  | 5 | 28 | 5.5 | 0.9 (0.9–0.9) |
| plan_trip_outfit | `mcp plan_trip_outfit` | 200 | 7.6 | 11.3 |  | 6 | 3 | 0.2 | 0.2 |
| wardrobe_stats | `mcp wardrobe_stats` | 200 | 15.2 | 18.6 |  | 3 | 201 | 17.1 | 2.0 |
| get_weather | `mcp get_weather` | 200 | 6.9 | 8.7 |  | 3 | 3 | 1.7 | 0.5 |
| list_shared_wardrobes | `mcp list_shared_wardrobes` | 200 | 4.4 | 6.6 |  | 2 | 2 | 0.1 | 0.1 |
| compare_with_shared_wardrobe | `mcp compare_with_shared_wardrobe` | 200 | 10.8 | 15.7 |  | 4 | 209 | 33.3 | 5.0 (5.0–5.0) |
| get_style_profile | `mcp get_style_profile` | 200 | 4.7 | 8.2 |  | 3 | 2 | 0.5 | 0.5 |
| list_plans | `mcp list_plans` | 200 | 37.5 | 43.2 |  | 4 | 1044 | 9.1 | 0.5 |
| get_plan_gaps | `mcp get_plan_gaps` | 200 | 18.8 | 23.0 |  | 5 | 287 | 140.5 | 3.6 |
| propose_plan_item | `mcp propose_plan_item` | 200 | 8.8 | 11.5 |  | 8 | 6 | 0.1 | 0.1 |
| update_plan_item | `mcp update_plan_item` | 200 | 9.8 | 17.7 |  | 7 | 5 | 0.1 | 0.1 |
| get_sizes | `mcp get_sizes` | 200 | 6.7 | 12.1 |  | 3 | 33 | 2.7 | 0.5 |
| get_shopping_list | `mcp get_shopping_list` | 200 | 17.3 | 21.6 |  | 5 | 310 | 6.8 | 0.8 (0.8–0.8) |
| add_candidate | `mcp add_candidate` | 200 | 15.5 | 19.1 |  | 12 | 9 | 0.4 | 0.4 |
| compare_plans | `mcp compare_plans` | 200 | 38.3 | 63.4 |  | 4 | 1067 | 52.8 | 1.7 |

## #173 Background jobs

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Morning reminders (with the re-plan first) | `job reminders` |  | 53.4 | 57.0 |  | 28 | 1161 | 0.0 | 0.0 |
| Evening reminders | `job reminders` |  | 15.4 | 20.3 |  | 9 | 547 | 0.0 | 0.0 |
| Reminders, nothing due | `job reminders` |  | 0.6 | 0.7 |  | 1 | 1 | 0.0 | 0.0 |
| Reminder claims prune | `job reminder_prune` |  | 0.8 | 2.8 |  | 1 | 0 | 0.0 | 0.0 |
| Week re-plan | `job replan` |  | 31.0 | 39.8 |  | 17 | 612 | 0.0 | 0.0 |
| Week re-plan, already done today | `job replan` |  | 1.6 | 1.8 |  | 1 | 0 | 0.0 | 0.0 |
| Re-plan claims prune | `job replan_prune` |  | 0.5 | 0.6 |  | 1 | 0 | 0.0 | 0.0 |
| Forecast refresh | `job weather refresh` |  | 3.4 | 4.5 |  | 3 | 2 | 0.0 | 0.0 |
| Cutout of an uploaded photo | `job cutout` |  | 197.2 | 223.6 |  | 11 | 2 | 0.0 | 0.0 |
| Cutout retry (nightly) | `job cutout_retry` |  | 1.1 | 6.2 |  | 1 | 0 | 0.0 | 0.0 |
| Storage reconciliation (nightly) | `job reconciliation` |  | 118.7 | 123.0 |  | 3 | 140 | 0.0 | 0.0 |
| Order mail poll (one new order email) | `job order_mail` |  | 27.1 | 31.5 |  | 8 | 6 | 0.0 | 0.0 |
| Order mail poll, nothing new | `job order_mail` |  | 7.5 | 10.3 |  | 3 | 3 | 0.0 | 0.0 |

## #174 Per-request platform overhead

| Step | Target | Status | p50 ms | p95 ms | db ms | Statements | Rows | KB | Wire KB |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Health check | `GET /healthz` | 204 | 0.3 | 0.7 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| About, signed in | `GET /about` | 200 | 3.3 | 8.2 | 0.6 | 1 | 1 | 9.1 | 3.0 |
| About, signed out | `GET /about` | 200 | 1.9 | 6.0 | 0.0 | 0 | 0 | 8.7 | 2.8 |
| Offline page | `GET /offline.html` | 200 | 3.7 | 8.0 | 0.6 | 1 | 1 | 9.0 | 2.7 |
| Manifest | `GET /manifest.json` | 200 | 0.4 | 0.6 | 0.0 | 0 | 0 | 1.0 | 1.0 |
| Asset links | `GET /.well-known/*` | 200 | 0.3 | 0.4 | 0.0 | 0 | 0 | 0.0 | 0.0 |
| Stylesheet | `GET /*` | 200 | 1.3 | 3.6 | 0.0 | 0 | 0 | 140.7 | 19.5 |
| Service worker | `GET /*` | 200 | 1.1 | 5.2 | 0.0 | 0 | 0 | 34.9 | 10.6 |
| A page script | `GET /*` | 200 | 1.0 | 8.9 | 0.0 | 0 | 0 | 4.0 | 1.5 |
| Not found page | `GET (unmatched)` | 404 | 6.0 | 15.1 | 0.6 | 1 | 1 | 8.5 | 2.7 (2.7–2.7) |
| Metrics scrape | `GET /metrics` | 200 | 7.3 | 20.9 | 0.7 | 1 | 1 | 134.5 (133.6–134.6) | 7.9 (7.6–8.0) |
| Device timings beacon | `POST /metrics/vitals` | 204 | 1.8 | 2.6 | 0.6 | 1 | 1 | 0.0 | 0.0 |
| Script error beacon | `POST /errors/client` | 204 | 3.9 | 8.1 | 0.8 | 1 | 1 | 0.0 | 0.0 |

## Not walked

Every route template and MCP tool was reached.
