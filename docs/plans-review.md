# Wardrobe plans: the review and what each page reads

The detail behind `src/web/plans/CLAUDE.md`'s review bullets (#271, #278, epic #268) and its statement counts (#167). The rules live in code: atop `src/wardrobe/plan-review.ts` (the machine) and `src/web/plans/review.ts` (the review post).

## The item review state machine (#278)

`plan_item.review` replaced the `proposed` boolean in `drizzle/0033_plan-item-review.sql` (true to `proposed`, false to `accepted`) and `0034_plan-item-drop-proposed.sql` (the drop). It is two migrations because drizzle-kit asks whether a dropped column and an added one are a rename, a prompt that needs a TTY; generating the add, then the drop, avoids it. `plan-item-review-migration.spec.ts` covers the backfill.

| Event                            | From               | To       | Owner's note      |
| -------------------------------- | ------------------ | -------- | ----------------- |
| `accept`                         | proposed, revise   | accepted | cleared           |
| `change` ("Change this")         | proposed, accepted | revise   | written, required |
| `decline` ("Don't buy")          | proposed, revise   | declined | written, optional |
| `repropose` (`update_plan_item`) | revise, accepted   | proposed | kept              |
| `reconsider`                     | declined           | proposed | cleared           |

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

## Looks (#290, epic #289)

A look is an outfit the agent designs from a plan, mixing closet garments with the plan's candidate products. It is not an `outfit`: an outfit is wearable today and feeds the calendar, wears, Today, the weekly auto-plan and the gallery, and `insertSlots` refuses wishlist items on purpose. Looks are plan-scoped and owner-only, like their plan. `src/web/plans/looks.ts` is the only writer of both tables and holds the rule atop it.

**Tables** (`drizzle/0037_plan-looks.sql`):

- `plan_look` has the name, `occasion` (nullable, `OCCASIONS`), the agent's `note`, `reaction`, `owner_note` and `agent_changed_at` (as on `plan_item`). It cascades with its plan.
- `plan_look_slot` has `outfit_slot`'s shape: `(look_id, position)` as the key, `category` (the garment's own when the look was written), and `garment_id` nullable with `ON DELETE SET NULL`. A garment fills one slot per look. Deleting a candidate (from the wishlist, or "Not this one") empties its slot, so the look still knows the role it is missing. The slot shape also lets #292 save a look slot for slot as an outfit.

**The reaction machine** (`src/wardrobe/look-reaction.ts`; `look-reaction.spec.ts` covers all 20 pairs):

| Event                            | From                    | To       | Owner's note      |
| -------------------------------- | ----------------------- | -------- | ----------------- |
| `love` (Love it)                 | proposed, revise        | loved    | cleared           |
| `change` (Change this)           | proposed, loved         | revise   | written, required |
| `decline` (Not for me)           | proposed, revise, loved | declined | written, optional |
| `repropose` (the agent's update) | revise, loved           | proposed | kept              |
| `reconsider`                     | declined                | proposed | cleared           |

`loved` is not final. An agent update of its own still-proposed look is a content edit, not a move. An agent update of a declined look is refused (`LookDeclined`, 409).

**The writers**, all run under the owner lock:

- `proposeLook` and `updateLook` (the agent's).
- `reactToLooks` (the owner's moves, `reviewItems`' shape: two statements). Notes are stored trimmed, a blank one null. Change this without a note is `LookNoteRequired` (400) before any statement.
- `copyLooks` (the duplicate).

**A piece is valid** when it is the plan owner's garment and either in the closet or a current candidate of this plan: on the wishlist and linked to an item of this plan that is not declined. Every writer of candidacy holds the owner lock too: `changeCandidates`, the review moves and post, `deleteItems`, `deletePlan`, the duplicate. The garments are locked `FOR SHARE` in id order, so a delete, Bought it or an archive outside the lock waits for the write.

**Refusals.** Nothing is written in any of these cases:

- `LookPiecesRefused`. A 404 when any id is no garment of the owner's (counted, never named). A 409 when every bad piece is the owner's, named: archived, or not a candidate of this plan (a plain wishlist item, another plan's candidate, a declined item's).
- A 400 for fewer than 2 pieces or more than `OUTFIT_GARMENTS_MAX` (20), a repeated piece, or a blank name.

**Sets and caps.** A look with an emptied slot is nobody's exact set.

- A proposal of exactly the pieces of a look already in the plan answers that look (`alreadyProposed`): a retry writes nothing. The pieces are judged first, so a retry whose set no longer passes (a piece archived meanwhile) is refused, as a fresh proposal would be.
- Exactly a declined look's set is refused (`LookSetDeclined`), to a proposal and to an update.
- An update to another look's exact set is refused (`LookSetTaken`).
- At most `LOOKS_PER_PLAN_MAX` (30) looks not declined (`TooManyLooks`). "Not for me" frees a place. Reconsider takes one back, counted in `reactToLooks`' read under the lock: past the cap the whole call is refused and nothing moves.
- Two garments of one role are allowed, as in an outfit. So is a look of closet pieces only.

**Reads.** `looksOfPlan` is one statement. Each slot's state is derived, never stored (`lookSlotState`):

- `owned`: in the closet. A bought candidate counts.
- `to-buy`: a current candidate.
- `missing`, with a reason: `removed` (the slot emptied), `archived`, or `not-a-candidate` (unlinked, or its item deleted or declined).

`missingPieces` lists the missing slots with their role. `complete` means every slot is owned, the gate for #292.

**The duplicate** copies every look (reaction, notes, slots as they stand, emptied ones included) after the candidates. A declined look's set is remembered in the copy, and a valid piece stays valid. It costs one more read, plus two inserts when there are looks.

`test/integration/plan-looks.spec.ts` covers every refusal, the derived states, the duplicate, the delete and two interleavings: a proposal waiting on a decline, and a garment delete waiting on a proposal.
