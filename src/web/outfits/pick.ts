import type { Queryable } from '../../db/client';
import type { IsoDate } from '../../calendar-date';
import type { Occasion } from '../../wardrobe/occasions';
import type { PlannedBy } from '../../wardrobe/week';
import { ownerTransaction } from '../auth/queries';
import type { ScheduleOutcome } from '../calendar/queries';
import { inOutfitOrderByCategory } from '../../wardrobe/generator';
import { ideaName } from '../gallery/ideas';
import { pickedGarments } from '../gallery/queries';
import { type CreateResult, createOutfit, reuseOutfit } from './queries';

export interface PickResult {
  id: number;
  name: string | null;
  /** The garments were already an outfit of the owner's: it was reused, nothing was created. */
  alreadySaved: boolean;
  /** That outfit was one of Muse's proposals, which this pick made the owner's (#335). */
  adoptedProposal: boolean;
  /**
   * The person's pick took over what the week planner had made of it: the
   * reused outfit (no longer the planner's to remove) or the entry on the
   * destination's day (now `user`). False for the planner's own picks.
   */
  adopted: boolean;
  /** With a destination: whether the entry is new or was already on the day. */
  schedule?: ScheduleOutcome;
}

/**
 * Picks an idea, once: the garments must all be the owner's and in the
 * closet (else 'not-found' and nothing is written: a card from before a
 * garment was archived or deleted). If an outfit of the owner's already has
 * exactly these garments, it is the answer (`alreadySaved`), planned on the
 * destination's day when given (an outfit is on a day once, so a second
 * plan changes nothing); otherwise the outfit (named by ideaName unless
 * `name` is given), its slots top to toe and the calendar entry are created
 * (createOutfit, the one writer of new outfits: once per garment set, #219).
 * A person's pick (not `plannedBy: 'auto'`) that reuses an outfit the week
 * planner created takes it over (reuseOutfit's adoptPlannerOutfit, #77):
 * "Already saved" is then true for good, and Undo or the re-plan never
 * delete it; planning it on a day where the planner has it takes that
 * entry over too (insertEntry). All in one transaction under the owner
 * lock, so a double tap, a retried post or a retried pick_outfit never
 * makes a second outfit: the second pick waits for the first to commit and
 * finds its outfit. The garments stay locked (pickedGarments, FOR SHARE)
 * until the outfit is saved, so one archived or deleted meanwhile is
 * either refused here or waits for the pick. Called by the gallery's pick, the MCP tool pick_outfit,
 * Today's "Wear this" and the week planner (#16, src/web/week-plan/plan.ts,
 * inside its own locked transaction); takes a Queryable so a spec can hold
 * a pick's transaction open.
 */
export function pickIdea(
  db: Queryable,
  ownerId: number,
  input: {
    garmentIds: readonly number[];
    /** plannedBy 'auto': the week planner's pick (#16); the person's otherwise. */
    plan?: { day: IsoDate; occasion: Occasion; plannedBy?: PlannedBy };
    name?: string;
  },
): Promise<PickResult | 'not-found'> {
  const wanted = [...new Set(input.garmentIds)];
  return ownerTransaction(db, ownerId, 'pickIdea', async (tx) => {
    const { garments: found, existing } = await pickedGarments(
      tx,
      ownerId,
      wanted,
    );
    if (found.length !== wanted.length) return 'not-found';
    if (existing)
      return pickResult(await reuseOutfit(tx, ownerId, existing, input.plan));
    const byId = new Map(found.map((g) => [g.id, g]));
    const garments = inOutfitOrderByCategory(wanted.map((id) => byId.get(id)!));
    const name = input.name ?? ideaName(garments);
    // createOutfit asks again in its insert (a no-op here, under the lock).
    const saved = await createOutfit(tx, ownerId, {
      name,
      notes: null,
      slots: garments.map((g) => ({ category: g.category, garmentId: g.id })),
      plan: input.plan,
    });
    return pickResult(saved);
  });
}

function pickResult(saved: CreateResult): PickResult {
  const { id, name, alreadySaved, adoptedProposal, adopted, schedule } = saved;
  return { id, name, alreadySaved, adoptedProposal, adopted, schedule };
}
