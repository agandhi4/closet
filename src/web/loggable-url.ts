import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The path carries a secret (an invite token): log lines show the route
     * pattern (`/wardrobe-share/invite/:token`) instead of the URL. Logs
     * reach app.log under DATA_PATH and Loki.
     */
    secretPath?: boolean;
  }
}

/**
 * The URL to write into a log line about this request: the raw URL, or the
 * route pattern for a route marked `config: { secretPath: true }`. Every
 * log line in src/web/ that names a request goes through this.
 */
export function loggableUrl(
  request: Pick<FastifyRequest, 'url' | 'routeOptions'>,
): string {
  const { config, url } = request.routeOptions;
  return config?.secretPath === true && url ? url : request.url;
}
