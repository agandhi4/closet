/**
 * The outbox (#178; docs/plans/2026-11-12-offline-queued-writes.md sections
 * 3, 5 and 6; src/web/shell/outbox.md): wears, washes and packing ticks
 * tapped offline are kept in IndexedDB and replayed when the server answers
 * again. Bundled by `npm run generate:outbox` into public/js/outbox.js,
 * which the layout loads on signed-in pages; the rules it shares with the
 * server (keys, paths, the answer table) are src/offline-writes.ts.
 *
 * - **What queues** is marked by the server (src/web/outbox.tsx): a form
 *   `data-offline-queue` and its regions (`data-outbox-key`). A submit while
 *   connectivity.js says offline is taken here instead of sent (htmx:
 *   `htmx:confirm` cancelled; a native post: a capture-phase `submit`,
 *   before submit-once.js), and so is an htmx queueable request that never
 *   reached the server (`htmx:sendError`: it may have landed; the replay is
 *   idempotent). One record per key: a new intent replaces the old one in
 *   the same transaction (Wore today then Undo replays only the Undo).
 * - **What shows** is the server's markup: the region's other state comes
 *   out of its `<template data-outbox-state>` and `data-outbox="pending"`
 *   shows its "Waiting to sync"; both are reapplied from the records after
 *   every load and swap, so a cached page reopened offline shows them too.
 * - **Replay** on reconnect (`connectivity:change`), on every page load and
 *   when the app comes back to the front while online: iOS has no
 *   Background Sync. One tab drains at a time (`navigator.locks`), oldest
 *   first; a network error or 5xx stops it and keeps the order (backoff),
 *   a 401 keeps everything for the next sign-in, a 404/409/400 is a failure
 *   the notice shows until it is dismissed.
 * - **Accounts**: a record is its page's account's (`data-account`). A page
 *   of another account deletes the others' records unsent; signing out
 *   drains, then asks before discarding what is left.
 *
 * Listeners sit on the document once, at module evaluation (a module runs
 * once per document; boosted navigations swap only the body).
 */
import { singleFlight } from 'single-flight';
import { showToast } from 'toast';
import { todayIn } from '../../src/calendar-date';
import {
  isChecklist,
  OUTBOX_MAX_PENDING,
  type QueueableKind,
  queueableKindOf,
  type ReplayFailure,
  type ReplayVerdict,
  replayVerdict,
  retryDelayMs,
  takesDay,
} from '../../src/offline-writes';

type Fields = Record<string, string | string[]>;

interface OutboxRecord {
  /** A v4 uuid: the replay's Idempotency-Key, and a wear's clientId. */
  id: string;
  account: string;
  kind: QueueableKind;
  key: string;
  path: string;
  fields: Fields;
  /** The garment, outfit or extra, for the notice. */
  label: string;
  queuedAt: number;
  attempts: number;
  state: 'pending' | 'failed';
  reason?: ReplayFailure;
}

/** A region's write, read from the page at the tap. */
interface Draft {
  region: HTMLElement;
  kind: QueueableKind;
  key: string;
  path: string;
  label: string;
  fields: Fields;
}

declare global {
  interface Window {
    htmx?: { process(element: Element): void };
  }
}

const DB_NAME = 'closet-outbox';
const STORE = 'writes';
const DRAIN_LOCK = 'closet-outbox-drain';
const LOGOUT_PATH = '/auth/logout';
// frontend-pwa.md: a sync says so only once it is slow.
const SYNCING_QUIET_MS = 2_000;
const SAVED_TOAST_MS = 3_000;
const REFUSAL_TOAST_MS = 6_000;

const REGION = '[data-outbox-key]';
const QUEUE_FORM = 'form[data-offline-queue]';
const ALTERNATE = ':scope > template[data-outbox-state]';
const FULL_MARK = 'outboxFull';

const ACTION_TEXT: Record<QueueableKind, string> = {
  wear: 'textOutboxActionWear',
  wash: 'textOutboxActionWash',
  entry: 'textOutboxActionEntry',
  packed: 'textOutboxActionPacked',
  item: 'textOutboxActionPacked',
};

const REASON_TEXT: Record<ReplayFailure, string> = {
  gone: 'textOutboxReasonGone',
  'too-old': 'textOutboxReasonTooOld',
  future: 'textOutboxReasonFuture',
  account: 'textOutboxReasonAccount',
  refused: 'textOutboxReasonRefused',
};

// ---- The page ---------------------------------------------------------------

const appStatus = () => document.getElementById('app-status')?.dataset ?? {};
/** The page's account; absent on a signed-out page, where nothing runs. */
const pageAccount = () => appStatus().account;
const text = (name: string) => appStatus()[name] ?? '';

/** A string with a count: its `One` or `Many` form, `{count}` filled. */
function counted(
  name: 'Waiting' | 'Syncing' | 'Saved' | 'SignIn' | 'Discard',
  count: number,
): string {
  return text(`textOutbox${name}${count === 1 ? 'One' : 'Many'}`).replace(
    '{count}',
    String(count),
  );
}

const fullText = () =>
  text('textOutboxFull').replace('{count}', String(OUTBOX_MAX_PENDING));

/** connectivity.js's state, on <html>; absent until its first change (online). */
function offline(): boolean {
  const state = document.documentElement.dataset.connectivity;
  return state === 'offline' || state === 'reconnecting';
}

// ---- The store --------------------------------------------------------------

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('key', 'key');
      store.createIndex('account', 'account');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
  return database;
}

/** One transaction over the store, settled when it commits. */
async function transact(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    work(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('transaction failed'));
  });
}

async function readAll(): Promise<OutboxRecord[]> {
  let records: OutboxRecord[] = [];
  await transact('readonly', (store) => {
    const request = store.getAll();
    request.onsuccess = () => {
      records = request.result;
    };
  });
  return records.sort((a, b) => a.queuedAt - b.queuedAt);
}

/**
 * Puts each record in place of its account's record with the same key, in
 * one transaction: the last intent wins, and nothing in between is seen.
 */
function putCollapsed(records: OutboxRecord[]): Promise<void> {
  return transact('readwrite', (store) => {
    for (const record of records) {
      const same = store.index('key').getAll(record.key);
      same.onsuccess = () => {
        const olds: OutboxRecord[] = same.result;
        for (const old of olds) {
          if (old.account === record.account) store.delete(old.id);
        }
        store.put(record);
      };
    }
  });
}

const put = (record: OutboxRecord) =>
  transact('readwrite', (store) => {
    store.put(record);
  });

const remove = (records: OutboxRecord[]) =>
  transact('readwrite', (store) => {
    for (const record of records) store.delete(record.id);
  });

// ---- State ------------------------------------------------------------------

/** This account's records, oldest first, as the store last read. */
let records: OutboxRecord[] = [];
/** The last replay was a 401: everything waits for a sign-in. */
let signedOut = false;
/** A drain has been running past SYNCING_QUIET_MS. */
let syncing = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const pending = () => records.filter((record) => record.state === 'pending');
const failed = () => records.filter((record) => record.state === 'failed');

async function refresh(): Promise<void> {
  const account = pageAccount();
  try {
    records = (await readAll()).filter((record) => record.account === account);
  } catch (error) {
    console.warn('[outbox] could not read the queue', error);
    records = [];
  }
  render();
}

/**
 * A page of another account than the records' deletes them unsent (plan
 * section 6): never replayed into, or shown to, the new account.
 */
async function claimForAccount(): Promise<void> {
  const account = pageAccount();
  const others = (await readAll()).filter(
    (record) => record.account !== account,
  );
  if (others.length === 0) return;
  await remove(others);
  console.info(
    `[outbox] ${others.length} queued change(s) of another account deleted unsent`,
  );
}

// ---- Rendering --------------------------------------------------------------

function render(): void {
  renderRegions();
  renderBanner();
  renderNotice();
  guardFull();
}

/** Marks every region with a pending record and shows the intent it waits to save. */
function renderRegions(): void {
  const byKey = new Map(pending().map((record) => [record.key, record]));
  for (const region of document.querySelectorAll<HTMLElement>(REGION)) {
    const record = byKey.get(region.dataset.outboxKey ?? '');
    if (!record) {
      delete region.dataset.outbox;
    } else if (region.dataset.outbox !== 'pending') {
      showIntent(region, record);
      region.dataset.outbox = 'pending';
    }
  }
}

/**
 * A region rendered before its record (a cached page, a swap) shows the
 * record's state: a checklist row its tick, a control its other state when
 * the one shown would ask for what is already queued.
 */
function showIntent(region: HTMLElement, record: OutboxRecord): void {
  const checkbox = region.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (isChecklist(record.kind) && checkbox) {
    checkbox.checked = [record.fields.packed ?? []].flat().length > 0;
  } else if (asksFor(region, record)) {
    flip(region);
  }
}

/** The form shown posts what the record posts (its day and ids aside). */
function asksFor(region: HTMLElement, record: OutboxRecord): boolean {
  if (!region.querySelector(ALTERNATE)) return false;
  const form = region.querySelector<HTMLFormElement>(':scope > form');
  if (!form) return false;
  for (const [name, value] of new FormData(form)) {
    if (name !== 'returnTo' && record.fields[name] !== value) return false;
  }
  return true;
}

/** Swaps the region's shown state with the one in its template. */
function flip(region: HTMLElement): void {
  const template = region.querySelector<HTMLTemplateElement>(ALTERNATE);
  if (!template) return;
  const focused = region.contains(document.activeElement);
  const shown = Array.from(region.children).filter(
    (child) => child !== template && !child.matches('[data-outbox-chip]'),
  );
  const next = Array.from(template.content.childNodes);
  template.content.replaceChildren(...shown);
  template.before(...next);
  window.htmx?.process(region);
  if (focused)
    region.querySelector<HTMLElement>(':scope > form button')?.focus();
}

function renderBanner(): void {
  const banner = document.getElementById('outbox-banner');
  const slot = banner?.querySelector('[data-role="text"]');
  if (!banner || !slot) return;
  const count = pending().length;
  let message = '';
  if (count === 0) message = '';
  else if (signedOut) message = counted('SignIn', count);
  else if (offline() && count >= OUTBOX_MAX_PENDING) message = fullText();
  else if (offline()) message = counted('Waiting', count);
  else if (syncing) message = counted('Syncing', count);
  slot.textContent = message;
  banner.classList.toggle('hidden', message === '');
}

function renderNotice(): void {
  const notice = document.getElementById('outbox-notice');
  const list = notice?.querySelector('[data-role="list"]');
  if (!notice || !list) return;
  const failures = failed();
  list.replaceChildren(
    ...failures.map((record) => {
      const item = document.createElement('li');
      item.textContent = failureText(record);
      return item;
    }),
  );
  notice.classList.toggle('hidden', failures.length === 0);
}

/** "Navy chinos, Wore today: not saved, it was deleted." */
function failureText(record: OutboxRecord): string {
  // Replaced through functions: a label's `$&` is not a pattern.
  return text('textOutboxNotSaved')
    .replace('{label}', () => record.label)
    .replace('{action}', () => text(ACTION_TEXT[record.kind]))
    .replace('{reason}', () => text(REASON_TEXT[record.reason ?? 'refused']));
}

/**
 * Past OUTBOX_MAX_PENDING the queueable controls are disabled offline, like
 * connectivity.js's, and the banner says why; marked, so only those come
 * back.
 */
function guardFull(): void {
  const full = offline() && pending().length >= OUTBOX_MAX_PENDING;
  for (const form of document.querySelectorAll<HTMLFormElement>(QUEUE_FORM)) {
    for (const control of form.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >('button, input:not([type="hidden"])')) {
      if (full && !control.disabled) {
        control.disabled = true;
        control.dataset[FULL_MARK] = '';
      } else if (!full && FULL_MARK in control.dataset) {
        control.disabled = false;
        delete control.dataset[FULL_MARK];
      }
    }
  }
}

// ---- Queueing ---------------------------------------------------------------

/**
 * What a submit of a queueable form writes. A form inside a region is that
 * region's write, its fields as posted. A form holding regions writes each
 * row by itself: the packing lists the tapped row (its tick as `shown` and
 * `packed`, the checklist protocol, so the replay changes only it), the
 * laundry every checked row (a wash, replayed through the garment's Washed).
 */
function drafts(form: HTMLFormElement, trigger: EventTarget | null): Draft[] {
  const own = form.closest<HTMLElement>(REGION);
  if (own) return [draftOf(own, formFields(form))].filter(isDraft);
  const tapped =
    trigger instanceof Element ? trigger.closest<HTMLElement>(REGION) : null;
  const rows =
    tapped && form.contains(tapped)
      ? [tapped]
      : Array.from(form.querySelectorAll<HTMLElement>(REGION));
  return rows
    .map((row) => {
      const box = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const kind = kindOf(row);
      if (!box || !kind) return undefined;
      if (isChecklist(kind)) {
        return draftOf(row, {
          shown: [box.value],
          packed: box.checked ? [box.value] : [],
        });
      }
      return box.checked ? draftOf(row, {}) : undefined;
    })
    .filter(isDraft);
}

const isDraft = (draft: Draft | undefined): draft is Draft =>
  draft !== undefined;

const kindOf = (region: HTMLElement) =>
  queueableKindOf(region.dataset.outboxPath ?? '');

function draftOf(region: HTMLElement, fields: Fields): Draft | undefined {
  const {
    outboxKey: key,
    outboxPath: path,
    outboxLabel: label,
  } = region.dataset;
  const kind = kindOf(region);
  if (!key || !path || !kind) {
    console.warn(`[outbox] a region names no queueable write (${path})`);
    return undefined;
  }
  return { region, kind, key, path, label: label ?? '', fields };
}

/** The form's fields as it would post them (repeated names as a list). */
function formFields(form: HTMLFormElement): Fields {
  const fields: Fields = {};
  for (const [name, value] of new FormData(form)) {
    if (typeof value !== 'string') continue;
    const prior = fields[name];
    fields[name] = prior === undefined ? value : [prior, value].flat();
  }
  return fields;
}

/**
 * crypto.randomUUID() needs a secure context, which the household's HTTP
 * twin is not; getRandomValues does not.
 */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join(''))
    .join('-');
}

function toRecord(
  draft: Draft,
  account: string,
  queuedAt: number,
  today: string,
): OutboxRecord {
  const id = newId();
  const fields = { ...draft.fields };
  // The tap's day, not the replay's: a Sunday-night wear replayed Monday is
  // Sunday's (the server takes it back to REPLAY_WINDOW_DAYS).
  if (takesDay(draft.kind)) fields.day = today;
  if (draft.kind === 'wear' && fields.worn === '1') fields.clientId = id;
  return {
    id,
    account,
    kind: draft.kind,
    key: draft.key,
    path: draft.path,
    fields,
    label: draft.label,
    queuedAt,
    attempts: 0,
    state: 'pending',
  };
}

/** A tap that cannot be queued: why, and a checklist's tick put back. */
function refuse(message: string, trigger: EventTarget | null): void {
  if (trigger instanceof HTMLInputElement && trigger.type === 'checkbox') {
    trigger.checked = !trigger.checked;
  }
  showToast({ text: message, kind: 'warning', ttlMs: REFUSAL_TOAST_MS });
}

async function queue(
  form: HTMLFormElement,
  trigger: EventTarget | null,
): Promise<void> {
  const account = pageAccount();
  const timeZone = appStatus().timeZone;
  if (!account || !timeZone) return;
  const writes = drafts(form, trigger);
  if (writes.length === 0) return;
  const now = new Date();
  const today = todayIn(timeZone, now);
  // Wore today's state is its page's day's; a copy from another day would
  // queue the wrong toggle.
  if (
    writes.some(
      (w) => w.kind === 'wear' && w.region.dataset.outboxDay !== today,
    )
  ) {
    console.info(
      `[outbox] ${writes[0].key} refused: the page is from another day`,
    );
    refuse(text('textOutboxStaleDay'), trigger);
    return;
  }
  if (pending().length + writes.length > OUTBOX_MAX_PENDING) {
    refuse(fullText(), trigger);
    return;
  }
  const queued = writes.map((w) => toRecord(w, account, now.getTime(), today));
  try {
    await putCollapsed(queued);
  } catch (error) {
    console.warn('[outbox] could not queue', error);
    refuse(text('textOutboxUnavailable'), trigger);
    return;
  }
  console.info(
    `[outbox] queued ${queued.map((record) => record.key).join(', ')}`,
  );
  for (const write of writes) flip(write.region);
  await refresh();
}

/** The queueable form an event came from, on a signed-in page. */
function queueFormOf(element: unknown): HTMLFormElement | null {
  if (!(element instanceof Element) || !pageAccount()) return null;
  return element.closest<HTMLFormElement>(QUEUE_FORM);
}

interface HtmxRequestEvent {
  elt?: Element;
  verb?: string;
  triggeringEvent?: Event;
  requestConfig?: { triggeringEvent?: Event };
}

// htmx's own forms (Wore today, Washed, the calendar's pill, the packing
// lists): offline, the request is not sent.
document.addEventListener('htmx:confirm', (event) => {
  const detail = (event as CustomEvent<HtmxRequestEvent>).detail;
  const form = queueFormOf(detail.elt);
  if (!form || detail.verb !== 'post' || !offline()) return;
  event.preventDefault();
  void queue(form, detail.triggeringEvent?.target ?? null);
});

// Sent but never reached the server, though connectivity.js had not seen
// the drop yet: queued, in case it never landed.
document.addEventListener('htmx:sendError', (event) => {
  const detail = (event as CustomEvent<HtmxRequestEvent>).detail;
  const form = queueFormOf(detail.elt);
  if (!form) return;
  void queue(form, detail.requestConfig?.triggeringEvent?.target ?? null);
});

// Native posts (the laundry, Today's and a trip's worn control): in the
// capture phase, before submit-once.js would disable the buttons.
document.addEventListener(
  'submit',
  (event) => {
    const form = queueFormOf(event.target);
    if (!form || form.hasAttribute('hx-post') || !offline()) return;
    event.preventDefault();
    void queue(form, event.submitter);
  },
  true,
);

// ---- Replay -----------------------------------------------------------------

/** Only a same-origin path of a queueable route is ever posted (plan section 7). */
function replayUrl(path: string): URL | undefined {
  try {
    const url = new URL(path, location.origin);
    const ours =
      url.origin === location.origin &&
      url.search === '' &&
      queueableKindOf(url.pathname) !== undefined;
    return ours ? url : undefined;
  } catch {
    return undefined;
  }
}

function formBody(fields: Fields): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return body;
}

async function send(record: OutboxRecord, url: URL): Promise<ReplayVerdict> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formBody(record.fields),
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        'X-Closet-Queued': record.account,
        'Idempotency-Key': record.id,
      },
    });
    return replayVerdict(
      response.status,
      response.headers.get('X-Closet-Outcome'),
    );
  } catch {
    return { verdict: 'retry' };
  }
}

/** Replays the account's pending records in order; how many were saved. */
async function replayAll(account: string, reason: string): Promise<number> {
  const queued = (await readAll()).filter(
    (record) => record.account === account && record.state === 'pending',
  );
  if (queued.length === 0) return 0;
  console.info(`[outbox] sync (${reason}): ${queued.length} pending`);
  const quiet = setTimeout(() => {
    syncing = true;
    renderBanner();
  }, SYNCING_QUIET_MS);
  let saved = 0;
  try {
    for (const record of queued) {
      const key = `${record.key} (key ${record.id.slice(0, 8)})`;
      const url = replayUrl(record.path);
      if (!url) {
        await remove([record]);
        console.warn(
          `[outbox] ${key} deleted: ${record.path} is not a queued write`,
        );
        continue;
      }
      const answer = await send(record, url);
      if (answer.verdict === 'saved') {
        await remove([record]);
        saved += 1;
        console.info(
          `[outbox] ${key} saved (${answer.changed ? 'changed' : 'unchanged'})`,
        );
      } else if (answer.verdict === 'failed') {
        await put({ ...record, state: 'failed', reason: answer.reason });
        console.warn(`[outbox] ${key} not saved: ${answer.reason}`);
      } else if (answer.verdict === 'retry') {
        const attempts = record.attempts + 1;
        await put({ ...record, attempts });
        const delay = retryDelayMs(attempts);
        retryTimer = setTimeout(() => void drain('retry'), delay);
        console.info(
          `[outbox] ${key} unreachable, retry ${attempts} in ${delay / 1000} s`,
        );
        return saved;
      } else {
        signedOut = true;
        console.info(
          `[outbox] ${key} needs a sign-in; ${queued.length - saved} kept`,
        );
        return saved;
      }
    }
    signedOut = false;
    return saved;
  } finally {
    clearTimeout(quiet);
    syncing = false;
  }
}

/**
 * One drain at a time in this tab (a call during one runs once more after
 * it, single-flight.js) and across tabs (the lock: a tab finding it held
 * leaves the queue to the one draining).
 */
const drain = singleFlight(async (reason: string) => {
  const account = pageAccount();
  if (!account) return;
  clearTimeout(retryTimer);
  const replay = () => replayAll(account, reason);
  // navigator.locks needs a secure context; without it, this tab alone.
  const saved = navigator.locks
    ? await navigator.locks.request(
        DRAIN_LOCK,
        { ifAvailable: true },
        (lock) => (lock ? replay() : 0),
      )
    : await replay();
  await refresh();
  if (saved > 0) {
    showToast({
      text: counted('Saved', saved),
      kind: 'success',
      ttlMs: SAVED_TOAST_MS,
    });
    // freshness.js asks the worker for the page again (swapped in only if
    // untouched): counts and lines are the server's.
    document.dispatchEvent(
      new CustomEvent('outbox:synced', { detail: { saved } }),
    );
  }
});

// ---- Signing out --------------------------------------------------------------

/**
 * Sign-out drains first (it is online by definition); what is left, failed
 * or unreachable, is named in a confirm and discarded (owner decision 2,
 * 2026-11-13). The worker's logout boundary (178c) deletes the store too.
 */
async function signOut(form: HTMLFormElement): Promise<void> {
  await drain('sign-out');
  const left = records;
  if (left.length > 0) {
    if (!confirm(counted('Discard', left.length))) return;
    await remove(left);
    console.info(
      `[outbox] ${left.length} unsynced change(s) discarded at sign-out`,
    );
  }
  form.submit();
}

document.addEventListener(
  'submit',
  (event) => {
    const form = event.target;
    if (
      !(form instanceof HTMLFormElement) ||
      form.getAttribute('action') !== LOGOUT_PATH ||
      records.length === 0
    ) {
      return;
    }
    event.preventDefault();
    void signOut(form);
  },
  true,
);

// ---- Wiring -------------------------------------------------------------------

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  if (!event.target.closest('[data-outbox-dismiss]')) return;
  const dismissed = failed();
  void remove(dismissed).then(() => {
    console.info(`[outbox] ${dismissed.length} failure(s) dismissed`);
    return refresh();
  });
});

document.addEventListener('connectivity:change', (event) => {
  const { state } = (event as CustomEvent<{ state: string }>).detail;
  render();
  if (state === 'online') void drain('online');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Another tab may have queued or drained meanwhile.
  void refresh();
  if (!offline()) void drain('visible');
});

// A boosted navigation or a swap brings regions (and #app-status) anew.
document.addEventListener('htmx:afterSettle', render);

async function start(): Promise<void> {
  if (!pageAccount()) return;
  try {
    await claimForAccount();
  } catch (error) {
    console.warn('[outbox] unavailable', error);
  }
  await refresh();
  void drain('load');
}

void start();
