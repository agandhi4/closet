import { addDays, type IsoDate } from '../calendar-date';
import type { Logger } from '../logger';
import { parseStoredName } from '../web/files/image-variant';
import type { PhotoStorage, TrashedSet } from '../web/files/storage';

/**
 * How long reconciliation's quarantine (#649) keeps a photo set before the
 * nightly run deletes it: long enough to notice, after a database restore,
 * that garments added since the dump have lost their photos.
 */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Deletes the day directories of `.trash` older than TRASH_RETENTION_DAYS
 * before `today`, and returns how many sets they held (a dry run deletes
 * nothing and counts the same). A day that cannot be deleted is a warning
 * and stays for the next run: the purge never stops reconciliation.
 */
export async function purgeTrash(
  storage: PhotoStorage,
  today: IsoDate,
  logger: Logger,
  dryRun: boolean,
): Promise<number> {
  const keepFrom = addDays(today, -TRASH_RETENTION_DAYS);
  let days: IsoDate[];
  let sets: TrashedSet[];
  try {
    days = (await storage.trashDays()).filter((day) => day < keepFrom);
    if (days.length === 0) return 0;
    sets = await storage.trash();
  } catch (error) {
    logger.warn({ err: error }, 'Trash purge skipped: .trash unreadable');
    return 0;
  }
  let purged = 0;
  for (const day of days) {
    const held = sets.filter((set) => set.day === day).length;
    try {
      if (!dryRun) await storage.removeTrashDay(day);
      logger.info(
        `${dryRun ? 'Would purge' : 'Purged'} quarantine of ${day}: ${held} photo sets`,
      );
      purged += held;
    } catch (error) {
      logger.warn({ err: error }, `Trash purge of ${day} failed; kept`);
    }
  }
  return purged;
}

export type RestoreOutcome = { restored: TrashedSet } | { refused: string };

/**
 * `maintenance:reconcile -- --restore-from-trash <name>`: moves a
 * quarantined set back into DATA_PATH, where list() (and reconciliation)
 * finds it. `name` is the set's base name (`<uuid>.webp`), or
 * `<day>/<entry>` when it was quarantined more than once. Refused when no
 * set or several match, or when storage already holds a live set of that
 * name: the trash never overwrites a photo.
 *
 * Restores the bytes only: with no `file` row they are an orphan again,
 * quarantined the next night unless the row is restored too.
 */
export async function restoreFromTrash(
  storage: PhotoStorage,
  name: string,
  logger: Logger,
): Promise<RestoreOutcome> {
  const matches = (await storage.trash()).filter(
    (set) =>
      `${set.day}/${set.entry}` === name ||
      set.entry === name ||
      set.entry.startsWith(`${name}~`),
  );
  if (matches.length === 0) {
    return { refused: `no quarantined photo set named ${name}` };
  }
  if (matches.length > 1) {
    const names = matches.map((set) => `${set.day}/${set.entry}`).join(', ');
    return { refused: `${name} matches several sets; name one: ${names}` };
  }
  const [set] = matches as [TrashedSet];
  const baseName = setBaseName(set);
  if (!baseName) {
    return { refused: `${set.day}/${set.entry} holds no photo files` };
  }
  for await (const object of storage.list()) {
    if (parseStoredName(object.name)?.baseName === baseName) {
      return {
        refused: `storage already holds a photo set named ${baseName}`,
      };
    }
  }
  await storage.restore(set);
  logger.info(
    `Restored ${set.day}/${set.entry} from the trash: ${set.files.join(', ')}`,
  );
  return { restored: set };
}

function setBaseName(set: TrashedSet): string | undefined {
  for (const file of set.files) {
    const parsed = parseStoredName(file);
    if (parsed) return parsed.baseName;
  }
  return undefined;
}
