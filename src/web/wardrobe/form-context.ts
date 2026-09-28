import type { Db } from '../../db/client';
import { selectScalars } from '../../db/select-scalars';
import {
  type PendingPhoto,
  pendingPhotoSql,
  type PendingScope,
  readPendingPhoto,
} from '../files/pending-photos';
import { type BrandSize, brandSizeSql } from '../sizes/queries';
import {
  type ReplaceableGarment,
  replaceableGarmentsSql,
} from '../wishlist/queries';
import {
  type ClosetLookalike,
  closetLookalikesSql,
  type LookalikeFields,
  readClosetLookalikes,
} from './lookalikes';
import { wardrobeCategoriesSql } from './queries';
import { type RepairEntry, repairLogSql } from './repairs';

/**
 * What a garment form reads, each part only where the form shows it
 * (render-form.tsx decides which, from the form's mode and audience):
 * - `categories`: the category suggestions, the landing wardrobe's own;
 * - `replaceable`: a wishlist form's "Replaces" choices, and the one an
 *   edited item names (`chosen`);
 * - `brandSize`: the requester's note on the form's brand (#24), on their
 *   own wardrobe only (the notes are their body);
 * - `lookalikes`: the duplicate check (#20), for a form that adds to the
 *   closet, over the values it opens with;
 * - `repairs`: the edit page's repair editor's log, the owner's alone;
 * - `pending`: the pending photo a new garment form holds (an add-sheet
 *   upload, a draft of a batch, #200), whether it is still the
 *   requester's in scope, and a draft's queue.
 */
export interface FormContextParts {
  categoriesOf: number;
  replaceable?: { ownerId: number; chosen: number | undefined };
  brandSize?: { userId: number; brand: string };
  lookalikes?: {
    ownerId: number;
    fields: LookalikeFields;
    dismissed: readonly number[];
  };
  repairsOf?: number;
  pending?: { fileName: string; scope: PendingScope };
}

export interface FormContext {
  categories: string[];
  replaceable: ReplaceableGarment[] | undefined;
  brandSize: BrandSize | undefined;
  lookalikes: ClosetLookalike[] | undefined;
  repairs: RepairEntry[] | undefined;
  /** As readPendingPhoto answers; undefined too when none was asked. */
  pending: PendingPhoto | 'otherWardrobe' | undefined;
}

/**
 * The garment form's reads, in one statement (selectScalars): they share
 * no rows, and were up to five round trips each until #161 (the edit page
 * with its repairs, a clone with its duplicate check, a draft with its
 * queue). A part not asked for is never read. Every form costs this one
 * statement after the session's, and after the garment for an edit or a
 * clone (what the form reads depends on it).
 */
export async function formContext(
  db: Db,
  parts: FormContextParts,
): Promise<FormContext> {
  const { replaceable, brandSize, lookalikes, repairsOf, pending } = parts;
  const row = await selectScalars(db, {
    categories: wardrobeCategoriesSql(parts.categoriesOf),
    replaceable:
      replaceable &&
      replaceableGarmentsSql(replaceable.ownerId, replaceable.chosen),
    brandSize: brandSize && brandSizeSql(brandSize.userId, brandSize.brand),
    lookalikes:
      lookalikes && closetLookalikesSql(lookalikes.ownerId, lookalikes.fields),
    repairs: repairsOf === undefined ? undefined : repairLogSql(repairsOf),
    pending: pending && pendingPhotoSql(pending.fileName, pending.scope),
  });
  return {
    categories: row.categories,
    replaceable: row.replaceable,
    brandSize: row.brandSize ?? undefined,
    // A form with nothing to match (no category or colour) reads nothing
    // and shows the region empty, as it always did.
    lookalikes:
      lookalikes &&
      readClosetLookalikes(lookalikes.fields, row.lookalikes ?? [], {
        dismissed: lookalikes.dismissed,
      }),
    repairs: row.repairs,
    pending: readPendingPhoto(row.pending),
  };
}
