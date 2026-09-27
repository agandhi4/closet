import { APP_ICON_SIZES, appIconFile } from '../app-icon';
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
    id: '/wardrobe',
    start_url: '/wardrobe',
    theme_color: '#222428',
    background_color: '#fafafa',
    display: 'standalone',
    scope: '/',
    shortcuts: [
      {
        name: 'My Wardrobe',
        short_name: 'Wardrobe',
        description: 'Browse your clothing items',
        url: '/wardrobe',
      },
      {
        name: 'My Outfits',
        short_name: 'Outfits',
        description: 'Browse your saved outfits',
        url: '/outfits',
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
