# The garment model

## Layout

```
  wardrobe/            The garment model, pure (no database, web or strings): properties.ts owns the
                       built-in categories, each category's role in an outfit (categoryRole), every
                       property's value set (schema.ts builds the check constraints from them), which
                       properties each role has (propertyApplies), the types per category with their
                       presets and weight steps, and applyPresets. See Wardrobe, Properties.
                       availability.ts: the wash and copies rules, away reasons and isAvailable
                       (the generator-facing rule). See Wears and washes.
                       status.ts: the garment status state machine (wishlist, closet, archived;
                       garmentStatusTransition, pure). See Wishlist
                       occasions.ts: a calendar entry's occasions, their order, weather window and
                       formality hint (#14's weather and #9's generator read them). See Calendar
                       generator.ts: the outfit generator (templates, rotation, colour rules, avoided
                       pairs, the weather and formality score; seeded, paged). See Outfit gallery
                       plans.ts: wardrobe plans' matching (matchPlan, targetDifferences,
                       fitTargetTo), comparing two plans (comparePlans) and "start from a
                       wardrobe" (planItemsFromWardrobe), pure; shopping.ts: the shopping list
                       and its totals (shoppingList, shoppingTotals, money in cents), pure;
                       style.ts: the style profile's value sets; plan-review.ts: a plan
                       item's review state machine (proposed, accepted, revise, declined;
                       planItemReviewTransition, pure, #278); look-reaction.ts: a plan
                       look's reaction machine (lookReactionTransition, pure, #290). See
                       Wardrobe plans
                       week.ts: the week template (weekdays, their occasions, the derived
                       rhythm) and planned_by; week-planner.ts: "Plan my week" and the
                       re-plan's judgement (planWeek, replanWeek), pure. See Weekly auto-plan
                       measurements.ts: body measurements, lengths in cm and the unit
                       they are read in; brands.ts: brandKey, the one brand comparison
                       (insights, sizes). See Sizes
                       insights.ts: every insights figure from the closet's rows
                       (wardrobeInsights), pure; recap.ts: the year in review
                       (yearRecap) from the same rows over a year, pure. See Insights
                       packing.ts: a trip's packing list (the copies-needed rule,
                       the warnings, tripPhase), pure. See Trips
                       care.ts: the care label's value sets, its presets from the
                       materials (carePresetsFor, applyCarePresets), the repair
                       kinds. See Wardrobe, care-and-repairs.md
```

## Gotchas

- **The generator's output is pinned** (`generator-output.spec.ts`, #168): exact ideas, order, scores and `more` for seeded closets. A change for speed must pass it unchanged; one that changes it on purpose bumps `GENERATOR_VERSION` and re-pins. Its early stops (`generator-draws.spec.ts`) are sound only because the colour, pattern and clash rules never pass once they fail (adding a garment cannot mend them), the formality score is a sum over garments and the weather's is never negative (`scoreFloor`), and every base has a draw weight above 0. A rule that adding a garment could mend goes in `passes`, not `compatible` (the saved-outfit rule: a layer changes the combination); a score part that could go negative or stop adding up breaks the floor.

- **Adding an occasion is a migration.** `outfit_calendar_occasion_check`, `week_template_occasion_check` and `trip_outfit_occasion_check` list `src/wardrobe/occasions.ts`'s `OCCASIONS`, so a new one fails every insert until `npx drizzle-kit generate` recreates the constraint; add its `occasion.<value>` string (a missing one is a type error). The display order is the array's order: reordering it is code only.
- **Adding a property value, a garment type, a colour or a style is a migration.** The check constraints (`garment`'s, and `plan_item`'s and `style_profile`'s, #34) list `src/wardrobe/properties.ts`'s, `care.ts`' and `style.ts`'s sets, so a new value there fails every insert until `npx drizzle-kit generate` recreates the constraint; add its `property.<name>.<value>` string too (`labels.spec.ts` fails without it). Removing a value needs a data step for rows that hold it.
