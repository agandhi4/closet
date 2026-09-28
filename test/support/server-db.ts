import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { loadConfig } from '../../src/config';
import { createDb, type Db, dbConfig } from '../../src/db/client';
import { user } from '../../src/db/schema';
import { insertGarment } from '../../src/web/wardrobe/queries';

/**
 * Runs `work` against the database of the server under test, for a
 * Playwright spec that seeds rows no browser action makes
 * (order-review.spec.ts) or more rows than its setup can afford to post one
 * at a time (#247). It is loadConfig()'s, the same environment and .env
 * files playwright.config.ts starts the server with (as householdToday
 * reads it).
 *
 * The pool lives for one call, never for a spec file: fullyParallel splits a
 * file's tests into groups a worker may run one after another, and the file
 * is imported once per worker, so a module-level pool ended in afterAll is
 * ended again (or used after end) by the next group.
 */
export async function withServerDb<T>(
  work: (db: Db) => Promise<T>,
): Promise<T> {
  const db = createDb(dbConfig(loadConfig()), pino({ level: 'silent' }));
  try {
    return await work(db);
  } finally {
    await db.$client.end();
  }
}

/** The id of the account registered as `email` (signIn's, signInAs'). */
export async function userIdOf(db: Db, email: string): Promise<number> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(sql`lower(${user.email})`, email.toLowerCase()));
  if (!row) throw new Error(`No account is registered as ${email}`);
  return row.id;
}

/**
 * Closet garments (tops, no photo) named `names`, for `email`'s account, in
 * one transaction through the app's own insertGarment, as the seed writes
 * them. Returns their ids in `names` order, which is creation order: the
 * last is the newest, first on the wardrobe grid. Posting 49 garments
 * through POST /wardrobe took most of a test's 30 s under a full parallel
 * suite (#247).
 */
export function seedGarments(
  email: string,
  names: readonly string[],
): Promise<number[]> {
  return withServerDb(async (db) => {
    const ownerId = await userIdOf(db, email);
    return db.transaction(async (tx) => {
      const ids: number[] = [];
      for (const name of names) {
        ids.push(
          await insertGarment(
            tx,
            ownerId,
            {
              name,
              category: 'tops',
              brand: null,
              colors: null,
              size: null,
              notes: null,
              washingDetails: null,
              acquiredOn: null,
            },
            null,
            'closet',
          ),
        );
      }
      return ids;
    });
  });
}
