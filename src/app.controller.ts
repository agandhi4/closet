import {
  Body,
  Controller,
  Get,
  Header,
  Logger,
  Post,
  Redirect,
  Render,
  Sse,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import { AppService } from './app.service';
import { I18n, I18nContext } from 'nestjs-i18n';

@Controller()
export class AppController {
  private logger = new Logger(AppController.name);

  private message$ = new Subject<string>();

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
  // static-asset handler in app.ts.
  @Get('manifest.json')
  @Header('Content-Type', 'application/manifest+json; charset=utf-8')
  manifest(): Record<string, unknown> {
    return this.appService.getWebManifest();
  }

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

  @Get('chat')
  @Render('chat')
  getChat(): any {
    return {
      message: this.appService.getHello(),
    };
  }

  @Get('offline.html')
  @Render('offline')
  getOffline() {}

  @Sse('sse')
  getChatStream() {
    return this.message$;
  }

  @Post('message')
  async postMessages(@Body() body: any) {
    const message = body.message as string;
    this.message$.next(`
      <div class='chat chat-end'>
        <div class='chat-header'>
          User
        </div>
        <div class='chat-bubble'>${message}</div>
      </div>
      `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.message$.next(`
      <div class='chat chat-start'>
        <div class='chat-header'>
          Assistant
        </div>
        <div class='chat-bubble'>1</div>
      </div>
      `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.message$.next(`
      <div class='chat chat-start'>
        <div class='chat-header'>
          Assistant
        </div>
        <div class='chat-bubble'>2</div>
      </div>
      `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.message$.next(`
      <div class='chat chat-start'>
        <div class='chat-header'>
          Assistant
        </div>
        <div class='chat-bubble'>3</div>
      </div>
      `);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.message$.next(`
      <div class='chat chat-start'>
        <div class='chat-header'>
          Assistant
        </div>
        <div class='chat-bubble'>Hello World</div>
      </div>
      `);
    this.logger.debug(`done with ${this.postMessages.name}`);
  }

  @Get('.well-known/*')
  well_known() {
    return {}; // Just return empty object
  }
}
