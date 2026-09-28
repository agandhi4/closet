/**
 * Whether a forwarded email is the owner's (#25; plan
 * docs/plans/2026-09-28-order-email-import.md, Trust check). Pure. Anyone
 * can send mail to the order account, and a From header is only a claim,
 * so an email is read only when:
 *
 * - its From is exactly one address, one of ORDER_MAIL_SENDERS; and
 * - the topmost Authentication-Results, the one Fastmail's own MX added
 *   (its authserv-id ends in FASTMAIL_AUTHSERV), says DKIM, SPF or DMARC
 *   passed for a domain aligned with the From address's domain (equal, or
 *   one a subdomain of the other).
 *
 * Only the topmost header counts: a receiving server adds its own above
 * whatever the message arrived with, so any lower one may be the sender's
 * forgery. A mailbox's auto-forward rule keeps the retailer as From, so
 * only mail the owner forwarded by hand passes; that is by design.
 */

/** Fastmail's MX hosts (mx1.messagingengine.com ...) name themselves so. */
export const FASTMAIL_AUTHSERV = 'messagingengine.com';

export interface SenderEvidence {
  /** JMAP's parsed From: its addresses (null for a group or none). */
  from: readonly { email: string | null }[] | null;
  /** Every Authentication-Results header as text, topmost first. */
  authenticationResults: readonly string[];
}

export type UntrustedReason =
  | 'no-single-sender'
  | 'sender-not-allowed'
  | 'no-authentication-results'
  | 'foreign-authserv'
  | 'authentication-failed';

export type TrustVerdict =
  | { trusted: true; sender: string }
  | {
      trusted: false;
      reason: UntrustedReason;
      /** The From domain, for the log line; never the address. */
      domain: string | null;
    };

export function judgeSender(
  { from, authenticationResults }: SenderEvidence,
  allowedSenders: readonly string[],
): TrustVerdict {
  const addresses = (from ?? [])
    .map((address) => address.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  if (addresses.length !== 1) {
    return {
      trusted: false,
      reason: 'no-single-sender',
      domain: addresses[0] ? domainOf(addresses[0]) : null,
    };
  }
  const sender = addresses[0];
  const domain = domainOf(sender);
  const refuse = (reason: UntrustedReason): TrustVerdict => ({
    trusted: false,
    reason,
    domain,
  });
  if (!allowedSenders.includes(sender)) return refuse('sender-not-allowed');
  const topmost = authenticationResults[0];
  if (topmost === undefined) return refuse('no-authentication-results');
  const results = parseAuthenticationResults(topmost);
  if (!isFastmail(results.authservId)) return refuse('foreign-authserv');
  return domain !== null && passesFor(results.methods, domain)
    ? { trusted: true, sender }
    : refuse('authentication-failed');
}

export interface MethodResult {
  /** `dkim`, `spf`, `dmarc` ... lower case. */
  method: string;
  /** `pass`, `fail`, `none` ... lower case. */
  result: string;
  /** `header.d`, `smtp.mailfrom`, `header.from` ... keys lower case. */
  properties: ReadonlyMap<string, string>;
}

export interface AuthenticationResults {
  authservId: string;
  methods: MethodResult[];
}

const MAX_HEADER_LENGTH = 16_384;
const METHOD = /^\s*([a-z0-9_.-]+)\s*=\s*([a-z0-9_-]+)/i;
const PROPERTY = /([a-z0-9_-]+)\.([a-z0-9_.-]+)\s*=\s*"?([^\s";]+)"?/gi;

/**
 * RFC 8601's `authserv-id; method=result ptype.property=value ...; ...`,
 * comments removed. Lenient: an unreadable piece is skipped, never thrown.
 */
export function parseAuthenticationResults(
  header: string,
): AuthenticationResults {
  const [head = '', ...pieces] = withoutComments(
    header.slice(0, MAX_HEADER_LENGTH),
  ).split(';');
  const methods: MethodResult[] = [];
  for (const piece of pieces) {
    const match = METHOD.exec(piece);
    if (!match) continue;
    const properties = new Map<string, string>();
    for (const [, ptype, property, value] of piece
      .slice(match[0].length)
      .matchAll(PROPERTY)) {
      properties.set(
        `${ptype.toLowerCase()}.${property.toLowerCase()}`,
        value.toLowerCase(),
      );
    }
    methods.push({
      method: match[1].toLowerCase(),
      result: match[2].toLowerCase(),
      properties,
    });
  }
  return {
    authservId: head.trim().split(/\s+/)[0]?.toLowerCase() ?? '',
    methods,
  };
}

/** `(...)` comments dropped, nested ones too, in one pass. */
function withoutComments(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

function isFastmail(authservId: string): boolean {
  return (
    authservId === FASTMAIL_AUTHSERV ||
    authservId.endsWith(`.${FASTMAIL_AUTHSERV}`)
  );
}

// Each method's property that names the domain it vouched for.
const VOUCHED_DOMAIN: Readonly<Record<string, string>> = {
  dkim: 'header.d',
  spf: 'smtp.mailfrom',
  dmarc: 'header.from',
};

function passesFor(methods: readonly MethodResult[], domain: string): boolean {
  return methods.some(({ method, result, properties }) => {
    const property = VOUCHED_DOMAIN[method];
    const vouched = property && properties.get(property);
    return result === 'pass' && vouched && aligned(domainOf(vouched), domain);
  });
}

/** An address's domain, or a bare domain as it is; lower case. */
function domainOf(value: string): string | null {
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  return domain || null;
}

function aligned(vouched: string | null, from: string): boolean {
  return (
    vouched !== null &&
    (vouched === from ||
      from.endsWith(`.${vouched}`) ||
      vouched.endsWith(`.${from}`))
  );
}
