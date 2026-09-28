import { scanDocument } from '../link-import/html';

/**
 * The links in a forwarded order email that may lead to a product page
 * (#25; plan docs/plans/2026-09-28-order-email-import.md, Links). Pure. The
 * body is a stranger's (a retailer's, forwarded) and is never rendered:
 * HTML parts are read by the link import's linear tag scanner (its `hrefs`),
 * text parts by one bounded regex, and nothing here throws on any input.
 *
 * Each link is unwrapped from the query of a redirector that carries its
 * target in plain sight (`?url=https%3A...`, Google's `?q=`, Outlook's safe
 * links), up to MAX_UNWRAP_DEPTH wrappers; an opaque tracker
 * (`click.shop.com/ls/click?upn=...`) is left for the fetcher's own bounded
 * redirect following. Links that cannot be a product (mail, social and app
 * store hosts, account, help, unsubscribe, privacy, order tracking and
 * return pages, a site's home page) are dropped, the fragment is stripped,
 * duplicates go, product-looking paths come first, and at most
 * MAX_LINKS_PER_EMAIL are returned: each one is a fetch. A link's query is
 * left as written (a tracker's may be signed); tracking parameters come off
 * the product page's own address (normalizedLink), which is what is stored.
 */

/** How many of an email's links are fetched. */
export const MAX_LINKS_PER_EMAIL = 12;
const MAX_UNWRAP_DEPTH = 3;
const MAX_URL_LENGTH = 2048;
const MAX_TEXT_LINKS = 200;

/** One of an email's body parts, as JMAP gives it (its value decoded). */
export interface BodyPart {
  /** The part's media type, lower case (`text/html`, `text/plain`). */
  type: string;
  value: string;
}

/** The email's candidate product links, best first, at most MAX_LINKS_PER_EMAIL. */
export function productLinkCandidates(parts: readonly BodyPart[]): string[] {
  const seen = new Set<string>();
  const links: { link: string; score: number }[] = [];
  for (const href of parts.flatMap(partLinks)) {
    const link = candidateLink(href);
    if (link === undefined || seen.has(link)) continue;
    seen.add(link);
    links.push({ link, score: productScore(new URL(link)) });
  }
  // A stable sort: product-looking links first, the email's order otherwise.
  return links
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LINKS_PER_EMAIL)
    .map(({ link }) => link);
}

function partLinks(part: BodyPart): readonly string[] {
  return part.type === 'text/html'
    ? scanDocument(part.value).hrefs
    : textLinks(part.value);
}

const TEXT_LINK = /https?:\/\/[^\s<>"'()[\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"»”’]+$/;

function textLinks(text: string): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(TEXT_LINK)) {
    links.push(match[0].replace(TRAILING_PUNCTUATION, ''));
    if (links.length === MAX_TEXT_LINKS) break;
  }
  return links;
}

/**
 * `href` as the link to fetch: unwrapped and judged, without its fragment;
 * undefined for one that is not http(s) or cannot be a product.
 */
export function candidateLink(href: string): string | undefined {
  const url = parseHttp(href);
  if (!url) return undefined;
  const target = unwrap(url);
  if (excluded(target)) return undefined;
  target.hash = '';
  return target.href;
}

/**
 * A product page's address as stored and compared (the page's own, after
 * redirects): without tracking parameters or the fragment. The query is
 * rebuilt only when a parameter came off.
 */
export function normalizedLink(url: URL): string {
  const clean = new URL(url.href);
  clean.hash = '';
  const tracking = [...clean.searchParams.keys()].filter(isTrackingParameter);
  for (const name of tracking) clean.searchParams.delete(name);
  return clean.href;
}

function parseHttp(value: string): URL | undefined {
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  try {
    return new URL(trimmed);
  } catch {
    return undefined;
  }
}

function unwrap(url: URL): URL {
  let current = url;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const inner = wrappedTarget(current);
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** The first query value that is itself an http(s) link, once or twice encoded. */
function wrappedTarget(url: URL): URL | undefined {
  for (const value of url.searchParams.values()) {
    const inner =
      parseHttp(value) ??
      (/^https?%3a/i.test(value) ? parseHttp(safeDecode(value)) : undefined);
    if (inner) return inner;
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Hosts (and their subdomains) that never sell the garment in the email.
const EXCLUDED_HOSTS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'pinterest.com',
  'tiktok.com',
  'youtube.com',
  'linkedin.com',
  'snapchat.com',
  'threads.net',
  'apps.apple.com',
  'itunes.apple.com',
  'play.google.com',
];

// A host's first label, or a whole path segment, that names a page about
// the order or the account rather than a product.
const EXCLUDED_WORDS = new Set([
  'account',
  'accounts',
  'my-account',
  'myaccount',
  'login',
  'signin',
  'sign-in',
  'register',
  'help',
  'support',
  'faq',
  'contact',
  'contact-us',
  'customer-service',
  'privacy',
  'privacy-policy',
  'terms',
  'unsubscribe',
  'preferences',
  'email-preferences',
  'order',
  'orders',
  'order-status',
  'track',
  'tracking',
  'return',
  'returns',
  'stores',
  'store-locator',
  'view-in-browser',
]);

function excluded(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return true;
  }
  if (EXCLUDED_WORDS.has(host.split('.')[0])) return true;
  // A site's home page (its campaign tags aside) is never the product.
  if (
    url.pathname === '/' &&
    [...url.searchParams.keys()].every(isTrackingParameter)
  ) {
    return true;
  }
  const segments = url.pathname.toLowerCase().split('/');
  return (
    segments.some((segment) => EXCLUDED_WORDS.has(segment)) ||
    url.searchParams.has('unsubscribe')
  );
}

function isTrackingParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('utm_') ||
    lower.startsWith('mc_') ||
    lower.startsWith('_hs') ||
    TRACKING_PARAMETERS.has(lower)
  );
}

const TRACKING_PARAMETERS = new Set([
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'cmpid',
  'cm_mmc',
]);

// Paths retailers give product pages: /p/, /dp/ (Amazon), /product(s)/,
// /item/, or a long numeric id (a SKU).
const PRODUCT_PATH =
  /\/(?:p|dp|pd|pdp|prod|product|products|item|items)(?:\/|$)|\d{5,}/i;

function productScore(url: URL): number {
  return PRODUCT_PATH.test(url.pathname) ? 1 : 0;
}
