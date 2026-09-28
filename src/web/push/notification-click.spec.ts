import { describe, expect, it } from 'vitest';
import {
  type AppWindow,
  type AppWindows,
  openNotification,
} from './notification-click';

const ORIGIN = 'https://closet.test';

/**
 * Open windows of the app, recording what the click did to them. `navigates`
 * false is a browser that declines to navigate one (navigate() resolves
 * null, older WebKit).
 */
function windowsAt(urls: string[], options: { navigates?: boolean } = {}) {
  const actions: string[] = [];
  const open = urls.map((url, index): AppWindow => {
    const window: AppWindow = {
      url,
      focus: () => {
        actions.push(`focus ${index}`);
        return Promise.resolve(window);
      },
      navigate: (target) => {
        actions.push(`navigate ${index} ${target}`);
        return Promise.resolve(options.navigates === false ? null : window);
      },
    };
    return window;
  });
  const windows: AppWindows = {
    matchAll: () => Promise.resolve(open),
    openWindow: (target) => {
      actions.push(`open ${target}`);
      return Promise.resolve(null);
    },
  };
  return { windows, actions };
}

describe('openNotification', () => {
  it('focuses a window already showing the page, without reloading it', async () => {
    const { windows, actions } = windowsAt([
      `${ORIGIN}/wardrobe`,
      `${ORIGIN}/calendar`,
    ]);

    await openNotification(windows, { url: '/calendar' }, ORIGIN);

    expect(actions).toEqual(['focus 1']);
  });

  it('brings the first window of the app to the page', async () => {
    const { windows, actions } = windowsAt([
      `${ORIGIN}/wardrobe`,
      `${ORIGIN}/outfits`,
    ]);

    await openNotification(windows, { url: '/' }, ORIGIN);

    expect(actions).toEqual(['focus 0', `navigate 0 ${ORIGIN}/`]);
  });

  it('opens a window when the browser declines to navigate one', async () => {
    const { windows, actions } = windowsAt([`${ORIGIN}/wardrobe`], {
      navigates: false,
    });

    await openNotification(windows, { url: '/' }, ORIGIN);

    expect(actions).toEqual([
      'focus 0',
      `navigate 0 ${ORIGIN}/`,
      `open ${ORIGIN}/`,
    ]);
  });

  it('opens a window when the app has none', async () => {
    const { windows, actions } = windowsAt([]);

    await openNotification(
      windows,
      { url: '/calendar?week=2026-09-28' },
      ORIGIN,
    );

    expect(actions).toEqual([`open ${ORIGIN}/calendar?week=2026-09-28`]);
  });

  it.each([
    ['another origin', { url: 'https://evil.test/phish' }],
    ['no url', { title: 'Today' }],
    ['no data', null],
  ])('opens the app root for a notification with %s', async (_, data) => {
    const { windows, actions } = windowsAt([]);

    await openNotification(windows, data, ORIGIN);

    expect(actions).toEqual([`open ${ORIGIN}/`]);
  });
});
