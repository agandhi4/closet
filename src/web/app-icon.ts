/**
 * Where the app icon's rasters live. ICON_NAME names the full-size one under
 * public/assets/ (1000 px, 45 KB for the default), used only where size pays:
 * Open Graph previews and the share-link watermark. Everything shown small
 * (the manifest's icons, and so the install dialog, which shows the first
 * one at 48 px; the apple-touch-icon) uses its PNG siblings `<stem>-192.png`
 * and `<stem>-512.png`. `npm run generate:icons` writes them for the default
 * icon; a custom ICON_NAME must ship them alongside.
 *
 * Used by src/web/shell/manifest.ts, src/web/layout/layout.tsx and
 * scripts/generate-icons.ts.
 */
export const APP_ICON_SIZES = [192, 512] as const;

export type AppIconSize = (typeof APP_ICON_SIZES)[number];

/** The file name of ICON_NAME's square PNG at `size` px, under public/assets/. */
export function appIconFile(iconName: string, size: AppIconSize): string {
  const stem = iconName.replace(/\.[^.]+$/, '');
  return `${stem}-${size}.png`;
}
