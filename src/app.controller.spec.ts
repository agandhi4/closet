import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppController } from './app.controller';
import { I18nContext } from 'nestjs-i18n';
import { AppService } from './app.service';
import { ConfigService } from '@nestjs/config';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue('Closet'),
            getOrThrow: vi.fn((key: string) =>
              key === 'ICON_NAME' ? 'icon.png' : 'Closet',
            ),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('about', () => {
    it('translates the page title and passes the app name to the OG strings', () => {
      const t = vi.fn((key: string) => key);
      const i18n = { t } as unknown as I18nContext;
      expect(appController.about(i18n)).toEqual({
        pageTitle: 'lang.ABOUT_TITLE',
        ogTitle: 'lang.ABOUT_OG_TITLE',
        ogDescription: 'lang.ABOUT_OG_DESC',
      });
      expect(t).toHaveBeenCalledWith('lang.ABOUT_OG_TITLE', {
        args: { appName: 'Closet' },
      });
      expect(t).toHaveBeenCalledWith('lang.ABOUT_OG_DESC', {
        args: { appName: 'Closet' },
      });
    });
  });

  describe('manifest', () => {
    it('builds the web manifest from APP_NAME and ICON_NAME', () => {
      const manifest = appController.manifest();
      expect(manifest.name).toBe('Closet');
      expect(manifest.short_name).toBe('Closet');
      expect(manifest.icons).toEqual([
        {
          src: '/assets/icon.png',
          sizes: '1000x1000',
          type: 'image/png',
          purpose: 'maskable any',
        },
      ]);
      expect(manifest.start_url).toBe('/wardrobe');
    });
  });
});
