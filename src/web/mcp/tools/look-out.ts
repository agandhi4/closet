import { OCCASIONS } from '../../../wardrobe/occasions';
import type { PlanLookView } from '../../plans/looks';

/**
 * A plan look as the agent reads it (list_looks, and get_plan_feedback's
 * looks): its slots top to toe, each owned (in the closet), to-buy (a
 * current candidate) or missing with the reason; never a photo. A declined
 * look carries the exact set to avoid.
 */
export function lookOut(look: PlanLookView) {
  return {
    id: look.id,
    planId: look.planId,
    name: look.name,
    occasion: look.occasion,
    note: look.note,
    reaction: look.reaction,
    ownerNote: look.ownerNote,
    slots: look.slots.map((slot) => ({
      garmentId: slot.garmentId,
      name: slot.name,
      role: slot.role,
      state: slot.state,
      ...(slot.state === 'missing' ? { reason: slot.reason } : {}),
    })),
    missingPieces: look.missingPieces.map((slot) => ({
      role: slot.role,
      category: slot.category,
      reason: slot.reason,
    })),
    complete: look.complete,
    // The owner's outfit once they saved the look (#292); never changed by
    // update_look, which only clears this when the pieces change.
    outfitId: look.outfitId,
  };
}

/** By occasion in the calendar's order (none last), then oldest first. */
export function byOccasion(looks: readonly PlanLookView[]): PlanLookView[] {
  const rank = (look: PlanLookView) =>
    look.occasion === null
      ? OCCASIONS.length
      : OCCASIONS.indexOf(look.occasion);
  return [...looks].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}
