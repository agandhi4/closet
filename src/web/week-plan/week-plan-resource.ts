import { type Static, Type } from '@sinclair/typebox';
import type { WeekPlanRow } from './queries';

/**
 * The changes feed's "Plan my week" batch (#196b-2, GET /changes): what
 * DELETE /week-plans/{id} undoes. Its entries' targets (the forecast each
 * was planned for) are left out: the daily re-plan's own input, which no
 * API answer carries.
 */
export const SyncedWeekPlan = Type.Object(
  {
    id: Type.Integer(),
    createdAt: Type.String({ format: 'date-time' }),
    entries: Type.Array(
      Type.Object(
        {
          entryId: Type.Integer(),
          outfitCreated: Type.Boolean({
            description:
              'The planner made its outfit: undoing the entry removes it too, once nothing else holds it',
          }),
        },
        { title: 'SyncedWeekPlanEntry' },
      ),
      {
        description:
          'The calendar entries it planned and still has (an entry deleted leaves it); one taken over since is `plannedBy: user`, which Undo keeps',
      },
    ),
  },
  {
    title: 'SyncedWeekPlan',
    description: 'One tap of Plan my week: the entries it planned',
  },
);

export function toSyncedWeekPlan(
  row: WeekPlanRow,
): Static<typeof SyncedWeekPlan> {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    entries: row.entries,
  };
}
