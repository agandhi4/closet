import {
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { signIn } from './support/e2e-session';

/**
 * The install dialog (<pwa-install>, public/js/pwa.js) costs only the loads
 * that can offer an install (issue #4). The installed app, where the
 * household lives, never loads it: no bundle, no /manifest.json fetch of its
 * own, no icon (the service worker no longer precaches it either). Where a
 * browser does offer installing, the dialog still appears and installs.
 *
 * Playwright runs Chromium only here, so the other browsers are Chromium
 * dressed as them: Safari on iPhone is its user agent and platform without
 * beforeinstallprompt (plus navigator.standalone, which only iOS has), and
 * Chromium is never offered an install in headless mode, so the specs
 * dispatch the event Chrome would.
 *
 * Needs a server started with PWA_ENABLED=true (pwa.js is loaded only then).
 */
test.describe('install dialog', () => {
  test.skip(
    process.env.PWA_ENABLED !== 'true',
    'needs a server started with PWA_ENABLED=true',
  );
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Chromium stands in for the other browsers here',
  );

  const IPHONE = devices['iPhone 12'];
  const PIXEL = devices['Pixel 5'];
  const DESKTOP_FIREFOX = devices['Desktop Firefox'];

  /** Safari on iPhone: no beforeinstallprompt; `standalone` as iOS sets it. */
  async function actAsIPhoneSafari(page: Page, standalone: boolean) {
    await page.addInitScript((standalone) => {
      delete (window as { BeforeInstallPromptEvent?: unknown })
        .BeforeInstallPromptEvent;
      Object.defineProperty(Navigator.prototype, 'platform', {
        get: () => 'iPhone',
      });
      Object.defineProperty(Navigator.prototype, 'standalone', {
        get: () => standalone,
      });
    }, standalone);
  }

  /** The installed app on Android: display-mode standalone. */
  async function actAsInstalledAndroidApp(page: Page) {
    await page.addInitScript(() => {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query.includes('display-mode: standalone')
          ? ({
              matches: true,
              media: query,
              onchange: null,
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
              addListener: () => undefined,
              removeListener: () => undefined,
              dispatchEvent: () => false,
            } as MediaQueryList)
          : matchMedia(query);
    });
  }

  /** Every path the context requests, the service worker's included. */
  function recordPaths(context: BrowserContext): string[] {
    const paths: string[] = [];
    context.on('request', (request) => {
      paths.push(new URL(request.url()).pathname);
    });
    return paths;
  }

  /**
   * A cold load of /wardrobe: nothing cached, the worker installing (and
   * precaching) during it. Returns once the worker is active and a lazy
   * import would have had time to start.
   */
  async function coldLoadWardrobe(page: Page): Promise<void> {
    await page.goto('/wardrobe');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForTimeout(1000);
  }

  function expectNoInstallDialogCost(paths: string[]) {
    expect(paths.filter((path) => path.startsWith('/assets/'))).toEqual([]);
    expect(paths.filter((path) => path.includes('pwa-install'))).toEqual([]);
    // The browser may read the manifest itself; the dialog would read it
    // again (twice, in fact).
    expect(
      paths.filter((path) => path === '/manifest.json').length,
    ).toBeLessThanOrEqual(1);
  }

  test.describe('installed on an Android phone', () => {
    test.use({
      userAgent: PIXEL.userAgent,
      viewport: PIXEL.viewport,
      isMobile: true,
      hasTouch: true,
    });

    test('a cold load fetches neither the icon nor the manifest twice', async ({
      page,
      context,
    }) => {
      await signIn(page, 'install-android');
      const paths = recordPaths(context);
      await actAsInstalledAndroidApp(page);

      await coldLoadWardrobe(page);

      expectNoInstallDialogCost(paths);
      await expect(page.locator('pwa-install')).toHaveCount(0);
    });
  });

  test.describe('on an iPhone', () => {
    test.use({
      userAgent: IPHONE.userAgent,
      viewport: IPHONE.viewport,
      isMobile: true,
      hasTouch: true,
    });

    test('the Home Screen app never loads the dialog', async ({
      page,
      context,
    }) => {
      await signIn(page, 'install-ios-app');
      const paths = recordPaths(context);
      await actAsIPhoneSafari(page, true);

      await coldLoadWardrobe(page);

      expectNoInstallDialogCost(paths);
      await expect(page.locator('pwa-install')).toHaveCount(0);
    });

    test('Safari shows how to add the app to the Home Screen', async ({
      page,
      context,
    }) => {
      await signIn(page, 'install-ios-safari');
      const paths = recordPaths(context);
      await actAsIPhoneSafari(page, false);

      await page.goto('/wardrobe');
      const dialog = page.locator('pwa-install');
      await dialog
        .getByRole('button', { name: 'Add to Home Screen' })
        .filter({ visible: true })
        .click();
      await expect(
        dialog.getByText('Press Share in Navigation bar'),
      ).toBeVisible();

      expect(paths.filter((path) => path.includes('screenshots'))).toEqual([]);
    });
  });

  test.describe('in a desktop browser tab', () => {
    test('Chrome offering the install shows the dialog, and Install prompts', async ({
      page,
      context,
    }) => {
      await signIn(page, 'install-chrome');
      const paths = recordPaths(context);
      await page.goto('/wardrobe');
      await page.evaluate(() => navigator.serviceWorker.ready);
      // Nothing is loaded until Chrome says the app can be installed.
      expect(paths.filter((path) => path.includes('pwa-install'))).toEqual([]);

      await page.evaluate(() => {
        const offer = Object.assign(
          new Event('beforeinstallprompt', { cancelable: true }),
          {
            platforms: ['web'],
            userChoice: Promise.resolve({
              outcome: 'accepted',
              platform: 'web',
            }),
            prompt: () => {
              document.documentElement.dataset.installPrompted = 'yes';
              return Promise.resolve();
            },
          },
        );
        window.dispatchEvent(offer);
      });

      await page
        .locator('pwa-install')
        .getByRole('button', { name: 'Install' })
        .filter({ visible: true })
        .click();
      await expect(page.locator('html')).toHaveAttribute(
        'data-install-prompted',
        'yes',
      );
      expect(paths.filter((path) => path.includes('screenshots'))).toEqual([]);
    });
  });

  test.describe('in a desktop Firefox tab', () => {
    test.use({ userAgent: DESKTOP_FIREFOX.userAgent });

    test('a browser that cannot install never loads the dialog', async ({
      page,
      context,
    }) => {
      await signIn(page, 'install-firefox');
      const paths = recordPaths(context);
      // Firefox has no beforeinstallprompt, and the element no instructions
      // for a desktop that is not a Mac.
      await page.addInitScript(() => {
        delete (window as { BeforeInstallPromptEvent?: unknown })
          .BeforeInstallPromptEvent;
      });

      await coldLoadWardrobe(page);

      expectNoInstallDialogCost(paths);
      await expect(page.locator('pwa-install')).toHaveCount(0);
    });
  });
});
