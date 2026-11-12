import { and, asc, gt, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { file } from '../db/schema';
import type { Logger } from '../logger';
import type { StoredPhoto } from '../web/files/image-variant';
import type { Photos, ThumbRederivation } from '../web/files/photos';

// Rows read per statement: the run reads per batch (Statements per run,
// AGENTS.md) and rewrites per photo, each in its own transaction.
const BATCH_SIZE = 100;

export interface RetrimOptions {
  /** Count what would change without storing or swapping anything. */
  dryRun?: boolean;
  /**
   * Stops the run between photos, never inside one: a photo cut off between
   * storing its new set and the swap would leave a set newer than its row's,
   * which reconciliation keeps (a restore's signature) and warns about
   * nightly.
   */
  stop?: AbortSignal;
}

/** What the run did, photo by photo; each photo is counted once. */
interface RetrimCounts {
  /** Given a new keyed set with the trimmed thumb (none in a dry run). */
  retrimmed: number;
  /** Whose thumb a dry run would replace. */
  due: number;
  /** Whose thumb already is the trimmed one: a second run changes nothing. */
  current: number;
  /** Whose row names a cutout that is not in storage. */
  missingCutouts: number;
  /** Refused by the state machine (an edit landed meanwhile, the row went). */
  refused: number;
  /** That threw; each logged with its id. A second run retries them. */
  failed: number;
}

export interface RetrimReport extends RetrimCounts {
  dryRun: boolean;
  /** `stop` ended the run before every photo was seen; a second run finishes it. */
  stopped: boolean;
  /** Photos with a ready or edited cutout. */
  photos: number;
  durationMs: number;
}

export interface RetrimDeps {
  db: Db;
  photos: Photos;
  logger: Logger;
}

const COUNTED_AS: Record<ThumbRederivation['result'], keyof RetrimCounts> = {
  rederived: 'retrimmed',
  due: 'due',
  current: 'current',
  'no-cutout': 'missingCutouts',
  refused: 'refused',
};

interface CutoutPhoto extends StoredPhoto {
  id: number;
}

/**
 * The one-off backfill of #373 (`npm run maintenance:retrim-thumbs`): every
 * photo with a cutout (ready or edited) gets the thumb its cutout derives
 * today, trimmed to the garment (Photos.rederiveCutoutThumb), under a new
 * variant key, so browsers and the app's image cache fetch it. Idempotent:
 * a photo whose thumb is already that one is left alone. Photos are taken
 * in id order, one at a time; one photo's failure is logged and counted,
 * never the others'. The replaced set is deleted by the swap itself, as an
 * edit's is (writeCutout); a file a failed swap leaves is reconciliation's.
 */
export async function retrimCutoutThumbs(
  deps: RetrimDeps,
  { dryRun = false, stop }: RetrimOptions = {},
): Promise<RetrimReport> {
  const { db, logger } = deps;
  const startedAt = Date.now();
  logger.info(`Thumb retrim started${dryRun ? ' (dry run)' : ''}`);
  const report: RetrimReport = {
    dryRun,
    stopped: false,
    photos: 0,
    retrimmed: 0,
    due: 0,
    current: 0,
    missingCutouts: 0,
    refused: 0,
    failed: 0,
    durationMs: 0,
  };

  for await (const photo of cutoutPhotos(db)) {
    if (stop?.aborted) {
      report.stopped = true;
      break;
    }
    report.photos++;
    report[await retrimPhoto(deps, photo, dryRun)]++;
  }

  report.durationMs = Date.now() - startedAt;
  if (report.stopped) {
    logger.warn(
      `Thumb retrim stopped by a signal after ${report.photos} photos; run it again to finish`,
    );
  }
  logger.info(
    `Thumb retrim finished${dryRun ? ' (dry run)' : ''} in ${report.durationMs}ms: ${report.photos} photos with a cutout, ${dryRun ? `${report.due} due` : `${report.retrimmed} retrimmed`}, ${report.current} current, ${report.missingCutouts} missing a cutout, ${report.refused} refused, ${report.failed} failed`,
  );
  return report;
}

// One photo, never throwing: what to count it as, its trouble logged.
async function retrimPhoto(
  { photos, logger }: RetrimDeps,
  photo: CutoutPhoto,
  dryRun: boolean,
): Promise<keyof RetrimCounts> {
  const named = `Photo ${photo.id} (${photo.fileName})`;
  let done: ThumbRederivation;
  try {
    done = await photos.rederiveCutoutThumb(photo, { dryRun });
  } catch (error) {
    logger.warn({ err: error }, `${named}: thumb retrim failed`);
    return 'failed';
  }
  if (done.result === 'no-cutout') {
    logger.warn(
      `${named}: its cutout (key ${photo.variantKey ?? 'unkeyed'}) is not in storage; thumb left`,
    );
  } else if (done.result === 'refused') {
    logger.info(
      `${named}: retrim refused (${done.reason}): the photo changed meanwhile, its new cutout with its own thumb`,
    );
  }
  return COUNTED_AS[done.result];
}

// Every photo whose thumb derives from a cutout, read BATCH_SIZE at a time
// in id order (a swap never moves an id), a batch only when the last is done.
async function* cutoutPhotos(db: Db): AsyncGenerator<CutoutPhoto> {
  let afterId = 0;
  for (;;) {
    const batch = await db
      .select({
        id: file.id,
        fileName: file.fileName,
        variantKey: file.variantKey,
      })
      .from(file)
      .where(
        and(
          gt(file.id, afterId),
          inArray(file.cutoutStatus, ['ready', 'edited']),
        ),
      )
      .orderBy(asc(file.id))
      .limit(BATCH_SIZE);
    if (batch.length === 0) return;
    yield* batch;
    afterId = batch[batch.length - 1].id;
  }
}
