/**
 * The outbox's IndexedDB store and its change channel (#178,
 * src/web/shell/outbox.md), shared by the page's outbox (outbox.ts) and the
 * service worker (src-sw.ts), which only deletes records at session
 * boundaries. One definition on purpose: whichever opens the database first
 * creates it, and an open without the schema's upgrade would leave version 1
 * with no store, which the other could then never add.
 */

const DB_NAME = 'closet-outbox';
const DB_VERSION = 1;
export const OUTBOX_STORE = 'writes';
const CHANNEL = 'closet-outbox';

/** What every write announces on the channel. */
export interface OutboxChange {
  /** A put: a tab that can reach the server should drain it. */
  drain: boolean;
}

export function openOutboxDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(OUTBOX_STORE, {
        keyPath: 'id',
      });
      store.createIndex('key', 'key');
      store.createIndex('account', 'account');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

/**
 * When the server last answered one of an account's replays properly: the
 * evidence that a 5xx is a record's fault (replayQueue). Its own database,
 * not a second store in the outbox's: a version bump of the outbox's would
 * wait on every open tab of the older build holding version 1 (nothing
 * closes it on `versionchange`), hanging the page and the worker.
 */
const HEALTH_DB_NAME = 'closet-outbox-health';
const HEALTH_STORE = 'healthy';

function inHealthStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const opening = indexedDB.open(HEALTH_DB_NAME, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(HEALTH_STORE, { keyPath: 'account' });
    };
    opening.onerror = () =>
      reject(opening.error ?? new Error('health open failed'));
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction(HEALTH_STORE, mode);
      const request = work(transaction.objectStore(HEALTH_STORE));
      transaction.oncomplete = () => {
        db.close();
        resolve(request?.result);
      };
      transaction.onabort = transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error('health transaction failed'));
      };
    };
  });
}

export async function readHealthyAt(
  account: string,
): Promise<number | undefined> {
  const row = await inHealthStore<{ at?: unknown } | undefined>(
    'readonly',
    (store) => store.get(account),
  );
  return typeof row?.at === 'number' ? row.at : undefined;
}

export async function writeHealthyAt(
  account: string,
  at: number,
): Promise<void> {
  await inHealthStore('readwrite', (store) => store.put({ account, at }));
}

/** One transaction over the store, settled when it commits. */
export function inTransaction(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(OUTBOX_STORE, mode);
    work(transaction.objectStore(OUTBOX_STORE));
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('transaction failed'));
  });
}

/**
 * The channel every tab of the origin and the worker share; absent where
 * BroadcastChannel is (iOS before 15.4), where tabs catch up at their next
 * visibilitychange.
 */
export function openOutboxChannel(): BroadcastChannel | undefined {
  return typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(CHANNEL)
    : undefined;
}
