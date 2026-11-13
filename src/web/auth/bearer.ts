import type { FastifyRequest } from 'fastify';

/** RFC 6750's header: the scheme matched in any case, one token, nothing after. */
const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * What a request's `Authorization` header presents: a token, or why there
 * is none to try. A bearer surface (/mcp, /api) answers every refusal with
 * the same 401, so the reason is only for its log line.
 */
export type PresentedBearer =
  | { token: string }
  | { refused: 'no bearer token' | 'malformed header' | 'duplicate header' };

/**
 * The bearer token in `Authorization`, deterministically: two headers are a
 * refusal, never the first or the last (Node keeps the first in `headers`
 * and drops the rest, so the count is taken from `rawHeaders`), and two
 * values folded into one (`Bearer a, Bearer b`) are malformed. Never read
 * from a cookie or the query string.
 */
export function presentedBearer(
  request: Pick<FastifyRequest, 'headers' | 'raw'>,
): PresentedBearer {
  const header = request.headers.authorization;
  if (header === undefined) return { refused: 'no bearer token' };
  if (authorizationHeaders(request) > 1) {
    return { refused: 'duplicate header' };
  }
  const token = BEARER.exec(header)?.[1];
  return token === undefined ? { refused: 'malformed header' } : { token };
}

function authorizationHeaders(request: Pick<FastifyRequest, 'raw'>): number {
  const raw = request.raw.rawHeaders;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'authorization') count += 1;
  }
  return count;
}
