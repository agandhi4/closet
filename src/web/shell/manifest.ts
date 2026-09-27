import { APP_ICON_SIZES, appIconFile } from '../app-icon';
import { THEME_BASE_100 } from '../theme-colors';
import { LINK_IMPORT_PATH } from '../wardrobe/urls';

/**
 * The web app manifest, served at GET /manifest.json (routes.tsx). Built
 * from config so the installed PWA's name and icon follow APP_NAME and
 * ICON_NAME; there is no public/manifest.json (the static handler would
 * shadow the route), and the service worker does not precache it.
 */
export function webManifest(config: {
  appName: string;
  iconName: string;
}): Record<string, unknown> {
  const { appName, iconName } = config;
  return {
    short_name: appName,
    name: appName,
    // Smallest first: <pwa-install> shows icons[0] (at 48 px) and fetches
    // nothing else. The 1000 px ICON_NAME is left to link previews.
    icons: APP_ICON_SIZES.map((size) => ({
      src: `/assets/${appIconFile(iconName, size)}`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'maskable any',
    })),
    // The app's identity since it was first installed: never changes, or
    // every installed app becomes another one (the Web Install API reads it
    // too). Where it opens can (#15).
    id: '/wardrobe',
    start_url: '/',
    // One value each, so the light theme's page colour: the navbar's
    // (the title bar blends into it) and the splash screen's.
    theme_color: THEME_BASE_100.light,
    background_color: THEME_BASE_100.light,
    display: 'standalone',
    scope: '/',
    shortcuts: [
      {
        name: 'Today',
        short_name: 'Today',
        description: "Today's outfit",
        url: '/',
      },
      {
        name: 'My Wardrobe',
        short_name: 'Wardrobe',
        description: 'Browse your clothing items',
        url: '/wardrobe',
      },
      {
        // Styling (#42), the dock's Style: composing an outfit is the
        // shortcut; Outfits is a tap away in the dock.
        name: 'Style an outfit',
        short_name: 'Style',
        description: 'Compose an outfit from your wardrobe',
        url: '/styling',
      },
      {
        name: 'Add Garment',
        short_name: 'Add Garment',
        description: 'Catalog a new clothing item',
        url: '/wardrobe/new',
      },
    ],
    // Android's share sheet: "Share" on a product page in any app opens the
    // link import with the page's link (in `url`, or inside `text` after
    // the title, depending on the app). GET, so the link page fetches
    // nothing until the person taps Fetch. iOS has no share targets.
    share_target: {
      action: LINK_IMPORT_PATH,
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    },
    description: 'Wardrobe organizer: garments, outfits, and a calendar.',
    // No `screenshots` (issue #4): the install dialogs (the browser's and
    // <pwa-install>) would fetch them for a household whose phones already
    // have the app.
    categories: ['lifestyle', 'utilities'],
  };
}
