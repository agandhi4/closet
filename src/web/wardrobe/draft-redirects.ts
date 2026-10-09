import type { Draft } from '../files/pending-photos';
import type { WebOptions } from '../plugin';
import { nextDraft } from './draft-queue';
import { batchDoneUrl, draftUrl, wardrobeUrl } from './urls';

/**
 * Where a batch's queue goes once its draft `photo` is saved as garment
 * `id` (#200): the next draft after it in picked order, wrapping round
 * (so one skipped earlier comes back once the rest are done), else
 * select mode with the batch checked. The claim answered the drafts
 * still waiting (takePendingPhoto), so this reads nothing.
 *
 * Used by the garment plugin's save and the photo plugin's Discard, which
 * must end a queue the same way.
 */
export function afterDraft(
  logger: WebOptions['logger'],
  viewOwner: number | undefined,
  photo: string,
  draft: Draft,
  saved: readonly number[],
  id: number,
): string {
  logger.info(
    `Garment ${id} saved from draft ${photo} of batch ${draft.batchId.slice(0, 8)}`,
  );
  const next = nextDraft(draft.waiting, draft.position);
  const savedNow = [...saved, id];
  return next
    ? draftUrl(viewOwner, next, savedNow)
    : batchEnd(logger, viewOwner, savedNow);
}

/** Where a batch's queue ends: select mode with what it saved checked. */
export function batchEnd(
  logger: WebOptions['logger'],
  viewOwner: number | undefined,
  saved: readonly number[],
): string {
  logger.info(`Draft queue done: ${saved.length} garments saved`);
  return saved.length > 0
    ? batchDoneUrl(viewOwner, saved)
    : wardrobeUrl(viewOwner);
}
