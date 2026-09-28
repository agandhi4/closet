# Generator rules (2026-09-28)

Issue #21: rules the outfit generator obeys, "never pair X with Y" and "always X with Y". Seen in
Smart Closet. **Owner direction (2026-09-28):** a useful power-user feature, but it must not
overwhelm people. This is the plan only. The build waits, and the issue stays unscheduled.

**What already exists.** #9's "Clashes" is a garment-level "never" rule. It is the `generator_avoid`
table, which the "Not this" menu on an Idea card writes. Its undo is "Never paired with" on the garment
page, and `generateIdeas` treats it as a hard rule. This plan extends that one mechanism. It does not
add a second one beside it.

## 1. Complexity budget

**The smallest version worth having** is three pair rules, all private to the owner:

| Rule | Names | Example | Status |
| --- | --- | --- | --- |
| Never together | two garments | this red shirt, these green chinos | exists (#9); gains two more places to set it |
| Never together, any of a kind | two garment types (#12) | shorts, blazer | new |
| Always with | one garment and its partner (directional) | this skirt, these black boots | new |

Every rule is a pair. There is no list for the user to author, and no page that has to be visited
before the feature does anything.

**Deliberately excluded:**

- a rule language, boolean combinations, or rules over more than two things;
- conditions: weather, occasion, season, day of week, or capsule ("never in winter", "always for work");
- weights, priorities, "prefer" or "sometimes", and soft rules of any kind. A rule is binary;
- conflict resolution UIs and precedence between rules. Every rule applies (see section 3);
- per-grantee rules, and rules on a shared wardrobe;
- category-level rules. For drawn garments a category *is* a role: "never tops with bottoms" kills a
  whole template, and custom categories are never drawn at all;
- colour rules ("never navy with black"). The generator's colour rule stays the only colour rule
  (open question 3);
- rules that extend to near-duplicates (below), rules on accessories, bags or `none`, and rules that
  name a wishlist item;
- a "Rules" settings page as the way in, and rules at onboarding or in any empty state.

## 2. Data model

- **Never, garment-level:** `generator_avoid`, unchanged: (owner, garment a < garment b), cascading.
- **Never, kind-level:** a new table `generator_avoid_type` with columns (owner, type a < type b).
  Types are #12's fixed per-category lists (`GARMENT_TYPES`) and are validated by the same check list
  as `garment.type` (`ALL_GARMENT_TYPES`). So a type added later lands in both checks through one
  drizzle-kit migration.
  - Only types of drawn categories are accepted: tops, bottoms, dresses, outerwear and footwear.
  - The type must be different on each side: an outfit never holds two garments of one drawn role
    except a top and a layer, which are different types anyway.
  - The rule keys on the type value alone. A value that ever appears under two categories means the
    same kind in both.
- **Always:** a new table `generator_always` with columns (owner, garment, partner). It is
  directional: "the skirt always with these boots" says nothing about the boots. Several partners of
  one role mean "one of these".
  - The write refuses a pair that could never share an outfit: the same garment, the same role, a
    one-piece with a top or bottom, or a role that is not drawn.
  - Both garments must be the owner's, owned now or once, as `avoidPair` requires.

**Why garment-level and type-level, not category-level.** The garment is the level where the
annoyance happens: this shirt with those trousers. The type is the level the owner means when a
garment pair keeps recurring with its siblings, as in "no shorts with a blazer". Types are what the
garment form already asks (#12), and they come prefilled by link import and tagging mode. A category is
too coarse, as said above. An untyped garment is simply never covered by a kind rule. That is a
reason to tag it, not a reason to guess its kind.

**Copies and near-duplicates (#20, #18b).** A rule follows the garment row, so it covers every copy
(`quantity`). This is one more reason "add a copy" beats a second row. A separately catalogued lookalike
(`nearDuplicates`) is not covered: a rule names what it names, and silently widening it would surprise
the owner. The kind rule is the tool for "all of these".

**One reader, one type.** `pairingRules(db, ownerId)` replaces the avoided pairs (`avoidedPairsSql`) at every call site:
`ideasFor`, `goesWithCloset` and `outfitCount`, and `readWeek` (the planner and the re-plan). It returns
`PairingRules { never, neverTypes, always }`, which replaces `IdeaRequest.avoid` and `WeekContext.avoid`.
So no caller can forget a rule kind. `IdeaGarment` gains `type`, which `ideaPool`, `weekPool`,
`closetGarmentsSql` and `goesWithInputsSql` select.

**Conflicts without a UI.** The same garment pair cannot be both "never" and "always". Setting one
removes the other in the same transaction, so the newest rule wins, and the log says so. Every other
combination simply applies together as filters.

## 3. Where rules take effect

**A rule is a filter on draws, in `generateIdeas` only** (`src/wardrobe/rules.ts`, pure, called from
`hardRules` and the drawer):

- **Never (either kind):** a base, or a base with its layer option, that holds the pair is rejected,
  as `generator_avoid` is rejected today.
- **Always:** a base that holds the anchor, plus a garment of a partner's role that is not one of the
  anchor's partners, is rejected. A role the idea does not have is not a breach: without a layer the
  cardigan rule is silent. So "always" never forces a layer the weather did not ask for, and never
  adds a role.
  - **Steering:** once the drawer has drawn the anchor, it draws that role from the anchor's
    available partners. Without this, the filter alone would reject most draws holding the anchor and
    quietly starve it out of the rotation.
  - Steering only changes the draw sequence for owners who have an always rule. `GENERATOR_VERSION`
    is not bumped: everyone else's seeds, pages and planned weeks stay the same.

**Degrading gracefully:**

- **A lock beats a rule.** A rule whose garments in the idea are all locked is skipped. The user chose
  them explicitly: Styling's rows, `?with=`, and "Style this". Today, two locked garments that the owner
  once avoided make Shuffle find nothing. With this plan, they ride along. This is the one change to
  #9's behaviour (open question 5).
- **An always rule never strands its anchor.** When none of the anchor's partners is drawable (dirty,
  away, or outside the capsule), an unlocked anchor sits out of this request. A locked anchor keeps
  its lock and the rule sits out. The rest of the closet is unaffected.
- **Empty is explained, never broken.** `IdeaPage` gains `ruledOut: boolean`, which is true when a
  user rule rejected at least one base.
  - When the ideas are empty or all near misses and `ruledOut` is true, the Ideas empty state, Styling's
    "nothing fits" note and Today's row say "Your pairing rules rule out some outfits" and link to the
    rules list. Otherwise, they say what they say today.
  - The week planner already has an honest empty state (`unfilled`); its log line adds `ruled out`.
- **Suggestions only.** Rules never block a manual save, a pick, Styling's Save, `schedule_outfit`, or
  an outfit that is already saved or planned.

**Entry points.** All of them get the rules for free through the one reader:

| Surface | Honours rules | Note |
| --- | --- | --- |
| Ideas tab and its strip (`ideasFor`/`ideasPage`) | yes | |
| Today's ideas (`todayIdeas`) | yes | |
| Styling's Shuffle (`ideasFor` with locks) | yes | lock beats rule |
| Trip ideas (`for=trip:`) | yes | |
| `suggest_outfits` (MCP) | yes | |
| "Goes with my closet" (#18b) | yes | kind rules match the wishlist item by its type; its count may fall |
| Week auto-plan (`planWeek`) and the daily re-plan's swaps | yes | read in `readWeek` under the owner lock |
| Shared wardrobe's Shuffle (`browseIdea`) | no | ignores the owner's clashes today; rules are private |

**The week.** "Plan my week" and every re-plan swap honour the rules. A new rule does **not** re-plan
auto entries already on the calendar: rules shape the next suggestion and never rewrite a plan
(open question 1). The person changes that day's outfit with Change, as they would anyway.

## 4. UX

**Invisible until used.** Nothing about rules appears for someone who never sets one: no page, no
menu item, no empty section. Each rule is set where the annoyance happens.

- **Never, garment-level:** the Idea card's "Not this" › Clashes pair buttons, as today. Two new places
  use the same component, extracted from `ideas-page.tsx`:
  - Today's idea cards get "Not this" (open question 6);
  - Styling gets a "Not this" menu beside Shuffle, shown only while the rows hold two or more drawn
    garments.
- **Never, kind-level (progressive disclosure):** it is offered only *after* a garment clash is set,
  and only when both garments are typed with different types. The clash answer's toast reads
  "Won't pair these again · Never any shorts with a blazer? · Undo".
  - One tap on the middle action stores the kind rule. The toast is `SavedToast`'s pattern with two
    actions.
  - The htmx answer stays a 200 that deletes the card, plus an out-of-band toast.
- **Always:** Styling's "Not this" menu gets an "Always wear together" group, shown only when a row is
  locked. It has one line per other chosen drawn garment: "Always wear Skirt with Black boots". The
  natural path is "Style this" on the skirt, which opens Styling with the skirt locked. The owner
  swipes to the boots and taps the line. On the next Shuffle, the boots come with the skirt.

**Seeing and undoing:**

- **Right away:** each set answers with a toast that has Undo.
- **On the garment page:** "Never paired with" becomes **"Pairing"**. It has the garment's never
  pairs, its always partners ("Always with Black boots"), the anchors it is a partner of ("Skirt is
  always worn with this"), and the kind rules on its type ("Never with a blazer · all shorts"). Each
  row has a remove button. The section shows, for the owner, only when one of these exists.
- **All in one place:** the style profile (`/auth/profile/style`) gets a "Pairing rules" section
  listing every rule, grouped by kind, with remove buttons. It shows only when at least one rule
  exists, and it is where the "ruled out" notes link to. It has no create form: rules are born
  in context.

**Routes** (gallery plugin, a native `PostForm` or htmx each, 303 back without script):

- `POST /outfits/ideas/avoid` and `/allow` stay as they are;
- `POST /outfits/rules/never-type` and `/allow-type` take `typeA` and `typeB`. A type outside the drawn
  categories' lists is a 400;
- `POST /outfits/rules/always` and `/always/remove` take `garmentId` and `partnerId`. A garment that is
  not the owner's is a 404, and a pair that could never share an outfit is a 400.

Every write is `data-needs-network`. Rules are owner-only, like outfits: no `?ownerId=`, and a grantee
gets a 404.

**Logs** (context `Web`, beside today's avoid lines):

- `Pairing rule <kind> added|removed|already by user <id>: <a> <b>`;
- `... replaced <other kind>` for the newest-wins case;
- the generation debug line adds `ruledOut`.

## 5. MCP

Rules reach `suggest_outfits`, `plan_week` and `goes_with_closet` without any change. Plain language
is the one rule interface this plan does not exclude, and Claude is where the owner would say "stop
suggesting shorts with a blazer". So there are two tools, owner-only through the token:

- `list_pairing_rules` (read): every rule, garments with their names and ids;
- `set_pairing_rule`: `action` add|remove, `kind` never|never-type|always, and the two ids or the two
  types. It goes through the web's writers. Its description says to set a rule only when the owner
  asks for one.

`get_style_profile` does not grow: rules are not style facts.

## 6. Migration, tests, open questions

**Migration shape** (the number is assigned at build time; generated by drizzle-kit from
`src/db/schema.ts`):

- `generator_avoid_type`:
  - columns: `owner_id` (FK to user, cascade), `type_a` text, `type_b` text, and `created_at`;
  - primary key `(owner_id, type_a, type_b)`;
  - checks: `type_a < type_b`, and both columns in `ALL_GARMENT_TYPES`.
- `generator_always`:
  - columns: `owner_id` (FK, cascade), `garment_id`, `partner_id` (both FK to garment, cascade), and
    `created_at`;
  - primary key `(owner_id, garment_id, partner_id)`;
  - check `garment_id <> partner_id`;
  - an index on `partner_id` (the FK, and the garment page's "is a partner of").
- No data migration. `generator_avoid` is untouched.

**Test strategy:**

- **Unit** (`rules.spec.ts`, `generator.spec.ts`):
  - each rule kind rejects exactly its pairs;
  - steering draws the anchor with a partner, and several partners mean one of them;
  - "always" is silent without its role;
  - lock beats rule;
  - an anchor without an available partner sits out, and a locked anchor keeps its lock;
  - `ruledOut`;
  - the same (pool, rules, seed, page) gives the same page, and page 1 is unchanged by reading page 3;
  - **with no rules, the ideas match today's output for fixed seeds**. This pins that
    `GENERATOR_VERSION` needs no bump.
  - pair validation (roles, one-piece versus separates, drawn types only).
- **Integration:**
  - the writers: ownership 404, refused pairs 400, idempotent `already`, and newest-wins between never
    and always on one pair;
  - one spec per entry point showing a rule honoured: the Ideas page and `/more`, Today, Shuffle,
    `suggest_outfits`, `plan_week` and a re-plan swap, and `goes_with_closet`'s count;
  - `browseIdea` ignoring rules;
  - Styling's Save and the pick unaffected;
  - the garment page's and the profile's lists;
  - matrix rows in `authorization-wardrobe.spec.ts`: a grantee can neither see nor set rules;
  - the two MCP tools.
- **E2E** (Playwright, 390 px):
  - a clash on an Idea card, then the toast's kind action, then Shuffle never showing the pair;
  - Undo;
  - Style this, the always line, then Shuffle bringing the partner;
  - the profile list removing a rule.
- **Seed:** one rule of each kind for Theo, set through the writers (demo.md), so the demo shows the
  Pairing section and `mcp-seed.spec.ts` can read them.

**Open questions for the owner:**

1. Should a new rule re-plan auto-planned entries that break it (for example, the daily re-plan
   treating "breaks a rule" like "cannot be worn")? This plan says no: rules shape future suggestions
   only.
2. "Always" is directional. For a suit (the jacket and its trousers), should Styling offer one "Always
   together" line that writes both directions, or leave that to two taps?
3. Colour-pair rules ("never navy with black") are the likely next ask. Should they stay out, or be
   the v2?
4. Kind rules cover typed garments only. Is that acceptable, given that tagging mode exists to fill
   types in?
5. "A lock beats a rule" changes #9's behaviour: two locked garments that were once marked as clashing
   will now Shuffle instead of finding nothing. Agree?
6. Today's idea cards get the "Not this" menu. Today has been kept lean, so should it stay without one?
