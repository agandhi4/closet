import type { StatusUndo } from '../announce';
import { t } from '../i18n';
import type { IsoDate } from '../../calendar-date';
import type { CalendarEntry } from './calendar-view';
import type { DeletedEntry } from './queries';
import { CALENDAR_RESTORE_PATH } from './urls';

/**
 * Removing a calendar entry is reversible (#686) when putting it back
 * restores it exactly: nothing but the row went. A worn entry takes its
 * wears and selfie, a one-off outfit (the planner's, an idea's: the row
 * shows its collage, not a name) is pruned with it (#748), and an agent's
 * choice carries a token the restore does not rewrite. Those are asked
 * first, by the row's confirm sheet; the rest act at once and the toast
 * offers Undo. The row decides before the tap (this), the server after the
 * delete (`restorable`): a page gone stale can disagree, never lose more
 * than the sheet said.
 */
export function removalIsReversible(
  entry: Pick<CalendarEntry, 'worn' | 'plannedBy' | 'outfit'>,
): boolean {
  return !entry.worn && entry.outfit.kept && entry.plannedBy !== 'agent';
}

/** The Undo for a delete that took nothing else with it (POST /calendar/restore). */
export function restorable(
  removed: DeletedEntry,
  week: IsoDate | undefined,
): StatusUndo | undefined {
  const { entry } = removed;
  if (entry.worn || removed.oneOffRemoved !== null) return undefined;
  if (entry.plannedBy === 'agent') return undefined;
  return {
    label: t('UNDO'),
    action: CALENDAR_RESTORE_PATH,
    fields: {
      date: entry.day,
      outfitId: String(entry.outfitId),
      occasion: entry.occasion,
      plannedBy: entry.plannedBy,
      ...(week && { week }),
    },
  };
}
