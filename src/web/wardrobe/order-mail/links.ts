import { scanDocument } from '../link-import/html';

/**
 * The links in a forwarded order email the poll may fetch (#25; plan
 * docs/plans/2026-09-28-order-email-import.md, Links; #698). Pure. The
 * body is a stranger's (a retailer's, forwarded) and is never rendered:
 * HTML parts are read by the link import's linear tag scanner (its
 * `links`), text parts by one bounded regex, and nothing here throws on
 * any input.
 *
 * A fetch is a GET the retailer sees as a click, and a "Cancel this order",
 * "Confirm your email" or single-use "View your order" link acts on one, so
 * the rule is an allowlist judged before anything is fetched (judgeLink),
 * and it fails closed (#946). Each link is unwrapped from the query of a
 * redirector that carries its target in plain sight (`?url=https%3A...`,
 * Google's `?q=`, Outlook's safe links), up to MAX_UNWRAP_DEPTH wrappers;
 * the target must be a product link (`isProductLink`: https, a product
 * path, nothing the deny rules refuse). An opaque click tracker (a target
 * only its redirect tells) is never fetched: it records the click on the
 * first request, whatever its anchor says. A shop whose product addresses
 * have none of these shapes, or that wraps every link in an opaque
 * tracker, lists nothing: a manual "Add from a link". The poll passes
 * `isProductLink` as the fetcher's `mayFollow`, so every redirect of a
 * product page must be one too, and keeps a product only where the fetch
 * ended on one. Anything else is never fetched, only counted (`skipped`).
 * A link's query is left as written; tracking parameters come off the
 * product page's own address (normalizedLink), which is what is stored.
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

export interface EmailLinks {
  /** What the poll fetches, best first. */
  links: string[];
  /** The email's other web links, each once: refused, or past a cap. */
  skipped: number;
}

/** A link as the poll judges it, unwrapped and without its fragment. */
export interface JudgedLink {
  link: string;
  kind: 'product' | 'refused';
}

/** The email's links to fetch, and how many of its others were not. */
export function emailLinks(parts: readonly BodyPart[]): EmailLinks {
  const products = new Set<string>();
  const refused = new Set<string>();
  for (const href of parts.flatMap(partLinks)) {
    const verdict = judgeLink(href);
    if (verdict) {
      (verdict.kind === 'product' ? products : refused).add(verdict.link);
    }
  }
  const links = [...products].slice(0, MAX_LINKS_PER_EMAIL);
  return { links, skipped: products.size + refused.size - links.length };
}

function partLinks(part: BodyPart): readonly string[] {
  return part.type === 'text/html'
    ? scanDocument(part.value).links
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
 * `href` judged before any fetch (unwrapped, without its fragment);
 * undefined for one that is not an http(s) link at all.
 */
export function judgeLink(href: string): JudgedLink | undefined {
  const url = parseHttp(href);
  if (!url) return undefined;
  const target = canonicalUrl(unwrap(url));
  return {
    link: target.href,
    kind: productShape(target) ? 'product' : 'refused',
  };
}

/**
 * A product page's address by its shape alone: https, a product path, and
 * nothing the deny rules refuse in its host, path or query. The poll's
 * `mayFollow` for every redirect, and its test of where a fetch ended.
 */
export function isProductLink(url: URL): boolean {
  return productShape(canonicalUrl(url));
}

/**
 * One form of an address for every check (#949): no fragment, and the path's
 * percent-escapes of unreserved characters decoded (`/%63ancel` is `/cancel`
 * to the server, so to the deny rules). The host is already lower case. A
 * check never reads an address that did not pass through here; the checks
 * below take the canonical URL and decode nothing themselves.
 */
function canonicalUrl(url: URL): URL {
  const canonical = new URL(url.href);
  canonical.hash = '';
  canonical.pathname = canonical.pathname.replace(
    /%([0-7][0-9A-F])/gi,
    (escape, hex: string) => {
      const char = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9._~-]/.test(char) ? char : escape;
    },
  );
  return canonical;
}

function productShape(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    isProductPath(url.pathname) &&
    !isTracker(url) &&
    !excluded(url) &&
    !refusedQuery(url)
  );
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

// A host's first label, a word of any path segment (split on non-letters,
// so `cancel-order` and `confirm-email` are refused, and `confirm-hoodie`
// too: an accepted false refusal, fail closed #946), or a product path's
// query key or whole value that names a page about the order or the
// account, or an action, rather than a product.
const EXCLUDED_WORDS = new Set([
  'account',
  'accounts',
  'my-account',
  'myaccount',
  'your-account',
  'login',
  'signin',
  'sign-in',
  'logout',
  'signout',
  'sign-out',
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
  'subscribe',
  'preferences',
  'email-preferences',
  'manage',
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
  // #698: one-click actions and sign-in links.
  'cancel',
  'cancellation',
  'confirm',
  'confirmation',
  'verify',
  'verification',
  'review',
  'reviews',
  'write-a-review',
  'feedback',
  'survey',
  'checkout',
  'cart',
  'basket',
  'pay',
  'payment',
  'payments',
  'reset',
  'password',
  'auth',
  'oauth',
  'magic',
  'magic-link',
  'token',
  'session',
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
  return (
    safeDecode(url.pathname).toLowerCase().split('/').some(namesExcludedWord) ||
    isAmazonServicePath(url.pathname) ||
    url.searchParams.has('unsubscribe')
  );
}

// Opaque click trackers, whose target only their redirect tells: SendGrid's
// `/ls/click` and `/wf/click`, Amazon SES's `/CL0/`, and a `click.` or
// `links.` host. Never a product, whatever else their path says (#946): a
// fetch is the click they record.
const TRACKER_PATH = /^\/(?:ls|wf)\/click(?:\/|$)|\/CL0(?:\/|$)/i;
const TRACKER_HOSTS = new Set(['click', 'links']);

function isTracker(url: URL): boolean {
  return (
    TRACKER_PATH.test(url.pathname) ||
    TRACKER_HOSTS.has(url.hostname.toLowerCase().split('.')[0])
  );
}

function namesExcludedWord(segment: string): boolean {
  return (
    EXCLUDED_WORDS.has(segment) ||
    segment.split(/[^a-z]+/).some((word) => EXCLUDED_WORDS.has(word))
  );
}

// Amazon's account, order and tracker pages live under /gp/ (/gp/css/...,
// /gp/your-account/..., /gp/r.html); only /gp/product/<ASIN> is a product.
function isAmazonServicePath(pathname: string): boolean {
  const [, first, second] = pathname.toLowerCase().split('/');
  return first === 'gp' && second !== 'product';
}

// A product path's query keys that carry a credential or name an action,
// matched whole and case-insensitively (tracking parameters aside). Fail closed: `?code=SAVE10` (a
// discount) is refused with a one-time sign-in's `?code=`.
const REFUSED_PARAMETERS = new Set([
  'token',
  'access_token',
  'auth',
  'authtoken',
  'key',
  'apikey',
  'sig',
  'signature',
  'session',
  'sessionid',
  'sid',
  'otp',
  'code',
  'magic',
  'login',
  'nonce',
  'ticket',
  'jwt',
  'action',
  'op',
  'do',
  'cmd',
  'command',
]);

function refusedQuery(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    // A campaign tag's value is a label (`utm_medium=order`), never an act.
    if (isTrackingParameter(name)) continue;
    if (
      REFUSED_PARAMETERS.has(name) ||
      EXCLUDED_WORDS.has(name) ||
      EXCLUDED_WORDS.has(value.trim().toLowerCase())
    ) {
      return true;
    }
  }
  return false;
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

// Paths retailers give product pages: a /p/, /dp/ (Amazon), /product(s)/
// or /item(s)/ segment, or a last segment naming the SKU as a page
// (`shirt-p01234567.html`, Zara; `productpage.0970819001.html`, H&M). A
// bare numeric id is no product: order, unsubscribe and sign-in links
// carry those too (`/u/1234567890`).
const PRODUCT_SEGMENT =
  /\/(?:p|dp|pd|pdp|prod|product|products|item|items)(?:\/|$)/i;
const SKU_PAGE = /\d{5,}[^/]*\.html?$/i;

function isProductPath(pathname: string): boolean {
  return (
    PRODUCT_SEGMENT.test(pathname) ||
    SKU_PAGE.test(pathname.slice(pathname.lastIndexOf('/') + 1))
  );
}
