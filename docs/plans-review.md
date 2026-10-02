# Wardrobe plans: the review and what each page reads

The detail behind `src/web/plans/CLAUDE.md`'s review bullets (#271, #278, epic #268) and its statement counts (#167). The rules live in code: atop `src/wardrobe/plan-review.ts` (the machine) and `src/web/plans/review.ts` (the review post).

## The item review state machine (#278)

`plan_item.review` replaced the `proposed` boolean in `drizzle/0033_plan-item-review.sql` (true to `proposed`, false to `accepted`) and `0034_plan-item-drop-proposed.sql` (the drop). It is two migrations because drizzle-kit asks whether a dropped column and an added one are a rename, a prompt that needs a TTY; generating the add, then the drop, avoids it. `plan-item-review-migration.spec.ts` covers the backfill.

| Event | From | To | Owner's note |
| --- | --- | --- | --- |
| `accept` | proposed, revise | accepted | cleared |
| `change` ("Change this") | proposed, accepted | revise | written, required |
| `decline` ("Don't buy") | proposed, revise | declined | written, optional |
| `repropose` (`update_plan_item`) | revise, accepted | proposed | kept |
| `reconsider` | declined | proposed | cleared |

- **Every other pair is refused, self-moves included.** `src/wardrobe/plan-review.spec.ts` covers all 20 pairs.
- **The owner's note.** `owner_note` is kept apart from the agent's `note`. The check `plan_item_owner_note_check` refuses `revise` without one.
- **When the agent last wrote the item.** `agent_changed_at` (null: never) is set only by the agent: `propose_plan_item`'s insert and `update_plan_item`. The owner's moves, form saves and purchase adjustments never touch it, so a later owner action cannot hide feedback. `get_plan_feedback` flags a rejection `new` when `agent_changed_at` is null or older than it. It is not `changed_at > ...` of any owner write: a review post stamps its rejection and its move in one transaction, whose `now()` is equal.
- **Who writes what.** `reviewItems` (`queries.ts`) is the owner's moves, one event per call: two statements, the read and one update, with each note a `case`. `updateItem` is a content rewrite whose move depends on who wrote it (`rewriteEvent`):
  - The owner's form save accepts what is not accepted yet.
  - The agent's `update_plan_item` reproposes what is not a proposal.
  - Either one on a declined item is a 409.
- **Everything runs under the owner lock**, which every item writer holds, so the review judged is the one written over.
- **Declined items** keep their row, so the agent sees them. A new candidate link to one throws `CandidateForDeclinedItem` (409) in `changeCandidates`. A duplicate copies the item, its note and its rejections, but not its candidates, which are inert.

## The review page and "Accept these"

**The page** (`GET /wardrobe/plans/:id/review`) has a snap strip (`src/web/strip/`) per proposal.

- **Order.** Strips run top to toe (`OUTFIT_ORDER`, custom categories last), then `byPriority`.
- **Tiles.** In order: Don't buy, Change this…, Keep, then the candidates in `rankCandidates` order (as `shoppingList`). The strip starts on the best candidate, else Keep. `OutfitCountSlot` is `inStrip`.
- **Under each strip** is a note for the agent. On each candidate is a "Not this one" box with a reason field.
- **Below the strips**, read-only, are the items waiting on the agent (revise) and the declined ones, each with its note. Reconsider lives on the plan page only, because a post of its own here would lose the swipes made so far.

**Every control rides in the one post**, so nothing reloads the page between swipes (owner decision, #278).

- **What the post carries.** Each strip posts `shown`, `pick` (`<item>:decline|change|keep|<garment>`), `offered` (`<item>:<garment>`, what it drew) and `note`, one per strip in `shown`'s order. Each tile posts `reject` (`<item>:<garment>`, when ticked) and `rejectReason`, one per offered candidate in its order.
- **How `readReview` pairs it.** It pairs notes with strips and reasons with tiles by that order (the browser submits in tree order). It holds `reject` to the strip's `offered`.
- **A post the page could not have sent** is the page as it stands now, with a 400.
- **Refused as posted** (400, with every pick, box and reason kept and nothing written):
  - Change this without a note.
- **A rejected pick reads as Keep**: the item is accepted without a product, the rejection still records and releases that product, Keep releases nothing else.

**`applyReview` is one owner transaction.**

- **Which items it decides.** Only `shown` items still proposed. One decided meanwhile is left as it is and logged.
- **The moves.**
  - A candidate or Keep accepts.
  - Don't buy declines.
  - Change this sends the item back for revision.
- **What is let go** (`releasedCandidates`) is judged only among `offered` ∩ current candidates. A candidate linked after the page was drawn is never judged, and a bought one is no candidate, so no rejection is recorded for it.
  - **"Not this one" always lets go**, with or without the removal box. It records a snapshot of the product in `plan_item_rejection` (`rejections.ts`), with the reason.
  - **With the removal box ticked** (it starts unticked), a picked item's unpicked candidates and every candidate of a declined item are let go too.
  - **Keep and Change this** let go of nothing else.
- **Deleted or unlinked.** A garment is deleted from the wishlist (`deleteGarment(..., 'wishlist')`) only when both hold:
  - Every link it has, in any plan and any review (`candidaciesOf`), is to an item of this post that lets it go.
  - No item of this post picked it.

  A candidate bought meanwhile is kept and logged. One kept because it stands for something else is unlinked from each item that let it go, which frees a place under the cap.
- **After the commit.** Photos go only after the commit. The toast counts what was removed (`?removed=`).

## What each page reads, and why (#167)

These were measured with `npm run audit:pages -- --only '#167'`. Every table here is tiny per owner, so the cost is the number of statements, not the query plans.

- **The whole closet.** The list, the gap view, the shopping list, Compare and a wishlist item's plan items read the plans, their items and the whole closet (`closetPieces`, about 80 rows for Theo). Matching needs every garment of each category an item names, and a category filter would save only a few rows of five categories.
- **Candidates.** The gap view and the list add `candidatesOfPlan` (photos, prices).
- **The rejected products.** `get_plan_gaps` adds `rejectionsOfPlan`.
- **Item routes** find the plan and the item in one statement (`findPlanItem`, a left join), so each miss keeps its own 404.
- **Writes guarded under the owner lock read nothing first** (`addItems`, `updatePlan`, `reviewItems`, `deleteItems`). The plan is read only to draw a refused form or to name the 404 (`itemMiss`).
- **A new plan is made active in its own insert** (a `not exists` over the owner's plans, under the lock), not by an update after it.
- **The duplicate** reads the original, its items and its candidates. It then writes:
  - the copy;
  - its items, in one insert (`copyItems`);
  - their rejections, in one `insert … select` (`copyRejections`);
  - every copy's candidates, in one `changeCandidates` (its `add` takes several sets; it used to be one call per item, eight statements each).

  The seed links a plan's candidates the same way.
- **What is left is the owner transactions' own cost.** Each nested `ownerTransaction` is a savepoint, a `set_config` and the lock again: four statements.

## The shopping list as strips (#272)

`shopping-page.tsx` draws each missing or partly item as a card holding a snap strip of its candidates, the review's pattern without its post.

- **Tiles.** The candidates in the list's order (`shoppingList`), the first centred. Nothing declines or keeps here, and "Not this one" is not offered. The centred tile alone shows (`DETAILS`, invisible on the others, so out of reach) price against budget, the mismatch, the outfit count (`inStrip`), "View product" and **Bought it** (`GET /wardrobe/:id/bought`, the form of Bought it unchanged; `buyCandidate` untouched).
- **No form.** The page has none. The strip's hidden input (`name="candidate"`) only records the centred tile for the observer; nothing reads it.
- **An item with no candidates** has no strip: "No candidates yet." and "Add a product" to the candidates picker. With candidates the link reads "Add a candidate".
- **Above the list**, the totals and "Style with my closet" (`/styling?plan=`, only when some item has a candidate, as on the review).
- **Shared parts** with the review: `candidate-tile.tsx` (`TILE`, `PLINTH`, `DETAILS`, `CandidateFace`, `PriceLine`). The wiring is the review's inline module, rooted on `#shopping-list`.
