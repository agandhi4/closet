# sparse: Dana Marsh

> Busy parent. Added a dozen things in one evening to try the app, and never came back to tag them.

This file is the persona's character bible and the seed's data (`src/seed/bible.ts`): the tables
below are what the seed writes.

## Account

| Field | Value |
|---|---|
| Email | sparse@closet.invalid |
| First name | Dana |
| Last name | Marsh |
| Shares with | demo (MANAGE) |

She shared her wardrobe with Theo, MANAGE: "can you sort this out, you like this stuff". The seed makes
the share whenever both personas exist, whichever was seeded first.

## Who she is

- **Dana Marsh**, 41, Theo's older sister. Physician assistant (12-hour shifts), lives in Maplewood,
  NJ, with her partner and two kids (6 and 9). Theo told her about the app; on **Sunday 2026-09-13,
  21:10 to 21:40**, after the kids were in bed, she added things off the laundry pile as fast as the
  form allowed. She has not opened it since.

## What she owns (12 garments)

As she typed them: no acquired dates, no brand, no prices; a category on each because the form
requires one (`Scrubs` is her own, a custom category: role none, never generated into an outfit). Two
are partly tagged (she started, then stopped); the rest have no properties at all, which is tagging
mode's work. `Photo` says whether she added one (generated art, as for Theo; four have none, the
degraded card). `—` is empty.

| id | Name in the app | Category | Type | Colours | Size | Form. | Length | Notes | Photo |
|---|---|---|---|---|---|---|---|---|---|
| S01 | jeans | bottoms | — | blue | — | — | — | — | yes |
| S02 | black jeans | bottoms | — | — | — | — | — | — | yes |
| S03 | grey tshirt | tops | — | grey | — | — | — | — | yes |
| S04 | white tee | tops | — | — | — | — | — | — | yes |
| S05 | striped top | tops | — | — | — | — | — | — | no |
| S06 | cardigan | tops | cardigan | beige | M | — | — | — | yes |
| S07 | work pants | bottoms | — | black | — | — | — | — | no |
| S08 | puffer | outerwear | — | black | — | — | — | — | yes |
| S09 | sneakers | footwear | — | white | — | — | — | — | yes |
| S10 | wrap dress (wedding in Oct) | dresses | day-dress | blue | — | 3 | midi | — | yes |
| S11 | big bag | bags | — | brown | — | — | — | — | no |
| S12 | scrubs top?? | Scrubs | — | — | — | — | — | does this even go in here | no |

## Saved outfits

Her half-finished first try: untitled (`—`), never scheduled. Same columns as Theo's.

| # | Name | Occasion | Bands | Garments |
|---|---|---|---|---|
| 1 | — | — | — | S01 jeans, S04 white tee |

No calendar entries.

## Testing purpose

Tagging mode (`countToTag`, `nextToTag`), bulk edit on untagged garments, cards without photos or
colours, a custom category, a MANAGE grantee (Theo) editing someone else's closet, and every feature's
"not enough data" answer (the gallery with a few tops and two bottoms, weather matching with no warmth
values, insights with no wears).
