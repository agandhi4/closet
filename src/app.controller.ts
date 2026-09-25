import {
  Controller,
  Get,
  Header,
  HttpCode,
  Redirect,
  Render,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';
import { I18n, I18nContext } from 'nestjs-i18n';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
  ) {}

  // There is no landing page: the wardrobe is the app. ConditionalAuthGuard on
  // the wardrobe controller sends unauthenticated visitors on to /auth/login.
  @Get()
  @Redirect('/wardrobe', 302)
  index(): void {}

  // public/manifest.json was deleted so this route is not shadowed by the
  // static-asset handler in app.ts. no-cache (revalidate, like sw.js): the
  // installed app must pick up APP_NAME/ICON_NAME changes on its next check.
  @Get('manifest.json')
  @Header('Content-Type', 'application/manifest+json; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  manifest(): Record<string, unknown> {
    return this.appService.getWebManifest();
  }

  // Heartbeat for public/js/connectivity.js: the client decides it is online
  // only when this answers, never from navigator.onLine. Listed in
  // STATIC_FILES so the session hook skips it, and no-store so neither the
  // HTTP cache nor the service worker can answer on the server's behalf.
  @Get('healthz')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  healthz(): void {}

  @Get('about')
  @Render('about')
  about(@I18n() i18n: I18nContext): any {
    const appName = this.configService.get<string>('APP_NAME');
    return {
      pageTitle: i18n.t('lang.ABOUT_TITLE'),
      ogTitle: i18n.t('lang.ABOUT_OG_TITLE', { args: { appName } }),
      ogDescription: i18n.t('lang.ABOUT_OG_DESC', { args: { appName } }),
    };
  }

  @Get('offline.html')
  @Render('offline')
  getOffline() {}

  @Get('.well-known/*')
  well_known() {
    return {}; // Just return empty object
  }
}
