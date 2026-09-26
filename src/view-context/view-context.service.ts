import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import { I18nContext, I18nService } from 'nestjs-i18n';
import { AuthContext } from '../auth/auth-context.service';
import { BUILD_INFO } from '../build-info';
import { requestOrigin } from '../web/security/origin';
import type { ViewContext } from '../web/view-context';

const OG_LOCALES: Record<string, string> = {
  en: 'en_US',
  ru: 'ru_RU',
  es: 'es_ES',
  fr: 'fr_FR',
  it: 'it_IT',
  de: 'de_DE',
};

/**
 * Builds the template context exposed as `reply.locals` by the preValidation
 * hook in app.ts. The session comes in as an argument: this service must not
 * read the cookie or load the user itself (AuthContextService already did).
 */
@Injectable()
export class ViewContextService {
  constructor(
    private readonly configService: ConfigService,
    private readonly i18n: I18nService,
  ) {}

  buildContext(
    req: FastifyRequest,
    auth: AuthContext | undefined,
  ): ViewContext {
    const locale = I18nContext.current()?.lang ?? 'en';
    const path = req.url.split('?')[0];
    // Forwarded headers only count from TRUSTED_PROXIES (requestOrigin); a
    // client's own X-Forwarded-Host must not rewrite canonical and og URLs.
    const origin = requestOrigin(req);
    const canonicalUrl = `${origin}${path}`;

    const siteUrl = this.configService.get<string>('SITE_URL') ?? origin;
    const appName = this.configService.getOrThrow<string>('APP_NAME');
    const iconName = this.configService.getOrThrow<string>('ICON_NAME');
    const appDescription = this.i18n.t('lang.APP_DESCRIPTION', {
      lang: locale,
    });

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
      locale,
      canonicalUrl,
      ogUrl: canonicalUrl,
      ogLocale: OG_LOCALES[locale] ?? 'en_US',
      ogTitle: appName,
      ogDescription: appDescription,
      ogImage: `${origin}/assets/${iconName}`,
      user: auth?.user,
    };
  }
}
