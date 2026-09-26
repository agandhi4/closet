import type { FastifyRequest } from 'fastify';

/**
 * `scheme://host[:port]` of an absolute URL, with the default port dropped
 * (what a browser puts in an Origin header), or undefined for anything that
 * is not an absolute http(s) URL, including the opaque origin `null`.
 */
export function originOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  return parsed.origin;
}

/**
 * The origin this request was addressed to, as Fastify sees it:
 * `request.protocol` and `request.host` read X-Forwarded-Proto/-Host only
 * from a peer listed in TRUSTED_PROXIES (trustProxy in createApp), so a
 * client cannot choose the answer by sending those headers itself.
 * Used by the same-origin check, the page context's canonical URL and the
 * invite links.
 */
export function requestOrigin(
  request: Pick<FastifyRequest, 'protocol' | 'host'>,
): string {
  const raw = `${request.protocol}://${request.host}`;
  return originOf(raw) ?? raw;
}
