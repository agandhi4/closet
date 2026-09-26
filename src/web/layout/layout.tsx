import type { Child } from 'hono/jsx';
import { jsonForScript } from '../html';
import { t } from '../i18n';
import type { ViewContext } from '../view-context';
import { AppStatus } from './app-status';

/**
 * The document shell of every page. The pages render navbar and dock
 * themselves (the error page and every current page do).
 *
 * English only: `lang`, `og:locale` and the default description are fixed.
 */

// https://htmx.org/reference/#config. htmx reads only the first htmx-config
// meta, so this is the whole config.
//  - No attribute inheritance (https://htmx.org/quirks/#attribute-inheritance).
//  - Three history snapshots, not ten: before every navigation htmx parses
//    and re-serializes the whole sessionStorage cache (up to 180 KB at ten
//    with 48 tiles loaded; about 9 ms a tap on a mid-range phone, 4 ms at
//    three). Three covers the usual back depth (a page, its detail, its
//    edit form); further back is fetched, through the service worker.
//  - No view transitions: while one runs (about 250 ms after every swap) the
//    page takes no taps, and navbar and dock cross-fade for nothing.
const HTMX_CONFIG = { disableInheritance: true, historyCacheSize: 3 };

// Bare specifiers for every ES module the pages import, so the versioned URL
// lives here once. Page-specific modules (sortablejs, background removal) are
// only fetched by the page that imports them.
function importMap(version: string) {
  const v = `?v=${version}`;
  return {
    imports: {
      'onnxruntime-web': `/modules/onnxruntime-web/dist/ort.all.bundle.min.mjs${v}`,
      'onnxruntime-web/webgpu': `/modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs${v}`,
      '@imgly/background-removal': `/modules/background-removal/index.mjs${v}`,
      sortablejs: `/modules/modular/sortable.esm.js${v}`,
      'workbox-window': `/modules/workbox-window.prod.mjs${v}`,
      // pwa.js imports these two only where they do something.
      'pwa-install': `/modules/pwa-install.bundle.js${v}`,
      pulltorefreshjs: `/modules/pulltorefresh/index.esm.js${v}`,
      toast: `/js/toast.js${v}`,
      'mask-editor': `/js/mask-editor.js${v}`,
      'outfit-builder': `/js/outfit-builder.js${v}`,
      push: `/js/push.js${v}`,
    },
  };
}

export interface LayoutProps {
  ctx: ViewContext;
  /** <title>; the app name when absent. */
  title?: string;
  ogTitle?: string;
  ogDescription?: string;
  /** The page's own link preview (the share page); the request URL and app icon otherwise. */
  ogUrl?: string;
  ogImage?: string;
  children?: Child;
}

export function Layout({
  ctx,
  title,
  ogTitle = ctx.appName,
  ogDescription = t('APP_DESCRIPTION'),
  ogUrl = ctx.ogUrl,
  ogImage = ctx.ogImage,
  children,
}: LayoutProps) {
  // Every first-party static URL carries ?v=appVersion (src/build-info.ts):
  // app.ts serves /modules, /js, /assets and bundle.css immutable for a year,
  // so the key is what rolls the cache on deploy.
  const v = `?v=${ctx.appVersion}`;
  return (
    // data-signed-in: pwa.js starts Web Push (push.js) only on signed-in
    // pages; the session cookie is httpOnly, so scripts cannot tell.
    <html lang="en" data-signed-in={ctx.user ? '' : undefined}>
      <head>
        <meta charset="UTF-8" />
        {/* No viewport-fit=cover: iOS standalone handles the safe areas
            itself, and cover puts content under the home indicator. */}
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content={ogDescription} />
        <link rel="canonical" href={ctx.canonicalUrl} />
        {/* https://ogp.me/ */}
        <meta property="og:locale" content="en_US" />
        <meta property="og:url" content={ogUrl} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={ogTitle} />
        <meta property="og:description" content={ogDescription} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:image:width" content="1000" />
        <meta property="og:image:height" content="1000" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta property="twitter:domain" content={ctx.siteUrl} />
        <meta property="twitter:url" content={ogUrl} />
        <meta name="twitter:title" content={ogTitle} />
        <meta name="twitter:description" content={ogDescription} />
        <meta name="twitter:image" content={ogImage} />
        <meta property="og:site_name" content={ctx.appName} />

        <link rel="icon" href={`/favicon.ico${v}`} sizes="48x48" />
        <link rel="apple-touch-icon" href={`/assets/${ctx.iconName}${v}`} />

        <meta name="htmx-config" content={JSON.stringify(HTMX_CONFIG)} />

        <title>{title ?? ctx.appName}</title>
        {/* Served from config by src/web/shell, not a static file. */}
        <link rel="manifest" href="/manifest.json" />
        <link href={`/bundle.css${v}`} rel="stylesheet" />
        {/* Libraries are served from node_modules (registerStaticAssets in
            app.ts), never a CDN. */}
        <script defer src={`/modules/htmx.min.js${v}`}></script>
        <script defer src={`/js/color-multiselect.js${v}`}></script>
        <script
          type="importmap"
          dangerouslySetInnerHTML={{
            __html: jsonForScript(importMap(ctx.appVersion)),
          }}
        />
        {/* Heartbeat-driven online/offline state and the banner in
            AppStatus; runs everywhere, service worker or not. */}
        <script type="module" src={`/js/connectivity.js${v}`}></script>
        {ctx.pwaEnabled && (
          // Service worker registration, update toast, Web Push, the install
          // dialog, iOS pull to refresh. In the head so hx-boost body swaps
          // never re-run it.
          <script type="module" src={`/js/pwa.js${v}`}></script>
        )}
      </head>

      {/* hx-boost swaps the body on every link and form
          (https://htmx.org/attributes/hx-boost/). With disableInheritance on,
          hx-inherit hands it down explicitly or no link is boosted. Every
          request lights the navbar spinner (#loading) and marks the tapped
          link htmx-request (pressed styling in main.css), so a slow network
          never looks like a dead tap; an element with its own hx-indicator
          (the photo form) keeps it. */}
      <body
        hx-boost="true"
        hx-indicator="#loading, closest a"
        hx-inherit="hx-boost hx-indicator"
        class="h-screen flex flex-col"
      >
        {children}
        <AppStatus />
      </body>
    </html>
  );
}
