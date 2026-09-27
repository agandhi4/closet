import { Readable } from 'node:stream';
import type { Db } from '../../../db/client';
import { HttpError } from '../../errors';
import {
  MAX_PENDING_PER_USER,
  recordPendingPhoto,
} from '../../files/pending-photos';
import type { ImageSource, Photos } from '../../files/photos';
import type { StringKey } from '../../i18n';
import type { Logger } from '../../../logger';
import {
  type FetchedResource,
  type OutboundFetcher,
  OutboundFetchError,
  type OutboundFetchRefusal,
} from '../../security/outbound-fetch';
import { type ExtractedProduct, extractProduct } from './extract';

/**
 * Adding a garment from a link (issue #6; docs/plans/2026-09-26-wardrobe-
 * features.md, section 0): fetch what the link names through the outbound
 * fetcher, the only fetcher of user-supplied URLs, and turn it into what
 * the garment form needs. Nothing here writes a `garment` or `file` row. A
 * photo it keeps is a pending photo: bytes plus a `pending_photo` row bound
 * to the user who fetched it (src/web/files/pending-photos.ts), which the
 * form's save claims (createGarmentWithLinkPhoto, ../writes.ts) or
 * reconciliation removes a day later.
 *
 * Memory: one import holds up to MAX_PHOTO_CHOICES images of up to 15 MB
 * (BYTE_LIMITS.image) at once, about 90 MB transient, plus the decodes for
 * their previews. LINK_IMPORT_LIMIT bounds one user's rate, not how many
 * users import at the same moment.
 *
 * - An image: stored as the pending photo.
 * - A web page: extractProduct, then its image candidates fetched for the
 *   choices (previews in memory, never stored) and the first one that
 *   reads stored as the pending photo, so the form opens with a photo.
 */

/** How many of a page's image candidates are fetched as choices. */
export const MAX_PHOTO_CHOICES = 6;

/**
 * The link field's cap (and the posted link's). Longer than the fetcher's
 * own URL cap, so a pasted line with words around the link still reaches
 * linkIn, and an over-long link is the fetcher's refusal with its message.
 */
export const LINK_INPUT_MAX = 4096;

export type LinkImportRefusal =
  | OutboundFetchRefusal
  /** The text holds no http(s) link. */
  | 'no-link'
  /** Fetched as an image, but not one Photos can decode (or too many pixels). */
  | 'unreadable-image';

/** A refusal of the link import's (REFUSALS says what the user is told). */
export class LinkImportError extends Error {
  constructor(readonly reason: LinkImportRefusal) {
    super(`Link import refused: ${reason}`);
    this.name = 'LinkImportError';
  }
}

/**
 * The message a refusal shows, and its status: 400 for a link that is not
 * one the server fetches, 502 for a site that did not give a usable answer.
 * The messages never name a host or an address (a name that resolves
 * inside the network must not tell the user where it points).
 */
export const REFUSALS: Readonly<
  Record<LinkImportRefusal, { message: StringKey; status: 400 | 502 }>
> = {
  'no-link': { message: 'linkImport.NO_LINK', status: 400 },
  'invalid-url': { message: 'linkImport.INVALID_URL', status: 400 },
  'unsupported-scheme': {
    message: 'linkImport.UNSUPPORTED_SCHEME',
    status: 400,
  },
  'credentials-in-url': {
    message: 'linkImport.CREDENTIALS_IN_URL',
    status: 400,
  },
  'port-not-allowed': { message: 'linkImport.PORT_NOT_ALLOWED', status: 400 },
  'blocked-address': { message: 'linkImport.BLOCKED_ADDRESS', status: 400 },
  // The rule of fetches that name their hosts (the weather's API); a link
  // import names none, so it never meets it.
  'host-not-allowed': { message: 'linkImport.BLOCKED_ADDRESS', status: 400 },
  unresolvable: { message: 'linkImport.UNRESOLVABLE', status: 400 },
  'too-many-redirects': {
    message: 'linkImport.TOO_MANY_REDIRECTS',
    status: 502,
  },
  'http-status': { message: 'linkImport.HTTP_STATUS', status: 502 },
  'unexpected-content-type': {
    message: 'linkImport.UNEXPECTED_CONTENT_TYPE',
    status: 502,
  },
  'too-large': { message: 'linkImport.TOO_LARGE', status: 502 },
  timeout: { message: 'linkImport.TIMEOUT', status: 502 },
  network: { message: 'linkImport.NETWORK', status: 502 },
  'unreadable-image': { message: 'linkImport.UNREADABLE_IMAGE', status: 502 },
};

export interface LinkImportDeps {
  db: Db;
  fetcher: OutboundFetcher;
  photos: Photos;
  logger: Logger;
}

/** One of a page's photos, to pick instead of the first. */
export interface PhotoChoice {
  /** The image's address, fetched again when it is picked. */
  url: string;
  /** A small WebP as a data: URL (the CSP allows no other origin's images). */
  preview: string;
}

export type LinkImport =
  | { kind: 'image'; photo: string }
  | {
      kind: 'page';
      product: ExtractedProduct;
      /** The pending photo: the first candidate that could be read. */
      photo: string | undefined;
      /** Every candidate that could be read, when there are two or more. */
      choices: PhotoChoice[];
    };

// Up to the first whitespace; the characters a sentence puts right after a
// link are not part of it.
const LINK = /https?:\/\/\S+/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»”’]+$/;

/**
 * The first http(s) link in `text`: what a person pasted, or what a share
 * sheet sent (Android puts the link in `text`, often after the page's
 * title). Undefined when there is none.
 */
export function linkIn(text: string): string | undefined {
  return LINK.exec(text)?.[0].replace(TRAILING_PUNCTUATION, '');
}

/**
 * What `url` gives the garment form, the pending photo stored for `userId`
 * (the user fetching; the save gives the `file` row to the wardrobe's
 * owner). Throws
 * LinkImportError for a link the fetcher refused or an image that cannot
 * be read.
 */
export async function importLink(
  deps: LinkImportDeps,
  url: string,
  userId: number,
): Promise<LinkImport> {
  const resource = await fetchOrRefuse(deps, url, ['html', 'image']);
  if (resource.kind === 'image') {
    return { kind: 'image', photo: await storePhoto(deps, resource, userId) };
  }
  const product = extractProduct(pageText(resource), resource.url);
  const readable = await fetchChoices(
    deps,
    product.images.slice(0, MAX_PHOTO_CHOICES),
  );
  const photo = readable[0]
    ? await storePhoto(deps, readable[0].resource, userId)
    : undefined;
  deps.logger.info(
    `Link import from ${resource.url.hostname}: ${product.source ?? 'nothing'} extracted, ${readable.length} of ${product.images.length} photos read${photo ? `, ${photo} pending` : ''}`,
  );
  return {
    kind: 'page',
    product,
    photo,
    choices:
      readable.length > 1
        ? readable.map(({ url: choice, preview }) => ({
            url: choice,
            preview,
          }))
        : [],
  };
}

/**
 * The photo at `url` (a choice the form offered, or any image link) stored
 * as a pending photo for `userId`; its stored name.
 */
export async function fetchLinkPhoto(
  deps: LinkImportDeps,
  url: string,
  userId: number,
): Promise<string> {
  return storePhoto(deps, await fetchOrRefuse(deps, url, ['image']), userId);
}

async function fetchOrRefuse(
  { fetcher }: LinkImportDeps,
  url: string,
  accept: readonly ('html' | 'image')[],
): Promise<FetchedResource> {
  try {
    return await fetcher.fetch(url, { accept });
  } catch (error) {
    // The fetcher logged the refusal with its hosts.
    if (error instanceof OutboundFetchError) {
      throw new LinkImportError(error.reason);
    }
    throw error;
  }
}

/**
 * Stores the image as `userId`'s pending photo: the bytes, then its
 * `pending_photo` row, which evicts their oldest past
 * MAX_PENDING_PER_USER (those bytes go here too). The bytes are this
 * request's own, so a failed row insert deletes them.
 */
async function storePhoto(
  { db, photos, logger }: LinkImportDeps,
  resource: FetchedResource,
  userId: number,
): Promise<string> {
  let fileName: string;
  try {
    ({ fileName } = await photos.storeImage(imageSource(resource), userId));
  } catch (error) {
    // Photos' refusals of the bytes themselves (unreadable, too many pixels).
    if (error instanceof HttpError && error.statusCode < 500) {
      throw new LinkImportError('unreadable-image');
    }
    throw error;
  }
  let evicted: string[];
  try {
    evicted = await recordPendingPhoto(db, fileName, userId);
  } catch (error) {
    await photos.deleteVariants(fileName);
    throw error;
  }
  for (const name of evicted) await photos.deleteVariants(name);
  if (evicted.length > 0) {
    logger.info(
      `User ${userId} is over ${MAX_PENDING_PER_USER} pending link photos: evicted ${evicted.join(', ')}`,
    );
  }
  return fileName;
}

/**
 * The candidates that are images Photos can read, in the page's order,
 * with their previews. Fetched together; one that is refused or unreadable
 * is left out (the fetcher logs why).
 */
async function fetchChoices(
  deps: LinkImportDeps,
  urls: readonly string[],
): Promise<(PhotoChoice & { resource: FetchedResource })[]> {
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const resource = await deps.fetcher.fetch(url, { accept: ['image'] });
        const preview = await deps.photos.preview(imageSource(resource));
        return {
          url,
          resource,
          preview: `data:image/webp;base64,${preview.toString('base64')}`,
        };
      } catch (error) {
        if (
          error instanceof OutboundFetchError ||
          (error instanceof HttpError && error.statusCode < 500)
        ) {
          return undefined;
        }
        throw error;
      }
    }),
  );
  return results.filter((result) => result !== undefined);
}

function imageSource(resource: FetchedResource): ImageSource {
  return {
    stream: Readable.from([resource.body]),
    mimetype: resource.mediaType,
    // For Photos' log lines: the host only, never the path (a product link
    // can carry a token).
    filename: `a photo from ${resource.url.hostname}`,
  };
}

/**
 * The page as text: UTF-8, unless its content type names another charset
 * that TextDecoder knows (an unknown label falls back to UTF-8).
 */
function pageText({ body, charset }: FetchedResource): string {
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(body);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return body.toString('utf8');
}
