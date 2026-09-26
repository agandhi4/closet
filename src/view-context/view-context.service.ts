import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { BUILD_INFO } from '../build-info';
import type { AuthContext } from '../web/auth/session';
import { requestOrigin } from '../web/security/origin';
import type { ViewContext } from '../web/view-context';

/**
 * Builds the template context exposed as `reply.locals` by the preValidation
 * hook in app.ts. The session comes in as an argument: this service must not
 * read the cookie or load the user itself (the session resolver already did).
 */
@Injectable()
export class ViewContextService {
  constructor(private readonly configService: ConfigService) {}

  buildContext(
    req: FastifyRequest,
    auth: AuthContext | undefined,
  ): ViewContext {
    const path = req.url.split('?')[0];
    // Forwarded headers only count from TRUSTED_PROXIES (requestOrigin); a
    // client's own X-Forwarded-Host must not rewrite canonical and og URLs.
    const origin = requestOrigin(req);
    const canonicalUrl = `${origin}${path}`;

    const siteUrl = this.configService.get<string>('SITE_URL') ?? origin;
    const appName = this.configService.getOrThrow<string>('APP_NAME');
    const iconName = this.configService.getOrThrow<string>('ICON_NAME');

    return {
      appName,
      iconName,
      siteUrl,
      baseUrl: req.url === '/' ? '' : req.url,
      signupsDisabled: this.configService.getOrThrow<boolean>(
        'DISABLE_REGISTRATION',
      ),
      pwaEnabled: this.configService.getOrThrow<boolean>('PWA_ENABLED'),
      appVersion: BUILD_INFO.assetVersion,
      appRelease: BUILD_INFO.version,
      canonicalUrl,
      ogUrl: canonicalUrl,
      ogImage: `${origin}/assets/${iconName}`,
      user: auth?.user,
    };
  }
}
