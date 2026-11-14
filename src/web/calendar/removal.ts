import type { PlannedBy } from '../../wardrobe/week';

/** What decides whether removing a calendar entry may go unasked. */
export interface RemovalFacts {
  worn: boolean;
  plannedBy: PlannedBy;
  /** Removing the entry also prunes the one-off outfit it created (#748). */
  takesOutfit: boolean;
}

/**
 * Removing an entry is asked first (the confirm sheet) when Undo could not
 * put it back exactly (#686): a worn entry takes its wears and selfie, an
 * agent's choice carries a token the restore does not rewrite, and a one-off
 * outfit the entry created is pruned with it.
 *
 * The one rule: the server applies it to the row it deletes (deleteEntry,
 * the decision) and the row's menu to the entry it drew (the hint, so a tap
 * asks only where it must). They agree unless the page is stale.
 */
export function removalAsksFirst(facts: RemovalFacts): boolean {
  return facts.worn || facts.plannedBy === 'agent' || facts.takesOutfit;
}
