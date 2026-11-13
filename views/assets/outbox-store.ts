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
