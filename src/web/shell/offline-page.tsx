import { t } from '../i18n';
import { AppBar } from '../layout/app-bar';
import { OfflineIcon } from '../layout/app-status';
import { Dock, sectionLabel } from '../layout/dock';
import { Layout } from '../layout/layout';
import { SECTION_HOME } from '../layout/sections';
import { OPENS_STALE } from '../page-cache';
import type { ViewContext } from '../view-context';

/**
 * The service worker's navigation fallback (FALLBACK_HTML_URL in
 * views/assets/src-sw.ts), precached at install, possibly before sign-in: it
 * renders whatever session the install request had. It says the page asked
 * for is not on the device and links the tab roots the worker does keep
 * (OPENS_STALE); `data-offline-fallback` makes connectivity.js leave out its
 * "showing saved data" banner, which this page would contradict. A signed-out
 * copy links nothing: every tab would bounce to the login page.
 */
export function OfflinePage({ ctx }: { ctx: ViewContext }) {
  return (
    <Layout ctx={ctx}>
      <AppBar ctx={ctx} title={t('OFFLINE_TITLE')} />
      <main
        class="p-20 gap-2 flex flex-col justify-center items-center h-full"
        data-offline-fallback=""
      >
        <OfflineIcon class="size-6 text-error animate-pulse" />
        <h2 class="font-semibold">{t('OFFLINE_NOT_SAVED')}</h2>
        {ctx.user && (
          <>
            <p>{t('OFFLINE_DESC')}</p>
            <ul class="flex flex-wrap gap-2 justify-center">
              {OPENS_STALE.map((section) => (
                <li>
                  <a href={SECTION_HOME[section]} class="btn">
                    {sectionLabel(section)}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
      <Dock ctx={ctx} />
    </Layout>
  );
}
