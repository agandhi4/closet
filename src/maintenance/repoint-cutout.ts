import { type CutoutRow, repointCutoutRow } from '../cutout/queries';
import type { Db } from '../db/client';
import type { Logger } from '../logger';
import { parseStoredName, variantFileName } from '../web/files/image-variant';
import type { PhotoStorage } from '../web/files/storage';

/** The argument that names the set stored with the photo (no key). */
export const UNKEYED = 'unkeyed';

const VARIANT_KEY = /^[0-9a-f]{12}$/;

export interface RepointDeps {
  db: Db;
  storage: PhotoStorage;
  logger: Logger;
}

export type RepointOutcome =
  | {
      repointed: true;
      photo: string;
      from: string | null;
      to: string | null;
      version: number;
      status: CutoutRow['status'];
      /** Its missing mark was cleared: its bytes are stored. */
      unmarked: boolean;
    }
  | { repointed: false; photo: string; refused: string };

/**
 * `maintenance:repoint-cutout <photo> <key|unkeyed>` (#653): points a
 * photo's row at a nobg and thumb already in storage, the sanctioned form of
 * what was a hand-written `update file`. After a database restored behind
 * its storage, a row names an older variant key than the newest files on
 * disk (reconciliation keeps those and says `Keeping variant key <k> of
 * <photo>`); after a rollback past #141 and back, a mask an older build
 * saved sits unkeyed under a keyed row.
 *
 * Through the cutout state machine, never around it (repointCutoutRow):
 * the garment owner's lock and the row's, so the sync triggers move the
 * garment's revision and every device and the API learn of it. A ready or
 * edited row takes `rederive` (its status kept: the model's cutout stays
 * the model's, a mask the user's); none, pending or failed take `edit` (the
 * cutout the household chose, which no job result replaces); unwanted (an
 * outfit selfie) takes neither. The row's missing mark is cleared with it:
 * its files are stored, so something of it shows again. The files are
 * checked here, before any lock (no storage I/O in a transaction).
 */
export async function repointCutout(
  { db, storage, logger }: RepointDeps,
  photo: string,
  keyArgument: string,
): Promise<RepointOutcome> {
  const refuse = (refused: string): RepointOutcome => {
    logger.warn(`Cutout repoint of ${photo} refused: ${refused}`);
    return { repointed: false, photo, refused };
  };
  const checked = await checkedKey(storage, photo, keyArgument);
  if ('refused' in checked) return refuse(checked.refused);
  const { key } = checked;
  const outcome = await repointCutoutRow(db, photo, key);
  if (outcome.gone) return refuse('no file row has that name');
  const { row, next, unmarked } = outcome;
  if (next && !next.ok) {
    return refuse(`the ${row.status} cutout takes no repoint (${next.reason})`);
  }
  const { version, status } = next ? next.state : row;
  const cleared = unmarked ? '; missing mark cleared' : '';
  logger.info(
    next
      ? `Cutout of ${photo} repointed from ${label(row.variantKey)} to ${label(key)}: ${status}, version ${version}${cleared}`
      : `Cutout of ${photo} already points at ${label(key)}${cleared}`,
  );
  return {
    repointed: true,
    photo,
    from: row.variantKey,
    to: key,
    version,
    status,
    unmarked,
  };
}

// The arguments, and the set they name in storage, checked before any lock
// (no storage I/O in a transaction: Images).
async function checkedKey(
  storage: PhotoStorage,
  photo: string,
  keyArgument: string,
): Promise<{ key: string | null } | { refused: string }> {
  if (parseStoredName(photo)?.variant !== 'original') {
    return { refused: 'not a photo name (<uuid>.webp)' };
  }
  const key = keyArgument === UNKEYED ? null : keyArgument;
  if (key !== null && !VARIANT_KEY.test(key)) {
    return { refused: `not a variant key (12 hex digits, or ${UNKEYED})` };
  }
  const missing: string[] = [];
  for (const variant of ['nobg', 'thumb'] as const) {
    const name = variantFileName(photo, variant, key);
    if (!(await storage.exists(name))) missing.push(name);
  }
  return missing.length > 0
    ? { refused: `not in storage: ${missing.join(', ')}` }
    : { key };
}

function label(key: string | null): string {
  return key === null ? UNKEYED : `key ${key}`;
}
