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
    icons: [
      {
        src: `/assets/${iconName}`,
        sizes: '1000x1000',
        type: 'image/png',
        purpose: 'maskable any',
      },
    ],
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
    description: 'Wardrobe organizer: garments, outfits, and a calendar.',
    screenshots: [
      {
        src: '/assets/screenshots/Screenshot_1.webp',
        sizes: '2300x2034',
        type: 'image/webp',
        form_factor: 'wide',
        label: 'Wardrobe view with garment catalog',
      },
      {
        src: '/assets/screenshots/Screenshot_mobile_1.webp',
        sizes: '1179x2556',
        type: 'image/webp',
        form_factor: 'narrow',
        label: 'Wardrobe view on mobile',
      },
    ],
    categories: ['lifestyle', 'utilities'],
  };
}
