import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route (or a whole controller) out of SessionGuard, the global guard
 * that otherwise requires a signed-in user on every Nest route. Only for what
 * an anonymous visitor must reach: login and registration, the health probe,
 * the manifest, the public share pages and the image routes.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
