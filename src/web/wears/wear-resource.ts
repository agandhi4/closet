import { type Static, Type } from '@sinclair/typebox';
import { withoutNulls } from '../api/resource';
import { IsoDateSchema } from '../schemas';
import type { WearRow } from './queries';

/**
 * A wear as the changes feed carries it (#196b-1, GET /changes): the
 * owner's record that a garment was worn on a day. A garment's counts
 * (worn, since its wash, last worn) are the client's to derive from these
 * and the garment's `care.lastWashedOn`: a wear never moves the garment's
 * revision (decisions 2026-11-13, the feed's garment).
 */
export const SyncedWear = Type.Object(
  {
    id: Type.Integer(),
    garmentId: Type.Integer(),
    day: IsoDateSchema,
    /** The calendar entry it was logged from; absent for a garment's own "Wore today". */
    calendarEntryId: Type.Optional(Type.Integer()),
  },
  {
    title: 'SyncedWear',
    description:
      "A garment worn on a day: the owner's own record, never a grantee's to read",
  },
);

export function toSyncedWear(wear: WearRow): Static<typeof SyncedWear> {
  return withoutNulls({
    id: wear.id,
    garmentId: wear.garmentId,
    day: wear.day,
    calendarEntryId: wear.outfitCalendarId,
  });
}
