import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppService {
  constructor(private readonly configService: ConfigService) {}

  // Served at GET /manifest.json (AppController). Built at request time so the
  // installed PWA's name and icon follow APP_NAME / ICON_NAME instead of a
  // static file. The service worker (views/assets/src-sw.ts) does not precache
  // it, so the route is the only source.
  getWebManifest(): Record<string, unknown> {
    const appName = this.configService.getOrThrow<string>('APP_NAME');
    const iconName = this.configService.getOrThrow<string>('ICON_NAME');
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
}
