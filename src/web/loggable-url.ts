import type { FastifyRequest } from 'fastify';
import { scrubSecrets } from '../secret-text';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The path carries a secret (an invite token): log lines show the route
     * pattern (`/wardrobe-share/invite/:token`) instead of the URL. Logs
     * reach Loki (and a LOG_FILE).
     */
    secretPath?: boolean;
  }
}

/**
 * The URL to write into a log line about this request: the route pattern
 * for a route marked `config: { secretPath: true }`, else the raw URL with
 * any credential shape in it filtered (scrubSecrets: a personal access
 * token or a JWT a client put in the query string, on any path, a matched
 * one or not). Every log line in src/web/ that names a request goes
 * through this.
 */
export function loggableUrl(
  request: Pick<FastifyRequest, 'url' | 'routeOptions'>,
): string {
  const { config, url } = request.routeOptions;
  return config?.secretPath === true && url ? url : scrubSecrets(request.url);
}
