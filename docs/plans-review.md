# Wardrobe plans: the review and what each page reads

The detail behind `src/web/plans/CLAUDE.md`'s review bullets (#271, #278, epic #268), the plan page's layout (#295) and its statement counts (#167). The rules live in code: atop `src/wardrobe/plan-review.ts` (the machine) and `src/web/plans/review.ts` (the review post).

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

## The plan page as a lookbook (#295)

The owner read the first production draft as "a flat list" with no photos and no way to tell what each thing was. `plan-page.tsx` (`planSections`) now draws the plan the way the Wardrobe's grid draws garments.

- **Sections by role, top to toe**: `topToToe` (`src/wardrobe/generator.ts`, over `categoryRole` and `OUTFIT_ORDER`, custom categories last as Other; the packing list and the review use it too), each headed "Shoes · 2" (`roleGroupLabel`, the shared plural `roles` strings).
- **The status is a chip, not a grouping**: To review, With your agent, To buy, "1 of 2", Owned. Grouping by status as well split each category into up to five places at 390 px, and what the owner asked first was what each thing is. Within a section: proposals, revise, missing, partly, owned, then `byPriority`. Declined items sit apart at the end with Reconsider.
- **A card** (`#plan-item-<id>`, `data-status`): the photo on the plinth (4:5, `object-contain`), which is the first fulfilling closet garment with one, else, while still to buy, the best-ranked candidate with one (`rankCandidates`, the shopping list's order), else the garment glyph (`HangerIcon`; the app has no per-category icons). Its alt names what it shows. Then the item's title (a stretched link to its edit form), budget and priority, the options (the other candidates as 32 px thumbs, at most three, and "3 options" to the candidates page; "No options yet" and Add a product), what in the closet fulfils it, why it is short (not "nothing fits", which the chip says), the owner's note, and the review moves (Accept, Don't buy, Change this…).
- **Proposals** are counted in a banner with Review (`#plan-review`). No statement was added: the page already read the candidates.

## The review page and "Accept these"

**The page** (`GET /wardrobe/plans/:id/review`) has a snap strip (`src/web/strip/`) per proposal.

- **Order.** Strips run top to toe (`OUTFIT_ORDER`, custom categories last), then `byPriority`, under a heading per role with its count (`#review-role-<role>`, #295).
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
- **The style page is 2 statements** (#251; `plans.spec.ts`): the session, then one `selectScalars` of `styleProfileSql`, `weekTemplateSql` and, with the weather on, `homeNameSql`.
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
- **Above the list**, the totals. ("Style with my closet", `/styling?plan=`, went with #335: Styling's own Include picks toggle replaced it.)
- **Shared parts** with the review: `candidate-tile.tsx` (`TILE`, `PLINTH`, `DETAILS`, `CandidateFace`, `PriceLine`). The wiring is the review's inline module, rooted on `#shopping-list`.

## Candidate research (#293, epic #289)

The agent says why it chose each option and which it recommends. `plan_item_candidate` gains `note` (text, at most `CANDIDATE_NOTE_MAX` 240 characters: a tile is 7 rem wide and the neighbours reserve the centred tile's height, so a long note makes the whole strip tall; non-blank by check) and `rank` (smallint, 1 to 5 by check, the cap). `drizzle/0038_candidate-research.sql` adds the two columns and both checks; both are nullable, so the rollback is dropping them (`ALTER TABLE ... DROP COLUMN`) and nothing else reads them.

- **One writer.** `changeCandidates` carries the research: an `add` set takes `research` (a map by garment), and `update` sets the research of existing links (a field left out stays, `null` clears it; one statement; `updated` counts the links found). Both run under the owner lock; an update on a declined item throws `CandidateForDeclinedItem`, and only wishlist garments of the owner's are found (a bought candidate is not a "current candidate"). A pairing that exists keeps its research when added again, so `add_candidate` answers 409 (`update_candidate`) when it is given a note or rank for a link that is there.
- **Ties.** Ranks are not unique per item: two options may both be rank 1 (the order below breaks the tie, both get the badge). A unique index would make swapping two ranks fail halfway.
- **Order.** `candidateRows` reads the ranked ones first (`rank asc nulls last`), and `rankCandidates` (the shopping list, the review and the plan page's cards) puts rank before fit, budget and price, so every strip opens on the pick. Unranked candidates keep the existing order.
- **Tiles.** `CandidateNote` under the price (wrapped, never cut; `data-candidate-note`) and `AgentsPick` under the name of a rank 1 candidate (`data-agents-pick`, `plans.AGENTS_PICK`); the plan page's card shows the badge over its photo whenever the item holds a rank 1 candidate. `test/plan-review.spec.ts` checks a 240 character note with an unbreakable word at 390 px.
- **MCP.** `add_candidate` and `add_garment_from_link` (`candidateNote`, `candidateRank`, with `planItemId`) write the research; `update_candidate` changes it; `candidateOut` returns `note` and `rank` to `get_plan_gaps`, `get_shopping_list` and `get_plan_feedback` (whose items now list their `candidates`; no statement added). The duplicate copies the research with the links. The owner's own adds (the pickers, the wishlist item's plan list) carry none. `test/integration/candidate-research.spec.ts`.

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

**The agent's tools** (`src/web/mcp/tools/looks.ts`, `look-out.ts`; `test/integration/mcp-looks.spec.ts`; plans are the caller's own, so another user's plan or look is a 404). They call the writers above and nothing else, and pass their refusals through as tool errors.

- `list_looks` (read): the plan's looks by occasion (`OCCASIONS` order, none last), each with its slots top to toe (`garmentId`, `name`, `role`, `state` owned / to-buy / missing, and `reason` when missing), `reaction`, `ownerNote`, `missingPieces` (role, category, reason) and `complete`. 3 statements.
- `propose_look` (WRITES): `planId?`, `name`, `occasion?`, `note?`, `garmentIds` (2 to 20). Answers `{ id, planId, reaction: 'proposed', alreadyProposed }`. A given `planId` costs no plan read (the writer answers a missing plan); an omitted one reads the active plan. 8 statements.
- `update_look` (WRITES): `lookId`, and any of `name`, `occasion` / `note` (null clears), `garmentIds` (the whole new set). Answers `{ id, planId, reaction, from }`: always `proposed`, from `revise` or `loved` this is the repropose. 6 statements.
- `get_plan_feedback` gains `looks: { revise, declined, incomplete }`, each entry in `list_looks`' shape: a declined look's slots are the exact set never to propose again, and `incomplete` is every look not declined with a missing slot (a candidate rejected or deleted empties its slot). One more statement (5).
- `INSTRUCTIONS` step 7 and the iteration paragraph tell the agent to propose a few looks per occasion of the week with every candidate in at least one look, to change `revise` looks, mend `incomplete` ones and never re-propose a declined set. The README's "Styling with an agent" follows.

`test/integration/plan-looks.spec.ts` covers every refusal, the derived states, the duplicate, the delete and two interleavings: a proposal waiting on a decline, and a garment delete waiting on a proposal.

### Looks in the app (#291)

`look-tile.tsx` holds what both pages share: `LooksStrip` (a heading, a hint and a snap strip of `card` tiles, 224 px), `LookFace` and `LooksApart`. `groupLooks` (`looks.ts`) splits a plan's looks into the strip (loved first, then proposed, each oldest first), `revise` and `declined`.

- **A tile.** The `OutfitCollage` in its `look` size: a 4:5 frame, so every tile of a strip is the same height. A piece to buy wears Styling's "To buy" badge. A missing slot is a dashed place in its role's position (`CollagePieceView.mark`; a `thumb` collage marks without words). Then the reaction chip, the name, the occasion with "1 to buy" and "1 piece missing", the agent's note and the owner's note. What a tile offers sits in `DETAILS`: it is invisible on the neighbours, which keep its space, so the strip does not jump and only the centred tile's controls can be reached. The strip is not a listbox, because its tiles hold controls (the shopping list's rule).
- **Looks first on both pages.** They are the most visual thing a plan has (the owner's ask in #295), and one strip costs one row.
- **The review page.** The form shows when there are proposed items or looks to react to. A page of looks alone posts no `shown`. Each tile posts:
  - its `look` id;
  - its `lookNote`, paired with `look` by order, as item notes pair with `shown`;
  - its reaction, a radio group of its own named `look-<id>`. Radios group by name, so the body schema is a `Type.Intersect` with a `Type.Record` over the `look-${number}` template. The values are Love it, Change this…, Not for me, and `''` for Clear, which shows only once a reaction is checked. A loved look is not offered Love it.

  A post whose notes do not pair with its looks, or that names a look twice, is a mismatch: the page as it stands, 400. Change this without a note is the page as posted, 400, with the marked look centred. Nothing is written in either case.
- **`applyReview` reacts inside its own transaction.** It makes one `reactToLooks` per reaction chosen, naming only the looks the strip drew. So a look the agent proposed after the GET waits for the next review, and a look left alone keeps its reaction. A look whose reaction moved meanwhile takes only what the machine allows and is logged. A look deletes and unlinks nothing.
- **The plan page.** The centred tile's moves are small native posts: `POST /wardrobe/plans/:id/looks/:lookId/love|decline|reconsider`, and Change this… on its own form (`GET|POST .../change`, `ChangeLookPage`, the item's `NoteForm`). A refused move is a 409 (`plans.looks.ALREADY_MOVED`). A look that is not the plan's is a 404, after the plan's own 404. Revise looks are listed apart with "Love it as it is" and Not for me; declined ones with Reconsider.
- **Statements.** The review page reads 5 (the looks were added) and the plan page reads 6, `looksOfPlan` each.

`test/integration/plan-look-reactions.spec.ts` covers the pages' HTML, the post's pinning and its refusals, and the plan page's posts. The matrix rows are in `authorization-plans.spec.ts`. `test/plan-looks.spec.ts` runs the flow at 390 px: swipe, Love one, Change another with a note, Accept, then the grouping.

### Looks become outfits (#292)

A look whose every piece is owned becomes an outfit by the owner's tap, never an agent's: no tool saves a look. `drizzle/0039_plan-look-outfit.sql` adds `plan_look.outfit_id` (nullable, `ON DELETE SET NULL`, `plan_look_outfit_id_index`); the rollback is dropping the column, which nothing else reads.

- **The gate** is `lookSaveState` (pure, `looks.ts`): `saved` once `outfit_id` is set, whatever the pieces are now; `saveable` when every slot's garment is in the closet (none to buy or missing) and the look is not declined, so a `revise` look is saveable as it is; else `not-yet`. `looksOfPlan` reads `outfitId` in its own statement.
- **The writer** is `saveLookAsOutfit`, one owner transaction. It reads the look (`looksOfPlan`), answers its outfit when it is saved already (before any other judgement, so a second tap after an archive still lands there), refuses a declined look or an incomplete one (`LookIncomplete`, 409, naming the pieces to buy), then calls **`createOutfit`**, the one writer of outfits, unchanged: the look's slots by position as `{ category, garmentId }`, the look's name, its agent's note as the notes, no calendar entry. Then it links the look. Eight statements with the session (`look-outfits.spec.ts`).
- **Idempotent three ways**: the form submits once; under the owner lock a second post waits and finds the link (an interleave spec); `createOutfit`'s once per garment set answers an outfit the owner already has of these pieces, which keeps its own name (outfit names are not unique, so a new outfit takes the look's name as it is).
- **The route** is `POST /wardrobe/plans/:id/looks/:lookId/save`, a 303 to the outfit, with `?alreadySaved=1` when nothing was created. A look not of the owner's plan is the plan's 404, then the look's.
- **Where it shows** (`LookSaveAction`, `look-tile.tsx`, a `PostForm` with `needsNetwork`; or "Saved as outfit" linking the outfit): the plan page's strip, its revise list and its declined list (the link only). The review page has a read-only chip (`LookSaveChip`: Ready to save, Saved as outfit), because a post or a link there would lose the swipes made so far.
- **After Bought it.** The post is a 303 to the garment page with `?bought=1`, so `buyCandidate` stays as it was and the page derives what the purchase completed: `looksWithGarmentSql`, one more column of `garmentContext`'s one statement, read only for the owner, a closet garment and `?bought=1`, judged by `boughtLooks` with `lookSaveState`. Right after the purchase, a look holding the garment that is now saveable is exactly one the purchase completed (the garment was its piece to buy). `CompletedLooks` lists them first on the page.
- **The link** is the plan owner's outfit by the writer's rule. The outfit's delete clears it and the look offers Save again. An agent's `update_look` with a new set of pieces clears it in its own update, and a name, note or occasion edit keeps it; neither ever changes the outfit. The owner's reactions and outfit edits keep it, and so does a piece archived or deleted later (the outfit keeps or empties its slot by its own rules). The duplicate copies it. **A look is not a holder of its outfit** (`outfitIsHeld`, owner decision): the link is `SET NULL`, so nothing is lost when the outfit goes, and looks stay out of the outfit-deletion and week-planner rules.
- **"In N looks"** (`candidate-tile.tsx`, `InLooks`): every tile of the review and shopping strips says how many looks of its item's plan hold the candidate, declined ones aside, and how many are loved ("In 3 looks, 2 loved"). It is a correlated column of `candidateRows` (`lookCountSql`, over `plan_look_slot_garment_id_index`), so no page or tool gains a statement; the strip's order is unchanged.
- **MCP.** `list_looks` and `get_plan_feedback`'s looks carry `outfitId` (no statement added); `INSTRUCTIONS` says `update_look` never changes that outfit.
