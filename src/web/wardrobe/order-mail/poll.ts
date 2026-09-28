import type { Db } from '../../../db/client';
import type { Logger } from '../../../logger';
import { findUserByEmail } from '../../auth/queries';
import { todayIn } from '../../calendar/calendar-date';
import {
  type OutboundFetcher,
  OutboundFetchError,
} from '../../security/outbound-fetch';
import type { ExtractedProduct } from '../link-import/extract';
import { readProductPage } from '../link-import/import';
import type { EmailEnvelope, JmapClient, JmapMailbox } from './jmap';
import { normalizedLink, productLinkCandidates } from './links';
import {
  type FoundProduct,
  orderMailWatermark,
  processedEmailIds,
  recordOrderEmail,
} from './queries';
import { judgeSender } from './trust';

/**
 * One poll of the order mail account (#25; plan
 * docs/plans/2026-09-28-order-email-import.md): the inbox's new emails,
 * each judged by its sender (trust.ts), its links read (links.ts) and each
 * link's page through the link import's reader (readProductPage: the user
 * URL fetcher, SSRF-safe, bounded), and the products it names listed for
 * ORDER_MAIL_OWNER's account to review. Run by server.ts's timer inside
 * metrics.timeJob('order_mail'), so a failure (JMAP unreachable or
 * refusing, an unknown owner) counts as the job's and reaches Bugsink.
 *
 * An email is recorded only once its links were read, in one transaction
 * with its items (recordOrderEmail), so a run that fails or is stopped
 * part-way reads the rest again next time. A link that fails to fetch is
 * skipped (the fetcher logs its host and reason).
 */

/** At most this many emails are read a poll; the rest wait for the next. */
export const MAX_EMAILS_PER_POLL = 5;
/** At most this many products are kept from one email. */
export const MAX_ITEMS_PER_EMAIL = 10;
/** An email's links are fetched this many at a time. */
const LINK_CONCURRENCY = 3;

export interface OrderMailDeps {
  db: Db;
  jmap: JmapClient;
  /** The app's fetcher of user-supplied URLs: every link of an email. */
  fetcher: OutboundFetcher;
  /** ORDER_MAIL_SENDERS, lower case. */
  senders: readonly string[];
  /** ORDER_MAIL_OWNER, normalized. */
  ownerEmail: string;
  /** APP_TIMEZONE: which day an email arrived. */
  timeZone: string;
  logger: Logger;
}

export interface PollSummary {
  queried: number;
  read: number;
  listed: number;
}

/** The configured owner names no closet account: the poll cannot list anything. */
export class OrderMailOwnerError extends Error {
  constructor() {
    super('ORDER_MAIL_OWNER names no closet account');
    this.name = 'OrderMailOwnerError';
  }
}

export async function pollOrderMail(deps: OrderMailDeps): Promise<PollSummary> {
  const { db, logger } = deps;
  const started = performance.now();
  const owner = await findUserByEmail(db, deps.ownerEmail);
  if (!owner) throw new OrderMailOwnerError();
  const mailbox = await deps.jmap.open();
  const watermark = await orderMailWatermark(db, mailbox.accountId);
  const ids = await mailbox.inboxIds(watermark);
  const processed = await processedEmailIds(db, mailbox.accountId, ids);
  const fresh = ids
    .filter((id) => !processed.has(id))
    .slice(0, MAX_EMAILS_PER_POLL);
  let listed = 0;
  for (const envelope of await mailbox.envelopes(fresh)) {
    listed += await readEmail(deps, mailbox, envelope, owner.id);
  }
  logger.info(
    `Order mail poll: ${ids.length} queried, ${fresh.length} new read, ${listed} products listed for user ${owner.id} in ${Math.round(performance.now() - started)} ms`,
  );
  return { queried: ids.length, read: fresh.length, listed };
}

/** Reads and records one email; how many products it listed. */
async function readEmail(
  deps: OrderMailDeps,
  mailbox: JmapMailbox,
  envelope: EmailEnvelope,
  ownerId: number,
): Promise<number> {
  const { db, logger } = deps;
  const record = (
    outcome: 'imported' | 'no-products' | 'untrusted' | 'too-large',
    products: readonly FoundProduct[] = [],
  ) =>
    recordOrderEmail(
      db,
      {
        accountId: mailbox.accountId,
        emailId: envelope.id,
        receivedAt: envelope.receivedAt,
        outcome,
      },
      ownerId,
      todayIn(deps.timeZone, envelope.receivedAt),
      products,
    );

  const verdict = judgeSender(envelope, deps.senders);
  if (!verdict.trusted) {
    logger.warn(
      `Order mail ${envelope.id} ignored: untrusted (${verdict.reason}, from ${verdict.domain ?? 'no domain'})`,
    );
    await record('untrusted');
    return 0;
  }
  const body = await mailbox.body(envelope.id);
  if (body.kind === 'gone') {
    logger.info(`Order mail ${envelope.id} was removed before it was read`);
    return 0;
  }
  if (body.kind === 'too-large') {
    logger.warn(`Order mail ${envelope.id} ignored: too large to read`);
    await record('too-large');
    return 0;
  }
  const links = productLinkCandidates(body.parts);
  const products = await readProducts(deps.fetcher, links);
  const listed = await record(
    products.length > 0 ? 'imported' : 'no-products',
    products,
  );
  logger.info(
    `Order mail ${envelope.id}: ${links.length} links read, ${products.length} products found, ${listed} listed for user ${ownerId}`,
  );
  return listed;
}

/**
 * The products behind `links`, LINK_CONCURRENCY fetches at a time, each
 * page once (two links that land on one page count once), in the links'
 * order, at most MAX_ITEMS_PER_EMAIL. A link refused or failing is skipped.
 */
async function readProducts(
  fetcher: OutboundFetcher,
  links: readonly string[],
): Promise<FoundProduct[]> {
  const found: (FoundProduct | undefined)[] = [];
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      found[index] = await readProduct(fetcher, links[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LINK_CONCURRENCY, links.length) }, worker),
  );
  const seen = new Set<string>();
  return found
    .filter((product): product is FoundProduct => {
      if (!product || seen.has(product.productUrl)) return false;
      seen.add(product.productUrl);
      return true;
    })
    .slice(0, MAX_ITEMS_PER_EMAIL);
}

async function readProduct(
  fetcher: OutboundFetcher,
  link: string,
): Promise<FoundProduct | undefined> {
  try {
    const { product, url } = await readProductPage(fetcher, link);
    if (!isProduct(product)) return undefined;
    return {
      productUrl: normalizedLink(url),
      name: product.name,
      brand: product.brand,
      price: product.price?.amount ?? null,
      currency: product.price?.currency ?? null,
    };
  } catch (error) {
    // The fetcher logged the refusal with its hosts.
    if (error instanceof OutboundFetchError) return undefined;
    throw error;
  }
}

/**
 * A product page: schema.org Product data, or a stated price. An email's
 * other links (a store's category pages, its blog) have neither, and its
 * page title alone would list them.
 */
function isProduct(product: ExtractedProduct): boolean {
  return product.source === 'json-ld' || product.price !== null;
}
